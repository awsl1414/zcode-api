# ZCode 官方套餐体系调研

记录官方客户端的套餐数据契约、UI 展示逻辑与活动体系。证据来自官方 ZCode 客户端 monorepo（只读，下文 `path:line` 均相对该仓库根），以及实证截图/日志。

- 性质：**只读调研**。未改官方仓库，未发网络请求。
- 证据分级：`path:line` 相对官方仓库根；实证截图/日志标注「实证」；无证据支撑的推断一律标注「推测」并集中进「残留不确定项」。

---

## 0. 结论摘要

1. **官方不存在「订阅性质 vs 体验性质」的字段级二分，也从不用 `period` 做这个判定。** 官方的二分在**数据面/连接类型**层：Coding Plan（`/api/biz/subscription/list` 或团队 `querySubscribeDetail` 确认的权益，UI 叫「编程套餐」）vs Start Plan（`/api/v1/zcode-plan/billing/balance` 的 `plans[]`，UI 叫「体验套餐」，`planCard.startPlan` = "体验套餐"）。判据是**哪套 entitlement 接口确认了权益**，不是任何桶上的字段。（`packages/shared/src/plan-identity.ts:8-53`、`packages/ui/src/i18n/locales/zh-CN.ts:3981-3982`）
2. **`period` 的真相：它是 entitlement 的「授予/重置周期」，取值实测只有 `daily`（每日重置授予）与 `one_time`（一次性授予）。** 类型是 string 自由串，官方注释举例只此两个（`packages/shared/src/usage-quota.ts:24`「所属 entitlement 的周期类型，如 daily / one_time」）。`daily` 出现在**体验套餐**上的实证：官方 e2e mock 的 Start Plan 预览就是 `period: "daily"`（`packages/desktop/test/e2e/fixtures/entitlement-presentation.ts:25`）——**daily≠订阅**，它只说明「额度每日刷新」。按 `period` 推套餐类型会把体验体系的 daily 桶误判成订阅。
3. **设置页套餐卡的分组键是 `plan_id`，卡片名取 `plan.name`，模型桶名取 `balance.show_name`。** `resolveStartPlanQuotaCardEntries` 以 `limit.planId === plan.productId` 精确归属额度桶（`packages/ui/src/settings/model-provider-section/StartPlanBalanceCard.tsx:154-167`）；「今日余额」按模型拆桶 = `capabilities[]`（`model:` 前缀）展开 + `show_name` 作 displayName（`packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts:1437-1443`）。
4. **「待生效」不是 plan 状态字段，是 `entitlements[].effective_at > now` 的投影**；「已过期」是 `status === "expired"`（或 `ends_at` 已过被客户端强制归一）。状态词三态 `pending / refreshable / settled` 的判定在 `CodingPlanStatusMeta.tsx:183-209`。
5. **活动套餐（实证「ZCODE GLOBAL BUILD」）与基础套餐（实证「ZCode Start Plan」）在数据上同构**：同在 `billing/balance` 的 `plans[]`，无类型字段区分；区分仅在 `plan_id`/`name` 与 `entitlements[].effective_at` 排期。活动的领取入口是 `POST /api/v1/zcode-plan/billing/claim`（Manual Claim，带人机验证证明），领取后即成为普通 plan 实例。
6. **「升级 150% 配额」按钮背后没有独立接口**：它是「升级」按钮 + `client/configs` 下发的 `codingPlanBillingDiscount` 纯文案配置（locale copy），点击打开购买面板（`/api/biz/pay/batch-preview` 等既有购买链路）。

---

## 1. 套餐体系全景

官方全部套餐/权益种类，按数据面划分（每行的「来源接口」就是该体系的权威判定接口）：

| 种类 | 来源接口 | 身份字段 | 生命周期 | UI 名称 |
|---|---|---|---|---|
| **Start Plan 基础体验套餐**（如 `zcode-v3-start-plan`「ZCode V3 Start Plan」） | `GET /api/v1/zcode-plan/billing/balance`（`packages/shared/src/zcodeEndpoint.ts:384`） | `plan_id` + `user_plan_id`（用户实例） | 发放/领取 → `starts_at` → `entitlements[].effective_at` 生效 → 额度桶 `expires_at` 周期重置 → `ends_at` 过期 | 「体验套餐」 |
| **Start Plan 活动套餐**（实证「ZCODE GLOBAL BUILD」；mock「ZCode Weekend Build」） | 领取前 `GET /api/v1/zcode-plan/billing/preview`；领取 `POST /api/v1/zcode-plan/billing/claim`；领取后同上 balance | 同上（`plan_id` 为活动 id） | preview 可领 → claim（带验证证明）→ **待生效**（`effective_at` 未来）→ 生效 → `ends_at` 过期 | 同上，卡片名 = 活动名 |
| **Coding Plan 个人订阅**（Pro/Max 等） | `GET /api/biz/subscription/list`（`packages/services/src/usage-stats/providers/bigmodelSubscriptionProvider.ts:23-25`） | `productId`/`productName`（含 "coding"） | 购买（`/api/biz/pay/batch-preview` → `preview` → `pay/create-sign` 等）→ `status=VALID` + `inCurrentPeriod=true` → `autoRenew`/`nextRenewTime` 续期 → `valid` 尾部日期过期 | 「编程套餐」 |
| **Coding Plan 团队订阅** | `GET /api/biz/team/subscribe/product/querySubscribeDetail`（`packages/services/src/bigmodel/codingPlanEntitlement.ts:108`） | `productId` + `organizationId`/`projectId`（`bigmodel-organization`/`bigmodel-project` 头） | 企业定价 `/api/biz/subscription/enterprise/v2/pricing` → create-order（返回 `subscriptionNo`）→ `status=EFFECTIVE` + `memberGrantStatus=VALID` → `subscribeEndTime` | 「编程套餐（团队）」 |
| **Off-peak 闲时** | `client/configs` 的 `offPeak.enable_offpeak_task` 灰度 + 专用 availability 接口（服务端即时快照，3006 兜底）（`packages/shared/src/coding-plan-subscription.ts:190-195`） | **无独立 plan 身份**——是 Coding Plan 权益的派生使用方式（Built-in offpeak Provider） | 灰度开关 + 服务端低峰准入 | — |
| **Highspeed 加速卡** | `highspeed draw` / `healthy`（`packages/shared/src/highspeed.ts:104-128`） | `card_id` + `task_id` | 抽卡（draw，`next_draw_at` 冷却）→ `issued_at`/`expires_at` → 过期（provider_code=3402） | — |
| **额度重置卡（5 小时/每周）** | `GET/POST /api/v1/coding-plan/reset/{status,use,opportunity,history/read}`（`packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts:74,523-647`） | Coding Plan 凭据（无独立 plan id；`idempotency_key` 幂等） | 发卡（opportunity，3301 限流带 `next_try_at`）→ use → history 已读 | — |
| **官方 Server MCP 额度** | `GET /api/v1/mcp/usage`（`packages/services/src/usage-stats/providers/zcodeMcpQuotaProvider.ts`，经 `bigmodelUsageQuotaProvider.ts:329-350` 接入） | Coding Plan 连接 scope（PERSONAL/TEAM） | 随 Coding Plan 权益 | — |

要点：

- **两档「Start Plan」并存**（zai / bigmodel 两个 family 各自一个 provider：`BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan` / `bigmodelStartPlan`，`packages/ui/src/hooks/useCodingPlanEntryPlanList.ts:95-100`）。官方注释「两个 Start Plan 的 Today's balance 接口已经返回面向用户的 show_name」（`bigmodelUsageQuotaProvider.ts:1439`）指的就是这两档。
- **`subscriptionNo` 不是权益身份**：只出现在企业下单/订单链路（`EnterpriseCodingPlanCreateOrderRequest/Response/PendingOrder`，`packages/shared/src/coding-plan-subscription.ts:538,543,562`），是订单与订阅的关联号，官方判定权益从不读它。
- **`ticket`/`randstr` 是人机验证票据**（购买试算 `CodingPlanPreviewRequest` 的 `ticket`/`randstr`，`packages/shared/src/coding-plan-subscription.ts:251-256`；claim 用 `RequestVerificationProof` 类型证明 + `requestVerificationClaimHeaders` 附加验证头，`packages/shared/src/request-security-edition/verification-policy.ts:2`）。
- 旧接口 `GET /api/v1/zcode-plan/billing/current` **已废弃**：官方注释「billing/current 已废弃，balance 会同时返回 plans 与 balances」（`bigmodelUsageQuotaProvider.ts:376`、`codingPlanProviderAvailability.ts:411`）。

### 生命周期时间字段刻度

- `plans[]` 的 `starts_at`/`ends_at`、`entitlements[].effective_at`、`balances[]` 的 `expires_at`/`period_start`/`period_end`：**Unix 秒**（`normalizeZaiStartPlanBalanceLimits` 内 `parseUnixSeconds` + `* 1000` 归一，`bigmodelUsageQuotaProvider.ts:1410-1436`）。
- `data.server_time`：Unix 秒，是响应内一切相对时间的权威时钟（「balance 的服务端时间与本响应的 effective_at 配对，不能用本机时钟覆盖」，`bigmodelUsageQuotaProvider.ts:439-444`）；HTTP `Date` 头优先于 JSON 时钟做过期归一（`zaiStartPlanBilling.ts:157-188`）。
- subscription/list 的 `nextRenewTime`/`valid`：**本地日期时间字符串**（`parseBigModelLocalDateTime`，`bigmodelUsageQuotaMapper.ts:145` 起）。

---

## 2. 数据契约：`plans[]` / `balances[]` / `entitlements[]` 三层结构

权威类型：`packages/services/src/model-provider/zaiStartPlanBilling.ts:14-56`（`ZaiStartPlanPlan` / `ZaiStartPlanBalanceEnvelope`）。

### 2.1 `plans[]`（套餐实例层，一行 = 一个用户套餐实例）

| 字段 | 含义 | 取值/说明 | 证据 |
|---|---|---|---|
| `user_plan_id` | **用户套餐实例身份**：同一 `plan_id` 商品可有多个实例（不同领取批次），桶归属反查优先用它 | string，可选（服务端契约上应有） | `zaiStartPlanBilling.ts:15-16`（注释「额度提醒用它关联同一实例的 entitlement 周期类型」） |
| `plan_id` | **套餐商品身份**：设置页按它分组额度桶；服务端契约保证**每个桶都携带 plan_id** | 如 `zcode-v3-start-plan`、活动 id | `bigmodelUsageQuotaProvider.ts:1427`、`StartPlanBalanceCard.tsx:163-165` |
| `name` | 面向用户的套餐名（卡片标题） | 如「ZCode V3 Start Plan」「ZCODE GLOBAL BUILD」 | `bigmodelUsageQuotaProvider.ts:1287`（productName 兜底「编程套餐」） |
| `status` | 套餐状态 | **实测取值 `active` / `expired`**。客户端只认 `active` 参与权益（`pickCurrentZaiStartPlan`），`ends_at` 已过的 active 会被强制改写为 `expired`（`normalizeStartPlanExpiry`） | `bigmodelUsageQuotaProvider.ts:1471-1482`、`zaiStartPlanBilling.ts:169-177`、mock `coding-plan-upgrade-mock-server.ts:332` |
| `starts_at` / `ends_at` | 生效/过期时刻（Unix 秒） | 实证「过期 11月10日 09:00」= `ends_at` | `zaiStartPlanBilling.ts:20-21` |
| `entitlements[]` | 该实例挂的权益（见 2.3） | | |

### 2.2 `balances[]`（额度桶层，一行 = 一个模型/权益额度桶）

| 字段 | 含义 | 取值/说明 | 证据 |
|---|---|---|---|
| `bucket_id` | 桶身份（官方提醒去重键的组成部分） | string | `usage-quota.ts:17`、`startPlanQuotaBuckets.ts:52-63` |
| `user_plan_id` / `plan_id` | 归属的套餐实例/商品。**契约保证每个桶都带 plan_id**，归属反查优先 `user_plan_id` 精确匹配，缺省退 `plan_id` | | `bigmodelUsageQuotaProvider.ts:1402-1406`、`warnOnUnattributedStartPlanBuckets` tripwire `:1310-1338` |
| `entitlement_id` | 桶挂的权益，`period` 反查链的钥匙 | | `bigmodelUsageQuotaProvider.ts:1407-1409` |
| `show_name` | **面向用户的模型/桶显示名**（服务端已翻译，如「GLM-5.3-Flash」）。模型桶渲染的 displayName 首选它，不再从 capabilities 推导（推导会把 GLM-5-Turbo 显示成 GLM-5Turbo） | string | `bigmodelUsageQuotaProvider.ts:1399,1439-1443` |
| `meter` | 计量面 | `model_usage` 等；官方过滤「模型桶」看 `meter === "model_usage"` | `startPlanQuotaBuckets.ts:23` |
| `unit_type` | 单位 | `token` 等（UI：`unitType === "token"` → 「tokens」文案） | `StartPlanCard.tsx:225-234` |
| `capabilities[]` | 该桶覆盖的模型能力 | `model:` 前缀 + 模型 code（如 `model:glm-5.3-flash`）；展示层剥前缀；多模型桶 join " / " | `bigmodelUsageQuotaProvider.ts:1449-1459`、`zaiStartPlanBilling.ts:129-155` |
| `total_units` / `used_units` / `remaining_units` | 总量/已用/剩余 | **「剩余」必须用 `remaining_units`**；`available_units` 是扣掉进行中请求 `reserved_units` 后的可用量，不能当剩余展示 | `bigmodelUsageQuotaProvider.ts:1388-1391`、`startPlanQuotaBuckets.ts:35-36` |
| `reserved_units` / `available_units` | 预留/可用 | 仅语义存在，展示不用 | `zaiStartPlanBilling.ts:48-50` |
| `period_start` / `period_end` | **桶的当前授予周期边界**（Unix 秒） | active 桶过滤：`period_start <= now <= period_end`；提醒去重键 = `[bucket_id, period_start, period_end]` | `startPlanQuotaBuckets.ts:17-28,52-63` |
| `expires_at` | **桶的真实重置边界**（服务端契约保证每个桶都带）。映射为 `UsageQuotaLimit.nextResetTime` | Unix 秒 | `bigmodelUsageQuotaProvider.ts:1395-1396`、`StartPlanBalanceCard.tsx:67-72` |

### 2.3 `entitlements[]`（权益层，挂在 plan 实例下）

| 字段 | 含义 | 证据 |
|---|---|---|
| `entitlement_id` | 权益身份（balance 反查 period 的钥匙） | `zaiStartPlanBilling.ts:22-23` |
| `show_name` | 面向用户的权益/模型名（与 balance.show_name 同语义，「待生效提示」也用它） | `usage-stats.ts:146-151`、`zaiStartPlanBilling.ts:24` |
| `period` | **授予/重置周期类型**（详见「`period` 的真相」） | `zaiStartPlanBilling.ts:25` |
| `effective_at` | **权益生效时刻**（Unix 秒；`0` = 立即生效哨兵值）。未来值 = 「待生效」 | `zaiStartPlanBilling.ts:26`、`CodingPlanStatusMeta.tsx:203` |

billing/preview 的 entitlement 还多出领取前预览字段：`meter` / `unit_type` / `capabilities` / `grant_units`（授予总量）/ `priority`（`ManualClaimPlanEntitlement`，`packages/shared/src/coding-plan-subscription.ts:133-143`）。

### 2.4 映射契约（`normalizeZaiStartPlanBalanceLimits`，`bigmodelUsageQuotaProvider.ts:1377-1447`）

桶 → `UsageQuotaLimit` 的完整字段映射即在此函数（本仓 `routes-quota.ts` 的反查口径与其同源）：

- `type` = `entitlement_id` ?? capabilities 串 ?? `meter` ?? `"model_usage"`；
- `planId` 仅在非空时带上——「planId 用于设置页按套餐卡片分组额度桶；服务端契约保证每个桶都携带 plan_id」（`:1427`）；
- `usageDetails[]` = `capabilities` 展开（剥 `model:` 前缀）→ `{ modelCode, displayName: show_name, usage: used_units }`；
- `percentage` = `remaining / total`（**剩余占比**，不是已用占比；与 MCP quota 的「已使用占比」口径相反，`usage-quota.ts:57-59` 有注释警示）。

tripwire：`warnOnUnattributedStartPlanBuckets`（`:1310-1338`）——出现无法归属到 active plan 的桶即 warn（契约破坏信号，多卡路径会静默丢弃这些桶）。

---

## 3. `period` 的真相

### 3.1 取值枚举

- 类型：`period?: string`（自由串，无 enum 约束）——`packages/shared/src/usage-quota.ts:23-24`：「所属 entitlement 的周期类型，**如 daily / one_time**」。
- 全仓实测/mock/fixture 取值只有两个：**`daily`**（`entitlement-presentation.ts:25`、`start-plan-bucket-reminder.fixture.tsx:47,59`、`desktop/test/e2e/fixtures`）与 **`one_time`**（`start-plan-bucket-reminder.fixture.tsx:35`、`coding-plan-upgrade-mock-server.ts:300,454`）。未发现 weekly/monthly 等其它取值（已搜 `packages/` 全部 ts 的 mock/fixture/测试，见「残留不确定项」）。

### 3.2 语义

**授予/重置周期**：回答「这个桶的额度怎么刷新」，不回答「这是不是订阅」。

- `daily` = 周期性**每日重置**的授予：实证「今日余额按模型拆桶……各带重置时间 23:59」就是 daily 桶（「今日余额」面板 i18n `startPlan.balance.title` = "今日余额"；daily 文案「每日额度 · {details}」「{unit}/日」）。
- `one_time` = **一次性**总量授予：不周期重置，用完或随 `expires_at`/`ends_at` 失效（mock 的活动「ZCode Weekend Build」entitlement 即 `period: "one_time"` + `grant_units: 100亿`）。

### 3.3 官方全部消费点（穷举）

1. **体验预览卡文案选择**：`primary.period === "daily"` → 「每日额度 · …」/「{unit}/日」，否则通用「额度 · …」（`packages/ui/src/settings/model-provider-section/StartPlanCard.tsx:173-182,209-223`）。
2. **billingCycle 展示**：`pickZaiStartPlanBillingCycle` 取 plan 的第一个非空 `entitlements[].period` 当 billingCycle 展示（`bigmodelUsageQuotaProvider.ts:1529-1535`）——即官方只把它当「周期」文案，不当订阅标记。
3. **额度提醒去重场景**（fixture `start-plan-bucket-reminder` 同时用 `one_time` 与 `daily` 桶做多桶提醒）。

**没有任何一处把 `period` 映射成「订阅/体验」。**

### 3.4 官方如何区分「订阅性质」与「体验/一次性性质」

**答案：根本没有 period 参与的二分；二分在 plan 卡片体系（数据面），每张卡片只有自己的名字和有效期。** 具体机制：

- `PlanIdentityStatus = "coding_plan" | "start_plan" | "no_plan" | "unknown"`（`packages/shared/src/usage-stats.ts:111`），由 `resolvePlanIdentitySnapshot` 判定（`packages/shared/src/plan-identity.ts:8-53`）：**coding_plan（订阅）优先**——个人/团队 Coding Plan entitlement 确认即 `coding_plan`；否则 Start Plan entitlement 确认即 `start_plan`；都没有 = `no_plan`。判据是 entitlement 快照（`quota || subscription || remaining` 任一存在即 active，`:94-100`），**不读任何 period/plan 类型字段**。
- UI 文案直接给出二分命名：`planCard.codingPlan` = **「编程套餐」**、`planCard.startPlan` = **「体验套餐」**（`zh-CN.ts:3981-3982`）；`startPlan.status.expired` = 「体验套餐已过期」（`:3819`）。**官方把整个 Start Plan 体系（含活动 plan）都叫「体验套餐」**。
- 字段级的辅助差别：subscription/list 体系有订阅语义字段 `autoRenew`/`nextRenewTime`/`valid`/`billingCycle`/`inCurrentPeriod`（`codingPlanEntitlement.ts:11-20`），而 Start Plan `plans[]` 体系**没有续期概念**（`renewTime` 恒 null：「Start Plan 卡片不展示套餐级续期时间」，`bigmodelUsageQuotaProvider.ts:1291-1293`）。反过来 `user_plan_id`/`bucket_id`/`entitlements[]` 只在 Start Plan 体系出现。
- 「订阅 vs 体验」在官方也**不是单选**：`usePlanIdentitySnapshot` 同时拉 coding 与 start 两套 entitlement（`usePlanIdentitySnapshot.ts:40-70`），两者可以并存（`planKind: "start-plan"` 与 `"individual-coding-plan"` / `"team-coding-plan"` 是连接类型维度，`codingPlanProviderAvailability.ts:97`）。

**结论：判据是「数据面归属」——credits 平面（start-plan / billing balance）永远是体验套餐，coding 平面（订阅接口确认）才是订阅；`balances[].period` 只承载「刷新周期」，不是套餐类型。**

---

## 4. 官方 UI 展示逻辑（设置页「模型设置」套餐面板）

### 4.1 分组键与卡片结构

- **分组键 = `plan_id`**（不是 user_plan_id）：`resolveStartPlanQuotaCardEntries({plans, limits})` → 每张卡 = 一个 `UsageEntitlementSubscriptionDetail`（= `plans[]` 的一条），卡内额度桶 = `limits.filter(limit => limit.planId === plan.productId)`（`StartPlanBalanceCard.tsx:154-167`）。注释明确：「额度桶只按 plan_id 精确归属……不再对无 plan_id 的桶做单套餐兜底，否则多套餐下会把同一桶复制进每张卡片」。
- 多卡渲染在 `StatusCards.tsx:576-607`：`startPlanEntries.map(...)` → 每卡一个 `PlanStatusCardSurface`，`planTitle = plan.productName`（即 `plan.name`，实证「ZCODE GLOBAL BUILD」「ZCode Start Plan」）；第一张卡带完整 statusMeta + trailingAction（升级按钮），其余卡各自带 `StartPlanStatusMeta`。
- 兜底单卡分支（`:608-647`）：nav 项无套餐详情时**不得**把全量 quotaLimits 塞进单卡（「无匹配 plan_id 的桶不得附着到任何卡片」），只保留查询占位。

### 4.2 卡片内容

- **状态行（`StartPlanStatusMeta`，`CodingPlanStatusMeta.tsx:86-181`）**：排期提示 + 过期日期。Start Plan **不展示 renew 时间**（「避免把免费额度刷新时间误读成套餐续费」，`:175`）。
- **「今日余额」模型桶（`StartPlanQuotaStatusCard` → `StartPlanBalanceLimit`，`StartPlanBalanceCard.tsx:81-122`）**：每桶一块，渲染来源：
  - 模型名 = `formatLimitModels(limit)`：`usageDetails[].displayName`（= `show_name`）优先，缺省用 `modelCode` 大写（`formatModelCode`，剥 `model:` 前缀）；多模型 join " / "（`:190-212`）；
  - 数值 = `remaining / total`（全格式数字「500,000,000 / 1,000,000,000」）+ 剩余百分比；
  - 进度条 = `remaining / total` 比例；
  - **桶重置时间** = `limit.nextResetTime`（= `balance.expires_at`）——「桶刷新时间只来自本桶的 expires_at，不再用套餐级 renewTime 兜底」（`:67-72`）。
  - 桶序 = 服务端返回序（「Today's balance 后端已经按产品优先级返回 balances。UI 继续反转……不一致」，`:28-30`）。
  - 过滤：`total > 0 || remaining > 0` 才显示（`:23-27`）。
- **配额条归属校验**：`hasStartPlanEntitlementQuota`（`StatusCards.tsx:660-673`）——entitlements 的 `entitlement_id` 集合与 `limit.type` 交集判断「有额度可展示」。

### 4.3 状态词判定条件

| 状态词 | 判定 | 证据 |
|---|---|---|
| **「待生效 {date}」**（`startPlan.pendingUntil`） | `resolveStartPlanStatusMetaState`：任一 `entitlements[].effectiveTime > now` → `pending`；文案取**最近的未来生效时间**（`resolvePendingStartPlanEffectiveTime`） | `CodingPlanStatusMeta.tsx:183-209,211-225`、`zh-CN.ts:3993` |
| **「刷新权益」按钮**（`refreshable`） | 有已到点的排期权益（`effective_at > 0 && <= now`；`0` 是立即生效哨兵）但额度桶尚未同步到（`!hasQuota`） | `CodingPlanStatusMeta.tsx:141-171,201-207` |
| **生效中/已同步**（`settled`） | 其余（含立即生效且桶已到） | 同上 |
| **「过期时间 {date}」**（`startPlan.expiresAt`） | `plan.expireTime`（= `ends_at`）非空即显示，与上面并存 | `CodingPlanStatusMeta.tsx:132-140` |
| **「已过期」**（`codingPlan.startPlan.expiredBadge`）/「体验套餐已过期」 | `status === "expired"`（含被 `normalizeStartPlanExpiry` 强制归一的）；`unavailableReason: "no_plan"` + `startPlanExpired` | `zh-CN.ts:3893,3819`、`bigmodelUsageQuotaProvider.ts:413-427` |

「待生效」的时间显示规则：今天/明天用相对日（「今天 23:00」/「明天 09:00」），更远用「月 日 时:分」（`formatStartPlanEffectiveDate`，`CodingPlanStatusMeta.tsx:227-257`）。

### 4.4 卡片标题判定

`resolveCodingPlanStatusCardTitle`（`StatusCards.tsx:675-714`）：已购 Start Plan 且权益名是 Start 系（`isStartPlanEntitlementName`：`start` / `start plan` / `* start plan`）→ 「体验套餐」；**否则露出后端权益名**（「避免付费用户看到免费套餐标题」）；未购 → 「体验套餐」/「编程套餐」默认标题。

### 4.5 身份面板组织（`usePlanIdentitySnapshot` + `startPlanEntitlementOptions`）

- 两套 entitlement 并行查询：coding（`includeSubscription: true`，planKind = team/individual）与 start（`planKind: "start-plan"`），各自带缓存 key 与 TTL（`usePlanIdentitySnapshot.ts:40-70`、`startPlanEntitlementOptions.ts:18-30`）。
- Start Plan 是**独立权益**：「即使当前连接仍是个人/Team Coding Plan，也必须单独查询，否则领取后待生效或已拥有的 Start Plan 会被错误地当成『未连接』」（`codingPlanProviderAvailability.ts:189-191`）。
- 可用性（`hasActiveStartPlan`）：`status === "active"` 且 `plan_id`/`name` 含 "start-plan"/"start plan"（无 id/name 时放行）——真实返回 `plan_id=zcode-v3-start-plan`、`name=ZCode V3 Start Plan`（`codingPlanProviderAvailability.ts:527-548`）。
- `pending`（整体待生效）：所有 entitlement 生效时间都在未来且无可用模型桶 → `{ kind: "pending", effectiveAt: min(生效时间) }`（`codingPlanProviderAvailability.ts:488-501`）。

---

## 5. 活动体系（claim 抢的套餐）

### 5.1 活动 plan 与基础 plan 的数据区分

**同构，无类型字段。** 二者都进 `billing/balance` 的 `plans[]`（mock：`plans: [oldPlan("ZCode V3 Start Plan"), newPlan("ZCode Weekend Build")]`，`coding-plan-upgrade-mock-server.ts:657-716`）。可见的区别只有：

- `plan_id`/`name`（基础 = `zcode-v3-start-plan`「ZCode V3 Start Plan」；活动 = 活动 id/名，如实证「ZCODE GLOBAL BUILD」）；
- 活动 plan 领取前在 `billing/preview` 有**预览形态**（多出 `description`/`priority`/`entitlements[].grant_units`/`priority`，`ManualClaimPlanPreview`，`packages/shared/src/coding-plan-subscription.ts:145-157`）；
- 活动 entitlement 常带**未来 `effective_at`**（排期生效），基础 plan 常为 `0`（立即生效哨兵）——实证「待生效 今天 23:00」即活动卡的 entitlement 排期。

### 5.2 「待生效」（未来生效时间）的语义

- entitlement 级：`effective_at > now` → 卡片「待生效 {date}」（见「状态词判定条件」）。到点后服务端**可能延迟创建额度桶**，中间态给「刷新权益」按钮（`CodingPlanStatusMeta.tsx:151-152` 注释「排期权益到点后服务端才创建额度桶」）。
- 桶级过滤：active 桶要求 `period_start <= now && period_end > now && nextResetTime > now`（`startPlanQuotaBuckets.ts:17-28`）——未来周期的桶不进「今日余额」。
- plan 级可用性：`pending` 状态只在「模型桶为空 且 所有 effective_at 都在未来」时成立（`codingPlanProviderAvailability.ts:488-501`）。

### 5.3 活动领取链路

1. **预览** `GET /api/v1/zcode-plan/billing/preview?app_version=&platform=`（Bearer `zcodejwttoken`）→ `{server_time, plans: [{plan_id, name, description, priority, entitlements: [{entitlement_id, show_name, meter, unit_type, capabilities, grant_units, period, priority, effective_at}]}]}`（`bigmodelCodingPlanSubscriptionProvider.ts:280-322`）。envelope 是**平台 code=0**（不是 BigModel 支付接口的 code=200）。
2. **领取** `POST /api/v1/zcode-plan/billing/claim`，body `{plan_id}`，头带 `Authorization: Bearer <zcodejwttoken>` + 人机验证证明头（`requestVerificationClaimHeaders`）+ `X-ZCode-App-Version` + `X-Platform`（`bigmodelCodingPlanSubscriptionProvider.ts:338-425`）。
   - 成功：`{code: 0, data: {server_time, plan: {user_plan_id, plan_id, status, starts_at, ends_at, entitlements: [{entitlement_id, show_name, effective_at}]}}}`。
   - 失败：`code` 非 0（如 `1003` already claimed；错误码可能是**数字字符串**），`data.message` 是服务端已翻译文案，`data.plan.ends_at` 作为 `failureEndsAt`（活动结束时间，「不得当作已领取权益期限」，`packages/shared/src/coding-plan-subscription.ts:166-170`）。
   - 无 token 直接 `{success: false, code: 401}`。
3. **领取后数据形态**：claim 返回的 plan 实例随即出现在 `billing/balance` 的 `plans[]`，对应桶出现在 `balances[]`（可能延迟，见 5.2）；此后与基础 plan 无差别地按 `plan_id` 分组展示。

### 5.4 「升级 150% 配额」按钮

- 渲染：`CodingPlanUpgradeAction`（`CodingPlanStatusActions.tsx:66-135`）——「升级」按钮（`codingPlan.upgrade`，Max 档换 `codingPlan.renew`）+ 活动徽章 pill（`CodingPlanBillingDiscountBadgePill`）+ 说明弹窗（`CodingPlanBillingDiscountInfoDialog`，入口文案「查看 150% 配额活动说明」`zh-CN.ts:3998`）。仅 `isStartPlanProvider && billingDiscount.active` 时激活（`StatusCards.tsx:378`）。
- **背后接口：没有独立的「升级配额」接口。** 活动配置 = `GET /api/v1/client/configs` 的 `configs.codingPlanBillingDiscount`——**纯 locale 文案**（`{cardTitle, cardBody, badgeBody, infoTitle, infoBody}`，`CodingPlanBillingDiscountConfig`，`packages/shared/src/coding-plan-subscription.ts:105-113`；mock 值 `"cardTitle: 150% quota"`，`entitlement-presentation.ts:31-37`）。读取经 `getBillingDiscount()` → `unwrapClientConfigBillingDiscount`（`bigmodelCodingPlanSubscriptionProvider.ts:470-473`），1h 缓存（`BILLING_DISCOUNT_CACHE_TTL_MS`，`CodingPlanBillingDiscount.tsx:22`）。
- 点击行为 = 打开购买/升级面板（`openUpgradePlans`，`StatusCards.tsx:354-368`）；面板数据走既有购买链路：个人 `POST /api/biz/pay/batch-preview`（`productList` + `isSubscribed`）、团队 `GET /api/biz/subscription/enterprise/v2/pricing`。**「150%」只是营销 copy，实际配额提升由购买的套餐决定。**

### 5.5 「新用户体验」预览卡（拉新）

`StartPlanCard`（`StartPlanCard.tsx:12-71`）：未购买 Start Plan 时展示的拉新卡，数据来自 `client/configs` 的 `startPlanPreview`（`{planId, name, entitlements: [{grantUnits, meter, period, showName, unitType}]}`）。注释：「体验套餐卡片必须由远端 startPlanPreview.entitlements 驱动；没有可展示额度时不能再回退到本地硬编码 Trial plan 文案」（`:22-24`）。

---

## 6. 残留不确定项

1. **`period` 是否有 `daily`/`one_time` 之外的服务端取值**：客户端类型是自由串（`usage-quota.ts:24`）。已搜官方仓全部 `*.ts`（含 tests/fixtures/mocks/e2e）中 `period` 的字面量赋值，仅得 `daily` / `one_time`；`packages/ui/test/browser/manual-review/pending/start-plan-bucket-reminder.fixture.tsx`、`packages/desktop/test/e2e/**` 也只覆盖这两个。**服务端契约文档不在可见范围内**，无法排除 weekly/monthly 等；消费端遇到未知 period 时不猜取值。
2. **`plans[].status` 的完整枚举**：实测/ mock 仅 `active` / `expired`（客户端只对这两个有分支：`pickCurrentZaiStartPlan` 认 active、`normalizeStartPlanExpiry` 造 expired、`startPlanExpired` 查 expired）。是否有 `pending`/`scheduled` 等服务端取值无证据——「待生效」在客户端完全由 `entitlements[].effective_at` 投影，不依赖 status，故不影响实现。
3. **「升级 150% 配额」的实际配额提升机制**：客户端只见文案配置（`codingPlanBillingDiscount`）与购买面板；150% 提升是否在购买后的额度桶总量上生效、还是活动期临时倍率，**客户端无证据**（要看购买后 balance 的 `total_units` 变化，属服务端行为）。已确认客户端侧没有任何「提升配额」调用。
4. **`billing/preview` 的活动资格判定**（谁能看到哪个活动 plan）：preview 对 `plan_id` 不做客户端过滤，返回什么展示什么；资格/灰度逻辑在服务端。`priority` 字段的排序语义（客户端只透传）未见消费点。
5. **Off-peak 的「专用 availability 接口」具体路径**：官方注释只说「改由专用 availability 接口提供服务端即时快照」（`packages/shared/src/coding-plan-subscription.ts:195-196`），接口实现未在走读的文件内（`offPeakModelSelectionView.ts` 只有模型选择视图）。不影响套餐体系结论。
6. **风控调研文档原文**：`docs/research/upstream-risk-control.md` 记录客户端风控全貌；本报告只覆盖套餐体系，其中未验证的取值与服务端行为集中在本节。

---

## 附：证据文件清单

官方仓库（相对路径）：

| 文件 | 行 | 证据内容 |
|---|---|---|
| `packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts` | 1377-1447 | `normalizeZaiStartPlanBalanceLimits`：桶→limit 全字段映射、period 反查链、planId 分组契约注释 |
| 同上 | 1310-1338 | `warnOnUnattributedStartPlanBuckets` tripwire（契约保证每桶带 plan_id） |
| 同上 | 1276-1308 | `buildZaiStartPlanSubscription`：entitlements→showName/effectiveTime、renewTime 恒 null 注释 |
| 同上 | 1471-1535 | `pickCurrentZaiStartPlan`（active+start-plan 身份）、`pickZaiStartPlanBillingCycle`（period 当 billingCycle） |
| 同上 | 376,439-444 | billing/current 已废弃注释；server_time 权威时钟注释 |
| 同上 | 523-647 | `/api/v1/coding-plan/reset/*` 重置卡契约 |
| `packages/services/src/model-provider/zaiStartPlanBilling.ts` | 14-56 | `ZaiStartPlanPlan` / `ZaiStartPlanBalanceEnvelope` 全字段类型 |
| 同上 | 63-69,129-155,157-188 | balance URL（`/api/v1/zcode-plan/billing/balance` + app_version）、capabilities→modelIds、过期归一 |
| `packages/services/src/model-provider/codingPlanProviderAvailability.ts` | 88-99,189-191 | `planKind` 三值；Start Plan 独立权益注释 |
| 同上 | 463-505,527-548 | pending 判定（effective_at 全未来）、`hasActiveStartPlan`（active + start-plan 身份） |
| `packages/services/src/bigmodel/codingPlanEntitlement.ts` | 11-56,98-132 | 个人/团队订阅 schema、`isActivePersonalCodingPlan`（VALID+inCurrentPeriod）、团队 EFFECTIVE/VALID 判定 |
| `packages/services/src/usage-stats/providers/bigmodelSubscriptionProvider.ts` | 10-59 | subscription/list + querySubscribeDetail → 订阅摘要 |
| `packages/services/src/usage-stats/providers/bigmodelUsageQuotaMapper.ts` | 90-160 | `pickCurrentSubscriptionFromList`：autoRenew/nextRenewTime/valid → renewTime/expireTime |
| `packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts` | 280-322,338-425 | billing/preview、billing/claim 完整请求/响应形态（含失败码/failureEndsAt） |
| 同上 | 470-473,1578-1581 | `getBillingDiscount`（client/configs）、offPeak 灰度 |
| `packages/shared/src/usage-quota.ts` | 14-37 | `UsageQuotaLimit`（period 注释「如 daily / one_time」、planId 分组注释） |
| `packages/shared/src/usage-stats.ts` | 78-152 | `UsageEntitlementSnapshot`/`SubscriptionDetail`（entitlements showName/effectiveTime）、`PlanIdentityStatus` |
| `packages/shared/src/plan-identity.ts` | 8-53,94-100 | 订阅/体验二分判定（coding_plan 优先，无 period 参与） |
| `packages/shared/src/coding-plan-subscription.ts` | 105-170,530-620 | BillingDiscount copy / StartPlanPreview / ManualClaimPlan 全类型、subscriptionNo 仅企业订单 |
| `packages/shared/src/highspeed.ts` | 21-62,64-128,136-151 | 加速卡 provider 身份、draw/healthy 契约、card 生命周期 |
| `packages/shared/src/zcodeEndpoint.ts` | 383-384 | billing/current（废弃）与 billing/balance URL |
| `packages/ui/src/settings/model-provider-section/StartPlanBalanceCard.tsx` | 11-122,149-212 | 「今日余额」桶渲染（show_name 优先、expires_at 重置时间、服务端桶序）；`resolveStartPlanQuotaCardEntries` 分组键 |
| `packages/ui/src/settings/model-provider-section/StatusCards.tsx` | 446-449,576-647,660-714 | 多卡渲染、兜底单卡不塞桶、`hasStartPlanEntitlementQuota`、卡片标题判定 |
| `packages/ui/src/settings/model-provider-section/CodingPlanStatusMeta.tsx` | 86-257 | 状态词三态判定（pending/refreshable/settled）、effective_at=0 哨兵、相对日期格式 |
| `packages/ui/src/settings/model-provider-section/StartPlanCard.tsx` | 12-71,173-223 | 体验预览卡（远端 startPlanPreview 驱动）、period=daily 文案选择 |
| `packages/ui/src/settings/model-provider-section/CodingPlanStatusActions.tsx` | 66-135 | 「升级 + 150% 徽章」按钮组合与行为 |
| `packages/ui/src/v4/startPlanQuotaBuckets.ts` | 17-63 | active 桶过滤（period_start/end）、提醒去重键 |
| `packages/ui/src/hooks/usePlanIdentitySnapshot.ts` / `packages/ui/src/lib/startPlanEntitlementOptions.ts` | 全 | 双 entitlement 并行查询、planKind 传参 |
| `packages/ui/src/i18n/locales/zh-CN.ts` | 3819-3998 | 状态词/卡片名文案（体验套餐/编程套餐/待生效/今日余额/150% 活动） |
| `packages/desktop/test/e2e/helpers/coding-plan-upgrade-mock-server.ts` | 274-345,425-470,657-716 | preview/claim/balance 全 mock 形态（双 plan 并存、排期生效、活动失败码 1003） |
| `packages/desktop/test/e2e/fixtures/entitlement-presentation.ts` | 11-154 | 五接口 mock 形态（client/configs、enterprise pricing、subscription/list、querySubscribeDetail、balance）；startPlanPreview `period: "daily"` 实证 |

本仓（zcode-api）对照点（只读引用）：

| 文件 | 行 | 证据内容 |
|---|---|---|
| `src/accounts/summary.ts` | 121-148 | `planKindsOf`：订阅/体验二分只按 `quotaPlane` 数据面派生 |
| `src/control/control-views.ts` | 50-149 | `AccountPlanKind`/`AccountQuotaSummary`/`AccountQuotaWindow` 控制面契约 |
| `src/accounts/quota.ts` | 127-203 | `RouteQuota`/`AccountQuotaBalance`/`AccountQuotaPlan` 采样归一契约 |
| `src/server/routes-quota.ts` | 82-124,281-305 | 数据层透传 showName/planId/userPlanId/capabilities/period；period 反查链同源注释 |

实证记录：账号页把「ZCODE GLOBAL BUILD」「ZCode Start Plan」贴「订阅套餐」标签、卡片未显示具体名称——官方数据面二者均为 Start Plan「体验套餐」体系（billing/balance `plans[]`），卡片名应取 `plan.name`、模型桶名取 `balance.show_name`。
