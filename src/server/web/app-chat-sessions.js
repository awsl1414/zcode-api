/*
 * app-chat-sessions.js — 聊天视图的会话状态与会话持久化（纯数据，不碰 DOM 与字典）。
 *
 * 会话是聊天视图里唯一有「数据形状」的部分：内存真值是一份会话数组（`sessions`），
 * localStorage 是它的持久投影（键 `zcode-chat-sessions`，一份 JSON 一把写）。本模块
 * 只管这一层：形状校验、恢复与写回、当前会话指针、删除 / 撤销在会话数组上的动作。
 * 消息区与列表怎么画、横幅怎么提示、撤销条什么时候出现，都是视图的事——那些要
 * 碰 DOM 与 i18n，留在主文件。
 *
 * 不碰 DOM、不查字典：需要选择快照的地方由调用方传进来（`ensureLoaded(choices)` /
 * `add(choices)` / `remove(id, choices)`），超软限只回一个布尔，提示由视图决定，
 * 会话标题的「新会话」兜底也在视图里拼。这样它对加载顺序没有额外要求，视图与
 * 发送链都能直接调。
 *
 * 消息数组的语义不变：全量随请求发 `/v1/chat/completions` 的 `messages`（无状态
 * 协议），多会话只是前端管理多份数组，服务端零改动。
 *
 * 存储容错：任何一步读不懂都当「没存过」，类型不对的字段逐个回落 / 丢弃，绝不因为
 * 一条坏数据把整个清单判死。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var store = App.store;

  /* ---- 存储键 ------------------------------------------------------------ */

  /** 全部会话：`{version, sessions: [会话…]}`，一份 JSON 一把写。*/
  var SESSIONS_STORAGE_KEY = "zcode-chat-sessions";
  /** 存储版本：将来改结构时用它分辨旧数据（目前只认 1，别的当损坏丢弃）。*/
  var SESSIONS_STORE_VERSION = 1;

  /* ---- 状态 -------------------------------------------------------------- */

  /** 全部会话（内存真值，localStorage 是它的持久投影）。渲染时按 updatedAt 排序。*/
  var sessions = [];
  /** 当前会话 id；`null` = 还没进过视图（会话清单未恢复）。*/
  var activeId = null;
  /** 会话清单是否已从 localStorage 恢复过（`ensureLoaded` 只恢复一次）。*/
  var loaded = false;

  /* ---- 形状 -------------------------------------------------------------- */

  /** 会话的展示标题：空标题落到调用方给的「新会话」文案（本模块不读字典）。*/
  function sessionDisplayName(session, untitledLabel) {
    return session.title || untitledLabel;
  }

  function newSessionId() {
    return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function createSessionObject(choices) {
    var now = Date.now();
    return {
      id: newSessionId(),
      title: "",
      createdAt: now,
      updatedAt: now,
      messages: [],
      choices: sanitizeChoices(choices),
    };
  }

  /** 选择快照只认四个字符串字段；别的形状一律回落「空选择」。*/
  function sanitizeChoices(raw) {
    var choices = { account: "", route: "", model: "", key: "" };
    if (!raw || typeof raw !== "object") return choices;
    var fields = ["account", "route", "model", "key"];
    for (var i = 0; i < fields.length; i++) {
      if (typeof raw[fields[i]] === "string") choices[fields[i]] = raw[fields[i]];
    }
    return choices;
  }

  /**
   * 存储里的附件列表 → 内存形状。只认两种合法形状，别的逐条丢弃：
   *
   *   image：`{kind, id, name, thumb}`——id 指向 IndexedDB（或降级内存桶）里的
   *          blob；thumb 是持久化的小缩略图（可为 null：画布不可用时生成的
   *          消息本来就没有）。**存的是引用，不是 base64**。
   *   file：`{kind, name, text}`——文本类文件的内容，是文本正文的一部分，
   *         随会话进 localStorage。
   *
   * 全部条目都非法时回 `undefined`（消息保留正文，附件字段整个缺席）。
   */
  function sanitizeAttachments(raw) {
    if (!Array.isArray(raw)) return undefined;
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var a = raw[i];
      if (!a || typeof a !== "object") continue;
      if (a.kind === "image" && typeof a.id === "string" && a.id) {
        out.push({
          kind: "image",
          id: a.id,
          name: typeof a.name === "string" ? a.name : "",
          thumb: typeof a.thumb === "string" ? a.thumb : null,
        });
      } else if (a.kind === "file" && typeof a.name === "string" && a.name && typeof a.text === "string") {
        out.push({ kind: "file", name: a.name, text: a.text });
      }
    }
    return out.length > 0 ? out : undefined;
  }

  /** 一条消息里的图片附件（没有就空数组——历史消息没有这个字段）。*/
  function imagesOf(message) {
    var out = [];
    var list = message && Array.isArray(message.attachments) ? message.attachments : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].kind === "image") out.push(list[i]);
    }
    return out;
  }

  /** 一条消息里的文件附件（同上）。*/
  function filesOf(message) {
    var out = [];
    var list = message && Array.isArray(message.attachments) ? message.attachments : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].kind === "file") out.push(list[i]);
    }
    return out;
  }

  /** 全部会话引用的图片 id（孤儿清理的保留集；预览条里的待发图由调用方补上）。*/
  function allReferencedImageIds() {
    var ids = [];
    for (var i = 0; i < sessions.length; i++) {
      var messages = sessions[i].messages;
      for (var j = 0; j < messages.length; j++) {
        var images = imagesOf(messages[j]);
        for (var k = 0; k < images.length; k++) {
          if (ids.indexOf(images[k].id) < 0) ids.push(images[k].id);
        }
      }
    }
    return ids;
  }

  /**
   * 待发送附件的存储形状：图存引用 + 缩略图（**不存 base64**），文件存内容。
   *
   * 它是 `sanitizeAttachments` 的反向：写进会话的消息带这个形状，读回来再由
   * `sanitizeAttachments` 校验一遍。
   */
  function attachmentsForStorage(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.kind === "image") out.push({ kind: "image", id: a.id, name: a.name, thumb: a.thumb || null });
      else out.push({ kind: "file", name: a.name, text: a.text });
    }
    return out.length > 0 ? out : undefined;
  }

  /**
   * 一条存储里的会话 → 内存形状。类型不对的字段逐个回落 / 丢弃，绝不因为一条
   * 坏数据把整个清单判死（localStorage 容错：损坏值回落，不抛错）。
   */
  function sanitizeSession(raw) {
    if (!raw || typeof raw !== "object") return null;
    var messages = [];
    if (Array.isArray(raw.messages)) {
      for (var i = 0; i < raw.messages.length; i++) {
        var message = raw.messages[i];
        if (
          message &&
          typeof message === "object" &&
          (message.role === "user" || message.role === "assistant") &&
          typeof message.content === "string"
        ) {
          var stored = { role: message.role, content: message.content };
          /* 附件（图片引用 + 缩略图 / 文件内容）形状不对就整个丢弃——消息正文不受
             影响，坏数据只损失附件。 */
          var attachments = sanitizeAttachments(message.attachments);
          if (attachments) stored.attachments = attachments;
          messages.push(stored);
        }
      }
    }
    var now = Date.now();
    var createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : now;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : newSessionId(),
      title: typeof raw.title === "string" ? raw.title : "",
      createdAt: createdAt,
      updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
      messages: messages,
      choices: sanitizeChoices(raw.choices),
    };
  }

  /* ---- 恢复与写回 -------------------------------------------------------- */

  /** 从 localStorage 恢复会话清单。任何一步读不懂都当「没存过」，落到全新状态。*/
  function loadSessions() {
    var raw = store.read(SESSIONS_STORAGE_KEY);
    if (!raw) return;
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; /* 损坏的值：当作没存过，后面的首建会给用户一个干净的新会话 */
    }
    if (!parsed || typeof parsed !== "object" || parsed.version !== SESSIONS_STORE_VERSION) return;
    if (!Array.isArray(parsed.sessions)) return;
    var cleaned = [];
    for (var i = 0; i < parsed.sessions.length; i++) {
      var session = sanitizeSession(parsed.sessions[i]);
      if (session) cleaned.push(session);
    }
    sessions = cleaned;
  }

  /**
   * 全量写回 localStorage，并回报是否接近配额。
   *
   * 会话总量小（护栏：单会话 200 条），一把写简单且原子。写之前量一下字节数：
   * 接近 5MB 配额就回 `true`，由视图提醒删旧会话——只提醒，不自动淘汰。
   */
  function persistSessions() {
    var raw;
    try {
      raw = JSON.stringify({ version: SESSIONS_STORE_VERSION, sessions: sessions });
    } catch {
      return false; /* 序列化不出来（理论上不会：没有循环引用）就别把内存状态弄坏 */
    }
    store.write(SESSIONS_STORAGE_KEY, raw);
    return raw.length > C.CHAT_STORAGE_SOFT_LIMIT;
  }

  /**
   * 首次进视图：恢复清单，一条都没有就建一个干净的（不落盘，直到真的有内容）。
   *
   * 新会话继承调用方给的选择快照，所以这一步要 `choices`——本模块不读下拉。
   */
  function ensureSessionsLoaded(choices) {
    if (loaded) return;
    loaded = true;
    loadSessions();
    if (sessions.length === 0) sessions.push(createSessionObject(choices));
    sessions.sort(function (a, b) {
      return b.updatedAt - a.updatedAt;
    });
    activeId = sessions[0].id;
  }

  function sessionById(id) {
    if (!id) return null;
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].id === id) return sessions[i];
    }
    return null;
  }

  function currentSession() {
    return sessionById(activeId);
  }

  /* ---- 增删与撤销（会话数组上的动作） ------------------------------------ */

  /** 新建并落为当前会话（继承调用方的选择快照）。*/
  function addSession(choices) {
    var session = createSessionObject(choices);
    sessions.push(session);
    activeId = session.id;
    return session;
  }

  /**
   * 从清单移除，返回撤销所需的事实：`{session, wasActive, fallbackId}`。
   *
   * 删的是当前会话就把指针落到最近的另一条；一条不剩就补一条空的（`fallbackId`
   * 记下它，撤销时要把它收回去）。id 不存在回 `null`。落盘与重画由调用方安排。
   */
  function removeSession(id, choices) {
    var index = -1;
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].id === id) {
        index = i;
        break;
      }
    }
    if (index < 0) return null;
    var session = sessions[index];
    var wasActive = id === activeId;
    sessions.splice(index, 1);
    var fallbackId = null;
    if (sessions.length === 0) {
      var fallback = createSessionObject(choices);
      sessions.push(fallback);
      fallbackId = fallback.id;
    }
    if (wasActive) activeId = sessions[0].id;
    return { session: session, wasActive: wasActive, fallbackId: fallbackId };
  }

  /**
   * 撤销：把会话原样放回清单（含消息、附件引用与选择快照）。
   *
   * 自动补的空会话是为「删掉最后一条」服务的：会话回来了它就没用了，但只收自己补的
   * 那条（用户真正在编辑的空会话不能动）。回 `{reopened}`：调用方据此决定要不要
   * 重新激活（重画消息区与四个下拉是视图的事）。
   */
  function restoreSession(pending) {
    if (pending.fallbackId) {
      for (var i = 0; i < sessions.length; i++) {
        var candidate = sessions[i];
        if (candidate.id !== pending.fallbackId) continue;
        if (candidate.messages.length === 0 && !candidate.title) sessions.splice(i, 1);
        break;
      }
    }
    sessions.push(pending.session);
    var reopened = Boolean(pending.wasActive || !sessionById(activeId));
    if (reopened) activeId = pending.session.id;
    return { reopened: reopened };
  }

  /* ---- 标题派生 ---------------------------------------------------------- */

  /** 标题 = 首条用户消息的前 20 字（补省略号）；用户重命名过（title 非空）就不动。*/
  function titleFromMessage(content) {
    var line = String(content || "").split("\n")[0].trim();
    if (!line) return "";
    return line.length > C.CHAT_TITLE_MAX_CHARS ? line.slice(0, C.CHAT_TITLE_MAX_CHARS) + "…" : line;
  }

  function retitleFromFirstMessage(session) {
    if (session.title) return;
    for (var i = 0; i < session.messages.length; i++) {
      if (session.messages[i].role !== "user") continue;
      session.title = titleFromMessage(session.messages[i].content);
      return;
    }
  }

  App.chatSessions = {
    /** 全部会话（内存真值）。调用方按只读视图用，改动走下面的动作。*/
    list: function () {
      return sessions;
    },
    activeId: function () {
      return activeId;
    },
    /** 把指针落到某个会话（切会话只剩这一半，渲染由视图做）。*/
    setActive: function (id) {
      activeId = id;
    },
    current: currentSession,
    byId: sessionById,
    ensureLoaded: ensureSessionsLoaded,
    add: addSession,
    remove: removeSession,
    restore: restoreSession,
    /** 全量写回；回 `true` = 已接近配额（提示归视图）。*/
    persist: persistSessions,
    displayName: sessionDisplayName,
    titleFromMessage: titleFromMessage,
    retitleFromFirstMessage: retitleFromFirstMessage,
    imagesOf: imagesOf,
    filesOf: filesOf,
    referencedImageIds: allReferencedImageIds,
    attachmentsForStorage: attachmentsForStorage,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
