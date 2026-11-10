# 请求头与工具描述特征审计

核对两类会暴露客户端身份的请求特征：`anthropic-beta` 头，以及工具描述里的品牌词。证据来自官方 ZCode 客户端源码与本机安装的 Claude Code v2.1.319 bundle。

- 性质：**只读调研**。本报告不改任何运行代码（`src/**` 与官方 ZCode 客户端仓库均未改动）。
- 证据分两级，报告中逐条标注：
  - **代码证据**：官方客户端实现里的字面量/判定逻辑（可直接复核）
  - **抓包证据**：真实请求头样本：**未获取到**（见「未验证项与验证方法」）

## 证据来源与复现方法

| 来源 | 位置 | 说明 |
|---|---|---|
| ZCode CLI 源码 | 官方 ZCode 客户端仓库/apps/zcode-cli/**` | 只读；`path:line` 可直接 `sed -n` 复核 |
| 我们的实现 | `src/proxy/{upstream,identity,system-prompt,body-transformer}.ts` | 只读对照（本报告不据此下任何改动指令） |
| Claude Code 实现 | `~/.local/share/claude/versions/2.1.319`（本机安装的 v2.1.319，Mach-O 内嵌 Bun JS bundle） | 用 `strings`/偏移切片提取；下文以 `2.1.319@<offset>` 标注字节偏移，附压缩后的符号名便于二次定位 |
| Claude Code 本机配置 | `~/.claude/settings.json` | 真实部署形态（模型 id 形态）证据 |

Claude Code 的压缩符号名是每个 chunk 独立的（同一名字在不同 chunk 里可能是不同函数），下文引用时都给了 offset，复核请以 offset 为准。

---

## 1. 结论摘要

**问题一（anthropic-beta）**：ZCode CLI 全代码库**只主动设置一个 beta**（`advanced-tool-use-2025-11-20`，且仅当 tool search 开启；关闭时**一个 beta 头都不发**），而 Claude Code v2.1.319 的 beta 注册表有 **40+ 条**、`/v1/messages` 主路径上按模型/组织/远端开关条件性地发送十余条（含自报家门的 `claude-code-20250219`、`oauth-2025-04-20`）。**差集极大**：真实 ZCode 客户端的 beta 集合等价于空集（或仅 tool-search 一条），真源是官方客户端代码，不是 Anthropic 文档里的 beta 清单。

**问题二（tool description 品牌词）**：Claude Code 的工具描述有 **lean / full 两套变体**：full 变体里 `Read` 与 `WebSearch` 确实带 `Claude` / `Claude Code` 品牌词，lean 变体**完全不带**；而 lean 与否由**模型 id** 决定（`claude-3-*` / `haiku` / `sonnet` / `opus-4-0..4-7` 走 full，其余走 lean）。用 Z.AI 模型 id（如本机配置里的 `glm-5.3[1M]`）时 Claude Code 走 **lean ⇒ 工具描述无品牌词**，与 ZCode 自己的描述几乎逐字相同。**故不构成稳定的可识别特征**；只有客户端仍用 `claude-*` 模型 id 时才露出品牌词（边缘场景）。真正稳定的差异不在品牌词，而在**工具集合**（ZCode 独有 `CreateWorkflow`/`ListModels`/`ReadSessionContext`…）与 `x-zcode-session-features` 头。

---

## 2. anthropic-beta 对照表

### 2.1 ZCode CLI 实际发送的 beta

ZCode 只有一处会写 `anthropic-beta`：

| 证据 | 内容 |
|---|---|
| `apps/zcode-cli/packages/contracts/src/tools/tool-search.ts:18` | `export const TOOL_SEARCH_BETA = "advanced-tool-use-2025-11-20";` |
| `apps/zcode-cli/packages/adapters/src/model/tool-search.ts:17-32` | `toolSearchHeaders(headers, enabled)`：`enabled` 为假时**原样返回 headers（不加任何 beta）**；为真时把 `TOOL_SEARCH_BETA` 去重合并进已有的 `anthropic-beta`（大小写不敏感地找已有键） |
| `apps/zcode-cli/packages/adapters/src/model/runner-options.ts:92,152` | 两处调用点，参数是 `input.request.toolSearchEnabled` |
| 全仓 `grep -rn "anthropic-beta"` | 除上述 + 测试外**无其他生产代码**；`packages/desktop` 只有 e2e 断言 |
| `apps/zcode-cli/docs/plan/trajectory/mid-conversation-system-projection-plan.md:43` | 明确写着「不新增、修改或自动注入 `anthropic-beta` / provider header」 |
| `apps/zcode-cli/packages/desktop/test/e2e/helpers/toolsearch-desktop.ts:76,89` | e2e 断言：tool search 开 → 含 `advanced-tool-use-2025-11-20`；关 → **不含** `advanced-tool-use` |

另外，provider 静态配置可以带任意 header（测试夹具里就出现过 `headers: { "anthropic-beta": "mid-conversation-system-2026-04-07" }`，`apps/zcode-cli/packages/adapters/tests/memory-provider-body.test.ts:291`），那是**用户自填**，不是客户端自动注入。

> **ZCode 侧结论：wire 上的 `anthropic-beta` 集合 = ∅（默认）或 `{advanced-tool-use-2025-11-20}`（tool search 开启时），此外可能叠加用户 provider 配置里的静态值。**

### 2.2 Claude Code v2.1.319 会发送的 beta（代码证据）

beta 注册表是 `P(name, header)` 产出的冻结对象，集中在 `2.1.319@261720898`–`261724300`，主排序表 `JMs` / `O$` / `P$` 与 3P 允许集 `UA`：

- `2.1.319@261723581`：`JMs = Object.freeze([gin,Tet,fjn,Cv,mbe,C7,Yvo,yin,n_t,hbe,kMr,PNe,Aet,G0,_in,oUt,pjn,Ret,XB,H2,xet,sUt,Xvo,mjn,nO,VMs,hjn,z0,V0,TV,n9,Kb,sb,N2,DR,ZE,AV,Sin,YMs,iRe,_E,Ud,gbe,K0,Fq,RV]...)`
- `2.1.319@263109279`：主路径有序表 `O$`（含每条 `when` 谓词）+ 每轮表 `P$`
- `2.1.319@263109600` 起：`M$(e)` 逐条求值 → `uie(e)` → `tBn(e,n)`（追加 SDK betas、按 `UA` 过滤 3P）

`/v1/messages` 主路径相关的 beta 与触发条件（谓词为压缩代码原文）：

| beta 头值 | 符号 | 触发谓词（原文） | 备注 |
|---|---|---|---|
| `claude-code-20250219` | `gin` | `(e)=>!e.canonical.includes("haiku")`；`tBn` 里 `isAgenticQuery` 时强制补 | **自报家门** |
| `oauth-2025-04-20` | `Tet` | `()=>At()` \|\| `ybe()&&!uIr()&&bc()` | OAuth/一方部署 |
| `interleaved-thinking-2025-05-14` | `fjn` | `(e)=>!i.DISABLE_INTERLEAVED_THINKING&&e.interleavedThinking` | 思考模型常见 |
| `context-1m-2025-08-07` | `Cv` | `(e)=>Yh(e.model)&&!fT(e.model,{byItsOwnName:!0})`；`Yh`=`/\[1m\]/i.test(model)`（`2.1.319@263095638`） | **模型 id 带 `[1m]` 就触发** |
| `context-management-2025-06-27` | `mbe` | `(e)=>{let n=i.USE_API_CONTEXT_MANAGEMENT&&!1,r=E$(e.model);return e.firstPartyCapabilityBetas&&(n\|\|r)}`；`E$`→ 非 `claude-3-*` 即真（`@263105571` 段） | |
| `structured-outputs-2025-12-15` | `C7` | `e.firstPartyCapabilityBetas&&Y1n(e.model)&&k("tengu_tool_pear",!1)` | 远端开关，默认 false |
| `web-search-2025-03-05` | `Yvo` | `e.provider==="vertex"\|\|"foundry"` | 仅云厂商 |
| `prompt-caching-scope-2026-01-05` | `PNe` | `()=>f7()`（firstParty + `Ti()`） | |
| `redact-thinking-2026-02-12` | `pjn` | `e.firstPartyOnlyBetas&&e.interleavedThinking&&!ye()&&!V1n()` | |
| `per-turn-control-2026-07-01` | `TV` | `e.perTurnTiming\|\|T1n(e.model,e.canonical)` | `P$` |
| `timing-2026-09-09` | `n9` | `e.perTurnTiming` | `P$` |
| `mid-conversation-tool-changes-2026-07-01` | `Kb` | `bOr()&&NAe(e.model)` | `P$` |
| `inline-tools-2026-09-15` | `sb` | `bOr()&&NAe(e.model)&&Bon()` | `P$` |
| `tool-provenance-2026-10-26` | `z0` | `()=>x$()` | `P$` |
| `advanced-tool-use-2025-11-20` | `yin` | tool search 路径 | **与 ZCode 唯一重合的一条** |
| `tool-search-tool-2025-10-19` | `n_t` | tool search 备选 | ZCode 不发 |
| `mid-conversation-system-2026-04-07` | `V0` | `u7(e.model)` | **`Ld(...)` 定义 → `header:null`，只走 body 不走头**（`@261723581`） |

另外两条非注册表来源：
- `ANTHROPIC_BETAS` 环境变量：`M$` 里读，逐条 `QMs(h)` 追加；其中 `mid-conversation-system-2026-04-07` 会被明确跳过并打日志（`@263109600` 段）
- SDK 传入的 betas（`tBn` 里的 `jp()`）：非一方部署时只保留 `UA` 集合内的 `{gin,fjn,Cv,mbe,C7,Yvo,hbe,n_t,H2,_E,AV,V0,XB,RV,gbe}`（`@263110600` 段）

注册表里还有一批**不属于 `/v1/messages`** 的（`files-api`/`dreams`/`deployments`/`ccr-byoc`/`request-tags`/`oidc-federation` 等，见 `2.1.319@128140188` 字符串表），本文不列。

### 2.3 本机真实部署形态下的"最可能实际发送集"

`~/.claude/settings.json` 里 Claude Code 被指向本地代理（`ANTHROPIC_BASE_URL=http://192.168.255.209:3065`），模型 id 是 `glm-5.3[1M]` / `deepseek-v4.1-flash-router[1M]`。按上表谓词推断（**未抓包**）：

```text
claude-code-20250219
oauth-2025-04-20            (取决于凭据形态 At())
interleaved-thinking-2025-05-14
context-1m-2025-08-07       ← 因为模型 id 带 [1M]
context-management-2025-06-27
prompt-caching-scope-2026-01-05
mid-conversation-tool-changes-2026-07-01 / inline-tools-2026-09-15  (取决于 bOr())
```

即：**至少 5 条、多则 8~9 条**，与 ZCode 的 0~1 条形成鲜明反差。其中 `claude-code-20250219` + `oauth-2025-04-20` 是**直接自报客户端身份**的字符串。

### 2.4 差集

| 类别 | 内容 |
|---|---|
| **两边都有** | `advanced-tool-use-2025-11-20`（ZCode 的 tool search；Claude Code 的 tool search 路径） |
| **只在 Claude Code 侧** | `claude-code-20250219`、`oauth-2025-04-20`、`interleaved-thinking-2025-05-14`、`context-1m-2025-08-07`、`context-management-2025-06-27`、`structured-outputs-2025-12-15`、`web-search-2025-03-05`、`prompt-caching-scope-2026-01-05`、`redact-thinking-2026-02-12`、`per-turn-control-2026-07-01`、`timing-2026-09-09`、`mid-conversation-tool-changes-2026-07-01`、`inline-tools-2026-09-15`、`tool-provenance-2026-10-26`、`tool-search-tool-2025-10-19` 及注册表里其余 20+ 条 |
| **只在 ZCode 侧** | 无（ZCode 不额外注入任何 beta） |

### 2.5 差集的含义

差集极大：客户端侧多出来的 beta 是**机器可读、离散、可枚举**的字段，其中 `claude-code-20250219`、`oauth-2025-04-20` 直接写明客户端身份，与 `User-Agent: ZCode/…` 构成内部不一致——这是比 system 里一句身份声明更容易被规则化检测的异常信号。官方 ZCode 正常流量里 `claude-code-*` / `oauth-*` / `context-management-*` 的出现概率是 0。

真实 ZCode 客户端的 beta 集合只有一个真源，不在 Anthropic 文档里：`apps/zcode-cli/packages/contracts/src/tools/tool-search.ts:18`（`TOOL_SEARCH_BETA`）与 `apps/zcode-cli/packages/adapters/src/model/tool-search.ts:17-32`（唯一注入点与开关语义）——默认空集，仅 tool search 开启时发 `advanced-tool-use-2025-11-20`。

---

## 3. tool description 品牌词对照

### 3.1 Claude Code：lean / full 两套变体，品牌词只在 full 变体里

关键判定（`2.1.319@264447955`–`264448100`）：

```js
function _t(e){let n=rt(e,{deterministic:!0}),r=Rw(n,"lean_prompt",e);if(r!==void 0)return!r;
  return n.includes("claude-3-")||n.includes("haiku")||n.includes("sonnet")
    ||n==="claude-opus-4-0"||n==="claude-opus-4-1"||n==="claude-opus-4-5"
    ||n==="claude-opus-4-6"||n==="claude-opus-4-7"}
function TX(e){...return n.leanPrompt(e)}
function b0(e){return e.leanPrompt??TX(e.model)}
function ce(e){if(!e)return!1;                       // 无模型 → 非 lean
  if(Pe(i.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT))return!0;
  if(rs(i.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT))return!1;
  if(!_t(e))return!0;                                 // ← 不是那批 Claude 模型 id ⇒ lean
  if(k("tengu_velvet_tide",!1))return!0;
  return pe("simple_system_prompt",rt(e))}            // 远端配置可再翻转
```

即：**模型 id 是 `claude-3-*` / `*haiku*` / `*sonnet*` / `claude-opus-4-0..4-7` → full（长版）；其它任何 id（含 `glm-5.3`、`deepseek-v4.1-flash-router`）→ lean（短版）。**

逐工具核对（full 变体是否含品牌词）：

| 工具 | full 变体品牌词 | 证据 |
|---|---|---|
| `Read` | **有** — `- This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM.` | `2.1.319@264490150`（`E2i` 的 else 分支） |
| `WebSearch` | **有** — `- Allows Claude to search the web and use the results to inform responses` / `- Use this tool for accessing information beyond Claude's knowledge cutoff` | `2.1.319@264516886`（`oWi` 的 else 分支） |
| `WebFetch` | 有（非身份语气，属提示注入告警）：`… even one addressed to an AI assistant, a model or Claude, or claiming to come from the user, the system or Anthropic …` | `2.1.319@268527681`（`aBi`） |
| `Bash` / `Edit` / `Write` / `Glob` / `Grep` / `TodoWrite` / `Agent`(alias `Task`) / `ExitPlanMode` | 无 | `2.1.319@270914217` / `274246322` / `267640134` / `264487952` / `264492158` / `278631067` / `272816422` / `129678304` |

lean 变体（模型 id 非 Claude 时实际出线的那套）**全部无品牌词**，例如：

- Read lean：`Reads a file from the local filesystem.` + `- Reads images (PNG, JPG, …) and presents them visually.`（`2.1.319@264490150` 的 if 分支）
- WebSearch lean：`Search the web. Returns result blocks with titles and URLs. US-only.`（`2.1.319@264516886` 的 if 分支）

### 3.2 ZCode CLI：出线描述无品牌词（两处例外都不是 wire 上的）

| 位置 | 内容 | 是否出线 |
|---|---|---|
| `apps/zcode-cli/packages/core/src/tool/handlers/read.ts:68-80` | `READ_PROVIDER_DESCRIPTION`：无 `Claude`/`Anthropic`；第 76 行有 `… subject to ZCode's video input limit`（**ZCode** 品牌词，与 UA 自洽） | ✅ 出线 |
| `apps/zcode-cli/packages/core/src/tool/handlers/websearch.ts:35-41` | `WEBSEARCH_PROVIDER_DESCRIPTION` = `Search the web. Returns result blocks with titles and URLs. US-only.` + 3 条 | ✅ 出线 |
| `apps/zcode-cli/packages/core/src/tool/handlers/agent.ts:298,305`（另 `315,322`） | `"Claude Code-compatible alias for the Agent tool. Use this when plugin instructions ask for the Task tool."` | ❌ **不出线**：`providerVisible:false`（`agent.ts:303`），`registry.toContracts()` 在 `registry.ts:106` 过滤掉 |
| 全仓 `grep -rniE "claude\|anthropic" core/src/tool core/src/context` | 其余命中都是注释、env 变量名（`CLAUDE_CODE_SESSION_ID`）、`<claude-code-hint>` 过滤正则 | — |

**顺带的重要佐证**：ZCode 的 `Read` / `WebSearch` 描述与 Claude Code 的 **lean 变体几乎逐字相同**（连 `- When you already know which part of the file you need, only read that part.` 和 `(provided in the conversation below)` 这种占位都一致，见 `websearch.ts:36-40` 与 `2.1.319@264516886`）。这说明 ZCode 当初就是照抄 Claude Code 的 lean prompt，也就解释了为什么"工具描述"这条特征在常见形态下**天然重合**。

### 3.3 是否构成可识别特征？

**结论：在真实部署形态下不构成稳定特征；仅在客户端保留 `claude-*` 模型 id 时构成。**

判断与依据：

1. 要把 Claude Code 指到我们的代理上，必然要把模型 id 换成上游认得的名字（本机就是 `glm-5.3[1M]`）。此时 `_t(canonical)` 为假 ⇒ `ce` 返回真 ⇒ **lean** ⇒ 工具描述无品牌词，与 ZCode 出线描述同源。
2. 反例只发生在 `ANTHROPIC_MODEL=claude-sonnet-4-5` 这类配置（`_t` 为真 ⇒ full）。此时 `Read` 会带 `Claude Code is a multimodal LLM`、`WebSearch` 会带 `Allows Claude to search the web`，而请求头却是 `User-Agent: ZCode/…`，属于**内部不一致**，与客户端身份归一规则里的 C1 问题同类。
3. 即便品牌词出现，其**信息量也低于另外两个更稳定的差异**：
   - **工具集合差异**：ZCode 独有 `CreateWorkflow`/`AmendWorkflow`/`ListModels`/`ReadSessionContext`/`TaskOutput`/`TaskStop`/`SendMessage`/`EnterPlanMode`/`Cron*`/`escalate`/`submit_result` 等（`apps/zcode-cli/packages/contracts/src/tools/*`、`core/src/tool/handlers/index.ts`）；Claude Code 独有 `NotebookEdit` 等。工具名列表本身就是指纹。
   - **`x-zcode-session-features` 头**：ZCode 每次请求带（`apps/zcode-cli/packages/adapters/src/model/model-request-headers.ts:4`，写入点 `runner-attribution.ts:61`），Claude Code 从不发。

### 3.4 品牌词的识别价值

常见形态（非 Claude 模型 id）下品牌词根本不出现，所以它不是稳定特征；只有客户端保留 `claude-*` 模型 id 时才会露出，届时与 `User-Agent: ZCode/…` 构成内部不一致。工具描述属于 `tools` 数组，它本身就是提示词，改动会直接影响模型行为，因此这条特征的处置判断不宜只看品牌词，而应看工具集合与 `x-zcode-session-features` 这两个更稳定的差异。

---

## 4. 未验证项与验证方法

| # | 未验证项 | 为什么没验证 | 验证方法 |
|---|---|---|---|
| 1 | **两个客户端的真实请求头样本（抓包）** | 本机没有 `ZCODE_DUMP_UPSTREAM` 产物（`~/.zcode-proxy/` 只有 `credentials.json`），`~/.claude/debug/latest` 为空，无历史请求日志 | 起代理时设 `ZCODE_DUMP_UPSTREAM=/tmp/p8b.jsonl`（`src/proxy/dump.ts` 已实现 `client_in` 阶段头转储），分别用 (a) 真 ZCode CLI、(b) Claude Code + `claude-sonnet-4-5`、(c) Claude Code + `glm-5.3[1M]` 各发一次请求，比对 `client_in` 的 `headers` |
| 2 | **Claude Code 实际默认发出的 beta 全集** | 部分谓词依赖远端配置（`Bd()` 下发的 `tengu_*` / `simple_system_prompt`）、组织策略与模型注册表（模型能力来自远端，不在二进制里） | 同上抓包；或 `CLAUDE_CODE_DEBUG=1` 观察；或把 `ANTHROPIC_BETAS` 设为空后对比 |
| 3 | **`@ai-sdk/anthropic@3.0.81` 是否自行注入 beta** | 参考仓库未装依赖（无 `node_modules`），无法读 provider 源码 | 在 ZCode checkout 里 `pnpm install` 后 `grep -rn "anthropic-beta" node_modules/@ai-sdk/anthropic/dist` |
| 4 | **上游网关对未知 beta 的反应**（是否 3012 / 是否忽略） | 约束禁止发真实网络请求 | 用一次性账号 + `curl` 直打上游，分别带 `anthropic-beta: claude-code-20250219` / 空，比对状态码与错误体；或查网关侧日志 |
| 5 | **`At()` / `bOr()` / `Ti()` 等压缩谓词的精确语义** | 压缩符号，只能从调用点推断，未逐条展开 | 抓包对照（同 #1），或读 Claude Code 的 `sdk.d.ts`/源码映射（本版本未提供） |

---

## 5. 身份归一的覆盖缺口（实测补充）

用 v2.1.319 的真实系统提示字符串只读跑 `normalizeClientSystemText`，记录哪些形态已被覆盖、哪些漏掉。这补充了「结论摘要」之外的第三条泄露点：主身份句之外的子代理 system 提示。

| v2.1.319 里的真实系统提示开头 | 归一结果 |
|---|---|
| `You are Claude Code, Anthropic's official CLI tool for Claude.`（`2.1.319@267358381`，变量 `T`） | ✅ → `You are ZCode, an interactive agent.` |
| `You are Claude Code, Anthropic's official CLI tool for Claude, running within the Claude Agent SDK.`（同处，变量 `D`） | ⚠️ 部分 → `You are ZCode, ZCode CLI for Claude, running within the Claude Agent SDK.`（残留 `for Claude` / `Claude Agent SDK`，且出现 `ZCode, ZCode CLI` 重复） |
| `You are a file search specialist for Claude Code, Anthropic's official CLI for Claude.`（`2.1.319@135932898`，Explore 子代理） | ❌ 未变 |
| `You are a web-reading specialist for Claude Code, Anthropic's official CLI for Claude.`（`2.1.319@136306484`） | ❌ 未变 |
| `You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, …`（`2.1.319@271788786`，通用子代理） | ❌ 未变 |
| `You are a Claude agent, built on Anthropic's Claude Agent SDK.`（`2.1.319@267358381`，变量 `U`） | ❌ 未变 |

规律：只有与主身份句逐字相同的那一条被覆盖，带后缀的 `D` 形态被半改写，子代理的 system 提示整体漏掉。这说明按「主身份句」写的规则天然只覆盖一个入口，子代理是独立的泄露面。

「官方 ZCode CLI 本身就是 Claude Code 的兼容实现」+「工具集同名同构」这一判断成立（Claude Code 2.1.319 的 agent 工具名是 `Agent`、别名 `Task`（`2.1.319@264050290/264050648`），ZCode 也有 `agentToolEntry` + `taskToolEntry` 别名，见 `core/src/tool/handlers/agent.ts:296-310`），所以「唯一真正的泄露点」这一说法不成立：`anthropic-beta` 与本节的子代理 system 提示是另外两个独立的泄露点。
