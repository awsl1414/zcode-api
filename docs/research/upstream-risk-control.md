# ZCode 客户端风控逻辑盘点

记录官方客户端（v3.17.2）与上游风控交互的机制，以及 405 状态码在客户端的语义。证据来自官方 ZCode 客户端源码 monorepo 及其仓库内文档、`path:line` 均相对该仓库根。

- 性质：**只读调研**，未改任何运行代码，未发网络请求。目标仓库是 ZCode 官方客户端源码 monorepo（与官方版本同步更新的公开仓库），其中「请求安全校验」的核心实现被**发行版剥离（stub 空壳）**，但全部脚手架、调用点、错误码契约、文档保留完整——本文从这些残留反推机制全貌。
- 证据分级：所有结论标注 `仓库内 path:line`（相对官方 ZCode 客户端仓库根）。标注「stub」表示该实现为空壳；标注「文档」表示依据仓库内 docs/。

---

## 0. 结论摘要

1. **ZCode 客户端的风控面 = 一套「请求安全校验（Request Verification）」机制 + 完整的失败分类/重试纪律**。核心机制是：Start Plan / Coding Plan 的每个模型请求发出前，经私有 RPC 通道（`provider-runtime-headers`，总时限 180s）向桌面 Host 换取**含官方请求安全校验一次性 header 的动态鉴权材料**（`docs/agent-subagent-provider-runtime-headers-routing.md` 原文：「例如官方版本请求安全校验所需的一次性 header」）。该机制的实现（头的生成、挑战-应答）在公开仓库里被 stub 成空壳（`packages/shared/src/request-security-edition/verification-policy.ts` 全部函数返回 `null/false/{}`），但触发时机、fail-closed 语义、错误码、UI 交互协议完整保留。
2. **风控拒绝的业务码是 `3007`（Security verification rejected，HTTP 403 携带）**。客户端把它分类为 `AuthFailed` + `retryReason=AuthRefresh` + **不可自动重试**（`failure-provider-business-codes.ts:100`）；官方构建「可先应用自己的有界安全验证恢复」（`docs/start-plan-provider-business-errors.md:19`），开源构建直接显示「请求被网关安全校验拒绝，请稍后重试或联系支持」（`packages/ui/src/request-security-edition/messages.ts:9`）。
3. **405 的完整答案**：客户端对 HTTP 405 **没有任何风控级处理**。全仓库只有一处业务处理：UI 归因层把它归为 `provider / invalid_request`（`packages/ui/src/lib/chatErrorAttribution.ts:311`），且该规则「只在 telemetry 归因边界生效，不改变 adapter retry、错误文案或业务动作」（`docs/trace/chat-error-banner-attribution.md`）。分类器没有 405 分支 → 落入 final fallback（unknown，不可重试）。**含义：405 在上游网关 = 请求形态（路径/方法）不被接受，客户端的立场是「这是请求构造错误，重试无用」**。其余 405 命中均为本地 HTTP 服务的 method-not-allowed（mock 网关、pluginSandbox 等），与风控无关。
4. **身份仿冒面在头层与体层双轨**：头层由共享组装规则 `buildZCodeSourceHeadersFromContext`（`packages/shared/src/zcode-source-headers.ts:30`）出 `User-Agent: ZCode/<ver>`、`X-Title: Z Code@<cli|electron>`、`X-Device-Mid`（设备指纹）等全表；体层由 Anthropic `metadata.user_id` 携带 `device_id + session_id` JSON（`docs/anthropic-request-metadata.md`）。另有请求归因头族 `x-session-id`（剥内部前缀）、`x-zcode-session-type`（服务端用它区分 main/subagent/side_chat 来源）等（`runner-attribution.ts:36-66`）。
5. **限流纪律严格区分「瞬时」与「终态」**：1302/1303/1305/1312 等瞬时限流可重试（Retry-After 优先 + 后置抖动）；1304/1308/1309/1310/1311/**1313（fair usage restriction）**/1113 等终态一律不重试——「自动 retry 会浪费预算，也可能加重 provider 侧的限流」（`docs/bigmodel-business-error-retry.md:66`）。2026-10 线上 1302 风暴的直接成因是「同一时刻被限流的一批请求拿到同一个 retry-after，不加抖动一起醒来再一起撞上限流」。

---

## 1. 风控面总览

```
                         ┌────────────────────────────────────────────┐
                         │ 上游网关（zcode.z.ai / open.bigmodel.cn /   │
                         │ api.z.ai 的 /api/v1/ultra* 系）             │
                         └──────────────┬─────────────────────────────┘
                                        │ 拒绝形态：HTTP 403+3007 / 429+130x /
                                        │ 405 / 200+SSE error frame / 空流
   客户端侧五道防线                      │
   ─────────────────                    ▼
   ① 身份层   头指纹（见「身份仿冒面」）+ 体指纹 metadata.user_id + 设备 deviceMid
   ② 凭据层   PAT 短期令牌 + accountScope 作用域锁 + 双 JWT（见「凭据层与风控联动」）
   ③ 安全校验 RequestVerification 一次性动态头（官方闭源，3007 对接，见「请求安全校验」）
   ④ 分类层   ProviderBusinessError 归一 + 业务码→(reason, retryable) 映射表（见「业务错误码」）
   ⑤ 恢复层   PAT 401 恢复 / thinking 签名修复 / 空流探测 / 端点降级（见「流式风控恢复」到「端点路由与环境」）
```

---

## 2. 请求安全校验（Request Verification）——风控核心

### 2.1 机制形状（从 stub 脚手架反推）

公开仓库把实现剥离了，但以下脚手架完整，机制形状可完全确定：

**契约层**（`packages/shared/src/request-security-edition/`）：

| 符号 | 开源版实现 | 反推的官方语义 |
|---|---|---|
| `requiresRequestVerification(access, config?)` | 恒 `false`（verification-policy.ts:34） | 按 access mode + 服务端下发的 config 决定该请求是否要过安全校验 |
| `readValidatedRequestVerificationConfig(configs)` | 恒 `null`（:14） | 从 `client/configs` 的 `configs` 里解析验证配置（服务端灰度开关） |
| `requestVerificationClaimHeaders(proof)` | 恒 `{}`（:19） | 把验证凭证（proof）翻译成一次性请求头 |
| `withoutRequestVerificationHeaders(headers)` | 原样拷贝（:24） | 从静态配置头里剥离验证头（验证头只能来自运行时） |
| `allowRequestVerificationHeaders(headers)` | 恒 `{}`（:29） | UI 应答的 runtime headers 中，仅 allowlist 内的验证头可注入 |
| `isRequestSecurityFailure(body, codes)` | 恒 `false`（policy.ts:2） | 判断响应体/错误码是否为「安全校验失败」 |
| `isRequestVerificationMessage(message)` | 恒 `false`（:40） | 识别远端验证拒绝文案 → 归一为 `request_verification_unavailable` |
| `requestVerificationTimeoutMessage` | `"Provider runtime headers request timed out. Please send your message again."`（:6） | 验证通道超时的用户文案 |
| `requestVerificationReasons` | `["model-request"]`（:4） | 验证原因枚举目前只有一个值 |

**执行层**（`apps/zcode-cli/packages/adapters/src/model/request-security-edition/`）：

- `recovery.ts`：`RequestVerificationRetry`（`extraAttempts=0`、`claim()` 恒 false）——官方版在被安全校验拒绝后提供**额外重试预算**去完成验证-重试；`isRequestVerificationRejection()` 恒 false——官方版识别「这个错误是验证拒绝」；`createRequestVerificationEmptyStreamError()` 恒 undefined——官方版把「带验证头的空流」合成为验证拒绝错误。
- `index.ts`：`protectTransport` 直接原样返回 transport——官方版在这里对传输做安全加固。**挂载点已定位**：`model-execution.ts:311`，位置在端点路由 fetch 之后、业务错误检测 fetch 之前，包装整个 provider transport（与本项目 zcode-api 的「proxyRequest 出线前叠加」同构）。

**签名握手端点已确认**（复查轮新增）：`POST /api/paas/c1f3a7e2/v2/client`（host `open.bigmodel.cn`）是**签名握手端点**。E2E 配置两处注释直接点明：「签名默认开启后，Account 用例的测试凭据也会发起握手；本地响应避免访问线上」（`packages/desktop/wdio.conf.ts:2324`）、「ToolSearch 的假凭据也会握手；与 Account 用例共用本地失败响应边界」（:2404），mock 一律返回 `{code:500, msg:"E2E handshake unavailable"}`。即：**开源构建的握手发起代码是活的**（zhipu-account access 的 Account 与 ToolSearch 请求默认都会尝试握手），只有握手的具体算法/密钥不在公开仓库内（`protectTransport` stub 的真实实现）。这与 PAT 文档 S01 行「Project Token 遵守官方版本的请求安全校验准入」互证。

**UI 层**（`packages/ui/src/request-security-edition/`）：

- `claim.ts`：`useRequestVerificationPrewarm`（验证预热 hook）、`prepareRequestVerificationClaim`（准备凭证，开源版返回空对象）。
- `index.ts`：`RequestSecurityHost` 组件（返回 null）、`RequestSecurityWorkspaceBridge`（workspace 桥接）——官方版有验证交互 UI/浮层（`additionalRequestModalSelectors` 暗示有 modal）。
- `parity.ts`：`runRequestVerificationParityAssertions`——发行版一致性断言。

### 2.2 运行时流程（Host 侧，实码）

`packages/services/src/zcode-agent/zcodeAgentService.ts:1725-1800`（`routeProviderRuntimeHeadersRequest`）：

1. `requiresRequestVerification(access)` 为真 → 读 `readRequestVerificationConfig()`（实现在 `bigmodelCodingPlanSubscriptionProvider.ts:472-481`：从 `client/configs` 拉，`code!==0 || success===false` 时抛「Request verification configuration is invalid」，**坏配置不能按网络故障自动重试，更不能打开跳过校验**）。
2. 配置读取失败分两类错误码：`configNetwork`（临时网络故障）→ `ZCODE_PROVIDER_CONFIG_NETWORK_ERROR`（下游分类为 `ModelRequestVerificationConfigNetwork`，**可重试**，`failure-classifier.ts:92-100`）；`configInvalid` → fail-closed 直接失败。
3. 配置缺失/无效 → **不跳过校验**，直接失败（fail-closed）。
4. 需要交互且 `requestVerificationInteractionAvailable`（开源版恒 false，verification-policy.ts:54）→ 向 Renderer 发 `providerRuntimeHeaders.request` session 事件等 UI 完成验证；「配置 IO 期间的晚订阅不能抢先启动界面验证」。
5. UI 应答经 `allowRequestVerificationHeaders(params.response.runtimeProviderHeaders)` 过滤后才可注入（zcodeAgentService.ts:6264）。

**CLI 侧**（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/provider-runtime-headers.ts`）：私有 RPC `interactionRequestProviderRuntimeHeaders`，总时限 **180s**（:17，同时覆盖排队与凭据解析），超时码 `-32022`，超时文案即 `requestVerificationTimeoutMessage`；主动取消发 `providerRuntimeHeadersCancelled` 通知释放 Host 队列；头未应用应答 `-32031`。**每次物理 HTTP attempt 前都要刷新**（`docs/model-provider-project-access-token.md:77`：「闲时模型每个物理 HTTP attempt 必须通过现有 Provider Runtime Headers 私有通道向 Host 换取当前 PAT」）。

**子 agent 路由坑**（`docs/agent-subagent-provider-runtime-headers-routing.md`）：Explore 子 agent 的刷新请求必须改用父 task 的 sessionId 发送——按子 sessionId 发会落到无人订阅的通道，子 agent 挂起直到用户 stop。请求彼此隔离：每个子/父模型调用有独立请求期重试预算，唯一 requestId 应答。

### 2.3 拒绝信号 `3007` 的完整处理链

- 上游返回 HTTP **403 + JSON `code:3007`**（也可能是 HTTP 200 SSE 帧内携带）。fetch 边界**不依赖 Content-Type**，非 2xx 一律尝试读 body 解析业务码（`model-execution.ts:702-705` 注释：「zcode-plan 安全校验拒绝（3007）等场景返回 HTTP 403 + JSON，但未必带 Content-Type: application/json。若只在启发式命中时才读 body，流式请求可能以空 completion 结束，core 最终误报 suspicious empty」）。
- AI SDK 可能把 403 JSON 包成 APICallError 而不走 ProviderBusinessError——分类器在通用 403 分支**之前**插入 `classifyProviderBusinessFailureFromApiCallBody`（`failure-classifier.ts:171-179` 注释明说 3007 这个 case），否则会误显示「Provider authentication failed.」。
- 深层挖掘：业务错误可能只出现在 AI SDK finish chunk 的深层 JSON（如 `response.body`），`collectCandidateRecords` 全量 BFS 扫描防止漏检 3007（`provider-finish-business-error.ts:152-158` 注释）。
- 分类：`3007 → code=InvalidModelRequest, reason=AuthFailed, retryReason=AuthRefresh, retryable=false`（`failure-provider-business-codes.ts:100-107`）。
- 流式路径：`isRequestVerificationRejection(err)` 命中**优先于一切分类**直接上抛（`runner-stream.ts:546`、`:580`、`:1309`）——把恢复机会留给官方 recovery 层。
- UI：`PROVIDER_BUSINESS_ERROR_UI_ACTIONS["3007"] = requestVerificationRecoveryAction`（`providerBusinessError.ts:96`；开源版为 null）；文案 `zcode.error.providerBusiness.3007` = 「请求被网关安全校验拒绝，请稍后重试或联系支持。」
- dynamic-workflow 内（子 agent/工具侧）：**`3007` 停止整个 run，归类为 authentication problem**，「official builds first apply their own bounded recovery」（`docs/start-plan-provider-business-errors.md:57-58`）。
- 订阅/计费面：远端错误消息命中 `isRequestVerificationMessage` → 归一为 `REQUEST_VERIFICATION_REQUIRED`（`"request_verification_unavailable"`，`bigmodelCodingPlanSubscriptionProvider.ts:1484-1487`）。
- PAT 侧边界：安全校验自身的错误恢复（`VERIFY_APIKEY_EXPIRED` / `VERIFY_SIGNATURE_INVALID`）**独立于 PAT 401 恢复**，不互相触发（`docs/model-provider-project-access-token.md:110`）。这两个 VERIFY_* 码是本项目已知的签名失败族——ZCode 客户端里它们属于「请求安全校验」体系。**复查确认：这两个码在开源源码里零命中**（`grep -rn 'VERIFY_APIKEY_EXPIRED|VERIFY_SIGNATURE_INVALID'` 无结果），识别与恢复逻辑同样在被剥离的部分，PAT 文档是唯一书面证据。

### 2.4 与购买流程的人机验证

Coding Plan 试算/下单透传 `ticket` + `randstr`（`packages/shared/src/coding-plan-subscription.ts:259-260`，`bigmodelCodingPlanSubscriptionProvider.ts:490-491`）——这是腾讯防水墙（TCaptcha）验证码票据的标准形状，属于购买链路的人机验证，与请求安全校验是两套东西。

---

## 3. 405 状态码的完整结论

**全仓库 405 的业务处理只有一处**：

```ts
// packages/ui/src/lib/chatErrorAttribution.ts:311-313
if (statusCode === 405) {
  return resolve("invalid_request", "provider");
}
```

文档侧同一结论（`docs/trace/chat-error-banner-attribution.md`，2026-08-17 段）：「HTTP `405` 同样归为 provider 的 `invalid_request`。**这些规则只在 telemetry 归因边界生效，不改变 adapter retry、错误文案或业务动作**」。

要点：

1. **失败分类器（`failure-classifier.ts`）没有 405 分支**。404 有专支（`ModelNotFound`，:414）、400/422 有专支（:426）、429/401/403/5xx/529 都有——405 落到最后的 fallback：`code=ModelRequestFailed, reason=Unknown, retryable=false`（:474-482）。**不重试、不恢复、无特殊文案**。
2. 客户端立场：405 = provider 侧认为「这个方法/路径不该收到这种请求」——**请求构造问题**（端点映射错、路径错），修代码而不是重试。这与 3007（403，可走官方恢复）形成鲜明对照。
3. 其余 405 命中与风控无关，均为本地服务的 method-not-allowed：`offPeakMockGateway.ts:526`（mock 网关对 GET 打 POST 端点）、`pluginSandbox/protocol.ts:141`、`browser-local-preview/index.ts:55`、`remoteMediaPreviewProxy.ts:274`。

---

## 4. 身份仿冒面：头层与体层指纹

### 4.1 共享来源头（App 服务层：billing / client-configs / OAuth / feedback 等 ZCode endpoint 请求）

真源 `packages/shared/src/zcode-source-headers.ts:30-59`（`buildZCodeSourceHeadersFromContext`），App 层包装 `packages/services/src/providers/sourceHeaders.ts:65-90`（读 `telemetry-state.json` 的 deviceMid，**只读不生成**）：

| 头 | 值 | 备注 |
|---|---|---|
| `User-Agent` | `ZCode/<appVersion>`（缺省 `ZCode/unknown`） | |
| `HTTP-Referer` | ZCode endpoint origin（`https://zcode.z.ai`） | |
| `X-Title` | `Z Code@<sourceTitle>`，`cli` 或 `electron` | CLI 按进程参数探测（`bootstrap/src/model-config.ts:78-81`） |
| `X-ZCode-App-Version` | appVersion | 有值才带 |
| `X-Platform` | `<platform>-<arch>`（如 `darwin-arm64`） | 有值才带 |
| `X-Release-Channel` | `ZCODE_ENV`（production/test） | 有值才带 |
| `X-Client-Language` | 进程 locale | 桌面端实时跟随 UI 语言（`docs/zcode-endpoint-client-language-header.md`：Main 持有 `currentApplicationLocale` 为实时 owner，`setting.json` 仅重启恢复） |
| `X-Client-Timezone` | 进程 timezone | |
| `X-Os-Category` | `macos`/`windows`/`linux` | |
| `X-Os-Version` | OS release | |
| `X-Device-Mid` | deviceMid UUID | **有值才带；`billing/balance` 把它当必填，缺失返回 `400 code 3001 parameter error`**（`docs/zcode-endpoint-device-mid-header.md:13`） |

值全部过 `normalizeZCodeSourceHeaderValue`（仅 ASCII 可打印，非法/空则整个头省略——不伪造）。

### 4.2 设备身份 deviceMid 的生命周期

`docs/zcode-endpoint-device-mid-header.md`：

- 存储于 `{appConfigDir}/telemetry-state.json` 的 `deviceMid` 字段，同名 `.lock` 互斥；各运行环境共享同一文件、同一字段、同一把锁（桌面 main 窗口创建前同步确保；独立 Server 在 `createServerHostServices()` 创建 services 前 `ensureTelemetryDeviceMid()`；旧 stdio entry 在 services 创建前自行确保；CLI 在首次模型请求时自行确保）。
- **远端（SSH/WSL/Docker）拥有自己的设备身份，不借用不下发桌面 deviceMid**；同一远端被多台桌面连接时身份稳定。
- 确保失败（文件系统/锁异常）只 warn 继续，**请求省略该头，不伪造设备 ID**。

### 4.3 请求体层指纹：Anthropic `metadata.user_id`

`docs/anthropic-request-metadata.md`（zcode-cli 事实规范）：所有 Anthropic 格式模型请求必须携带：

```json
{ "metadata": { "user_id": "{\"device_id\":\"<deviceMid UUID>\",\"account_uuid\":\"\",\"session_id\":\"<session id>\"}" } }
```

- `device_id` = deviceMid 原样 UUID；`account_uuid` 固定空串；`session_id` 复用 `x-session-id` 的归一化（剥 `sess_`/`subagent_agent_` 前缀，无上下文时空串）。
- 请求级 metadata **必须覆盖** provider 静态配置的 `anthropic.metadata.userId`——防止静态配置把旧设备/旧会话身份带入新请求。

### 4.4 模型请求归因头族（CLI 模型层）

`apps/zcode-cli/packages/adapters/src/model/runner-attribution.ts:36-66`（`createModelRequestAttributionHeaders`）：

| 头 | 值 | 风控含义 |
|---|---|---|
| `x-request-id` | 每请求 requestId | |
| `x-session-id` | sessionId，**剥 `sess_`/`subagent_agent_` 内部前缀**（:105-115） | 跨网络观测字段，不暴露实现前缀 |
| `x-zcode-session-type` | `main`/`subagent`/`side_chat`/`other` | **「Coding Plan 服务端使用该请求级 Header 区分 main/subagent/side_chat/other 来源」**（:24-25 注释）——服务端按请求来源风控归类的直接证据 |
| `x-zcode-trace-id` | traceId | |
| `x-query-id` | queryId（剥 `query_` 前缀） | |
| `x-zcode-query-source` | `main_turn`/`compact` 等（pattern `[A-Za-z0-9_.:-]{1,128}`） | 观测标识；非法只省略不阻断请求 |
| `x-zcode-session-features` | 会话能力标签逗号拼接（去重、字典序、每项 `^[a-z0-9_]{1,64}$`、总长 ≤256，任一非法**整头省略**） | 标签：`browser_use`/`computer_use`/`tool_search_called`/`tool_search_local`/`tool_search_native`/`workflow_auto`/`workflow_cmd`（`invocation-context.ts:19-34`） |
| `x-opencode-session` | 仅 openCode 网关 | |

纪律：「只能由调用上下文生成的归因头：provider 静态值和 SDK 默认值一律剔除，缺失时也不回退」（`model-request-headers.ts:5-9`）；`withoutContextOwnedModelHeaders` 强制剥离静态配置里的同名头。头合并且大小写归一去重（:33-47）。

CLI 模型执行层默认头（`bootstrap/src/model-config.ts:59-72` `buildCliZCodeSourceHeaders`）与 App 层同表但：**无 `X-Device-Mid`**、多一个 **`X-ZCode-Agent: glm`**（固定值）。Anthropic 兼容网关同时读 `x-api-key` 与 Bearer `Authorization`，显式配置的 Authorization 优先（`model-execution.ts:444-452`）。

### 4.5 凭据头的请求期覆盖纪律

`zhipu-account` access 型 Provider：静态认证头先被 `withoutModelAuthHeaders` 剥掉（authorization/x-api-key），再合并请求期 `requestAuth.headers`（`model-execution.ts:430-437`）——「账号动态身份头必须先清理静态认证头，避免 SDK 优先使用旧凭据」。敏感头（authorization/cookie/x-api-key/`x-off-peak-ticket-id` 等）在日志层统一 `[redacted]`（`runner-network-headers.ts:7-16`）。

---

## 5. 业务错误码 → 分类/重试决策全表

### 5.1 zcode-plan / Start Plan 码（`providerBusinessError.ts:16-31` 契约表 + `failure-provider-business-codes.ts:53-292`）

| 码 | 语义 | HTTP | 分类 reason | 自动重试 | UI 动作 |
|---|---|---|---|---|---|
| `1005` | Start Plan 配额耗尽 | 200 | InvalidRequest | 否 | refresh-quota（升级横幅，不锁 composer） |
| `1006` | JWT 缺失/失效 | 200 | AuthFailed→AuthRefresh | 否 | login |
| `2007` | 上游 HTTP 异常 | 500 | ServerError | **是** | retry-later（重试前刷新配额快照，防本地误扣额度 :277） |
| `3001` | 参数错误 | 400 | InvalidRequest | 否 | 无（off-peak 旧网关兼容：3001 亦视为票据过期，`offpeak-retry.ts:36`） |
| `3002` | 请求过频 | 429 | RateLimited | **是** | retry-later |
| `3006` | 模型不可用 | 400 | InvalidRequest（ModelNotFound） | 否 | switch-model（响应可带 `allowed_models` 候选列表，`provider-finish-business-error.ts:225`） |
| **`3007`** | **安全校验拒绝** | **403** | **AuthFailed→AuthRefresh** | **否**（官方版走有界恢复） | 官方恢复动作 / 提示联系支持 |
| `3008` | 会话并发上限 | 429 | RateLimited | 否（特例见「并发限制的细粒度豁免」） | upgrade |
| `3009` | 模型级并发上限 | 429 | RateLimited | 否（特例见「并发限制的细粒度豁免」） | upgrade |
| `3010` | 当前模型并发上限 | 429 | RateLimited | 否（特例见「并发限制的细粒度豁免」） | upgrade |
| `3102` | 闲时票据过期（ready 过号） | 400 | ticketExpired | 否 | 无（过号需新票，横幅重试救不了） |
| `3104` | 其他无效票据 | 400 | ticketExpired | 否 | 同上 |
| `3105` | 闲时排队 | 429+Retry-After | OffpeakQueued | **是（不耗预算）** | — |
| `3106` | 闲时运行超时 | 400 | ticketExpired | 否 | 明确提示运行超时 |

### 5.2 BigModel / Z.AI 兼容接口码（`docs/bigmodel-business-error-retry.md` 权威表 + 映射表实码）

**会重试**（仅在尚未向用户产出已提交模型事件时；已产出 `text_delta`/`tool_call`/`finish` 不重放，防重复文本/工具调用）：

| 码 | 语义 | 分类 | retry reason |
|---|---|---|---|
| `1120` | **临时账号访问异常**（风控相关：账号被临时标记） | model_request_failed | server_error |
| `1230` | API 调用流程异常 | model_request_failed | server_error |
| `1234` | 网络错误 | model_request_failed | network_error |
| `1302` | 并发过高 | rate_limited | rate_limited |
| `1303` | 调用频率过高 | rate_limited | rate_limited |
| `1305` | 平台流量限制/过载 | rate_limited | rate_limited |
| `1312` | 模型访问负载过高 | provider_overloaded | provider_overloaded |
| `3002` | 请求过频 | rate_limited | rate_limited |
| `2007` | 上游异常 | server_error | server_error |

**不重试**（即使由 HTTP 429 携带也保持非重试）：

| 码 | 语义 | 备注 |
|---|---|---|
| `1113` | provider 明确终止型业务错误 | |
| `1261` | 上下文超窗 | context_exceeded |
| `1304` | 日调用限制 | |
| `1308` | 使用量上限 | |
| `1309` | Coding Plan 到期 | |
| `1310` | 周/月额度上限 | |
| `1311` | 套餐无模型权限 | |
| **`1313`** | **fair usage restriction（公平使用限制）** | 「继续 retry 容易放大异常流量」——风控相关 |
| `1314`/`1315` | 终态业务 | TERMINAL_BUSINESS_MAPPING |
| `1316`-`1321` | 额度/套餐边界族 | TERMINAL_RATE_LIMIT_MAPPING（与 `insufficient_quota`/`credit_balance_exhausted`/`2056`/`20097` 等 OpenAI 风格码同表，:297-314） |
| `1008` | 终态业务 | |
| `1301`/`1213`/`3012` | （telemetry 归因层）invalid_request | `3012` 即内容检查拒绝码（`docs/trace/chat-error-banner-attribution.md`） |

SSE 特例：BigModel 强格式前缀 `[1302][...][request_id]`（HTTP 200 的 error frame 里只有 message 没有结构化 code）→ 正则 `^\[(\d{4})\](?=\[)` 提取四位业务码进同一张表（`provider-finish-business-error.ts:6,248-252`；`failure-classifier.ts:638-644`）。

### 5.3 并发限制（3008/3009/3010）的细粒度豁免

`docs/start-plan-provider-business-errors.md`：

- **首轮准入失败不自动重试**：新会话第一轮直接显示「当前系统繁忙，请更换模型、切换到 Coding Plan 订阅，或稍后再试。」
- **已完成至少一轮可见输出后**：`main_turn` 准入 busy 失败允许**短的有界退避重试**（关掉空占位后重发）。
- **流恢复中**（已 running）：允许自动恢复重试；达上限显示「当前系统繁忙，当前自动重试已达到最大次数…」。
- **Goal 完成校验**（`target_completion_verification`）：见过 assistant 输出后可对 3008/3009/3010 用固定小预算重试，防目标循环被瞬时 busy 打断。
- **dynamic-workflow 内**：adapter 分类**不是**重试权威——子 agent/工具侧请求带**无界预算**，3008/3009/3010 在 run 内用正常退避+Retry-After 重试，且每个都作为 **process-wide concurrency governor（进程级并发治理器）** 的节流信号；永不 fail 子 agent、永不弹横幅。`1005` 停 run（quota，可恢复）；`3007` 停 run（auth）。

### 5.4 Retry-After 与退避纪律

`runner-retry.ts:41-63`（`calculateRetryDelay`）+ `docs/bigmodel-business-error-retry.md:40-46`：

- `retry-after-ms` / `retry-after` 优先于本地指数退避；合理上限 **5 分钟**（`MAX_REASONABLE_RETRY_AFTER_MS`，:15）。
- `x-should-retry: false/0` 时**不用** retry-after 驱动等待（`retryAfterSource` 返回 `blocked_by_x_should_retry`，:246-249）——这是上游显式「别再试」信号。
- 使用 provider retry-after 时加**后置**抖动 `[0, min(retryAfter×20%, 5s)]`，绝不早于 provider 要求（1302 风暴教训）；`jitter:false` 时精确等于。
- 本地指数：`baseDelayMs × backoffFactor^(attempt-1)`，cap 到 `maxDelayMs`，jitter 为 `[0.5,1.0)×capped`。
- retry-after 必须贯穿三条路径（fetch 直抛 / error chunk 重建 / `APICallError.cause` 包装）——任何一层丢响应头都会退回本地短退避。
- 重试预算档位：`Unbounded`（0 哨兵）只放宽瞬态放弃条件，退避曲线/分类/边界不宽；`SingleAttempt` 收敛 maxAttempts=1（`retry-budget.ts`）。**鉴权刷新与签名修复的额外尝试不占预算**。
- **默认参数**（`retry-policy.ts:13-30`）：重试 10 次（maxAttempts=11，含首次）、base 2s、factor 2、cap 60s、jitter 开；env `ZCODE_MODEL_RETRY_MAX_RETRIES` 可调。空补全重试上限 **1 次**（`empty-completion-retry.ts:5`，且要求 `attempt < maxAttempts`）。
- 准入控制 `request-admission.ts`：每次尝试发出前 `admitAttempt` 拿票据，退避 sleep 期间**不持票**——进程级 cap 约束的是上游真实看到的在飞数（`model_request_queued`/`model_request_admitted` 事件）。

---

## 6. 凭据层与风控联动：PAT + 双 JWT + 作用域锁

`packages/shared/src/project-access-token.ts` + `docs/model-provider-project-access-token.md` + `packages/services/src/model-provider/accountProviderRequestAuthService.ts`：

### 6.1 账号模式与凭据形态

- `start-plan` → 直接用 OAuth `zcodeJwtToken`（accountProviderRequestAuthService.ts:83-86）。
- `individual-coding-plan` / `team-coding-plan` / `off-peak` → **Project Access Token（PAT）**：平台按「专用 API Key ID」签发的短期 Bearer token（`POST /api/biz/v1/organization/{org}/projects/{project}/api_keys/{id}/access_tokens`，Bearer 登录 JWT，body 带 `clientType=zcode` 与真实 clientVersion）。Key 定位：个人 `zcode-api-key`、团队 `zcode-team-api-key`（keyType=2、usageScene=1）。
- `highspeed`（加速卡）→ 双 JWT + 卡 ID（见「加速卡」）。
- off-peak 模型请求把 PAT 放 **`X-Coding-Plan-Api-Key`** 头（`off-peak-request-auth.ts:30-38`）；普通请求放 `apiKey`（Bearer）。
- **PAT「仍遵守官方版本的请求安全校验准入规则，不能因使用 Token 而跳过」**（`docs/model-provider-project-access-token.md:14`）；`GET /api/v1/agent/configs` 与 `POST /api/paas/c1f3a7e2/v2/client` 同样受安全校验准入（:144 S01 行）——后者是安全校验体系的客户端上报端点（2026-10-09 修正此前 Token 豁免规则）。

### 6.2 PAT 缓存与刷新（`project-access-token.ts:126-237`）

- 提前 **120s + 0-60s 抖动**刷新（`REFRESH_LEAD_MS`/`REFRESH_JITTER_MS`）；`expiresIn` 从签发请求发出时保守起算（不吃网络耗时红利）。
- 并发签发合并（同一 pending）；临时故障（网络/超时/429/5xx）且旧 PAT 仍有效未被拒 → **共享旧值 + 5s 退避**（`project_token_refresh_deferred` 事件），不延长有效期；401/403/404、`enable=false`、畸形响应 → 清缓存立即失败。
- 401 拒绝按 **SHA-256 指纹**只废弃被拒的那一代（`projectAccessTokenFingerprint`，:240-243）——「迟到的 401 不得废弃新凭据或打断正在进行的换证」。

### 6.3 作用域锁（accountScope）

- `accountScope = SHA256([family, planKind, [org,project,product]?, accessToken, zcodeJwtToken?])`（accountProviderRequestAuthService.ts:118-135）——不可逆校验值，不含 PAT 原文、不持久化、不进日志。
- 每个物理 attempt 带上派发时冻结的 `expectedAccountScope`；换证 IO 前后各校验一次（:105-110），账号/项目/套餐中途变化 → `project_token_scope_invalidated`，**不把原票据串到新账号**。
- 模型 401 的 PAT 恢复（`account-request-retry.ts`）：普通 401（非安全校验失败、非其他 auth 拒绝）→ 携带**失败 PAT 指纹**刷新一次 → 新 PAT 重试一次；「401 是尝试恢复的触发条件，不被当作已确认的 Token 过期原因」。预算为 1，二次 401 终止。**手填 Key、Start Plan、加速卡不参与 PAT 恢复**。
- `agent/configs` 的账号标识：不再发 `x-api-key`/Authorization，改发 **`x-api-key-id`**（真实 Key ID，不得把 PAT 改名塞入）。路由缓存进程级：成功 5 分钟、失败 30s 冷却（`docs/model-provider-project-access-token.md:199-210`）。「上游已移除安全校验开关请求：手工 Provider 直接沿用默认安全校验逻辑，只有路由配置读取 agent/configs，且不发送手工 Key」。

### 6.4 Z.AI 业务 JWT（`ZaiBusinessTokenCache`）

- `/api/auth/z/login` 的业务 JWT 按 `expires_in`/JWT `exp` 最早值缓存，提前 120s 刷新；无元数据最多缓存 5 分钟。
- 业务接口 401 → 只允许重换业务 JWT 再重试换证**一次**；403/网络错误不触发；二次 401 清失败 JWT（`docs/model-provider-project-access-token.md:90`）。
- 临时故障降级复用 PAT 同款规则（5s 退避共享旧值，`project_token_business_login_refresh_deferred`）。
- **JWT 过期恢复三态**（`docs/oauth/jwt-expiry-reauthentication.md`）：`authenticated`（本地 `exp` 未过期）/`signed-out`/`reauthentication-required`（`exp` 已过期，须重新登录）。客户端只做本地 `exp` 预判（含时钟偏差）；无法解析或缺 `exp` 时不能证明过期，按兼容缓存处理交给服务端拒绝。**服务端 401/403 的全局失效广播当时（3.x）尚未实现**——401 不会全局触发登出，只走各自的请求级恢复。

---

## 7. 流式风控恢复：空流探测与 thinking 签名修复

### 7.1 空流 / 零输出（suspicious empty）

- 「403 JSON 等业务错误有时不会让 AI SDK 抛出 error chunk，流会以空 completion 结束」（`runner-stream.ts:564-566`）——`isSuspiciousStreamDiagnostics` 命中后先尝试 `detectProviderBusinessFinishError` 挖真因，再试 `createRequestVerificationEmptyStreamError`（官方版：带验证头的空流 → 合成为验证拒绝错误；stub：undefined）。
- 纯零输出（无文本/无工具/无 usage，`isZeroOutputModelCompletion`）→ `empty-completion-retry` 有界重试（空 completion 计数独立于主 retry 预算）。
- core 侧守卫文案：`SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE = "Model returned no text, no tool calls, and no usage before completing the turn."`（`providerBusinessError.ts:2`，UI 归因 `modelSuspiciousEmpty`：「模型没有返回内容（常由 token 过期或套餐问题引起）」——即空流是风控拒绝的常见伪装形态）。

### 7.2 thinking 签名拒绝修复（内容完整性风控）

上游会校验 thinking block 的 signature（防历史篡改）。`reasoning-history-normalization.ts:82-98`：

- 判定：HTTP **400** + 文案含 `"signature in thinking block"`，或（提 thinking block/`thinking`/`redacted_thinking` 且含 `cannot be modified`/`invalid signature`）——窄化匹配，防误伤其他 invalid_request。
- 修复：`removeRejectedReasoning` 清掉被拒 reasoning blocks，**只改本次请求副本不写回 canonical history**（签名只对生成它的 thinking block 有效）；跨模型 reasoning 有独立清理（`removeCrossModelReasoning`，provider 兼容组内不算跨模型）。
- 预算：**一次**额外物理请求（`signatureRepairAttempted` 门闸），不占普通 retry 预算，新 requestId（`runner-stream.ts:200-224`，事件 `model.reasoning_signature_repair.retry`）。

---

## 8. 派生通道的风控：加速卡与闲时

### 8.1 加速卡（Highspeed）

`docs/highspeed/highspeed-card-spec.md` + `runner.ts:181-197`：

- **双 JWT 契约**：`Authorization: Bearer <zcode JWT>` + `X-Bigmodel-Authorization: <业务 JWT>`（抽卡直传不套 Bearer，推理套 Bearer）+ Team 时 `Bigmodel-Target-Type`/`Bigmodel-Organization`/`Bigmodel-Project` + `X-Highspeed-Card-ID`。
- 回归约束原文：「曾经只发 `Authorization` + `X-Highspeed-Card-ID`，网关无法校验 Coding Plan 权益，返回 **`401 auth_failed`**。这套 Coding Plan 头与卡 ID 必须来自同一次 selected connection 解析，**禁止跨 Family 拼接**。」（:85-87）
- 抽卡 `POST /api/v1/highspeed/draw`：1 秒内未返回本轮照常发送（后台完成）；`next_draw_at` 是服务端冷却权威，冷却内不得重复抽卡；一张卡绑定一个 `task_id/provider/model`。
- 推理 `POST /api/v1/highspeed/anthropic/v1/messages`：body 为 Anthropic Messages，`model` 必须与卡绑定一致。
- **任何失败降级**：卡过期 `HTTP 400 / provider_code=3402`、鉴权失败、限流、5xx、网络、超时、流中断——保留已完成工具结果与上下文，把该 Turn 剩余模型请求**切回原模型，只降一次**（`TurnExecutionModelFallback` 事件声明式规则：`3402 → highspeed_card_expired`，其余 `→ highspeed_request_failed`）。失败归因到卡时作废当前卡并保留 `nextDrawAt` 冷却事实，防失败循环。
- 派生 Provider（`account:*-highspeed-card`）无独立权益：发布状态继承母体 Coding Plan 的最终权益结果；母体 `unknown` + 同身份旧权益 → last-known-good available；身份变化 → **fail-closed 下架**（:106-112）。

### 8.2 闲时（Off-Peak）

`docs/off-peak-task/spec.md` + `offpeak-retry.ts`：

- 服务端承载排队（全局 ticket FIFO、按资源空余控并发）；客户端批量 `POST /ticket/status` 观察，`ready` 才派发。
- 排队真实信号 = HTTP 429（`3105` 带 Retry-After；裸 429 同样按排队）→ 等待 `min(Retry-After, 5min)`（无则 60s 探测），**不消耗普通重试预算**（`OffpeakQueued`）。
- `3102`（ready 过号）/`3106`（运行超时，2000s 到顶）/`3104`（无效票据）→ 停止执行记录票据过期，**不自动补号**；仅用户创建/Continue/重试可请求新票。
- 每个 HTTP attempt 经 runtime-headers 通道换当前 PAT（带 `expectedAccountScope`），票据派发时只冻结票据与作用域约束，PAT 不冻结（`docs/model-provider-project-access-token.md:77`）。
- 票据头 `x-off-peak-ticket-id` 列入日志脱敏表（`runner-network-headers.ts:13`）。

---

## 9. 端点路由与环境

- **静态改写表**（`official-coding-plan-gateway.ts:13-15`）：`https://open.bigmodel.cn:443/api/anthropic/v1/messages → /api/v1/ultra/anthropic/v1/messages`；`https://api.z.ai:443/api/anthropic/v1/messages → /api/v1/ultra-zai/anthropic/v1/messages`。「静态实现只提供 URL 决策；Host 清理、请求与响应透传由公共 fetch wrapper 负责」——wrapper 删 `host` 头再套 decision.headers（`provider-endpoint-routing-fetch.ts:44-49`）。
- **动态路由（官方版）被 stub**：`endpoint-routing-edition/index.ts` 直接返回静态表。PAT 文档描述动态行为：路由配置从 `agent/configs` 读，缓存成功 5 分钟、失败 30s 冷却；上游已移除安全校验开关请求（旧版曾用配置开关决定是否做安全校验，现在默认启用）。
- 环境来源：生产 `zcode.z.ai`（`ZCODE_BASE_URL` 权威，production 构建忽略设置覆盖，`docs/zcode-endpoint-switching.md`）；BigModel API `https://bigmodel.cn`（`BIGMODEL_API_BASE_URL` 可覆盖，`docs/bigmodel-api-environment-origin.md`）；ZAI OAuth `https://chat.z.ai`，业务交换 `/api/auth/z/login`（`docs/zai-oauth-environment-origin.md`，client_id `client_P8X5CMWmlaRO9gyO-KSqtg` 两环境相同）。
- Anthropic baseURL 归一：非 `/v1` 结尾的网关根强制补 `/v1`（`model-execution.ts:458-478`）。

---

## 10. UI 归因链（telemetry 边界）

`packages/ui/src/lib/chatErrorAttribution.ts`（优先级从高到低）：

1. 结构化 `reason`（network/runtime 直接采信；`rate_limited` + `retryable=false` + trusted builtin + `quota_exhausted` → 规范为 quota_exhausted，:237-246）
2. `invalid_model_request` + ZCode 自产文案 → runtime/invalid_request（:256-264）
3. legacy 三段式 envelope `[code][message][request-id]` allowlist code（:266-279）
4. `STABLE_ERROR_ATTRIBUTION` 稳定码表（:281-284）
5. trusted provider 业务码（130x/300x 词表只对可信 builtin provider 身份生效，防自定义 provider 同名码误归因，:286-297）
6. HTTP 状态码推导：413+文案 → context_exceeded；**405 → invalid_request**；402+余额文案 → balance_insufficient；401/403 → auth_failed；408/504 → timeout；429 → rate_limited；404/410 → model_not_found；400/422 → invalid_request；5xx → server_error（:299-332）
7. 受控文案（最低优先级，:334-344）；`1301`/`1213`/`3012`/BAD_REQUEST → invalid_request（`docs/trace/chat-error-banner-attribution.md`）

纪律：「无法证明根因时保留 unknown，不通过兜底规则伪造成 provider/network 根因」；业务码词表必须校验 provider 身份（trusted builtin 或严格 envelope），防污染。

---

## 11. 已确认不存在的东西

- **无「必须上报数据才保号」的客户端强制**：遥测（数仓 `/event/report`）与 ARMS RUM 均为**构建期可选能力**（`docs/desktop/build-time-optional-capabilities.md` + `packages/shared/src/env.ts:50-60`）——端点未注入时「遥测事件在发送前直接返回」「ARMS SDK 以 enable=false 初始化」，官方明确支持产出「默认不上报、不自动更新」的构建。上报失败仅有界重试 2 次 + warn 日志（`telemetryCore.ts:470-511`），**无任何业务消费方根据上报失败限制功能**；`ensureTelemetryDeviceMid` 与上报路径解耦（同一状态文件、独立函数，telemetryCore.ts:280-332）。`marketing/touch` 亦是尽力而为。服务端是否用遥测缺失做账号级风控无法从客户端代码证明，但「可选构建 + 失败无回灌」的设计形态表明客户端侧不存在保号上报契约。
- **无 captcha/PoW/challenge 求解逻辑**：全仓搜索 `captcha|proof of work|pow|challenge`（排除 node_modules）仅命中无关文件（浏览器缩放、E2E 覆盖热图、sshAuth、onboarding 渲染器等）。唯一的 captcha 形态是购买链路透传的 TCaptcha `ticket/randstr`（见「与购买流程的人机验证」）。客户端不求解验证码——**请求安全校验的一次性头由官方闭源组件（Host/Renderer 交互）生成**。
- **无 405 重试/特判**（见「405 状态码的完整结论」）。
- `3012` 无客户端侧恢复——只是 telemetry 归因为 invalid_request。
- mock 网关的 405 与风控无关（见「405 状态码的完整结论」）。

---

## 12. 残留不确定项

- 一次性安全头的确切**头名/算法**（对应本项目的 Ed25519 签名 V4 / PoW）在公开仓库不可见——只能确认「存在每请求刷新的一次性动态头 + fail-closed + UI 可交互验证」这个形状，以及**握手端点 `POST /api/paas/c1f3a7e2/v2/client`（`open.bigmodel.cn`）且默认开启**（见「请求安全校验」，E2E 两处注释 + mock）。`protectTransport`（`model-execution.ts:311`）是该体系的传输层挂载点。
- `RequestVerificationConfig` 的 schema 未知（`Record<string, unknown>`）。
- 官方验证 UI 的交互形态未知（`additionalRequestModalSelectors` 暗示 modal，开源版为空数组）。
- **传输面保护旁证**：desktop 与 zcode-server 的 `/ws/host` 握手用一次性能力票据 `x-zcode-rpc-host-capability`——「desktop 先经受保护 HTTP endpoint 申请，再在 `/ws/host` 握手时一次性消费」（`packages/shared/src/channels.ts:615`）。一次性凭证模式在客户端全栈多处复用（ws 握手 / PAT / 安全校验头 / 闲时票据）。

---

## 附：证据文件清单（本仓库内）

核心实现：`apps/zcode-cli/packages/adapters/src/model/`（`model-execution.ts` / `failure-classifier.ts` / `failure-provider-business-codes.ts` / `provider-finish-business-error.ts` / `runner-stream.ts` / `runner-retry.ts` / `retry-budget.ts` / `retry-policy.ts` / `account-request-retry.ts` / `offpeak-retry.ts` / `off-peak-request-auth.ts` / `empty-completion-retry.ts` / `request-admission.ts` / `runner-attribution.ts` / `reasoning-history-normalization.ts` / `official-coding-plan-gateway.ts` / `provider-endpoint-routing-fetch.ts` / `model-request-headers.ts` / `request-security-edition/*` / `endpoint-routing-edition/*`）；`packages/shared/src/`（`request-security-edition/*` / `project-access-token.ts` / `zcode-source-headers.ts` / `coding-plan-subscription.ts`）；`packages/services/src/`（`model-provider/accountProviderRequestAuthService.ts` / `zcode-agent/zcodeAgentService.ts` / `coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts` / `providers/sourceHeaders.ts` / `session/offPeakMockGateway.ts`）；`packages/ui/src/`（`lib/chatErrorAttribution.ts` / `lib/providerBusinessError.ts` / `request-security-edition/*`）；`apps/zcode-cli/packages/bootstrap/src/`（`model-config.ts` / `runtime-platform-headers.ts` / `zcode-protocol/provider-runtime-headers.ts` / `official-command-endpoint/endpoint.ts`）；`apps/zcode-cli/packages/contracts/src/model/`（`invocation-context.ts`）。

文档：`docs/bigmodel-business-error-retry.md`、`docs/start-plan-provider-business-errors.md`、`docs/model-provider-project-access-token.md`、`docs/highspeed/highspeed-card-spec.md`、`docs/off-peak-task/spec.md`、`docs/zcode-endpoint-device-mid-header.md`、`docs/zcode-endpoint-client-language-header.md`、`docs/zcode-endpoint-switching.md`、`docs/anthropic-request-metadata.md`、`docs/agent-subagent-provider-runtime-headers-routing.md`、`docs/zai-provider-connection-auth-boundary.md`、`docs/zai-oauth-environment-origin.md`、`docs/bigmodel-api-environment-origin.md`、`docs/oauth/jwt-expiry-reauthentication.md`、`docs/trace/chat-error-banner-attribution.md`。（`docs/coding-plan/zcode-official-server-mcp-auth-spec.md` 等为官方 MCP/插件通道的身份面，与模型网关风控主线分离，本文不展开。）
