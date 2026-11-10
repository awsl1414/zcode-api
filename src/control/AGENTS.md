# src/control/ — loopback 控制面

> 维护基线：2026-11-10。基线只表示最后核对点，不是内容的有效期。

## FILES
| 文件 | 角色 |
|---|---|
| control.ts | `dispatch` 命令表 + `createControlDispatcher` + 测试入口；回环监听由 `server/control-listener.ts` 直接调传输层 |
| control-types.ts | 命令契约：`ControlCommand`、补丁类型、应答包络、`HandlerContext` |
| control-views.ts | 读模型：账号行 / 额度窗口 / 风控报告 / 代理行 / `ControlState`、`OAuthStatus` |
| control-transport.ts | node:http 监听 + 回环复查 + 读/写 JSON；命令表作为参数注入（不 import control.ts） |
| control-policy.ts | 路由 / 粘性 / 风控策略的校验与应用（唯一写 `broker.routing` 的地方） |
| control-report.ts | 只读聚合（账号表 / 风控报告 / 代理表）+ 领域错误码映射 |
| control.test.ts | 协议回归 |

拆分的判据是职责：`control.ts` 依赖其余五个，反过来不成立。日志缓冲不在本目录，
住 `src/log/buffer.ts`。

## 契约
- 三个消费者，命令语义必须一致：
  - 网页面板：`server/panel.ts` **进程内**复用 `createControlDispatcher`，浏览器对回环
    `POST /api/control`，无第二控制端口（面板与代理同端口，会话 cookie 门控）。
  - CLI 转发：`cli/control.ts` 起一次性 dispatcher，跑着的实例则由
    `server/control-listener.ts` 的独立回环监听接命令。
  - `serve` 回环监听：`server/control-listener.ts` 绑 127.0.0.1、端口由内核分配并写进
    `runtime/control-port.ts` 的端口文件，CLI 靠它找到进程。
- 命令面（按域分组，`ControlCommand` 联合类型是唯一真值）：
  - **运行态**：`status` / `shutdown`（退出时序在装配层 `server/control-surface.ts`：先应答再走与信号同一条路径；没接 `onShutdown` 的入口回 `shutdown_unavailable`）
  - **登录**：`startOAuth` / `deliverOAuthCode`
  - **日志**：`getLogs`（since 游标增量）
  - **请求记录**：`getRequests`（内存最近 N 条）/ `getRequestsHistory`（requests.jsonl 倒序分页，`before` 游标 + `hasMore`）
  - **额度**：`quota`（双平面快照；带 `label` = 立即刷新该账号，应答 `quotaRefreshed` 不带快照）
  - **账号**：`listAccounts` / `addAccount` / `removeAccount` / `setAccountEnabled` / `setAccountConcurrency` / `setAccountWeight` / `setAccountProxy` / `resetAccountOverrides`
  - **路由策略**：`getRoutingPolicy` / `setRoutingPolicy` / `getRiskReport`
  - **统计**：`getUsageStats`（JSONL 首次扫描聚合：总量/时序/六维分组/错误/调度事件/缓存）
  - **导入导出**：`exportAccounts`（含 inline 内容模式）/ `importAccount`（含 content 模式）
  - **其它**：`checkUpdate` / `detectAppVersion` / `getHealthObservation`（纯内存读，回 `healthObservation` 事件；没有 broker 的宿主回 `account_control_unavailable`）
  - **API key**：`listApiKeys` / `createApiKey` / `setApiKeyEnabled` / `resetApiKeyUsage` / `deleteApiKey`
  - **出口代理**：`listProxies` / `addProxy` / `setProxy` / `removeProxy` / `setAccountProxy`
  - **抢活动**（`src/claim/control.ts`，`HandlerContext` 钩子注入，缺省 `claim_unavailable`）：`getClaimOverview`（纯内存读，可随轮询）/ `previewClaimPlans`（实时拉两面活动，**仅手动或进屏触发**）/ `listClaimPlanChoices`（设置页选择器的选项：内部挑一个可领账号拉同一份两面活动，只回名称 / 描述 / 来源 / 优先级 / 时间窗；同样**仅用户打开选择器时触发**）/ `claimNow`（单次领取）。后两条与 `previewClaimPlans` 共用上游调用，差别只在「谁来挑账号」与「回多细」：`previewClaimPlans` 由面板指定账号、回完整活动（账号详情窗用），`listClaimPlanChoices` 由服务端挑一个可领账号、回投影后的选项（设置页用）。
  - 无 `logout` / `setActiveAccount`：多账号下一个进程就是全部账号，删账号用 `removeAccount`。
  - 无代理生命周期命令：命令面只读写状态，不起停代理进程。`ControlState.proxyPort`
    保留是为了 `status` 能应答实际监听端口。
- 错误语义：HTTP 200 带内 `{ok:false, error}`；未知命令回纯 `unknown_cmd` 码，命令名放
  `message` 字段（码要能进面板翻译表，细节不污染码本身）。控制面返回的每个码都要有
  `error.<code>` 的中英翻译键，`page.test.ts` 会扫 `control.ts` 里的错误码字面量核这一条。
- **监听永不绑非回环**：bind 恒 127.0.0.1 + 每请求 remoteAddress 复查（双保险）。

## WHERE TO LOOK
| 任务 | 位置 |
|---|---|
| 加/改命令 | control.ts `dispatch` 表 + `control-types.ts` 的 `ControlCommand` 与应答变体（两处一起改，编译器会抓漏） |
| 面板命令接线 | server/panel.ts（登录页 + `users.json` 会话门控先于 dispatcher） |
| CLI 转发与回环监听 | cli/control.ts（离线目标表）/ server/control-listener.ts（端口文件） |
| 日志游标 | src/log/buffer.ts `LogBuffer`（环形 + since cursor） |
