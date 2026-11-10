/**
 * 统一错误分类学的落码与三出口同源测试。
 *
 * 每个 errorCode 都要有：① 产生点身份 ② 健康层的 kind（上游族）/ 统计层分组键
 * ③ 用户层的两语言用户词 + hint。三处都从 `error-codes.ts` 的同一张表派生，
 * 所以这里按全表遍历，而不是手挑几个「看起来重要」的码。
 */
import { describe, expect, it } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import {
  ERROR_CODES,
  LOCAL_ERROR_CODES,
  UPSTREAM_ERROR_CODES,
  errorCodeOf,
  errorCodeOfUpstreamEvent,
  isErrorCode,
  signalKindOfErrorCode,
} from "./error-codes.js";
import type { ErrorCode } from "./error-codes.js";
import type { BrokerErrorCode } from "../accounts/broker.js";
import type { UpstreamSignalKind } from "../accounts/signals.js";
import { httpForBrokerError } from "./lease.js";
import { computeUsageStats } from "./usage-stats.js";
import { errorResponse } from "./http-io.js";
import zhDictionary from "../server/web/i18n/zh.json" with { type: "json" };
import enDictionary from "../server/web/i18n/en.json" with { type: "json" };
import { errorUserWord, errorUserHint } from "../cli/error-words.js";

/** 表一：broker 结构化码直通（表外的内部码也有明确身份）。*/
const BROKER_TO_CODE: readonly [BrokerErrorCode, ErrorCode][] = [
  ["accounts-saturated", "accounts-saturated"],
  ["all-accounts-cooling", "all-accounts-cooling"],
  ["quota-exhausted", "quota-exhausted"],
  ["auth-invalid", "auth-invalid"],
  ["route-broken", "route-broken"],
  ["model-unsupported", "model-unsupported"],
  ["account-disabled", "account-disabled"],
  ["queue-timeout", "queue-timeout"],
  ["no-account", "account-disabled"],
  ["account-unhealthy", "all-accounts-cooling"],
  ["account-unknown", "other"],
  ["route-not-allowed", "other"],
];

/** 表二：`UpstreamSignal.kind` → 上游族 errorCode 逐行。*/
const KIND_TO_CODE: readonly [UpstreamSignalKind, ErrorCode | undefined][] = [
  ["success", undefined],
  ["rate-limited", "upstream-rate-limited"],
  ["fair-usage", "upstream-fair-usage"],
  ["auth", "upstream-auth-rejected"],
  ["quota-terminal", "upstream-quota-terminal"],
  ["endpoint-shape", "upstream-endpoint-shape"],
  ["gateway", "upstream-gateway"],
  ["transport", "upstream-transport"],
  ["empty-stream", "upstream-empty-stream"],
  ["model-level", "upstream-model-level"],
];

describe("errorCode 全表", () => {
  it("8 本地 + 11 上游 + other，键唯一且稳定", () => {
    expect(LOCAL_ERROR_CODES).toHaveLength(8);
    expect(UPSTREAM_ERROR_CODES).toHaveLength(11);
    expect(ERROR_CODES).toHaveLength(20);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(ERROR_CODES[ERROR_CODES.length - 1]).toBe("other");
  });

  it("broker 产生点：逐行映射，表内码直通", () => {
    for (const [brokerCode, expected] of BROKER_TO_CODE) {
      expect(errorCodeOf(brokerCode)).toBe(expected);
    }
    // 每个 broker 码都有 HTTP 语义（Record 的编译期护栏在此也过一遍运行期）。
    for (const [brokerCode] of BROKER_TO_CODE) expect(httpForBrokerError(brokerCode).status).toBeGreaterThanOrEqual(400);
  });

  it("observeUpstream 信号产生点：逐行映射，success 不是错误", () => {
    for (const [kind, expected] of KIND_TO_CODE) {
      expect(errorCodeOf(kind)).toBe(expected);
      // 健康出口反查同一个身份（成功无身份）。
      if (expected !== undefined) expect(signalKindOfErrorCode(expected)).toBe(kind);
    }
  });

  it("event 形态产生点与 readUpstreamSignal 的 kind 同源", () => {
    expect(errorCodeOfUpstreamEvent("connect-failed")).toBe(errorCodeOf("gateway")!);
    expect(errorCodeOfUpstreamEvent("stream-interrupted")).toBe(errorCodeOf("transport")!);
    expect(errorCodeOfUpstreamEvent("empty-stream")).toBe(errorCodeOf("empty-stream")!);
    expect(errorCodeOfUpstreamEvent("biz-code")).toBe("upstream-error");
    expect(errorCodeOfUpstreamEvent("stream-error")).toBe("upstream-error");
  });

  it("非上游族没有 signal kind（不会误进健康引擎）", () => {
    for (const code of [...LOCAL_ERROR_CODES, "upstream-error", "translate-failed", "other"] as ErrorCode[]) {
      expect(signalKindOfErrorCode(code)).toBeUndefined();
    }
  });

  it("isErrorCode 只是集合检查，不猜字符串", () => {
    for (const code of ERROR_CODES) expect(isErrorCode(code)).toBe(true);
    expect(isErrorCode("upstream_error")).toBe(false);
    expect(isErrorCode("saturated")).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
    expect(isErrorCode("dispatch")).toBe(false);
  });
});

describe("三出口同源", () => {
  it("① 健康层：每个上游族码反查回原 kind", () => {
    for (const code of UPSTREAM_ERROR_CODES) {
      const kind = signalKindOfErrorCode(code);
      if (code === "upstream-error" || code === "translate-failed") {
        expect(kind).toBeUndefined();
      } else {
        expect(kind).toBeDefined();
        expect(errorCodeOf(kind!)).toBe(code);
      }
    }
  });

  it("② 统计层：每个 errorCode 一个分组键，零字符串猜分类", () => {
    // 聚合器读 JSONL；这里直接写每种码各一条、消息全部相同，验证分类不看消息。
    const lines = ERROR_CODES.map((code, index) => JSON.stringify({
      reqId: `#w112-${index}`,
      startedAt: 1_700_000_000_000,
      format: "anthropic",
      model: "m",
      stream: false,
      requestBytes: 1,
      retries: 0,
      stages: [],
      apiKeyId: "",
      failedStage: "dispatch",
      error: "identical free text for every code",
      errorCode: code,
    }));
    const path = `/tmp/w112-error-codes-${process.pid}.jsonl`;
    writeFileSync(path, lines.join("\n") + "\n");
    try {
      const stats = computeUsageStats({ path });
      const groups = new Map(stats.errors.map((row) => [row.kind, row.count]));
      for (const code of ERROR_CODES) expect(groups.get(code)).toBe(1);
      expect(stats.totals.errorCount).toBe(ERROR_CODES.length);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("③ 用户层：zh/en 全键（用户词 + hint），CLI 读同一批键", () => {
    const zh = zhDictionary as Record<string, string>;
    const en = enDictionary as Record<string, string>;
    for (const dict of [zh, en]) {
      for (const code of ERROR_CODES) {
        expect(dict[`errorCode.${code}`]).toBeTruthy();
        expect(dict[`errorCode.${code}.hint`]).toBeTruthy();
        // 内部实现词零残留：用户词讲的是发生了什么，不是代码里的枚举名。
        expect(dict[`errorCode.${code}`]).not.toMatch(/dispatch|saturated|all-cooling|no-account|upstream_error|translate_failed/);
      }
    }
    for (const code of ERROR_CODES) {
      expect(errorUserWord(code)).toBe(zh[`errorCode.${code}`]);
      expect(errorUserHint(code)).toBe(zh[`errorCode.${code}.hint`]);
    }
    // 旧展示词键删净（零兼容）；新的调度计数标签不与 errorCode 词表混。
    for (const key of ["stats.errors.byStage", "stats.errors.byKind", "stats.schedule.queueTimeout"]) {
      expect(zh[key]).toBeUndefined();
      expect(en[key]).toBeUndefined();
    }
  });

  it("errorResponse 把产生点的码带给客户端（detail 原文不变）", async () => {
    for (const code of ERROR_CODES) {
      const resp = errorResponse(503, "upstream_error", "raw detail text", undefined, code);
      const body = (await resp.json()) as { error: { type: string; message: string; code: ErrorCode } };
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe("raw detail text");
    }
  });
});
