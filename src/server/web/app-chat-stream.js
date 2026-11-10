/*
 * app-chat-stream.js — 聊天视图的请求体组装、SSE 帧解析与错误应答判定。
 *
 * 拆出来的是「一次请求与它回来的字节」这条线上与 DOM 无关的那三段：
 *
 *   1. 组装：存储里的消息数组 → `/v1/chat/completions` 的 `messages`。带图 / 带文件的
 *      历史消息按引用重建 content 数组（无状态协议每轮全量重发），data URL 的取回是
 *      异步的，所以这一步回 Promise。
 *   2. 解析：SSE 帧（`data: {json}` 每行一条，`data: [DONE]` 收尾，空行分帧）。缓冲区
 *      按分帧符切、最后一段留到下一次读——一个 chunk 边界落在 JSON 中间是常态。
 *   3. 判定：失败应答里的错误消息取法，以及「这是 401 吗」——401 要改的是 key 选择，
 *      不是模型，视图据此请回粘贴行。
 *
 * 剩下的都在视图里：`fetch` 本身、中止与收尾链、横幅与状态文字、气泡节点的增删。
 * 解析器把增量交给调用方的 `onDelta(text)`，自己只认字符串。
 *
 * 与存储层（`app-chat-sessions.js`）的分工：那边管会话数据，这边只读它给出的消息
 * 视图（`imagesOf` / `filesOf`）与附件存储层（`App.attachments`）的读取接口。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var t = App.i18n.t;
  var imagesOf = App.chatSessions.imagesOf;
  var filesOf = App.chatSessions.filesOf;

  /* SSE 的收尾帧（OpenAI 兼容协议的固定标记，不翻译）。*/
  var SSE_DONE = "[DONE]";

  /* ---- 请求体 ------------------------------------------------------------ */

  /**
   * 存储里的消息数组 → 请求体的 messages。
   *
   * 不带附件的消息原样 `{role, content}`（大多数历史消息，与纯文本会话的请求体
   * 完全同构）；带图的历史消息按引用重建 content 数组——无状态协议每轮全量
   * 重发，图必须每次都带上；文件附件注入为带标注的文本块。blob 缺失（被清理 /
   * 降级后刷新）时降级为一条说明文本：绝不静默丢图，模型至少知道这里有一张图。
   */
  function buildApiMessages(messages) {
    var apiMessages = [];
    var fills = [];
    for (var i = 0; i < messages.length; i++) {
      var message = messages[i];
      var images = imagesOf(message);
      var files = filesOf(message);
      if (images.length === 0 && files.length === 0) {
        apiMessages.push({ role: message.role, content: message.content });
        continue;
      }
      var target = { role: message.role, content: "" };
      apiMessages.push(target);
      fills.push(fillMessageContent(target, message, images, files));
    }
    if (fills.length === 0) return Promise.resolve(apiMessages);
    return Promise.all(fills).then(function () {
      return apiMessages;
    });
  }

  /** 一条带附件消息的 content 数组：文本（正文 + 文件标注）在前，图片在后。*/
  function fillMessageContent(target, message, images, files) {
    var parts = [];
    var textBits = [];
    if (message.content) textBits.push(message.content);
    for (var f = 0; f < files.length; f++) {
      textBits.push(t("chat.fileAnnotation", { name: files[f].name }) + "\n" + files[f].text);
    }
    if (textBits.length > 0) parts.push({ type: "text", text: textBits.join("\n\n") });
    var loads = [];
    for (var i = 0; i < images.length; i++) {
      (function (att) {
        loads.push(
          App.attachments.dataUrlOf(att.id).then(function (dataUrl) {
            if (dataUrl) parts.push({ type: "image_url", image_url: { url: dataUrl } });
            else parts.push({ type: "text", text: t("chat.imageMissing", { name: att.name }) });
            return null;
          }),
        );
      })(images[i]);
    }
    return Promise.all(loads).then(function () {
      target.content = parts;
      return null;
    });
  }

  /* ---- SSE 帧 ------------------------------------------------------------ */

  /**
   * 逐帧拆一条响应流，把增量交给 `onDelta`，读完回整段正文。
   *
   * 帧边界与 JSON 解析都在这里；调用方只负责「增量到了要画在哪」。读不懂的帧跳过，
   * 不因此丢掉已经收到的正文。没有 body 时回 `null`——调用方据此跳过收尾（没有流
   * 就没有可收尾的正文，不能把「没读到」说成「模型回了空」）。
   */
  function readStream(response, onDelta) {
    if (!response.body) return Promise.resolve(null);
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    var text = "";

    function applyFrame(frame) {
      var lines = frame.split("\n");
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf("data:") !== 0) continue;
        var payload = line.slice(5).trim();
        if (!payload || payload === SSE_DONE) continue;
        var chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; /* 上游给了一条读不懂的帧：跳过它，不要因此丢掉已经收到的正文。*/
        }
        var choice = chunk.choices && chunk.choices[0];
        var delta = choice && choice.delta;
        if (delta && typeof delta.content === "string" && delta.content) {
          text += delta.content;
          onDelta(text);
        }
      }
    }

    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) {
          if (buffer) applyFrame(buffer);
          return text;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        var frames = buffer.split(C.SSE_FRAME_SEPARATOR);
        buffer = frames.pop() || "";
        for (var i = 0; i < frames.length; i++) applyFrame(frames[i]);
        return pump();
      });
    }

    return pump();
  }

  /* ---- 错误应答 ---------------------------------------------------------- */

  /** 应答体里的 `error.message`（读不出就空串：那是诊断信息，不翻译）。*/
  function errorMessageOf(body) {
    return body && body.error && typeof body.error.message === "string" ? body.error.message : "";
  }

  /** 凭据被拒：改的是 key 选择，不是模型（视图据此请回粘贴行）。*/
  function isUnauthorized(response) {
    return response.status === C.HTTP_UNAUTHORIZED;
  }

  App.chatStream = {
    buildApiMessages: buildApiMessages,
    readStream: readStream,
    errorMessageOf: errorMessageOf,
    isUnauthorized: isUnauthorized,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
