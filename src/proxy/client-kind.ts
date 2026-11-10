/**
 * 入站客户端归类。
 *
 * `RequestRecord.clientKind` 的判定来源。为什么放在 intake：客户端是谁在请求头里
 * 就已经定了（User-Agent / 自报头），不等 body 解析、更不等收尾——记录的入站段
 * 字段在能知道的那一刻就写（与 `route` 同一模式）。
 *
 * 归类口径（判定依据全部来自代码事实，不猜）：
 *
 * - `panel`：面板聊天页自己带 `X-ZCode-Client` 头自报（`app-view-chat.js` 的两个
 *   数据面 fetch——对话与模型列表——都带）。浏览器 UA 千差万别（Chrome/Safari/
 *   Firefox），UA 指纹判不了「这是本面板」，自报是唯一可靠的信号。头值
 *   不校验内容：出现即算面板（伪造它只会污染自己的报表）。
 * - `zcode`：User-Agent 以 `ZCode/` 开头。官方桌面客户端对网关的 LLM 请求 UA 是
 *   `ZCode/<ver> ai-sdk/anthropic/3.0.81`（`upstream.ts::ANTHROPIC_SDK_UA` 注释，
 *   bundle `Cm`）——前缀匹配同时覆盖裸 UA 与带 SDK 后缀的形态。
 * - `claude-code`：三个独立信号，命中任一即算：
 *   1. UA 以 `claude-cli/` 开头（Claude Code 自己的 UA：`claude-cli/2.x (external, cli)`，
 *      SDK 客户端同形）；
 *   2. `anthropic-beta` 里带 `claude-code`（CC 自报家门的 beta 串
 *      `claude-code-20250219`；代理出线时把这类 beta 滤掉，入站时它还在）；
 *   3. `x-app: cli` 或带 `x-claude-code-session-id` / `claude-code-session-id`
 *      （CC 2.1.87+ 的网关协议头，`client-session.ts::SESSION_ID_HEADERS` 的
 *      证据注释）。
 * - `other`：其余一切（curl、Cline/Roo 等第三方壳、裸 SDK 脚本……）。没有
 *   「 unidentified 」与「other」之分：报表只关心前几类，剩下的都是 other。
 *
 * 顺序即优先级：面板自报 → ZCode UA → Claude Code（UA 最先，会话头兜底）。前两类
 * 互斥（面板 UA 是浏览器的），CC 的信号不会出现在前两类的真请求上；即便伪造，
 * 后果也只是报表分错类——判定本身不参与任何行为决策（fail-open 的一贯纪律）。
 *
 * 本文件不做 body 指纹（system prompt 里 "You are Claude Code" 之类）：那需要在
 * intake 把大 body 再扫一遍，而 UA/头的信号已经足够回答「哪类客户端」；system
 * prompt 的身份问题由 `system-prompt.ts` 的身份归一层在出线侧处理，不在这边重复。
 */

/** `RequestRecord.clientKind` 的取值全集。*/
export type ClientKind = "claude-code" | "zcode" | "panel" | "other";

/** 面板自报头（`app-view-chat.js` 发出）。出现即归类 panel，值不参与判定。*/
const PANEL_HEADER = "x-zcode-client";

/** Claude Code 的自报家门信号（anthropic-beta 串与两个会话头）。*/
const CC_BETA_MARKER = "claude-code";
const CC_SESSION_HEADERS = ["x-claude-code-session-id", "claude-code-session-id"] as const;

/**
 * 归类一次入站请求的客户端。
 *
 * 只读请求头：intake 阶段在 body 解析之前就要能用（body 可能根本读不出来）。
 */
export function classifyClientKind(headers: Headers): ClientKind {
  // 面板自报（聊天页与模型列表 fetch 都带）。
  if ((headers.get(PANEL_HEADER) ?? "").trim() !== "") return "panel";

  const ua = (headers.get("user-agent") ?? "").trim();
  // UA 判定不区分大小写：客户端生态里 UA 大小写本来就不统一。
  if (/^zcode\//i.test(ua)) return "zcode";
  if (/^claude-cli\//i.test(ua)) return "claude-code";

  // Claude Code 的旁证：beta 串自报 + 网关协议头。
  const beta = (headers.get("anthropic-beta") ?? "").toLowerCase();
  if (beta.includes(CC_BETA_MARKER)) return "claude-code";
  for (const name of CC_SESSION_HEADERS) {
    if ((headers.get(name) ?? "").trim() !== "") return "claude-code";
  }
  if ((headers.get("x-app") ?? "").trim().toLowerCase() === "cli") return "claude-code";

  return "other";
}
