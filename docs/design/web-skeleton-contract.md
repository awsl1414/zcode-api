# 面板骨架契约：参考层

`src/server/web/AGENTS.md` 是常驻契约，改视图 / 样式前读那一份。本文件是它的参考层：
逐批的实测依据、取值推导、术语口径、变体登记表、遗留清单与跨片段源序依赖的全部细节
都在这里，按需查阅。常驻契约给规则与正例 class 组合，本文件回答「为什么是这个值」。

常驻契约里的规则能在下面按节名找到对应的完整推导。

---

## 这层管什么 / 不管什么

- **管**：视图手拼 DOM 时自由度最大的那一段——层级、间距节奏、对齐网格、
  排布、浮层与图表的形态约定。
- **不管**：取值本身。颜色 / 字号 / 圆角 / 间距档位在 `tokens.css`，组件形态在
  `styles/*` 的片段里，页面与运行时只引用 `var(--…)`，裸值仅限纯几何
  （meter 进度、柱高、内联 `width`/`height`；`page.test.ts` 钉全目录零裸 hex）。
- 注释就是文档：组件块头上的「为什么」是本规范的证据链（块按样式职责搬进 `styles/*`，
  注释随块走），改行为时保留 / 更新依据，不要重写成「看起来更合理」的实现。
- **页面布局协议是地基**：先决定这一页是 flow 还是 fill，再谈别的小节。壳之外的补丁
  （`position: fixed`、`100vh` 估算、给滚动打的计算）一律视为违规，不是风格问题。

## FILES

| 文件 | 角色 |
| --- | --- |
| page.ts | 唯一面板模板的拼装入口（THEME-BOOT / TOKENS / COMPONENTS / I18N / APP 五占位；单套 HTML 服务全部视图）+ 两个拼接数组 |
| page.html / page-tail.html / views/*.html | 面板骨架片段：壳与侧边栏（到概览之前）/ 八个视图块 / 收尾（见下节） |
| login.html | 登录页（同一套 tokens + components，360px 卡；不参与拼接数组） |
| tokens.css | `:root` 变量唯一来源（间距 / 字号 / 圆角 / 密度 / 布局几何 / 配色，浅深两套 + system 媒体查询） |
| styles/base.css · styles/components.css · styles/views/*.css | 组件类片段，只引用 token，不写裸色值；**顺序 = 层叠顺序**（见下节） |
| app-view-*.js / app-add-account.js | 视图运行时 DOM（表格行 / 详情窗体 / 菜单 / 图表节点），同样只拼组件类 |
| app-logs-system-stream.js · app-logs-request-table.js | 日志页（`app-view-logs.js`）的两个渲染模块，`APP_MODULES` 里排在主视图之前：系统 tab 的日志流（行缓冲 / 四列 / 重复折叠 / 连接状态）与请求事件表（十四列 / 展开详情 / 「加载更早」）。过滤、tab 与取数留在主视图 |
| app-chat-attachments.js · app-chat-sessions.js · app-chat-stream.js | 聊天视图的三个零件：图片 blob 存储层 / 会话状态与持久化 / 请求体组装与 SSE 帧解析。只被聊天视图消费，排在 `app-view-chat.js` 之前 |
| app-accounts-plan-cards.js / app-accounts-table.js / app-accounts-detail.js | 账号页的三个子系统（三分法）：额度模型与套餐卡 / 表格行与批量条与菜单 / 详情大窗与抢活动段；主视图 `app-view-accounts.js` 只留渲染出口、导入导出、删除确认与顶栏刷新 |
| app-charts.js | SVG 自绘堆叠柱（唯一图表绘制点） |

## 账号页模块分工（三分法）

账号页的运行时脚本分成四个文件，按依赖顺序拼进 `APP_MODULES`（都排在
`app-view-accounts.js` 之前）：

| 文件 | 职责 | 不做什么 |
| --- | --- | --- |
| app-accounts-plan-cards.js | 额度模型（`planCardsOf` 卡序列）与套餐卡 / 桶行 / 窗口行 / 订阅产品行；百分比换算与额度条；套餐段、体系分区、活动段 | 不拼表格行，不碰大窗开合 |
| app-accounts-table.js | 表格行九格、状态与筛选派生、统计行、批量条与批量动作、行尾菜单与调度权重浮层 | 不画套餐卡，不拥有选择以外的跨页状态 |
| app-accounts-detail.js | 详情大窗（段序列 / 抢活动 / 逐路由健康 / 能力对齐 / 健康状态变化事件）与开窗入口 | 不改表格 DOM，不拉轮询 |
| app-view-accounts.js | 编排：`render` 出口（统计 → 行 → 批量条 → 同步大窗 → `?focus=`）、导入导出、删除确认、顶栏刷新 | 不重复实现子系统里的构造 / 派生函数 |

模块间通信仍走 `window.__zcodeApp` 命名空间：套餐卡模块挂 `App.accountsPlans`，
表格挂 `App.accountsTable`，大窗挂 `App.accountsDetail`；主视图向表格注入三个
入口（开详情窗 / 开删除确认 / 整页重画），表格因此不依赖主视图与大窗的状态。
`page.test.ts` 的模块顺序断言是拼接契约的一部分，改数组要同步改断言。

## 片段布局与索引（2026-11-10 按片段文件重排）

组件样式与页面骨架不是单个文件：`page.ts` 用三个数组把片段拼成一份，面板页与登录页
共用同一个 `COMPONENTS_SLOT`。

- `APP_MODULES`：**顺序 = 模块依赖顺序**。常量 / DOM / 格式化等基建在前，随后是
  聊天三个零件与各视图模块（被依赖的排在视图之前）。拼好的脚本顺序就是浏览器执行顺序。
- `COMPONENT_CSS_PARTS`：**顺序 = CSS 层叠顺序**。`styles/base.css`（原块 1-11）→
  `styles/components.css`（12-22）→ `styles/views/logs.css`（23-24）→
  `styles/views/settings.css`（25-31）→ `styles/views/chat.css`（32）。拼好的文本是
  `PAGE_COMPONENTS_CSS` / `joinedComponentsCss()`。
- `PAGE_HTML_PARTS`：**顺序 = DOM 顺序**。`page.html`（壳与侧边栏，到概览视图之前）→
  `views/{overview,stats,accounts,routing,keys,logs,settings,chat}.html` →
  `page-tail.html`（收尾、tabbar、浮层、字典与脚本占位）。拼好的文本是
  `joinedPageHtml()`；登录页走自己的 `login.html`，不参与这个数组。

改片段的纪律：先找块在哪个片段（块头的「为什么」注释就在该片段里）。`COMPONENT_CSS_PARTS`
与 `PAGE_HTML_PARTS` 的顺序是层叠与 DOM 顺序的唯一保证，调整顺序不会报错、只会静默换一套
样式；`page.test.ts` 的拼接断言核对产物与按序读到的片段逐字节相同，跑
`bun test src/server/web/page.test.ts` 即可。

### 片段索引：跨片段的源序依赖

片段之间**有真实的层叠依赖**：后出现的片段压过前面的，所以下面这些类必须靠
`page.ts` 数组顺序才成立。**数组顺序是唯一保证，勿调序**（调序不会报错，只会静默换一套样式）。

| 类 / 规则 | 定义分布 | 为什么依赖源序 |
| --- | --- | --- |
| `.table.matrix`（路由矩阵） | 在 `styles/base.css`（块 11「账号 × 路由矩阵」），而 `.table` / `.table th, td` 基础规则在 `styles/components.css`（块 16「表格」） | 矩阵的对齐与铺满写在基础表格规则**之前**，所以选择器一律带 `.table` 提高特异性（`.table.matrix th/td`）才盖得过去；片段顺序反了，基础表格的 `text-align` 会赢 |
| `.field-grid` / `.field-cell` | 基础规则（两列网格、标签行、行内排、控件吃满）在 `styles/components.css`（块 13「字段格 / 说明文字」）；`.modal .field-grid`（弹窗内一列）在 `styles/base.css`（块 7「模态」） | 弹窗那条是**减列**覆盖，靠 `.modal` 前缀拿特异性；基础规则改列数时弹窗不受影响，删掉前缀则弹窗回到两列 |
| `.chat__panel` 的空态居中 | `.chat__panel` 基础规则（flex 列、`gap`）在 `styles/views/chat.css`（块 32）；`.chat__panel:has(> .empty:not([hidden])) > .empty` 在 `styles/views/logs.css`（块 23「日志流」，与 `.log-panel:has(> .empty:only-child)` 同一块） | 这一块是「fill 页的两个框体」共用的空态取舍，拆批时按原文件字节位置留在了日志片段。聊天片段排在它后面，靠 `:has` 的高特异性与 `.chat__panel > .empty` 的基础规则叠加；改空态行为要同时看两个片段 |
| `.group__icon` / `.collapse__chevron` | 图标盒子（`width` / `height` / `stroke` 一组）在 `styles/base.css` 的图标组（块 1「应用骨架」末尾）；`.collapse__chevron` 的折叠态旋转与尺寸微调在 `styles/views/settings.css`（块 28「CollapsibleSection」） | 两组规则管**不同属性**，靠源序叠加：base 给盒子，settings 片段给 `[data-collapse-open="false"]` 下的旋转。settings 片段必须在 base 之后；删掉任何一侧都只剩半个图标 |

新增片段时先回答：它压谁、被谁压。跨片段共用一个类时，要么把覆盖写成带作用域的高
特异性选择器（如 `.table.matrix`、`.modal .field-grid`），要么把片段插进数组的正确位置
并在本表登记一行。

## 术语表（W86）

同一件事只许一个叫法。下表是**面板文案与本文已经用开**的词，新页面、新文案、
新提交信息按这一列取词；同义异名（「体验包」「一次性套餐」「限额格」…）不再新增。

| 术语 | 定义 | 用在哪 |
| --- | --- | --- |
| **体验套餐** | start-plan 平面（`billing/balance` 的套餐实例与余额桶，含活动套餐，W110）；与 `period` 无关 | 账号类型标签（`.tag`）、套餐卡 `.plan-card` |
| **订阅套餐** | coding-plan 平面（订阅接口确认的权益：`coding-plan` 及派生入口 `off-peak` / `highspeed`）；套餐段分区小标题用官方产品面词**「编程套餐」**（`accounts.plan.group.coding`，W95-P2） | 同上（`.tag--accent`） |
| **双套餐** | 同一账号同时具备两类（`planKinds = ["subscription", "experience"]`） | 账号类型标签 |
| **调度权重** | `weight / Σweight` 的归一化百分比，**不是优先级、也不是实测流量**；同一时刻所有账号加起来 100% | 账号页「调度权重」列 `.share__value` → 浮层 `.share-pop` |
| **额度窗口** | coding 平面的四格：5 小时 / 每周 / 每月工具调用 / ZCode MCP（窗口身份 = `unit` + `number`，官方 UI 的四格靠它区分） | 账号详情大窗 `.plan-card__windows`、账号页 `.quota-cell` |
| **fill / flow** | 页面滚动模式的两种（W70，页面布局协议）：fill = 核心交互区始终可见；flow = 正文自己滚 | 布局协议 |
| **刷新** | 顶栏唯一的上下文刷新入口（W72，顶栏刷新协议）；页内不再有第二个「重取」按钮 | 全局 |
| **降级顺序 / 调度策略 / 队列 / 粘性 / 风控** | 路由页的五组；降级顺序与账号矩阵整行跨两列（`.routing-grid__span`），中间四组两两配对 | 自适应 Grid 与高度同步 |
| **账号类型** | 路由矩阵里的身份列：主标签 = `provider` 的用户词（Z.AI / BigModel），小字 = 凭据出身 `kind`；不读 routes，也不复述 JWT-only 的能力说明 | 容器 |

两条口径值得单独记下来，它们最容易在文案里混：

- **「权重」与「调度权重」是两个量**：权重是配置里的正整数，调度权重是它的归一化
  结果。界面上只出现归一化后的百分比（W76 把原始权重的列换掉了），权重只在编辑
  浮层里出现。列里算的是调度器**分配请求**的比例，真实流量看统计页。
- **「额度窗口」只说窗口**，不说「额度格 / 限额条」——后者听起来像几何尺寸的说法
  （字号 / 行高 / 尺寸基线里的 `--control-height` 那一类）。

## 浏览器基线（W86）

**只支持现代常青浏览器**（Chrome / Edge / Firefox / Safari 最近两个大版本）。面板
是本地工具的控制面，读者是开发者，所以不为老引擎付任何成本。

已经依赖、且**不打算**降级的平台能力（都在 `styles/*` 里真的在用）：`:has()`
（浮层滚动锁、`.panel:has(> .table)` 的横向滚动、`fill` 页空态居中）、`100dvh`、
`inset`、`min()` / `max()`、对齐关键字的 `safe` 变体（热力图窄屏不裁左边界）、
`:focus-visible`、`appearance`。

三条禁令：

- **禁 `@supports` 回退**：写「不支持就退回老布局」等于同时维护两套骨架，而两套的
  差异没人能在本地看见。能力缺失应当表现为明显的坏掉（能被发现并修），不是悄悄
  降级。目前全目录零 `@supports`，`page.test.ts` 也只钉产物不钉兼容分支。
- **禁 polyfill / 预处理器**：零构建链口径不变（见「消费方式」），没有 Babel / PostCSS / core-js
  这一层，页面直接跑自写的 ES5 风格模块（`var` + IIFE + 一个 `window.__zcodeApp`）。
- **禁 `-webkit-*` 前缀，两处例外**：`input[type="number"]` 的 spinner 只有
  `::-webkit-inner-spin-button` 这一组伪元素可选，那里的 `-webkit-appearance: none`
  与 `-moz-appearance: textfield` 并写是**功能实现**（见「表单」的「数值输入」），不是兼容
  补丁；`.hint-details > summary::-webkit-details-marker`（W78）用来收掉 Safari 的
  `<summary>` 三角形——`list-style: none` 在旧 Safari 不够，两行并写（W101 登记）。
  除此之外新增任何前缀都先在本文登记。

## 1. 页面布局协议：一个壳 + 两种滚动模式（W70）

### 判据

**「核心交互区是否需要始终可见？」是 → `fill`；否 → `flow`（默认）。**

判据一句话就够分类：聊天（输入框）与日志（日志流）的交互区必须始终在视野里，
所以那两页 fill；其余七页是读内容，读者滚动时不需要同时盯着某个控件，所以
flow。拿不准时选 flow：flow 的行为与旧文档流一致，不会误伤任何页。

### 壳（唯一滚动模型）

整页不滚：`html.app-root` 把文档钉成视口高度并关掉文档流滚动，滚动只发生在
**视图的 `.page-body`** 里。每个视图 = `.page.<密度档>`（就是带 `data-view` 的
容器，密度档也钉在这一个元素上），里面**只有两块**：页头与正文。

```html
<div class="page dense" data-view="logs" hidden>
  <header class="page-header">…标题 / 说明 / 全局动作…</header>
  <div class="page-body">…正文（flow：这一层自己滚）…</div>
</div>
```

CSS 骨架（实现就在 `styles/base.css` 的「应用骨架」块，别处不要另行发明）：

```css
html.app-root, html.app-root > body { height: 100%; overflow: hidden; }
.app { height: 100%; display: flex; flex-direction: column; }
.app__body { flex: 1; min-height: 0; display: flex; }
.sidebar { flex: 0 0 auto; overflow-y: auto; }
.content { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 20px; }
.page { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.page-header { flex: 0 0 auto; }
.page-body { flex: 1; min-height: 0; overflow-y: auto; }            /* flow 默认 */
.page-body--fill { overflow: hidden; }
.fill-region { flex: 1 1 auto; min-height: 0; overflow-y: auto; }  /* fill 的滚动块 */
.fill-chain { flex: 1 1 auto; min-height: 0; }                     /* 只传高度的中间层 */
```

`.app__body` 与视图之间还有一层 `.content`（主区，内边距由
`--layout-content-gutter` 给）：它不滚、不限宽，只负责把内边距让出来。
**锚点由这一层的 padding 统一给**（左对齐定锚）：`.page`、页头、正文、面板与
`.content__note` 都吃满主区可用宽，只写 `width: 100%`，不写 `margin: auto`。
顶栏也用同一个 gutter，所以刷新 / 主题 / 语言三颗控件的右缘与
`.page-header__actions` 的右缘落在同一条竖线上。
`.content` 顶上的 `.content__note`（读取失败横幅）是唯一不属于任何视图的块，
空时高度为 0（里面横幅 `hidden`）——所以它不占位，也不参与视图切换。

**一条内容列**：八视图不按表单 / 数据 / 聊天分档，也没有设置页的窗口宽例外。
页头、正文、面板、表格共用 `.content` 给出的右边界；超宽屏下不跟着拉宽的是
组件本身——指标卡、字段格、图表、长表格与聊天输入区各自有可读上限，取值在
`tokens.css`，规则在 `styles/components.css`。热力图的格子缸与月轴沿用同一份
动态列模板，相对面板继续铺满，不留右侧空白。flow 视图出现纵向滚动条时，
正文的可用宽少一个滚动条宽；页头动作仍钉在全局 gutter 上。

每一层都必须写 `min-height: 0`：弹性项的默认最小高度是**内容**高度，漏一层
就会把标“固定”的那块顶出视口——W70 之前聊天输入框掉到屏幕下沿、状态行
只能靠 `position: fixed` 补、旧页顶栏随页面滚走，根因都是同一个。

正文里的四层顺序不变：**标题 → 工具栏 → 横幅 → 内容**（标题层现在就是
`.page-header`，另三层按顺序排在 `.page-body` 里），间隔统一 16px
（`--space-4`，`.page` 与 `.page-body` 的 `gap`）。

正例（标题 + 一句说明 + 右侧全局动作，W40a PageHeader）：

```html
<header class="page-header">
  <div class="page-header__heading">
    <h1 class="page-title">…</h1>
    <p class="page-header__desc">…</p>
  </div>
  <div class="page-header__actions">
    <button type="button" class="btn">…</button>
    <button type="button" class="btn btn--primary">…</button>
  </div>
</header>
```

八个视图全部用这一层页头（W70 把概览 / 统计 / 日志从裸 `h1.page-title` 也收
进来：页头要固定，就不该有两种写法）。工具栏里有真正的过滤器行（日志的
status / 账号 / 级别、统计的范围 tab）时，那一行仍然摆在 `.page-body` 顶部的
第一层，不塞进 `page-header__actions`。

### 两种模式的正例

**flow（默认）**——概览 / 统计 / 账号 / 路由 / API key / 设置：

```html
<div class="page comfortable" data-view="overview">
  <header class="page-header">…</header>
  <div class="page-body">
    <div class="banner banner--warn">…</div>   <!-- 有告警才出现 -->
    <div class="metrics">…</div>
    <section class="panel">…</section>
  </div>
</div>
```

页头固定，其余全部在 `.page-body` 里滚；滚动位置归这一页自己（切到别的视图
就是另一块滚动容器，不带着上一页的偏移）。

**fill**——聊天 / 日志。`.page-body--fill` 不滚，中间层写 `.fill-chain` 把高度
往下传，真正滚的那一块写 `.fill-region`：

```html
<!-- 聊天：选择器固定 / 消息区吃满 / 输入区贴底 -->
<div class="page-body page-body--fill">
  <div class="banner banner--danger">…</div>
  <div class="chat__layout fill-chain">
    <div class="chat__main">
      <section class="collapse">…连接与层级选择…</section>
      <section class="panel chat__panel fill-chain">
        <div class="chat__log fill-region">…消息…</div>
        <form class="chat__composer">…输入区…</form>
      </section>
    </div>
  </div>
</div>

<!-- 日志：tab + 过滤器固定，日志流吃满 -->
<div class="page-body page-body--fill">
  <div class="tabs">…</div>
  <div class="toolbar">…过滤器…</div>
  <section class="panel fill-chain log-panel">
    <div class="log fill-region">…日志行…</div>
  </section>
</div>
```

fill 页的两个约定：

- `.page-body--fill` 的直接子元素默认不压缩（`flex: 0 0 auto`），所以输入区不会
  在矮视口下被压成一条薄片；只有标了 `.fill-region` / `.fill-chain` 的那一条
  参与高度分配。
- 网格中间层（`.chat__layout`）要显式写 `grid-template-rows: minmax(0, 1fr)`：
  隐式行按内容高算，高度会断在那里。
- **聊天输入区的几何（W79）**：输入行 `.chat__inputrow` = 36×36 附件按钮 + 
  `.chat__field`（可宽 1 份），两者顶对齐；`.chat__field` 内是 textarea 与
  一层绝对定位的 `.chat__actions`（左 12px / 右 12px / 下 8px）——状态文案在左下，
  停止 / 发送在右下。发送键曾是输入框**下一行**的面板级按钮，视觉上跟输入区无关
  （用户实测「发送按钮孤立」）；现在它贴着输入框右下角内侧，输入区读作一个框。
  textarea 的 `padding-bottom: calc(--control-height + --space-4)` 给操作行让位。
  768px 高的视口下实测输入框底部 727 < 768（选择器区收起；展开时也一样），
  因为高度全部由壳算，不靠任何 `calc(100vh - N)` 估算。

### 禁止

- **禁止用 `position: fixed` 给页面块打补丁**（状态行、tabbar、页头都曾经是这
  样）：壳已经把「谁固定」表达清楚了。只允许真正的浮层用 fixed——遮罩
  （`.modal-scrim`）与三个面板类（标准模态 `.modal`、账号详情大窗
  `.modal.modal--lg`、登录卡 `.login-card`），共三类；W75 把 W40-2 的右侧抽屉
  （已删除的抽屉类 `drawer`）并进了大模态，浮层类型反而少了一种。W79 登记第四类：撤销条
  `.toast`（见「浮层」），它是唯一不带遮罩的 fixed——因为它不表达「模态」。
  新增第五类要先在本文登记。
- **禁 `min-height: 100vh` / `calc(100vh - Npx)` 这类高度估算**：前者把页面交回
  文档流滚动，后者把「顶栏 + 页头 + 横幅 + 选择器 + 输入区」的和写成常数，任何
  一块变高/变矮都会让估算落空。高度由壳算。
- **禁在 `.page-body` 里再套第二层纵向滚动**：一个视图只有一个滚动容器
  （flow 就是 `.page-body`，fill 就是那个 `.fill-region`）。表格、日志、消息区
  要滚，就把它自己写成 `.fill-region`（fill 页）或让页面滚（flow 页）。
- 浮层打开时要锁住底下的滚动：`styles/base.css` 用
  `html.app-root:has(.modal:not([hidden]))` 给 `.page-body` 与 `.sidebar` 上
  `overflow: hidden`。**所有浮层的开合投影统一是 `hidden` 属性**（W75 把抽屉的
  `data-drawer-open` 也收进来了）：新增浮层只要用 `hidden` 表达可见性，这条锁自动
  生效，不要再造一个 JS 计数器。

- 密度档钉在 `data-view` 容器（也就是 `.page`）上：概览 / 统计 `comfortable`；
  设置 / 聊天 `medium`；账号 / 路由 / API key / 日志 `dense`。W46v2 起
  三档同值（radius 8 / pad 16），W71 只把内边距提到 20，圆角仍是 8——类名保留给
  将来的分页调密度。
- 内容区外层不限宽：`.page`、页头、正文、面板与 `.content__note` 吃满 `.content`
  的可用宽；右边界与顶栏共用 `--layout-content-gutter`。页头动作靠
  `margin-left: auto` 钉在这条右缘上，不跟随任何页面宽度档位。
- 有告警才出现的横幅 `.banner`（`--warn/--danger/--ok` 三变体）插在
  工具栏与内容之间；无告警整条不渲染（不画空容器）。

### 1.1 字号 / 行高 / 尺寸基线（W71）

取值只有一个来源：`tokens.css` 的 `:root`。组件层与视图**只引用 `var(--…)`**，
任何一处裸 `font-size: 13px` 都是缺陷（`page.test.ts` 钉全目录零裸字号）。

| token | 值 | 用途 |
| --- | --- | --- |
| `--text-display` | 26px | 页面标题、关键数字（`.page-title` / `.card__value`） |
| `--text-title` | 17px | 区块标题、模态标题、品牌名 |
| `--text-body` | 15px | 正文（`.app` 基准字形）；日志正文也走 meta 而非它 |
| `--text-meta` | 14px | 按钮、字段、下拉、表格常规行、导航项 |
| `--text-micro` | 13px | 辅助信息、hint、徽章、图表刻度、密集数据表 |

行高全局 `--leading: 1.5`（不新增档位）。由字号推出来的尺寸：

| 尺寸 | 值 | 推导 / 用途 |
| --- | --- | --- |
| `--control-height` | 36px | 按钮 / 输入框 / 下拉 / 步进器 / 导航项：14px × 1.5 = 21 + 上下各 7.5 |
| `--control-height-sm` | 28px | 表格行内控件档（W85 起，W99 扩到全部行内控件：`.btn--sm` / `.tag--toggle` / 步进器 / 行内下拉 / ⋯ 触发键）：13px × 1.5 = 19.5 + 上下各 4 |
| `--tag-height` | 22px | 标签族（W99 统一口径）：`.tag` / `.status-badge` / `.chip` / `.chat__filechip` / `.req__effort`：13px 文字 + 1px 描边 + 小留白 |
| `--switch-width` × `--switch-height` | 40 × 22 | 开关胶囊，滑块 `--switch-knob` = 18；半径 `--radius-lg` = 高度的一半 |
| 表格行高 | 常规 45px / 密集 40px（单行）· 56px（两行小字塔配） | 12px 上下内边距 + 21px（meta）/ 8px 四边 + 40px 最小高度（micro，W99）；横向内边距按表密度取（U3a） |
| `--layout-icon` | 20px | 导航 / 区块标题 / 折叠头 / 品牌名旁的图标 |
| `--icon-sm` / `--icon-xs` | 18 / 16px | 按钮内图标 / 芯片与小型图标 |
| `--layout-appbar` / `--layout-sidebar` | 56 / 232px | 顶栏高 / 侧栏宽 |
| `--layout-content-gutter` | `var(--space-5)` | `.content` 与顶栏共用的左右留白；窄屏换 `--space-4`，页头动作与顶栏按钮仍在同一条竖线上 |
| `--layout-metric-max` / `--layout-field-grid-max` / `--layout-reader-max` / `--layout-composer-max` | 320 / 620 / 1280 / 1024px | 指标卡、字段格、图表与长表格、聊天输入区各自的可读上限；不按视图切换 |
| `--layout-actions-col` | 176px | 表格「操作」列（W85 定，W99 三张表共用）：内容 160（三件 28px 行内控件 + 两道 8px 间隔）+ 单元格左右内边距 16 |

- 尺寸只允许「字号推出来」这一条推导链：要更大的控件先问字号要不要动，
  不要单独把某个按钮加高（同层级同尺寸）。
- **28px 是全文件唯一的受控例外**（W85 定档，W99 收口）：**表格行内的控件一律 28px**
  ——`.cell-actions` 里的 `.btn--sm` / `.tag--toggle`，以及没有小号变体的步进器 /
  行内下拉 / ⋯ 触发键（后三者由 `.table` 作用域统一给，见「按钮」）。理由是同排的 36px
  三件套会把 45px 的行撑到 53px（一屏少两行），而 22px 的开关与 36px 的按钮同排时
  基线对不上。它仍然是「字号推出来」的：13px 文字 × 1.5 + 上下各 4px。
  窄屏媒体查询里的 `.btn` 44px 写在后面、同特异性，会把它盖回触摸档；`.table`
  作用域那几条是 (0,1,1)，所以在同一条媒体查询里按同一组选择器再压一次（见「按钮」）。
  表里**不属于行内控件**的按钮不在此列：「加载更早」那种跨整行的动作仍是 36px。
- 标签族（`.tag` / `.status-badge` / `.chip` / `.chat__filechip` / `.req__effort`）
  高度只有一个来源：`--tag-height`（W99）。新增标签外形先复用这一档，
  不要在某个视图里另写一个高度。
- 密集数据表的受控例外见「容器」末条。

## 2. 容器：一层边框、8px 圆角、20px 内边距

- 容器类全家族（`.panel` / `.group` / `.collapse` / `.card`）= 1px `--line` +
  `--radius-md`（8px）+ 密度档内边距（W71 起 20px）。层级靠 padding 与字号，
  不靠边框深浅。
- **折叠区摘要只在收起时出现**（W77 起的显式钩子 `.collapse--summary-when-closed`）：
  摘要复述的就是字段值，展开后它只是噪声；收起时需要它把值留在标题行
  （路由页的队列 / 粘性 / 风控三块）。**不给 `.collapse__summary` 写全局规则**
  ——聊天的选择器折叠区（`.chat__settings`）展开时也要显示组合摘要，那里
  摘要不是复述。
- **面板内的表格不再给单元格画框**：`.table th, td` 只有横向分隔线（表头
  `--line`、数据行 `--line-soft`、末行不画）。这是 W46v2 对「框体套框体」的
  收敛结论，禁止回退。
- **对齐全项目统一，内边距按表密度自定（U3a 定，全项目一张表格契约）**：
  `.table th/td` 是唯一写对齐的地方——`text-align: center` + `vertical-align: middle`，
  表头 / 文本 / 数值 / 状态 / 操作列一律居中；**逐表禁止再写对齐**（`.table.matrix`、
  `.req__history` 等块的散写对齐已删）。「居中」指**单元格内的内容**，不是表格本身：
  表格 `width: 100%` 铺满面板，禁止 `width: auto` / `margin: 0 auto` 缩成窄带。
  `text-align` 管不到 flex 盒子，盒子级内容（`.cell-stack` / `.cell-actions` /
  `.key-cell` / `.quota-cell` / `.usage-tower` / `.share__value`）各自显式
  `align-items: center` 或 `justify-content: center`。
  内边距分三档、按表的字段密度取：
  - 密集表 `.table--dense`（日志 14 列 `req-table`）：`--space-2` 四边，唯一允许覆盖
    表格字号与内边距的钩子（W71 定，W99 收行高到 40px）；
  - 多列常规表 `.table--tight`（概览摘要 6 列、账号页 9 列）：纵向 `--space-3`、
    横向 `--space-2`（1000px 视口下 12px 横向会把概览摘要表顶出面板）；
  - 其余常规表（keys / proxies / 统计分组）与矩阵：`--space-3` 四边（基础档）。
  **不要给新表加全局统一的 padding**——按自己的字段密度选档，并在本文件登记。
  旧文案「常规表格 12px 纵向 / 8px 横向」已被这条取代。
- **密集数据表的例外（W71 定，W99 收行高）**：列数多、需要一屏看全的表（目前只有日志页的
  十四列请求表 `data-role="req-table"`（W80），即 `.table--dense`）字号降到
  `--text-micro`（13px）、单元格回 8px 四边，**单行行高 40px**（单元格的 `height`
  在表里是最小高度，两行小字塔配的格子照旧长到 56px）。这是**唯一**
  允许覆盖表格字号与内边距的钩子；新增密集表只能复用这个类，禁止在某张表上
  写 `font-size` / `padding` / `height`。判断线：列数 ≥ 10，或单元格里要并排两行数字
  （reqId + 阶段、↑出 ↓入）时才用它。
  列数 ≥ 10 的表在窄视口还要回答「哪几列可以走」（W99）：请求表在 ≤1440 把缓存 /
  推理强度 / 重试三列折叠进展开行（`.req__col--extra`，见「自适应 Grid 与高度同步」）。
- 横向溢出由 `.panel:has(> .table)` 自己滚（页面不出现横向滚动条）。
- **表格里的可点单元格（W75 / W76）**：账号表的两个数值列各有自己的交互件，都写成
  真 `<button>`（键盘唯一入口，也是「关窗把焦点还回去」的落点，见「浮层」）：
  - 额度列 `.quota-cell`：单元格本身就是按钮，里面是「类型 + 数字 + 48px 迷你条」
    的行（`.quota-cell__line` / `__kind` / `__amount` / `__more`）；没有额度时
    `.quota-cell--empty` 换一行灰字，不画空壳。迷你条的宽度是一段几何值。
    **两种「空」写两句话（W100）**：还没采样过 = 「未采样」+ `title` 说明；
    有采样但桶全过期 = `—`。两者写成同一个 `—` 会被读成「零额度」。
  - 调度权重列 `.share__value`：主题色 + 等宽数字、**无下划线**（下划线是 `<a>` 跳转的
    语义，见「按钮」），命中区保持 `--control-height`（36px；密集表 45px 行高装得下）。
- **fill 页的两个框体（W70 / W79）**：`.log-panel`（日志）与 `.chat__panel`（聊天）
  是 `.panel` + `.fill-chain` 的复合体——一个元素两个类，不是第二层容器。框体自己不
  滚，只管边界与内边距，里面那块 `.log` / `.table-scroll` / `.chat__log` 才是
  `.fill-region`。两者都必须是 flex 列：块级子元素上的 `flex: 1 1 auto` 无效，行一多
  内容会冲出框体（页面已经不滚，溢出部分直接被 `.page-body` 裁掉）。只剩空态时
  （`:has(> .empty…)`）改成居中，别让虚线框贴顶、下面留一整块空白。
- **矩阵列宽与对齐（U3a 收敛，取代早先的逐表写法）**：`.table.matrix`（路由页「账号 ×
  路由」）跟随全项目表格契约，块里**只留列排布**（`width: 100%` + `table-layout: fixed`，
  按列数等分，不逐列 ch 定宽）；对齐与纵向中线由基础规则统一给，矩阵块里不写
  `text-align` / `vertical-align`。窄屏多路由列由 `.panel:has(> .table)` 横向滚。
  距离按表自定：矩阵留在基础档（`--space-3`），不写自己的 padding。账号类型列
  （`.matrix__type`）展示 `AccountSummary.provider` 的用户词与 `kind` 的小字补充，
  不是从 routes 派生。**只定对齐与铺满，不动字号**——字号仍只有 `.table--dense`
  一个钩子。旧的逐表对齐声明 / 左对齐契约 / `align-items: flex-start` / `padding-left` /
  30-15-55 百分比布局 / ch 定宽 / 末列吃剩余宽度 / 表格居中，全部删除，不留双轨。
- **双层框禁令**：`.panel > .card`、`.group > .group`、panel 套 panel 一律禁止。
  面板内自带边框的「行框体」是仅有的合法嵌套，登记在案的三种：
  `.order-item`（路由降级行）、`.chat__session`（会话列表项）、
  `.empty`（虚线占位框，虚线是「这里是空态」的语义，不是第二层容器）。
  新增例外必须先在本文件登记。
- **纯布局容器不算一层框**：只把子块排开、自己不画边框 / 背景 / 内边距 / 阴影的
  `div` 不触发上一条——它没有第二层轮廓，读者看不到它。登记在案的一个：
  `.stats-side`（统计页两列的右列，竖叠调度事件与缓存命中率，只管
  `grid-template-rows` 与 20px 行距）。新加这类容器照此办理：只写排布属性，
  类名带用途（不叫 `.col` / `.wrapper`），并在本节与「变体登记」登记。
- **`.stat` 在面板内不画自己的框**（W61 修 W60 P2-2）：`.stat` 自带 1px 边框，
  只在顶层（概览 / 账号页的统计行）成立；进 `.panel` 就退成裸数字列
  （`.panel .stat` 清掉 padding / border / 背景）。统计页的调度三卡与并排的
  「缓存命中率」因此同构：面板一层框，里面只有标题与值。
- 阴影分工：分组卡片（`.group` / `.collapse`）无阴影；`.card` 只有
  `--shadow-card`；`--shadow-panel` 只给模态 / 登录卡这类真浮层。
- **额度条的三档语义色（W75，过程态例外，唯一登记在案的第三色阶）**：
  剩余 >50% `--ok`、20–50% `--warn`（琥珀）、<20% `--danger`。健康徽章只有
  绿 / 红 / 灰三档（红 = 系统故障，灰 = 用户主动停用），额度条是例外——「还剩一半」
  与「快用完了」对行动决策不同，而健康徽章回答的是「现在能不能发请求」。例外只给
  `.meter__fill--*` 与 `.quota-pct--*`，不得回到 `status-badge` / `.banner`；新增
  第四档先登记。
- **`status-badge--accent`（W77 路由优先级，W101 补登记）**：路由页把「优先级
  最高的那条路由」的徽章染成主题色（`app-view-routing.js` 的 `index === 0`）。它是
  **标识**不是状态：不表达「好 / 坏 / 进行中」，所以用 `--accent` 而不是第四种语义色。
  健康 / 状态仍只有 ok / danger / muted 三档 + warn / pending 过程态；这一档只给
  路由优先级，不得拿去标状态。
- **来源色点（W80，登记在案的非语义色组）**：`tokens.css` 的 `--identity-1..6`
  六档，只给日志页「来源」列的 `.req__source-dot`。它是**标识**不是状态
  （绿 / 琥珀 / 红只说明状态，拿来标账号会被读成告警），所以不随主题
  翻转——与 `--qr-*` 同一写法，只在 `:root` 定义一次。账号名 → 稳定下标，同一个
  账号永远是同一个颜色（`app-logs-request-table.js::identityDotIndex`）。这一组是已登记
  的例外，不得外溢到其它组件。
- **日志正文的键值分层（W80）**：`.log__kv--key`（faint）/ `.log__kv--val`（text）。
  结构化条目的正文里 `key=value` 分段着色，键弱值深——日志墙的常态是同一句模板
  反复出现，只有值在变。整段原文的行（无 `entry` 的历史行）不拆分段，靠
  `.log__line--plain` 的悬挂缩进让续行对齐。
- 空态两级：整页没内容用 `.empty`（虚线框 + 标题 + 动作）；块内没数据用
  `.empty-inline` 一行提示（不画空壳：没有数据就不占地方）。

## 3. 间距

4px 基距，六档 token：`--space-1/2/3/4/5/6` = 4/8/12/16/20/24（W71 新增 20px
一档）。档位名 = 取值 ÷ 4px，这条恒等式一直成立；页面里不允许出现第七个
间距值，也不要写裸 `padding: 14px`。

**W71 上移一档**：常用间距整体上移（12 → 16、16 → 20），于是 12px 这一档
（`--space-3`）退成「比常用更紧」的例外档，只给表格单元格内边距（否则
行高被顶到 53px）。U3a 起表格内边距按表密度取档：常规表与矩阵 `--space-3`、
`.table--tight` 横向回到 `--space-2`、`.table--dense` 四边 `--space-2`。新增代码
默认从 `--space-4`（16）与 `--space-5`（20）取，不要在常用节奏里随手用 12。

| 语境 | 值 | 载体（正例） |
| --- | --- | --- |
| 页面区块纵距 | 16px（`--space-4`） | `.page` / `.page-body` gap。**例外**：`.content__note`（页头之上那条读取失败横幅）取 20px（`--space-5`）——两处基线在各自片段的块头注释里写明了依据 |
| 卡片 / 分组内边距 | 20px | `--density-pad`（`.panel` / `.group` / `.collapse` / `.card`，W71 起 20） |
| 字段格 | 16px（行 / 列同值） | `.field-grid`（`gap: var(--space-4)`，两列与上下都同一拍）；`.group__body` 的无网格容器仍是 16 |
| 按钮组内 | 8px | `.toolbar` / `.modal__footer` / `.cell-actions` / `.empty__actions` / `.order-item__actions` / `.chat__actions` |
| 卡片行内（统计 / 指标） | 20px | `.stats` / `.metrics` gap（W71 上移一档） |
| 两列 Grid | 20px（表单 / 面板并排）· 16px（路由页） | `.settings-grid` / `.stats-cols`；`.routing-grid`（跟着 `.page-body` 的 16px 走，见「自适应 Grid 与高度同步」） |
| 表格单元格 | 按表密度自定（受控例外） | `.table th/td` 基础档 `--space-3` 四边；`.table--tight`（概览摘要 / 账号页）纵向 12 / 横向 8；`.table--dense`（日志）8px 四边。见「容器」 |

- 按钮组整体靠右用 `margin-left: auto`（正例 `.order-item__actions`、
  `.toolbar__group--end`），不要用等宽 spacer 拼凑。
- `.cell-actions`（表格行内动作组）W59 起是 8px（审计 #3 已关）。新代码一律 8px。
  W85：组内控件统一 28px 高（`.btn--sm` / `.tag--toggle`）——不同高度靠
  `align-items: center` 居中时，眼神看到的基线仍会错开，真正的对齐是盒子等高。
  W99：这条从 keys 页的做法升成**三张表的共同口径**——账号 / API key / 代理的操作列
  都带 `col-actions`（`--layout-actions-col` = 176px），组内只有 28px 的控件。
  操作列**不给宽度就跟内容走**：同一排按钮在三个页面上占的宽度各不相同，
  语言一换列几何又跳一次（这是 W99 之前的实际状态）。

## 4. 表单

**全项目只有一种字段骨架**：`.field-grid` > `.field-cell`——一格 = 标签（在上）+
控件（吃满格）+ 可选说明（控件下）。旧的「标签列在左」两族骨架与其全部变体已在
U3b 删净（清单见「遗留清单」），目录里搜不到它们的类名。表格行内控件没有标签语义，是
**唯一例外**（28px 档，见「容器」）。

```html
<div class="field-grid">                        <!-- 组内两列；弹窗内一列 -->
  <div class="field-cell">                      <!-- 吃宽度的控件：标签在上、控件在下 -->
    <label class="field-cell__label" for="ID">标签</label>
    <input class="field" id="ID" />
    <div class="hint">一句说明（控件下）</div>
  </div>
  <div class="field-cell field-cell--inline">   <!-- 行内小件：标签与控件同一行 -->
    <label class="field-cell__label" for="ID">标签</label>
    <label class="switch"><input class="switch__input" id="ID" /></label>
  </div>
  <div class="field-cell field-cell--span">…</div>   <!-- 跨两列 -->
</div>
```

四条契约：

1. **骨架唯一**：`.field-grid > .field-cell`，标签在上。需要跨行的格子加
   `.field-cell--span`；奇数个字段里落单的那个跨两列（不跨就在右列留一个空格，
   读者会以为少了一个字段）。
2. **对齐**：标签 / 文本 / 控件全部左对齐。数值框 `.field.field--num` 是
   `text-align: left` + `tabular-nums`；它的宽度由值域定（`.field-cell >
   .field--num` 收 10ch，行尾菜单里 4.5rem），**不吃满格子**——吃满两列宽的一根
   数字框只是留白。这条必须写在 `.field-cell > .field { width: 100% }` 之后。
3. **网格**：组内两列等宽 `repeat(2, minmax(0, 1fr))`，列距 `--space-4`；
   `minmax` 的下界必须是 `0`，否则长内容会把整列撑到内容宽、把列距挤没。
   ≤720px 退一列。弹窗宽 560 / 600px，`.modal .field-grid` 收成一列
   （网格仍在，只是列数 1）。
4. **控件高度 36px**（`--control-height`）；表格行内 28px（`--control-height-sm`）
   是**唯一例外**。输入框与下拉的横向内边距同为 12px（`--space-3`），否则文字
   起点错位。

其余约定：

- **行内排**（`.field-cell--inline`）：控件是行内小件——开关 / 按钮 / 链接 /
  只读值。标签与控件同一行（两列网格 `1fr auto`，控件靠右居中），格子的
  `min-height` 就是 `--control-height`，与单行字段同高。说明行跨两列落到下面。
- **说明**：控件下（字段格内），或放容器末尾作为块级说明（账本 / 空态 / 复制结果
  这类「说的是整块」的句子）。不进标签与控件之间。
- **动作行**（账户组的保存 / 退出登录）用 `.field-cell.field-actions`：跨两列、
  按钮靠右、说明占一整行在按钮之上（说明 `flex: 1 1 100%` + `max-width: 100%`
  ——`42ch` 的限宽会让第一颗按钮挤上同一行、第二颗被挤到第三行）。
- **组内横幅**（账户组的改密码结果）用 `.field-grid > .banner`，跨两列。
- **聊天连接区**：`.field-grid chat__settings-grid`（钩子类，样式全来自
  `.field-grid`），四个下拉两列，窄屏一列。
- **日志筛选行**：`.toolbar__group--fields` 里每格是 `.field-cell--inline`，
  标签在控件左侧同一行（筛选条是横排的一排控件，不是两列表单）。
- 一个字段格的高度：标签 21px + 控件 36px + 一行说明 18px ≈ 83px（行内排
  58px），这是整页高度的唯一来源；要把页变矮就减字段数或换排法，不要在格子里
  写死高度。
- 列表型字段（可增删的多个短值）用 chip 列表 `.chips`（W78，目前只有设置页的
  planIds）：外形是一个 `.field`（`min-height: --control-height`），里面是
  `.chip` + 末尾的内嵌输入框；`.chip__remove` 的 ✕ 按「按钮」一节用不绘制的 `::before`
  把命中区扩到 36×36。**不要**再用固定行数的 `<textarea>` 表达列表——
  `rows=3` 在空列表时就是一个大白框。
- 开关 `.switch > .switch__input`：40×22 胶囊，全项目唯一尺寸（W71 从 36×20 上调），
  滑块 18px，半径取 `--radius-lg`（11 = 高度的一半）；行内与输入框同排
  （`min-height: --control-height`）。
- 长只读值（路径 / 指纹）：`.group__readonly` 或 `.hint.hint--clip`（一行截断 +
  `title` 全值，正例 app-view-settings.js `setPathText`），不吃满行伪装成输入框。

## 5. 按钮

- 排布：页面级主操作进 `.page-header__actions`（主按钮放最右）或
  `.toolbar` + `toolbar__group--end`；表格行内多动作收 `.cell-actions`；低频动作
  （启停 / 删除）收 ⋯ 菜单（账号页模式）；行内紧凑组用
  `.order-item__actions`（按钮 `min-width: 0`）。
- **工具栏的分组与换行（W99，日志筛选行）**：`.toolbar` 是 `flex-wrap: wrap` 的
  一排，子元素逐个参与换行——七个筛选器 + 三个动作挤在 1000px 里时，「暂停 / 清空」
  会被挤到第二行最左，与它们作用的那张表隔着一整行空白。所以**需要成组换行的
  内容包一层 `.toolbar__group`**：
  - `.toolbar__group`：组内 `nowrap`，换行只发生在组与组之间；
  - `.toolbar__group--fields`：筛选器组——它是**字段集合**，内部按字段换行；
  - `.toolbar__group--end`：动作组（导出 / 暂停 / 清空，或连接状态 + 暂停 / 清空）
    ——整组不拆，靠 `margin-left: auto` 钉在右缘。**不要用 `.toolbar__spacer`**：
    `flex: 1` 在换行后把第一行吃满，动作组落到第二行最左（W99 修的就是这个）。
  分页动作（页码、排序）将来进工具栏也照这个分。
- **筛选条是固定两行（U10，日志页两个 tab），不靠流式换行决定断点**：
  第一行是筛选下拉（`.toolbar--filters > .toolbar__group--fields`，整行独占、
  各格 `flex: 1 1 0` 等分、`min-width: 0` 允许长选项省略），第二行是搜索框
  （`.toolbar--filters > .toolbar__search`，吃动作组之外的宽度）加动作组
  （`margin-left: auto` 贴右缘）。**搜索框必须留在 `--fields` 组外**：放进组里
  就会跟着下拉一起折行，折点由内容宽度决定——1000px 窗口下「key」占满第一行末尾、
  搜索掉到第二行左端、右边孤零零三个按钮，第二行左边空一大段。格子内部把
  `field-cell--inline` 的网格列钉成「3.5em 标签 + 吃满剩余的控件」：骨架默认的
  `auto` 控件列按内容算，一排下拉的右缘会参差（实测「全部路由」比「全部 key」
  宽 24px）。≤1200px 时下拉按 `calc((100% - 2 * gap) / 3)` 折成三列，六个字段
  就是两行三列，不出现「一行五个 + 一行一个」；1200 这条线是等分下限定的
  （六格在 1025–1200 之间每格只剩 120–140px，扣掉标签与间隙后下拉装不下
  「全部状态」），不是随手取的档位。
- **批量操作条（W76，账号页）**：`.toolbar.bulk-bar` —— `.toolbar` 管间距 / 换行 /
  `toolbar__group`，`.bulk-bar` 只加一层主题色浅底（`--accent-soft` + 
  `--accent-border`）表明「这一排作用于一批行」。它是**一个元素同时挂两类**，不是
  第二层容器（双框禁令不变）。无选择时整条不出现：全局 `[hidden] { display: none
  !important }`（`styles/base.css` 的应用骨架块）**已经压过** `.toolbar` 的
  `display: flex`，组件层不再各写一份 `xxx[hidden]`——新增组件依赖这一条即可。
  数值（并发 / 权重 / 代理）就近放在它的动作按钮前（`.bulk-bar__group`，组内 8px、
  `flex-wrap: nowrap`：窄屏折行时整组一起走，不会把「删除」单独掠在下一行），
  宽度取 `.field--num` 的 4.5rem 档（与 `.menu__field` 同档，值域最多三位数）。
- 点击面积：桌面图标按钮 ≥36px 见方（`--control-height`）；窄屏媒体查询里
  一切可点目标 ≥44px（`--layout-touch-min`）。行内小 ✕（会话删除 / 附件移除）
  W61 起用一层不绘制的 `::before` 把命中区扩到 36×36，字形与盒子尺寸不动
  （`.chat__session-delete` / `.chat__preview-remove`，审计 #4 已关）。新代码
  —— 除了表格行内控件档：`--control-height-sm`（28px，见下一条）。
- **高度档位（W86 校准 + W99 收口）**：默认 `--control-height`（36px）；**表格行内
  的控件一律 `--control-height-sm`（28px）**，这是**唯一**的小档例外。行内按钮只是
  去掉 `.btn` 的 `--layout-btn-min`（64px）最小宽（`.btn--sm`），高度按上一条分档；
  表格行高 45px 装不下 36px 按钮，所以行内档必须有。
  三种**没有小号变体**的行内控件（步进器 / 行内下拉 / ⋯ 触发键）由 `.table` 作用域
  统一给高：`.table .stepper` / `.table .select` / `.table .btn--menu`，
  `.table .stepper__btn` 的方形宽度同步收成 28px。作用域是 `.table` 而不是
  「所有按钮」：表里还有跨整行的动作（`.req__history .btn` 「加载更早」），它属于
  页面级动作，仍是 36px。窄屏那三条是 (0,1,1)，必须在 720 的媒体查询里按同一组
  选择器再压回 44px（写在文件末尾那条）。

变体清单封闭，不许新造：

| 变体 | 场景 |
| --- | --- |
| `.btn`（默认） | 次要动作 |
| `.btn--primary` | 每屏唯一主动作（页面主操作 / 模态确认 / 空态引导） |
| `.btn--danger` | 破坏性直接动作（退出进程、退出登录） |
| `.btn--danger-quiet` | 每行都在的破坏性动作（表格行内删除，W85）：danger 文字 + danger 描边，hover 才铺 danger-soft 底 |
| `.btn--sm` | 表格行内控件档（W85）：28px 高、`min-width: 0`、横向 `--space-2`，只给 `.cell-actions` |
| `.btn--confirm-danger` | 确认模态的确认键（`app-confirm.js` 切换） |
| `.btn--icon` | 36×36 方形图标按钮（聊天附件、顶栏刷新 / 主题；图标 `--icon-sm`）。选择器是 `.btn.btn--icon`（W79）：`.btn` 的 `min-width: --layout-btn-min`（64）写在后面，同优先级会把方形撑成 64×36 的胶囊 |
| `.btn--menu` | ⋯ 行尾菜单触发（36px 方形；在表格行里由 `.table .btn--menu` 收到 28px，W99） |
| `.btn--block` | 全宽（登录提交，唯一使用点） |
| `.btn--jump` | `<a>` 上的跳转按钮：抹掉 UA 下划线、行尾箭头指向目的地（W57 概览「查看统计」，W61 登记） |

## 6. hint

- 控件正下方一行说明：`.hint`（13px / `--faint` / 限宽 42ch）。位置只有两种：
  控件下（字段格内，紧跟控件）、组体末尾的独立说明块。**标签与控件之间不挂
  hint**（W61 把最后几处——账号导入 / 导出、路由心跳抖动、keys 与 proxies 模态
  ——迁到控件列下，审计 #10 已关）。
- 长度一至两句；更长的细节折 `title`（正例：`.hint.hint--clip` +
  `setPathText` 把全路径写进 title）。W61 把功能开关那组（highspeed / mcp /
  async / claim / planIds / drainThreshold）压到一句，细节进
  `data-i18n-attr="title:<key>.detail"`（审计 #9 已关）。
- **常驻与折叠的界线是后果，不是字数**：要一直看得见的用 `.hint`（限宽 42ch，
  一行装不下就折）；只在少数时候要读的用 `.hint-details`。不要按文本宽度自动分档
  ——同一条说明在两种容器里出现两份，改动时必漏一处。
- **设置页的说明按后果分级**：四条常驻 `.hint`（绑定地址、需要 API key、身份归一、
  额度耗尽阈值），其余进 `.hint-details--icon`——空 `<summary>` 的 `title` 与
  `aria-label` 和展开正文 `.__more` 共用同一个 i18n 键，原文只有一份，不按文本宽度
  分档。四种后果型提示里，「需重启」挂标签列 warn 徽章的 `title`；「改完密码其他
  设备登录失效」进保存键的 `title`。常驻与折叠不要混着用：同一个字段上摆一个
  `.hint` 再摆一个 `.hint-details` 就是两份说明。
- 需要「必须一直看得见」的说明不进 `.hint-details`：目前只有端口与绑定地址的
  `data-reload="restart"` 提醒（C 类后果型提示），它用 `.hint.hint--clip`：
  一行截断 + `title` 全句。
- 后果型提示不混用 `.hint`：需重启 = 标签列 `status-badge status-badge--warn`
  徽章 + 行内 `data-reload="restart"` 提示；风险文案 = `.confirm__warn` 或
  `.detail__note`（warn 系但不刺眼）。

## 7. 图表（自绘，无库）

三个图表都出自 `app-charts.js`（唯一绘制点），**色 100% 走 token**
（`page.test.ts` 钉全目录零裸 hex）。它们共用一套框：`.chart__frame` = 左侧值刻度列
（`.chart__scale` + `.chart__tick`）+ 右侧绘图区（`.chart__plot`，`<svg>` 装在里面）。
峰值 / 合计写在框外的 `.chart__meta` 行，每根柱的悬浮提示走 SVG `<title>`。

- **几何**：viewBox 固定 600 宽 + `preserveAspectRatio="none"`（桶数从 24 到 720
  都靠浏览器横向拉伸，JS 不读布局）；高度由调用方传给 `options.height`，写成
  `.chart__frame` 的内联纯几何（概览并发曲线 96px / 概览今日缩略 72px / 统计时序
  160px）。**这是纯几何，不是第五个高度档**：不新增图表高度 token（旧
  `--layout-chart-height` 已随 flex 柱一起退场）。
- **柱形**：堆叠柱 `.tokchart__in` = `--accent-border`（入）、`.tokchart__out` =
  `--accent`（出）；单系柱 `.tokchart__bar` = `--accent-border`、峰值
  `.tokchart__bar--peak` = `--accent`。缝隙比 0.3、单柱有 24 单位的上限（桶很少时
  居中，不变成一堵色墙）、**柱顶 2px 圆角只画在顶段**（底段仍是方角，圆了会漏缝）。
- **网格线（W57）**：水平刻度线由 SVG `<line>` 画（`.tokchart__grid` =
  `--line-soft` + `shape-rendering: crispEdges`，只给线不给柱）；基线（0）由
  `.chart__plot` 的下边框画（SVG 里 y=height 的线会被视口边缘裁掉一半）。刻度取
  「把峰值包进 3–4 段的整值」（1/2/5 阶梯），图中总有 2–3 条内部横线且每条在左侧
  刻度列有对应数值。旧口径「无网格线、无坐标轴文字」已被 W57 取代——文字仍不进
  SVG（非等比拉伸会把字拉变形），只在刻度列里用 HTML 定位。
- **值刻度（W71 随字号重算）**：`.chart__tick` 用 `--text-micro`（13px），
  `.chart__scale` 列宽 `--layout-chart-scale` = 56px（最长刻度「12.5万」≈ 44px +
  8px 间隔），三张图的绘图区起点因此仍是同一条竖线。刻度用 `bottom` 百分比贴在
  对应网格线上——标签与线共用同一套百分比，两边永不错位。
- **热力图 `.heatmap`（W111 对齐官方 BigModel 特写）**：tab（`.heatmap__tabs`
  三档聚合粒度：每日 = 日格、每周 = 周格聚合、累计 = 总量分档，选中态胶囊
  `.heatmap__tab--active`）+ 格子缸 `.heatmap__grid` + 底部月轴 `.heatmap__months`
  + 悬停 tooltip `.heatmap__tip`）。网格周为列、**周一起算** 7 行（W111 从周日
  改周一，跟官方一致），列数按时间范围算满、列宽 `minmax(12px, 1fr)` **撑满
  容器**——W111 修的旧病根：格子固定 12px 居中，53 列铺不满宽卡，右侧留白。
  窄屏 12px 保底 + 外层横滚。列模板（JS 写 inline，纯几何值）格子缸与月轴
  同值，标签才对得齐各月首周列。卡片内边距 16px（`.heatmap-panel`）。
- **色阶按粒度分档（W111）**：`app-view-stats.js::HEATMAP_TIERS` 三套阈值——
  每日 = 绝对档 100 万 / 500 万 / 2000 万（W82 口径沿用：量级分档跨时间可比，
  不看窗口峰值），每周 = 日档 × 7，累计 = **占区间总量的份额**档（25% / 50% /
  75%，累计值单调涨到总量，绝对档会把左半边全压浅档）。每套 5 档：0 = l0。
- **色值走 `--heat-0..4`（tokens.css）**：官方蓝色系（浅灰零档 → 深蓝顶档，采样
  自官方热力图），只给热力图格子（本节），不得外溢。l0 与 void 是两件事：
  `--heat-0` 是「存在但没有用量」，`.heatmap__cell--void` = 透明（首列前的空位 /
  最后一周补齐的尾格 = 「不存在的日子」）。
- **tooltip（`.heatmap__tip`）是悬停浮层不是 title**：第一行日期、第二行
  「Tokens 消耗 X | MCP 消耗 Y次」。Tokens 用 `fmtMB`（M/B 两位小数不 trim，
  官方就是 58.65M 这个格式，不走中文万/亿）；MCP 次数来自数据层 `stats.heatmap`
  格值（`/mcp` 端点请求归因，usage-stats.ts::isMcpRecord）。格子不带 title——
  原生 tooltip 会跟浮层双弹。浮层开合走 hidden（见「浮层」的浮层纪律），`pointer-events:
  none` 不挡 hover。
- 错误横条 `.hbar`：名 + 轨 8px + 次数三列网格（名字列吃到 42ch 上限、轨占中间
  `1fr`、次数贴右缘——这一块只占半幅面板，名字列按整幅宽的老值定死会把中文 hint
  折出单字成行）；fill = `--danger`（danger 系只给失败）。**一个方向只剩一种分类时
  不画条**（W98 S-2，`.hbar--single`）：`count / max` 恒等于 1，满宽红条没有对比
  对象，改成「名 × 次数」的一行文本，名字列吃满剩余宽。
- 图例色块与柱子必须同组类（`.legend__swatch--in` / `--out`），不许各写一份色值。
- 空态：图表容器 hidden，位置只留 `.empty-inline` 一行；「加载中 / 失败 / 真的
  没有数据」三种空各说各的话（正例 app-view-overview.js renderUsageChart）。

## 8. 浮层

- 宽档（W81 起五档），新浮层从现有档里选，不造第六档：

| 浮层 | 宽 | 类 |
| --- | --- | --- |
| 标准模态 | `min(var(--layout-modal-width), 92vw)` = 560px | `.modal` |
| 二次确认 | `min(var(--layout-confirm-width), 92vw)` = 420px | `.modal.confirm` |
| 表单型模态（W81） | `min(var(--layout-modal-md), 92vw)` = 600px | `.modal.modal--md` |
| 账号详情大窗（W75） | `min(var(--layout-modal-lg), 92vw)` = 920px | `.modal.modal--lg` |
| 登录卡 | `var(--layout-login-width)` = 360px | `.login-card` |

- 五档全部走 `--layout-*` token（W61 把 560 / 440 两个裸值收上来，审计 #14 已关；
  W81 把添加账号从标准档拆出来单独一档）：改宽改 token，不在选择器里写新裸值。
  **「表单型」的判据是行结构与宽度需求**，不是“觉得窄”：添加账号是唯一一个四 tab ×
  两列表单的浮层，560px 下标签列 + 列距吃掉三成，控件列只剩 312px，路径预览会被
  挤成两行。600px 配 100px 标签列后控件列 444px。
- **披露式小浮层（W76 登记）**：行尾 ⋯ 菜单与账号页的**调度权重浮层**都是
  `[data-menu-cell]` 里的 `.menu`（`position: absolute`，不是 `position: fixed`），
  所以不在这五档宽度表里：它们不是模态，不接管焦点、不锁底层滚动。
  调度权重浮层只多两行说明，用 `.share-pop` 把 `.menu` 的 `min-width` 从 176 调到
  232px（否则口径说明折成四行），说明行是 `.menu__note` / `--quiet`（13px /
  `--faint` / 限宽 26ch，同「hint」一节的约定）。两者共用 `closeMenus()` 收口，
  **同一时刻只开一个**；调度权重浮层的弹开状态记在视图模块里（`openShareLabel`），
  因为浮层里的步进器每点一下都要回读一次、整表重画之后它必须还在。
- 圆角 11px（`--radius-lg`）是浮层（模态 / 登录卡）专用档；开关胶囊因「高度
  的一半」几何共用它（22px 高 → 11px 角），不是第五个视觉档位（W71：高度
  20 → 22，这一档跟着 10 → 11）。
- 遮罩只有一套：`.modal-scrim`（`position: fixed` + `inset: 0`，`--panel-alt`
  @ 0.85）。抽屉的遮罩（`drawer-scrim`，已删除）随 W75 一起退场；`.toast` 不带遮罩
  （见末条）。
  浮层分三档层级（`tokens.css` 的 `--layer-drawer: 1` / `--layer-modal: 2` /
  `--layer-popover: 30`）：
  - **抽屉**（`.modal--lg[data-dialog="proxies"]`）压最低一档。它是从页面里展开的
    管理面，排在弹窗之后（要压在账号表那一层），所以不能再靠文档序决定谁盖谁；
  - **弹窗 / 确认框 / 登录卡 / 撤销条**同一档（`--layer-modal`）。它们互为「同一个
    动作的确认面」，谁提示谁就排在后面：确认框排在大窗与抽屉之后，弹窗排在抽屉之后
    （否则抽屉里点「添加代理」打开的弹窗会被抽屉盖住——截图 #111）；
  - **披露式浮层**（`.menu--fixed`）最高一档，要盖过表格自己的层叠上下文。
  层级只管「叠」，不管「开」：Esc 按打开的先后倒着退，一次一层
  （`app-widgets.js` 的 `closeTopDialog`，在 window 捕获阶段接并掐掉冒泡）。
- 大窗（`.modal--lg`）的横向断点与正文的滚动分工：壳 `overflow: hidden` +
  `.modal__body` 自己滚（头部标题 / 类型 / 刷新 / 关闭始终可见），`max-height: 86vh`；
  ≤900px 退成全屏模态（`inset: 0`、无圆角、无边框），与 `.plan-cards` 的双列
  → 单列同一个断点。
- Esc / 遮罩关闭 / 焦点管理在 `app-widgets.js`（`Dialog`，W75 由 `Drawer` 改名——
  投影从 `data-drawer-open` 换成 `hidden`；Esc 一次退一层，见 `closeTopDialog`）
  与 `app-confirm.js`（确认模态）；视图只调 `App.widgets.dialog.open/close`，
  不自己写 overlay。**从浮层里打开的弹窗也要登记成 dialog**（出口代理抽屉里的
  「添加代理」用 `data-dialog="proxies-form"`），否则 Esc 认不出叠在谁上面。
- 打开浮层的**来源元素必须可聚焦**（W75 的教训）：大窗关掉时把焦点还给来源，
  而账号表的行是 `<tr>`（不可聚焦），所以额度格写成了真 `<button>`——它既是键盘
  用户的唯一入口，也让「焦点还回去」有着落点。新增打开浮层的入口照此办理。
- **撤销条 `.toast`（W79 登记，第四类浮层）**：底部居中的一条「一句话 + 一个
  动作」，目前只有会话删除的 5 秒撤销。它是最轻的一类浮层，三条约束与模态相反：
  不遮罩、不锁底层滚动、**不抢焦点**（键盘用户靠 Tab 到动作键即可，条子弹出时
  不移动焦点）——所以它不进滚动锁的 `:has(...)` 名单，只共用 `--shadow-panel`
  与 `--radius-md`。开合投影照旧是 `hidden`（与其余浮层同一条规矩），文案一行
  截断。**行为在 `App.widgets.toast`**（`show` / `hide`），视图不自己写 overlay、
  不自己拿定时器：超时只收起条子、**不代跑动作**，但会回一个 `onExpire` 给调用方
  （聊天页靠它把撤销窗口内暂缓的图片清理补上）；被下一条顶掉时不回调，由调用方
  先收口。z-index 与模态同层（2），文档序在模态之后。
- 二次确认一律模态（`.confirm`），禁止原生 `confirm()`（危险动作用的护栏）。

## 9. 自适应 Grid 与高度同步

| 块 | 形态 | gap | 断点 | 高度 |
| --- | --- | --- | --- | --- |
| `.settings-grid` | 2 × minmax(0,1fr)（主区：连接 + 服务） | 20px | ≤1023 单列 | `align-items: stretch`（两张组卡等高）；账户组、高级区、页脚是 `.page-body` 里各自独立的层，不在网格里 |
| `.routing-grid`（W77） | 2 × minmax(0,1fr) | 16px | ≤1023 单列 | `align-items: start` + `flex: 0 0 auto`（flow 页的 `.page-body` 是 flex 列，不钉住会被压缩） |
| `.field-grid`（原 W78 设置页，U3b 起全项目唯一） | 2 × minmax(0,1fr)；弹窗内 1 列；整张网格上限 620px | 16px | ≤720 单列 | `align-items: start`（字段格只占自己内容高） |
| `.stats-cols` | 2 × minmax(0,1fr) | 20px | ≤900 单列 | 默认 `stretch`（W57 摘掉 `start`：左右两列等高）。统计页下半部分的两列对：左列整高放错误分析，右列 `.stats-side` 竖叠调度事件与缓存命中率 |
| `.chat__layout` | minmax(200px,260px) + minmax(0,1fr)；行 `minmax(0,1fr)` | 20px | ≤1024 会话栏折进顶部下拉 | `align-items: stretch`（会话栏与右侧同高，列表内滚 `min-height:0; overflow-y:auto`） |
| `.metrics` | 4 × minmax(0, min(320px, 100%)) | 20px | ≤900 两列、≤600 一列 | 内容撑高 |
| `.chat__settings-grid`（W79，U3b 起只是钩子） | 同 `.field-grid`（2 × minmax(0,1fr)） | 16px | ≤720 单列 | 样式全部来自 `.field-grid` |
| `.plan-cards`（W75，账号详情大窗内的套餐卡） | 2 × minmax(0,1fr) | 12px | ≤900 单列 | 内容撑高（一张卡 = 一套餐） |

- 断点全景（W86 去重后只剩五档，其中 1024 这一档在代码里有两种写法）：
  **1440**（W99 起：请求表 **≤1440** 折叠三列）/
  **1023**（`.settings-grid`、`.routing-grid` 单列）/ **1024**（聊天双栏折行）/ **900**
  （`.stats-cols`、`.metrics`、`.plan-cards`、`.modal--lg` 全屏）/ **720**（侧栏→tabbar、
  触摸目标 44px、`.field-grid` 单列）/ **600**
  （`.metrics` 一列）。新增两列块先查这张表再选断点：表单分组类与「双栏 + 主内容」
  取 1024 这条界线，面板并排取 900，不引入第三个值（审计 #13 已关）。
  1023 与 1024 是**同一条界线的两种写法**（`max-width: 1023px` 与 `max-width:
  1024px` 只差 1px），不是两个断点：`settings-grid` / `routing-grid` 折在 ≤1023，
  聊天双栏折在 ≤1024，两处都是「小于 1024 就折」。改一处时不要把另一个页带过去。
- **1440 这条界线只用于请求表**：`max-width: 1440px` 让十四列请求表把缓存 / 推理强度 /
  重试三列折叠进展开行（`.req__col--extra`），表格回到十一列。展开行 /
  「加载更早」行的 `colSpan` 由 `requestColumnSpan()` 按同一条媒体查询算
  （`C.REQUEST_FOLD_MEDIA`，与 CSS 逐字同值）——**不要**继续写死十四列靠浏览器
  截断余量。折叠掉的列不是丢数据：值在展开行的 `.req__meta` 里逐项给出。
- **基础规则写在断点之前**（W77 踩过一次）：同优先级下后写的生效，把两列的基础
  规则放在 `@media (max-width: 1023px)` 之后，断点里的单列会被它盖回去——
  1000px 窗口仍是两列，`page.test.ts` 现在钉住这条先后关系。
- 「侧栏 + 主内容」高度约定：内容驱动高度的并排块用 `start`（各占内容高）；
  有内滚的框体用 `stretch` + 内部滚动——滚动发生在框体内部，框体高度不随
  内容变（正例 `.chat__session-list`，与日志流同一条取舍）。
- **聊天会话栏的等宽纪律（W79）**：新建按钮与会话项必须**完全等宽**。做法不是
  调 padding，而是让两者共用一个内容框——会话列表自己就是滚动容器
  （`flex: 1 1 auto; min-height: 0; overflow-y: auto`），按钮搬进这一层、包在
  一个 sticky 槽位（`.chat__new-slot`）里。按钮曾是列表的**兄弟节点**，滚动条
  一出现就比列表项宽出一个滚动条宽（实测 15px）；搬进容器后两者被同一个滚动条
  一起收窄。槽位带不透明背景与 4px 下留白，滚上来的会话项在那条线上被整齐
  剪掉。`renderSessions` 只清 `.chat__session-items`（`data-role="chat-session-items"`），
  静态按钮不跟着消失；按钮写 `flex: 0 0 auto`，否则项一多它会被弹性压缩
  （实测 36 → 29px）。
- 窄屏（≤720px）纪律：侧栏退场换底部 tab；`.field-grid` 转单列（标签本来就在
  控件上方，骨架不变）；触摸目标升 44px。
- **设置页主区固定两列**：`.settings-grid` 不再按窗口宽度切三列，也不写
  `grid-template-areas`。四层（主区 / 账户 / 高级 / 页脚）在 `.page-body` 里按文档
  顺序排，共吃同一条内容列；字段格自己的 620px 上限保证超宽屏下控件仍有可读
  宽度，不靠页面级截宽。把五组塞进一张自动排布的网格时，跨两列的那组会把后面
  推到下一行、前面留空洞，固定两列就没有这个折点。

## 10. 消费方式（后续批怎么用本文）

- 改样式先对照对应小节的正例 class 组合；新增容器嵌套、按钮变体、浮层宽档、
  间距档，必须先在本文登记例外，不允许只改 CSS。
- 离群审计清单（不入库的临时产物）按 # 编号引用本文条款；修一条勾一条，
  修完的条目从清单移除、必要时把它的正例回填进本文。W56 那份 14 条在 W61
  全部关闭（每条的去向已回填到对应小节），清单只剩历史价值。
- token / 组件两层的事实问题（取值、对比度、深浅色）以 tokens.css /
  `styles/*` 的注释为准，本文与其冲突时先改本文。
- 新增页面/视图时先答「页面布局协议」的判据（fill 还是 flow），再写 `.page` 壳；漏了
  `.page-body` 或搞错模式，后面所有间距/滚动讨论都落不到实处。
- **本文的正例 class 必须在代码里真实存在**（W86 立的门禁）：本文提到一个类就必须
  在 `styles/*` 里有规则、或在 `views/*.html` / `page.html` / `app-*.js` 里真的拼出来。
  核对是一行命令：`grep -oE '\.[a-z][a-z0-9_-]*' src/server/web/AGENTS.md | sort -u`
  取名单，逐个在 `styles/*` 里查。动态拼出来的类（`quota-pct--` + tone、
  `req__source-dot--` + 下标、`log__level--` + 级别）以族名登记。
  本文里不应该再出现「已删除的类」作为正例——历史去向写在条目里，不写 class。

## 11. 顶栏刷新协议（W72）

**一颗图标按钮，语义是「刷新当前视图的数据」。** 顶栏右侧 `.appbar__actions`
里全是它（图标 `refresh-cw`，与主题图标同一颗 `--layout-icon` / 2px 描边），
按 `state.activeView` 派发到视图模块的 `refresh()`。

| 视图 | `refresh()` 做什么 |
| --- | --- |
| 概览 | `/api/state` + `getUsageStats`（今日，绕过 60s 节流） |
| 统计 | 当前范围重拉 `getUsageStats`（连热力图） |
| 聊天 | 无服务端数据 → 置灰（`disabled` + title「当前页面无需刷新」） |
| 账号 | `/api/state` 重拉 + `quota`（带 `labels` / `focusedLabel`）分级采（详情账号必采 / stale 补采 / 新鲜不采 / 30s 去重）；详情大窗头部那个「刷新」是已登记的页内例外，走 `label` 必采路径 |
| 路由策略 | `/api/state` 重拉 |
| ~~代理~~（视图已退场） | 字典挂在账号页抽屉里：开抽屉时 `listProxies` 重拉；账号页进页面时也取一次（代理列 / 批量条下拉要它） |
| API key | `listApiKeys` 重拉 |
| 设置 | `/api/settings` 重读 |
| 日志 | 请求事件 tab → `getRequests` 重拉；系统 tab → 置灰（SSE 实时） |

约定：

- **视图模块各自暴露 `refresh()`**（返回 Promise 或 `null`），需要按页内状态变的
  再暴露 `canRefresh()`（日志页：tab 决定）。`app-refresh.js` 只派发与写按钮
  状态，不碰取数；`app.js` 在 `showView` 与日志 tab 切换后调 `App.refresh.sync()`。
- **新增视图**：在自己的 `app-view-*.js` 里加 `refresh()` 就自动接上，
  不需要改顶栏或映射表。没有服务端数据的视图**不要**加一个什么都不做的
  `refresh()` —— 没有它就自然置灰。
- **在途态**：图标转圈（`.appbar__refresh-icon--spinning`，一圈 `--motion-fast`，
  `prefers-reduced-motion` 下不转），完成后 800ms 复位；在途时 `aria-busy`。
- **提示文案**：`title` / `aria-label` 由 `App.refresh.sync()` 写（`refresh.title` /
  `refresh.disabled`），语言切换后重写一次（`app-i18n.js` 的 `applyLanguage`）。
- **快捷键**：`R` 与点击同一条路（输入框 / 文本域 / 下拉 / contenteditable 内
  不接，带修饰键不接）。
- **页内不要再放刷新入口**：W72 删掉了统计页范围栏的「刷新」与设置页页头的
  「重新读取」。新增「重取一次」的需求先看能不能走这条：走不了就在本文登记例外。

## 12. 变体登记（W69–W99 新增的类）

本文各节讲形态，这一节是**索引**：W69–W99 二十来批新增的类都落在下表里，一个不
漏。新增类时先在这里加一行（类 + 批次 + 一句话职责 + 归哪一节），再去 CSS 里写规则
——不允许只在 CSS 里出现、规范里查不到。

| 类 | 批次 | 是什么 | 归哪节 |
| --- | --- | --- | --- |
| `.page-header` / `__heading` / `__desc` / `__actions` | W70 | 页头（标题 + 一句说明 + 右侧全局动作），八个视图统一 | 页面布局协议 |
| `.page-body--fill` / `.fill-chain` / `.fill-region` | W70 | fill 模式的高度接力：中间层只传高度，最后一块滚 | 页面布局协议 |
| `.table--dense` | W71 | 密集表唯一钩子（13px / 8px 内边距），判据是列数 ≥10 或两行塔配 | 容器 |
| `.table--tight` | U3a | 多列常规表的紧档（纵向 12 / 横向 8）：概览账号摘要 6 列、账号页 9 列——12px 横向在 1000px 视口下会把概览摘要表顶出面板 | 容器 |
| `.log-panel` | W70 | 日志框体（`.panel` + `.fill-chain` 复合），空态时居中 | 页面布局协议 / 容器 |
| `.chat__panel` | W70 / W79 | 聊天框体（同上），三块里只有消息区伸缩，空态可让步 | 页面布局协议 / 容器 |
| `.quota-cell`（`__line` / `__kind` / `__amount` / `__more`、`--open`、`--empty`） | W75 | 账号表额度列的按钮格（打开详情大窗的键盘入口） | 容器 |
| `.share__value` | W76 | 账号表调度权重列的按钮（主题色 + 等宽数字，无下划线） | 容器 |
| `.share-pop` | W76 | 调度权重浮层（`.menu` 加宽到 232px，多两行口径说明） | 浮层 |
| `.bulk-bar`（`__count` / `__group`） | W76 | 批量操作条：`.toolbar` + 主题色浅底，一个元素两个类 | 按钮 |
| `.routing-grid`（`__span`） | W77 | 路由页两列网格，两块整行跨列 | 自适应 Grid |
| ~~旧「并排字段」骨架~~ | W77 → U3b 删除 | 组内并排字段，已并入 `.field-grid` / `.field-cell`（跨列用 `.field-cell--span`） | — |
| `.field-grid` / `.field-cell`（`--inline`、`--span`、`__label`）/ `.field-actions` | W78 / U3b | 全项目唯一字段骨架（上下排 / 行内排 / 跨列 / 动作行） | 表单 |
| `.hint-details`（`--icon` / `__more`） | W78 / U2 | 后果型说明折进 ⓘ：空 `<summary>` + 展开正文，与 `title` 共用同一份文案 | hint |
| `.chips` / `.chip` / `.chip__remove` | W78 | 列表型字段（`planIds`），外形是一个 `.field` | 表单 |
| `.settings-meta` | W78 | 页级只读信息行（环境变量优先级 + 配置文件落点） | 间距（gap 4 / 12） |
| `.chat__settings-grid` / `.chat__keymanual` | W79 | 聊天连接区四字段网格（标签列 64px）+ 手动粘贴行跨两列 | 表单 / 自适应 Grid |
| `.chat__new-slot` / `.chat__session-items` | W79 | 会话栏等宽纪律（按钮搬进滚动容器 + sticky 槽位） | 自适应 Grid |
| `.toast`（`__text` / `__action`） | W79 | 撤销条，第四类浮层（不遮罩 / 不锁滚 / 不抢焦点） | 浮层 |
| `.modal--md` | W81 | 表单型模态 600px（添加账号：四 tab × 单列字段格） | 浮层 |
| `.modal--lg` | W75 | 账号详情大窗 920px（壳不滚、体滚，≤900 全屏） | 浮层 |
| `.plan-cards` / `.plan-card`（`__head` / `__name` / `__meta` / `__buckets` / `__bucket`（`__bucket-label` / `__bucket-amount` / `__bucket-reset`、`--expired`）/ `__windows` / `__window` / `__window-label` / `__window-pct` / `__window-reset`、`--expired`） | W75 / W110 | 套餐卡：一卡一 plan（plan_id 分组，W110 模型桶行），双列，窄屏单列 | 自适应 Grid |
| `.plan-groups` / `.plan-group`（`__title`） | W95-P2 | 套餐段体系分区：体验/编程并存时各带小标题（官方词），单体系退回 `.plan-cards` 平铺 | 自适应 Grid |
| `.plan-card__subscription`（`__line`） | W115 | 订阅卡的产品信息行（个人/团队、续期、到期、计费周期）；窗口行不变，产品未采到时一行诚实说明 | 自适应 Grid |
| `.heatmap-panel` / `.heatmap__months` / `.heatmap__grid` / `.heatmap__cell--void` | W82 / W111 | 热力图版式（月轴与格子同一列模板）+ 占位格；W111 月轴移到底部、行序改周一起算 | 图表 |
| `.heatmap__tabs` / `.heatmap__tab`（`--active`） | W111 | 热力图粒度 tab（每日 / 每周 / 累计），选中态胶囊 | 图表 |
| `.heatmap__grid--flat` | W111 | 周格聚合视图的单行网格（每周 tab 一格一周） | 图表 |
| `.heatmap__tip`（`__date` / `__label` / `__value` / `__sep`） | W111 | 热力图悬停 tooltip 浮层（日期 + Tokens/MCP 两行），hidden 开合 | 图表 / 浮层 |
| `.hbar--single` | W98 | 单分类错误行：名 × 次数文本（不画横条） | 图表 |
| `.stats-side` | 统计页改半幅版式 | 统计页两列的右列：纯布局容器（竖叠调度事件与缓存命中率，无边框 / 背景 / 内边距） | 容器 / 自适应 Grid |
| `.req__source-dot`（`--1..6`）+ `--identity-1..6` | W80 | 日志「来源」列的六色身份盘（标识色，不随主题翻转） | 容器 |
| `.log__kv--key` / `.log__kv--val` / `.log__line--plain` | W80 | 日志正文的键值分层与整段原文行 | 容器 |
| `.table-scroll` | W70 | fill 页表格的滚动框（框体不滚，里面滚） | 容器 |
| `.btn--confirm-danger` | W61 | 确认模态的确认键（危险动作） | 按钮 |
| `.toolbar__group`（`--fields` / `--end`） | W99 | 工具栏分组：组内 nowrap，换行只发生在组之间；`--end` 靠 `margin-left: auto` 钉右缘 | 按钮 |
| `.toolbar--filters` / `.toolbar__search` | U10 | 日志页筛选条固定两行：下拉整行等分、搜索与动作在第二行；≤1200 下拉折三列 | 按钮 |
| `.col-actions` | W85 / W99 | 表格操作列的定宽钩子（`--layout-actions-col` = 176px），账号 / keys / 代理三张表共用 | 间距 |
| `.req__col--extra` | W99 | 请求表 ≤1440 折叠的三列（缓存 / 推理强度 / 重试），值进展开行的 `.req__meta` | 容器 / 自适应 Grid |
| `.transfer-row` | W100 | 导入 / 导出两行的首件控件（选择文件 / 格式下拉）同档定宽，密码框起点对齐 | 表单 |
| `.req__time` / `.req__tps` | W100 | 日志请求表的时间列与速率列（只加 tabular-nums，字号与内边距仍由 `.table--dense` 定） | 容器 |
| `.key-cell`（`__value`） | W102 | keys 页 Key 列的格内组（掩码值 + 显示 / 复制两颗 28px 按钮，与 `.cell-actions` 同口径但不是它的类）；`__value` 放开 `overflow-wrap: anywhere` 让 50 字符的完整 key 能折行 | 容器 |
| `.matrix__account-head` / `__type-head` / `__account` / `__type` / `__kind` / `__route-head` / `__route` | W114 / W114-P3 | 路由矩阵身份格、凭据出身小字与单元格文本居中的路由表头/✓ 格，两行塔配复用 `.cell-stack` | 容器 |

## 13. 遗留清单（W86 对账 + W101 补记）

以下几条是核对时**明确不做**的，别当成规范遗漏；动手前先在任务里认领。

| 遗留 | 现状 | 为什么留着 |
| --- | --- | --- |
| ~~`runtime.test.ts` 拆分~~ **W89 已做** | 按视图拆成 `runtime-{chat,accounts,account-actions,account-modals,logs,settings,routing,overview,keys,shell}.test.ts` + 共享脚手架 `runtime-harness.ts`；`runtime.test.ts` 只剩跨视图的视图切换用例。原来是 8763 行 / 63 个 describe / 单文件 3.39 GB | 纯机械搬移，混在 UI 批里只会让 review 读不到行为差异，所以单独一批 |
| 二进制文件上传 | `accept` 只列图片与文本类扩展名，其余在 `attachOne` 里统一拒绝 | 上游多模态契约只覆盖图片；拒绝比默默传一个读不了的文件好 |
| W83 计划的「hint ≤40 字 / >40 字折 ⓘ」 | 按字数分档没落地，U2 按后果分级落了 ⓘ：四条常驻 `.hint`，其余 `.hint-details--icon`（见「hint」） | 分档依据是后果，不是文本宽度；ⓘ 与 `<details>` 的箭头是两种展开语义，别并存 |
| ~~W85 计划的 28px 行内按钮档~~ **W99 已做** | `--control-height-sm` 从 keys 页的三件套扩成**所有表格行内控件**（`.btn--sm` / `.tag--toggle` / 步进器 / 行内下拉 / ⋯），见「字号 / 行高 / 尺寸基线」与「按钮」 | 当时只落在 keys 页，三张表的行内控件高度不一；W99 收口并同步 AGENTS |
| `.detail__head` / `.detail__title` | CSS 里有规则、DOM 里已经没人拼（W75 换成 `.plan-card` 之后） | 死样式，归 W87 的清理批；本文不把它们当正例引用 |
| `--density-medium-*` / `--density-compact-*` 与 `comfortable` 三档同值 | 三档都是 radius 8 / pad 20（`dense` 只是类名，值不变） | 类名是给将来分页调密度留的钩子，删了以后要重加（见「页面布局协议」） |
| ~~旧字段骨架两族 / 定宽标签列~~ **U3b 已删** | 「标签列在左」的一行一字段骨架（基础 + 6 个变体）、「并排字段」骨架（基础 + 5 个变体）、弹窗与工具栏里的对应覆盖、窄屏里对应的覆盖，以及 `--layout-label` / `--layout-policy-label` / `--layout-chat-label` / `--layout-modal-label` 四个 token 全部删除 | 收编成 `.field-grid > .field-cell` 一种骨架（见「表单」）；旧骨架各带一套定宽标签列，正是控件起点逐行漂的来源 |
