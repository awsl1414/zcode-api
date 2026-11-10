<div align="center">

[中文版](README.md) | [英文版](README_EN.md)

# ZCode Proxy

**把你的 GLM 编码套餐，接进所有 AI 编程工具。**

一个跑在自己电脑上的小工具：智谱 Z.AI / Bigmodel 的编码套餐（个人套餐 / 体验套餐）
本来只能在官方客户端里用，ZCode Proxy 在本机把它变成标准的 OpenAI / Anthropic 接口，
于是 Claude Code、Codex、Silly Tavern ……都能直接用上你的套餐额度。

[快速上手](#-一分钟上手) · [接入编码工具](#-把编码工具接上来) · [常见问题](#-常见问题)

</div>

---

## 它能帮你做什么

- 🧩 **一个地址，三种格式** —— OpenAI、Anthropic、Responses（Codex 专用）接口都在本机 `127.0.0.1:8080` 上，工具认哪种就给它哪种。
- 🖥️ **带网页面板** —— 启动后在浏览器里管理：账号、路由策略、额度、实时日志、设置。面板和代理共用一个端口，首次启动打印一次管理员密码；绑定地址默认跟随代理，想只给本机就把 `panel.host` 设成 `127.0.0.1`。
- 💬 **自带网页聊天**：面板侧栏的「聊天」视图就是一个本地 ChatGPT 风格聊天页，随手测试模型——不用另开端口，也不用记第二个地址。
- 🌙 **闲时通道 & 套餐秒抢**（可选）—— 错峰时段的免费额度通道、限量体验套餐自动领取，都是内置功能。
- 🔌 **套餐内 MCP 聚合端点** —— ZCode 官方插件 MCP（天眼查 / Wind / 同花顺 iFinD…）聚合到**单一** `/mcp` 端点（streamable HTTP，工具名 `{plugin}__{tool}` 命名空间化——客户端只配一个 MCP server 即可，需 coding-plan 登录，浏览器 `GET /mcp` 查看目录）。
- 🪟 **全平台** —— Windows / macOS / Linux 一份代码直接跑，也能编译成单文件程序或 Docker 部署。

## 🚀 一分钟上手

### 第 1 步：从[GitHub Releases](https://github.com/awsl1414/zcode-api/releases)下载最新版本的exe

没错，这就完了，就是这么简单

启动后代理直接跑起来，并在终端打印面板地址与一次性的管理员密码（同时在有桌面会话时打开浏览器）：

```text
zcode-proxy listening on http://127.0.0.1:8080
panel: http://127.0.0.1:8080/
panel: admin password (shown once, change it in Settings):
        Xk9mP2vL8nQ4wR7t
```

面板和代理共用 8080，打开就是登录页：用户名 `admin`，密码是上面那行。登录之后可在设置页改密码。

面板的侧栏有八个视图：**概览**（代理状态 / 端口 / 在飞数 / 风控告警）、**统计**（用量聚合与 365 天热力图）、**账号**（账号表、添加 / 编辑 / 启停 / 删除，全部热生效）、**路由策略**（order / mode / strategy / 粘性 / 风控开关）、**API key**、**日志**（SSE 实时流、按账号与级别过滤、搜索）、**设置**（登录 / 登出、检查更新、改密码、逐字段写回 `config.yaml`）、**聊天**。出口代理表不占单独页面，是账号页里的抽屉。聊天是侧栏里的一个视图，不是独立页面。面板里没有「启停代理」的按钮：它和代理共用一个监听，关掉等于把自己也关掉，停服务用 Ctrl+C / 进程管理器。

> 想纯后台静默运行（无浏览器 / 无 TTY）：`zcode-proxy --cli serve`。`--no-panel` 只关面板、代理照跑，适合已经配好账号的机器；容器里别用，面板是建账号、建 API key 的入口。旧的终端 TUI 已在 5.0 移除，`zcode-proxy tui` 会明确报错。

## 🔌 把编码工具接上来

代理启动后，本机地址就是 **`http://127.0.0.1:8080`**。你的工具只需要改两样东西：**接口地址**和**模型名**。

关于「API Key」：在面板的「API key」页（`/keys`）给每个程序建一把，工具里填那一把，只显示一次。还没建 key 时数据面不校验，随便填（如 `sk-1234`）即可。

<details>
<summary><b>Claude Code</b>（点开看配置）</summary>

```bash
# macOS / Linux
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_AUTH_TOKEN=sk-1234
export ANTHROPIC_MODEL=glm-5.3
claude
```

```powershell
# Windows PowerShell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8080"
$env:ANTHROPIC_AUTH_TOKEN = "sk-1234"
$env:ANTHROPIC_MODEL = "glm-5.3"
claude
```

</details>

<details>
<summary><b>Codex CLI</b>（走 Responses 接口）</summary>

编辑 `~/.codex/config.toml`：

```toml
model_provider = "zcode"
model = "glm-5.3"

[model_providers.zcode]
name = "ZCode Proxy"
base_url = "http://127.0.0.1:8080/v1"
wire_api = "responses"
env_key = "ZCODE_API_KEY"   # 任意非空值即可，除非你设置了代理密钥
```

</details>

<details>
<summary><b>其他 OpenAI 兼容工具</b>（Cherry Studio、Kilo Code、Cline、LobeChat…）</summary>

在工具的"自定义提供商 / Custom Provider"里填：

| 设置项 | 值 |
|--------|-----|
| API 地址 (Base URL) | `http://127.0.0.1:8080/v1` |
| API Key | 你的代理密钥（没设就随便填） |
| 模型 | `glm-5.3`、`glm-5.3-flash`，见下方模型表 |

Anthropic 格式的工具（如某些 Claude 客户端）地址填 `http://127.0.0.1:8080`，路径 `/v1/messages` 代理会自动接。

</details>

想先手动试一下？登录面板后点侧栏的「聊天」，或者用 curl：

```bash
curl http://127.0.0.1:8080/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "glm-5.3-flash",
  "messages": [{"role": "user", "content": "你好！"}]
}'
```

<details>
<summary><b>Docker 部署</b></summary>

镜像多架构（amd64 / arm64），以 `bun` 用户运行。多阶段构建后的运行层仅带应用 bundle 和验证码 worker，不带 `node_modules`、源码、测试或额外构建工具，保留完整功能。面板挂在代理自己的监听上，一个端口服务所有，所以只映射 `8080`。

```bash
mkdir -p data                        # Docker 会以 root 创建不存在的挂载目录，而容器以 uid 1000 运行
docker compose up -d                  # 仓库根目录的 docker-compose.yml，先把种子换成固定随机串
docker compose logs zcode-proxy       # 找管理员密码那一行
```

首次启动的日志长这样（密码只打印这一次，在面板里改过就不会再出现）：

```text
Created /data/config.yaml from bundled template.
Run: zcode-proxy auth login <zai|bigmodel>

No account yet. Open the panel to add one, or run:
  zcode-proxy auth login zai|bigmodel
  zcode-proxy auth import [--jwt <token>]
panel: admin password (shown once, change it in Settings):
        Xk9mP2vL8nQ4wR7t
zcode-proxy listening on http://0.0.0.0:8080
panel: http://127.0.0.1:8080/
09:41:07 W [panel] panel reachable on a non-loopback address: anyone who reaches this port and signs in can log out, change settings, or shut down host=0.0.0.0
  models: 2 available
  /async/v1/*: ON        # 只有开了 async.enabled 才会出现
```

`panel: http://127.0.0.1:8080/` 那行是回环地址，只在宿主机的浏览器里点得开；从这里或局域网访问用 `http://<宿主机>:8080/`。

打开 `http://<宿主机>:8080/`，用户名 `admin` 加那行密码登录，然后：

1. 在「账号」页添加账号（面板里走登录流程，或导入已有凭据）。没有账号时代理照样启动，请求会按 `no-account` 回 503。
2. 在「API key」页建一把 key 填给客户端。建第一把之前数据面不校验，随便填也行。

不想写 compose 文件也可以：

```bash
mkdir -p data
docker run -d --name zcode-proxy -p 8080:8080 \
  -v "$(pwd)/data:/data" \
  -e ZCODE_PROXY_CREDENTIAL_SECRET="一串只有你知道的固定随机串" \
  ghcr.io/awsl1414/zcode-proxy:latest
```

compose 文件（仓库里的 `docker-compose.yml` 就是这个）：

```yaml
services:
  zcode-proxy:
    image: ghcr.io/awsl1414/zcode-proxy:latest
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data
    environment:
      # 账号文件的加密种子。改它等于丢失所有已导入的账号。
      ZCODE_PROXY_CREDENTIAL_SECRET: "换成一串固定的随机字符"
    restart: unless-stopped
```

`./data` 是整个安装的存储目录：`config.yaml`（首次启动自动生成）、`accounts.json`、`apikeys.json`、`users.json`、`policy.json`，以及运行期写出的 `requests.jsonl`（请求记录）、`activities.jsonl`（抢活动台账）与 `control.port`。备份、换机器、迁移都只拷这一个目录。

挂载目录要先建：不存在时由 Docker 以 root 建，而容器以 uid 1000（镜像里的 `bun` 用户）运行，写 `config.yaml` 会直接报权限错误。宿主机第一个用户不是 uid 1000 时，改成 `mkdir -p data && sudo chown 1000:1000 data`。

`ZCODE_PROXY_CREDENTIAL_SECRET` 是这几个文件的加密种子，定了就别改：换一个值等于让已导入的账号与新写的 key 全部解不开。它不进 `config.yaml`，因为那等于把密钥明文存进配置文件。

端口在 `data/config.yaml` 的 `server.port`（模板默认 8080）。改端口要同时改 compose 的 `ports`，容器内的监听跟着 YAML 走。容器自带 `HEALTHCHECK`，探针打 `/healthz`（控制面的无鉴权路径，建了 API key 也不会 401）；用 `--no-panel` 启动时这个路径没有响应，容器会显示 unhealthy。

</details>

<details>
<summary><b>可调的配置与环境变量</b>（改不改都能跑）</summary>

配置文件是进程当前目录下的 `config.yaml`（首次启动自动生成，完整注释见 [`config.example.yaml`](config.example.yaml)）；容器里由 `ZCODE_PROXY_CONFIG` 指到 `/data/config.yaml`。**配置只有一个入口：`config.yaml`，或者面板的设置页**（面板写回的就是这个文件）。环境变量用于进程级覆盖，不参与用户配置，所以改端口、开关、端点这类事都在 `config.yaml` 里做。

运行时会读的环境变量，都不是用户配置：

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `ZCODE_PROXY_CONFIG` | `config.yaml` | 配置文件路径（启动参数，此时还不知道 YAML 在哪；镜像里是 `/data/config.yaml`） |
| `ZCODE_PROXY_STORE_DIR` | `~/.zcode-proxy` | 存储目录：账号、API key、控制面用户、账号策略都写在这里（镜像里是 `/data`） |
| `ZCODE_PROXY_CREDENTIAL_SECRET` | 机器相关 | 那几个存储文件的加密种子（跨机器迁移/Docker 时需要固定它） |
| `ZCODE_LOG_FORMAT` | 桌面表格 | 设为 `compact` 可得单行日志（适合窄屏与 `docker logs`，镜像里默认就是） |
| `ZCODE_ENV` | 生产 | 设为 `test` 时把客户端的 release channel 报成 test；桌面场景不用管 |
| `ZCODE_UPDATE_CHECK` / `ZCODE_UPDATE_SKIP` | 开 / 无 | 关掉「有新版」检查 / 逗号分隔要忽略的版本，如 `v5.0.0,v5.0.1` |
| `HTTP_PROXY` / `HTTPS_PROXY` | 无 | 系统代理，验证码求解与出线请求会走它 |
| `CAPTCHA_POOL_MAX` / `CAPTCHA_SOLVE_CONCURRENCY` / `CAPTCHA_CPU_LIMIT_PCT` | `60` / `3` / `100` | 验证码池的上限、求解并发、CPU 占用上限（低端机往下调） |

另外几个是进程级覆盖，桌面部署通常不用管：`ZCODE_IDENTITY_*`（显式覆盖出站身份头，默认取本机真实值）、`ZCODE_DUMP_UPSTREAM` / `CAPTCHA_DEBUG` / `CAPTCHA_DEBUG_BODIES`（排障）、`CAPTCHA_ACQUIRE_BUDGET_MS` / `CAPTCHA_CONFIG_TIMEOUT_MS` / `CAPTCHA_CONFIG_TTL_MS`（验证码取配置与重试预算，默认 45s / 15s / 1h）、`ZCODE_CAPTCHA_WORKER` / `ZCODE_CAPTCHA_WARM_WORKERS`（编译产物里的 worker 路径与预热池大小）、`MCP_AGGREGATE_TOOLS_TTL_MS`（`/mcp` 工具缓存，默认 5 分钟）、`ZCODE_OAUTH_PASTE`（等价于 `auth login --paste`）。

套餐类型（`plan`: `coding-plan` 个人套餐 / `start-plan` 体验套餐）是**账号**的属性：导入凭据时按凭据与订阅得出，进程级策略不覆盖它。所以换套餐就是换账号：`zcode-proxy auth account` 命令族或面板的「账号」页删除重建，重新导入后立即生效。

面板默认就开着，和代理**同一个端口**（`config.yaml` 的 `panel.enabled` 开关、`panel.host` 改绑定地址，`--no-panel` 只影响这一次启动）。面板能看状态与额度、管理账号、改路由策略、登录登出、看实时日志（MCP 目录在数据面的 `GET /mcp`，不在面板里）。访问走登录页：首次启动会在终端打印一次管理员密码（用户名 `admin`），登录后可在设置页修改，会话存在服务端、12 小时滑动续期。命令走进程内分发，不会再额外开一个控制端口。SIGTERM/SIGINT 和面板的 shutdown 都会先清掉后台定时器（包括自动领取与验证码池），再退出。在面板里登出只结束面板会话，上游账号与凭据不受影响。

**有新版提示**：启动时会异步向 GitHub 查一次 latest release，最多多打一行日志（面板「设置」页可手动重查），不阻塞启动、不影响代理；离线、被挡、限流或返回格式变了都一律静默忽略。手动检查总会给你明确答复（「已是最新」或「检查不可用」）。容器里镜像是不可变的，所以提示给的是**当前运行时的拉取命令**（Docker 为 `docker compose pull && docker compose up -d`，Podman 为 `podman compose pull && podman compose up -d`；认不出运行时则只说「拉取新镜像后重建容器」），而不是自己去替换文件（release 目前也没有校验和，所以不做自动下载替换）。不想让它查就设 `ZCODE_UPDATE_CHECK=off`，某个版本太吵可以 `ZCODE_UPDATE_SKIP=v5.0.0` 忽略。

**Docker 里怎么连面板**：面板挂在代理自己的监听上，所以 `-p 8080:8080` 一个端口就够，打开 `http://<宿主机>:8080/` 就是登录页。管理员密码在首次启动的 `docker logs` 里。密码登录之后，面板与代理共用一个端口、一套会话。

非容器部署想只把控制面留给本机，把 `config.yaml` 里的 `panel.host` 设成 `127.0.0.1`：代理仍绑 `0.0.0.0`，面板只接受本机请求。容器里别这么设，那会让宿主机也连不上面板。

</details>

<details>
<summary><b>进阶功能：闲时通道 & 套餐自动领取</b></summary>

**闲时通道 (`/async/*`)** —— 凌晨等错峰时段官方释放的免费算力通道。请求先排队领票，轮到了自动发给模型（适合不着急的批量任务）。`config.yaml` 里 `async.enabled: true` 打开；注意它一次性、不带会话记忆，多轮对话要把历史放进请求里。

**周末/体验套餐自动领取 (claim)** —— 默认开启。代理每 5 分钟探测一次官方的限量套餐活动（`claim.pollIntervalMs`），活动开场前预热、开场瞬间连发；要停后台任务设 `claim.auto: false`，要整块关掉设 `claim.enabled: false`。手动抢：`bun run src/index.ts claim`。

**额度显示 (quota)** —— 后台按 `accounts.quota.pollSeconds`（默认 300 秒）逐账号采样，启动时另有一轮首轮探测，所以登录之后额度会自己刷新；顶栏刷新按钮与 `r` 键按当前视图触发即时复采。数据来自上游两个额度平面：体验/积分制套餐的积分桶（`billing/balance`，剩余 / 总额、到期时间），以及个人编码套餐的用量窗口（`/api/monitor/usage/quota/limit`，与官方用量面板同源，5 小时 / 周窗口的**剩余额度**与重置时间——上游 `number` 不是可与剩余比较的总量，所以与 CLI 一致只显示剩余，只有上游给出百分比时才画比例条）。命令行直接查：`bun run src/index.ts quota`（对应 HTTP 接口 `GET /quota`）。

</details>

## 🧮 可用模型

列表仅供展示：

| 模型 | 上下文 | 最大输出 |
|------|--------|----------|
| `glm-5.3` | 1M | 128K |
| `glm-5.3-flash`（视觉） | 1M | 128K |

## ❓ 常见问题

**启动后提示 No account yet / 请求回 503？**
没有账号时代理照样启动，只是请求按 `no-account` 回 503。登录：`bun run src/index.ts auth login zai`（或 bigmodel），或在面板「账号」页添加。登录一次即可，凭据加密保存。

**端口 8080 被占了？**
改 `config.yaml` 的 `server.port`（或在面板设置页改，写回同一个文件）。

**工具一直连不上 / 401？**
工具里要填面板「API key」页建的某一把 key。表里一把 key 都没有时数据面不校验，随便填即可；一旦建了 key，除面板自己的会话（浏览器里登录过面板）外**所有路由**（包括 `/health`）都要带它，被禁用的 key 与填错的 key 一样收到 401。

**换电脑 / 重装系统后要重新登录吗？**
要。凭据加密时绑定了本机信息。跨机器迁移可以两边都设 `ZCODE_PROXY_CREDENTIAL_SECRET` 为同一个值，再把 `~/.zcode-proxy/` 整个目录拷过去（账号、key、控制面用户都在里面）。

**服务器上没有浏览器怎么登录？**
直接登录即可：`bun run src/index.ts auth login zai`（或 bigmodel）。登录链接在任何设备的浏览器打开都行，授权后本机自动完成（无需回调页面）。若想手动交换，也有粘贴模式：`auth login bigmodel --paste`，把跳转后的完整网址粘回来即可。

**已经在 ZCode 客户端登录过，还要重新授权吗？**
不用。`bun run src/index.ts auth import` 会读 `~/.zcode/v2/credentials.json`，用里面的 OAuth token 换出编码套餐的 API Key，并把套餐 JWT 一并导入；换不出来时留下的 JWT 只够跑体验套餐（start-plan）、查额度和领套餐，MCP、闲时通道、加速卡还需要编码套餐密钥。手里只有 JWT 就粘：`auth import --jwt <token>`。导入不做续期，凭据失效后重新导入或重新登录即可。

**它在后台到底做了什么？**
它就是一个"翻译官 + 传话员"：把你的工具发出的标准请求翻译成官方客户端的同款请求转发上去，再把回复原样翻译回来。所有流量都只在你本机和官方服务器之间，不经过任何第三方。

## 🛠️ 参与开发

```bash
bun test            # 跑测试
bun x tsc --noEmit  # 类型检查
bun run dev         # 开发模式启动面板
```

架构与实现细节见 [`src/`](src/) 下各源码文件内的注释。

### CI 与发版

- **CI 必过**：`.github/workflows/ci.yml` 在每个 PR 与 master 直推上跑（类型检查 + 测试 + 面板拼装冒烟）。分支保护（Settings → Branches → Branch protection rules）把 `test` / `panel-build` 两个 check 设为 required，不绿不合并。
- **发版手动触发**：`.github/workflows/release.yml` 只由 Actions 页面手动 dispatch（输入 tag，如 `v5.0.0`），流程：verify → 版本号自动写回 `package.json`（`src/version.ts` 从它派生）→ 五平台二进制全部进同一个 Release（changelog 由 GitHub 按提交自动生成，tag 含 alpha/beta/rc 自动标 prerelease）。
- **依赖周更**：`.github/dependabot.yml` 每周为 GitHub Actions 与 bun 依赖提升级 PR（新发布版本有 7 天冷却期）。

## Privacy

本代理完全本地运行：**无遥测、无分析、无任何形式的外发报告**。你的使用数据、设备信息与配置不会离开本机；debug/dump 日志会自动脱敏 API key、JWT 与 proxy key。

## License

Copyright (c) 2026 awsl1414 and the ZCode Proxy contributors.
Based on ZCode Proxy by TriDefender and contributors.

本项目采用 **[CC BY-NC-SA 4.0（署名—非商业性使用—相同方式共享 4.0 国际）](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)**。[LICENSE](LICENSE) 收录未经修改的官方标准全文；文件开头为项目的版权与许可声明。

- **非商业性使用**：允许在遵守许可的前提下免费复制、分享和改编；不得用于主要以商业利益或金钱报酬为目的的活动。
- **署名并保留声明**：分享原作或改编作品时，须按许可要求保留原作者署名、已提供的原始版权声明、许可声明及免责声明，提供许可链接，并注明是否修改。
- **相同方式共享**：公开分享改编作品时，须按本许可允许的相同或兼容许可授权，不得施加限制许可权利的附加法律条款或技术措施。

**适用边界**：CC BY-NC-SA 4.0 没有强制提供软件源码的条款，不能严格保证禁止闭源，也不要求网络服务公开对应源码；本项目未附加此类自定义限制。CC 官方[不推荐将 CC 许可用于软件](https://creativecommons.org/faq/#can-i-apply-a-creative-commons-license-to-software)，本项目选择其非商业、署名和相同方式共享条件。不含本项目受许可内容的独立工具产出不会仅因使用本项目而自动适用此许可。

第三方组件继续适用各自的许可。本许可仅覆盖权利人有权按这些条款授权的内容；此前依法取得的 MIT 授权不会被追溯撤销。上述说明为摘要，完整条件以 [LICENSE](LICENSE) 和[官方法律文本](https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.zh-hans)为准。

## 协议与维护说明

Responses hosted 搜索工具不会在服务端执行。
