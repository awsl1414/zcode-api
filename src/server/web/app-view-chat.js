/*
 * app-view-chat.js — 面板侧边栏的聊天视图：编排、DOM 与事件。
 *
 * 三层分工：
 *
 *   app-chat-sessions.js  会话状态与持久化：会话形状校验、localStorage 恢复与写回、
 *                         当前会话指针、增删与撤销在会话数组上的动作。纯数据，不碰 DOM。
 *   app-chat-stream.js    请求体组装、SSE 帧解析、错误应答判定的取法。
 *   本文件                其余全部：消息区与列表的渲染、四个层级下拉、附件选择与预览条、
 *                         发送链的中止与收尾、事件绑定、进视图与语言切换钩子。
 *
 * 发消息、流式渲染、错误横幅、停止按钮、401 降级这些「请求 — 渲染 — 报错」的本体
 * 仍在发送链里；多会话与层级选择是它上面的两层状态：
 *
 *   1. 多会话（localStorage，键前缀 `zcode-chat-`）：会话可保存 / 切换 / 重命名 /
 *      删除。消息数组的语义不变——仍全量随请求发 `/v1/chat/completions` 的
 *      `messages`（无状态协议），多会话只是前端管理多份数组，服务端零改动。
 *   2. 层级选择（每会话的属性）：账号 → 套餐 → 模型 → key 四个下拉，选择快照存进
 *      会话（`choices`），切会话连带切换——一个会话对应一个「账号×套餐×模型×key」
 *      组合，测试矩阵用法自然成立。
 *
 * 附件（图片 + 文本类文件）分三段：存储层在 `app-chat-attachments.js`（图片 blob 的
 * IndexedDB 存取与孤儿清理），待发送列表与预览条在本文件，组装进请求体在
 * `app-chat-stream.js`。图片只存引用与小缩略图（`{kind:"image", id, name, thumb}`），
 * **base64 不进 localStorage**；文本类文件读内容注入消息（`[文件: foo.ts]` 标注，
 * 存 localStorage——它是文本正文）。二进制一律拒绝：上游多模态契约只覆盖图片。
 *
 * 能力提示：`/v1/models` 的目录内条目在 `architecture.input_modalities` 里带模态，
 * 选中已知非视觉模型 + 带图发送前用提示横幅拦下。
 *
 * 层级选择走显式路由头：选了账号带 `X-ZCode-Account: <label>`，选了
 * 套餐带 `X-ZCode-Route: <routeKind>`，模型走 body `model`。「空选择」就是不带——
 * 账号交给调度器（自动调度），套餐按策略，模型让服务端默认，key 用面板会话。模型
 * 的空选择是「body 不带 model 字段」：服务端本来就容忍缺 model（peekBody 的占位符
 * 与调度器的模型过滤都绕开它），前端不替用户挑一个——那不是「默认」，是「伪装成
 * 默认的替选」。非法组合由服务端报错（400/503），前端不预校验：错误横幅把服务端
 * 消息透出来，这正是测试工具的本意。
 *
 * key 下拉的数据源是控制命令 `listApiKeys`（与 key 页同一模式）。服务端把
 * key 加密存储、`listApiKeys` 解密带回（每条摘要的 `secret`），所以「归因真实」的
 * 机制变得直接：选中某把已管理的 key，就发它解出来的完整值——不再要求粘贴。
 * 「手动输入」是唯一还走粘贴行的入口（带「记住此 key」勾选：勾了存 localStorage 按
 * keyId 关联，不勾只在本页生存期内生效），粘贴值若与某把已管理 key 的前缀唯一命中
 * 会自动归到那把 key 名下。选中已管理 key 即发其完整值（记录必带可解密文）。
 * 发哪把 key 的 `Authorization: Bearer <完整key>`，用量就真实归因到哪条（请求记录
 * 的 `apiKeyId`）。鉴权优先级是**会话 Cookie > Bearer key**，而同源 fetch
 * 总是自动带 Cookie——登录着的面板里发 key 请求，服务端仍把用量记到面板会话
 * （`apiKeyId` 为空），选中的 key 只被当成真伪测试。所以 key 模式的请求带
 * `credentials: "omit"`（见 `send`）：Cookie 不随请求走，服务端没有会话可认，就按
 * Bearer key 鉴权并归因到 key——这正是「像外部客户端那样发请求」的语义。「面板
 * 会话（默认）」不带 key，Cookie 随请求走、归因到面板会话——绝不伪造 keyId 归因。
 *
 * 为什么是原生 `fetch` + `ReadableStream` 而不是 EventSource：`/v1/chat/completions`
 * 是 POST，EventSource 只发 GET（与面板的日志流刚好相反）。
 *
 * 切会话的正确收尾：先中止在飞流（`quiesce()`），等收尾链走完（部分回复落历史、
 * busy 复位）再换数据——流式回调闭包捕获的会话是发送那一刻的会话，收尾必须在
 * 切换之前发生，否则部分回复会写进别的会话。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var byRole = App.dom.byRole;
  var setText = App.dom.setText;
  var setHidden = App.dom.setHidden;
  var create = App.dom.create;
  var clear = App.dom.clear;
  var button = App.dom.button;
  var store = App.store;
  var t = App.i18n.t;
  /** 会话状态与持久化（`app-chat-sessions.js`）。*/
  var chatSessions = App.chatSessions;
  /** 请求体组装与 SSE 解析（`app-chat-stream.js`）。*/
  var chatStream = App.chatStream;

  /* 两个端点都是同源相对路径：页面不拼主机名（只有这一个视图用它们）。*/
  var CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
  var CHAT_MODELS_PATH = "/v1/models";
  /* 面板自报头（`client-kind.ts` 的 panel 判定）。浏览器 UA 千差万别，服务端没法从
     UA 认出「这是本面板」，只能靠自报。这个头不外传：出线请求头是白名单转发
     （upstream.ts 只放行 anthropic-beta），它只活在代理本地。*/
  var CLIENT_HEADER = { "X-ZCode-Client": "panel-web" };

  /* ---- 存储键（zcode-chat- 前缀，读写全走 App.store 的 try/catch）-------- */

  /** 「记住此 key」勾选落下的完整 key：`{[keyId]: 完整key}`（含手动 key 的桶）。*/
  var KEYS_STORAGE_KEY = "zcode-chat-keys";
  /** 手动输入的 key 在 KEYS_STORAGE_KEY 里的位置：它不是任何一把已管理的 key。*/
  var MANUAL_KEY_ID = "manual";

  var SESSION_MESSAGE_LIMIT = C.CHAT_SESSION_MESSAGE_LIMIT;

  /* ---- 状态 -------------------------------------------------------------- */

  /** 「记住此 key」的持久表（localStorage 的内存投影）。*/
  var rememberedKeys = {};
  /** 本次页面生存期内的完整 key（没勾「记住」的粘贴落这里；切会话不丢，刷新即清）。*/
  var runtimeKeys = {};
  /** 最近一次 `listApiKeys` 的条目（下拉的数据源，key 页的同一份命令应答）。*/
  var keyRows = [];
  /** 手动粘贴行当前为谁服务：keyId 或 MANUAL_KEY_ID；`null` = 行是收起的。*/
  var keyPasteTarget = null;
  /**
   * 401 降级挂起的粘贴提示（非空 = 行因凭据被拒而开着）。
   *
   * 首拍序列里 401 先到、选择快照后落：applyChoices 对「面板会话」的例行收起
   * 不能把刚请出来的粘贴行再收回去，否则错误横幅又指向一个 display:none 的输入框
   *（UI 审查 #2 的同一条教训）。锁存器由用户动作解除：改选择、贴上 key、切会话。 */
  var pastePrompt = null;

  /** `/v1/models` 的 id 列表；只拉一次，key 换了之后手动重拉。*/
  var modelIds = [];

  /**
   * `/v1/models` 里的视觉能力表（字段在 `architecture.input_modalities`）：
   * id → true/false/undefined。true/false 只在目录内 id 上出现（模态数组有值 =
   * 已知）；目录外的 id（用户自加的转发模型）不带 architecture → undefined =
   * 未知，发送前提示 fail-open（不拦）。
   */
  var visionById = {};

  /**
   * `/v1/models` 广告的默认模型 id（非标准字段 `default_model`，即生效的
   * `config.defaultModel`）。空串 = 服务端没广告该字段时，「服务端
   * 默认」选项退回原文案 —— 见 renderModelOptions。
   */
  var defaultModelId = "";

  /* ---- 附件 --------------------------------------------------------------- */

  /**
   * 待发送的附件（预览条的真值，发送时随消息落库）：
   *
   *   `{kind:"image", id, name, blob, objectUrl, thumb, persisted}`
   *     — blob 是选文件时的 File（可能包了一层带 media type 的 Blob）；id 由
   *       附件存储层分配（attach 时就落 IndexedDB / 内存桶，发送只是引用）。
   *   `{kind:"file", name, text}`
   *     — 文本类文件的内容（上限内）整体在这里，发送时注入消息文本，存储时
   *       随消息进 localStorage（文本正文的口径）。
   */
  var pendingAttachments = [];

  /** 附件对象的 object URL 缓存（预览条 / 气泡显示用；页面生存期，不主动撤销）。*/
  var objectUrls = {};

  /** 降级提示只弹一次（idb 不可用是环境事实，不是每次附加都值得说一遍的事件）。*/
  var degradedNoticeShown = false;

  /** 在飞请求的中止句柄；`null` = 空闲。*/
  var controller = null;
  /** 在飞请求的收尾链（含错误处理与持久化）：切会话前要等它走完。*/
  var inflight = null;

  /**
   * 正在把一份选择快照落进四个下拉（`applyChoices`）。
   *
   * 下拉重建的回落逻辑会顺手把回落值写回会话；应用快照时那一笔写回是多余的（快照
   * 的回落值由 `applyChoices` 自己统一落一次），拿这个开关挡掉。
   */
  var applyingChoices = false;

  /**
   * 选择快照已经至少落过一次（首次进视图的 Promise.all 之后）。
   *
   * 模型 / key 清单在首拍到达时会重建下拉，那一刻快照还没落（下拉是空的「空选择」），
   * 重建的写回会把恢复中的会话快照覆盖成默认值。首拍之后的重建（轮询同步、语言
   * 切换）才允许把回落值写回——那才是「外部世界变了，选择作废」的时刻。
   */
  var choicesApplied = false;

  /** `bind()` 只跑一次：骨架是静态 DOM，反复绑定会把同一条事件接两遍。*/
  var bound = false;

  /* 选项重建的签名：`/api/state` 每 5 秒轮询一次，选项没变就不重建，
     语言切换后把签名清空强制重画（选项文案是运行时拼的）。*/
  var accountSignature = null;
  var routeSignature = null;
  var modelSignature = null;
  var keySignature = null;

  /* ---- 元素与状态 ------------------------------------------------------ */

  function logNode() {
    return byRole("chat-log");
  }

  function inputNode() {
    return byRole("chat-input");
  }

  function showError(text) {
    var banner = byRole("chat-error");
    if (!banner) return;
    setHidden(banner, text === null);
    setText("chat-error-text", text === null ? "" : text);
  }

  /** 提示（非错误）：目前只有存储接近上限的「删旧会话」提醒。*/
  function showNotice(text) {
    var banner = byRole("chat-notice");
    if (!banner) return;
    setHidden(banner, text === null);
    setText("chat-notice-text", text === null ? "" : text);
  }

  function setStatus(text) {
    setText("chat-status", text || "");
  }

  /** 在飞时禁用发送、露出停止按钮（两件事总是一起发生，所以收在一个函数里）。*/
  function setBusy(busy) {
    var send = byRole("chat-send");
    var stop = byRole("chat-stop");
    if (send) send.disabled = busy;
    setHidden(stop, !busy);
    setStatus(busy ? t("chat.status.streaming") : "");
  }

  /** 滚到底：新消息与流式增量都让最新一行可见（纯几何，不是视觉值）。*/
  function scrollToEnd() {
    var log = logNode();
    if (log) log.scrollTop = log.scrollHeight;
  }

  /**
   * 空状态与对话区互斥。
   *
   * 两者同时出现会得到一张「还没消息」的卡片加一块空白框。用 DOM 里有没有气泡
   * 判断，而不是 `messages.length`：流式回复进行到一半时，气泡已经在，消息数组
   * 还没收尾。
   */
  function syncEmptyState() {
    var log = logNode();
    var empty = byRole("chat-empty");
    var hasMessages = Boolean(log && log.firstChild);
    setHidden(empty, hasMessages);
    setHidden(log, !hasMessages);
  }

  /**
   * 运行时拼一个精灵图标：预览条与气泡里的附件芯片用。页面静态层的
   * `<svg><use>` 是写死在 HTML 里的，视图动态生成的节点只能用 createElementNS。
   */
  function iconNode(iconId) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "btn__icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#" + iconId);
    svg.appendChild(use);
    return svg;
  }

  /**
   * 气泡里的附件区：图片缩略图（thumb 兑底，blob 到手后升到原图；点击
   * 新标签页看全图）+ 文件芯片（只有名字——文件内容可能到 128KB，不往气泡里
   * 塞）。容器在无附件时根本不创建，布局上无痕。
   */
  function buildMessageMedia(message) {
    var images = imagesOf(message);
    var files = filesOf(message);
    var media = create("div", "chat__msg-media");
    for (var i = 0; i < images.length; i++) media.appendChild(buildMessageImage(images[i]));
    for (var j = 0; j < files.length; j++) media.appendChild(buildFileChip(files[j]));
    return media;
  }

  function buildMessageImage(att) {
    var link = create("a", "chat__msg-imglink");
    link.title = att.name;
    var display;
    if (att.thumb) {
      var img = document.createElement("img");
      img.className = "chat__msg-img";
      img.alt = t("chat.attach.imageAlt", { name: att.name });
      img.src = att.thumb;
      link.appendChild(img);
      display = img;
    } else {
      display = create("span", "chat__msg-img chat__msg-img--ph");
      display.setAttribute("role", "img");
      display.setAttribute("aria-label", t("chat.attach.imageAlt", { name: att.name }));
      display.appendChild(iconNode("icon-image"));
      link.appendChild(display);
    }
    upgradeImageLink(link, display, att);
    return link;
  }

  /**
   * blob 到手后把缩略图升到原图、把链接指到 object URL（新标签页看全图）。
   * 取不到 blob（被清理 / 降级后刷新）就保持缩略图或占位块——链一拉回还能看，
   * 这是消息里持久缩略图存在的原因。节点已被重画掉（切会话）就放弃。
   */
  function upgradeImageLink(link, display, att) {
    App.attachments.objectUrlOf(att.id).then(function (url) {
      if (!url) return;
      objectUrls[att.id] = url;
      if (!link.isConnected) return;
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      if (display.tagName === "IMG") display.src = url;
    });
  }

  function buildFileChip(file) {
    var chip = create("span", "chat__filechip");
    chip.title = file.name;
    chip.appendChild(iconNode("icon-file-text"));
    chip.appendChild(create("span", "chat__filechip-name", file.name));
    return chip;
  }

  /**
   * 一条消息节点：角色名 + 正文 + 附件区。正文一律 `textContent`，不拼
   * HTML。纯文本消息（大多数历史消息）是最简单的形态；纯文件消息没有正文
   * 节点，附件区就是全部。返回值仍是「会被 removeNode 连带删掉气泡的那个
   * 节点」：正文优先，其次附件区（见 removeNode 的调用方）。
   */
  function appendMessage(role, text, message) {
    var log = logNode();
    if (!log) return null;
    var node = create("div", "chat__msg chat__msg--" + role);
    node.appendChild(create("span", "chat__role", t(role === "user" ? "chat.role.user" : "chat.role.assistant")));
    var body = null;
    if (text || role === "assistant") {
      /* 助手消息即使空着也要有正文节点：流式增量往它身上写。 */
      body = create("div", "chat__body", text);
      node.appendChild(body);
    }
    var hasMedia = message && ((Array.isArray(message.attachments) && message.attachments.length > 0) || false);
    if (hasMedia) {
      var media = buildMessageMedia(message);
      node.appendChild(media);
      if (!body) body = media;
    }
    log.appendChild(node);
    syncEmptyState();
    scrollToEnd();
    return body;
  }

  /** 清空对话区并按会话的历史重画（切会话 / 删除后的兜底都走它）。*/
  function renderSessionLog(session) {
    var log = logNode();
    if (!log) return;
    clear(log);
    for (var i = 0; i < session.messages.length; i++) {
      appendMessage(session.messages[i].role, session.messages[i].content, session.messages[i]);
    }
    syncEmptyState();
    scrollToEnd();
  }

  /* ---- 会话（状态与持久化在 app-chat-sessions.js） ----------------------- */

  /** 会话的展示标题：空标题落到「新会话」（翻译由视图给，存的是空串）。*/
  function sessionDisplayName(session) {
    return chatSessions.displayName(session, t("chat.sessions.untitled"));
  }

  /*
   * 会话状态的真值在 `chatSessions` 里；下面这几个薄包装让渲染与发送链读起来跟
   * 拆之前一样，写路径则一律走模块动作（`add` / `remove` / `restore` / `setActive`）。
   */

  /** 全部会话的数组（只读视图：增删走 `chatSessions.add` / `remove` / `restore`）。*/
  function sessionList() {
    return chatSessions.list();
  }

  function currentSession() {
    return chatSessions.current();
  }

  function sessionById(id) {
    return chatSessions.byId(id);
  }

  /** 全量写回，接近配额的提醒在这里发（模块只回报布尔）。*/
  function persistSessions() {
    if (chatSessions.persist()) showNotice(t("chat.warn.storage"));
  }

  /**
   * 孤儿剪除的保留集：会话引用的全部图片 + 预览条里待发送的图。后者还没进任何
   * 会话（撤回后未重发、刚选还没发），剪了会把用户手里的图弄丢。
   */
  function keepImageIds() {
    var ids = chatSessions.referencedImageIds();
    for (var i = 0; i < pendingAttachments.length; i++) {
      var att = pendingAttachments[i];
      if (att.kind === "image" && ids.indexOf(att.id) < 0) ids.push(att.id);
    }
    return ids;
  }

  /** 一条消息里的图片 / 文件附件（气泡渲染与能力闸门都用）。*/
  var imagesOf = chatSessions.imagesOf;
  var filesOf = chatSessions.filesOf;

  /** 待发送附件的存储形状（图存引用，文件存正文——见 app-chat-sessions.js）。*/
  var attachmentsForStorage = chatSessions.attachmentsForStorage;

  /**
   * 把某个会话落为当前会话：重画消息区、按它的快照落四个下拉、清横幅。
   *
   * 只做「落」，不做持久化与列表重画——调用方各自安排顺序。
   */
  function activate(session) {
    chatSessions.setActive(session.id);
    renderSessionLog(session);
    /* 切会话是用户动作：401 挂起的粘贴提示随旧会话一起翻篇（横幅同样清空）。 */
    pastePrompt = null;
    applyChoices(session.choices);
    showError(null);
    showNotice(null);
  }

  /**
   * 在飞请求的正确收尾：先中止，再等收尾链走完。
   *
   * 收尾链的回调闭包捕获的是发送那一刻的会话与 DOM 节点；等它走完再换数据，
   * 部分回复才会落进原来那个会话的历史（而不是被切换吞掉或写错地方）。
   */
  function quiesce() {
    if (!controller) return Promise.resolve();
    controller.abort();
    var pending = inflight;
    controller = null;
    return pending || Promise.resolve();
  }

  /* ---- 会话列表渲染 ------------------------------------------------------ */

  /** 相对时间（与 key 页的「最后使用」同一口径，键换到 chat 自己的段）。*/
  var MINUTE_MS = C.SECONDS_PER_MINUTE * 1000;
  var HOUR_MS = C.SECONDS_PER_HOUR * 1000;
  var DAY_MS = C.SECONDS_PER_DAY * 1000;

  function relativeTime(at) {
    if (typeof at !== "number" || !Number.isFinite(at)) return t("chat.relative.now");
    var delta = Date.now() - at;
    if (delta < MINUTE_MS) return t("chat.relative.now");
    if (delta < HOUR_MS) return t("chat.relative.minutes", { count: Math.floor(delta / MINUTE_MS) });
    if (delta < DAY_MS) return t("chat.relative.hours", { count: Math.floor(delta / HOUR_MS) });
    return t("chat.relative.days", { count: Math.floor(delta / DAY_MS) });
  }

  /** 会话列表与窄屏下拉一起重画；列表按 updatedAt 降序（最近的在上）。*/
  function renderSessions() {
    var list = sessionList();
    list.sort(function (a, b) {
      return b.updatedAt - a.updatedAt;
    });

    /* 只重画会话项那一层：列表容器里住在顶部的 sticky 新建按钮，
       它是页面静态 DOM，不能跟着 clear 一起消失。 */
    var items = byRole("chat-session-items");
    if (items) {
      clear(items);
      for (var i = 0; i < list.length; i++) items.appendChild(buildSessionItem(list[i]));
    }

    var select = byRole("chat-session-select");
    if (select) {
      clear(select);
      for (var j = 0; j < list.length; j++) {
        var option = document.createElement("option");
        option.value = list[j].id;
        option.textContent = sessionDisplayName(list[j]);
        select.appendChild(option);
      }
      select.value = chatSessions.activeId() || "";
    }
  }

  function buildSessionItem(session) {
    /* 整行可聚焦：宽屏下会话栏是切换会话的唯一入口（窄屏走顶部的真 `<select>`），
       以前它是个带 click 的 div，Tab 永远进不去。`role="button"` 而不是真
       `<button>`：行里还嵌着删除键，按钮里不能再放按钮。
       `aria-current` 说「当前会话」——选中态原本只靠边框色。 */
    var item = create("div", "chat__session");
    item.setAttribute("data-session-id", session.id);
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    if (session.id === chatSessions.activeId()) {
      item.setAttribute("data-current", "true");
      item.setAttribute("aria-current", "true");
    }

    var title = create("span", "chat__session-title", sessionDisplayName(session));
    /* 标题一行截断（`.chat__session-title` 的 ellipsis），全名挂 `title`
       ——重命名可以写任意长，光靠截断之后就读不全了。 */
    title.title = sessionDisplayName(session);
    title.addEventListener("dblclick", function (event) {
      event.preventDefault();
      startRename(item, session, title);
    });
    item.appendChild(title);

    item.appendChild(create("span", "chat__session-time", relativeTime(session.updatedAt)));

    var remove = button("×", "chat__session-delete", function (event) {
      event.stopPropagation();
      deleteSession(session.id);
    });
    remove.setAttribute("aria-label", t("chat.sessions.delete"));
    remove.title = t("chat.sessions.delete");
    item.appendChild(remove);

    item.addEventListener("click", function () {
      switchToSession(session.id);
    });
    item.addEventListener("keydown", function (event) {
      /* 只在行自己拿着焦点时响应：焦点落在删除键或重命名输入框上时，按键是
         它们的。F2 与双击标题同义（重命名）。 */
      if (event.target !== item) return;
      if (event.key === "F2") {
        event.preventDefault();
        startRename(item, session, title);
        return;
      }
      /* 空格在按下时处理（与原生按钮一致）；Enter 挂在 keydown 上是因为这个
         行不是真按钮，没有默认的激活行为可等。 */
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      switchToSession(session.id);
    });
    return item;
  }

  /**
   * 重命名：标题被替换成原位输入框，Enter / 失焦提交，Esc 取消。
   *
   * 键盘入口是 F2（会话项拿着焦点时按一下）与鼠标的双击标题。重命名结束后重画
   * 列表，焦点回到这条会话项本身——输入框已经不在 DOM 里了，不还焦点就会掉到
   * `<body>`。
   */
  function startRename(item, session, titleNode) {
    if (!item || item.querySelector(".chat__rename")) return;
    var input = create("input", "chat__rename");
    input.type = "text";
    input.value = session.title;
    /* 输入框自己的值就是可访问名要说的东西：重命名哪一条会话。 */
    input.setAttribute("aria-label", sessionDisplayName(session));
    var done = false;
    var finish = function (save) {
      if (done) return;
      done = true;
      if (save) {
        var name = input.value.trim();
        if (name && name !== session.title) {
          session.title = name;
          session.updatedAt = Date.now();
          persistSessions();
        }
      }
      var id = session.id;
      renderSessions();
      focusSessionItem(id);
    };
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", function () {
      finish(true);
    });
    if (titleNode && titleNode.parentNode === item) item.replaceChild(input, titleNode);
    else if (item.firstChild) item.insertBefore(input, item.firstChild);
    else item.appendChild(input);
    input.focus();
    try {
      input.select();
    } catch {
      /* 选不中全文就让它停在末尾，无碍 */
    }
  }

  /** 重画后把焦点放回某条会话项（会话可能已经不在了：那时什么也不做）。*/
  function focusSessionItem(id) {
    var items = byRole("chat-session-items");
    if (!items) return;
    var node = items.querySelector('[data-session-id="' + id + '"]');
    if (node && typeof node.focus === "function") node.focus();
  }

  /* ---- 会话操作 ---------------------------------------------------------- */

  /** 切会话：在飞的先收尾（abort + 等链走完），再换数据。*/
  function switchToSession(id) {
    if (id === chatSessions.activeId()) return;
    quiesce().then(function () {
      var session = sessionById(id);
      if (!session) return null;
      activate(session);
      renderSessions();
      return null;
    });
  }

  /**
   * 新建：继承当前四个下拉的选择（测试矩阵里「只改一个维度」从这里开始）。
   *
   * 去重：当前会话本来就是空的（一条消息都没有）就不再创建——连点新建
   * 攒出一列「新会话 1 分钟前」是实测 bug。聚焦 / 高亮现有的空会话即可：
   * activate 重落它的选择快照并清横幅，renderSessions 保证高亮，输入框回焦点。
   * 判据只有 messages.length：预览条里的待发附件不在此列（它不属于任何会话，
   * 切到新会话仍带着）。
   */
  function newSession() {
    quiesce().then(function () {
      var existing = currentSession();
      if (existing && existing.messages.length === 0) {
        activate(existing);
        renderSessions();
        var focused = inputNode();
        if (focused) focused.focus();
        return null;
      }
      chatSessions.add(currentChoices());
      persistSessions();
      activate(currentSession());
      renderSessions();
      var input = inputNode();
      if (input) input.focus();
      return null;
    });
  }

  /* ---- 删除与撤销 --------------------------------------------------------- */

  /**
   * 待撤销的删除：会话已从内存与存储里移除，但图片剪除暂缓到撤销窗口关闭。
   *
   * `{ session, wasActive, fallbackId, timer }`——`fallbackId` 是「删的是最后一条」
   * 时自动补出来的空会话；撤销时要把它收回（否则用户得到一条自己没建的空会话）。
   */
  var pendingDelete = null;

  /**
   * 关闭撤销窗口 = 提交删除。这里的 `attachments.pruneExcept` 是定向孤儿剪除
   * （按余下会话的引用集剪）；预览条里的待发图仍然保留（`keepImageIds` 算上了）。
   *
   * 为什么得拖到窗口关闭才剪：撤销要把会话原样放回来，而图片 blob 一旦
   * 剪掉就回不来了——先剪再撤销会得到一屏「图片已不在本机存储」的占位。
   * 反正进视图时还有一次全局孤儿剪除兜底，即使窗口未关闭就刷新页也不会漏。
   */
  function closeUndoWindow() {
    if (!pendingDelete) return;
    window.clearTimeout(pendingDelete.timer);
    pendingDelete = null;
    App.attachments.pruneExcept(keepImageIds());
  }

  /** 打开撤销窗口：一条 toast + 定时器，到时自动提交。*/
  function openUndoWindow(session, wasActive, fallbackId) {
    /* 前一次删除先收口：同一时刻只有一条撤销条，也就只有一个待撤销的删除。 */
    closeUndoWindow();
    pendingDelete = {
      session: session,
      wasActive: wasActive,
      fallbackId: fallbackId,
      timer: window.setTimeout(function () {
        closeUndoWindow();
      }, C.CHAT_UNDO_MS),
    };
    App.widgets.toast.show({
      text: t("chat.sessions.deleted", { title: sessionDisplayName(session) }),
      actionLabel: t("chat.sessions.undo"),
      action: restoreDeletedSession,
      durationMs: C.CHAT_UNDO_MS,
    });
  }

  /**
   * 撤销：把会话原样放回列表（含消息、附件引用与选择快照），恢复当前选中。
   *
   * `sessions.push` 与 `renderSessions` 里的排序一起保证它回到原来的时间位；
   * 删除前就是当前会话的，重新激活一次把消息区与四个下拉拉回这个快照。
   */
  function restoreDeletedSession() {
    var pending = pendingDelete;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingDelete = null;

    /* 自动补的空会话是为「删掉最后一条」服务的：会话回来了它就没用了，
       但只收自己补的那条（用户真正在编辑的空会话不能动）——这一步在模块里。 */
    var outcome = chatSessions.restore(pending);
    if (outcome.reopened) activate(pending.session);
    persistSessions();
    renderSessions();
  }

  /**
   * 删除：先收尾在飞请求，再直接从内存与存储里移除（不弹二次确认，靠撤销条兜底）。
   *
   * 删的是当前会话就落到最近的另一条（一条不剩就新建一条空的——现有行为）。
   * 反悔入口是同一条 toast 里的「撤销」，窗口 `CHAT_UNDO_MS`（5 秒）；窗口内
   * 不剪图片，关闭时才剪（见 `closeUndoWindow`）。最后一个会话删完又自动补了
   * 空会话时，撤销会把那条自动补的收回去。
   */
  function deleteSession(id) {
    quiesce().then(function () {
      var removed = chatSessions.remove(id, currentChoices());
      if (!removed) return null;
      if (removed.wasActive) activate(currentSession());
      persistSessions();
      renderSessions();
      openUndoWindow(removed.session, removed.wasActive, removed.fallbackId);
      return null;
    });
  }

  /* ---- 层级选择（账号 → 套餐 → 模型 → key） ------------------------------ */

  /**
   * 四层的「空选择」及其含义（服务端语义，前端只负责不带）：
   *
   *   账号 "" → 不带 X-ZCode-Account，调度器自动选号
   *   套餐 "" → 不带 X-ZCode-Route，按策略选档
   *   模型 "" → body 不带 model 字段，服务端默认
   *   key   "" → 不带 Authorization，面板会话（Cookie）归因
   *
   * key 非空时除 Bearer 完整值外还带 `credentials: "omit"`：不带 Cookie，
   * 鉴权优先级才轮得到 Bearer key——否则选中的 key 只被当成真伪测试（见
   * `send`）。
   */

  function buildOption(value, label) {
    var option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }

  function selectHas(select, value) {
    for (var i = 0; i < select.options.length; i++) {
      if (select.options[i].value === value) return true;
    }
    return false;
  }

  /** 下拉重建的回落值写回会话（应用快照期间、首拍之前都跳过，理由见各自注释）。*/
  function writeBackChoice(field, value) {
    /* 摘要先刷新：快照恢复期间的部分状态也会被后面 applyChoices 末尾的
       一次完整刷新盖掉，多写几次 textContent 无害。 */
    updateSelectorSummary();
    if (applyingChoices || !choicesApplied) return;
    var session = currentSession();
    if (!session || session.choices[field] === value) return;
    session.choices[field] = value;
    persistSessions();
  }

  /** 启用中的账号 label（下拉的选项集；禁用账号不出现——不可路由的没有意义）。*/
  function enabledAccountLabels(accounts) {
    var labels = [];
    if (!Array.isArray(accounts)) return labels;
    for (var i = 0; i < accounts.length; i++) {
      var account = accounts[i];
      if (account && account.enabled === true && typeof account.label === "string" && account.label) {
        labels.push(account.label);
      }
    }
    return labels;
  }

  /** `app.js` 的 renderState 每 5 秒调一次：账号增删 / 启停在这里跟上。*/
  function syncAccounts(accounts) {
    var labels = enabledAccountLabels(accounts);
    var signature = labels.join("\u0000");
    if (signature === accountSignature) return;
    accountSignature = signature;
    rebuildAccountOptions(labels);
    /* 账号集变了，套餐的合法集也可能变（原账号消失 → 回到全部四条）。 */
    rebuildRouteOptions();
  }

  function rebuildAccountOptions(labels) {
    var select = byRole("chat-account");
    if (!select) return;
    var previous = select.value;
    clear(select);
    select.appendChild(buildOption("", t("chat.account.auto")));
    for (var i = 0; i < labels.length; i++) select.appendChild(buildOption(labels[i], labels[i]));
    var next = previous !== "" && labels.indexOf(previous) >= 0 ? previous : "";
    select.value = next;
    writeBackChoice("account", next);
  }

  /**
   * 套餐下拉：选了账号 → 该账号允许的路由；没选 → 全部四条 ROUTE_KINDS。
   *
   * 选项文字就是协议值（`coding-plan` 等）——与日志页的路由过滤同一条约定：
   * 技术标识不翻译，界面上出现什么、请求头里就发什么。当前值还在合法集里就保留
   *（语言切换重建时不丢），不在就回落「按策略」。
   */
  function rebuildRouteOptions() {
    var account = byRole("chat-account");
    var route = byRole("chat-route");
    if (!account || !route) return;

    var routes = null;
    var state = App.state.lastState;
    var accounts = state && Array.isArray(state.accounts) ? state.accounts : [];
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i] && accounts[i].label === account.value) {
        routes = accounts[i].routes;
        break;
      }
    }
    if (!Array.isArray(routes)) routes = C.ROUTE_KINDS;
    var valid = [];
    for (var j = 0; j < routes.length; j++) {
      if (C.ROUTE_KINDS.indexOf(routes[j]) >= 0) valid.push(routes[j]);
    }

    var signature = t("chat.route.policy") + "\u0000" + valid.join("\u0000");
    if (signature === routeSignature) return;
    routeSignature = signature;

    var previous = route.value;
    clear(route);
    route.appendChild(buildOption("", t("chat.route.policy")));
    for (var k = 0; k < valid.length; k++) route.appendChild(buildOption(valid[k], valid[k]));
    var next = previous !== "" && valid.indexOf(previous) >= 0 ? previous : "";
    route.value = next;
    writeBackChoice("route", next);
  }

  /**
   * 模型下拉：`/v1/models` 的广告面 + 「服务端默认」。清单没到之前不校验存量值。
   *
   * 服务端在 `/v1/models` 里广告了生效的 defaultModel（非标准字段
   * `default_model`）时，空值选项显示成「默认（glm-5.3-flash）」—— 用户看得见
   * 实际将用的模型，不再误以为有个神秘的「默认」。拿不到该字段就
   * 维持原文案「服务端默认」。选项的 value 不变仍是空串：发送行为不变，body 不
   * 带 model，由主链路注入（proxy/default-model.ts）。
   */
  function renderModelOptions() {
    var select = byRole("chat-model");
    if (!select) return;
    var defaultLabel = defaultModelId ? t("chat.model.defaultWithModel", { model: defaultModelId }) : t("chat.model.default");
    var signature = defaultLabel + "\u0000" + modelIds.join("\u0000");
    if (signature === modelSignature) return;
    modelSignature = signature;

    var previous = select.value;
    clear(select);
    select.appendChild(buildOption("", defaultLabel));
    for (var i = 0; i < modelIds.length; i++) select.appendChild(buildOption(modelIds[i], modelIds[i]));
    var next = previous !== "" && modelIds.indexOf(previous) >= 0 ? previous : "";
    select.value = next;
    writeBackChoice("model", next);
  }

  function keyOptionLabel(record) {
    return String(record.name || "") + " (" + String(record.prefix || "") + "…)";
  }

  /**
   * key 下拉：面板会话（默认）+ 已管理的 key + 手动输入。
   *
   * 禁用的 key 以禁用选项出现（看得见、选不了）：它还挂在 key 表里，用户该知道
   * 「这把 key 现在用不了」，而不是看着它凭空消失。已吊销（表里没有）的条目才会
   * 从下拉里消失——选中值随之回落「面板会话」。
   */
  function renderKeyOptions() {
    var select = byRole("chat-key-select");
    if (!select) return;
    var signature = t("chat.key.session") + "\u0000" + t("chat.key.manualOption");
    for (var i = 0; i < keyRows.length; i++) {
      signature += "\u0000" + keyRows[i].id + ":" + keyRows[i].name + ":" + keyRows[i].prefix + ":" + (keyRows[i].enabled === false ? "0" : "1");
    }
    if (signature === keySignature) return;
    keySignature = signature;

    var previous = select.value;
    clear(select);
    select.appendChild(buildOption("", t("chat.key.session")));
    for (var j = 0; j < keyRows.length; j++) {
      var option = buildOption(keyRows[j].id, keyOptionLabel(keyRows[j]));
      if (keyRows[j].enabled === false) option.disabled = true;
      select.appendChild(option);
    }
    select.appendChild(buildOption(MANUAL_KEY_ID, t("chat.key.manualOption")));
    var next = previous !== "" && selectHas(select, previous) ? previous : "";
    select.value = next;
    writeBackChoice("key", next);
    /* 选择真的变了才动粘贴行：401 降级刚把它请出来时，key 清单的一次重建
       （选择没变）不得把它再收回去。 */
    if (next !== previous) syncKeyManualRow(next);
  }

  /**
   * 把一个 key 选择落到下拉 + 会话快照 + 粘贴行的显隐。
   *
   * 选了某把 key 但本机没有它的完整值 → 立刻请出粘贴行：选 key 的意义就在于
   * 发那把 key 的完整值，含糊地带 Cookie 发出去会把用量算到别处（归因造假）。
   */
  /**
   * 折叠标题行的当前组合摘要：不展开选择器区也能看出发什么。四段用
   * 「 · 」连接，空选择显示各自的短词（自动 / 策略 / 默认 / 会话）。
   */
  function updateSelectorSummary() {
    var node = byRole("chat-selectors-summary");
    if (!node) return;
    var account = byRole("chat-account");
    var route = byRole("chat-route");
    var model = byRole("chat-model");
    var parts = [
      account && account.value ? account.value : t("chat.summary.auto"),
      route && route.value ? route.value : t("chat.summary.policy"),
      model && model.value ? model.value : t("chat.summary.default"),
    ];
    var key = keyChoice();
    if (!key) parts.push(t("chat.summary.session"));
    else if (key === MANUAL_KEY_ID) parts.push(t("chat.summary.manual"));
    else parts.push(keyNameOf(key));
    node.textContent = parts.join(" · ");
  }

  /**
   * 展开选择器折叠区：401 降级 / 选了缺完整值的 key 时，粘贴行在折叠
   * 体里——不展开就是「横幅指向一个看不见的输入框」（UI 审查 #2 的教训换了
   * 个藏身处）。只在用户动作的路径上调：恢复快照的例行显隐不抢用户的折叠状态。
   */
  function expandSelectors() {
    if (App.widgets.isCollapsed("chat-selectors")) App.widgets.setCollapsed("chat-selectors", false);
  }

  function setKeyChoice(value) {
    var select = byRole("chat-key-select");
    if (!select) return;
    var next = value && selectHas(select, value) ? value : "";
    select.value = next;
    writeBackChoice("key", next);
    syncKeyManualRow(next);
  }

  /** 选中项缺完整值时的分流：手动输入请出粘贴行（401 挂起的粘贴提示
   *  不被例行的收起逻辑顶掉——pastePrompt 锁存器）。已管理 key 必有完整值
   *  （5.0 契约），缺值只剩「手动输入」一种场景。*/
  function syncKeyManualRow(choice) {
    if (choice && !keyFor(choice)) {
      /* 用户亲手选 key（或 401 后的选择）才展开；enter() 恢复快照的例行调用
         发生在 choicesApplied 之前，不抢用户的折叠状态。 */
      if (choicesApplied) expandSelectors();
      configureKeyPaste(choice, true);
      return;
    }
    if (!pastePrompt) hideKeyManual();
  }

  function keyNameOf(keyId) {
    for (var i = 0; i < keyRows.length; i++) {
      if (keyRows[i].id === keyId) return String(keyRows[i].name || keyId);
    }
    return keyId;
  }

  /**
   * 请出手动粘贴行（唯一路径：「手动输入」选项，或 401 后的兑底）。
   *
   * 「记住此 key」默认勾上：手动粘进来的完整 key 用户几乎总是为了反复用；不想
   * 落盘的人可以取消勾选（那次粘贴只活在本页生存期内）。粘进来的值与某把已管理
   * key 前缀唯一命中时，applyManualKey 把它记到那把 keyId 名下并把下拉切过去。
   */
  function configureKeyPaste(target, focus) {
    keyPasteTarget = target;
    pastePrompt = target;
    var row = byRole("chat-key-manual");
    var input = byRole("chat-key");
    var remember = byRole("chat-key-remember");
    if (!row || !input) return;
    setHidden(row, false);
    if (remember) remember.checked = true;
    input.value = keyFor(target);
    input.placeholder = t("chat.keyHint");
    if (focus) {
      try {
        input.focus();
      } catch {
        /* 聚焦失败不影响功能 */
      }
    }
  }

  function hideKeyManual() {
    keyPasteTarget = null;
    pastePrompt = null;
    var row = byRole("chat-key-manual");
    var input = byRole("chat-key");
    if (row) setHidden(row, true);
    if (input) input.value = ""; /* 收起就不留明文（key 页创建模态的同一条规矩）*/
  }

  /**
   * 手动输入的 key 按前缀认亲：与某把已管理 key 的 prefix 唯一命中时，记到那把
   * keyId 名下并把下拉切过去。命中不了（或清单没到）就落 manual 桶——归因由
   * 服务端按收到的完整 key 判定，本地的桶只决定「下次从哪里取」。
   */
  function matchKeyByPrefix(fullKey) {
    var hits = [];
    for (var i = 0; i < keyRows.length; i++) {
      var prefix = keyRows[i].prefix;
      if (typeof prefix === "string" && prefix && fullKey.indexOf(prefix) === 0) hits.push(keyRows[i].id);
    }
    return hits.length === 1 ? hits[0] : null;
  }

  /** 「使用」：粘贴生效。勾了「记住」就落 localStorage（按 keyId 关联）。*/
  function applyManualKey() {
    var input = byRole("chat-key");
    var remember = byRole("chat-key-remember");
    var select = byRole("chat-key-select");
    if (!input || !select) return;
    var raw = input.value.trim();
    if (!raw) {
      showError(t("chat.error.keyEmpty"));
      return;
    }
    var target = keyPasteTarget || MANUAL_KEY_ID;
    if (target === MANUAL_KEY_ID && remember && remember.checked) {
      var matched = matchKeyByPrefix(raw);
      if (matched) target = matched;
    }
    runtimeKeys[target] = raw;
    if (remember && remember.checked) {
      rememberedKeys[target] = raw;
      persistKeys();
    }
    /* 粘贴本身就是一次显式的 key 选择：从「面板会话」上贴 key（401 降级的路）
       之后，下拉也切到这份 key 上，下一次发送才真的带它。 */
    if (selectHas(select, target)) select.value = target;
    writeBackChoice("key", select.value);
    hideKeyManual();
    showError(null);
    /* key 换了就重读模型列表：401 修好之后模型下拉要自己长回来。*/
    loadModels();
  }

  /* ---- key 存储 ---------------------------------------------------------- */

  function readKeysMap() {
    var raw = store.read(KEYS_STORAGE_KEY);
    if (!raw) return {};
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {}; /* 损坏的值：回落空表，用户重新粘贴即可 */
    }
    var map = {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return map;
    for (var key in parsed) {
      if (Object.prototype.hasOwnProperty.call(parsed, key) && typeof parsed[key] === "string" && parsed[key]) {
        map[key] = parsed[key];
      }
    }
    return map;
  }

  function persistKeys() {
    store.write(KEYS_STORAGE_KEY, JSON.stringify(rememberedKeys));
  }

  /** 恢复 key 表（按 keyId 关联，带「记住」勾选）。*/
  function loadKeyState() {
    rememberedKeys = readKeysMap();
  }

  /** 选中 key 的完整值：先内存（没勾「记住」的粘贴），再 localStorage；都没有
   *  就查 `listApiKeys` 带回的 secret（服务端解密后的明文，选中即可发）。
   *  已管理 key 必有值（5.0 契约）；实时查表不落缓存：key 页重建后这张表就是
   *  最新真值。*/
  function keyFor(choice) {
    if (!choice) return "";
    if (runtimeKeys[choice]) return runtimeKeys[choice];
    var saved = rememberedKeys[choice];
    if (typeof saved === "string" && saved) {
      runtimeKeys[choice] = saved;
      return saved;
    }
    for (var i = 0; i < keyRows.length; i++) {
      if (keyRows[i].id === choice && typeof keyRows[i].secret === "string" && keyRows[i].secret) {
        return keyRows[i].secret;
      }
    }
    return "";
  }

  /* ---- 请求接线 ---------------------------------------------------------- */

  function keyChoice() {
    var select = byRole("chat-key-select");
    return select ? select.value : "";
  }

  /**
   * 代理要求的 `Authorization` 头。
   *
   * 「面板会话（默认）」不带（Cookie 随同源请求走）；选了 key 就带它的完整
   * 值——用量归因到那把 key。发送前有守卫（见 `send`）：选了 key 但没有完整值时
   * 根本不发，含糊地发出去只会把用量算到别处。
   */
  function authHeaders() {
    var key = keyFor(keyChoice());
    return key ? { authorization: "Bearer " + key } : {};
  }

  /** 显式路由头：选了才带；空选择 = 不带 = 调度器按策略。*/
  function routingHeaders() {
    var headers = {};
    var account = byRole("chat-account");
    var route = byRole("chat-route");
    if (account && account.value) headers["X-ZCode-Account"] = account.value;
    if (route && route.value) headers["X-ZCode-Route"] = route.value;
    return headers;
  }

  /** 四个下拉的当前值（新建会话时 inheriting 用的快照）。*/
  function currentChoices() {
    var account = byRole("chat-account");
    var route = byRole("chat-route");
    var model = byRole("chat-model");
    var key = byRole("chat-key-select");
    return {
      account: account ? account.value : "",
      route: route ? route.value : "",
      model: model ? model.value : "",
      key: key ? key.value : "",
    };
  }

  /**
   * 把一份选择快照落到四个下拉上（切会话 / 进视图）。
   *
   * 存过的选择不在当前可选项里就回落到该层的「空选择」，并把回落值写回会话：
   * 下一次请求不带那个头 / 字段，界面上看到什么、线上就发什么。
   */
  function applyChoices(choices) {
    applyingChoices = true;
    try {
      var account = byRole("chat-account");
      var route = byRole("chat-route");
      var model = byRole("chat-model");
      if (!account || !route || !model) return;

      var accountValue = choices && selectHas(account, String(choices.account || "")) && choices.account ? choices.account : "";
      account.value = accountValue;

      /* 套餐的合法集跟着账号走：先落账号，再按新账号重建套餐选项，最后落套餐值。
         存过的账号已经不在（被删 / 禁用）时，套餐也不保留——那是「那个账号的」钉档，
         账号没了组合就散了，不能变成一个没主的 route-only。 */
      rebuildRouteOptions();
      var routeValue = choices && choices.route && selectHas(route, choices.route) ? choices.route : "";
      if (choices && choices.account && !accountValue) routeValue = "";
      route.value = routeValue;

      var modelValue = choices && choices.model && modelIds.indexOf(choices.model) >= 0 ? choices.model : "";
      model.value = selectHas(model, modelValue) ? modelValue : "";

      setKeyChoice(choices && typeof choices.key === "string" ? choices.key : "");

      /* 回落值统一写回会话（写回时已退出 applyingChoices）：快照里失效的选择
         就此作废，下一轮请求不再发它。 */
      var session = currentSession();
      if (session) {
        var changed = false;
        if (session.choices.account !== accountValue) {
          session.choices.account = accountValue;
          changed = true;
        }
        if (session.choices.route !== routeValue) {
          session.choices.route = routeValue;
          changed = true;
        }
        if (session.choices.model !== modelValue) {
          session.choices.model = modelValue;
          changed = true;
        }
        if (session.choices.key !== keyChoice()) {
          session.choices.key = keyChoice();
          changed = true;
        }
        if (changed) persistSessions();
      }
    } finally {
      applyingChoices = false;
    }
  }

  /* ---- 下拉事件 ---------------------------------------------------------- */

  function onAccountChange() {
    var account = byRole("chat-account");
    var route = byRole("chat-route");
    if (!account) return;
    writeBackChoice("account", account.value);
    /* 切账号一律重置套餐到「按策略」：不管新账号是否也允许旧套餐——「账号×套餐」
       的组合是用户显式选出来的，换账号后沿用旧套餐只会造成「以为还在测 A 的
       start-plan，其实测的是 B 的」这类误判。 */
    writeBackChoice("route", "");
    if (route) route.value = "";
    rebuildRouteOptions();
  }

  function onRouteChange() {
    var route = byRole("chat-route");
    if (route) writeBackChoice("route", route.value);
  }

  function onModelChange() {
    var model = byRole("chat-model");
    if (model) writeBackChoice("model", model.value);
  }

  function onKeyChoiceChange() {
    /* 用户亲手改选择 = 对挂起提示的表态：回面板会话或换一把有完整值的，行都该收起。 */
    pastePrompt = null;
    setKeyChoice(keyChoice());
    /* key 换了就重读模型列表：401 修好之后模型下拉要自己长回来（rememberKey
       同一条语义，只是触发点从输入框换成了下拉）。*/
    loadModels();
  }

  /* ---- 模型列表 ---------------------------------------------------------- */

  /** 读一次 `/v1/models`，把可选模型填进下拉框（key 换了之后也要重读一次）。*/
  function loadModels() {
    var select = byRole("chat-model");
    if (!select) return Promise.resolve();
    return window
      .fetch(CHAT_MODELS_PATH, { headers: Object.assign({}, authHeaders(), CLIENT_HEADER) })
      .then(function (response) {
        if (!response.ok) return failed(response, "chat.error.models");
        return response.json().then(function (body) {
          var models = (body && body.data) || [];
          var ids = [];
          var vision = {};
          for (var i = 0; i < models.length; i++) {
            if (!models[i] || typeof models[i].id !== "string") continue;
            ids.push(models[i].id);
            /* 模态数组在 OpenRouter 风格的 architecture 块里
               （顶层 input_modalities 已删除），目录内 id 才有 = 已知；目录外的
               id 无 architecture，visionOkForSend 对未知 fail-open。 */
            var arch = models[i].architecture;
            if (arch && Array.isArray(arch.input_modalities)) {
              vision[models[i].id] = arch.input_modalities.includes("image");
            }
          }
          modelIds = ids;
          visionById = vision;
          /* 同一份应答里的非标准字段 default_model = 生效的 defaultModel。
             字段缺省时保持空串，选项退回原文案。 */
          defaultModelId = body && typeof body.default_model === "string" ? body.default_model : "";
          renderModelOptions();
          showError(null);
          return null;
        });
      })
      .catch(function (error) {
        console.error("[chat] model list failed", error);
        showError(t("chat.error.models"));
        return null;
      });
  }

  /** 首次进视图拉一次；之后只在 key 变化时手动重拉（不随轮询反复重拉）。*/
  function ensureModels() {
    if (modelsLoaded) return Promise.resolve();
    modelsLoaded = true;
    return loadModels();
  }

  var modelsLoaded = false;

  /* ---- key 清单（listApiKeys，key 页的同一份命令） ----------------------- */

  function loadKeyOptions() {
    return App.api.sendControl({ cmd: "listApiKeys" }).then(function (body) {
      if (body && body.ok && Array.isArray(body.apiKeys)) keyRows = body.apiKeys;
      /* 命令失败（网络 / 应答不完整）保留上一次的表：别因为一次抖动把用户选着的
         key 从下拉里抹掉。首次拉取失败就是空表（下拉只剩面板会话 + 手动输入）。 */
      renderKeyOptions();
      return null;
    });
  }

  /* ---- 附件：选择 → 类型分流 → 预览条 ------------------------------------ */

  function extensionOf(name) {
    var dot = name.lastIndexOf(".");
    return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  }

  /** 图片：mime 前缀或扩展名（file.type 为空的拖放来源按扩展名认）。*/
  function isImageFile(file) {
    var type = typeof file.type === "string" ? file.type : "";
    if (type.startsWith("image/")) return true;
    return C.CHAT_IMAGE_EXTENSIONS.includes(extensionOf(file.name));
  }

  /** 文本类：mime text/* 或扩展名命中清单（与官方客户端同一张表）。*/
  function isTextLikeFile(file) {
    var type = typeof file.type === "string" ? file.type.split(";")[0] : "";
    if (type.startsWith("text/")) return true;
    return C.CHAT_TEXT_FILE_EXTENSIONS.includes(extensionOf(file.name));
  }

  function limitLabel(bytes) {
    return bytes >= 1024 * 1024 ? Math.round(bytes / (1024 * 1024)) + "MB" : Math.round(bytes / 1024) + "KB";
  }

  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      /* window. 前缀：测试环境里裸 FileReader 解析到运行宿主的全局，而不是
         测试 window 的实现（页面脚本只注入 window / document 两个名字）。
         浏览器里两者同一个对象，行为不变。 */
      var reader = new window.FileReader();
      reader.onload = function () {
        resolve(typeof reader.result === "string" ? reader.result : null);
      };
      reader.onerror = function () {
        reject(reader.error);
      };
      reader.readAsText(file);
    });
  }

  /** file input 的 change：逐个走类型分流（串行处理，拒绝路径只留最后一条横幅）。*/
  function onFilesPicked(fileList) {
    /* 先拷贝再清 value：真实浏览器的 FileList 是活绑定，`value = ""` 会把
       已经捕获的列表一并清空（happy-dom 的列表是快照，测试里发现不了）。
       清 value 是为了同一张图选两次也能再触发 change。 */
    var files = [];
    for (var i = 0; i < fileList.length; i++) {
      if (fileList[i]) files.push(fileList[i]);
    }
    var input = byRole("chat-file-input");
    if (input) input.value = "";
    var chain = Promise.resolve();
    for (var j = 0; j < files.length; j++) {
      (function (file) {
        chain = chain.then(function () {
          return attachOne(file);
        });
      })(files[j]);
    }
    return chain.then(function () {
      renderPreviews();
      return null;
    });
  }

  function attachOne(file) {
    var name = typeof file.name === "string" && file.name ? file.name : "file";
    if (pendingAttachments.length >= C.CHAT_MAX_ATTACHMENTS_PER_MESSAGE) {
      showError(t("chat.error.attachLimit", { count: C.CHAT_MAX_ATTACHMENTS_PER_MESSAGE }));
      return Promise.resolve(null);
    }
    if (isImageFile(file)) return attachImage(file, name);
    if (isTextLikeFile(file)) return attachTextFile(file, name);
    /* 只接受图片与文本类文件。二进制一律拒绝：上游多模态契约只覆盖图片。 */
    showError(t("chat.error.fileUnsupported", { name: name }));
    return Promise.resolve(null);
  }

  function attachImage(file, name) {
    if (file.size > C.CHAT_IMAGE_MAX_BYTES) {
      showError(t("chat.error.imageTooLarge", { name: name, limit: limitLabel(C.CHAT_IMAGE_MAX_BYTES) }));
      return Promise.resolve(null);
    }
    /* file.type 为空时按扩展名补 media type：data URL 的前缀就是上游看到的
       media_type，空类型会被当成 application/octet-stream 而不是图片。 */
    var blob = file.type
      ? file
      : new window.Blob([file], { type: C.CHAT_IMAGE_MIME_BY_EXT[extensionOf(name)] || "image/png" });
    var wasDegraded = App.attachments.isDegraded();
    return App.attachments.putImage(blob).then(function (stored) {
      var entry = {
        kind: "image",
        id: stored.id,
        name: name,
        blob: blob,
        objectUrl: window.URL.createObjectURL(blob),
        thumb: null,
        persisted: stored.persisted,
      };
      objectUrls[stored.id] = entry.objectUrl;
      pendingAttachments.push(entry);
      if (!stored.persisted) warnDegraded(name, wasDegraded);
      /* 芯片先进预览条（无缩略图态）；缩略图解码是异步且可能永远不回（安全网
         500ms），不能让它挡住「选了就能看见」。 */
      renderPreviews();
      return App.attachments.makeThumb(blob).then(function (thumb) {
        entry.thumb = thumb;
        renderPreviews();
        return null;
      });
    });
  }

  function attachTextFile(file, name) {
    /* 超限的文本文件不直接拒绝——截断到上限并附上（开头往往就是用户想给
       模型看的那段），横幅说明「已截断，完整内容见原文件」。图片走另一条路
       （10MB 上限，IndexedDB 存 blob），两边上限不同是内容形态决定的：文本注入
       对话正文（撑大每轮请求），图片走视觉通道。 */
    const truncated = file.size > C.CHAT_TEXT_FILE_MAX_BYTES;
    return readFileAsText(file).then(
      function (text) {
        if (text === null) {
          showError(t("chat.error.fileRead", { name: name }));
          return null;
        }
        const body = truncated ? text.slice(0, C.CHAT_TEXT_FILE_MAX_BYTES) : text;
        pendingAttachments.push({ kind: "file", name: name, text: body });
        if (truncated) {
          showError(
            t("chat.error.fileTooLarge", {
              name: name,
              limit: limitLabel(C.CHAT_TEXT_FILE_MAX_BYTES),
              truncated: limitLabel(C.CHAT_TEXT_FILE_MAX_BYTES),
            }),
          );
        }
        return null;
      },
      function () {
        showError(t("chat.error.fileRead", { name: name }));
        return null;
      },
    );
  }

  /**
   * 图片没能进 IndexedDB 的提示：环境本身不可用（隐私模式）说一次就够；
   * 单张配额爆掉（之前可用、这张没落盘）按张提示。
   */
  function warnDegraded(name, wasDegraded) {
    if (!wasDegraded) {
      showNotice(t("chat.warn.idbQuota", { name: name }));
      return;
    }
    if (degradedNoticeShown) return;
    degradedNoticeShown = true;
    showNotice(t("chat.warn.imageSessionOnly"));
  }

  /* ---- 预览条（输入框上方的待发送附件） ---------------------------------- */

  function renderPreviews() {
    var strip = byRole("chat-previews");
    if (!strip) return;
    clear(strip);
    setHidden(strip, pendingAttachments.length === 0);
    for (var i = 0; i < pendingAttachments.length; i++) {
      strip.appendChild(buildPreviewChip(pendingAttachments[i], i));
    }
  }

  function buildPreviewChip(att, index) {
    var chip = create("div", "chat__preview" + (att.kind === "file" ? " chat__preview--file" : ""));
    if (att.kind === "image") {
      if (att.thumb) {
        var img = document.createElement("img");
        img.src = att.thumb;
        img.alt = t("chat.attach.imageAlt", { name: att.name });
        chip.appendChild(img);
      } else {
        var ph = create("span", "chat__preview-ph");
        ph.appendChild(iconNode("icon-image"));
        chip.appendChild(ph);
      }
    } else {
      chip.appendChild(iconNode("icon-file-text"));
      chip.appendChild(create("span", "chat__preview-name", att.name));
    }
    chip.title = att.name;
    var remove = button("×", "chat__preview-remove", function () {
      dropPendingAttachment(index);
    });
    remove.setAttribute("aria-label", t("chat.attach.remove", { name: att.name }));
    chip.appendChild(remove);
    return chip;
  }

  /** 单张移除：芯片从预览条消失，图从存储层删除（此刻没有任何消息引用它）。*/
  function dropPendingAttachment(index) {
    var att = pendingAttachments[index];
    if (!att) return;
    pendingAttachments.splice(index, 1);
    if (att.kind === "image") {
      App.attachments.removeImages([att.id]);
      delete objectUrls[att.id];
    }
    renderPreviews();
  }

  /** 发送失败撤回的一轮：附件从消息上还回预览条（图片按引用回列，不重选）。*/
  function restorePendingFromMessage(message) {
    var list = message && Array.isArray(message.attachments) ? message.attachments : [];
    if (list.length === 0) return;
    var restored = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.kind === "image") {
        restored.push({
          kind: "image",
          id: a.id,
          name: a.name,
          blob: null,
          objectUrl: objectUrls[a.id] || null,
          thumb: a.thumb || null,
          persisted: true,
        });
      } else {
        restored.push({ kind: "file", name: a.name, text: a.text });
      }
    }
    if (restored.length === 0) return;
    pendingAttachments = restored;
    renderPreviews();
  }

  /**
   * 发送前的视觉能力闸门：本条带图 + 目标模型已知不支持视觉 → 提示
   * 横幅 + 不发。目标 = 显式选择；没选就是服务端默认（default_model 广告值）；
   * 都拿不到或目录外（未知）→ fail-open 放行。只看**本条**的附件：历史消息
   * 里的图是上一轮已经接受过的，纯文本追问不该被反复拦。
   */
  function visionOkForSend() {
    var hasImages = false;
    for (var i = 0; i < pendingAttachments.length; i++) {
      if (pendingAttachments[i].kind === "image") {
        hasImages = true;
        break;
      }
    }
    if (!hasImages) return true;
    var model = byRole("chat-model");
    var targetId = (model && model.value) || defaultModelId;
    if (!targetId) return true;
    if (visionById[targetId] !== false) return true;
    showNotice(t("chat.warn.vision", { model: targetId }));
    return false;
  }

  /* ---- 发送与流式渲染（消息数组取当前会话的） ---------------------------- */

  /**
   * 失败应答 → 一句人话。
   *
   * 401 单独一条：它说的是「凭据不被接受」，用户要改的是 key 选择，不是模型。
   *
   * 其余情况**只给「干什么失败了 + 怎么办」**：上游（或本地 fetch）的
   * `error.message` 原文不进横幅——它可能带着请求体片段与内部报文，而对用户
   * 来说那条错误的唯一用处是排障，落点是日志页的系统日志 / 请求事件（同一条
   * 链路的诊断记录）与浏览器控制台。所以原文走 `console.error`，横幅走 i18n 键。
   *
   * 401 还要把手动粘贴行请回来——错误横幅不能指向一个 display:none 的输入框
   *（UI 审查 #2 的同一条教训）：key 行本体（下拉）常驻可见，但粘贴行平时收着。
   */
  function failed(response, key, vars) {
    return response
      .json()
      .catch(function () {
        return null;
      })
      .then(function (body) {
        var message = chatStream.errorMessageOf(body);
        if (chatStream.isUnauthorized(response)) {
          /* 401 兑底：不管选的是什么（密文解出的值刚被拒，或选的是面板
             会话），都退到「手动输入」——粘贴的 key 按前缀认亲回它自己的条目。
             粘贴行在折叠体里：先展开，横幅指向的输入框必须看得见（UI 审查 #2）。 */
          expandSelectors();
          configureKeyPaste(MANUAL_KEY_ID, false);
          showError(t("chat.error.unauthorized"));
          return null;
        }
        if (message) console.error("[chat]", key, "HTTP " + response.status, message);
        showError(t(key, Object.assign({ status: response.status }, vars || {})));
        return null;
      });
  }

  function send() {
    if (controller) return;
    var session = currentSession();
    if (!session) return;

    var input = inputNode();
    var text = input ? input.value.trim() : "";
    /* 纯文件消息也算有内容：文件就是这轮的全部输入。 */
    if (!text && pendingAttachments.length === 0) {
      showError(t("chat.error.empty"));
      return;
    }
    if (session.messages.length >= SESSION_MESSAGE_LIMIT) {
      showError(t("chat.error.limit", { count: SESSION_MESSAGE_LIMIT }));
      return;
    }
    /* 选了 key 但拿不到完整值：手动输入未粘贴请出粘贴行——不发（带 Cookie 发出
       去的用量会记到面板会话头上，用户以为在测那把 key——这是本视图唯一一处
       前端拦截，拦的是「归因造假」）。已管理 key 必有完整值（5.0 契约）。 */
    var choice = keyChoice();
    if (choice && !keyFor(choice)) {
      if (choice === MANUAL_KEY_ID) {
        expandSelectors();
        configureKeyPaste(choice, true);
        showError(t("chat.error.keyMissing"));
      }
      return;
    }
    /* 能力闸门：已知非视觉模型 + 本条带图 → 提示横幅 + 不发（只看本条的
       附件，历史消息里的图不拦纯文本追问——见 visionOkForSend）。 */
    if (!visionOkForSend()) return;

    showError(null);
    showNotice(null);
    /* 附件随消息落库：预览条先清（与「发送时清空输入区」同一语义）；请求失败
       的撤回会从消息上把附件还回预览条（restorePendingFromMessage）。图片 blob
       留在存储层——消息引用它们，不能删。 */
    var outgoing = pendingAttachments.slice();
    pendingAttachments = [];
    var storedMessage = { role: "user", content: text };
    var storedAttachments = attachmentsForStorage(outgoing);
    if (storedAttachments) storedMessage.attachments = storedAttachments;
    renderPreviews();
    var userNode = appendMessage("user", text, storedMessage);
    var replyNode = appendMessage("assistant", "");
    session.messages.push(storedMessage);
    chatSessions.retitleFromFirstMessage(session);
    session.updatedAt = Date.now();
    persistSessions();
    renderSessions();
    if (input) input.value = "";
    controller = new AbortController();
    setBusy(true);

    var pending = controller;
    /* 用户点了停止：不当作失败，但也不能把“已停止”当成模型的回答写进历史。*/
    var stopped = false;
    /* 请求体不直接用存储形态——带图 / 带文件的历史消息按引用重建
       content 数组（无状态协议每轮全量重发），data URL 的取回是异步的，组装完
       才发。inflight 挂整条链（含组装）：切会话的 quiesce() 要等的就是它。 */
    inflight = chatStream.buildApiMessages(session.messages)
      .then(function (apiMessages) {
        if (pending.signal.aborted) {
          /* 组装期间被中止（切会话 / 停止）：不发请求，与「一个字都没到」的
             中止同场收尾——空回复节点删掉，用户消息留在历史里。 */
          stopped = true;
          removeNode(replyNode);
          syncEmptyState();
          return null;
        }
        var body = { messages: apiMessages, stream: true };
        var model = byRole("chat-model");
        /* 模型的空选择 = body 不带 model（服务端默认）；选了就原样进 body。*/
        if (model && model.value) body.model = model.value;
        /* 归因真实：选了具体 key（含手动输入）时，这条请求不带 Cookie
          （`credentials: "omit"`）。鉴权优先级是会话 Cookie > Bearer key，
           而同源 fetch 总是自动带 Cookie——登录着的面板里发请求，服务端仍把用量归因
           到面板会话（`apiKeyId` 为空），选中的 key 只被当成真伪测试。Cookie 不随
           请求走，服务端没有会话可认，就按 Bearer key 鉴权并把用量记到那把 key 头上。
           「面板会话」模式不带这个字段：fetch 默认的 same-origin 让 Cookie 照旧随
           请求走。401 降级不受影响：它换的是凭据，粘贴行请回来之后的新请求同样按
           「有没有选 key」决定带不带 Cookie。`/v1/models` 不动——它不涉归因。 */
        var chatInit = {
          method: "POST",
          headers: Object.assign({ "content-type": "application/json" }, authHeaders(), routingHeaders()),
          body: JSON.stringify(body),
          signal: pending.signal,
        };
        if (choice) chatInit.credentials = "omit";
        return window
          .fetch(CHAT_COMPLETIONS_PATH, chatInit)
          .then(function (response) {
            if (!response.ok) {
              /* 请求没被接受：把这一轮撤回，正文与附件都还给输入区，用户改完能直接重发。*/
              rollback(userNode, replyNode, text, session);
              return failed(response, "chat.error.request");
            }
            return consumeStream(response, session, replyNode);
          })
          .catch(function (error) {
            if (error && error.name === "AbortError") {
              stopped = true;
              /* 已经收到的部分留在会话里；一个字都没到就把空回复删掉。*/
              var partial = replyNode ? replyNode.textContent || "" : "";
              if (partial) finishReply(session, replyNode, partial);
              else removeNode(replyNode);
              syncEmptyState();
              return;
            }
            rollback(userNode, replyNode, text, session);
            /* 原文只进控制台（`[chat]` 前缀与日志页同一配线）；横幅说「重发一次」。 */
            console.error("[chat] stream failed", error);
            showError(t("chat.error.stream"));
          });
      })
      .catch(function (error) {
        /* 组装失败（理论上不会：dataUrlOf 的失败都在内部降级）：当普通失败收场。*/
        rollback(userNode, replyNode, text, session);
        console.error("[chat] message assembly failed", error);
        showError(t("chat.error.stream"));
      })
      .then(function () {
        controller = null;
        inflight = null;
        setBusy(false);
        /* `setBusy(false)` 会清掉状态文字，所以“已停止”要在它之后落。*/
        if (stopped) setStatus(t("chat.status.stopped"));
        /* 这一轮落定后把更新时间与存储一起收尾：排序、相对时间都从这里来。*/
        var active = currentSession();
        if (active) {
          active.updatedAt = Date.now();
          persistSessions();
        }
        renderSessions();
        scrollToEnd();
      });
  }

  /**
   * 读一条流：增量交给气泡，读完收尾。
   *
   * 帧的拆分与 JSON 解析在 `app-chat-stream.js`；这里只决定增量画在哪（`replyNode`
   * 可能已被切会话重画掉，节点断开时照样往它的 textContent 写——收尾时读的是它，
   * 所以历史与气泡不会分叉）。
   */
  function consumeStream(response, session, replyNode) {
    return chatStream.readStream(response, function (text) {
      if (replyNode) replyNode.textContent = text;
      scrollToEnd();
    }).then(function (text) {
      /* 没有 body 的应答没有可收尾的正文：不当成「模型回了空」。*/
      if (text !== null) finishReply(session, replyNode, text);
      return null;
    });
  }

  /** 收尾：正文进会话历史；一个 token 都没收到就是失败，不能留一条空回复。*/
  function finishReply(session, replyNode, text) {
    if (!text) {
      if (replyNode) replyNode.textContent = t("chat.error.emptyReply");
      return;
    }
    session.messages.push({ role: "assistant", content: text });
    announceDone();
  }

  /**
   * 流式期间消息区不挂 `aria-live`（每个 token 都会打断读屏），收尾时往
   * `chat-done` 那块 sr-only live region 写一句。同一条文案反复写读屏器不会
   * 重播，所以先清空再写。
   */
  function announceDone() {
    var node = byRole("chat-done");
    if (!node) return;
    node.textContent = "";
    node.textContent = t("chat.stream.done");
  }

  /** 撤回这一轮（请求失败 / 流中断）：节点删掉、历史撤回、正文还回输入框。*/
  function rollback(userNode, replyNode, text, session) {
    removeNode(userNode);
    removeNode(replyNode);
    /* 这一轮没成功，会话历史里也不该留一条没人回的用户消息：否则下一次发送会
       把它一起带上，模型可能去答那句已经失败的提问。*/
    var last = session.messages[session.messages.length - 1];
    if (last && last.role === "user") {
      session.messages.pop();
      /* 附件回到预览条（图按引用回列——blob 已在存储层，不重选不重传）。*/
      restorePendingFromMessage(last);
      /* 首条消息没发出去，从它派生的标题也一并退场——否则标题留着一句「没人
         问过」的话，列表里对不上号。用户手动改过的标题（与派生值不同）不动。 */
      if (session.messages.length === 0 && session.title === chatSessions.titleFromMessage(text)) {
        session.title = "";
      }
    }
    var input = inputNode();
    if (input) input.value = text;
    syncEmptyState();
  }

  function removeNode(bodyNode) {
    if (!bodyNode) return;
    var node = bodyNode.parentNode;
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  /* ---- 事件 ------------------------------------------------------------ */

  function submitFromComposer(event) {
    event.preventDefault();
    send();
  }

  /** Enter 发送、Shift+Enter 换行：输入框里只有这一处按键语义。*/
  function handleComposerKey(event) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    send();
  }

  function stop() {
    if (controller) controller.abort();
  }

  function bind() {
    var form = byRole("chat-form");
    if (form) form.addEventListener("submit", submitFromComposer);

    var input = inputNode();
    if (input) input.addEventListener("keydown", handleComposerKey);

    var stopButton = byRole("chat-stop");
    if (stopButton) stopButton.addEventListener("click", stop);

    /* 附件入口：按钮代点隐藏的 file input，选择结果走 change。
       display:none 的 input 也能被程序点开，只是不接受手动点击。 */
    var attachButton = byRole("chat-attach");
    var fileInput = byRole("chat-file-input");
    if (attachButton && fileInput) {
      attachButton.addEventListener("click", function () {
        fileInput.click();
      });
      fileInput.addEventListener("change", function () {
        onFilesPicked(fileInput.files);
      });
    }

    var account = byRole("chat-account");
    if (account) account.addEventListener("change", onAccountChange);

    var route = byRole("chat-route");
    if (route) route.addEventListener("change", onRouteChange);

    var model = byRole("chat-model");
    if (model) model.addEventListener("change", onModelChange);

    var keySelect = byRole("chat-key-select");
    if (keySelect) keySelect.addEventListener("change", onKeyChoiceChange);

    var apply = byRole("chat-key-apply");
    if (apply) apply.addEventListener("click", applyManualKey);

    var keyInput = byRole("chat-key");
    if (keyInput) {
      keyInput.addEventListener("keydown", function (event) {
        if (event.key !== "Enter") return;
        event.preventDefault();
        applyManualKey();
      });
    }

    var newButton = byRole("chat-new");
    if (newButton) newButton.addEventListener("click", newSession);

    var newNarrow = byRole("chat-new-narrow");
    if (newNarrow) newNarrow.addEventListener("click", newSession);

    var deleteNarrow = byRole("chat-delete-narrow");
    if (deleteNarrow) {
      deleteNarrow.addEventListener("click", function () {
        deleteSession(chatSessions.activeId());
      });
    }

    var sessionSelect = byRole("chat-session-select");
    if (sessionSelect) {
      sessionSelect.addEventListener("change", function () {
        switchToSession(sessionSelect.value);
      });
    }

    /* 会话列表是渲染期重建的 DOM：点击 / 双击在 buildSessionItem 里各自绑。*/
  }

  /* ---- 进视图与外部钩子 --------------------------------------------------- */

  /**
   * 进视图（`app.js` 的 `showView` 在 `activeView` 变成 chat 时调）。
   *
   * 初始化分两层：骨架与事件只绑一次；会话清单只恢复一次。模型清单与 key 清单
   * 每次进视图都确认一遍——key 页随时可能建 / 吊销 key，聊天页的下拉不该比 key
   * 页旧。消息区与选择快照在两份清单到手后落定（快照的「还存不存在」校验需要
   * 它们），消息区本身不等：会话内容不依赖任何应答，先上屏。
   */
  function enter() {
    if (!bound) {
      bound = true;
      bind();
    }
    loadKeyState();
    /* 首次进视图：恢复会话清单，一条都没有就建一条并继承当前四个下拉的选择。*/
    chatSessions.ensureLoaded(currentChoices());
    /* 孤儿剪除——会话清单恢复后，没有消息引用、也不在预览条里的图片
       blob 清掉（撤回后没再发的、上次页面崩溃残留的，都在这里归零）。 */
    App.attachments.pruneExcept(keepImageIds());
    var current = currentSession();
    if (current) renderSessionLog(current);
    renderSessions();
    renderPreviews();
    setBusy(false);
    syncEmptyState();
    Promise.all([ensureModels(), loadKeyOptions()]).then(function () {
      var session = currentSession();
      if (session) applyChoices(session.choices);
      choicesApplied = true;
      return null;
    });
  }

  /**
   * 语言切换后重画「运行时拼出来」的文案：四个下拉的默认项、key 选项、会话列表。
   *
   * `app-i18n.applyLanguage` 调（与 logs.renderControls 同一批钩子）；签名清空
   * 强制重建，否则切了语言下拉里还是旧语言的「按策略」。
   */
  function renderChrome() {
    accountSignature = null;
    routeSignature = null;
    modelSignature = null;
    keySignature = null;
    var state = App.state.lastState;
    syncAccounts(state && Array.isArray(state.accounts) ? state.accounts : []);
    renderModelOptions();
    renderKeyOptions();
    renderSessions();
    updateSelectorSummary();
  }

  App.views.chat = {
    enter: enter,
    syncAccounts: syncAccounts,
    renderChrome: renderChrome,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
