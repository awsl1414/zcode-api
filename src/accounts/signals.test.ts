/**
 * 统一上游信号层的用例。三层各测一遍：
 *
 * 1. **业务码全表**：表里每一行都有一条断言背书（按 kind 分组逐码核对，
 *    zai / bigmodel 两族都查）；
 * 2. **三个解析来源**：全部用实测形态做用例。502+1005 信封（2026-11-09 实测日志）、
 *    200+SSE `[1302][...][request_id]` 帧（`docs/research/upstream-risk-control.md` 的 5.2 节、
 *    实证形态）、claim `429; retry in 600s`（claim 模块实测）、405（同报告第 3 节）、裸 429 无头、
 *    200 空流（start-plan 实测：`{"code":1005}` 的 502 与空流是两种不同形态）；
 * 3. **quota-rules 并表**：额度终态码由全表派生，`1304`/`1308`/`1309`/`1310`/
 *    `1311`/`1316`-`1321` 判 drained。
 *
 * @see 业务码终态分类 · 统一观测点
 */
import { describe, expect, it } from "bun:test";
import {
  BUSINESS_CODE_KINDS,
  codesOfKind,
  emptyStreamSignal,
  kindForBusinessCode,
  signalFromBusinessCode,
  signalFromResponse,
  signalFromStreamError,
  parseRetryAfterSeconds,
  upstreamBizCode,
  type UpstreamSignalKind,
} from "./signals.js";
import { QUOTA_EXHAUSTED_CODES, isQuotaExhaustedCode } from "./quota-rules.js";

// ---------------------------------------------------------------------------
// 1. 业务码全表：每行一例（对照 `docs/research/upstream-risk-control.md` 5.1/5.2 全量）
// ---------------------------------------------------------------------------

/** 测试侧独立复述全表期望——表里每行在这里都有一条背书，不是把实现抄一遍就完。 */
const EXPECTED_TABLE: ReadonlyArray<[number, UpstreamSignalKind]> = [
  // quota-terminal（调研文档 5.2「不重试」表 + 5.1；502 信封携带 1005 是实测形态）
  [1_005, "quota-terminal"],
  [1_113, "quota-terminal"],
  [1_304, "quota-terminal"],
  [1_308, "quota-terminal"],
  [1_309, "quota-terminal"],
  [1_310, "quota-terminal"],
  [1_311, "quota-terminal"],
  [1_316, "quota-terminal"],
  [1_317, "quota-terminal"],
  [1_318, "quota-terminal"],
  [1_319, "quota-terminal"],
  [1_320, "quota-terminal"],
  [1_321, "quota-terminal"],
  // fair-usage（调研文档 5.2：1313，「继续 retry 容易放大异常流量」）
  [1_313, "fair-usage"],
  // rate-limited（调研文档 5.2「会重试」表 + 5.1 3002/2007 + 5.3 并发族 3008-3010）
  [1_302, "rate-limited"],
  [1_303, "rate-limited"],
  [1_305, "rate-limited"],
  [1_312, "rate-limited"],
  [1_120, "rate-limited"],
  [1_230, "rate-limited"],
  [1_234, "rate-limited"],
  [2_007, "rate-limited"],
  [3_002, "rate-limited"],
  [3_008, "rate-limited"],
  [3_009, "rate-limited"],
  [3_010, "rate-limited"],
  // auth（调研文档 5.1：3007 安全校验拒绝、1006 JWT 缺失/失效）
  [3_007, "auth"],
  [1_006, "auth"],
  // model-level（调研文档 5.1：3006 模型不可用；5.2：1261 上下文超窗）
  [3_006, "model-level"],
  [1_261, "model-level"],
];

describe("业务码全表（调研文档 5.1/5.2 全量）", () => {
  it("表里每一行逐码核对（zai / bigmodel 两族同表，各查一遍）", () => {
    for (const [code, kind] of EXPECTED_TABLE) {
      expect(kindForBusinessCode("zai", code)).toBe(kind);
      expect(kindForBusinessCode("bigmodel", code)).toBe(kind);
    }
  });

  it("字符串码归一后命中同一行（上游可能把码发成字符串）", () => {
    expect(kindForBusinessCode("zai", "1005")).toBe("quota-terminal");
    expect(kindForBusinessCode("bigmodel", "1302")).toBe("rate-limited");
  });

  it("未收录码 / 不可归一码 → undefined（保守策略在信号组装层，见下）", () => {
    expect(kindForBusinessCode("zai", 9_999)).toBeUndefined();
    // 调研文档 5.2 的 1314/1315/1008、闲时票据族 3102/3104/3105/3106 等码未收录。
    expect(kindForBusinessCode("zai", 1_314)).toBeUndefined();
    expect(kindForBusinessCode("zai", "abc")).toBeUndefined();
    expect(kindForBusinessCode("zai", undefined)).toBeUndefined();
  });

  it("全表恰好等于测试侧复述（没有实现里多出来、测试没背书的行）", () => {
    for (const family of ["zai", "bigmodel"] as const) {
      const actual = [...BUSINESS_CODE_KINDS[family].entries()].sort(([a], [b]) => a - b);
      const expected = [...EXPECTED_TABLE].sort(([a], [b]) => a - b);
      expect(actual).toEqual(expected);
    }
  });

  it("未收录码 → 保守 rate-limited + detail 带原码（确定策略，不是回避探查）", () => {
    const signal = signalFromBusinessCode(9_999);
    expect(signal.kind).toBe("rate-limited");
    expect(signal.code).toBe(9_999);
    expect(signal.detail).toContain("9999");
    // 命中表的码不带「未收录」标记。
    expect(signalFromBusinessCode(1_302)).toEqual({ kind: "rate-limited", code: 1_302 });
  });
});

// ---------------------------------------------------------------------------
// 2. 解析来源 ①：响应头 + 信封
// ---------------------------------------------------------------------------

describe("signalFromResponse（来源①：响应头 + 信封）", () => {
  it("502 + {\"code\":1005,\"msg\":\"exceed quota limit\"} 信封 → quota-terminal（2026-11-09 实测日志）", () => {
    // 实测原文：upstream returned invalid Anthropic message:
    // {"code":1005,"msg":"exceed quota limit","logid":...}，HTTP 502——上游网关把
    // 业务码包在 5xx 信封里是已实证形态，不是「如有」分支。
    const signal = signalFromResponse(
      502,
      new Headers({ "content-type": "application/json" }),
      '{"code":1005,"msg":"exceed quota limit","logid":"0198c8e2-1c79-7dd3-9f0a-2a1b64f1c0d1"}',
    );
    expect(signal.kind).toBe("quota-terminal");
    expect(signal.code).toBe(1_005);
  });

  it("2xx → success 且不读体（成功响应体大；200 形态的错误判定交给流/翻译层）", () => {
    // bodyText 即便传进来也不解析——正常成功响应是完整 message JSON。
    const signal = signalFromResponse(200, new Headers(), '{"id":"msg_01","content":[{"type":"text","text":"hi"}]}');
    expect(signal).toEqual({ kind: "success" });
    expect(signalFromResponse(200, new Headers(), undefined)).toEqual({ kind: "success" });
  });

  it("405 → endpoint-shape（调研文档 3：405 = invalid_request，重试无用）", () => {
    expect(signalFromResponse(405, new Headers(), "").kind).toBe("endpoint-shape");
  });

  it("404 → endpoint-shape，detail 标注「可能为模型 id 不存在」（404 弱信号）", () => {
    const signal = signalFromResponse(404, new Headers(), "");
    expect(signal.kind).toBe("endpoint-shape");
    expect(signal.detail).toContain("可能为模型 id 不存在");
  });

  it("裸 401 / 403 → auth（由 HTTP 状态判定，不靠码）", () => {
    expect(signalFromResponse(401, new Headers(), undefined).kind).toBe("auth");
    expect(signalFromResponse(403, new Headers(), undefined).kind).toBe("auth");
  });

  it("裸 429 无头 → rate-limited 且无 retryAfterSeconds", () => {
    expect(signalFromResponse(429, new Headers(), undefined)).toEqual({ kind: "rate-limited" });
  });

  it("claim 429; retry in 600s → retryAfterSeconds=600 无 cap（claim 模块实测）", () => {
    // claim 模块实测 429 + Retry-After 600s（claim/client.ts 同一套
    // parseRetryAfterSeconds）；600s > 官方 5min cap，代理侧直接采信，不做截断。
    const signal = signalFromResponse(429, new Headers({ "retry-after": "600" }), undefined);
    expect(signal.kind).toBe("rate-limited");
    expect(signal.retryAfterSeconds).toBe(600);
    // 大值同样直接采信（大值 = 窗口重置远，正是要的精确信号）。
    expect(signalFromResponse(429, new Headers({ "retry-after": "86400" }), undefined).retryAfterSeconds).toBe(86_400);
  });

  it("retry-after 的 HTTP 日期形态：算与 now 的差（RFC 9110 两形态）", () => {
    const now = Date.parse("2026-11-01T00:00:00Z");
    const signal = signalFromResponse(
      429,
      new Headers({ "retry-after": "Sun, 01 Nov 2026 00:10:00 GMT" }),
      undefined,
      now,
    );
    expect(signal.retryAfterSeconds).toBe(600);
  });

  it("x-should-retry 头存在时仍解析 retry-after（本层不特判它，透传语义由调用方决定）", () => {
    const signal = signalFromResponse(
      429,
      new Headers({ "retry-after": "60", "x-should-retry": "false" }),
      undefined,
    );
    expect(signal.kind).toBe("rate-limited");
    expect(signal.retryAfterSeconds).toBe(60);
  });

  it("1313 → fair-usage（调研文档 5.2：风控标记不是速率窗口）", () => {
    const signal = signalFromResponse(429, new Headers(), '{"code":1313,"msg":"fair usage restriction"}');
    expect(signal.kind).toBe("fair-usage");
    expect(signal.code).toBe(1_313);
    // fair-usage 不是额度耗尽，不能走 drained。
    expect(isQuotaExhaustedCode("zai", 1_313)).toBe(false);
  });

  it("429 + 1310 信封 → quota-terminal：表优先于状态（调研文档 5.2「即使由 HTTP 429 携带也保持非重试」）", () => {
    const signal = signalFromResponse(429, new Headers(), '{"code":1310,"msg":"weekly quota exceeded"}');
    expect(signal.kind).toBe("quota-terminal");
    expect(signal.code).toBe(1_310);
  });

  it("403 + 1113 信封 → quota-terminal（权益不足判 drained，调研文档 5.3 第 4 条）", () => {
    const signal = signalFromResponse(403, new Headers(), '{"code":1113,"msg":"余额不足"}');
    expect(signal.kind).toBe("quota-terminal");
  });

  it("401 + 未收录码 → auth：未收录码不推翻强状态（两者不能混）", () => {
    const signal = signalFromResponse(401, new Headers(), '{"code":9999,"msg":"weird"}');
    expect(signal.kind).toBe("auth");
    expect(signal.code).toBe(9_999);
    expect(signal.detail).toContain("9999");
  });

  it("Anthropic 嵌套信封的字符串码同样查表（{\"error\":{\"code\":\"1005\"}}）", () => {
    const signal = signalFromResponse(
      502,
      new Headers(),
      '{"error":{"type":"api_error","code":"1005","message":"exceed quota limit"}}',
    );
    expect(signal.kind).toBe("quota-terminal");
    expect(signal.code).toBe("1005");
  });

  it("5xx 无码 → gateway；4xx 无码 → model-level（来源①兜底）", () => {
    expect(signalFromResponse(502, new Headers(), "<html>Bad Gateway</html>").kind).toBe("gateway");
    expect(signalFromResponse(500, new Headers(), undefined).kind).toBe("gateway");
    expect(signalFromResponse(400, new Headers(), '{"error":{"type":"invalid_request_error"}}').kind).toBe("model-level");
    expect(signalFromResponse(422, new Headers(), undefined).kind).toBe("model-level");
  });

  it("5xx + 未收录码 → 保守 rate-limited，detail 带原码", () => {
    const signal = signalFromResponse(502, new Headers(), '{"code":9999,"msg":"unknown"}');
    expect(signal.kind).toBe("rate-limited");
    expect(signal.code).toBe(9_999);
    expect(signal.detail).toContain("9999");
    expect(signal.detail).toContain("未收录业务码");
  });

  it("429 + 1302 信封 + retry-after：表与头同时生效（调研文档 5.3 并发类码的 Retry-After 语义）", () => {
    const signal = signalFromResponse(429, new Headers({ "retry-after": "30" }), '{"code":1302,"msg":"并发过高"}');
    expect(signal.kind).toBe("rate-limited");
    expect(signal.code).toBe(1_302);
    expect(signal.retryAfterSeconds).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// 3. 解析来源 ②：SSE error frame（HTTP 200 流内）
// ---------------------------------------------------------------------------

describe("signalFromStreamError（来源②：SSE error frame）", () => {
  it("BigModel 强格式前缀 [1302][...][request_id] → rate-limited（调研文档 5.2 实证形态）", () => {
    // 调研文档 5.2 SSE 特例：HTTP 200 的 error frame 里只有 message 没有结构化 code，
    // 正则 ^\\[(\\d{4})\\](?=\\[) 提取四位业务码（对齐 provider-finish-business-error.ts）。
    const signal = signalFromStreamError("error", "[1302][8f3a2b1c][0198f2c1-2f7d-7c2e-9b0a-31c5d8e4f0a1]");
    expect(signal.kind).toBe("rate-limited");
    expect(signal.code).toBe(1_302);
  });

  it("前缀码查表命中终态类：[1310] → quota-terminal", () => {
    const signal = signalFromStreamError("error", "[1310][aa11][req-1]");
    expect(signal.kind).toBe("quota-terminal");
    expect(signal.code).toBe(1_310);
  });

  it("前缀是未收录码：[9999] → 保守 rate-limited + detail 带原码", () => {
    const signal = signalFromStreamError("error", "[9999][aa11][req-1]");
    expect(signal.kind).toBe("rate-limited");
    expect(signal.code).toBe(9_999);
    expect(signal.detail).toContain("9999");
  });

  it("Anthropic 风格 error 帧提取不到码 → gateway（上游流内错误默认按可重试处理）", () => {
    const signal = signalFromStreamError("overloaded_error", "Overloaded");
    expect(signal.kind).toBe("gateway");
    expect(signal.detail).toContain("Overloaded");
  });

  it("前缀不满足强格式（缺第二个方括号）→ 提取不到码 → gateway", () => {
    expect(signalFromStreamError("error", "[1302] just a bracketed number").kind).toBe("gateway");
    expect(signalFromStreamError(undefined, undefined).kind).toBe("gateway");
  });

  it("detail 截断 ≤200 字符（原始错误片段契约）", () => {
    const signal = signalFromStreamError("error", "x".repeat(500));
    expect(signal.detail).toBeDefined();
    expect(signal.detail!.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// 4. 解析来源 ③：空流
// ---------------------------------------------------------------------------

describe("emptyStreamSignal（来源③：空流）", () => {
  it("固定返回 {kind:\"empty-stream\"}，detail 由调用方附上下文", () => {
    expect(emptyStreamSignal()).toEqual({ kind: "empty-stream" });
  });

  it("start-plan 实测：502+1005 信封与 200 空流是两种不同形态", () => {
    // 实测（2026-11-09）：空流 = 200 + 0 stream events（或 200 + 非
    // Message 信封无业务码），25 条嫌疑全部 start-plan、coding-plan 零命中、
    // 两账号反复——上游对不可用服务的 200 软拒绝。它不是 429/1005：
    const envelopeForm = signalFromResponse(502, new Headers(), '{"code":1005,"msg":"exceed quota limit"}');
    const emptyForm = emptyStreamSignal();
    expect(envelopeForm.kind).toBe("quota-terminal");
    expect(emptyForm.kind).toBe("empty-stream");
  });
});

// ---------------------------------------------------------------------------
// 5. quota-rules 并表：quota-terminal 类派生（单一真相）
// ---------------------------------------------------------------------------

describe("quota-rules 并表（额度终态码由全表派生）", () => {
  it("QUOTA_EXHAUSTED_CODES = 全表 quota-terminal 类（派生，无独立白名单）", () => {
    const expected = [
      1_005, 1_113, 1_304, 1_308, 1_309, 1_310, 1_311, 1_316, 1_317, 1_318, 1_319, 1_320, 1_321,
    ];
    expect([...QUOTA_EXHAUSTED_CODES.zai].sort((a, b) => a - b)).toEqual(expected);
    expect([...QUOTA_EXHAUSTED_CODES.bigmodel].sort((a, b) => a - b)).toEqual(expected);
    expect(codesOfKind("zai", "quota-terminal")).toEqual(QUOTA_EXHAUSTED_CODES.zai);
  });

  it("行为翻转：1304/1308/1309/1310/1311/1316-1321 判 drained", () => {
    // 这些码在旧表里缺席，被当作普通 429 每 5 分钟重试；
    // 并表后 isQuotaExhaustedCode 判 true → 观测点按 quota-terminal 信号判 drained。
    for (const code of [1_304, 1_308, 1_309, 1_310, 1_311, 1_316, 1_317, 1_318, 1_319, 1_320, 1_321]) {
      expect(isQuotaExhaustedCode("zai", code)).toBe(true);
    }
    // 原有两码继续判耗尽（回归保持）。
    expect(isQuotaExhaustedCode("zai", 1_005)).toBe(true);
    expect(isQuotaExhaustedCode("bigmodel", 1_113)).toBe(true);
    expect(isQuotaExhaustedCode("zai", "1310")).toBe(true);
  });

  it("非 quota-terminal 的码一律不判耗尽（含 fair-usage / auth / 未收录）", () => {
    for (const code of [1_313, 3_007, 1_006, 3_006, 1_261, 1_302, 3_001, 401, 9_999, "abc", undefined] as const) {
      expect(isQuotaExhaustedCode("zai", code)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 解析基元（已收编自 proxy/upstream-error.ts，零行为变化）
// ---------------------------------------------------------------------------

describe("parseRetryAfterSeconds（delta-seconds 与 HTTP-date 两形态）", () => {
  it("delta-seconds：原样取秒", () => {
    expect(parseRetryAfterSeconds("120", 0)).toBe(120);
    expect(parseRetryAfterSeconds("0", 0)).toBe(0);
  });

  it("HTTP-date：算与 now 的差（并向上取整到秒）", () => {
    const now = Date.parse("2026-11-01T00:00:00Z");
    expect(parseRetryAfterSeconds("Sun, 01 Nov 2026 00:00:30 GMT", now)).toBe(30);
  });

  it("过去的时间点归零（上游时钟偏差不该变成“未来才解冻”）", () => {
    const now = Date.parse("2026-11-01T00:00:00Z");
    expect(parseRetryAfterSeconds("Sun, 01 Nov 2026 00:00:00 GMT", now + 10_000)).toBe(0);
  });

  it("没有头 / 空值 / 不可解：返回 undefined（调用方落成无 until 冷却）", () => {
    expect(parseRetryAfterSeconds(null, 0)).toBeUndefined();
    expect(parseRetryAfterSeconds("   ", 0)).toBeUndefined();
    expect(parseRetryAfterSeconds("soon-ish", 0)).toBeUndefined();
  });
});

describe("upstreamBizCode（从三种信封里取业务码）", () => {
  it("扁平信封 {\"code\":1113}", () => {
    expect(upstreamBizCode('{"code":1113,"msg":"no balance"}')).toBe(1_113);
  });

  it("Anthropic 嵌套信封 {\"error\":{\"code\":\"1113\"}}（码可能是字符串）", () => {
    expect(upstreamBizCode('{"error":{"type":"invalid_request_error","code":"1113"}}')).toBe("1113");
  });

  it("非 JSON / 无 code：undefined（读不出码是常态，不是错误）", () => {
    expect(upstreamBizCode("upstream exploded")).toBeUndefined();
    expect(upstreamBizCode('{"error":{"type":"x"}}')).toBeUndefined();
    expect(upstreamBizCode("null")).toBeUndefined();
  });
});
