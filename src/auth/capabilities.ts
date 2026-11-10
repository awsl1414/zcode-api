/**
 * What a stored credential can actually do, in one table.
 *
 * Each upstream surface authenticates differently, and the difference is easy
 * to get wrong at every call site (it used to be five separate checks):
 *
 *   /v1/* coding-plan   x-api-key and Authorization: Bearer {apiKey}.{secret}
 *   /v1/* start-plan    Authorization: Bearer {plan JWT} to zcode.z.ai
 *   /mcp                coding-plan only: Bearer {jwt} plus
 *                       X-Bigmodel-Authorization: Bearer {apiKey}.{secret}
 *   /async/*            Bearer {jwt} plus x-coding-plan-api-key
 *   /quota, claim       Bearer {jwt}
 *   highspeed draws     coding-plan only: Bearer {jwt} plus the apiKey pair
 *
 * So a credential imported as a JWT-only account (`auth import --jwt`) serves
 * start-plan, /quota and claim. MCP, async and highspeed need the apiKey pair
 * as well, and MCP and highspeed only run on coding-plan.
 *
 * Keeping the requirements in one table means one gate and one message per
 * surface. Without it, each entry point discovers the missing half as an
 * upstream 401 or a JSON-RPC 3101, which tells the user nothing.
 *
 * **Routing**: there is no global "is the process on the coding-plan tier?"
 * flag. Every request resolves an `(account, route)` pair through
 * `accounts/broker.ts`, so the gate asks whether **the route this request
 * resolved to** is the one the surface runs on. `quota` / `claim` / `async`
 * carry no route requirement — they are credential-shaped, not route-shaped.
 * (`async` talks to the off-peak ticket backend but deliberately runs on the
 * route the account resolved to; see `async/handler.ts::resolveCredential`.)
 */
import type { RouteKind } from "../accounts/types.js";
import type { Credential } from "./types.js";
import { hasCodingPlanKey } from "./types.js";

/** Anything that authenticates against the upstream on the user's behalf. */
export type Surface =
  | "coding-plan"
  | "start-plan"
  | "mcp"
  | "async"
  | "quota"
  | "claim"
  | "highspeed";

interface SurfaceRequirement {
  /** Name used in messages. */
  label: string;
  /** Needs the `{apiKey}.{secret}` pair. */
  apiKey: boolean;
  /** Needs the plan JWT. */
  jwt: boolean;
  /**
   * The route this surface runs on. Absent = any resolved route is acceptable
   * (the surface only cares about the credential halves).
   */
  route?: RouteKind;
}

const SURFACES: Record<Surface, SurfaceRequirement> = {
  "coding-plan": { label: "coding-plan", apiKey: true, jwt: false, route: "coding-plan" },
  "start-plan": { label: "start-plan", apiKey: false, jwt: true, route: "start-plan" },
  mcp: { label: "/mcp", apiKey: true, jwt: true, route: "coding-plan" },
  async: { label: "/async", apiKey: true, jwt: true },
  quota: { label: "/quota", apiKey: false, jwt: true },
  claim: { label: "claim", apiKey: false, jwt: true },
  highspeed: { label: "highspeed", apiKey: true, jwt: true, route: "coding-plan" },
};

const NOT_LOGGED_IN_MESSAGE =
  "Not logged in. Run `zcode-proxy auth login <zai|bigmodel>`, or `zcode-proxy auth import`.";
const MISSING_KEY_HINT = "Import the ZCode credential file (`zcode-proxy auth import`) or log in again.";
const MISSING_JWT_HINT = "Run `zcode-proxy auth login`, or import the ZCode credential file with `zcode-proxy auth import`.";

export type SurfaceCheck = { ok: true } | { ok: false; message: string };

/** Credential-only half of the check (no route involvement). */
function checkCredential(surface: Surface, cred: Credential | null): SurfaceCheck {
  if (!cred) return { ok: false, message: NOT_LOGGED_IN_MESSAGE };

  const requirement = SURFACES[surface];
  if (requirement.apiKey && !hasCodingPlanKey(cred)) {
    return {
      ok: false,
      message: `${requirement.label} needs the coding-plan API key, but the stored credential only holds a plan JWT. ${MISSING_KEY_HINT}`,
    };
  }
  if (requirement.jwt && !cred.jwt) {
    return {
      ok: false,
      message: `${requirement.label} needs the plan JWT, but the stored credential has none. ${MISSING_JWT_HINT}`,
    };
  }
  return { ok: true };
}

/**
 * Gate one surface on the credential that is actually stored **and on the route
 * this request resolved to**.
 *
 * `route` comes from `broker.acquire()` (`lease.route`); there is no global
 * plan config to consult. A route-bound surface asked to run on a
 * different route fails here, with the route named — the same "say which half is
 * missing" discipline the credential checks follow.
 */
export function checkSurface(surface: Surface, cred: Credential | null, route: RouteKind): SurfaceCheck {
  const requirement = SURFACES[surface];
  if (requirement.route && requirement.route !== route) {
    return {
      ok: false,
      message: `${requirement.label} runs on route "${requirement.route}", but this request resolved route "${route}".`,
    };
  }
  return checkCredential(surface, cred);
}

/**
 * Surfaces usable right now for one account: `auth status`, the web panel and
 * the import report ask "what can this account do", which needs the account's
 * route whitelist rather than a single resolved route.
 */
export function usableSurfaces(cred: Credential | null, routes: readonly RouteKind[]): Surface[] {
  return (Object.keys(SURFACES) as Surface[]).filter((surface) => {
    const required = SURFACES[surface].route;
    if (required !== undefined && !routes.includes(required)) return false;
    return checkCredential(surface, cred).ok;
  });
}

/** Display summary of the stored credential itself, independent of routes. */
export interface CredentialCapabilities {
  /** The apiKey pair is present, so coding-plan traffic can authenticate. */
  codingPlan: boolean;
  /** The plan JWT is present. */
  startPlan: boolean;
}

/**
 * 路由 → LLM 能力面。由路由表派生，而不是在请求链路里写 if。
 *
 * `off-peak` / `highspeed` 是派生路由，鉴权用母体的 apiKey 对，所以归 `coding-plan` 面。
 */
const LLM_SURFACE_BY_ROUTE: Record<RouteKind, Surface> = {
  "coding-plan": "coding-plan",
  "start-plan": "start-plan",
  "off-peak": "coding-plan",
  "highspeed": "coding-plan",
};

/**
 * LLM surface for a route this request resolved to.
 *
 * 请求链路（`proxy/handler.ts` / `proxy/responses-handler.ts`）拿到的不是"用户选了哪个
 * 套餐"，而是 `broker.acquire()` 解析出的 `(account, route)` —— 所以"该用哪条能力要求
 * 去闸"必须从路由推出来，而不是读全局套餐配置。
 */
export function llmSurfaceFor(route: RouteKind): Surface {
  return LLM_SURFACE_BY_ROUTE[route];
}

export function credentialCapabilities(cred: Credential | null): CredentialCapabilities {
  return {
    codingPlan: cred !== null && hasCodingPlanKey(cred),
    startPlan: Boolean(cred?.jwt),
  };
}
