/**
 * Tests for local client session inference.
 */
import { describe, it, expect } from "bun:test";
import { createClientSessionResolver } from "./client-session.js";

function makeReq(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:8080/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

const CFG = { mode: "enforce" as const, ttlSeconds: 900, maxSessions: 1024 };
/** 默认账号命名空间：隔离用例会显式传第二个账号。 */
const ACCOUNT = "acct-a";

describe("client session resolver", () => {
  it("preserves explicit ZCode-style metadata IDs without hashing them", () => {
    const resolver = createClientSessionResolver();
    const body = JSON.stringify({
      model: "glm-4.6",
      metadata: {
        requestId: "req_client_1",
        traceId: "trace_client_1",
        queryId: "query_turn_1",
        sessionId: "sess_thread_1",
      },
      messages: [{ role: "user", content: "Hi" }],
    });

    const result = resolver.resolve(ACCOUNT, makeReq(body), body, "anthropic", "glm-4.6", CFG);

    expect(result.source).toBe("explicit");
    expect(result.requestId).toBe("req_client_1");
    expect(result.traceId).toBe("trace_client_1");
    expect(result.queryId).toBe("query_turn_1");
    expect(result.sessionId).toBe("sess_thread_1");
    expect(result.upstreamSessionId).toBe("sess_thread_1");
  });

  it("preserves explicit subagent session headers for emission-time prefix stripping", () => {
    const resolver = createClientSessionResolver();
    const body = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });
    const result = resolver.resolve(ACCOUNT, makeReq(body, {
      "x-request-id": "req_header_1",
      "x-zcode-trace-id": "trace_header_1",
      "x-query-id": "query_header_1",
      "x-session-id": "subagent_agent_worker_1",
    }), body, "anthropic", "glm-4.6", CFG);

    expect(result.source).toBe("explicit");
    expect(result.requestId).toBe("req_header_1");
    expect(result.traceId).toBe("trace_header_1");
    expect(result.queryId).toBe("query_header_1");
    expect(result.sessionId).toBe("subagent_agent_worker_1");
    expect(result.upstreamSessionId).toBe("subagent_agent_worker_1");
  });

  it("accepts Claude Code session headers case-insensitively", () => {
    const resolver = createClientSessionResolver();
    const body = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });
    const result = resolver.resolve(ACCOUNT, makeReq(body, {
      "X-Claude-Code-Session-Id": "  claude_session_1  ",
    }), body, "anthropic", "glm-4.6", CFG);

    expect(result.source).toBe("explicit");
    expect(result.confidence).toBe(1);
    expect(result.sessionId).toBe("claude_session_1");
    expect(result.upstreamSessionId).toBe("claude_session_1");
  });

  it("recognizes the expanded explicit-session header set (Claude Code non-x, VSCode family)", () => {
    const resolver = createClientSessionResolver();
    const body = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });

    // Claude Code SDK variant without the x- prefix
    expect(resolver.resolve(ACCOUNT, makeReq(body, { "claude-code-session-id": "cc_nox_1" }), body, "anthropic", "glm-4.6", CFG)
      .sessionId).toBe("cc_nox_1");
    // VSCode family (Google Antigravity sends x-vscode-sessionid per launch)
    expect(resolver.resolve(ACCOUNT, makeReq(body, { "x-vscode-sessionid": "vs_sess_1" }), body, "anthropic", "glm-4.6", CFG)
      .sessionId).toBe("vs_sess_1");
    // Claude Code per-request id feeds requestId detection
    expect(resolver.resolve(ACCOUNT, makeReq(body, { "x-client-request-id": "ccr_1" }), body, "anthropic", "glm-4.6", CFG)
      .requestId).toBe("ccr_1");
  });

  it("prefers tool-specific session headers over the generic x-session-id", () => {
    const resolver = createClientSessionResolver();
    const body = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });
    const result = resolver.resolve(ACCOUNT, makeReq(body, {
      "x-vscode-sessionid": "vs_specific_1",
      "x-session-id": "generic_1",
    }), body, "anthropic", "glm-4.6", CFG);
    expect(result.sessionId).toBe("vs_specific_1");
  });

  it("keeps existing snake_case metadata session fallbacks", () => {
    const resolver = createClientSessionResolver();
    const body = JSON.stringify({
      model: "glm-4.6",
      metadata: {
        request_id: "req_legacy_1",
        trace_id: "trace_legacy_1",
        query_id: "query_legacy_1",
        session_id: "sess_legacy_1",
      },
      messages: [{ role: "user", content: "Hi" }],
    });

    const result = resolver.resolve(ACCOUNT, makeReq(body), body, "anthropic", "glm-4.6", CFG);

    expect(result.requestId).toBe("req_legacy_1");
    expect(result.traceId).toBe("trace_legacy_1");
    expect(result.queryId).toBe("query_legacy_1");
    expect(result.sessionId).toBe("sess_legacy_1");
  });
  it("keeps lineage session inference when metadata only provides trace IDs", () => {
    const resolver = createClientSessionResolver();
    const body1 = JSON.stringify({
      model: "glm-4.6",
      metadata: {
        requestId: "req_turn_1",
        traceId: "trace_turn_1",
        queryId: "query_turn_1",
      },
      messages: [{ role: "user", content: "Hi" }],
    });
    const body2 = JSON.stringify({
      model: "glm-4.6",
      metadata: {
        requestId: "req_turn_2",
        traceId: "trace_turn_2",
        queryId: "query_turn_2",
      },
      messages: [{ role: "user", content: "Hi" }],
    });

    const first = resolver.resolve(ACCOUNT, makeReq(body1), body1, "anthropic", "glm-4.6", CFG);
    const second = resolver.resolve(ACCOUNT, makeReq(body2), body2, "anthropic", "glm-4.6", CFG);

    expect(first.source).toBe("lineage");
    expect(first.upstreamSessionId).toBeTruthy();
    expect(first.requestId).toBe("req_turn_1");
    expect(first.traceId).toBe("trace_turn_1");
    expect(first.queryId).toBe("query_turn_1");
    expect(second.source).toBe("lineage");
    expect(second.upstreamSessionId).toBe(first.upstreamSessionId);
    expect(second.requestId).toBe("req_turn_2");
    expect(second.traceId).toBe("trace_turn_2");
    expect(second.queryId).toBe("query_turn_2");
  });
  it("reuses the same session for exact request bodies", () => {
    const resolver = createClientSessionResolver();
    const body = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });

    const first = resolver.resolve(ACCOUNT, makeReq(body), body, "anthropic", "glm-4.6", CFG);
    const second = resolver.resolve(ACCOUNT, makeReq(body), body, "anthropic", "glm-4.6", CFG);

    expect(first.source).toBe("lineage");
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.upstreamSessionId).toBe(first.upstreamSessionId);
    expect(second.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("reuses the same session for a linear continuation", () => {
    const resolver = createClientSessionResolver();
    const firstBody = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });
    const nextBody = JSON.stringify({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Next" },
      ],
    });

    const first = resolver.resolve(ACCOUNT, makeReq(firstBody), firstBody, "anthropic", "glm-4.6", CFG);
    const next = resolver.resolve(ACCOUNT, makeReq(nextBody), nextBody, "anthropic", "glm-4.6", CFG);

    expect(next.sessionId).toBe(first.sessionId);
    expect(next.source).toBe("lineage");
  });

  it("creates separate sessions for forked continuations from the same parent", () => {
    const resolver = createClientSessionResolver();
    const parentBody = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });
    const forkA = JSON.stringify({
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }, { role: "user", content: "A" }],
    });
    const forkB = JSON.stringify({
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }, { role: "user", content: "B" }],
    });

    resolver.resolve(ACCOUNT, makeReq(parentBody), parentBody, "anthropic", "glm-4.6", CFG);
    const a = resolver.resolve(ACCOUNT, makeReq(forkA), forkA, "anthropic", "glm-4.6", CFG);
    const b = resolver.resolve(ACCOUNT, makeReq(forkB), forkB, "anthropic", "glm-4.6", CFG);

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.upstreamSessionId).not.toBe(b.upstreamSessionId);
  });

  it("canonicalizes OpenAI requests while ignoring transport and sampling fields", () => {
    const resolver = createClientSessionResolver();
    const firstBody = JSON.stringify({
      model: "glm-4.6",
      stream: true,
      temperature: 0.2,
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "Hi" }],
    });
    const secondBody = JSON.stringify({
      model: "glm-4.6",
      stream: false,
      temperature: 0.9,
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "Hi" }],
    });

    const first = resolver.resolve(ACCOUNT, makeReq(firstBody), firstBody, "openai", "glm-4.6", CFG);
    const second = resolver.resolve(ACCOUNT, makeReq(secondBody), secondBody, "openai", "glm-4.6", CFG);

    expect(second.sessionId).toBe(first.sessionId);
  });

  it("does not throw or allocate a session for malformed or empty bodies", () => {
    const resolver = createClientSessionResolver();

    const malformed = resolver.resolve(ACCOUNT, makeReq("not-json"), "not-json", "anthropic", "glm-4.6", CFG);
    const empty = resolver.resolve(ACCOUNT, makeReq(""), undefined, "anthropic", "glm-4.6", CFG);

    expect(malformed.source).toBe("none");
    expect(malformed.sessionId).toBeUndefined();
    expect(empty.source).toBe("none");
    expect(empty.sessionId).toBeUndefined();
  });

  it("reuses the same session when a tool round appends three messages", () => {
    const resolver = createClientSessionResolver();
    const firstBody = JSON.stringify({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    });
    // parallel tool results split across two user messages → 3-message append
    const nextBody = JSON.stringify({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "read" }, { type: "tool_use", id: "t3", name: "grep" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "a" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "b" }] },
      ],
    });

    const first = resolver.resolve(ACCOUNT, makeReq(firstBody), firstBody, "anthropic", "glm-4.6", CFG);
    const next = resolver.resolve(ACCOUNT, makeReq(nextBody), nextBody, "anthropic", "glm-4.6", CFG);

    expect(next.source).toBe("lineage");
    expect(next.sessionId).toBe(first.sessionId);
    expect(next.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("mints a fresh session after the lineage TTL expires", () => {
    let clock = 1_000_000;
    const resolver = createClientSessionResolver(() => clock);
    const body = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });

    const first = resolver.resolve(ACCOUNT, makeReq(body), body, "anthropic", "glm-4.6", CFG);
    clock += CFG.ttlSeconds * 1000 + 1;
    const second = resolver.resolve(ACCOUNT, makeReq(body), body, "anthropic", "glm-4.6", CFG);

    expect(second.source).toBe("lineage");
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("keeps node-level affinity after a session is LRU-evicted within TTL", () => {
    const smallCfg = { ...CFG, maxSessions: 1 };
    const resolver = createClientSessionResolver();
    const bodyA = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "A" }] });
    const bodyB = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "B" }] });
    const bodyA2 = JSON.stringify({
      model: "glm-4.6",
      messages: [{ role: "user", content: "A" }, { role: "assistant", content: "hey" }, { role: "user", content: "more" }],
    });

    const a = resolver.resolve(ACCOUNT, makeReq(bodyA), bodyA, "anthropic", "glm-4.6", smallCfg);
    resolver.resolve(ACCOUNT, makeReq(bodyB), bodyB, "anthropic", "glm-4.6", smallCfg);
    const aNext = resolver.resolve(ACCOUNT, makeReq(bodyA2), bodyA2, "anthropic", "glm-4.6", smallCfg);

    expect(aNext.source).toBe("lineage");
    expect(aNext.sessionId).toBe(a.sessionId);
  });

  it("does not reuse an expired lineage node after another node in its session is refreshed", () => {
    let clock = 0;
    const resolver = createClientSessionResolver(() => clock);
    const cfg = { ...CFG, ttlSeconds: 5 };
    const aFirst = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "A" }] });
    const aNext = JSON.stringify({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "A" },
        { role: "assistant", content: "answer A" },
        { role: "user", content: "continue A" },
      ],
    });
    const bFirst = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "B" }] });
    const bNext = JSON.stringify({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "B" },
        { role: "assistant", content: "answer B" },
        { role: "user", content: "continue B" },
      ],
    });

    resolver.resolve(ACCOUNT, makeReq(aFirst), aFirst, "anthropic", "glm-4.6", cfg);
    clock = 1_000;
    const b = resolver.resolve(ACCOUNT, makeReq(bFirst), bFirst, "anthropic", "glm-4.6", cfg);
    clock = 2_000;
    resolver.resolve(ACCOUNT, makeReq(aNext), aNext, "anthropic", "glm-4.6", cfg);
    // Refresh A's newer node. Its earlier node stays at the front of the node
    // map, ahead of B's node, so it must not make B's timestamp look fresh.
    clock = 6_000;
    resolver.resolve(ACCOUNT, makeReq(aNext), aNext, "anthropic", "glm-4.6", cfg);

    clock = 7_000;
    const afterExpiry = resolver.resolve(ACCOUNT, makeReq(bNext), bNext, "anthropic", "glm-4.6", cfg);

    expect(afterExpiry.sessionId).not.toBe(b.sessionId);
  });
});

/**
 * 一账号一 session 命名空间。
 *
 * 此前实测发现的缺陷：血缘表是进程级单例、键里没有 accountId，于是同一段对话
 * 在两个账号下拿到**同一个** sessionId。这里断言的是修复后的三条性质：跨账号
 * 不同、同账号稳定、id 形态对齐上游 `createSessionId`。
 */
describe("client session resolver 账号命名空间", () => {
  const BODY = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });

  it("同一段对话在两个账号下拿到不同的 sessionId", () => {
    const resolver = createClientSessionResolver();

    const a = resolver.resolve("acct-a", makeReq(BODY), BODY, "anthropic", "glm-4.6", CFG);
    const b = resolver.resolve("acct-b", makeReq(BODY), BODY, "anthropic", "glm-4.6", CFG);

    expect(a.source).toBe("lineage");
    expect(b.source).toBe("lineage");
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.upstreamSessionId).not.toBe(b.upstreamSessionId);
  });

  it("同一账号重复请求 sessionId 稳定（原有行为不能坏）", () => {
    const resolver = createClientSessionResolver();

    const first = resolver.resolve("acct-a", makeReq(BODY), BODY, "anthropic", "glm-4.6", CFG);
    const second = resolver.resolve("acct-a", makeReq(BODY), BODY, "anthropic", "glm-4.6", CFG);
    // 另一个账号的插入不能把 acct-a 的条目挤掉
    resolver.resolve("acct-b", makeReq(BODY), BODY, "anthropic", "glm-4.6", CFG);
    const third = resolver.resolve("acct-a", makeReq(BODY), BODY, "anthropic", "glm-4.6", CFG);

    expect(second.sessionId).toBe(first.sessionId);
    expect(third.sessionId).toBe(first.sessionId);
    expect(third.upstreamSessionId).toBe(first.upstreamSessionId);
    expect(third.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("续轮在同一账号内仍然命中血缘，跨账号不复用", () => {
    const resolver = createClientSessionResolver();
    const nextBody = JSON.stringify({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Next" },
      ],
    });

    const firstA = resolver.resolve("acct-a", makeReq(BODY), BODY, "anthropic", "glm-4.6", CFG);
    const nextA = resolver.resolve("acct-a", makeReq(nextBody), nextBody, "anthropic", "glm-4.6", CFG);
    const nextB = resolver.resolve("acct-b", makeReq(nextBody), nextBody, "anthropic", "glm-4.6", CFG);

    expect(nextA.sessionId).toBe(firstA.sessionId);
    expect(nextB.sessionId).not.toBe(firstA.sessionId);
  });

  it("生成的 sessionId 是上游形态 `sess_<uuid>`（前缀必须能被 trace-headers 剥掉）", () => {
    const resolver = createClientSessionResolver();
    const result = resolver.resolve(ACCOUNT, makeReq(BODY), BODY, "anthropic", "glm-4.6", CFG);

    // 上游 `createSessionId` = `sess_${crypto.randomUUID()}`；`ses_` 前缀不在
    // trace-headers 的剥离集合里，会原样漏给上游（本用例即该回归的守卫）。
    expect(result.sessionId).toMatch(/^sess_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // 出线值（upstreamSessionId）是剥掉前缀后的裸 UUID
    expect(result.upstreamSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("容量上限是全局进程上限，不是每账号配额（一个账号的洪水会挤掉别的账号）", () => {
    // maxSessions = 1 → 会话表上限 1、血缘节点表上限 1 * NODES_PER_SESSION_CAP(32)。
    // 语义是「进程内存上限」：32 个不同对话（同一账号）之后，最久未用的节点
    // —— 哪怕是另一个账号的 —— 会被淘汰。若是每账号配额，B 的条目就该活着。
    const cfg = { ...CFG, maxSessions: 1 };
    const resolver = createClientSessionResolver();
    const bodyOf = (tag: string) => JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: tag }] });
    const bodyB = bodyOf("B");

    const b = resolver.resolve("acct-b", makeReq(bodyB), bodyB, "anthropic", "glm-4.6", cfg);
    // 32 个新对话把 acct-b 那条挤到淘汰线之外
    for (let i = 0; i < 32; i += 1) {
      const body = bodyOf(`A${i}`);
      resolver.resolve("acct-a", makeReq(body), body, "anthropic", "glm-4.6", cfg);
    }

    const bAgain = resolver.resolve("acct-b", makeReq(bodyB), bodyB, "anthropic", "glm-4.6", cfg);
    expect(bAgain.source).toBe("lineage");
    expect(bAgain.sessionId).not.toBe(b.sessionId);
  });
});

/**
 * 两段式推断：`fingerprint()` 账号无关、`finalize()` 才带账号。
 *
 * 为什么必须拆开：`broker.acquire()` 要在选号时拿到会话键（粘性绑定与
 * `sticky-hash` 的哈希输入），而 sessionId 带账号种子，只能等租约。于是
 * 「粘性键」与「sessionId」必须是两个值。这一组用例钉住前者跨轮、跨账号都不变。
 */
describe("两段式推断：粘性键账号无关且跨轮稳定", () => {
  const firstBody = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });
  const nextBody = JSON.stringify({
    model: "glm-4.6",
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Next" },
    ],
  });

  it("同一段对话的续轮拿到同一个粘性键（键是对话级的，不是节点级的）", () => {
    const resolver = createClientSessionResolver();

    const first = resolver.fingerprint(makeReq(firstBody), firstBody, "anthropic", "glm-4.6", CFG);
    const next = resolver.fingerprint(makeReq(nextBody), nextBody, "anthropic", "glm-4.6", CFG);

    expect(first.source).toBe("lineage");
    expect(first.stickyKey).toBeTruthy();
    expect(next.stickyKey).toBe(first.stickyKey!);
  });

  it("粘性键里不含账号：选号之前就能算出来", () => {
    const resolver = createClientSessionResolver();
    // fingerprint 的签名里根本没有 accountId，这条断言守的是「以后别把它加回去」。
    const fingerprint = resolver.fingerprint(makeReq(firstBody), firstBody, "anthropic", "glm-4.6", CFG);
    expect(fingerprint.stickyKey).not.toContain("acct");
  });

  it("同一指纹在两个账号下 finalize 出不同 sessionId，但粘性键仍是同一个", () => {
    const resolver = createClientSessionResolver();
    const fingerprint = resolver.fingerprint(makeReq(firstBody), firstBody, "anthropic", "glm-4.6", CFG);

    const a = resolver.finalize("acct-a", fingerprint, CFG);
    const b = resolver.finalize("acct-b", fingerprint, CFG);

    expect(a.sessionId).not.toBe(b.sessionId);
    // 键没有第二份：它只属于这段对话，不属于某个账号。
    expect(fingerprint.stickyKey).toBeTruthy();
  });

  it("fingerprint + finalize 与 resolve 等价", () => {
    const resolver = createClientSessionResolver();
    // 先让这段对话存在（sessionId 是随机生成的，两个 resolver 之间不可比）。
    const seeded = resolver.resolve("acct-a", makeReq(firstBody), firstBody, "anthropic", "glm-4.6", CFG);

    const viaSplit = resolver.finalize("acct-a", resolver.fingerprint(makeReq(nextBody), nextBody, "anthropic", "glm-4.6", CFG), CFG);
    const viaResolve = resolver.resolve("acct-a", makeReq(nextBody), nextBody, "anthropic", "glm-4.6", CFG);

    expect(viaSplit.source).toBe(viaResolve.source);
    expect(viaSplit.sessionId).toBe(viaResolve.sessionId);
    // 两条路径都落在先播种的那个会话上（续轮血缘）
    expect(viaSplit.sessionId).toBe(seeded.sessionId!);
    // 置信度不比：第一次调用把 exact 节点写进了表，第二次命中 exact（0.95），
    // 前者走的是父节点匹配（0.9）。差异来自调用顺序，不是两段式与合并式的语义差别。
  });

  it("explicit 用客户端给的会话 id 当粘性键，trace-only 与 none 没有键", () => {
    const resolver = createClientSessionResolver();
    const body = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });

    const explicit = resolver.fingerprint(
      makeReq(body, { "x-session-id": "client_thread_1" }), body, "anthropic", "glm-4.6", CFG);
    expect(explicit.stickyKey).toBe("client_thread_1");

    const traceOnly = resolver.fingerprint(
      makeReq(body, { "x-request-id": "req_1" }), body, "anthropic", "glm-4.6", CFG);
    expect(traceOnly.source).toBe("lineage"); // 有 body 就能推断血缘，键仍然有
    expect(traceOnly.stickyKey).toBeTruthy();

    // 既没有会话头也没有可哈希的 body：没有会话身份，也就没有粘性键。
    const none = resolver.fingerprint(makeReq("{}"), "{}", "anthropic", "glm-4.6", CFG);
    expect(none.source).toBe("none");
    expect(none.stickyKey).toBeUndefined();
  });

  it("关闭会话推断时不产出指纹（mode=off）", () => {
    const resolver = createClientSessionResolver();
    const off = { ...CFG, mode: "off" as const };
    const fingerprint = resolver.fingerprint(makeReq(firstBody), firstBody, "anthropic", "glm-4.6", off);
    expect(fingerprint.stickyKey).toBeUndefined();
    expect(resolver.finalize("acct-a", fingerprint, off).source).toBe("none");
  });
});
