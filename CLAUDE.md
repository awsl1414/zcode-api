# zcode-api

单进程本地代理：把 Z.AI / bigmodel 的编码套餐伪装成 ZCode 桌面客户端发往上游（两档套餐上游
都是 Anthropic 格式），对本地客户端暴露 OpenAI / Anthropic / Responses 三套协议。运行时 Bun。

## 常用命令

```bash
bun install                                          # 依赖（CI/Docker/build 全钉 Bun 1.4.4）
bun run dev                                          # serve + 面板；无 TTY / Docker 加 -- --no-panel
bun run typecheck                                    # tsc --noEmit，唯一静态门禁（无 lint）
bun test src/proxy/handler-routing-signing.test.ts    # 单文件；bun test -t "captcha" 按名过滤
bun run src/index.ts auth login zai|bigmodel         # 登录落成账号，凭据加密存 ~/.zcode-proxy/
bun run src/index.ts auth import [--jwt <token>]     # 从 ~/.zcode/v2/credentials.json 导入
bun run src/index.ts serve debug                     # 每请求诊断日志
bun run build:darwin-arm64                           # 编译单文件；先跑 scripts/build-fork-worker.ts
bun run regen:mcp                                    # 离线重生成 src/mcp/official-catalogue.json
```

`bun run dev` / `src/index.ts` 从源码跑不需要 fork-worker 那步；只有 `bun build --compile` 的
单文件二进制靠它嵌 captcha worker。CI = `bun run typecheck` + `bun test`（`.github/workflows/ci.yml`）；
发版走 `.github/workflows/release.yml`，tag 必须 `v*`。

## 请求链路

客户端 → `server/server.ts`（node:http + 路由表 + 数据面 API key 门控 `auth.requireKey`）→
`server/routes-*.ts`（按入站协议解析 / 校验 / 翻译）→ `proxy/handler.ts` `proxyRequest()`
（唯一出线口）→ 上游。OpenAI 侧上行由 `translator/openai-to-anthropic.ts` 翻译、下行
`translator/sse-translator.ts` 转 SSE；`/v1/messages` 只改写 body 后直传（`decompress: false`，
压缩字节与 `Content-Encoding` 原样透传）。模型能力钉在 `provider/models.ts`，由 translator 消费
钳制。上游仿冒层都叠在 `proxyRequest` 出线前，彼此独立、fail-open：`identity` / `client-signing`
/ `endpoint-routing` / `session-context` / `highspeed` / `captcha` / `ordered-transport`（都在
`src/proxy/` 或同名目录，文件头注释写明了各自的逆向依据）。

入口 `src/index.ts`：默认 serve + 面板，`--cli` 走子命令，`--no-panel` 关面板。配置由
`config/loader.ts` 合并 YAML 与 `ZCODE_*` 环境变量（env 优先），`DEFAULTS` 是最终真值；
`config/template.ts` 与 `config.example.yaml` 是双写契约。

## 容易踩的坑

- **system prompt 是 3 块形态、签名模板用真换行**：网关内容检查不对就回 `3012`，签名模板换
  行错一个字节就 401 / `VERIFY_*`。别「顺手简化」上游契约，改动前先找对应 `.test.ts`。
- **`src/server/web/` 的样式与骨架由 `page.ts` 的三个数组拼接**，数组顺序即 CSS 层叠 / DOM /
  依赖语义；改片段后跑 `bun test src/server/web/page.test.ts`（钉逐字节守恒与模块顺序）。
- **测试与被测文件同目录**（`*.test.ts`，`bun:test`），靠依赖注入覆盖网络：`fetchImpl`、
  `endpointRouting`、`clientSigning`、`highspeed`、`captcha`。新增网络路径要留同样的注入点。
- **控制面 / 面板永不绑非回环**：bind 127.0.0.1 + 每请求 `remoteAddress` 复查。
- **Bun-only 语法**：`import x from "./page.html" with { type: "text" }`、`with { type: "file" }`
  嵌资源。新增内嵌资源要同步 `scripts/build-fork-worker.ts`，否则编译产物缺那份。
- **版本号两处**：`src/version.ts` 的 `VERSION` 与 `package.json` 的 `version`。
- **注释就是文档**：文件头的「为什么」引用逆向得到的 ZCode bundle 版本与压缩符号
  （`_reverse/NOTEPAD.md`，gitignore，本地常常不存在）。改行为时保留或更新依据。
- LICENSE 是 CC BY-NC-SA 4.0（非商业），改动涉及许可声明时注意。

## 模块化与文件边界

按职责分，不按行数分。拆不拆看三条：改动是否经常一起发生、是否有独立消费者、是否有独立的
变更理由。别按技术类型硬切（`utils.ts` / `helpers.ts`），也别因为「文件太长」硬劈。设计文档、
两语言 i18n 字典、`AGENTS.md`、所有 `*.test.ts`（`runtime-harness.ts` 是多测试共用基建）、
`captcha-*` / `chat-to-responses` / `config/loader` / `quota.ts` 等单一职责长文件裁决不拆。拆分
行为零变化（视觉、DOM、测试用例数守恒）。

## 目录级契约（改前先读）

- `src/control/AGENTS.md`：`ControlCommand` 命令表、错误语义（HTTP 200 带内 `{ok:false}`）、
  回环双保险、面板 / CLI / 回环监听三个消费者必须同语义。
- `src/provider/AGENTS.md`：`MODELS` 是能力事实、`config.models` 是广告面；vision 是显式字段；
  换默认 / 展示模型两处同步（`loader.ts` `DEFAULTS`、`config.example.yaml` + `template.ts`）。
- `src/server/web/AGENTS.md`：面板骨架的强制约定与正例 class 组合，改 `views/*.html`、
  `styles/*` 或视图 DOM 前先读；取值推导与历史依据在 `docs/design/web-skeleton-contract.md`。

`docs/research/` 是上游行为的**只读证据**（客户端源码逆向、套餐契约、风控码表），被源码注释
引用为依据。它只记录观测到什么、证据在哪，不写实施计划、缺口清单或改进建议——那些属于任务
与设计文档。

## 文本写作规范

所有成段文本按全局 `~/.claude/CLAUDE.md` 的 humanizer 规则写，不在这里重复。
