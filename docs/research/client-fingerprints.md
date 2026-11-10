# 多客户端身份特征盘点

盘点除 Claude Code 之外哪些客户端会把身份句带进 block 3、身份句的字面量，以及现有归一规则对这些字面量的覆盖情况。证据来自 `system-prompts-and-models-of-ai-tools` 资料仓库、未合入 PR、本机客户端配置与本项目归一函数的实测。

- 性质：**只读调研**。未改任何运行代码（`src/**` 未动），未改资料仓库（只读），未发真实网络请求。
- 证据分级（逐条标注）：
  - **代码证据**：本项目源码里的字面量/判定逻辑，可用 `sed -n` 直接复核
  - **资料证据**：资料仓库里的 prompt 原文，标注 `path:line`
  - **PR 证据**：`gh pr diff <n>` 的内容，标注「PR 号 + 新增文件路径 + 行号」
  - **实测**：用真实函数 `normalizeClientSystemText` 跑过（见「我们的归一覆盖情况」）
  - **未验证**：只有常识没有证据，明确标注，不推测填充
- 证据位置约定：资料仓库用 `path:line`（相对资料仓库根）；本项目用 `文件:行`；PR 新增文件用「PR #n 新增文件 `path:line`」

## 0. 结论摘要

1. **扫了 32 个客户端目录、48 份主 prompt 文件**（全仓 `.txt`/`.yaml` 共 96 份），提取到 **58 条不同字面量的身份句**，按句式归为 **8 类模板**（见「身份句分类」、附录 B）；另有 4 条来自未合入的 PR。**没有一份资料里出现当前 Claude Code 的身份句** `You are Claude Code, Anthropic's official CLI tool for Claude.`：资料仓库最新只到 Claude Code 2.0.0（`Anthropic/Claude Code 2.0.txt`，2025-09-29），比现有归一规则对应的客户端版本更旧。
2. **现有规则实测只覆盖 1 条身份句**（Claude Code 2.1 那句）。拿 50 条代表性身份句去跑真实函数，**49 条 `no-match`**（见「我们的归一覆盖情况」，用真实函数跑的，不是读代码推断）。
3. **泄露点有两类，现有规则只处理了一类**：
   - **A 类 产品自称句**：`You are Cursor` / `You are Cline` / `You are v0` / `You are Qoder`……（身份归一规则已覆盖）
   - **B 类 模型归属句**：`You are powered by the model named Sonnet 4.5. The exact model ID is claude-sonnet-4-5-20250929.`：这句在 Claude Code 2.0、opencode、Kilo Code 里**逐字相同**，直接和 `User-Agent: ZCode` + 上游实为 GLM 的事实三向矛盾。**身份归一规则里没有这一类**。
4. **一个工程陷阱**：`Trae/Chat Prompt.txt` 的身份句用 **NBSP（U+00A0）** 当词间空格（`You\u00a0are\u00a0Trae\u00a0AI`）。逐字精确匹配规则会**静默失效**，实测已确认。全仓扫下来 NBSP 只出现在 2 份文件（`Trae/Chat Prompt.txt` 520 处、`OpenCode/Agent Prompt (muse.spark…)` 9 处），后者只在 markdown 标题的破折号后（`# Communication – Tone`），不影响身份句。
5. **两条路由的覆盖差异**：`src/proxy/body-transformer.ts` 的 `applyStartPlanOpenAISystem` 只往 `messages` 前面插官方 system 段，客户端自己的 system 消息不经归一；Anthropic 路由才把客户端文本放进 block 3。见表「路由级缺口」。
6. **触达面分层**：能改 Base URL 的 CLI / agent harness（A 组）才会连到我们；IDE 插件（B 组）的 Base URL 可改性未完全验证；网页 SaaS（C 组）改不了 Base URL，架构上连不到。判据是「能改 Base URL」+「身份句可精确匹配」+ 用户基数。

---

## 1. 证据来源与复现

| 来源 | 位置 | 复现方式 |
|---|---|---|
| 资料仓库 | `system-prompts-and-models-of-ai-tools` 资料仓库（只读） | `sed -n '<line>,<line>p' '<file>'` |
| 我们的实现 | `src/proxy/system-prompt.ts:81-94`（三条规则常量）、`:110-115`（`normalizeClientSystemText`） | `sed -n '81,115p'` |
| 归一注入点 | `src/proxy/system-prompt.ts:132-135`（`blockThreeText`）、`src/proxy/body-transformer.ts:192-216` | `sed -n` |
| 未合入 PR | `gh pr list --repo x1xhlol/system-prompts-and-models-of-ai-tools --limit 30 --state all` | `gh pr diff <n> --repo …` |
| 客户端 Base URL 能力 | `qoder2api-hub/docs/clients.md`（sibling 仓库）（同机 sibling 仓库，只读）+ 本机已装客户端 bundle | 见「客户端清单与身份句」逐行证据 |
| 归一实测 | `bun -e 'import {normalizeClientSystemText as n} from "./src/proxy/system-prompt.ts"; …'` | 见「我们的归一覆盖情况」 |

资料仓库 HEAD：`162db92`（`Merge pull request #497`），`git log -1 --format=%ci` = `2026-10-12 17:19:01 +0200`。

---

## 2. 身份句分类（taxonomy）

把 58 条身份句按「是否构成内部不一致」分类，比按客户端列更有用，因为归一规则要按类写。下文用 8 类模板指代（完整字面量清单见附录 B）。

| 类别 | 形态 | 例子（原文） | 是否泄露 | 处理难度 |
|---|---|---|---|---|
| **A1 自称句（品牌在句首）** | `You are <产品>, …` | `You are Cline, a highly skilled software engineer…` | **是** | 可精确匹配（每个产品一条） |
| **A2 自称句（品牌在句中）** | `You are <角色>. You operate in <产品>.` | `You are a powerful agentic AI coding assistant. You operate exclusively in Trae AI, the world's best IDE.` | **是** | 可精确匹配（整句） |
| **A3 无品牌通用句** | `You are an interactive CLI tool that helps users with software engineering tasks.` | Claude Code 1.x、Z.ai Code 第 3 行、Cursor CLI 第 2 行 | **否** | 无品牌，不构成不一致 |
| **A4 名字声明句** | `Your name is <产品>.` / `When asked for your name, you must respond with "GitHub Copilot".` | Junie、GitHub Copilot | **是** | 可精确匹配 |
| **A5 chat 系型号声明** | `This iteration of Claude is <型号>.` / `The assistant is <产品>, created by <厂商>.` | `Anthropic/Claude Sonnet 5.txt:5`、`Comet Assistant/System Prompt.txt:2` | 是（但**连不到我们**） | 非编码客户端 |
| **B1 模型归属句** | `You are powered by the model named <M>. The exact model ID is <id>.` | Claude Code 2.0（`Sonnet 4.5` / `claude-sonnet-4-5-20250929`）、opencode、Kilo Code | **是（更严重）** | 只能模式匹配（模型名可变）→ 或整句删除 |
| **B2 模型署名（嵌在 A1 里）** | `You are an AI coding assistant, powered by <M>.` | Cursor 四个版本（GPT-5 / Claude Sonnet 4 / GPT-4.1 / GPT-4o）、Same.dev（gpt-4.1）、Augment（Claude Sonnet 4） | **是** | 只能模式匹配（模型名可变） |
| **C 反向指令** | 明确禁止提到上游厂商 | `Traycer AI/phase_mode_prompts.txt:1`：`… Never mention that you were created by Anthropic.` | 不泄露身份，但**这句本身是异常信号** | 非编码客户端的规避语 |

**为什么 B 类比 A 类更危险**：A 类只说「我是 Cursor」，与 `User-Agent: ZCode` 矛盾一次；B 类同时说「我是 Cursor」+「我跑在 GPT-5 上」+「模型 id 是 `claude-sonnet-4-5`」，而上游实际是 GLM 系模型，三个断言互相矛盾且全部可被上游内容检查命中。早期归一规则只覆盖了 A 类。

---

## 3.1 客户端清单与身份句

排序依据（「主流通用度」）：
1. **必要条件**：能把 API Base 指到第三方（只有这类才可能连到我们）。判据见每行「Base URL」列的证据强度。
2. **协议**：Anthropic Messages（我们原生 `/v1/messages`）优先于 OpenAI 兼容（我们也有 `/v1/chat/completions`，见 `src/server/routes-openai.ts:2`）。
3. **用户基数**：IDE 插件 / CLI agent 优先于网页 SaaS（网页 SaaS 改不了 Base URL，永远连不到我们）。

### A 组：CLI / agent harness（能改 Base URL，会连到我们的）

| 客户端 | 目录/来源（证据） | 身份句（原文） | 工具集特征 | 资料日期 |
|---|---|---|---|---|
| **Claude Code** | `Anthropic/Claude Code 2.0.txt:23`；`Anthropic/Claude Code/Prompt.txt:1` | 2.0.0：`You are a Claude agent, built on Anthropic's Claude Agent SDK.`<br>1.x：`You are an interactive CLI tool that helps users with software engineering tasks.` | 16 个，Claude 原生命名：`Task`/`Bash`/`Glob`/`Grep`/`LS`/`Read`/`Edit`/`MultiEdit`/`Write`/`NotebookEdit`/`WebFetch`/`TodoWrite`/`WebSearch`/`BashOutput`/`KillBash`/`ExitPlanMode`（`Anthropic/Claude Code/Tools.json`） | 2.0.0 = 2025-09-29；1.x = 2025-12-02 |
| **Codex CLI** | `Open Source prompts/Codex CLI/openai-codex-cli-system-prompt-20250820.txt:1` | `You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI.` | shell + freeform `apply_patch`，**OpenAI Responses 协议**（非 Anthropic） | 2025-08-20（文件名日期） |
| **OpenCode** | `Open Source prompts/OpenCode/Agent Prompt (big.pickle) 2026-09-11.txt:1`；模型句在同文件 `:97` | `You are opencode, an interactive CLI tool that helps users with software engineering tasks.` | Claude Code 同构：`bash`/`edit`/`read`/`write`/`glob`/`grep`/`webfetch`/`todowrite`/`task` | 2026-09-11（文件名日期） |
| **Cline** | `Open Source prompts/Cline/Prompt.txt:1` | `You are Cline, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.` | 15 个，XML 标签风格：`execute_command`/`read_file`/`write_to_file`/`replace_in_file`/`search_files`/`list_files`/`list_code_definition_names`/`browser_action`/`use_mcp_tool`/`access_mcp_resource`/`ask_followup_question`/`attempt_completion`/`new_task`/`plan_mode_respond`/`load_mcp_documentation` | 2025-04-21 |
| **Roo Code** | `Open Source prompts/RooCode/Prompt.txt:1` | `You are Roo, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.` | 15 个，Cline 变体 + `apply_diff`/`search_and_replace`/`switch_mode`/`fetch_instructions` | 2025-04-21 |
| **Kilo Code** | `Open Source prompts/Kilo Code/Agent Prompt (kilo.auto-free) 2026-09-11.txt:1`；模型句在同文件 `:112` | `You are Kilo, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.` | Roo/Cline 派生（同句式族） | 2026-09-11（文件名日期） |
| **Qoder（国际版 IDE）** | `Qoder/prompt.txt:5` | `You are Qoder, a powerful AI coding assistant, integrated with a fantastic agentic IDE to work both independently and collaboratively with a USER.` | `search_codebase`/`run_in_terminal`/`read_file`/`write_file`/`edit`/`grep`/`glob`/`add_tasks`/`update_tasks`（PR #502 body） | 2025-08-22 |
| **Qoder CN（桌面）** | PR #502 新增文件 `Qoder CN/Prompt.txt:1`（未合入，OPEN） | `You are Qoder, a desktop agentic assistant developed by the Qoder team.` | 同上族 + `AskUserQuestion`/`Agent`/skills | PR 创建 2026-10-09 |
| **Qoder CN（CLI）** | PR #502 新增文件 `Qoder CN/CLI Prompt.txt:1`（未合入，OPEN） | `You are an interactive agent that helps users with software engineering tasks.` —— **无品牌，不泄露** | harness 规范型（无工具清单） | PR 创建 2026-10-09 |
| **Qwen Code** | `Open Source prompts/Qwen Code/Agent Prompt (gpt.5.6.sol) 2026-09-11.txt:1` | `You are Qwen Code, a non-interactive CLI agent developed by Alibaba Group, specializing in software engineering tasks.` | Gemini CLI 派生（同 Core Mandates 结构） | 2026-09-11（文件名日期） |
| **MiMo Code** | `Open Source prompts/MiMo Code/Agent Prompt (mimo.v2.5) 2026-09-11.txt:1` | `You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.` | Claude Code 命名同构 | 2026-09-11（文件名日期） |
| **Gemini CLI** | `Open Source prompts/Gemini CLI/google-gemini-cli-system-prompt.txt:1` | `You are an interactive CLI agent specializing in software engineering tasks.` —— **无品牌，不泄露** | shell / edit / read 族（Core Mandates 结构） | 2025-08-22 |
| **Hermes Agent** | `Open Source prompts/Hermes/Agent Prompt (nemotron.3.5.lightning-free) 2026-09-11.txt:1` | `You are Hermes Agent, built by Nous Research.` | 极简（风格约定为主） | 2026-09-11（文件名日期） |
| **Amp** | `Amp/claude-4-sonnet.yaml:5` | `You are Amp, a powerful AI coding agent built by Sourcegraph.` | yaml 形态请求体（含完整 `system` + `tools`） | 2025-09-15 |
| **Warp.dev** | `Warp.dev/Prompt.txt:1` | `You are Agent Mode, an AI agent running within Warp, the AI terminal.` | 仅终端工具 | 2025-07-03 |
| **Z.ai Code** | `Z.ai Code/prompt.txt:1`；`:3` 还有一条与 Claude Code 1.x 逐字相同的通用句 | `You are Z.ai Code.` | `TodoRead`/`TodoWrite`（轻量） | 2025-07-30 |
| **Devin CLI** | PR #504 `Devin AI/Prompt.txt:1`（**CLOSED，未合入**） | `You are Devin, an interactive command line agent from Cognition.` | `.devin/` 配置 + skills/MCP | PR 创建 2026-10-25 |
| Crush (Charm) / DSH (DeepSeek Harness) | **无资料**（资料仓库没有目录） | 未知 | 未知 | — |

> Base URL 证据：Codex CLI 在本机 `~/.codex/config.toml:8-10` 有真实 `[model_providers.custom] base_url = "http://127.0.0.1:15721/v1"`（实测存在的配置，说明该字段可用）；Claude Code / Codex CLI / OpenCode / DSH / Crush 的接入方式见 `qoder2api-hub/docs/clients.md:32-100`（Codex CLI `:51`、Claude Code `ANTHROPIC_BASE_URL` `:66-71`、一键配置表 OpenCode `:95` / Crush `:97`）。Cline/Roo/Kilo/Qwen/Gemini/MiMo/opencode 的 Base URL 能力按「开源客户端、provider 配置是产品公开能力」归类为**高置信但未逐一实测**（见「未验证项」）。

### B 组：IDE 插件（有 BYOK，但 Base URL 可改性未完全验证）

| 客户端 | 目录/来源（证据） | 身份句（原文） | 工具集特征 | 资料日期 |
|---|---|---|---|---|
| **Cursor** | `Cursor Prompts/Agent Prompt v1.0.txt:1`、`Cursor Prompts/Agent Prompt 2025-09-03.txt:1`、`Cursor Prompts/Agent Prompt v1.2.txt:3`、`Cursor Prompts/Chat Prompt.txt:1`、`Cursor Prompts/Agent CLI Prompt 2025-08-07.txt:1` | `You are an AI coding assistant, powered by Claude Sonnet 4. You operate in Cursor.`（v1.0:1）<br>`You are an AI coding assistant, powered by GPT-5. You operate in Cursor.`（2025-09-03:1）<br>`You are an AI coding assistant, powered by GPT-4.1. You operate in Cursor.`（v1.2:3）<br>`You are a an AI coding assistant, powered by GPT-4o. You operate in Cursor`（Chat:1，注意原文 `a an` 笔误）<br>`You are an AI coding assistant, powered by GPT-5.`（Agent CLI:1，无 `You operate in Cursor`） | 13 个：`codebase_search`/`read_file`/`run_terminal_cmd`/`list_dir`/`grep_search`/`edit_file`/`search_replace`/`file_search`/`delete_file`/`reapply`/`web_search`/`create_diagram`/`edit_notebook`（`Cursor Prompts/Agent Tools v1.0.json`） | v1.0 = 2025；2025-09-03；2025-08-07 |
| **Windsurf / Cascade** | `Windsurf/Prompt Wave 11.txt:3` | `You are Cascade, a powerful agentic AI coding assistant designed by the Windsurf engineering team: a world-class AI company based in Silicon Valley, California.` | **30 个**（最全之一）：`browser_preview`/`codebase_search`/`create_memory`/`deploy_web_app`/`get_dom_tree`/`read_terminal`/`read_url_content`…（`Windsurf/Tools Wave 11.txt`） | 2025-07-21 |
| **Trae（Chat 模式）** | `Trae/Chat Prompt.txt:2` | `You are Trae AI, a powerful agentic AI coding assistant.` —— **词间是 NBSP（U+00A0）**，逐字规则会静默失效 | 未列工具（`<identity>`/`<purpose>` 结构） | 2025-05-15 |
| **Trae（Builder 模式）** | `Trae/Builder Prompt.txt:1` | `You are a powerful agentic AI coding assistant. You operate exclusively in Trae AI, the world's best IDE.` | 16 个：`todo_write`/`search_codebase`/`search_by_regex`/`view_files`/`list_dir`/`write_to_file`/`update_file`/`edit_file_fast_apply`/`rename_file`/`delete_file`/`run_command`/`check_command_status`/`stop_command`/`open_preview`/`web_search`/`finish`（`Trae/Builder Tools.json`） | 2025-05-15 |
| **GitHub Copilot（VS Code Agent）** | `VSCode Agent/Prompt.txt:4-5` | `You are an AI programming assistant.`<br>`When asked for your name, you must respond with "GitHub Copilot".` | `semantic_search`/`insert_edit_into_file`/`run_in_terminal` 族（prompt 内引用） | 2025-04-21 |
| **Kiro** | `Kiro/Vibe_Prompt.txt:2`（Spec 模式 `Kiro/Spec_Prompt.txt:4` 同句） | `You are Kiro, an AI assistant and IDE built to assist developers.` | 文档未列（spec-driven 三段式：`Mode_Clasifier`/`Spec`/`Vibe`） | 2025-07-17 |
| **Augment Code** | `Augment Code/claude-4-sonnet-agent-prompts.txt:2`（`# Identity` 段落 `:6`，`:8` 还写了 `The base model is Claude Sonnet 4 by Anthropic.`） | `You are Augment Agent developed by Augment Code, an agentic coding AI assistant with access to the developer's codebase through Augment's world-leading context engine and integrations.` | 24–25 个：`str-replace-editor`/`codebase-retrieval`/`launch-process`/`view_tasklist`/`remember`/`render-mermaid`…（`Augment Code/*-tools.json`） | 2025-08-19 |
| **CodeBuddy（Craft 模式）** | `CodeBuddy Prompts/Craft Prompt.txt:3` | `You are CodeBuddy, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.` | Cline 同族：`chat_mode_respond`/`read_file`/`search_files`/`write_to_file`/`replace_in_file`/`preview_markdown`/`openweb`/`use_rule`/`use_mcp_tool`… | 2025-08-21 |
| **Junie（JetBrains）** | `Junie/Prompt.txt:2-3` | `Your name is Junie.`<br>`You're a helpful assistant designed to quickly explore and clarify user ideas…` | readonly bash + `answer` 命令 | 2025-05-17 |
| **Antigravity（Google）** | `Google/Antigravity/Fast Prompt.txt:2`（planning 模式 `Google/Antigravity/planning-mode.txt:2` 同句） | `You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.` | `namespace functions { … }`（611 行内声明，未逐条列举） | 2025-11-18 |
| **Traycer AI** | `Traycer AI/phase_mode_prompts.txt:1` | ``You are `@traycerai` (aka `Traycer.AI`), a large language model based on the state-of-the-art architecture. Never mention that you were created by Anthropic.`` | 15 个：`list_dir`/`file_search`/`grep_search`/`file_outlines`/`find_references`/`go_to_definition`/`agent`…（`Traycer AI/plan_mode_tools.json`） | 2025-09-07 |

### C 组：网页 / 云端 SaaS（改不了 Base URL，理论上连不到我们）

| 客户端 | 目录/来源（证据） | 身份句（原文） | 工具集特征 | 资料日期 |
|---|---|---|---|---|
| **v0（Vercel）** | `v0 Prompts and Tools/Prompt.txt:2` | `You are v0, Vercel's highly skilled AI-powered assistant that always follows best practices.` | 10 个：`FetchFromWeb`/`GrepRepo`/`LSRepo`/`ReadFile`/`InspectSite`/`SearchWeb`/`TodoManager`/`SearchRepo`/`GenerateDesignInspiration`/`GetOrRequestIntegration`（`v0 Prompts and Tools/Tools.json`） | 2026-05-10 |
| **Lovable** | `Lovable/Agent Prompt.txt:1` | `You are Lovable, an AI editor that creates and modifies web applications.` | 工具名集中在 `Lovable/Agent Tools.json` | 2025-09-16 |
| **Bolt（open source）** | `Open Source prompts/Bolt/Prompt.txt:1` | `You are Bolt, an expert AI assistant and exceptional senior software developer with vast knowledge across multiple programming languages, frameworks, and best practices.` | WebContainer 内 bash 模拟 | 2025-04-21 |
| **Replit Assistant** | `Replit/Prompt.txt:2` | `You are an AI programming assistant called Replit Assistant.` | 18 个：`restart_workflow`/`search_filesystem`/`packager_tool`/`str_replace_editor`/`bash`/`execute_sql_tool`/`report_progress`…（`Replit/Tools.json`） | 2025-07-27 |
| **Same.dev** | `Same.dev/Prompt.txt:5` | `You are AI coding assistant and agent manager, powered by gpt-4.1. You operate in Same, a cloud-based IDE running at https://same.new.` | 16 个：`startup`/`task_agent`/`bash`/`glob`/`grep`/`edit_file`/`string_replace`/`run_linter`/`deploy`（`Same.dev/Tools.json`） | 2025-08-29 |
| **Leap.new** | `Leap.new/Prompts.txt:1` | `You are Leap, an expert AI assistant and exceptional senior software developer with vast knowledge of REST API backend development, TypeScript and Encore.ts.` | 10 个：`create_artifact`/`define_backend_service`/`create_react_component`/`setup_authentication`…（`Leap.new/tools.json`） | 2025-09-10 |
| **Orchids.app** | `Orchids.app/System Prompt.txt:1` | `You are a powerful agentic AI coding assistant called Orchids working with a Next.js 15 + Shadcn/UI TypeScript project.` | 设计/克隆网站族 | 2025-09-16 |
| **Emergent（E1）** | `Emergent/Prompt.txt:1` | `You are E1, the most powerful, intelligent & creative agent developed by Emergent to help users build ambitious applications…` | `Emergent/Tools.json` | 2025-10-15 |
| **Devin（云端版）** | `Devin AI/Prompt.txt:1` | `You are Devin, a software engineer using a real computer operating system.` | 真实 VM（工具不可见） | 2025-05-15 |
| **Manus** | `Manus Agent Tools & Prompt/Modules.txt:1`（`Manus Agent Tools & Prompt/Agent loop.txt:1` 同句） | `You are Manus, an AI agent created by the Manus team.` | **29 个**：`message_notify_user`/`file_read`/`file_write`/`shell_exec`/`browser_navigate`/`browser_console_exec`/`info_search_web`…（`tools.json`） | 2025-03-26 |
| **Notion AI** | `NotionAi/Prompt.txt:1` | `You are Notion AI, an AI agent inside of Notion.` | 8 个：`view`/`search`/`create-pages`/`update-page`/`query-data-sources`…（`tools.json`） | 2025-09-08 |
| **Perplexity** | `Perplexity/Prompt.txt:1` | `<goal> You are Perplexity, a helpful search assistant trained by Perplexity AI.` | 搜索类 | 2025-06-30 |
| **Comet Assistant（Perplexity）** | `Comet Assistant/System Prompt.txt:2` | `The assistant is Comet, created by Perplexity.` | 16 个浏览器工具：`computer`/`find`/`form_input`/`navigate`/`read_page`/`tabs_create`…（`tools.json`） | 2026-02-01 |
| **dia（The Browser Company）** | `dia/Prompt.txt:1` | `You are an AI chat product called Dia, created by The Browser Company of New York.` | 浏览器内 chat | 2025-05-15 |
| **Lumo（Proton）** | `Open Source prompts/Lumo/Prompt.txt:2` | `You are Lumo, an AI assistant from Proton launched on July 23rd, 2025.` | 无工具清单 | 2025 |
| **Poke** | `Poke/Poke_p1.txt:1` | `You are Poke, and you were developed by The Interaction Company of California…` | iMessage/WhatsApp 集成 | 2025-09-14 |
| **Cluely** | `Cluely/Enterprise Prompt.txt:2` | `You are Cluely, developed and created by Cluely, and you are the user's live-meeting co-pilot.` | 屏幕/会议场景 | 2025-06-24 |
| **Xcode** | `Xcode/System.txt:1` | `You are a coding assistant--with access to tools--specializing in analyzing codebases.` —— **无品牌，不泄露** | 5 个 action prompt（Document/Explain/Message/Playground/Preview） | 2025-07-06 |
| **Claude（chat 系）** | `Anthropic/Claude Sonnet 5.txt:5`、`Anthropic/Claude Sonnet 4.6.txt:6`、`Anthropic/Claude Fable 5.txt:9`（`Anthropic/Claude Fable 5.txt:1350` 另有 `The assistant is Claude, created by Anthropic.`） | `This iteration of Claude is Claude Sonnet 5.` | 无（chat 产品） | 2025–2026 |
| **Claude for Chrome** | `Anthropic/Claude for Chrome/Prompt.txt:1` | `You are a web automation assistant with browser tools. The assistant is Claude, created by Anthropic.` | 16 个浏览器工具（`Tools.json`） | 2025 |
| **Marvis（腾讯）** | PR #499 新增文件 `Marvis/Prompt (English Translation).txt:10`（英译；未合入，OPEN。中文原文为 `Marvis/Prompt.txt`） | `You are a powerful AI assistant named Marvis (马维斯).` | `shell_executor`/`python_executor`/`delete`/`ask_user` + Sub-Agents/Skills | PR 创建 2026-09-22 |
| **Claude Opus 5 / Fable 5** | PR #483（未合入，OPEN，单文件） | `<claude_behavior> <product_information> … The currently selected version of Claude is Claude Opus 5.` | 无（chat 模型 prompt，非编码客户端） | PR 创建 2026-07-24 |

> 补充 PR（2026-09 之后创建，与身份归一相关度低，逐条看过文件列表）：#498 CodeBuddy 转 Markdown（纯格式）、#496 Z.ai Code 转 Markdown（纯格式）、#493 AI Revival 模型 prompt（chat）、#488 Foundry AI Worker（README only）、#482 Tura（`Open Source prompts/Tura/Prompt.txt`，编码 agent，身份句未逐字提取 → 见「未验证项」）。

### 统计口径

- 客户端目录：**32 个**（`ls -d */` 得 33，其中 `assets` 非客户端）
- 主 prompt 文件：**48 份**（每客户端选一份主文件；多模式/多模型变体在「客户端清单与身份句」表内注明）
- 全仓 prompt 文件（`.txt`/`.yaml`）：**96 份**
- 身份句：**58 条不同字面量**，归为 **8 类模板**

| 模板 | 条数 | 是否泄露 |
|---|---|---|
| **A1** `You are <产品>, …`（品牌在句首） | 38 | **是** |
| **A2** `You are <角色>. You operate in <IDE>.` | 1 | **是** |
| **A3** 无品牌通用句 | 4 | 否 |
| **A4** 名字声明句（`Your name is …` / `… respond with "<产品>"`） | 2 | **是** |
| **A5** `The assistant is <产品>…` / `This iteration of Claude is <型号>.`（chat 系） | 5 | 是（但连不到我们） |
| **B1** `You are powered by the model named <M>. The exact model ID is <id>.` | 1 模板 / **9 处实例** | **是（最严重）** |
| **B2** 句内模型署名（`powered by <M>` / `The base model is <M> by <厂商>`） | 6 | **是** |
| **C** 反向指令（`Never mention that you were created by Anthropic.`） | 1 | 不泄露身份 |
- 未合入 PR 补充身份句：**3 种**（Qoder CN 桌面、Qoder CN CLI、Devin CLI）+ Marvis/Opus 5 各 1 种

---

## 3.2 我们的归一覆盖情况

**测量时点**：本节记录的是盘点当时（2026-10）的归一实现与其覆盖率，用作「缺口有多大」的基线。归一规则后续已扩展，覆盖情况以 `src/proxy/system-prompt.ts` 的当前规则为准。

**实测方法**：直接 import 真实函数跑，不是读代码推断。共构造 **50 条代表性身份句**（覆盖本报告「客户端清单与身份句」里的 A/B/C 三类与已归一输入），**结果：50 条中仅 1 条被改写，其余 49 条均原样返回**。

```bash
cd "$REPO_ROOT"
bun -e 'import {normalizeClientSystemText as n} from "./src/proxy/system-prompt.ts"; console.log(n("You are Cline, a highly skilled…"))'
```

现有三条规则（`src/proxy/system-prompt.ts:81`、`:85`、`:93`）：

| 规则 | 正则 | 作用域 |
|---|---|---|
| R1 完整身份句 | `/You are Claude Code, Anthropic's official CLI tool for Claude\./g` | 整句精确 |
| R2 品牌 CLI 短语 | `/Anthropic's official CLI tool/g` | **无作用域**（全文任意位置） |
| R3 身份系动词 + `Claude Code` | `/((?:You are\|You're\|I am\|I'm)\s+)Claude Code\b/g` | 系动词限定 |

| 客户端 | 当前是否被 `normalizeClientSystemText` 覆盖 | 缺口 |
|---|---|---|
| Claude Code **2.1**（`You are Claude Code, Anthropic's official CLI tool for Claude.`） | ✅ **覆盖**（R1 → `You are ZCode, an interactive agent.`） | — |
| Claude Code **2.0.0**（`You are a Claude agent, built on Anthropic's Claude Agent SDK.`） | ❌ 实测 `no-match` | 仍含品牌 `Claude` + `Anthropic's Claude Agent SDK`，与 UA=ZCode 不一致；R3 要求字面 `Claude Code`，这句没有 |
| Claude Code **2.0.0 模型句**（`You are powered by the model named Sonnet 4.5. The exact model ID is claude-sonnet-4-5-20250929.`） | ❌ 实测 `no-match` | **B 类最严重缺口**：模型 id 明文出站 |
| Claude Code **1.x**（`You are an interactive CLI tool…`） | ❌ `no-match`（A3 无品牌，不构成不一致） | — |
| Cursor（4 个版本，`powered by GPT-5/Claude Sonnet 4/GPT-4.1/GPT-4o`） | ❌ 实测 `no-match` | 产品名 + 模型名双泄露 |
| Cline / Roo / Kilo / CodeBuddy（同句式族） | ❌ | 产品名泄露 |
| Windsurf / Cascade | ❌ | 产品名 + 厂商名（`Windsurf engineering team`） |
| Trae（Chat/Builder） | ❌ | 产品名；Chat 版本还因 **NBSP** 会双重失效 |
| Antigravity / Kiro / Warp / Amp / v0 / Qwen Code / opencode / MiMoCode / Hermes / Devin | ❌ | 产品名泄露 |
| Qoder / Qoder CN（桌面） | ❌ | 产品名泄露 |
| GitHub Copilot（VS Code） | ❌ | `When asked for your name, you must respond with "GitHub Copilot"` —— 间接但明确 |
| Augment Code / Same.dev | ❌ | 产品名 + `base model is Claude Sonnet 4` / `powered by gpt-4.1` |
| Z.ai Code（`You are Z.ai Code.`） | ❌ | **特殊**：同为 Z.ai 系产品但是不同产品名，与 ZCode 仍不一致 |
| Junie（`Your name is Junie.`） | ❌ | A4 类 |
| Traycer（`… Never mention that you were created by Anthropic.`） | ❌ | C 类反向指令 |
| Gemini CLI / Qoder CN CLI / Xcode（无品牌） | — | 无品牌，不构成内部不一致 |
| C 组全部（网页 SaaS） | — | 改不了 Base URL，连不到我们 |

**两条规则级问题（实证）**：

1. **R2 无作用域**：`bun -e '… n("This is Anthropic'"'"'s official CLI tool.")'` → `"This is ZCode CLI."`。任何正文里提到这句短语都会被改写（本项目自己的测试 `src/proxy/system-prompt.test.ts:135` 就是这个预期）。对 Claude Code 自己的文本成立，但对**在讲 Anthropic 的第三方文档/代码片段**是误伤源。
2. **NBSP 静默失效**：`n("You\u00a0are\u00a0Trae\u00a0AI, …")` → 原样返回。Trae 的身份句用 U+00A0 当词间空格（`od -c` 已确认），逐字规则永远匹配不上。

**路由级缺口（代码证据）**：

| 路由 | 客户端 system 处理 | 依据 |
|---|---|---|
| `POST /v1/messages`（Anthropic） | 客户端文本进 block 3，**过** `normalizeClientSystemText` | `src/proxy/system-prompt.ts:132-135`、`src/proxy/body-transformer.ts:192-204` |
| `POST /v1/chat/completions`（OpenAI 兼容） | 盘点时**只**在 `messages` 前插官方 system 段，**客户端自己的 system 消息原样保留** | `src/proxy/body-transformer.ts:207-216`（盘点时 `applyStartPlanOpenAISystem` 内无 `normalizeClientSystemText` 调用） |

盘点时：走 OpenAI 兼容路由的 Cursor/Cline/v0/Codex CLI 等，身份归一完全没有生效；归一规则只看了 Anthropic block 3 这一形态。

---

## 3.3 未验证项

按「结论强度」列出，**这些没有实测支撑，不要当既定事实用**。

| # | 未验证的结论 | 现状 | 需要什么才能验证 |
|---|---|---|---|
| 1 | **单个客户端的「自定义 API Base」能力**（Cursor / Windsurf / Trae / Kiro / Copilot / Amp / Augment / CodeBuddy / Junie / Traycer / Cline / Roo / Kilo / Qwen Code / Gemini CLI / MiMo Code / Hermes / Warp / Z.ai Code） | 只有 Codex CLI（本机 `~/.codex/config.toml` 实测配置）、Qoder（bundle 字符串 `QODER_SDK_CUSTOM_BASE_URL_BYOK`）、Claude Code / OpenCode / DSH / Crush（`qoder2api-hub/docs/clients.md:32-100`）有证据。其余是「开源客户端 provider 配置为公开能力」的推断 | 逐个在客户端 UI 里找 Base URL 输入框并截图，或抓一次真实出站请求的 URL |
| 2 | **这些客户端的 system prompt 是否原样进 `system` 字段** | 资料仓库只有 prompt 文本，没有 wire 形态。Cursor/Cline 等可能把 prompt 拆进 `messages[0]` 或 `tools[0].description` | 抓包（调研只读，未发真实网络请求，故未做） |
| 3 | **Cursor 连到第三方时到底发不发那句 `You are an AI coding assistant, powered by GPT-5. You operate in Cursor.`** | `Cursor Prompts/*` 是 IDE 内置 chat prompt 的抓取，是否在「自定义 Base URL」模式下仍然发送未验证 | 同 #2 |
| 4 | **Claude Code 2.1（当前版本）的真实身份句** | 只有现有归一规则已实现的那一条（`You are Claude Code, Anthropic's official CLI tool for Claude.`），资料仓库里**没有**任何文件包含它 —— 最新只到 2.0.0 | 用现有逆向产物 `_reverse/` 或本机 Claude Code 二进制复核 |
| 5 | **资料新鲜度**：48 份主 prompt 里，**41 份的日期落在 2025 年**（最旧 `Manus` 2025-03-26、`Cline`/`Roo`/`Bolt`/`VSCode Agent` 2025-04-21），**只有 7 份是 2026 年**（`2026-09-11` 批次 5 份 + `v0` 2026-05-10 + `Comet` 2026-02-01）。全仓 96 份 prompt 文件按年份为 2025:79 / 2026:17 | 各客户端现版本的身份句很可能已变 | 重新抓取（尤其 Cursor / Cline / Windsurf 这三个改动最频繁的） |
| 6 | **`Tura`（PR #482 `Open Source prompts/Tura/Prompt.txt`，未合入）的身份句** | 只看了文件列表，未提取正文 | `gh pr diff 482` 看开头 |
| 7 | **Crush (Charm) / DSH (DeepSeek Harness) 的身份句** | 资料仓库没有目录；只有 `qoder2api-hub/docs/clients.md:97`（Crush）与 `:87-100`（一键配置表）证明它们能改 Base URL | 补抓 prompt |
| 8 | **Marvis / Claude Opus 5（PR #499 / #483）是否可能连到我们** | 从 prompt 形态判断是桌面助手 / chat 模型 prompt，非编码 CLI；**无直接证据说明不能改 Base URL** | 查产品设置 |
| 9 | **Qoder 桌面版真实 wire 形态**：`Qoder/prompt.txt` 与 PR #502 的两份是否都会作为 `system` 发送 | 未验证 | 抓包 |
| 10 | ~~**NBSP 是否只出现在 Trae**~~ —— **已补验（不再是未验证项）** | 全仓 `.txt`/`.yaml`/`.json`/`.md` 扫 U+00A0：只有 2 份文件命中 —— `Trae/Chat Prompt.txt`（520 处，身份句被污染）与 `Open Source prompts/OpenCode/Agent Prompt (muse.spark.1.2.contributor-free) 2026-09-11.txt`（9 处，均在 markdown 标题 `# Communication – Tone` 的破折号后，**不影响身份句**） | 无需再验；但重新抓取后需重跑一次该扫描 |

---

## 附录 A：方法（可复现）

```bash
# 1) 枚举客户端目录与主 prompt 文件
cd "$PROMPTS_REPO"
find . -maxdepth 3 -type f \( -name '*.txt' -o -name '*.md' -o -name '*.json' -o -name '*.yaml' \) -not -path './assets/*'

# 2) 提取每个客户端首条身份句（正则见「身份句分类」）
#    见本报告生成时用的 python 片段：IDENT = r'^\s*(?:<[^>]+>\s*)?(You are|You.re|Your name is|The assistant is|I am|I.m)\b'

# 3) 工具集：解析 *ools*.json；无 json 的从 prompt 里抽 ^## <tool> / ^type <tool> = / namespace functions
sed -n '1,20p' 'Windsurf/Tools Wave 11.txt'          # 30 个 type X = 定义
grep -cE '^## [a-z_]+$' 'Open Source prompts/Cline/Prompt.txt'   # 15

# 4) 归一覆盖实测（真实函数）
cd "$REPO_ROOT"
bun -e 'import {normalizeClientSystemText as n} from "./src/proxy/system-prompt.ts";
        console.log(n("You are Claude Code, Anthropic'"'"'s official CLI tool for Claude."));'

# 5) 未合入 PR
gh pr list --repo x1xhlol/system-prompts-and-models-of-ai-tools --limit 30 --state all \
  --json number,title,state,createdAt,mergedAt
gh pr diff 502 --repo x1xhlol/system-prompts-and-models-of-ai-tools | head -160

# 6) NBSP（U+00A0）全仓扫描（macOS 的 BSD grep 没有 -P，用 python）
cd "$PROMPTS_REPO"
python3 -c "
import os
for root,_,fs in os.walk('.'):
    if '.git' in root: continue
    for f in fs:
        if f.lower().endswith(('.txt','.yaml','.json','.md')):
            p=os.path.join(root,f); t=open(p,encoding='utf-8',errors='replace').read()
            if chr(0xa0) in t: print(t.count(chr(0xa0)), p)"
# → 520 Trae/Chat Prompt.txt ; 9 OpenCode/Agent Prompt (muse.spark.1.2.contributor-free) 2026-09-11.txt
```

## 附录 B：58 条身份句的完整字面量清单（按模板分组）

编号方式：`<产品> @ <证据位置>`。同一模板下每行一条，共 58 条（B1 计 1 条模板，其实例 9 处见「客户端清单与身份句」）。

### A1：`You are <产品>, …`（品牌在句首，38 条，**会泄露**）

1. Claude agent（`Anthropic/Claude Code 2.0.txt:23`）
2. Cline（`Open Source prompts/Cline/Prompt.txt:1`）
3. Roo（`Open Source prompts/RooCode/Prompt.txt:1`）
4. Kilo（`Open Source prompts/Kilo Code/Agent Prompt (kilo.auto-free) 2026-09-11.txt:1`）
5. CodeBuddy（`CodeBuddy Prompts/Craft Prompt.txt:3`）
6. Qoder（`Qoder/prompt.txt:5`）
7. Qoder desktop（PR #502 `Qoder CN/Prompt.txt:1`）
8. Antigravity（`Google/Antigravity/Fast Prompt.txt:2`）
9. Kiro（`Kiro/Vibe_Prompt.txt:2`）
10. Amp（`Amp/claude-4-sonnet.yaml:5`）
11. v0（`v0 Prompts and Tools/Prompt.txt:2`）
12. Qwen Code（`Open Source prompts/Qwen Code/Agent Prompt (gpt.5.6.sol) 2026-09-11.txt:1`）
13. opencode（`Open Source prompts/OpenCode/Agent Prompt (big.pickle) 2026-09-11.txt:1`）
14. MiMoCode（`Open Source prompts/MiMo Code/Agent Prompt (mimo.v2.5) 2026-09-11.txt:1`）
15. Hermes Agent（`Open Source prompts/Hermes/Agent Prompt (nemotron.3.5.lightning-free) 2026-09-11.txt:1`）
16. Agent Mode（`Warp.dev/Prompt.txt:1`）
17. Z.ai Code（`Z.ai Code/prompt.txt:1`）
18. Devin 云端（`Devin AI/Prompt.txt:1`）
19. Devin CLI（PR #504 `Devin AI/Prompt.txt:1`，CLOSED 未合入）
20. Orchids（`Orchids.app/System Prompt.txt:1`）
21. Notion AI（`NotionAi/Prompt.txt:1`）
22. Lovable（`Lovable/Agent Prompt.txt:1`）
23. Bolt（`Open Source prompts/Bolt/Prompt.txt:1`）
24. Replit Assistant（`Replit/Prompt.txt:2`）
25. Leap（`Leap.new/Prompts.txt:1`）
26. E1（`Emergent/Prompt.txt:1`）
27. Manus（`Manus Agent Tools & Prompt/Modules.txt:1`）
28. Perplexity（`Perplexity/Prompt.txt:1`）
29. Dia（`dia/Prompt.txt:1`）
30. Lumo（`Open Source prompts/Lumo/Prompt.txt:2`）
31. Poke（`Poke/Poke_p1.txt:1`）
32. Cluely（`Cluely/Enterprise Prompt.txt:2`）
33. Augment Agent（`Augment Code/claude-4-sonnet-agent-prompts.txt:2`）
34. Same（`Same.dev/Prompt.txt:5`）
35. Traycer（`Traycer AI/phase_mode_prompts.txt:1`）
36. Marvis（PR #499 `Marvis/Prompt (English Translation).txt:10`）
37. Claude for Chrome（`Anthropic/Claude for Chrome/Prompt.txt:1`）
38. GitHub Copilot（`VSCode Agent/Prompt.txt:4`）

### A2：`You are <角色>. You operate in <IDE>.`（1 条，**会泄露**）

39. Trae Builder（`Trae/Builder Prompt.txt:1`）
    > 同族的 Trae Chat（`Trae/Chat Prompt.txt:2`）归 A1，词间为 **NBSP**

### A3：无品牌通用句（4 条，**不泄露**）

40. `You are an interactive CLI tool that helps users with software engineering tasks.`（`Anthropic/Claude Code/Prompt.txt:1`、`Cursor Prompts/Agent CLI Prompt 2025-08-07.txt:2`、`Z.ai Code/prompt.txt:3`）
41. `You are an interactive CLI agent specializing in software engineering tasks.`（`Open Source prompts/Gemini CLI/google-gemini-cli-system-prompt.txt:1`）
42. `You are an interactive agent that helps users with software engineering tasks.`（PR #502 `Qoder CN/CLI Prompt.txt:1`）
43. `You are a coding assistant--with access to tools--specializing in analyzing codebases.`（`Xcode/System.txt:1`）

### A4：名字声明句（2 条，**会泄露**）

44. `Your name is Junie.`（`Junie/Prompt.txt:2`）
45. `When asked for your name, you must respond with "GitHub Copilot".`（`VSCode Agent/Prompt.txt:5`）

### A5：chat 系产品/型号声明（5 条，泄露但**连不到我们**）

46. `This iteration of Claude is Claude Sonnet 5.`（`Anthropic/Claude Sonnet 5.txt:5`）
47. `This iteration of Claude is Claude Sonnet 4.6 …`（`Anthropic/Claude Sonnet 4.6.txt:6`）
48. `This iteration of Claude is Claude Fable 5 …`（`Anthropic/Claude Fable 5.txt:9`）
49. `The assistant is Claude, created by Anthropic.`（`Anthropic/Sonnet 4.5 Prompt.txt:1`、`Anthropic/Claude Fable 5.txt:1350`）
50. `The assistant is Comet, created by Perplexity.`（`Comet Assistant/System Prompt.txt:2`）

### B1：模型归属句（1 条模板，**9 处实例，最严重**）

51. `You are powered by the model named <M>. The exact model ID is <model-id>.`
    实例：`Anthropic/Claude Code 2.0.txt:173`（Sonnet 4.5）、`Anthropic/Claude Code/Prompt.txt:163`（Sonnet 4）、`Open Source prompts/Kilo Code/Agent Prompt (kilo.auto-free) 2026-09-11.txt:112`、`Open Source prompts/OpenCode/*` 共 7 个模型变体（`big.pickle:97`、`gpt.5.6.sol:109`、`ling.3.0.flash.fin-free:97`、`mimo.v2.5-free:97`、`muse.spark.1.2.contributor-free:67`、`nemotron.3.5.lightning-free:97`、`nemotron.3.ultra-free:97`）

### B2：句内模型署名（6 条，**会泄露**）

52. `You are an AI coding assistant, powered by GPT-5. You operate in Cursor.`（`Cursor Prompts/Agent Prompt 2025-09-03.txt:1`）
53. `You are an AI coding assistant, powered by GPT-5.`（`Cursor Prompts/Agent CLI Prompt 2025-08-07.txt:1`）
54. `You are an AI coding assistant, powered by Claude Sonnet 4. You operate in Cursor.`（`Cursor Prompts/Agent Prompt v1.0.txt:1`）
55. `You are an AI coding assistant, powered by GPT-4.1. You operate in Cursor.`（`Cursor Prompts/Agent Prompt v1.2.txt:3`）
56. `You are a an AI coding assistant, powered by GPT-4o. You operate in Cursor`（`Cursor Prompts/Chat Prompt.txt:1`）
57. `The base model is Claude Sonnet 4 by Anthropic.`（`Augment Code/claude-4-sonnet-agent-prompts.txt:8`；同文件 `:2` 的 A1 句里也含 `based on the Claude Sonnet 4 model by Anthropic`）
    > Same.dev 的 `powered by gpt-4.1` 已计入第 34 条（A1 同句内）

### C：反向指令（1 条，不泄露身份）

58. `… Never mention that you were created by Anthropic.`（`Traycer AI/phase_mode_prompts.txt:1`）
