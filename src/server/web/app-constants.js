/*
 * app-constants.js — 页面运行时的全部常量：存储键、端点、枚举、阈值。
 *
 * 这个文件只有声明，没有函数也没有状态，所以它排在被拼接脚本的第一位：后面的每个
 * 文件都从这里取值，取到的都是常量，不存在被覆盖的可能。
 *
 * 枚举（`ROUTE_KINDS` / `ROUTING_*_OPTIONS` / `CLIENT_IDENTITY_MODE_OPTIONS`）是
 * 服务端常量表的显示用副本：页面不 import 服务端模块（零构建链），所以任何一边
 * 增删枚举都要两边同步（服务端那份是唯一真值，这里是它的显示副本）。
 */
(function (App) {
  "use strict";

  App.const = {
    /* ---- 存储键与取值 ------------------------------------------------ */

    THEME_STORAGE_KEY: "theme",
    LANGUAGE_STORAGE_KEY: "i18n_lang",
    THEME_ATTR: "data-theme",
    ROLE_ATTR: "data-role",

    /*
     * 侧边栏折叠：与主题同一个形态（localStorage + 根元素上的一个属性），
     * 所以两者在 `theme-boot.js` 的首屏防闪烁里并排处理。属性在 `<html>` 上，值只有
     * 下面两项——`expanded` 也会写上去（而不是删属性），这样“没写过”与“写过展开”
     * 在 DOM 里是同一个选择器结果，CSS 只需一条 `[data-sidebar="collapsed"]`。
     */
    SIDEBAR_STORAGE_KEY: "zcode-sidebar",
    SIDEBAR_ATTR: "data-sidebar",
    SIDEBAR_COLLAPSED: "collapsed",
    SIDEBAR_EXPANDED: "expanded",
    SIDEBAR_MODES: ["collapsed", "expanded"],

    THEME_MODES: ["system", "light", "dark"],
    DEFAULT_THEME_MODE: "system",
    /**
     * 主题三态到精灵图标的映射：顶栏的主题按钮一次只画当前态的那颗
     * （Lucide monitor / sun / moon），`use` 的 href 由 app-theme.js 按这份表写。
     */
    THEME_ICONS: { system: "monitor", light: "sun", dark: "moon" },
    LANGUAGES: ["zh", "en"],
    DEFAULT_LANGUAGE: "en",
    HTML_LANG: { zh: "zh-CN", en: "en" },

    /* ---- 网络 -------------------------------------------------------- */

    STATE_PATH: "/api/state",
    CONTROL_PATH: "/api/control",
    /**
     * 会话接口：`POST` 登录、`GET` 当前登录状态、`DELETE` 登出。
     * 控制面的凭据是 Cookie，页面读不到它，也不该读到。
     */
    SESSION_PATH: "/api/session",
    /** 改密码（「我的账户」页）。*/
    PASSWORD_PATH: "/api/password",
    /** 登录页与登录后的首页：401 时整页跳转，而不是露一个输入框。*/
    LOGIN_PATH: "/login",
    HOME_PATH: "/",
    /** 系统页要的信息（版本 / 地址 / 聊天页地址），见 `panel.ts`。*/
    SYSTEM_PATH: "/api/system",
    CREDENTIAL_SOURCES_PATH: "/api/credential-sources",
    EVENTS_PATH: "/api/events",
    /** 设置接口（读回生效值，写回 YAML）。*/
    SETTINGS_PATH: "/api/settings",
    POLL_INTERVAL_MS: 5000,
    /**
     * 「已生效」提示的停留时长：A / B 类保存成功后顶部短暂提示，到点自己
     * 收起。4s 够读完一句话，也不会盖住接下来要改的下一个字段。
     */
    SETTINGS_NOTICE_TTL_MS: 4000,
    HTTP_UNAUTHORIZED: 401,
    NETWORK_ERROR_CODE: "network_error",
    /**
     * 行内失败提示的 `dispatch` 目标前缀 + 账号 label（`app-api.js` 的
     * `showTargetError` 认它）。
     *
     * 为什么要一个前缀而不是第二个参数：`dispatch(cmd, onOk, target)` 的 `target`
     * 本来就是一个字符串（`"add"` / `"settings"` / 缺省 = 页顶横幅），行内目标是
     * 「某一行的某一格」，label 里可能有任意字符，所以用一条不会与固定档撞名的
     * 前缀把 label 隔开。控制字符 `\u0000` 不可能出现在 label 里。
     */
    ROW_TARGET_PREFIX: "\u0000row\u0000",
    /**
     * 行内失败提示的停留时长：一次轮询周期。行随下一拍重画就消失——它是
     * 「刚才那一下没成」的即时反馈，不是一条要人去关的告警。
     */
    ROW_FAILURE_TTL_MS: 5000,

    /*
     * 事件流的重连退避：首连失败等 1s，之后翻倍，最多 15s。
     *
     * 上限 15s 与 SSE 心跳间隔同量级：既是「断网恢复后最多等 15 秒」的可接受体验，
     * 也不至于让一个长期断开的后台标签页每秒发起一次连接。
     */
    RECONNECT_BASE_MS: 1000,
    RECONNECT_MAX_MS: 15000,
    /** 每失败一次退避翻几倍（指数退避的底数，不留裸数字）。*/
    RECONNECT_BACKOFF_FACTOR: 2,

    /*
     * 页面端保留的日志行数。
     *
     * 500 与 `LogBuffer` 的容量同值：服务端缓冲区就只留 500 行，客户端留更多没有意义
     * （重连时补的也是这 500 行），而 DOM 节点数必须有上限，否则开一夜就是十万行。
     */
    LOG_LINE_LIMIT: 500,

    /* ---- 页面（同一份 HTML，按 pathname 选一个 [data-view]）----------- */

    /*
     * 八个视图。`/account` 不在这里：「我的账户」并进了设置页，页面不需要认识它。`chat` 也没有
     * 服务端路由，进视图靠侧边栏的 `show-chat` 动作做客户端切换（`app.js` 的
     * `switchToChat`）。
     * `stats`：用量统计报表页，`getUsageStats` 的唯一消费面。
     * 代理没有视图：它是账号属性的「出口」命名字典，挂在账号页的抽屉里，
     * 所以既没有 `VIEW_PROXIES` 也没有 `/proxies` 路径。
     */
    VIEW_OVERVIEW: "overview",
    VIEW_STATS: "stats",
    VIEW_CHAT: "chat",
    VIEW_ACCOUNTS: "accounts",
    VIEW_ROUTING: "routing",
    VIEW_KEYS: "keys",
    VIEW_LOGS: "logs",
    VIEW_SETTINGS: "settings",
    ROUTE_PATH_ACCOUNTS: "/accounts",
    ROUTE_PATH_ROUTING: "/routing",
    ROUTE_PATH_KEYS: "/keys",
    ROUTE_PATH_LOGS: "/logs",
    ROUTE_PATH_SETTINGS: "/settings",
    ROUTE_PATH_STATS: "/stats",

    /**
     * 账号摘要跳账号页时带的查询参数（概览页的每一行 → 账号页的那一行）。
     *
     * 两页共用同一个键名，所以它在这里；拼 URL 的一侧是 `app-view-overview.js`，
     * 读的一侧是 `app-view-accounts.js`。
     */
    FOCUS_QUERY_KEY: "focus",

    /**
     * 让账号页一进来就展开出口代理抽屉（概览的「共用出口」告警 → 账号页）。
     *
     * 代理没有自己的路径（管理面降级成账号页抽屉），所以那条告警的落点只能
     * 是账号页 + 一个「把它打开」的标记。读的一侧是 `app-view-accounts.js` 的
     * `openProxiesFromUrl`，只消费一次（与 `?focus=` 同一套约定）。
     */
    PROXIES_QUERY_KEY: "proxies",

    /*
     * 跳转的查询参数：面板的视图是几条真实路径，跨页带参就用查询串
     * （与 `?focus=` 同一机制，没有 hash 路由）。
     *
     * - `stats` 读 `range`：进视图落在哪个范围（今天 / 7d / 30d / all）——
     *   概览页的今日卡与时序缩略都指向 `/stats?range=today`。
     * - `logs` 读 `tab` 与 `key`：统计视图的 key 维度行与 keys 页的用量数字
     *   跳日志页的请求事件 tab，并把 key 筛选器带上（`none` = 无归因，
     *   与 `REQUEST_KEY_NONE` 同值）。
     * - `logs` 还读 `status` 与 `stage`——概览页的错误数卡跳
     *   `status=error`，错误数卡下方的阶段分布小字跳 `stage=<stage>`；两处都
     *   钉住请求事件 tab 上对应的筛选器（`app-view-logs.js` 的 `enter`）。
     */
    STATS_RANGE_QUERY_KEY: "range",
    LOGS_TAB_QUERY_KEY: "tab",
    LOGS_KEY_QUERY_KEY: "key",
    LOGS_STATUS_QUERY_KEY: "status",
    LOGS_STAGE_QUERY_KEY: "stage",

    /**
     * 统计视图的四个范围（page.html 的 `data-stats-range` 与
     * `app-view-stats.js` 共用这一份）；缺省落在「今天」，与概览页的今日卡
     * 指向的范围一致。
     */
    STATS_RANGES: ["today", "7d", "30d", "all"],
    DEFAULT_STATS_RANGE: "today",

    /**
     * 显式直连的保留名字（与 `src/accounts/proxies.ts` 的 `DIRECT_PROXY` 同源）。
     *
     * 它既是「账号的出口」（下拉里的一项），也是「这一组账号共用本机 IP」的分组键：
     * 两个直连账号本来就在同一个出口上，概览的共用出口告警要把它算进去。
     */
    DIRECT_PROXY: "direct",

    /* 事件名与帧分隔符：与 `src/server/routes-events.ts` 的导出常量一一对应 */
    SSE_EVENT_LOG: "log",
    SSE_EVENT_REQUEST: "request",
    SSE_EVENT_STATE: "state",
    SSE_FRAME_SEPARATOR: "\n\n",

    /* ---- 日志页 ------------------------------------------------------------ */

    /** 两个 tab：系统日志与请求事件。*/
    LOG_TABS: ["requests", "system"],
    DEFAULT_LOG_TAB: "requests",
    LOG_TAB_REQUESTS: "requests",

    /** 四个连接状态（与 `data-role="log-conn"` 的文案键一一对应）。*/
    LOG_CONN_CONNECTING: "connecting",
    LOG_CONN_CONNECTED: "connected",
    LOG_CONN_RECONNECTING: "reconnecting",
    LOG_CONN_DISCONNECTED: "disconnected",

    /** 连接状态到小圆点配色（二值化：ok / 过程态 warn / 异常 danger，中性态用 faint）。*/
    LOG_CONN_DOT_CLASS: {
      connecting: "status__dot",
      connected: "status__dot status__dot--ok",
      reconnecting: "status__dot status__dot--warn",
      disconnected: "status__dot status__dot--danger",
    },

    /**
     * 级别过滤的取值：`all` 加四档（`log` 事件的 `level` 字段是稳定值）。
     *
     * `debug` 是请求链路阶段打点落的那一档，所以默认的
     * 「全部」之外，用户最常切的就是只看 `debug` 或排除 `debug`。
     */
    LOG_LEVEL_FILTERS: ["all", "debug", "info", "warn", "error"],
    LOG_LEVEL_ALL: "all",

    /** 模块过滤的「全部」值：空串不可能是模块名。*/
    LOG_MOD_ALL: "",

    /** 账号过滤的「全部」值：空串不可能是账号 label（label 必填）。*/
    LOG_ACCOUNT_ALL: "",

    /** 级别到行配色（语义色，日志正文的两档加普通行）。*/
    LOG_LINE_CLASS: {
      error: "log__line log__line--error",
      warn: "log__line log__line--warn",
      info: "log__line",
      /* `debug` 不给第四种颜色：它只是更啰嗦的 info，靠级别过滤区分，
         再配一个颜色会让日志墙看不出重点。*/
      debug: "log__line",
    },

    /* ---- 日志页 · 请求事件 tab --------------------------------------- */

    /**
     * 表体行数上限，与服务端 `REQUEST_STORE_CAPACITY` 同值：更早的丢弃。
     * DOM 节点必须有上限，理由与系统日志的 `LOG_LINE_LIMIT` 同一条。
     */
    REQUEST_ROW_LIMIT: 200,
    /** `getRequests` 初始加载拉多少条：一次拉满，之后靠 SSE 增量。*/
    REQUESTS_LOAD_LIMIT: 200,
    /** `getRequestsHistory` 一页拉多少条：与服务端缺省同值。*/
    REQUESTS_HISTORY_PAGE_LIMIT: 100,
    /**
     * 「加载更早」累计保留的历史行上限。内存段仍是 `REQUEST_ROW_LIMIT`；
     * 历史段超限丢最旧的（数组尾部），DOM 总量有界——同一条纪律，上限不同：
     * 历史行只在用户点按时才增长。
     */
    REQUESTS_HISTORY_ROW_LIMIT: 1000,
    /**
     * 请求表的列数（十四列）。展开行与「加载更早」行跨全部列。
     *
     * 列是：来源（账号名 + 身份色点）、请求（流式/批量 + 路由 / 端点路径）、
     * 缓存命中率、推理强度、重试等。列多了一排，窄屏由 `.table-scroll` 横向滚
     * （填入时算的就是这个列数，用来给跨列行算 `colSpan`）。
     */
    REQUEST_COLUMN_COUNT: 14,

    /**
     * ≤1440 折叠三列的断点：与 `components.css` 的 `@media (max-width: 1440px)`
     * 同值。JS 侧只需要它来算展开行的 `colSpan`（CSS 侧自己隐藏那三列）。
     */
    REQUEST_FOLD_MEDIA: "(max-width: 1440px)",

    /** 被折叠的列数（缓存 / 推理强度 / 重试），与上面的断点配套。*/
    REQUEST_FOLDED_COLUMN_COUNT: 3,

    /**
     * 推理强度（`reasoningEffort`）到小片的配色档。
     *
     * 四档与 `reasoning-effort.ts` 的 `REASONING_EFFORT_LEVELS` 一一对应；
     * 颜色深浅表达「要了多少思考」，不是好坏（用主题色深浅，不用语义色）。
     */
    REQUEST_EFFORT_CLASS: {
      none: "req__effort req__effort--none",
      low: "req__effort req__effort--low",
      medium: "req__effort req__effort--medium",
      high: "req__effort req__effort--high",
    },

    /**
     * 来源色点的档数：与 `tokens.css` 的 `--identity-1..6` 同值。
     *
     * 账号名 → 稳定下标做哈希取模，所以同一个账号永远是同一颗色点；换主题、刷新、
     * 重连都不漂。档数改这里就要同步改 tokens.css 的那一组。
     */
    REQUEST_IDENTITY_DOTS: 6,

    /**
     * 「导出 JSON」的文件名前缀与时刻格式。
     *
     * 落成 `zcode-requests-20261109-143005.json`：文件名带时刻，同一天导出多次不会
     * 让浏览器自动加 `(1)` 猜名字；前缀统一，下载目录里能按名字找到。
     */
    REQUESTS_EXPORT_PREFIX: "zcode-requests",
    REQUESTS_EXPORT_MIME: "application/json",

    /**
     * 账号导出的下载 MIME。
     *
     * `application/json` + `download` 属性：浏览器当成文件存下来而不导航过去
     * （导航会抡掉面板）。与日志导出的 `zcode-requests-*` 同一个 mime。
     */
    ACCOUNTS_EXPORT_MIME: "application/json",

    /**
     * 一次性提示条的停留时长。
     *
     * 与聊天页的撤销窗口（`CHAT_UNDO_MS`）不是一回事：那条要等用户反悔，这条
     * 只是告诉用户「已经开始了」。四秒够读完一句话，又不至于挡在页底。
     */
    TOAST_NOTICE_MS: 4000,

    /** 状态列的占位：还没收尾的请求没有状态码（显示成「进行中」）。*/
    REQUEST_STATUS_PENDING: "…",
    /**
     * 状态过滤的六档：全部 / 2xx / 4xx / 5xx / 进行中 / 错误。
     * 前三档按状态码分段（<400 / <500 / 其余），「进行中」是还没状态码的记录，
     * 「错误」是带 `error` / `failedStage` 的记录（不管状态码是多少——在 intake
     * 就挂掉的请求没有状态码，也要有地方可筛）。值就是状态桶的键，见
     * `requestStatusBucket`。
     */
    REQUEST_STATUS_FILTERS: ["all", "2xx", "4xx", "5xx", "pending", "error"],
    REQUEST_STATUS_ALL: "all",
    REQUEST_STATUS_OK_KEY: "2xx",
    REQUEST_STATUS_CLIENT_ERROR_KEY: "4xx",
    REQUEST_STATUS_SERVER_ERROR_KEY: "5xx",
    REQUEST_STATUS_PENDING_KEY: "pending",
    REQUEST_STATUS_ERROR_KEY: "error",

    /**
     * 状态码到 StatusBadge 的配色（组件层的语义色）：2xx 绿 /
     * 4xx 橙 / 5xx 红 / 进行中琥珀。`--pending` 与 `--aborted` 是两个
     * 追加变体（components.css）：前者是「在飞」不是警告，后者是「客户端断开」
     * 不是失败。
     */
    REQUEST_STATUS_BADGE_CLASS: {
      ok: "status-badge status-badge--ok",
      warn: "status-badge status-badge--warn",
      danger: "status-badge status-badge--danger",
      pending: "status-badge status-badge--pending",
      aborted: "status-badge status-badge--aborted",
    },

    /** 账号 / 路由 / 模型过滤的「全部」值：空串不可能是账号 label、route key 或模型 id。*/
    REQUEST_ACCOUNT_ALL: "",
    REQUEST_ROUTE_ALL: "",
    REQUEST_MODEL_ALL: "",
    /**
     * 阶段过滤的「全部」值与选项来源。
     *
     * 阶段就是 `RequestRecord.failedStage`（`upstream-req` / `upstream-resp` /
     * `dispatch` / `translate` / `handler` …），服务端没有「已知阶段」枚举可给，
     * 所以选项从**已见记录聚合**（与账号 / 模型 / key 同一思路），值原样是
     * 阶段标识（技术标识不翻译）。
     */
    REQUEST_STAGE_ALL: "all",
    /**
     * key 过滤的两个保留值。`apiKeyId` 是 16 位 hex（`apiKeyIdOf`），这两个
     * 字符串不可能撞上真 id；空串不能用——它本身就是「无归因」的记录值。
     */
    REQUEST_KEY_ALL: "all",
    REQUEST_KEY_NONE: "none",

    /**
     * 没有模型时的占位（与 `request-record.ts` 的 `UNKNOWN_MODEL` 同源）：占位符
     * 不是模型 id，展开头的模型段要跳过它。
     */
    REQUEST_UNKNOWN_MODEL: "-",

    /** dump 开关没配路径时，设置页显示的默认位置（与服务端默认值一致）。*/
    DUMP_DEFAULT_PATH_DISPLAY: "~/.zcode-proxy/dump.jsonl",

    /* ---- 聊天视图 ----------------------------------------------------- */

    /*
     * 单会话消息条数上限：到了就拒绝发送，提示新开会话。
     *
     * 消息数组是全量随每次请求重发的（无状态协议），200 条首先撞的是上下文成本，
     * 其次才是 localStorage 容量；超限不静默截断历史——那会让模型「失忆」而用户
     * 不知情，宁可明说「新开会话」。
     */
    CHAT_SESSION_MESSAGE_LIMIT: 200,

    /*
     * 全部会话合计的存储软上限（字节）：接近 localStorage 的 5MB 配额时提示删除
     * 旧会话。只提示、不自动淘汰——自动删用户的聊天记录是聊天工具不能做的事，
     * 这里的职责是把「快满了」说清楚。
     */
    CHAT_STORAGE_SOFT_LIMIT: 4.5 * 1024 * 1024,

    /** 会话标题取首条用户消息的前若干字（截断补省略号）。 */
    CHAT_TITLE_MAX_CHARS: 20,

    /*
     * 删除会话的撤销窗口：删除不弹二次确认，改成「先删 + 一条撤销条」。
     *
     * 5 秒是「看到它、读完那句话、还能回头」的尺度：再短就成了抢时间（读不完
     * 一条带会话名的句子），再长则让删除变成了半完成状态（之后又在另一个会话里
     * 发了消息，反悔的语义就模糊了）。窗口内不剪会话的图片 blob，关窗才剪。
     */
    CHAT_UNDO_MS: 5000,

    /* ---- 聊天附件 ----------------------------------------------------- */

    /*
     * 单张图片的字节上限。官方 ZCode 客户端的内联图片上限是 20MB
     * (`packages/ui/src/lib/chatAttachments.ts` 的 INLINE_IMAGE_ATTACHMENT_MAX_BYTES)，
     * 但那是桌面端带本地路径的形态；面板走 data URL + IndexedDB，10MB 已经远超
     * 一屏截图的需要，再大先压尺寸再谈。
     */
    CHAT_IMAGE_MAX_BYTES: 10 * 1024 * 1024,

    /*
     * 文本类文件的内容上限（字节）：超过就拒绝。上限的口径与官方客户端的
     * INLINE_TEXT_ATTACHMENT_MAX_CHARS（64K 字符）同量级；文件内容整体进
     * localStorage（文本正文），4.5MB 软护栏仍按会话 JSON 总量计算。
     */
    CHAT_TEXT_FILE_MAX_BYTES: 128 * 1024,

    /* 单条消息的附件总数上限（图片 + 文件合计；官方客户端同为 8）。 */
    CHAT_MAX_ATTACHMENTS_PER_MESSAGE: 8,

    /*
     * 「文本类文件」的判定：mime 以 text/ 开头，或扩展名命中这份清单（与官方
     * 客户端 `chatAttachmentMetadata.ts` 的 isTextLikeAttachment 同一张表）。
     * 清单之外的扩展名 + 非 image mime = 二进制，明确拒绝（只押注验证过的类型）。
     */
    CHAT_TEXT_FILE_EXTENSIONS: [
      "cjs", "conf", "cpp", "cs", "css", "csv", "go", "h", "hpp", "html",
      "ini", "java", "js", "json", "jsx", "log", "md", "mjs", "py", "rs",
      "sh", "sql", "toml", "ts", "tsx", "txt", "xml", "yaml", "yml",
    ],

    /* 图片扩展名（file.type 缺失时按扩展名认；blob 按此重建 media type）。 */
    CHAT_IMAGE_EXTENSIONS: ["png", "jpg", "jpeg", "gif", "webp", "bmp"],

    /* 扩展名到图片 media type：重建无 type 文件的 Blob 用（FileReader data URL 的前缀）。 */
    CHAT_IMAGE_MIME_BY_EXT: {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
    },

    /*
     * 缩略图的最长边（px）与 JPEG 质量：消息里持久的小预览。缩略图是给「blob
     * 已不在 IndexedDB」时的兜底显示（存储降级 / 被清理后仍看得见气泡里有图），
     * 128px 在气泡里足够辨认，JPEG 压后约 2-4KB。
     */
    CHAT_THUMB_MAX_EDGE: 128,
    CHAT_THUMB_JPEG_QUALITY: 0.6,
    /* 缩略图解码的安全网（毫秒）：解码器一个回调都不给就放弃（见 makeThumb）。 */
    CHAT_THUMB_TIMEOUT_MS: 500,

    /* IndexedDB 库名与对象仓（图片 blob 的唯一持久层）。 */
    CHAT_IMAGE_DB_NAME: "zcode-proxy-chat",
    CHAT_IMAGE_DB_VERSION: 1,
    CHAT_IMAGE_STORE: "images",

    /* ---- 文案 / 排版 ------------------------------------------------- */

    INTERPOLATION: /\{\{(\w+)\}\}/g,
    VARS_ATTR: "data-i18n-vars",
    SECONDS_PER_MINUTE: 60,
    MINUTES_PER_HOUR: 60,
    SECONDS_PER_HOUR: 3600,
    SECONDS_PER_DAY: 86400,

    /*
     * 健康状态到标签配色（二值化）：绿 = ok（健康 / 启用），红 =
     * drained / cooling / 停用 / 401。冷却也是「异常」一端——文字保留具体语义
     * （「冷却」），色统一红；琥珀从健康语义退役，只留给过程态与提醒（
     * components.css 的 StatusBadge 注释同步）。
     */
    HEALTH_TAG_CLASS: {
      ok: "tag tag--ok",
      cooling: "tag tag--danger",
      drained: "tag tag--danger",
    },

    /** 凭据类别到标签配色（只剩套餐账号一类）。*/
    KIND_TAG_CLASS: {
      "zhipu-account": "tag tag--accent",
    },

    /*
     * 路由与策略枚举（值与 `src/accounts/routes.ts` 的 `ROUTE_KINDS`、
     * `src/accounts/routing.ts` 的常量表一一对应）。
     */
    ROUTE_KINDS: ["coding-plan", "start-plan", "off-peak", "highspeed"],
    ROUTING_MODE_OPTIONS: ["prefer", "only"],
    ROUTING_STRATEGY_OPTIONS: ["sticky-hash", "balanced", "round-robin"],
    SATURATED_OPTIONS: ["wait", "overflow"],
    DRAINED_OPTIONS: ["fallback", "stop"],
    AUTH_FAILED_OPTIONS: ["rotate"],
    STICKINESS_SATURATED_OPTIONS: ["wait", "overflow", "wait-then-overflow"],

    /*
     * 并发步进器的一档与权重下界。
     *
     * 并发：`0` 是软禁用（`maxConcurrency: 0`），所以下界是 0，服务端
     *       `isNonNegativeInteger` 同口径；负数由页面先拒，不发给服务端。
     * 权重：服务端 `isPositiveInteger`，下界是 1。
     */
    CONCURRENCY_STEP: 1,
    MIN_CONCURRENCY: 0,
    MIN_WEIGHT: 1,

    /* ---- 设置页 ------------------------------------------------------ */

    /** 导出格式：加密 / 明文 / 掩码；默认加密。*/
    EXPORT_FORMATS: ["encrypted", "plain", "masked"],
    DEFAULT_EXPORT_FORMAT: "encrypted",

    /** 明文导出要用户手输的那个词（「输入 EXPORT」）。*/
    PLAINTEXT_EXPORT_FORMAT: "plain",
    PLAINTEXT_EXPORT_TOKEN: "EXPORT",

    /**
     * 批量删除要用户手输的那个词。
     *
     * 与明文导出同一个护栏形态（危险动作要手输确认词，不用原生 confirm），
     * 但词分开：一次删掉 N 个账号比导出不可逆得多，用户不该把肌肉记忆从导出借过来。
     * 词本身不进 i18n（手输的是一个固定的大写词，翻译会让两边行为不一致）。
     */
    BULK_DELETE_TOKEN: "DELETE",

    /** 会话亲和模式的三个取值（与 `routes-state.ts` 的 `CLIENT_IDENTITY_MODES` 同源）。*/
    CLIENT_IDENTITY_MODE_OPTIONS: ["off", "observe", "enforce"],

    /**
     * 推理强度（与 `config/types.ts` 的 `REASONING_MODES` / `REASONING_EFFORTS`
     * 同源）：模式透传/覆盖 + 档位四档。档位顺序即下拉顺序，`off` 在最前——它是
     * 「明确关闭」，不是缺省。
     */
    REASONING_MODE_OPTIONS: ["passthrough", "override"],
    REASONING_EFFORT_OPTIONS: ["off", "low", "high", "max"],

    /* ---- 服务组 ------------------------------------------------------ */

    /** 上游回了不可打开的授权地址（不是 http/https 绝对地址）。*/
    SYSTEM_ERROR_UNUSABLE_URL: "oauth_url_unusable",

    /* ---- 添加账号 ---------------------------------------------------- */

    /*
     * 添加账号的 tab 内有两种凭据来源（control 的 `AccountSource`）。`login` 不进
     * `AccountSource`：它不直接建号，而是发起一条 OAuth 流程，由控制面在回调到达时建号。
     *
     * 登录排首位、也是默认 tab。数组顺序就是 tab 条与面板的阅读顺序，所以
     * 这里不按「来源」排——凭据文件与 JWT 是知道自己在干什么的人走的路，
     * 首次建号的人手里只有一个网页登录。
     */
    /**
     * 添加账号模态的三个 tab：登录 / 导入凭据 / 粘贴 JWT。
     *
     * 以前是四个（「本机文件」+「选择文件」分开），两者读的是同一种文件、只在
     * “读的位置”上不同；而「本机」指的是服务端那台机器，对浏览器用户是误导。
     * 现在合并成 `credential`，内部再用 radio 选来源（`browser` 默认 / `server`）。
     */
    ADD_TABS: ["login", "credential", "jwt"],
    DEFAULT_ADD_TAB: "login",

    /* ---- 登录（OAuth 模态）------------------------------------------- */

    /** 最近一次登录流程的进度（`panel.ts` 的 `GET /api/oauth-status`）。*/
    OAUTH_STATUS_PATH: "/api/oauth-status",
    /** 四个相位；`idle` 表示没有流程，或者那一条已经过期。*/
    LOGIN_PHASE: { IDLE: "idle", PENDING: "pending", READY: "ready", FAILED: "failed" },

    /**
     * 登录轮询间隔。
     *
     * 2s 与上游 `/oauth/cli/poll` 自己的节奏同量级：扫码到回调通常是秒级，再快只是
     * 在页面和服务端之间空转；再慢用户会觉得扫完码界面卡住了。
     */
    LOGIN_POLL_INTERVAL_MS: 2000,

    /**
     * 「这次流程已经不在服务端」的稳定错误码（`control.ts` 的 `reportOauth` 用它回
     * 一条命中不了的流程 id）。轮询看到 `idle`，或者应答里的 `flowId` 不是自己那次，
     * 就用它当失败原因：两种情况都意味着等的结果不会来了。
     */
    LOGIN_ERROR_NO_FLOW: "no_matching_oauth_flow",

    /*
     * 凭据出身。两个取值与 `src/provider/types.ts` 的 `ProviderId` 同源，
     * 默认值与 `accounts/transfer.ts` 的 `DEFAULT_PROVIDER` 一致。
     *
     * 这不是用户偏好：provider 记的是这个账号的 key 从哪家换出来，建号后不可变。
     * 选项文字直接用协议值，不翻译。
     */
    PROVIDER_IDS: ["zai", "bigmodel"],
    DEFAULT_PROVIDER: "zai",
  };
})(window.__zcodeApp = window.__zcodeApp || {});
