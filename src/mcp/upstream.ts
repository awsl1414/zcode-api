/**
 * Official plugin-MCP upstream client: structured JSON-RPC calls against
 * Z.AI's official gateway (`{origin}/api/v1/mcp/server/{routeId}`), replacing
 * the old blind `/mcp/{key}` passthrough relay with the aggregated `/mcp`
 * endpoint (one URL, all tools — see aggregate.ts).
 *
 * Header contract — LIVE-VERIFIED 2026-09-25 against
 * `https://zcode.z.ai/api/v1/mcp/server/finance_tianyancha` (initialize →
 * 200 + serverInfo `zcode-official-mcp`):
 *   Authorization: Bearer <zcode JWT>                        (Credential.jwt)
 *   X-Bigmodel-Authorization: Bearer <coding-plan API key>   (credentialString)
 *   Bigmodel-Target-Type: PERSONAL | TEAM                    (账号自己的身份作用域)
 *   Bigmodel-Organization / Bigmodel-Project                 (TEAM only)
 *
 * 身份三个头**必须**取自账号（`Account.credential.identity`），不能硬编码
 * `PERSONAL`：TEAM 账号的凭据带组织 / 项目作用域，按个人身份发出去会被上游当成
 * 错误的权益范围处理（`highspeed/manager.ts` 修过同一个问题）。
 *
 * Corrections to the 3.14.3 host bundle reading: the
 * `tw`/`nw` symbols suggest the plan header carries the raw OAuth access token from
 * the `oauth:{family}:access_token` slot — but that slot is `enc:v1:`-encrypted
 * in the desktop store (content unverifiable), and the API-key variant is what
 * actually authenticates. Identity-only (Authorization alone) is rejected by
 * the gateway with JSON-RPC 3101 "coding plan is required", so start-plan
 * credentials cannot serve this plane at all (routes surface that as 400
 * `mcp_plan_unsupported`, mirroring the async-route pattern).
 *
 * @see _reverse/NOTEPAD.md "Official plugin MCP"
 */
import { credentialString, hasCodingPlanKey, type Credential } from "../auth/types.js";
import type { AccountIdentity } from "../accounts/types.js";
import { fetchWithEgress, type EgressOptions } from "../proxy/egress.js";

/**
 * MCP 出线需要的账号身份（`AccountIdentity` 的子集）。
 *
 * 只取官方那三个头用得到的字段（与 `highspeed/manager.ts::HighspeedIdentity` 同形）：
 * 传整份 `AccountIdentity` 会把 `deviceMid` / `productId` 也带进这个只做鉴权头的
 * 函数，让"谁在用哪份身份"变得含糊。
 */
export type McpTargetIdentity = Pick<AccountIdentity, "targetType" | "organizationId" | "projectId">;

type OfficialMcpAuthMode = "coding-plan";
export type McpCredentialReason = "missing_jwt" | "missing_api_key";

export class McpCredentialsUnavailableError extends Error {
  constructor(
    public readonly reason: McpCredentialReason,
    message: string,
  ) {
    super(message);
    this.name = "McpCredentialsUnavailableError";
  }
}

export interface OfficialMcpAuth {
  mode: OfficialMcpAuthMode;
  headers: Record<string, string>;
}

/**
 * Build the official-MCP auth headers for a coding-plan credential.
 *
 * `identity` 是**账号自己的**身份作用域，由调用方从
 * `Account.credential.identity` 取：TEAM 账号必须带上 `Bigmodel-Organization` /
 * `Bigmodel-Project`，否则上游把组织凭据当个人账号处理。组织、项目、产品三个字段
 * 必须来自同一份凭据，官方明确禁止跨 Family 拼接，也禁止把 TEAM 降级成个人身份。
 * 这里没有默认值 —— 猜一个 `PERSONAL` 只会把问题藏起来。
 *
 * @throws McpCredentialsUnavailableError when the credential has no zcode JWT.
 */
export function buildOfficialMcpAuthHeaders(cred: Credential, identity: McpTargetIdentity): OfficialMcpAuth {
  const jwt = cred.jwt?.trim();
  if (!jwt) {
    throw new McpCredentialsUnavailableError(
      "missing_jwt",
      "stored credential has no ZCode JWT — re-run `auth login` (or `auth import`) to use the /mcp endpoint",
    );
  }
  // The X-Bigmodel-Authorization below carries `{apiKey}.{secret}`. A JWT-only
  // credential (imported plan token) would send the header empty and the
  // gateway answers 3101, so reject it here where the headers are built.
  if (!hasCodingPlanKey(cred)) {
    throw new McpCredentialsUnavailableError(
      "missing_api_key",
      "stored credential has no coding-plan API key, so /mcp cannot authenticate; import the ZCode credential file (`zcode-proxy auth import`) or log in again",
    );
  }
  return {
    mode: "coding-plan",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "X-Bigmodel-Authorization": `Bearer ${credentialString(cred).trim()}`,
      "Bigmodel-Target-Type": identity.targetType,
      // TEAM 的两个头：导入时保证非空（见 `AccountIdentity` 注释），
      // 与 `highspeed/manager.ts::highspeedAuthHeaders` 保持同一套断言。
      ...(identity.targetType === "TEAM"
        ? {
          "Bigmodel-Organization": identity.organizationId!,
          "Bigmodel-Project": identity.projectId!,
        }
        : {}),
    },
  };
}

/** Thrown when the upstream answers HTTP 404 for a session-bound call — the
 *  streamable-HTTP "session expired" signal; callers re-initialize once. */
export class McpSessionExpiredError extends Error {
  constructor() {
    super("upstream MCP session expired (HTTP 404)");
    this.name = "McpSessionExpiredError";
  }
}

/** Upstream call failed in a way that is NOT worth retrying (auth/plan/
 *  network/JSON-RPC error) — the plugin is temporarily unusable. */
export class McpUpstreamError extends Error {
  constructor(
    message: string,
    /** JSON-RPC error object from the upstream, when the failure was a
     *  well-formed JSON-RPC error response (preserved for the client). */
    public readonly rpcError?: { code: number; message: string; data?: unknown },
  ) {
    super(message);
    this.name = "McpUpstreamError";
  }
}

export interface UpstreamTool {
  name: string;
  [k: string]: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";
const MAX_TOOLS_PAGES = 10;

/** Identity of one official plugin endpoint (from the build-time catalogue). */
export interface OfficialMcpTarget {
  /** Gateway route identifier (path segment after /api/v1/mcp/server/). */
  routeId: string;
  /** Upstream path (`/api/v1/mcp/server/{routeId}`), pre-origin. */
  path: string;
}

/**
 * Streamable-HTTP JSON-RPC client for ONE official plugin endpoint. Keeps the
 * upstream `Mcp-Session-Id` + negotiated protocol version; callers own the
 * retry policy (aggregate.ts re-initializes once on McpSessionExpiredError).
 */
export class OfficialMcpUpstream {
  private sessionId: string | undefined;
  private protocolVersion = SUPPORTED_PROTOCOL_VERSION;

  constructor(
    private readonly origin: string,
    private readonly target: OfficialMcpTarget,
    private readonly auth: OfficialMcpAuth,
    private readonly fetchImpl: typeof fetch = fetch,
    /** 该账号的出口代理。创建时固定。*/
    private readonly egress?: EgressOptions,
  ) {}

  /** Whether initialize has completed (session established). */
  get initialized(): boolean {
    return this.sessionId !== undefined;
  }

  private url(): string {
    return `${this.origin}${this.target.path}`;
  }

  private baseHeaders(): Record<string, string> {
    return {
      ...this.auth.headers,
      accept: "application/json, text/event-stream",
    };
  }

  private sessionHeaders(): Record<string, string> {
    return {
      ...this.baseHeaders(),
      "mcp-session-id": this.sessionId!,
      "mcp-protocol-version": this.protocolVersion,
    };
  }

  /**
   * POST one JSON-RPC message and await the matching response object.
   * Streamable-HTTP servers may answer POST with SSE instead of JSON — both
   * shapes are decoded; the first frame carrying the request id wins.
   * Returns the payload plus the raw response headers (session capture).
   */
  private async rpc(message: unknown, headers: Record<string, string>): Promise<{ payload: JsonRpcResponse; respHeaders: Headers }> {
    let resp: Response;
    try {
      resp = await fetchWithEgress(this.fetchImpl, this.url(), {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(message),
      }, this.egress);
    } catch (err) {
      throw new McpUpstreamError(`official MCP gateway unreachable: ${(err as Error).message}`);
    }
    if (resp.status === 404) throw new McpSessionExpiredError();
    if (resp.status === 401 || resp.status === 403) {
      throw new McpUpstreamError(`upstream rejected the credential (HTTP ${resp.status})`);
    }
    const contentType = resp.headers.get("content-type") ?? "";
    let payload: JsonRpcResponse;
    if (contentType.includes("text/event-stream")) {
      payload = decodeSseFrame(await resp.text(), (message as { id?: unknown }).id);
    } else {
      const text = await resp.text();
      try {
        payload = JSON.parse(text) as JsonRpcResponse;
      } catch {
        throw new McpUpstreamError(`upstream returned non-JSON body (HTTP ${resp.status})`);
      }
    }
    if (payload?.error) {
      throw new McpUpstreamError(
        `upstream JSON-RPC error ${payload.error.code}: ${payload.error.message}`,
        { code: payload.error.code ?? -32000, message: payload.error.message ?? "upstream error", data: payload.error.data },
      );
    }
    return { payload, respHeaders: resp.headers };
  }

  /** initialize + notifications/initialized. Idempotent per session. */
  async initialize(clientName: string): Promise<void> {
    if (this.initialized) return;
    const { payload: init, respHeaders } = await this.rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: SUPPORTED_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: clientName, version: "1.0.0" },
        },
      },
      this.baseHeaders(),
    );
    const result = init.result as { protocolVersion?: string } | undefined;
    if (result?.protocolVersion) this.protocolVersion = result.protocolVersion;
    const sessionId = respHeaders.get("mcp-session-id") ?? undefined;
    if (sessionId) this.sessionId = sessionId;
    // Fire-and-forget the initialized notification (202, no body). A missing
    // session id means a stateless upstream — nothing to notify or bind.
    if (this.sessionId) {
      try {
        await fetchWithEgress(this.fetchImpl, this.url(), {
          method: "POST",
          headers: { "content-type": "application/json", ...this.sessionHeaders() },
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        }, this.egress);
      } catch {
        // Non-fatal: some gateways skip the notification round-trip.
      }
    }
  }

  /** tools/list with cursor pagination; returns tools in their ORIGINAL names. */
  async listTools(): Promise<UpstreamTool[]> {
    const tools: UpstreamTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOLS_PAGES; page++) {
      const resp = await this.rpc(
        {
          jsonrpc: "2.0",
          id: page + 2,
          method: "tools/list",
          ...(cursor ? { params: { cursor } } : {}),
        },
        this.sessionHeaders(),
      );
      const result = resp.payload.result as { tools?: UpstreamTool[]; nextCursor?: string } | undefined;
      if (Array.isArray(result?.tools)) tools.push(...result!.tools!);
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  /** tools/call with the ORIGINAL (un-namespaced) tool name. */
  async callTool(name: string, args: unknown): Promise<unknown> {
    const resp = await this.rpc(
      {
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name, ...(args !== undefined ? { arguments: args } : {}) },
      },
      this.sessionHeaders(),
    );
    return resp.payload.result;
  }

  /** Best-effort session close (DELETE). Never throws. */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetchWithEgress(this.fetchImpl, this.url(), {
        method: "DELETE",
        headers: this.sessionHeaders(),
      }, this.egress);
    } catch {
      // best effort
    } finally {
      this.sessionId = undefined;
    }
  }
}

/**
 * Decode the first SSE frame whose JSON-RPC id matches (or the first frame
 * with an id at all). Streamable-HTTP POST responses are single messages.
 */
function decodeSseFrame(text: string, wantId: unknown): JsonRpcResponse {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as JsonRpcResponse;
      if (parsed?.id !== undefined && parsed.id !== null) {
        if (wantId === undefined || wantId === null || parsed.id === wantId) return parsed;
      }
    } catch {
      // skip malformed frames
    }
  }
  throw new McpUpstreamError("upstream SSE stream carried no JSON-RPC response");
}
