/** Client-observed decode speed, separate from request latency/TTFB.
 * Like GenAI-Perf's per-user throughput, exclude the first token and TTFT.
 * SSE chunks are not tokens; only authoritative usage supplies the count.
 * Buffered/batched delivery still makes this an approximation of model speed.
 */
export class StreamMetrics {
  tokens = 0;
  /**
   * 输入 token 数（用量统计的口径）。
   *
   * 流式响应里它只出现在头一个 chunk：Anthropic 是 `message_start` 的
   * `message.usage.input_tokens`，OpenAI 兼容流是最后一个 `usage` 帧里的
   * `prompt_tokens`。两个位置都读，因为这个旁路要同时覆盖直传与翻译两条路。
   */
  inputTokens = 0;
  /**
   * 缓存命中 / 缓存写入 token 数（与 `RequestRecord` 同名字段同源）。
   *
   * `undefined` = 到流结束为止上游一个缓存桶都没报过（翻译流的 OpenAI usage 里
   * 没有 cache 字段时也算）；数字（含 0）= 上游报了，后来的覆盖先前的——与
   * `inputTokens` 同一条覆盖语义，也与 sse-translator 的 usage 合并（后来的
   * 0 胜过先前的非 0）对齐。缓存命中同时在两个形状里出现：Anthropic 的
   * `message.usage.cache_read_input_tokens` / OpenAI 的
   * `prompt_tokens_details.cached_tokens`（翻译层把前者折成后者）；缓存写入
   * （cache_creation）只存在于 Anthropic 形状——OpenAI usage 没有这个桶，翻译
   * 流上它由 sse-translator 的 usage 观察钩子补齐（handler 侧接）。
   */
  cacheReadTokens: number | undefined = undefined;
  cacheCreationTokens: number | undefined = undefined;
  firstOutputAt: number | undefined;
  lastOutputAt: number | undefined;

  observe(value: unknown, now: number): void {
    if (!value || typeof value !== "object") return;
    const j = value as Record<string, any>;
    const count = j.usage?.completion_tokens ?? j.usage?.output_tokens;
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
      this.tokens = count;
    }
    const inputCount = j.usage?.prompt_tokens ?? j.message?.usage?.input_tokens ?? j.usage?.input_tokens;
    if (typeof inputCount === "number" && Number.isFinite(inputCount) && inputCount >= 0) {
      this.inputTokens = inputCount;
    }
    // 缓存桶与 inputTokens 同源同覆盖语义。OpenAI 形状先查（翻译流的
    // `prompt_tokens_details.cached_tokens`），Anthropic 形状兜底（直传/旁路的
    // `message_start` 帧）；一个 chunk 里只会出现一种形状，`??` 链的短路无歧义。
    // 0 是有效样本（上游明报 0 命中），只有「字段不在」才保持 undefined。
    const cacheRead = j.usage?.prompt_tokens_details?.cached_tokens
      ?? j.message?.usage?.cache_read_input_tokens
      ?? j.usage?.cache_read_input_tokens;
    if (typeof cacheRead === "number" && Number.isFinite(cacheRead) && cacheRead >= 0) {
      this.cacheReadTokens = cacheRead;
    }
    const cacheCreation = j.message?.usage?.cache_creation_input_tokens ?? j.usage?.cache_creation_input_tokens;
    if (typeof cacheCreation === "number" && Number.isFinite(cacheCreation) && cacheCreation >= 0) {
      this.cacheCreationTokens = cacheCreation;
    }
    const nonempty = (v: unknown) => typeof v === "string" && v.length > 0;
    const delta = j.choices?.[0]?.delta;
    const anthropic = j.type === "content_block_delta" && (
      (j.delta?.type === "text_delta" && nonempty(j.delta.text)) ||
      (j.delta?.type === "thinking_delta" && nonempty(j.delta.thinking)) ||
      (j.delta?.type === "input_json_delta" && nonempty(j.delta.partial_json))
    );
    const openai = delta && (nonempty(delta.content) || nonempty(delta.reasoning_content) ||
      nonempty(delta.function_call?.arguments) ||
      (Array.isArray(delta.tool_calls) && delta.tool_calls.some((t: any) => nonempty(t.function?.arguments))));
    if (anthropic || openai) {
      this.firstOutputAt ??= now;
      this.lastOutputAt = now;
    }
  }

  get generationMs(): number {
    return this.firstOutputAt === undefined || this.lastOutputAt === undefined
      ? 0 : this.lastOutputAt - this.firstOutputAt;
  }

  get tokensPerSecond(): number {
    return this.tokens > 1 && this.generationMs > 0
      ? (this.tokens - 1) * 1000 / this.generationMs : 0;
  }
}
