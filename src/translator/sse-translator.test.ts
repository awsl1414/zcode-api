/**
 * Tests for SSE event translator.
 */
import { describe, it, expect } from "bun:test";
import { anthropicSseToOpenaiSse, parseSSEChunk } from "./sse-translator.js";

function makeStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

interface ParsedChunk {
  choices: Array<{
    delta: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

function parseChunks(output: string): ParsedChunk[] {
  return output
    .split('\n')
    .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
    .map((l) => JSON.parse(l.slice(6)) as ParsedChunk);
}

const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"model":"glm-4.6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

describe("parseSSEChunk — lenient frame/data parsing", () => {
  it("parses a data line without the optional space after the colon", () => {
    const parsed = parseSSEChunk('event: message_stop\ndata:{"type":"message_stop"}\n\n');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].event).toBe("message_stop");
    expect(parsed[0].data).toEqual({ type: "message_stop" });
  });

  it("keeps byte-identical output for classic 'data: x' (one space) payloads", () => {
    const parsed = parseSSEChunk('data: {"a":1}\n\n');
    expect(parsed[0].data).toEqual({ a: 1 });
    // two spaces after the colon: only ONE is stripped (SSE spec); the
    // remaining leading space is JSON whitespace, so it still parses.
    const twoSpaces = parseSSEChunk('data:  {"a":1}\n\n');
    expect(twoSpaces[0].data).toEqual({ a: 1 });
  });

  it("tolerates CRLF frame boundaries and CRLF line endings", () => {
    const crlf = 'event: message_start\r\ndata: {"type":"message_start"}\r\n\r\nevent: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n';
    const parsed = parseSSEChunk(crlf);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].event).toBe("message_start");
    expect(parsed[1].event).toBe("message_stop");
    expect(parsed[1].data).toEqual({ type: "message_stop" });
  });

  it("anthropicSseToOpenaiSse no longer buffers forever on a CRLF-only stream", async () => {
    const crlfStream = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_crlf","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join("\r\n") + "\r\n";
    const out = await collectStream(anthropicSseToOpenaiSse(makeStream(crlfStream), "glm-4.6"));
    expect(out).toContain('"role":"assistant"');
    expect(out).toContain("data: [DONE]");
  });
});

describe("anthropicSseToOpenaiSse", () => {
  it("translates message_start to first chunk with role", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"role":"assistant"');
  });

  it("translates text_delta to delta.content", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"content":"Hello"');
    expect(output).toContain('"content":" world"');
  });

  it("translates thinking_delta to delta.reasoning_content", async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"glm-4.6"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"I should answer directly."}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_ignored"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');

    const output = await collectStream(anthropicSseToOpenaiSse(makeStream(sse), "glm-4.6"));
    const chunks = parseChunks(output);
    const reasoning = chunks
      .map((c) => c.choices[0]?.delta.reasoning_content)
      .filter((text): text is string => typeof text === "string");

    expect(reasoning).toEqual(["I should answer directly."]);
    expect(output).not.toContain("sig_ignored");
  });

  it("translates multiple thinking_delta events into stable reasoning_content deltas", async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"glm-4.6"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"First step. "}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Second step."}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_ignored"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');

    const output = await collectStream(anthropicSseToOpenaiSse(makeStream(sse), "glm-4.6"));
    const chunks = parseChunks(output);
    const reasoning = chunks
      .map((c) => c.choices[0]?.delta.reasoning_content)
      .filter((text): text is string => typeof text === "string");

    expect(reasoning).toEqual(["First step. ", "Second step."]);
    expect(output).not.toContain("sig_ignored");
  });

  it("translates message_delta stop_reason to finish_reason", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"finish_reason":"stop"');
  });

  it("emits [DONE] at the end", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain("data: [DONE]");
  });

  it("emits usage on final chunk from input_tokens + output_tokens", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"usage"');
    expect(output).toContain('"prompt_tokens":10');
    expect(output).toContain('"completion_tokens":5');
    expect(output).toContain('"total_tokens":15');
  });

  it("takes the real usage from message_delta when message_start reports zeros", async () => {
    const sse = [
      'event: message_start',
      `data: ${JSON.stringify({
        type: "message_start",
        message: { id: "msg_1", model: "glm-4.6", usage: { input_tokens: 0, output_tokens: 0 } },
      })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          input_tokens: 8,
          output_tokens: 3,
          cache_read_input_tokens: 1216,
          server_tool_use: { web_search_requests: 0 },
          service_tier: "standard",
        },
      })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      '',
    ].join('\n');

    const output = await collectStream(anthropicSseToOpenaiSse(makeStream(sse), "glm-4.6"));
    const usageChunks = parseChunks(output).filter((c) => c.usage);

    expect(usageChunks).toHaveLength(1);
    expect(usageChunks[0].choices[0].finish_reason).toBe("stop");
    expect(usageChunks[0].usage).toEqual({
      prompt_tokens: 1224,
      completion_tokens: 3,
      total_tokens: 1227,
      prompt_tokens_details: { cached_tokens: 1216 },
    });
  });

  it("merges successive usage deltas per field, last write wins", async () => {
    const sse = [
      'event: message_start',
      `data: ${JSON.stringify({
        type: "message_start",
        message: { id: "msg_1", model: "glm-4.6", usage: { input_tokens: 0, output_tokens: 0 } },
      })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({
        type: "message_delta",
        delta: {},
        usage: { input_tokens: 10, cache_read_input_tokens: 1216, cache_creation_input_tokens: 4 },
      })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({ type: "message_delta", delta: {}, usage: { input_tokens: 8 } })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 3, cache_read_input_tokens: 0 },
      })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      '',
    ].join('\n');

    const output = await collectStream(anthropicSseToOpenaiSse(makeStream(sse), "glm-4.6"));
    const usageChunk = parseChunks(output).find((c) => c.usage);

    // input 8 (overwritten), cache_read 0 (a later zero wins), cache_creation 4 (retained).
    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 3,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 0 },
    });
  });

  it("falls back to message_start usage when no message_delta arrives", async () => {
    const sse = [
      'event: message_start',
      `data: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_1",
          model: "glm-4.6",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 2,
          },
        },
      })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      '',
    ].join('\n');

    const output = await collectStream(anthropicSseToOpenaiSse(makeStream(sse), "glm-4.6"));
    const usageChunk = parseChunks(output).find((c) => c.usage);

    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 32,
      completion_tokens: 5,
      total_tokens: 37,
      prompt_tokens_details: { cached_tokens: 20 },
    });
  });

  it("accepts a usage-only message_delta that carries no delta member at all", async () => {
    const sse = [
      'event: message_start',
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "glm-4.6" } })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({ type: "message_delta", usage: { input_tokens: 40, output_tokens: 7 } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      '',
    ].join('\n');

    const output = await collectStream(anthropicSseToOpenaiSse(makeStream(sse), "glm-4.6"));
    const usageChunk = parseChunks(output).find((c) => c.usage);

    expect(usageChunk?.usage).toEqual({ prompt_tokens: 40, completion_tokens: 7, total_tokens: 47 });
  });

  it("emits a single finish chunk when two message_delta events both carry a stop_reason", async () => {
    const sse = [
      'event: message_start',
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "glm-4.6" } })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 40, output_tokens: 7 },
      })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      '',
    ].join('\n');

    const output = await collectStream(anthropicSseToOpenaiSse(makeStream(sse), "glm-4.6"));
    const finishChunks = parseChunks(output).filter((c) => c.choices[0]?.finish_reason);

    expect(finishChunks).toHaveLength(1);
    expect(finishChunks[0].choices[0].finish_reason).toBe("stop");
    expect(finishChunks[0].usage).toEqual({ prompt_tokens: 40, completion_tokens: 7, total_tokens: 47 });
  });

  it("still emits a zeroed usage block when the upstream reports none", async () => {
    const sse = [
      'event: message_start',
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "glm-4.6" } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      '',
    ].join('\n');

    const output = await collectStream(anthropicSseToOpenaiSse(makeStream(sse), "glm-4.6"));
    const usageChunk = parseChunks(output).find((c) => c.usage);

    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it("handles max_tokens stop reason", async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"glm-4.6"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).toContain('"finish_reason":"length"');
  });

  it("emits OpenAI tool_calls delta with id+name+empty arguments on tool_use content_block_start", async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"glm-4.6"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_abc","name":"get_weather","input":{}}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    const chunks = parseChunks(output);
    const toolCallChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(toolCallChunks).toHaveLength(1);
    const tc = toolCallChunks[0].choices[0].delta.tool_calls![0];
    expect(tc).toEqual({
      index: 0,
      id: "toolu_abc",
      type: "function",
      function: { name: "get_weather", arguments: "" },
    });
    const finishReasons = chunks
      .flatMap((c) => c.choices ?? [])
      .map((ch) => ch.finish_reason)
      .filter((fr): fr is string => fr !== null && fr !== undefined);
    expect(finishReasons).toEqual(["tool_calls"]);
  });

  it("streams input_json_delta as OpenAI tool_calls.function.arguments deltas", async () => {
    const deltaLine = (partial: string) =>
      `data: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: partial },
      })}`;
    const sse = [
      'event: message_start',
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "glm-4.6" } })}`,
      '',
      'event: content_block_start',
      `data: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
      })}`,
      '',
      'event: content_block_delta',
      deltaLine('{"city":'),
      '',
      'event: content_block_delta',
      deltaLine('"SF"}'),
      '',
      'event: content_block_stop',
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    const chunks = output
      .split('\n')
      .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map((l) => JSON.parse(l.slice(6)) as { choices: Array<{ delta: { tool_calls?: Array<{ index: number; function?: { arguments?: string } }> } }> });
    const argChunks = chunks
      .flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []);
    expect(argChunks.length).toBe(3);
    expect(argChunks[0]).toMatchObject({ index: 0, id: "toolu_1" });
    expect(argChunks[0].function?.arguments).toBe("");
    expect(argChunks[1].function?.arguments).toBe('{"city":');
    expect(argChunks[2].function?.arguments).toBe('"SF"}');
    const assembled = (argChunks.map((c) => c.function?.arguments ?? "").join(""));
    expect(JSON.parse(assembled)).toEqual({ city: "SF" });
  });

  it("uses separate incrementing OpenAI tool_calls index for multiple parallel tool_use blocks", async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"glm-4.6"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_a","name":"w","input":{}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_b","name":"w","input":{}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    const chunks = parseChunks(output);
    const toolCallChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(toolCallChunks).toHaveLength(2);
    expect(toolCallChunks[0].choices[0].delta.tool_calls![0]).toEqual({
      index: 0,
      id: "toolu_a",
      type: "function",
      function: { name: "w", arguments: "" },
    });
    expect(toolCallChunks[1].choices[0].delta.tool_calls![0]).toEqual({
      index: 1,
      id: "toolu_b",
      type: "function",
      function: { name: "w", arguments: "" },
    });
  });

  it("does not emit tool_calls for text-only streams (regression)", async () => {
    const input = makeStream(ANTHROPIC_SSE);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    expect(output).not.toContain('"tool_calls"');
  });

  it("emits exactly one non-null finish_reason per stream (no duplicate from message_stop)", async () => {
    const sse = [
      'event: message_start',
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "glm-4.6" } })}`,
      '',
      'event: content_block_start',
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "w", input: {} } })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    const chunks = output
      .split('\n')
      .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map((l) => JSON.parse(l.slice(6)) as { choices: Array<{ finish_reason: string | null }> });
    const finishReasons = chunks
      .flatMap((c) => c.choices ?? [])
      .map((ch) => ch.finish_reason)
      .filter((fr): fr is string => fr !== null && fr !== undefined);
    expect(finishReasons).toHaveLength(1);
    expect(finishReasons[0]).toBe("tool_calls");
  });

  it("still emits finish_reason='stop' via message_stop when message_delta lacks stop_reason", async () => {
    const sse = [
      'event: message_start',
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "glm-4.6" } })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      '',
    ].join('\n');
    const input = makeStream(sse);
    const output = await collectStream(anthropicSseToOpenaiSse(input, "glm-4.6"));
    const chunks = output
      .split('\n')
      .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map((l) => JSON.parse(l.slice(6)) as { choices: Array<{ finish_reason: string | null }> });
    const finishReasons = chunks
      .flatMap((c) => c.choices ?? [])
      .map((ch) => ch.finish_reason)
      .filter((fr): fr is string => fr !== null && fr !== undefined);
    expect(finishReasons).toHaveLength(1);
    expect(finishReasons[0]).toBe("stop");
  });

  it("observes the raw Anthropic usage snapshot via the onUsage hook", async () => {
    // OpenAI usage 装不下 cache_creation（anthropicUsageToOpenAI 有意不镜像），
    // 那个桶只能从钩子拿——快照仍是 Anthropic 形状。
    const seen: Array<{ input: number; read: number | undefined; creation: number | undefined }> = [];
    const sse = [
      'event: message_start',
      `data: ${JSON.stringify({
        type: "message_start",
        message: { id: "msg_1", model: "glm-4.6", usage: { input_tokens: 10, cache_read_input_tokens: 1216, cache_creation_input_tokens: 4 } },
      })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 8 } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      '',
    ].join('\n');
    const output = await collectStream(anthropicSseToOpenaiSse(makeStream(sse), "glm-4.6", (usage) => {
      seen.push({ input: usage.input_tokens, read: usage.cache_read_input_tokens, creation: usage.cache_creation_input_tokens });
    }));
    // 翻译输出不受钩子影响：usage 块仍然只有 OpenAI 形状的字段。
    expect(output).toContain('"prompt_tokens_details":{"cached_tokens":0}');
    // 钩子每次折用量后回调一次（message_start + message_delta），带当前快照；
    // 字段是绝对值，后到的覆盖先到的——最后一次是终值。
    expect(seen).toEqual([
      { input: 10, read: 1216, creation: 4 },
      { input: 12, read: 0, creation: 8 },
    ]);
  });

  it("works without the onUsage hook (existing callers unchanged)", async () => {
    const output = await collectStream(anthropicSseToOpenaiSse(makeStream(ANTHROPIC_SSE), "glm-4.6"));
    expect(output).toContain('"prompt_tokens":10');
  });
});
