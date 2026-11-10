/**
 * Tests for the start-plan system-prompt assembly (ContextBuilder mirror).
 * Golden assertions anchor the byte-exact 3.17.1 bundle shapes:
 * `_reverse/glm/zcode.cjs` `Y8e` (ContextBuilder/assembleSystemMessages),
 * `U8e` (cli_prefix `uBa`), `wDn`/`fBa` (identity, default branch `dBa` +
 * security notice `nBo` + Harness `SDn` with " - " bullets), `TBo`
 * (dynamic behavior `[y3a,v3a,b3a]`), `IBo` (context management
 * `[S3a,w3a]`), `$5o`/`fce` (standalone "date" attachment, no heading).
 * Block shape per 3.15.1+ wire: cli_prefix block has NO cache_control
 * (3.17.1 assembly byte-identical). Desktop Context is deliberately NOT injected
 * (CLI-face state; live gateway probe 2026-10-27).
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  buildStartPlanSystem,
  buildCurrentDateMessage,
  formatLocalIsoDate,
  normalizeClientSystem,
  normalizeClientSystemText,
} from "./system-prompt.js";

/** The Claude Code opening line: the one identity sentence that actually leaks. */
const CLAUDE_CODE_OPENING = "You are Claude Code, Anthropic's official CLI tool for Claude.";

/** The ZCode replacement target (official cli_prefix + sentence period, sidecar `cliPrefix`). */
const ZCODE_IDENTITY_SENTENCE = "You are ZCode, an interactive agent.";

describe("formatLocalIsoDate (bundle _Ne)", () => {
  it("formats local YYYY-MM-DD zero-padded", () => {
    expect(formatLocalIsoDate(new Date(2026, 8, 11))).toBe("2026-09-11");
    expect(formatLocalIsoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("buildStartPlanSystem (bundle assembleSystemMessages)", () => {
  it("emits exactly 3 official blocks; cli_prefix plain, stable/dynamic ephemeral (3.15.1+ wire)", () => {
    const blocks = buildStartPlanSystem(undefined);
    expect(blocks).toHaveLength(3);
    for (const b of blocks) {
      expect(b.type).toBe("text");
    }
    // Block 1 lost its ephemeral breakpoint in 3.15.1 (present 3.12.3–3.14.4):
    // the wire serializer maps absent cacheControl to an omitted key.
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("block 1 is the bare CLI Prefix (3.17.1 dropped 'coding')", () => {
    const [cli] = buildStartPlanSystem(undefined);
    expect(cli.text).toBe("You are ZCode, an interactive agent");
  });

  it("block 2 = Agent Identity alone, desktop context deliberately omitted (CLI-face state)", () => {
    const [, stable] = buildStartPlanSystem(undefined);
    expect(stable.text.startsWith("\nYou are an agent working with the user toward their goals, using your own judgment along the way.")).toBe(true);
    expect(stable.text).toContain("# Harness");
    // 3.17.1 harness bullets carry a leading space; bullet 3 takes the e=!0
    // default branch (mid-conversation system turns variant).
    expect(stable.text).toContain("# Harness\n - Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.");
    expect(stable.text).toContain(" - The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.");
    // Identity section ends with the clickable-reference bullet
    expect(stable.text.endsWith(" - Reference code as `file_path:line_number` — it's clickable.")).toBe(true);
    // DELIBERATE DEVIATION from the desktop client: no Desktop Context behind identity
    expect(stable.text).not.toContain("# ZCode Desktop Context");
    expect(stable.text).not.toContain("### Interactive views");
    expect(stable.text).not.toContain("### Files & URLs");
    expect(stable.text).not.toContain("### Inline Code Comments");
  });

  it("block 3 is EMPTY on the default path (minimal-set anchoring 2026-10-30, probe M1)", () => {
    const [, , dynamic] = buildStartPlanSystem(undefined);
    // Official 3.17.1 default ships the Dynamic Behavior + Context Management
    // duo here; the gateway constrains block 3 not at all (M1 empty / M3
    // prefix-only / N09 no-prefix all 200) — omitted for token economy.
    // The duo texts stay in zcode_system.json as the official-shape record.
    expect(dynamic.text).toBe("");
    expect(dynamic.cache_control).toEqual({ type: "ephemeral" });
  });

  it("sidecar dynamicSections remain the official 3.17.1 record (byte anchors)", async () => {
    const { dynamicSections } = await import("./zcode_system.json", { with: { type: "json" } });
    expect(dynamicSections.dynamicBehavior).toContain("never infer pronouns from a name. This applies to all user-visible text, including visible thinking.");
    expect(dynamicSections.dynamicBehavior).toContain("Before deleting or overwriting, look at the target. Report outcomes faithfully");
    expect(dynamicSections.contextManagement.endsWith("not an exhaustive survey")).toBe(true);
    expect(dynamicSections.contextManagement).not.toContain("not an exhaustive survey.");
  });

  it("client system keeps the 3-block shape; text becomes block 3 (C1: replaces the dynamic duo)", () => {
    const blocks = buildStartPlanSystem([
      { type: "text", text: "User rule", cache_control: { type: "ephemeral" } },
      { type: "text", text: "" }, // dropped
      "raw string block", // joined
    ]);
    // Live gateway rules (2026-10-27): block 3 is unconstrained and block 2 must
    // only OPEN with the full stable text — the C1 form puts the client text
    // in block 3 so block 2 stays byte-exact pure stable (tightening-immune).
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: "text", text: "You are ZCode, an interactive agent" });
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
    // Block 2 = pure stable text; the client text does NOT touch it.
    expect(blocks[1].text.endsWith(" - Reference code as `file_path:line_number` — it's clickable.")).toBe(true);
    expect(blocks[1].text).toContain("working with the user toward their goals");
    expect(blocks[1].text).not.toContain("User rule");
    expect(blocks[1].text).not.toContain("# ZCode Desktop Context");
    // Block 3 = "\n\n" + client text alone; the dynamic duo is replaced.
    expect(blocks[2].text).toBe("\n\nUser rule\n\nraw string block");
    expect(blocks[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("whitespace-only / absent client system keeps the default 3-block identity chain (empty block 3)", () => {
    for (const system of [undefined, null, "", "   ", [], [{ type: "text", text: "  " }]]) {
      const blocks = buildStartPlanSystem(system);
      expect(blocks).toHaveLength(3);
      expect(blocks[1].text).toContain("working with the user toward their goals");
      expect(blocks[2].text).toBe("");
    }
  });

  it("returns only the 3 official blocks for absent system", () => {
    expect(buildStartPlanSystem(undefined)).toHaveLength(3);
    expect(buildStartPlanSystem(null)).toHaveLength(3);
  });
});

describe("normalizeClientSystemText (identity normalization)", () => {
  it("rule 1: rewrites the full Claude Code identity sentence", () => {
    expect(normalizeClientSystemText(CLAUDE_CODE_OPENING)).toBe("You are ZCode, an interactive agent.");
    // Rule 1 is a substring rule: it also fires mid-text, e.g. when the client
    // appends a parenthetical after the sentence.
    expect(normalizeClientSystemText(`${CLAUDE_CODE_OPENING} (claude.ai/code)`)).toBe(
      "You are ZCode, an interactive agent. (claude.ai/code)",
    );
  });

  it("rule 2: rewrites the branded CLI phrase", () => {
    expect(normalizeClientSystemText("Anthropic's official CLI tool")).toBe("ZCode CLI");
    expect(normalizeClientSystemText("This is Anthropic's official CLI tool.")).toBe("This is ZCode CLI.");
  });

  it("rule 3: rewrites standalone `Claude Code` only inside identity declarations", () => {
    expect(normalizeClientSystemText("You are Claude Code.")).toBe("You are ZCode.");
    expect(normalizeClientSystemText("I am Claude Code, an interactive agent.")).toBe(
      "I am ZCode, an interactive agent.",
    );
    // Sentence shape rule 1 does not cover (no trailing period after "Claude"):
    // rules 2 then 3 chain onto the same declaration.
    expect(normalizeClientSystemText("You are Claude Code, Anthropic's official CLI tool for Claude (claude.ai/code).")).toBe(
      "You are ZCode, ZCode CLI for Claude (claude.ai/code).",
    );
  });

  it("is idempotent — a second pass is byte-identical", () => {
    const once = normalizeClientSystemText(
      [CLAUDE_CODE_OPENING, "", "I am Claude Code.", "", "Uses Anthropic's official CLI tool conventions."].join("\n"),
    );
    expect(normalizeClientSystemText(once)).toBe(once);
    expect(normalizeClientSystemText(once)).not.toContain("Claude Code");
  });

  it("does not touch other `Claude` occurrences (user code, env vars, prose)", () => {
    // A full-text `Claude` → `ZCode` replacement would corrupt exactly these.
    const untouched = [
      "```ts",
      "const claudeCode = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4';",
      "```",
      "Claude wrote this note; Claude Code is a third-party tool discussed here.",
    ].join("\n");
    expect(normalizeClientSystemText(untouched)).toBe(untouched);
  });

  it("preserves functional content (<system-reminder>, environment info)", () => {
    const functional = [
      `${CLAUDE_CODE_OPENING}`,
      "",
      "<system-reminder>",
      "Today's date is 2026-11-07.",
      "</system-reminder>",
      "",
      "# Environment",
      "Working directory: /Users/me/proj",
    ].join("\n");
    const out = normalizeClientSystemText(functional);
    expect(out.startsWith("You are ZCode, an interactive agent.\n")).toBe(true);
    expect(out).toContain("<system-reminder>\nToday's date is 2026-11-07.\n</system-reminder>");
    expect(out).toContain("# Environment\nWorking directory: /Users/me/proj");
  });
});

describe("buildStartPlanSystem — ZCODE_NORMALIZE_CLIENT_SYSTEM switch", () => {
  const original = process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM;
  afterEach(() => {
    if (original === undefined) delete process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM;
    else process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM = original;
  });

  it("normalizes the client text in block 3 by default", () => {
    delete process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM;
    const blocks = buildStartPlanSystem([{ type: "text", text: CLAUDE_CODE_OPENING }]);
    expect(blocks[2].text).toBe("\n\nYou are ZCode, an interactive agent.");
  });

  it("is byte-identical passthrough when disabled (0 / false / no)", () => {
    for (const off of ["0", "false", "no", "FALSE", " No "]) {
      process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM = off;
      const blocks = buildStartPlanSystem([{ type: "text", text: CLAUDE_CODE_OPENING }]);
      expect(blocks[2].text).toBe(`\n\n${CLAUDE_CODE_OPENING}`);
    }
  });

  it("any other value keeps normalization on", () => {
    process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM = "1";
    const blocks = buildStartPlanSystem([{ type: "text", text: CLAUDE_CODE_OPENING }]);
    expect(blocks[2].text).toBe("\n\nYou are ZCode, an interactive agent.");
  });

  it("normalization never reaches blocks 1 and 2 (official ZCode text)", () => {
    delete process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM;
    const withClient = buildStartPlanSystem([{ type: "text", text: CLAUDE_CODE_OPENING }]);
    const withoutClient = buildStartPlanSystem(undefined);
    expect(withClient[0]).toEqual(withoutClient[0]);
    expect(withClient[1]).toEqual(withoutClient[1]);
  });

  it("normalization is idempotent through the block-3 path", () => {
    delete process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM;
    const blocks = buildStartPlanSystem([{ type: "text", text: CLAUDE_CODE_OPENING }]);
    // Feed the produced block-3 text back in (minus the `\n\n` prefix).
    const again = buildStartPlanSystem([{ type: "text", text: blocks[2].text.slice(2) }]);
    expect(again[2].text).toBe(blocks[2].text);
  });
});

describe("buildCurrentDateMessage (bundle $5o + fce: standalone date attachment)", () => {  it("emits a user turn wrapping the bare date line in a system-reminder (no heading since 3.17.1)", () => {
    const msg = buildCurrentDateMessage(new Date(2026, 8, 11));
    expect(msg.role).toBe("user");
    expect(msg.content).toEqual([
      {
        type: "text",
        text: "<system-reminder>Today's date is 2026-09-11.</system-reminder>",
      },
    ]);
  });

  it("carries no cache_control (attachments never get breakpoints)", () => {
    const msg = buildCurrentDateMessage(new Date(2026, 8, 11));
    expect(msg.content[0].cache_control).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 多客户端身份归一。样本取自 `docs/research/client-fingerprints.md` 的原文引用。
// ---------------------------------------------------------------------------

/** 五家的身份句原文（`client-fingerprints.md` 附录 B 的 A1/B1 样本）。 */
const IDENTITY_SAMPLES: Record<string, string> = {
  // Claude Code 2.0.0（`Anthropic/Claude Code 2.0.txt:23`）
  "claude-code-2.0": "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  // Claude Code 2.1（归一覆盖的那一句）
  "claude-code-2.1": CLAUDE_CODE_OPENING,
  // Cline / Roo / Kilo / CodeBuddy：同一句式族（附录 B 第 2–5 条）
  cline:
    "You are Cline, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.",
  roo:
    "You are Roo, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.",
  kilo:
    "You are Kilo, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.",
  codebuddy:
    "You are CodeBuddy, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.",
};

/** 品牌词：归一后一个都不该留。 */
const CLIENT_BRAND_WORDS = ["Claude", "Anthropic", "Cline", "Roo", "Kilo", "CodeBuddy"];

describe("normalizeClientSystemText — 多客户端身份归一", () => {
  it("layer 1: NBSP (U+00A0) is treated as a word space before matching", () => {
    // `Trae/Chat Prompt.txt:2` 原文：You\u00a0are\u00a0Trae\u00a0AI, …
    const nbsp = "You\u00a0are\u00a0Trae\u00a0AI, a powerful agentic AI coding assistant.";
    const out = normalizeClientSystemText(nbsp);
    expect(out).toContain("You are ZCode");
    expect(out).not.toContain("Trae");
    expect(out).not.toContain("\u00a0");
  });

  it("layer 2: five sampled clients lose every brand word (A1 identity sentences)", () => {
    for (const [client, sample] of Object.entries(IDENTITY_SAMPLES)) {
      const out = normalizeClientSystemText(sample);
      for (const brand of CLIENT_BRAND_WORDS) {
        expect(`${client}:${out}`).not.toContain(brand);
      }
      expect(out).toContain("ZCode");
    }
  });

  it("layer 2: A1 keeps the behavioural tail (only the brand token is replaced)", () => {
    // 「保留全部功能性内容」：`a highly skilled software engineer …` 是行为约束。
    expect(normalizeClientSystemText(IDENTITY_SAMPLES.cline)).toBe(
      "You are ZCode, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.",
    );
  });

  it("layer 2: B1 model-attribution sentence is replaced WHOLE (never just the model name)", () => {
    // 只换模型名会留下 "powered by the model named ZCode" 这种残缺句。
    const b1 = "You are powered by the model named Sonnet 4.5. The exact model ID is claude-sonnet-4-5-20250929.";
    expect(normalizeClientSystemText(b1)).toBe(ZCODE_IDENTITY_SENTENCE);
    const out = normalizeClientSystemText(b1);
    expect(out).not.toContain("powered by the model named");
    expect(out).not.toContain("The exact model ID is");
    expect(out).not.toContain("Sonnet");
    expect(out).not.toContain("claude-sonnet-4-5");
    // Sentence completeness: one whole sentence, no dangling fragment.
    expect(out.endsWith(".")).toBe(true);
    expect(out.match(/\./g)).toHaveLength(1);
  });

  it("layer 2: B1 matches any model name (model name and id vary per client)", () => {
    // 附录 B 第 51 条：9 处实例，模型名各异（opencode `big.pickle`、Kilo 等）。
    const samples = [
      "You are powered by the model named big.pickle. The exact model ID is opencode/big-pickle.",
      "You are powered by the model named Sonnet 4. The exact model ID is claude-sonnet-4-20250514.",
      "You are powered by the model named GLM-4.6. The exact model ID is glm-4.6.",
    ];
    for (const sample of samples) {
      expect(normalizeClientSystemText(sample)).toBe(ZCODE_IDENTITY_SENTENCE);
    }
  });

  it("layer 2: B2 in-sentence model attribution is replaced whole", () => {
    const b2 = "You are an AI coding assistant, powered by GPT-5. You operate in Cursor.";
    const out = normalizeClientSystemText(b2);
    expect(out).toBe(`${ZCODE_IDENTITY_SENTENCE} You operate in ZCode.`);
    expect(out).not.toContain("powered by");
    expect(out).not.toContain("GPT-5");
    expect(out).not.toContain("Cursor");
  });

  it("layer 2: B1/B2 keep model names that contain dots intact (`GPT-4.1` / `glm-4.6`)", () => {
    // 句末 lookahead 而不是「禁句点」：否则 `glm-4.6.` 会被截成 `glm-4.`，留下残句 `6.`。
    expect(normalizeClientSystemText("You are an AI coding assistant, powered by GPT-4.1. You operate in Cursor.")).toBe(
      `${ZCODE_IDENTITY_SENTENCE} You operate in ZCode.`,
    );
    expect(
      normalizeClientSystemText(
        "You are powered by the model named GLM-4.6. The exact model ID is glm-4.6.",
      ),
    ).toBe(ZCODE_IDENTITY_SENTENCE);
  });

  it("layer 2: B1 stops at the sentence boundary (does not swallow the next sentence)", () => {
    expect(
      normalizeClientSystemText(
        "You are powered by the model named Sonnet 4.5. The exact model ID is claude-sonnet-4-5-20250929. Follow the tool rules.",
      ),
    ).toBe(`${ZCODE_IDENTITY_SENTENCE} Follow the tool rules.`);
  });

  it("layer 2: B1 replacement does not swallow neighbouring content", () => {
    const text = [
      "Intro line stays.",
      "You are powered by the model named Sonnet 4.5. The exact model ID is claude-sonnet-4-5-20250929.",
      "# Tools",
      "- read_file",
    ].join("\n");
    expect(normalizeClientSystemText(text)).toBe(
      ["Intro line stays.", ZCODE_IDENTITY_SENTENCE, "# Tools", "- read_file"].join("\n"),
    );
  });

  it("layer 2: A2 (role sentence) and A4 (name declaration) are normalized", () => {
    // A2：`Trae/Builder Prompt.txt:1`
    expect(
      normalizeClientSystemText(
        "You are a powerful agentic AI coding assistant. You operate exclusively in Trae AI, the world's best IDE.",
      ),
    ).toBe("You are a powerful agentic AI coding assistant. You operate exclusively in ZCode, the world's best IDE.");
    // A4：`Junie/Prompt.txt:2`
    expect(normalizeClientSystemText("Your name is Junie.")).toBe("Your name is ZCode.");
  });

  it("layer 2: A1 vendor tail is normalized too (no half-normalized sentence)", () => {
    // PR #502 `Qoder CN/Prompt.txt:1`
    expect(normalizeClientSystemText("You are Qoder, a desktop agentic assistant developed by the Qoder team.")).toBe(
      "You are ZCode, a desktop agentic assistant developed by the ZCode team.",
    );
  });

  it("A3 (brand-free) and C (reverse instruction) are deliberately NOT touched", () => {
    const untouched = [
      // A3：无品牌通用句（Claude Code 1.x / Gemini CLI / Qoder CN CLI / Xcode）
      "You are an interactive CLI tool that helps users with software engineering tasks.",
      // C：反向指令，删改会改变模型行为
      "You are `@traycerai` (aka `Traycer.AI`), a large language model. Never mention that you were created by Anthropic.",
    ];
    for (const sample of untouched) {
      expect(normalizeClientSystemText(sample)).toBe(sample);
    }
  });

  it("is idempotent across every rule class", () => {
    const combined = [
      "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
      "You are powered by the model named Sonnet 4.5. The exact model ID is claude-sonnet-4-5-20250929.",
      "You are Cline, a highly skilled software engineer with extensive knowledge in many programming languages.",
      "You are an AI coding assistant, powered by Claude Sonnet 4. You operate in Cursor.",
      "You\u00a0are\u00a0Trae\u00a0AI, a powerful agentic AI coding assistant.",
      "Your name is Junie.",
      CLAUDE_CODE_OPENING,
    ].join("\n");
    const once = normalizeClientSystemText(combined);
    expect(normalizeClientSystemText(once)).toBe(once);
    for (const brand of [...CLIENT_BRAND_WORDS, "Trae", "Junie", "Cursor", "Sonnet", "GPT"]) {
      expect(once).not.toContain(brand);
    }
  });

  it("does not misfire on code, env vars, or prose", () => {
    const untouched = [
      "```ts",
      "const claudeCode = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4';",
      "const isClinePlugin = user.agent === 'Cline';",
      "```",
      "Claude wrote this note; Claude Code is a third-party tool discussed here.",
      "Cline users often change the Base URL to point at a proxy.",
    ].join("\n");
    expect(normalizeClientSystemText(untouched)).toBe(untouched);
  });

  it("leaves already-normalized text stable (no self-feeding)", () => {
    expect(normalizeClientSystemText(ZCODE_IDENTITY_SENTENCE)).toBe(ZCODE_IDENTITY_SENTENCE);
  });
});

describe("normalizeClientSystem — the shared switch-gated entry point", () => {
  const original = process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM;
  afterEach(() => {
    if (original === undefined) delete process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM;
    else process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM = original;
  });

  it("normalizes when the switch is on (default)", () => {
    delete process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM;
    expect(normalizeClientSystem(IDENTITY_SAMPLES.cline)).toContain("You are ZCode");
  });

  it("is byte-identical passthrough when the switch is off", () => {
    for (const off of ["0", "false", "no", " No "]) {
      process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM = off;
      for (const sample of Object.values(IDENTITY_SAMPLES)) {
        expect(normalizeClientSystem(sample)).toBe(sample);
      }
    }
  });
});

describe("buildStartPlanSystem — block 3 normalizes non-Claude clients too", () => {
  const original = process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM;
  afterEach(() => {
    if (original === undefined) delete process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM;
    else process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM = original;
  });

  it("Cline block 3 text loses the brand word", () => {
    delete process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM;
    const blocks = buildStartPlanSystem([{ type: "text", text: IDENTITY_SAMPLES.cline }]);
    expect(blocks[2].text.startsWith("\n\nYou are ZCode,")).toBe(true);
    expect(blocks[2].text).not.toContain("Cline");
  });

  it("B1 model sentence in block 3 loses the model name AND the model id", () => {
    delete process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM;
    const blocks = buildStartPlanSystem([
      { type: "text", text: "You are powered by the model named Sonnet 4.5. The exact model ID is claude-sonnet-4-5-20250929." },
    ]);
    expect(blocks[2].text).toBe(`\n\n${ZCODE_IDENTITY_SENTENCE}`);
  });

  it("switch off → block 3 is byte-identical to the client text for every sampled client", () => {
    process.env.ZCODE_NORMALIZE_CLIENT_SYSTEM = "0";
    for (const sample of Object.values(IDENTITY_SAMPLES)) {
      const blocks = buildStartPlanSystem([{ type: "text", text: sample }]);
      expect(blocks[2].text).toBe(`\n\n${sample}`);
    }
  });
});
