/**
 * 账号能力判定：只看账号级别，不管具体模型。
 *
 * 请求期问的是"**这次请求**能走哪条路由"（`accounts/broker.ts` + `(route, model)`
 * 能力矩阵）；控制面与启动日志问的是另一个问题："**有没有账号**能跑某个 surface"。
 * 后者没有请求上下文，只能扫账号仓，这就是本模块存在的原因。
 *
 * 为什么必须与请求期同源：async 闸门如果自己写一套"够不够格"的判断，
 * 面板/启动日志说"能跑"而请求期 400 只是时间问题。所以这里直接复用
 * `auth/capabilities.ts::checkSurface`，把每个启用账号用它白名单里的第一条路由送进
 * 同一个闸门。
 *
 * 这里只有 **surface 级**的判定：`(route, model)` 的能力矩阵在
 * `model-support.ts::routeSupportsModel`（请求期用，候选集过滤的第三层）。两者粒度不同，
 * 不要合并：控制面没有 model 上下文，请求期不需要扫账号仓。
 */
import type { AccountManager } from "./manager.js";
import { toAuthCredential } from "./manager.js";
import type { Account } from "./types.js";
import { checkSurface, type Surface } from "../auth/capabilities.js";

/**
 * 这个账号能不能跑某个 surface（只看凭据能力 + 自己的路由白名单）。
 *
 * 用 `routes[0]` 而不是遍历全部路由：`checkSurface` 的路由约束是"这条 surface 绑
 * 在哪条路由上"，而 `routes` 已按 `ROUTE_KINDS` 稳定排序（`manager.ts::normalizeRoutes`），
 * 第一条就是该账号的主路由。不绑路由的 surface（quota / claim / async）根本不看
 * 这个参数。
 */
export function accountSupportsSurface(account: Account, surface: Surface): boolean {
  const route = account.routes[0];
  if (!route) return false;
  return checkSurface(surface, toAuthCredential(account.credential), route).ok;
}

/** 是否存在**启用中**且能跑该 surface 的账号。*/
export async function hasCapableAccount(accounts: AccountManager, surface: Surface): Promise<boolean> {
  for (const account of await accounts.list()) {
    if (!account.enabled) continue;
    if (accountSupportsSurface(account, surface)) return true;
  }
  return false;
}
