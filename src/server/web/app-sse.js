/*
 * app-sse.js — 事件流的连接、帧解析与重连退避。
 *
 * 数据来自 `GET /api/events` 的三条事件：
 *
 *   log      { seq, level, account?, line }   一行一条，级别与账号由服务端标注
 *   request  <RequestRecord>                 一次请求收尾时整条推送
 *   state    <StatePayload>                   状态快照（节流版），也用来刷新账号下拉
 *
 * 为什么不用 `EventSource`：它无法带 `Authorization` 头（`/api/*` 一律要令牌），
 * 把令牌塞进查询串会把它泄给历史记录与截屏。所以这里用
 * `fetch` 加 ReadableStream 自己解析帧，退避也自己控。
 *
 * 连接只在日志页存在：进页面才订阅，离开就断开，不留一条后台流。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var state = App.state;
  /* 日志视图在本文件之后拼接，所以这里不能提前取值，只能在调用点取。*/
  function logs() {
    return App.views.logs;
  }

  /** 重连退避的当前值（成功连上后复位）。*/
  var reconnectDelayMs = C.RECONNECT_BASE_MS;
  /** 重连定时器句柄：切视图 / 重新连接前要清掉，否则会堆出多条流。*/
  var reconnectTimer = null;
  /** 当前事件流的取消句柄（`AbortController`），断开 / 切页时 abort。*/
  var eventsController = null;

  /** 进入日志页才订阅事件流；离开就断开。*/
  function syncEventStream() {
    stopEventStream();
    if (state.activeView !== C.VIEW_LOGS) return;
    logs().setConnection(C.LOG_CONN_CONNECTING);
    connectEvents();
  }

  /** 清掉重连定时器与当前流的 abort 句柄（两者不清就是泄漏）。*/
  function stopEventStream() {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (eventsController !== null) {
      eventsController.abort();
      eventsController = null;
    }
  }

  function connectEvents() {
    var controller = new AbortController();
    eventsController = controller;
    /* 「放弃」与「掉线」必须分开：401 不该重连，掉线必须重连。两者都会回到下面
       同一条 `.then`，所以用这个标志把 401 那条路标出来（`aborted` 只表示调用方
       主动切走了页面）。*/
    var gaveUp = false;

    window
      .fetch(C.EVENTS_PATH, {
        headers: { accept: "text/event-stream" },
        credentials: "same-origin",
        signal: controller.signal,
      })
      .then(function (response) {
        if (response.status === C.HTTP_UNAUTHORIZED) {
          /* 会话没了：不重试（重试一万次也还是 401），整页回登录页 */
          gaveUp = true;
          eventsController = null;
          logs().setConnection(C.LOG_CONN_DISCONNECTED);
          App.api.goToLogin();
          return null;
        }
        if (!response.ok) {
          scheduleReconnect();
          return null;
        }
        reconnectDelayMs = C.RECONNECT_BASE_MS;
        logs().setConnection(C.LOG_CONN_CONNECTED);
        return readEventStream(response.body.getReader());
      })
      .then(function () {
        /* 流正常结束（服务端关闭 / 重启）也要重连；主动 abort 时不重连 */
        if (gaveUp || controller.signal.aborted) return;
        scheduleReconnect();
      })
      .catch(function () {
        if (gaveUp || controller.signal.aborted) return;
        scheduleReconnect();
      });
  }

  /** 指数退避重连（1s、2s、4s… 封顶 `RECONNECT_MAX_MS`）。*/
  function scheduleReconnect() {
    if (reconnectTimer !== null) return;
    if (state.activeView !== C.VIEW_LOGS) {
      logs().setConnection(C.LOG_CONN_DISCONNECTED);
      return;
    }
    logs().setConnection(C.LOG_CONN_RECONNECTING);
    var delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * C.RECONNECT_BACKOFF_FACTOR, C.RECONNECT_MAX_MS);
    reconnectTimer = window.setTimeout(function () {
      reconnectTimer = null;
      if (state.activeView !== C.VIEW_LOGS) return;
      connectEvents();
    }, delay);
  }

  /** 逐帧消费 SSE：一个空行结束一帧，`:` 开头是注释（心跳）。*/
  function readEventStream(reader) {
    var decoder = new TextDecoder();
    var pending = "";
    function pump() {
      return reader.read().then(function (result) {
        if (result.done) return;
        pending += decoder.decode(result.value, { stream: true });
        pending = consumeEventFrames(pending);
        return pump();
      });
    }
    return pump();
  }

  /** 切出完整帧，剩下的半帧（还没等到空行）原样返回给下一次。*/
  function consumeEventFrames(text) {
    var rest = text;
    var boundary = rest.indexOf(C.SSE_FRAME_SEPARATOR);
    while (boundary >= 0) {
      handleEventFrame(rest.slice(0, boundary));
      rest = rest.slice(boundary + C.SSE_FRAME_SEPARATOR.length);
      boundary = rest.indexOf(C.SSE_FRAME_SEPARATOR);
    }
    return rest;
  }

  /** 一帧：`event:` 加 `data:` 行；未知事件名忽略（服务端将来加事件不会弄坏页面）。*/
  function handleEventFrame(frame) {
    var name = "";
    var data = "";
    var lines = frame.split("\n");
    for (var i = 0; i < lines.length; i++) {
      /* 行尾 `\r`：中间设备把 `\n` 改写成 `\r\n` 时保留协议兼容 */
      var line = lines[i].replace(/\r$/, "");
      if (!line || line.charAt(0) === ":") continue;
      var colon = line.indexOf(":");
      var field = colon < 0 ? line : line.slice(0, colon);
      var value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.charAt(0) === " ") value = value.slice(1);
      if (field === "event") name = value;
      else if (field === "data") data = data ? data + "\n" + value : value;
    }
    if (!name || !data) return;

    var payload;
    try {
      payload = JSON.parse(data);
    } catch {
      /* 帧内容不是 JSON 就丢掉：无效帧不该被画成一行日志 */
      return;
    }
    if (name === C.SSE_EVENT_LOG) logs().append(payload);
    else if (name === C.SSE_EVENT_REQUEST) logs().appendRequest(payload);
    else if (name === C.SSE_EVENT_STATE) applyStateEvent(payload);
  }

  /** `state` 事件：与 `/api/state` 同一份载荷，直接当一次轮询结果用。*/
  function applyStateEvent(next) {
    state.lastState = next;
    App.renderState(next);
  }

  App.sse = { sync: syncEventStream, stop: stopEventStream };
})(window.__zcodeApp = window.__zcodeApp || {});
