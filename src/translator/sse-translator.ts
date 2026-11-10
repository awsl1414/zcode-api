/**
 * SSE event translator — converts streaming events between OpenAI and Anthropic formats.
 * @see https://docs.anthropic.com/en/api/messages-streaming
 */
import type { AnthropicStreamEvent, AnthropicUsage, OpenAIStreamChunk, OpenAIUsage } from "./types.js";
import { anthropicUsageToOpenAI } from "./openai-to-anthropic.js";

/** Parse a raw SSE chunk string into event type + JSON data. */
export interface ParsedSSE {
  event: string;
  data: unknown;
}

/**
 * SSE frame boundary splitter: a blank line in any of the three line-ending
 * styles. Mirrors the 3.11.2 bundle's `Kxo` frame regex — a CRLF-only
 * upstream (`\r\n\r\n`) never produces a `\n\n` boundary and would buffer
 * forever under a plain `indexOf("\n\n")` / `split("\n\n")`.
 */
export const SSE_FRAME_SPLIT = /\r\n\r\n|\n\n|\r\r/;

export function parseSSEChunk(raw: string): ParsedSSE[] {
  const results: ParsedSSE[] = [];
  const blocks = raw.split(SSE_FRAME_SPLIT);

  for (const block of blocks) {
    const lines = block.trim().split(/\r\n|\r|\n/).filter(Boolean);
    if (lines.length === 0) continue;

    let eventType = "";
    let dataStr = "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        // SSE spec: the colon may be followed by at most ONE space. Strip at
        // most one leading space so both `data: x` and `data:x` parse while
        // existing `data: x` payloads stay byte-identical.
        let data = line.slice(5);
        if (data.startsWith(" ")) data = data.slice(1);
        dataStr = data;
      }
    }

    if (dataStr) {
      try {
        results.push({ event: eventType, data: JSON.parse(dataStr) });
      } catch {
        // Skip malformed JSON
      }
    }
  }

  return results;
}

export interface TranslationState {
  messageId: string;
  model: string;
  roleSent: boolean;
  /** Running Anthropic usage snapshot; the upstream reports it incrementally. */
  usage: AnthropicUsage;
  /**
   * 用量观察钩子（可选）。
   *
   * 每欢上游把新用量折进 {@link initState} 建的快照（`message_start` 与每个
   * `message_delta`）之后回调一次，带**当前快照**。存在它的理由：OpenAI 的
   * usage 形状装不下 cache_creation 桶（`anthropicUsageToOpenAI` 有意不镜像，
   * strict-schema 客户端拒未知成员），翻译流上那个桶只能在这里——快照还是
   * Anthropic 形状——递给调用方，由它落到 `RequestRecord.cacheCreationTokens`。
   * 调用方必须自己处理覆盖语义（快照字段是绝对值，后到的覆盖先到的）。
   */
  onUsage?: (usage: AnthropicUsage) => void;
  toolCallIndex: number;
  blockIndexToToolCallIndex: Map<number, number>;
  finishReasonSent: boolean;
}

export function initState(model: string, onUsage?: (usage: AnthropicUsage) => void): TranslationState {
  return {
    messageId: "",
    model,
    roleSent: false,
    usage: { input_tokens: 0, output_tokens: 0 },
    /** 用量观察钩子。每次上游把新用量折进快照后回调（见 TranslationState）。*/
    onUsage,
    toolCallIndex: 0,
    blockIndexToToolCallIndex: new Map(),
    finishReasonSent: false,
  };
}

/**
 * Fold an incremental usage report into the running snapshot, field by field.
 * Overwrite (not accumulate) semantics: the upstream re-reports absolute
 * totals, so a later 0 must win over an earlier non-zero, while a field the
 * event omits keeps its previous value.
 */
function mergeAnthropicUsage(target: AnthropicUsage, patch: Partial<AnthropicUsage> | undefined): void {
  if (!patch) return;
  if (patch.input_tokens != null) target.input_tokens = patch.input_tokens;
  if (patch.output_tokens != null) target.output_tokens = patch.output_tokens;
  if (patch.cache_read_input_tokens != null) target.cache_read_input_tokens = patch.cache_read_input_tokens;
  if (patch.cache_creation_input_tokens != null) target.cache_creation_input_tokens = patch.cache_creation_input_tokens;
}

function makeChunk(
  state: TranslationState,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: OpenAIUsage,
): string {
  const chunk: OpenAIStreamChunk = {
    id: state.messageId || "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{
      index: 0,
      delta: delta as any,
      finish_reason: finishReason as any,
    }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Transform an Anthropic SSE stream into OpenAI SSE format.
 * Input: ReadableStream<Uint8Array> (Anthropic SSE bytes)
 * Output: ReadableStream<Uint8Array> (OpenAI SSE bytes)
 */
export function anthropicSseToOpenaiSse(
  upstream: ReadableStream<Uint8Array>,
  model: string = "glm-4.6",
  /** 用量观察钩子，透传给状态（见 TranslationState.onUsage）。*/
  onUsage?: (usage: AnthropicUsage) => void,
): ReadableStream<Uint8Array> {
  const state = initState(model, onUsage);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      let errored = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split(SSE_FRAME_SPLIT);
          buffer = blocks.pop() ?? "";

          for (const block of blocks) {
            const parsed = parseSSEChunk(block);
            for (const p of parsed) {
              const output = translateEvent(state, p);
              if (output) {
                controller.enqueue(encoder.encode(output));
              }
            }
          }
        }

        // Flush remaining buffer
        if (buffer.trim()) {
          const parsed = parseSSEChunk(buffer);
          for (const p of parsed) {
            const output = translateEvent(state, p);
            if (output) controller.enqueue(encoder.encode(output));
          }
        }

        // Emit [DONE]
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        errored = true;
        void reader.cancel(err).catch(() => {});
        // error()/close() 互斥:errored 流上再 close() 会抛 TypeError,进而触发 Bun 引擎空指针崩溃。
        try { controller.error(err); } catch { /* 已 errored 的流二次 error 不可再抛 */ }
      } finally {
        if (!errored) {
          try { controller.close(); } catch { /* 已关闭的流二次 close 同样会抛 */ }
        }
        reader.releaseLock();
      }
    },
  });
}

/** An in-band Anthropic failure must not become a successful empty Chat stream. */
export class AnthropicStreamError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AnthropicStreamError";
  }
}

export function translateEvent(state: TranslationState, sse: ParsedSSE): string | null {
  const data = sse.data as AnthropicStreamEvent;

  if ((sse.data as { type?: string }).type === "error") {
    const error = (data as { error?: { type?: string; message?: string } }).error;
    throw new AnthropicStreamError(error?.type ?? "upstream_error", error?.message ?? "Anthropic upstream stream failed");
  }

  switch (data.type) {
    case "message_start": {
      const msg = (data as any).message;
      state.messageId = msg?.id ?? "msg_stream";
      state.model = msg?.model ?? state.model;
      mergeAnthropicUsage(state.usage, msg?.usage);
      state.onUsage?.(state.usage);
      if (!state.roleSent) {
        state.roleSent = true;
        return makeChunk(state, { role: "assistant" });
      }
      return null;
    }

    case "content_block_start": {
      if (data.type !== "content_block_start") return null;
      const block = data.content_block;
      const blockIdx = data.index;
      if (block.type === "tool_use") {
        const myIndex = state.toolCallIndex++;
        state.blockIndexToToolCallIndex.set(blockIdx, myIndex);
        return makeChunk(state, {
          tool_calls: [{
            index: myIndex,
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: "" },
          }],
        });
      }
      return null;
    }

    case "content_block_delta": {
      if (data.type !== "content_block_delta") return null;
      const delta = data.delta;
      const blockIdx = data.index;
      if (delta.type === "text_delta") {
        return makeChunk(state, { content: delta.text });
      }
      if (delta.type === "thinking_delta") {
        return makeChunk(state, { reasoning_content: delta.thinking });
      }
      if (delta.type === "signature_delta") {
        return null;
      }
      if (delta.type === "input_json_delta") {
        const myIndex = state.blockIndexToToolCallIndex.get(blockIdx);
        if (myIndex === undefined) return null;
        return makeChunk(state, {
          tool_calls: [{
            index: myIndex,
            function: { arguments: delta.partial_json ?? "" },
          }],
        });
      }
      return null;
    }

    case "message_delta": {
      // Fold usage in *before* the stop_reason branch: the upstream carries
      // both in the same event, and this is the only place the real input and
      // cache counts ever arrive. Usage that lands only *after* the finish
      // chunk was emitted updates the snapshot but is not re-announced — the
      // alternative is a trailing `choices: []` usage chunk, which some clients
      // index into blindly. No observed upstream orders the events that way.
      mergeAnthropicUsage(state.usage, data.usage);
      state.onUsage?.(state.usage);
      if (data.delta?.stop_reason && !state.finishReasonSent) {
        const finishReason = mapStopReason(data.delta.stop_reason);
        state.finishReasonSent = true;
        return makeChunk(state, {}, finishReason, anthropicUsageToOpenAI(state.usage));
      }
      return null;
    }

    case "message_stop": {
      if (state.finishReasonSent) return null;
      state.finishReasonSent = true;
      return makeChunk(state, {}, "stop", anthropicUsageToOpenAI(state.usage));
    }

    case "ping":
    case "content_block_stop":
      return null;

    default:
      return null;
  }
}

function mapStopReason(stopReason: string): string {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}
