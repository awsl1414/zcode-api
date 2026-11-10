# src/server/web/ — 面板骨架契约

> 改 `views/*.html`、`styles/*`、`tokens.css` 或视图 DOM 前先读本文件。术语表、变体登记、遗留
> 清单、跨片段依赖表、hint / 图表 / 浮层细则见
> [docs/design/web-skeleton-contract.md](../../../docs/design/web-skeleton-contract.md)。

只管形态；取值只在 `tokens.css`，组件形态只在 `styles/*`；页面与运行时只引用 `var(--…)`，裸值
仅限纯几何，`page.test.ts` 钉零裸 hex、零裸字号。

## 片段布局

- `page.ts` 的 `COMPONENT_CSS_PARTS` / `PAGE_HTML_PARTS` 拼接样式与骨架，**数组顺序即 CSS 层
  叠与 DOM 顺序**；调序不报错、只静默换一套样式。登录页另有 `login.html`，不参与数组。
- 片段间有真实层叠依赖（后压前）。新增片段先回答「压谁、被谁压」：用带作用域的高特异性
  选择器，或插到正确位置。
- `page.test.ts` 要求产物与按序读到的片段逐字节相同，并钉数组与模块顺序。代码注释里的
  `AGENTS.md` 指本文件；不带路径的「骨架规范」「容器规范」等提法指参考层
  [web-skeleton-contract.md](../../../docs/design/web-skeleton-contract.md)。

## 布局协议：一个壳 + 两种滚动模式

**判据：核心交互区是否需要始终可见？是 → `fill`；否 → `flow`（默认）。** 聊天与日志是 fill，
其余全 flow；拿不准选 flow。整页不滚：`html.app-root` 钉成视口高度，滚动只发生在视图的
`.page-body` 里。每个视图 = `.page.<密度档>`（带 `data-view` 的元素），里面只放页头与正文。

```html
<div class="page dense" data-view="logs" hidden>
  <header class="page-header"><div class="page-header__heading">…</div><div class="page-header__actions">…</div></header>
  <div class="page-body">…正文…</div>
</div>
```

- 页头正例：`.page-header` > `.page-header__heading`（`.page-title` + `.page-header__desc`）+
  `.page-header__actions`；过滤器行留在 `.page-body` 顶部第一层。正文顺序 标题 → 工具栏 → 横幅
  → 内容，间隔 `--space-4`。
- fill：`.page-body--fill` 不滚，`.fill-chain` 只传高度，真正滚的写 `.fill-region`（如
  `.panel.fill-chain.log-panel > .log.fill-region`）；网格中间层写
  `grid-template-rows: minmax(0, 1fr)`。每层都要 `min-height: 0`，漏一层固定块就被顶出。
- `.page`、页头、正文、面板、表格与 `.content__note` 吃满 `.content` 的可用宽，
  共用一条右边界；gutter 由 `--layout-content-gutter` 同时给 `.content` 与顶栏。
  锚点左对齐，**不写 `margin: 0 auto`**；不再按视图切换页面宽度。
  `.page-header__actions` 的 `margin-left: auto` 以这条内容列为参照，右缘与顶栏
  刷新 / 主题 / 语言所在的 gutter 对齐。限宽下沉到组件：指标卡、字段格、图表、
  长表格与聊天输入区各守自己的可读上限，取值在 `tokens.css`；热力图格子沿面板铺满。
- 禁止：`position: fixed` 给页面块打补丁（只有真浮层能 fixed：`.modal-scrim`、`.modal` /
  `.modal--lg` / `.login-card`、`.toast`）；`100vh` / `calc(100vh - Npx)`；在 `.page-body` 里
  再套纵向滚动。浮层开合统一投影成 `hidden`，`:has(.modal:not([hidden]))` 自动锁底层滚动；全局
  `[hidden] { display: none !important }` 已压过组件 `display`。

## 容器与表格

- `.panel` / `.group` / `.collapse` / `.card` = 1px `--line` + `--radius-md`（8px）+ 20px 内边
  距。双层框禁令：`.panel > .card`、`.group > .group`、panel 套 panel 禁止；合法嵌套行框体只
  有 `.order-item`、`.chat__session`、`.empty`。纯布局容器（不画边框 / 背景 / 内边距 / 阴
  影）不算一层框；类名要带用途，不用 col / wrapper 这类通用名。
- 表格不画单元格框，`.table th, td` 只有横向分隔线；`width: 100%` 铺满，禁止 `width: auto` /
  `margin: 0 auto`。对齐只由 `.table th/td` 给，逐表禁止再写；`text-align` 管不到 flex 盒，
  `.cell-stack` / `.cell-actions` / `.key-cell` / `.quota-cell` / `.usage-tower` /
  `.share__value` 各自显式居中。
- 内边距按密度选档：`.table--dense`（列数 ≥10 或并排两行数字）`--space-2` 四边；`.table--tight`
  （概览摘要、账号页）纵向 `--space-3`、横向 `--space-2`；其余 `--space-3`。**新表不加全局统一
  padding。** `.table--dense` 是唯一允许覆盖表格字号与内边距的钩子。
- 横向溢出由 `.panel:has(> .table)` 自己滚。fill 页框体 `.log-panel` / `.chat__panel` 是
  `.panel` + `.fill-chain` 复合体（一个元素两个类），必须是 flex 列，只剩空态时居中。空态两级：
  整页没内容用 `.empty`，块内没数据用 `.empty-inline`。
- 阴影：`.group` / `.collapse` 无，`.card` 用 `--shadow-card`，`--shadow-panel` 只给模态 / 登录
  卡。语义色只有 ok / danger / muted + warn / pending；例外只给额度条（`.meter__fill--*` /
  `.quota-pct--*`）与 `.status-badge--accent`（标识色，不标状态）。

## 间距、表单与按钮

- 4px 基距，六档 `--space-1/2/3/4/5/6` = 4/8/12/16/20/24，档名 = 取值 ÷ 4px；不许第七个值，
  不写裸像素，新代码从 `--space-4` / `--space-5` 取。页面纵距 `--space-4`（`.content__note`
  例外 `--space-5`）· 卡片内边距 20 · 字段格 `--space-4` 行列同值 · 按钮组内 8（`.toolbar` /
  `.modal__footer` / `.cell-actions` / `.empty__actions` / `.order-item__actions` /
  `.chat__actions`）· 卡片行内 20（`.stats` / `.metrics`）· 两列 Grid 20 或 16 · 表格单元格按
  表密度。按钮组靠右用 `margin-left: auto`；`.cell-actions` 固定 8、控件 28px，操作列用
  `.col-actions`（`--layout-actions-col` = 176px）。
- 全项目只有一种字段骨架：`.field-grid` > `.field-cell`——标签在上、控件吃满、可选说明在控件
  下；表格行内控件没有标签语义，是唯一例外。

```html
<div class="field-grid">
  <div class="field-cell"><label class="field-cell__label" for="ID">标签</label><input class="field" id="ID" /><div class="hint">说明</div></div>
  <div class="field-cell field-cell--inline">…标签与开关同一行…</div>
  <div class="field-cell field-cell--span">…跨两列…</div>
</div>
```

- 网格 `repeat(2, minmax(0, 1fr))`，下界必须 `0`；≤720px 单列；`.modal .field-grid` 收一列。
  全部左对齐；数值框 `.field--num` 用 `tabular-nums`、宽度按值域（不吃满格），写在
  `.field-cell > .field { width: 100% }` 之后。控件高 36px，表格行内 28px 例外。
- 落单字段跨两列；说明只在控件下或容器末尾；动作行用 `.field-cell.field-actions`。列表型
  字段不用固定行数 `<textarea>`；不让用户输入机器标识。只读值不进行内排（`1fr auto` 会把值
  推到格子最右端），用只读 `.field` 与可编辑控件同骨架。hint 常驻还是折叠看后果不看字数，
  同一字段不同时摆 `.hint` 与 `.hint-details`。
- 设置页的「当前活动」是**只读清单**（`.claim-overview` 族，写在
  `app-view-settings.js`）：每行只露活动名、状态标签与时间窗，标识不进画面。清单由
  `listClaimPlanChoices` 供给，进设置页时拉一次、页内「刷新活动」按钮再拉（billing 面有
  独立限频，不参与轮询），取舍写 `views/settings.html` 的注释里。
- 按钮排布：页面主操作进 `.page-header__actions`（主按钮最右）或 `.toolbar` +
  `.toolbar__group--end`；表格行内多动作收 `.cell-actions`；低频动作收 ⋯ 菜单。
- `.toolbar` 是 `flex-wrap: wrap`：需要成组换行的包 `.toolbar__group`（组内 nowrap，换行只在
  组之间）；`--fields` 是筛选器组、内部按字段换行；`--end` 靠 `margin-left: auto` 钉右缘。
  **不要用 `.toolbar__spacer`**——`flex: 1` 会把动作组挤到第二行最左。日志筛选条固定两行，
  **搜索框必须在 `--fields` 组外**；≤1200px 下拉折三列。
- 点击面积：图标按钮 ≥36px，窄屏一切可点目标 ≥44px（`--layout-touch-min`）。行内小 ✕ 用不绘
  制的 `::before` 把命中区扩到 36×36。高度默认 36px；表格行内一律 28px（`.btn--sm` +
  `.table .stepper` / `.table .select` / `.table .btn--menu`），跨整行动作仍 36px。
- 变体封闭，不许新造：`.btn`、`.btn--primary`（每屏唯一主动作）、`.btn--danger`、
  `.btn--danger-quiet`、`.btn--sm`、`.btn--confirm-danger`、`.btn--icon`（选择器写
  `.btn.btn--icon`，否则被 `min-width` 撑成胶囊）、`.btn--menu`、`.btn--block`、`.btn--jump`。

## 浮层与 Grid

- 浮层宽档五档，不造第六档：`.modal` 560 · `.modal.confirm` 420 · `.modal.modal--md` 600（表
  单型）· `.modal.modal--lg` 920 · `.login-card` 360，全部走 `--layout-*` token。披露式小浮层
  （行尾 ⋯、`.share-pop`）是 `[data-menu-cell]` 里的 `.menu`（`absolute`），不接管焦点、不锁滚
  动，同一时刻只开一个（`closeMenus()`）。遮罩只有 `.modal-scrim`；Esc 按打开先后倒着退
  （`closeTopDialog`）。`.toast` 不遮罩、不锁滚动、不抢焦点。
- 打开浮层的来源元素必须可聚焦（关窗把焦点还回去）；账号表行是 `<tr>`，所以额度格与权重写
  成真 `<button>`。从浮层里打开的弹窗也要登记 dialog。二次确认一律 `.confirm`。
- 两列块（形态 / gap / 断点）：`.settings-grid` 2 列 / 20 / ≤1023 单列，`stretch` 等高；
  页面本身不限宽，字段格 `.field-grid` 的控件列上限是 `--layout-field-grid-max`；
  `.routing-grid` 2 列 / 16 / ≤1023 单列，`start` + `flex: 0 0 auto`；`.field-grid` 2 列（弹窗
  1 列）/ 16 / ≤720 单列；`.stats-cols` 2 列 / 20 / ≤900 单列，`stretch`；`.chat__layout`
  `minmax(200px,260px) + minmax(0,1fr)` / 20 / ≤1024 折进顶部下拉；`.metrics` 4 列 / 20 / ≤900
  两列、≤600 一列；`.plan-cards` 2 列 / 12 / ≤900 单列。指标网格吃满内容列，
  每列卡宽由 `--layout-metric-max` 钳住；字段格、图表、长表格与输入区的上限
  也在 `tokens.css`，改取值同步 `page.test.ts`。
- 断点：**1440**（请求表 ≤1440 折叠三列）· **1023 / 1024**（同一条界
  线的两种写法）· **900**（面板并排、`.metrics`、`.plan-cards`、大窗全屏）· **720**（侧栏
  →tabbar、触摸 44px、`.field-grid` 单列）· **600**。新两列块先查表，不引入第三个值。基础规则
  必须写在断点之前，否则断点里的单列被盖回去（`page.test.ts` 钉这条）。聊天会话栏的新建按钮与
  会话项必须等宽（按钮放进 `.chat__new-slot`）。设置页主区固定两列，不写
  `grid-template-areas`。

## 门禁

- 改样式先对照正例 class。新增容器嵌套、按钮变体、浮层宽档、间距档，先在参考层文档登记例
  外。取值问题以 `tokens.css` / `styles/*` 的注释为准，文档与其冲突先改文档。
- 新增页面先答 fill 还是 flow，再写 `.page` 壳。顶栏 `.appbar__actions` 的 refresh-cw 是唯一
  上下文刷新入口（派发到视图 `refresh()`，`R` 键同路），**页内不放第二个**。登记在案的例外：
  设置页「当前活动」旁的「刷新活动」按钮单独重拉 `listClaimPlanChoices`（上游 billing 面有
  独立限频，它只刷这一块清单，不重读配置）。
- **本文件提到的 class 必须在代码里真实存在**：`styles/*` 有规则，或在 `views/*.html` /
  `page.html` / `app-*.js` 里真的拼出来。核对
  `rg -oE '\.[a-z][a-z0-9_-]*' src/server/web/AGENTS.md | sort -u`，逐个查；动态拼的类
  （`quota-pct--` + tone、`req__source-dot--` + 下标、`log__level--` + 级别）以族名登记。
- 浏览器只支持现代常青（Chrome / Edge / Firefox / Safari 最近两个大版本）。禁 `@supports` 回
  退、禁 polyfill / 预处理器、禁 `-webkit-*` 前缀（只有数值输入框 spinner 与
  `.hint-details > summary::-webkit-details-marker` 两处例外）。
