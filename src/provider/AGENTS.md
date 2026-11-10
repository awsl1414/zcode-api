# src/provider/ — 服务商与模型目录

> 维护基线：2026-11-10。基线只表示最后核对点，不是内容的有效期；能力字段随 `MODELS` 全集维护。溯源证据见 `_reverse/NOTEPAD.md`。

## FILES
| 文件 | 角色 |
|---|---|
| models.ts | 钉死目录 `MODELS`（11 型，spec 对齐 3.11.2 逆向 catalog），只当能力事实表用 |
| providers.ts | zai/bigmodel 端点定义（anthropic/openai base、bizHost） |
| reasoning.ts | GLM-5.3 effort 契约：eligibility、budget 配对与钳制 |
| types.ts | `ProviderId` / `ModelDef` |

## 契约（改错即全线回归）
- **MODELS 是能力事实，config.models 是广告面**：`MODELS` 供 translator 钳制 maxOutputTokens / reasoning 判定（不在广告面的模型仍照常转发、仍需 spec）；`/v1/models`（含 `client_version=pi` 富目录）与聊天页模型下拉读 `config.models`（loader.ts `DEFAULTS.MODELS`，用户可改）。config 里的 id 不在 `MODELS` 全集时照常列出并转发，能力字段缺省。裁 MODELS 前先看 translator/openai-to-anthropic.ts 的 find/some 消费。
- **vision 是显式字段**（`ModelDef.vision`），不是 id 含 "v" 启发式：glm-5.3-flash 无 v 但多模态；`routes-openai` 的 `input_modalities` 与面板聊天页的视觉闸门都读这个标志。
- effort 必须配对 budget_tokens；`"none"`→`"low"`（不可关）；预算按模型 maxOutputTokens 钳制。
- 目录序：当前代默认对领先，其余新→旧——纯呈现层排序，消费方全按 id 查找，序不参与行为。
- **换默认/展示模型需两处同步**：config `DEFAULTS.DEFAULT_MODEL`+`DEFAULTS.MODELS`（loader.ts）、config.example.yaml + template.ts（双编辑契约）。`MODELS` 全集只在能力变化（上架/下架/spec 变更）时动。

## WHERE TO LOOK
| 任务 | 位置 |
|---|---|
| 新模型上架 | models.ts（spec 钉逆向 catalog）+ providers.test.ts 顺序断言 |
| 换广告面 | config.yaml 的 `models`（loader.ts 解析；`/v1/models` 与聊天页的模型下拉都读它，改完即生效） |
| 默认模型 | config/loader.ts `DEFAULTS`（DEFAULT_MODEL / MODELS） |
| effort/thinking 预算 | reasoning.ts + translator/openai-to-anthropic.ts（applyAnthropicThinkingCompat） |

## ANTI-PATTERNS
- 永不为"精简"裁 MODELS 全目录（translator 依赖未广告模型的 spec）。
- 永不把 `/v1/models` 改回读硬编码子集：广告面只有 `config.models` 一处，再建一份常量就会回到两套列表靠巧合一致的局面。
- 永不复活 id-含-"v" 视觉启发式（flash 反例已实锤）。
- spec 数值（contextWindow/maxOutputTokens）钉自逆向 catalog，勿凭印象填。
