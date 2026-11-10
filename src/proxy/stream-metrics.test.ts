import { describe, expect, it } from "bun:test";
import { StreamMetrics } from "./stream-metrics.js";

describe("stream generation throughput", () => {
  it("excludes prefill, metadata, usage/close delays for both short and long outputs", () => {
    for (const tokens of [11, 101, 1001]) {
      const m = new StreamMetrics();
      m.observe({ choices: [{ delta: { role: "assistant", content: "" } }] }, 0);
      m.observe({ choices: [{ delta: { content: "first" } }] }, 5000);
      m.observe({ choices: [{ delta: { content: "last" } }] }, 5000 + (tokens - 1) * 10);
      m.observe({ usage: { completion_tokens: tokens } }, 100000);
      expect(m.tokensPerSecond).toBe(100);
    }
  });

  it("includes thinking and tool arguments, but not signatures or terminal metadata", () => {
    const m = new StreamMetrics();
    m.observe({ type: "message_start", message: { usage: { output_tokens: 1 } } }, 0);
    m.observe({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "think" } }, 1000);
    m.observe({ type: "content_block_delta", delta: { type: "text_delta", text: "answer" } }, 1500);
    m.observe({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } }, 2000);
    m.observe({ type: "content_block_delta", delta: { type: "signature_delta", signature: "sig" } }, 4000);
    m.observe({ type: "message_delta", usage: { output_tokens: 101 } }, 5000);
    expect(m.tokensPerSecond).toBe(100);
  });

  it("observes OpenAI reasoning and tool argument deltas including usage on the same event", () => {
    const m = new StreamMetrics();
    m.observe({ choices: [{ delta: { reasoning_content: "think" } }] }, 0);
    m.observe({ choices: [{ delta: { tool_calls: [{ function: { arguments: "{}" } }] } }], usage: { completion_tokens: 51 } }, 1000);
    expect(m.tokensPerSecond).toBe(50);
  });

  it("does not invent counts from chunks or rates from a single delivery", () => {
    const m = new StreamMetrics();
    m.observe({ choices: [{ delta: { content: "many tokens in one chunk" } }] }, 1000);
    expect(m.tokens).toBe(0);
    m.observe({ usage: { completion_tokens: 100 } }, 3000);
    expect(m.tokensPerSecond).toBe(0);
    m.observe({ usage: { completion_tokens: NaN } }, 4000);
    expect(m.tokens).toBe(100);
  });
});

describe("cache token buckets", () => {
  it("reads Anthropic cache buckets from message_start (直传 / 旁路流的形状)", () => {
    const m = new StreamMetrics();
    m.observe({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 1216, cache_creation_input_tokens: 4 } } }, 0);
    m.observe({ type: "message_delta", usage: { output_tokens: 3 } }, 1000);
    expect(m.cacheReadTokens).toBe(1216);
    expect(m.cacheCreationTokens).toBe(4);
  });

  it("reads OpenAI prompt_tokens_details.cached_tokens (翻译流的形状)", () => {
    const m = new StreamMetrics();
    m.observe({ choices: [], usage: { prompt_tokens: 1224, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 1216 } } }, 0);
    expect(m.cacheReadTokens).toBe(1216);
    // OpenAI usage 没有 cache_creation 桶：保持 undefined（由 sse-translator 的
    // onUsage 钩子从 Anthropic 快照补齐，见 sse-translator.test.ts）。
    expect(m.cacheCreationTokens).toBeUndefined();
  });

  it("0 is a valid sample (presence semantics): later zero wins, absent stays undefined", () => {
    const m = new StreamMetrics();
    m.observe({ type: "message_start", message: { usage: { cache_read_input_tokens: 50 } } }, 0);
    expect(m.cacheReadTokens).toBe(50);
    // message_delta 重报 0：后来的覆盖先前的（与 usage 合并语义一致）。
    m.observe({ type: "message_delta", usage: { cache_read_input_tokens: 0 } }, 1000);
    expect(m.cacheReadTokens).toBe(0);
    // 从头就没报过：undefined，不是 0。
    const fresh = new StreamMetrics();
    fresh.observe({ type: "message_start", message: { usage: { input_tokens: 3 } } }, 0);
    expect(fresh.cacheReadTokens).toBeUndefined();
    expect(fresh.cacheCreationTokens).toBeUndefined();
  });

  it("ignores malformed cache values instead of poisoning the record", () => {
    const m = new StreamMetrics();
    m.observe({ type: "message_start", message: { usage: { cache_read_input_tokens: NaN } } }, 0);
    m.observe({ type: "message_start", message: { usage: { cache_creation_input_tokens: -5 } } }, 0);
    expect(m.cacheReadTokens).toBeUndefined();
    expect(m.cacheCreationTokens).toBeUndefined();
  });
});
