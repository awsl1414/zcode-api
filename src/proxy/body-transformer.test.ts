/**
 * Tests for body transformer.
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import { describe, it, expect } from "bun:test";
import { transformRequestBody } from "./body-transformer.js";

describe("transformRequestBody — general", () => {
  it("returns undefined unchanged", () => {
    expect(transformRequestBody(undefined, { format: "openai" })).toBeUndefined();
  });

  it("returns empty string unchanged", () => {
    expect(transformRequestBody("", { format: "openai" })).toBe("");
  });

  it("returns original body on JSON parse failure", () => {
    const broken = "{not valid json";
    expect(transformRequestBody(broken, { format: "openai" })).toBe(broken);
  });

  it("returns original body when JSON is not an object", () => {
    expect(transformRequestBody("[1,2,3]", { format: "openai" })).toBe("[1,2,3]");
    expect(transformRequestBody("\"hello\"", { format: "openai" })).toBe("\"hello\"");
  });

  it("returns original body when no transformation applies", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [], stream: false });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });
});

describe("transformRequestBody — stream_options.include_usage (OpenAI)", () => {
  it("injects stream_options.include_usage when stream:true and missing", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [], stream: true });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.stream_options).toEqual({ include_usage: true });
  });

  it("preserves existing stream_options fields, only adds include_usage", () => {
    const body = JSON.stringify({ stream: true, stream_options: { some_other: "x" } });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.stream_options).toEqual({ some_other: "x", include_usage: true });
  });

  it("does NOT touch body when stream_options.include_usage already true", () => {
    const body = JSON.stringify({ stream: true, stream_options: { include_usage: true } });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });

  it("does NOT inject when stream is false", () => {
    const body = JSON.stringify({ stream: false });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });

  it("does NOT inject when stream is missing", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [] });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });

  it("does NOT inject for anthropic format (Anthropic API has no stream_options)", () => {
    const body = JSON.stringify({ stream: true });
    expect(transformRequestBody(body, { format: "anthropic" })).toBe(body);
  });
});

describe("transformRequestBody — cache_control (Anthropic)", () => {
  it("adds cache_control to last user message with string content", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "second question" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // Last user msg content converted to array with cache_control on the block
    expect(parsed.messages[2].content).toEqual([
      { type: "text", text: "second question", cache_control: { type: "ephemeral" } },
    ]);
    // Earlier messages untouched
    expect(parsed.messages[0].content).toBe("first question");
    expect(parsed.messages[1].content).toBe("answer");
  });

  it("adds cache_control to last content block when content is already array", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("clears a non-canonical existing cache_control and re-marks with the canonical ephemeral shape (zsi+Fsi)", () => {
    const existing = { type: "ephemeral", ttl: "1h" };
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "x", cache_control: existing }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("strips client cache_control on earlier non-system messages, keeps only the last-message marker", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "early", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content[0].cache_control).toBeUndefined();
    expect(parsed.messages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("is idempotent: an already-marked body is returned without modification", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "early" }] },
        { role: "assistant", content: [{ type: "text", text: "reply", cache_control: { type: "ephemeral" } }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    // Already our target shape → the original string comes back untouched
    expect(out).toBe(body);
  });

  it("skips system messages — finds last non-system", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "q1" },
        { role: "system", content: "sys-prompt" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // The user msg (index 0) is the last non-system; gets cache_control
    expect(parsed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    // System untouched
    expect(parsed.messages[1].content).toBe("sys-prompt");
  });

  it("does nothing when messages array is empty", () => {
    const body = JSON.stringify({ messages: [] });
    expect(transformRequestBody(body, { format: "anthropic" })).toBe(body);
  });

  it("does nothing when messages are all system", () => {
    const body = JSON.stringify({ messages: [{ role: "system", content: "sys" }] });
    expect(transformRequestBody(body, { format: "anthropic" })).toBe(body);
  });

  it("does NOT apply cache_control for openai format", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
    });
    const out = transformRequestBody(body, { format: "openai" });
    expect(out).toBe(body);
  });

  it("handles missing messages field gracefully", () => {
    const body = JSON.stringify({ model: "glm-4.6" });
    expect(transformRequestBody(body, { format: "anthropic" })).toBe(body);
  });
});

describe("transformRequestBody — combined behavior", () => {
  it("OpenAI streaming body is only stream_options-modified (no cache_control)", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.stream_options).toEqual({ include_usage: true });
    expect(parsed.messages[0].content).toBe("hi");
  });
});

describe("transformRequestBody — start-plan system (Anthropic)", () => {
  it("prepends three official blocks in the ContextBuilder shape (3.17.1: no Environment in system)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });

    const out = transformRequestBody(body, { format: "anthropic", injectZcodeSystem: true, provider: "bigmodel" });
    const parsed = JSON.parse(out as string);

    expect(parsed.system).toHaveLength(3);
    // 3.15.1+ wire: cli_prefix block carries NO cache_control (stable/dynamic do).
    expect(parsed.system[0]).toEqual({
      type: "text",
      text: "You are ZCode, an interactive agent",
    });
    expect(parsed.system[1].text).toContain("# Harness");
    expect(parsed.system[1].text).toContain("working with the user toward their goals");
    // Desktop Context deliberately not injected (CLI-face state)
    expect(parsed.system[1].text).not.toContain("# ZCode Desktop Context");
    expect(parsed.system[1].cache_control).toEqual({ type: "ephemeral" });
    // 3.17.1 moved Environment Info / powered-by / currentDate out of the
    // system blocks into meta_user attachments — and the minimal-set
    // anchoring (2026-10-30) ships an EMPTY block 3 (gateway-unconstrained,
    // probe M1): the default path carries identity only.
    expect(parsed.system[2].text).toBe("");
    expect(parsed.system[2].text).not.toContain("# Environment");
    expect(parsed.system[2].text).not.toContain("powered by the model named");
    expect(parsed.system[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("prepends the standalone date attachment user message ($5o/fce mirror)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
    });

    const out = transformRequestBody(body, { format: "anthropic", injectZcodeSystem: true, provider: "bigmodel" });
    const parsed = JSON.parse(out as string);

    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.messages[0].content).toEqual([
      {
        type: "text",
        text: expect.stringMatching(
          /^<system-reminder>Today's date is \d{4}-\d{2}-\d{2}\.<\/system-reminder>$/,
        ),
      },
    ]);
    // The client's message keeps the last-message cache marker (phase 2)
    expect(parsed.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
    });
  });

  it("strips client cache_control from tools (4-breakpoint budget)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "get_weather", cache_control: { type: "ephemeral" } },
        { name: "read_file" },
      ],
    });

    const out = transformRequestBody(body, { format: "anthropic", injectZcodeSystem: true, provider: "bigmodel" });
    const parsed = JSON.parse(out as string);
    expect(parsed.tools[0]).toEqual({ name: "get_weather" });
    expect(parsed.tools[1]).toEqual({ name: "read_file" });
  });

  it("client system keeps the 3-block shape; text becomes block 3 (C1: replaces the dynamic duo)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      system: [{ type: "text", text: "User rule", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    });

    const out = transformRequestBody(body, { format: "anthropic", injectZcodeSystem: true, provider: "bigmodel" });
    const parsed = JSON.parse(out as string);
    // Wiring-level assertions only: the byte-exact block shapes (cli_prefix,
    // stable-block tail, ephemeral breakpoints) are pinned at the
    // buildStartPlanSystem seam (system-prompt.test.ts). Here we verify the
    // transformer routes the client text through that seam (live gateway rules,
    // 2026-10-27); negative suppression per the AGENTS.md convention.
    expect(parsed.system).toHaveLength(3);
    expect(parsed.system[1].text).toContain("working with the user toward their goals");
    expect(parsed.system[1].text).not.toContain("User rule");
    expect(parsed.system[2].text).toBe("\n\nUser rule");
  });

  it("system blocks stay env-free regardless of body.model presence (3.17.1 meta_user move)", () => {
    for (const model of [undefined, "", { nested: "object" }]) {
      const body = JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      });

      const out = transformRequestBody(body, { format: "anthropic", injectZcodeSystem: true, provider: "bigmodel" });
      const parsed = JSON.parse(out as string);

      expect(parsed.system).toHaveLength(3);
      expect(parsed.system[2].text).toBe("");
      expect(parsed.system[2].text).not.toContain("You have been invoked in the following environment:");
      expect(parsed.system[2].text).not.toContain("powered by the model named");
    }
  });

  it("string client system becomes block 3 (C1, 3-block shape)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      system: "User rule",
      messages: [{ role: "user", content: "hi" }],
    });

    const out = transformRequestBody(body, { format: "anthropic", injectZcodeSystem: true, provider: "bigmodel" });
    const parsed = JSON.parse(out as string);

    expect(parsed.system).toHaveLength(3);
    expect(parsed.system[1].text).not.toContain("User rule");
    expect(parsed.system[2].text).toBe("\n\nUser rule");
  });
});

describe("transformRequestBody — start-plan system (OpenAI)", () => {
  it("prepends the three ZCode system messages (minimal: empty third) before OpenAI chat messages", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
    });

    const out = transformRequestBody(body, { format: "openai", injectZcodeSystem: true, provider: "bigmodel" });
    const parsed = JSON.parse(out as string);

    expect(parsed.messages[0]).toEqual({
      role: "system",
      content: "You are ZCode, an interactive agent",
    });
    expect(parsed.messages[1].role).toBe("system");
    expect(parsed.messages[1].content).toContain("# Harness");
    // Desktop Context deliberately not injected (CLI-face state)
    expect(parsed.messages[1].content).not.toContain("# ZCode Desktop Context");
    expect(parsed.messages[2].role).toBe("system");
    // 3.17.1: Environment Info / powered-by live in meta_user attachments,
    // and block 3 is EMPTY on the default path (minimal-set anchoring).
    expect(parsed.messages[2].content).toBe("");
    expect(parsed.messages[2].content).not.toContain("powered by the model named");
    expect(parsed.messages[3]).toEqual({ role: "user", content: "hi" });
  });

  it("OpenAI system messages stay env-free when body.model is missing", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    });

    const out = transformRequestBody(body, { format: "openai", injectZcodeSystem: true, provider: "bigmodel" });
    const parsed = JSON.parse(out as string);

    expect(parsed.messages[0].role).toBe("system");
    expect(parsed.messages[2].role).toBe("system");
    expect(parsed.messages[2].content).toBe("");
    expect(parsed.messages[2].content).not.toContain("powered by the model named");
    expect(parsed.messages[3]).toEqual({ role: "user", content: "hi" });
  });
});

describe("transformRequestBody — metadata.user_id (Anthropic)", () => {
  it("injects metadata.user_id when ctx.userId is set", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic", metadataUserId: "u_42" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toEqual({ user_id: "u_42" });
  });

  it("preserves existing metadata fields when adding user_id", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { existing_field: "keep" },
    });
    const out = transformRequestBody(body, { format: "anthropic", metadataUserId: "u_99" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toEqual({ existing_field: "keep", user_id: "u_99" });
  });

  it("does NOT touch body when metadata.user_id already equals ctx.userId", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { user_id: "u_x" },
    });
    expect(transformRequestBody(body, { format: "anthropic", metadataUserId: "u_x" })).toBe(body);
  });

  it("overwrites metadata.user_id when value differs from ctx.userId", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { user_id: "client_set" },
    });
    const out = transformRequestBody(body, { format: "anthropic", metadataUserId: "oauth_resolved" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata.user_id).toBe("oauth_resolved");
  });

  it("does NOT inject metadata when ctx.userId is absent", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toBeUndefined();
  });

  it("does NOT inject metadata for OpenAI format even if userId is set", () => {
    const body = JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "openai", metadataUserId: "u_42" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 多客户端身份归一 —— 第三层「路由覆盖」（证据
// `docs/research/client-fingerprints.md` 的 3.2 节「路由级缺口」）：
// OpenAI 路由的 `applyStartPlanOpenAISystem` 过去只插官方 system 段，完全不碰
// 客户端自己的 system 消息，身份句 100% 原样出站。现在两条路由共用
// `normalizeClientSystem`（system-prompt.ts）。
// ---------------------------------------------------------------------------

/** Cline 的身份句（`Open Source prompts/Cline/Prompt.txt:1`）。 */
const CLINE_OPENING =
  "You are Cline, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.";
/** B1 模型归属句（`Anthropic/Claude Code 2.0.txt:173`）。 */
const CLAUDE_CODE_MODEL_SENTENCE =
  "You are powered by the model named Sonnet 4.5. The exact model ID is claude-sonnet-4-5-20250929.";
/** 归一后的 ZCode 身份句（官方 cli_prefix + 句点）。 */
const ZCODE_IDENTITY_SENTENCE = "You are ZCode, an interactive agent.";

/** Run `fn` with `ZCODE_NORMALIZE_CLIENT_SYSTEM` pinned to `value` (undefined = unset). */
function withNormalizeSwitch<T>(value: string | undefined, fn: () => T): T {
  const original = process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM;
  if (value === undefined) delete process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM;
  else process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM;
    else process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM = original;
  }
}

describe("transformRequestBody — start-plan identity normalization on the OpenAI route", () => {
  it("normalizes a client `system` message (it used to pass through verbatim)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "system", content: CLINE_OPENING },
        { role: "user", content: "hi" },
      ],
    });

    const out = withNormalizeSwitch(undefined, () =>
      transformRequestBody(body, { format: "openai", injectZcodeSystem: true, provider: "bigmodel" }),
    );
    const parsed = JSON.parse(out as string);

    // 3 official system messages first, then the client's own messages.
    expect(parsed.messages).toHaveLength(5);
    expect(parsed.messages[3].role).toBe("system");
    expect(parsed.messages[3].content).toContain("You are ZCode");
    expect(parsed.messages[3].content).not.toContain("Cline");
    expect(parsed.messages[4]).toEqual({ role: "user", content: "hi" });
  });

  it("normalizes the B1 model-attribution sentence inside a client system message", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "system", content: CLAUDE_CODE_MODEL_SENTENCE },
        { role: "user", content: "hi" },
      ],
    });

    const out = withNormalizeSwitch(undefined, () =>
      transformRequestBody(body, { format: "openai", injectZcodeSystem: true, provider: "bigmodel" }),
    );
    const parsed = JSON.parse(out as string);

    expect(parsed.messages[3].content).toBe(ZCODE_IDENTITY_SENTENCE);
    expect(parsed.messages[3].content).not.toContain("powered by the model named");
    expect(parsed.messages[3].content).not.toContain("claude-sonnet-4-5");
  });

  it("normalizes `developer` messages too (the translator folds them into the upstream system field)", () => {
    // openai-to-anthropic.ts:34 把 role system|developer 一起折进上游 `system`。
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "developer", content: CLINE_OPENING },
        { role: "user", content: "hi" },
      ],
    });

    const out = withNormalizeSwitch(undefined, () =>
      transformRequestBody(body, { format: "openai", injectZcodeSystem: true, provider: "bigmodel" }),
    );
    const parsed = JSON.parse(out as string);

    expect(parsed.messages[3].role).toBe("developer");
    expect(parsed.messages[3].content).toContain("You are ZCode");
    expect(parsed.messages[3].content).not.toContain("Cline");
  });

  it("normalizes text parts of array-form system content", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "system", content: [{ type: "text", text: CLINE_OPENING }] },
        { role: "user", content: "hi" },
      ],
    });

    const out = withNormalizeSwitch(undefined, () =>
      transformRequestBody(body, { format: "openai", injectZcodeSystem: true, provider: "bigmodel" }),
    );
    const parsed = JSON.parse(out as string);

    expect(parsed.messages[3].content[0].text).toContain("You are ZCode");
    expect(parsed.messages[3].content[0].text).not.toContain("Cline");
  });

  it("leaves non-system messages untouched (user prose is never rewritten)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "system", content: "Rule 1" },
        { role: "user", content: CLINE_OPENING },
      ],
    });

    const out = withNormalizeSwitch(undefined, () =>
      transformRequestBody(body, { format: "openai", injectZcodeSystem: true, provider: "bigmodel" }),
    );
    const parsed = JSON.parse(out as string);

    expect(parsed.messages[3]).toEqual({ role: "system", content: "Rule 1" });
    expect(parsed.messages[4]).toEqual({ role: "user", content: CLINE_OPENING });
  });

  it("both routes share one normalizer: identical input yields identical text", () => {
    const anthropicBody = JSON.stringify({
      model: "glm-5.2",
      system: CLAUDE_CODE_MODEL_SENTENCE,
      messages: [{ role: "user", content: "hi" }],
    });
    const openaiBody = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "system", content: CLAUDE_CODE_MODEL_SENTENCE },
        { role: "user", content: "hi" },
      ],
    });

    const anthropic = withNormalizeSwitch(undefined, () =>
      transformRequestBody(anthropicBody, { format: "anthropic", injectZcodeSystem: true, provider: "bigmodel" }),
    );
    const openai = withNormalizeSwitch(undefined, () =>
      transformRequestBody(openaiBody, { format: "openai", injectZcodeSystem: true, provider: "bigmodel" }),
    );

    const anthropicParsed = JSON.parse(anthropic as string);
    const openaiParsed = JSON.parse(openai as string);
    // Anthropic block 3 is the `\n\n`-prefixed client text; OpenAI keeps the raw message.
    expect(anthropicParsed.system[2].text).toBe(`\n\n${openaiParsed.messages[3].content}`);
    expect(anthropicParsed.system[2].text).toBe(`\n\n${ZCODE_IDENTITY_SENTENCE}`);
  });

  it("switch off → the client system message is byte-identical (逐字节不变)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "system", content: CLAUDE_CODE_MODEL_SENTENCE },
        { role: "user", content: "hi" },
      ],
    });

    const out = withNormalizeSwitch("0", () =>
      transformRequestBody(body, { format: "openai", injectZcodeSystem: true, provider: "bigmodel" }),
    );
    const parsed = JSON.parse(out as string);

    expect(parsed.messages[3].content).toBe(CLAUDE_CODE_MODEL_SENTENCE);
  });

  it("is idempotent: transforming the output again changes nothing", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "system", content: `${CLINE_OPENING}\n${CLAUDE_CODE_MODEL_SENTENCE}` },
        { role: "user", content: "hi" },
      ],
    });

    const once = withNormalizeSwitch(undefined, () =>
      transformRequestBody(body, { format: "openai", injectZcodeSystem: true, provider: "bigmodel" }),
    );
    const twice = withNormalizeSwitch(undefined, () =>
      transformRequestBody(once, { format: "openai", injectZcodeSystem: true, provider: "bigmodel" }),
    );

    const onceParsed = JSON.parse(once as string);
    const twiceParsed = JSON.parse(twice as string);
    // Second pass re-prepends the 3 official blocks, so compare the client message.
    expect(twiceParsed.messages[6]).toEqual(onceParsed.messages[3]);
    expect(onceParsed.messages[3].content).not.toContain("Cline");
    expect(onceParsed.messages[3].content).not.toContain("powered by the model named");
  });
});

describe("transformRequestBody — effort override (Anthropic branch)", () => {
  it("rewrites the body to the tier and re-serializes", () => {
    const body = JSON.stringify({ model: "glm-5.3", max_tokens: 4096, temperature: 0.7 });
    const out = transformRequestBody(body, { format: "anthropic", effortOverride: "low" });
    expect(out).not.toBe(body);
    const parsed = JSON.parse(out as string);
    expect(parsed.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    expect(parsed.output_config).toEqual({ effort: "low" });
    expect(parsed.max_tokens).toBe(4096 + 8000);
    expect(parsed.temperature).toBeUndefined();
  });

  it("omits the override entirely in passthrough (no ctx.effortOverride)", () => {
    const body = JSON.stringify({ model: "glm-5.3", max_tokens: 4096, temperature: 0.7 });
    expect(transformRequestBody(body, { format: "anthropic" })).toBe(body);
  });

  it("leaves OpenAI-format bodies untouched even when a tier is set", () => {
    // The OpenAI/Responses chains converge to Anthropic BEFORE this transform
    // runs; a body still in OpenAI shape here is not ours to rewrite.
    const body = JSON.stringify({ model: "glm-5.3", max_tokens: 4096, reasoning_effort: "low" });
    expect(transformRequestBody(body, { format: "openai", effortOverride: "low" })).toBe(body);
  });

  it("off tier writes thinking disabled and drops output_config", () => {
    const body = JSON.stringify({
      model: "glm-5.3-flash",
      max_tokens: 4096 + 8000,
      thinking: { type: "enabled", budget_tokens: 8000 },
      output_config: { effort: "low" },
    });
    const out = transformRequestBody(body, { format: "anthropic", effortOverride: "off" });
    const parsed = JSON.parse(out as string);
    expect(parsed.thinking).toEqual({ type: "disabled" });
    expect(parsed.output_config).toBeUndefined();
    expect(parsed.max_tokens).toBe(4096);
  });

  it("returns the original string on parse failure even with a tier set", () => {
    const broken = "{not valid json";
    expect(transformRequestBody(broken, { format: "anthropic", effortOverride: "low" })).toBe(broken);
  });

  it("non-reasoning models pass through unchanged (changed:false → original string)", () => {
    const body = JSON.stringify({ model: "glm-4.6v", max_tokens: 4096 });
    expect(transformRequestBody(body, { format: "anthropic", effortOverride: "max" })).toBe(body);
  });
});
