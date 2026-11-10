import { describe, expect, it } from "bun:test";
import { classifyClientKind } from "./client-kind.js";
import type { ClientKind } from "./client-kind.js";

/** 表驱动的归类测试：每行 = 一组请求头 → 期望的 clientKind。 */
function headersOf(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("classifyClientKind", () => {
  it("classifies by the evidence table (headers only, no body)", () => {
    const table: Array<[Record<string, string>, ClientKind]> = [
      // 空头：other（curl 之类不带 UA 的裸请求也是 other，不是缺失）。
      [{}, "other"],
      // 面板自报：值不参与判定，出现即算。
      [{ "x-zcode-client": "panel-web" }, "panel"],
      [{ "x-zcode-client": "anything" }, "panel"],
      // 面板自报优先于 UA（面板 UA 是浏览器的，但万一伪造了 ZCode UA 也先认自报）。
      [{ "x-zcode-client": "panel-web", "user-agent": "ZCode/3.17.1" }, "panel"],
      // ZCode 桌面客户端：裸 UA 与带 SDK 后缀的形态（upstream.ts::ANTHROPIC_SDK_UA）。
      [{ "user-agent": "ZCode/3.17.1" }, "zcode"],
      [{ "user-agent": "ZCode/3.17.1 ai-sdk/anthropic/3.0.81" }, "zcode"],
      [{ "user-agent": "zcode/3.17.1" }, "zcode"],
      // Claude Code：UA。
      [{ "user-agent": "claude-cli/2.1.87 (external, cli)" }, "claude-code"],
      // Claude Code：beta 串自报（入站还在，出线被 beta 白名单滤掉）。
      [{ "user-agent": "curl/8.4.0", "anthropic-beta": "claude-code-20250219,oauth-2025-04-20" }, "claude-code"],
      // Claude Code：网关协议头（CC 2.1.87+）。
      [{ "user-agent": "node", "x-claude-code-session-id": "s-1" }, "claude-code"],
      [{ "user-agent": "node", "claude-code-session-id": "s-1" }, "claude-code"],
      [{ "user-agent": "node", "x-app": "cli" }, "claude-code"],
      // 第三方壳与脚本：other。
      [{ "user-agent": "Mozilla/5.0 (Macintosh) Chrome/126" }, "other"],
      [{ "user-agent": "OpenAI/JS 4.68.0" }, "other"],
      [{ "user-agent": "opencode/1.0" }, "other"],
      // 非自报的 x-zcode 头不算面板（X-ZCode-Account/Route 是显式路由头）。
      [{ "x-zcode-account": "work", "x-zcode-route": "start-plan" }, "other"],
      // 空白值等同没有。
      [{ "x-zcode-client": "  " }, "other"],
      [{ "user-agent": "  " }, "other"],
    ];
    for (const [entries, expected] of table) {
      expect([entries, classifyClientKind(headersOf(entries))]).toEqual([entries, expected]);
    }
  });

  it("is a pure header function: same headers, same kind", () => {
    const entries = { "user-agent": "claude-cli/1.0" };
    expect(classifyClientKind(headersOf(entries))).toBe(classifyClientKind(headersOf(entries)));
  });
});
