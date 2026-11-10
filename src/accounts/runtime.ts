import type { Credential } from "../auth/types.js";
import type { ProxyConfig } from "../config/types.js";
import { captchaPoolAccountIds, stopCaptchaPoolFor } from "../captcha/captcha-pool.js";
import { bindHighspeedSlots } from "../highspeed/slots.js";
import { collectQuotaSnapshot } from "../server/routes-quota.js";
import { Broker } from "./broker.js";
import { brokerOptionsFromConfig, type BrokerOptions } from "./broker-options.js";
import { accountDeviceMid } from "./device-mid.js";
import { AccountManager, toAuthCredential } from "./manager.js";
import { readPolicyOverrides, type PersistedPolicy } from "./policy-store.js";
import type { Account } from "./types.js";
import type { QuotaSampler } from "./quota.js";
import { logger } from "../log/index.js";

/** 账号子系统的运行时装配日志（健康状态变化事件也落在这一路）。*/
const log = logger("accounts");

/**
 * 打开账号仓。
 *
 * 账号只从 `accounts.json` 加载，启动即空账号。凭据由 `auth import`
 * 或 OAuth 登录写入；进程不读取其它凭据文件。
 */
export async function openAccountStore(): Promise<AccountManager> {
  const accounts = new AccountManager();
  // 账号删除 / 禁用后，它的 highspeed 卡槽（抽卡循环）立刻停。挂在账号仓的写后
  // 回调上，调用方不需要自己记着去停（见 highspeed/slots.ts）。
  bindHighspeedSlots(accounts);
  // 同一条接线的另一份：captcha 池按账号分，账号删除 / 禁用后
  // 停掉它的补池循环。
  bindCaptchaPools(accounts);
  return accounts;
}

/**
 * 账号级 captcha 池的生命周期接线：账号删除 / 禁用后停掉它的 captcha 池。
 *
 * 硬约束要求签名状态、PoW 状态、captcha 池按账号隔离，所以池天然是账号级的；
 * 接法同 `highspeed/slots.ts::bindHighspeedSlots`：账号启用状态只有账号仓知道，
 * 依附在账号上的后台循环必须跟着停，否则被删账号的补池循环还会按
 * `deepIdleAfterMs` 再烧一刻钟的求解 CPU 与阿里云配额。
 *
 * 池是懒创建的，所以只对账「已存在的池」：账号重新启用后，下一个要 token 的请求
 * 会自己把池建回来。回调只在写成功之后触发，读失败不会误停定时器。
 */
export function bindCaptchaPools(accounts: AccountManager): void {
  accounts.onChange((list) => {
    const alive = new Set(list.filter((account) => account.enabled).map((account) => account.id));
    for (const accountId of captchaPoolAccountIds()) {
      if (!alive.has(accountId)) stopCaptchaPoolFor(accountId);
    }
  });
}

/**
 * 持久化策略覆盖：三层里的第一层（最优先），只读 `policy.json`。
 *
 * 单独一个名字而不是让 `createBroker` 直接调 `policy-store`：两者的区别在 `config`
 * 缺失时才显出来。混在一起看，「`config` 缺失就跳过整块读文件」显得合理，而那份
 * 文件存的不是配置，是用户显式改过的值，比 config.yaml 更优先。
 *
 * 读文件失败一律返回空对象（见 `policy-store.ts`）：策略不是启动的硬依赖。
 */
export function readPersistedPolicy(): Promise<PersistedPolicy> {
  return readPolicyOverrides();
}

/**
 * 建 broker 的唯一入口：三层策略按优先级合出最终值。
 *
 * ```
 * 持久化覆盖（policy.json） > config.yaml 的 accounts 段 > 内置默认值
 * ```
 *
 * 每一层各自回答自己的事：`brokerOptionsFromConfig` 只管配置（缺 `config` 就回
 * 内置默认值），`readPersistedPolicy` 只管 sidecar。`config` 为 `null` 只让中间那层空，
 * 最上面那层照读：`cli/control.ts` 在没有 config.yaml 时传的是 `null`，用户在那里
 * 改过的策略不该因为删了配置文件就看不见（这正是把两层混读时踩过的根因）。
 *
 * 账号级覆盖（`entries`）是另一条路，因为它是按 label 一条条写进覆盖表的，得等
 * broker 造好才能灌。
 *
 * 两条入口（`serve` / 一次性 CLI）都走这里：只接其中一个的话，用户改完
 * 换个入口就看不到自己刚改的值，而且 `resetAccountOverrides` 在 CLI 里会变成空操作。
 *
 * `options` 最后展开，是给用例的注入点（路由顺序、队列尺度、entries）；生产调用方
 * 不传。它必须在持久化覆盖之后，否则用例注入的值会被 sidecar 盖掉。
 */
export function createBroker(
  accounts: AccountManager,
  config?: ProxyConfig | null,
  options: BrokerOptions = {},
): Promise<Broker> {
  return buildBroker(accounts, config, options);
}

/**
 * 生产装配的**唯一入口**：先造 broker，再把账号仓的凭据刷新观察口接到它
 * 上面（auth-invalid 的人工恢复靠这条线）。`createBroker` 本身保持纯装配
 * （大量测试直接调它），不偷偷改账号仓。
 */
export async function createProductionBroker(
  accounts: AccountManager,
  config?: ProxyConfig | null,
  options: BrokerOptions = {},
): Promise<Broker> {
  const broker = await buildBroker(accounts, config, options);
  accounts.onCredentialRefreshed((account) => broker.resetAuthInvalid(account));
  return broker;
}

/** 建 broker 的实现（三层策略合并 + 健康状态变化写入日志）。*/
async function buildBroker(
  accounts: AccountManager,
  config?: ProxyConfig | null,
  options: BrokerOptions = {},
): Promise<Broker> {
  const fromConfig = brokerOptionsFromConfig(config?.accounts);
  const persisted = await readPersistedPolicy();
  const broker = new Broker(accounts, {
    ...fromConfig,
    routing: { ...fromConfig.routing, ...persisted.routing },
    stickiness: { ...fromConfig.stickiness, ...persisted.stickiness },
    risk: { ...fromConfig.risk, ...persisted.risk },
    ...options,
  });
  if (persisted.entries) broker.applyPersistedOverrides(persisted.entries);
  // 观测事件落日志（状态变化全部落事件）：进/出冷却、drained、
  // auth-invalid、breaker 开关、probe 结果全部落 LogBuffer（logger 的缓冲即面板
  // 「系统」tab / getLogs 读的那份——usage-stats 的「调度事件」维度读的是请求
  // 记录 stages，状态变化事件不是请求级事实，落点选 LogBuffer 一侧）。
  // 接线放生产装配点而不是 Broker 构造器：测试直接 new Broker 不会被日志淹没。
  broker.health.onTransition((event) => {
    log.info("health transition", {
      type: event.type,
      account: event.accountId,
      route: event.route,
      reason: event.reason,
      until: event.until,
      at: event.at,
      ...(event.from !== undefined ? { from: event.from } : {}),
      ...(event.to !== undefined ? { to: event.to } : {}),
      ...(event.detail !== undefined ? { detail: event.detail } : {}),
      ...(event.ok !== undefined ? { ok: event.ok } : {}),
    });
  });
  return broker;
}

/**
 * 取**调度器为本命令选出的那个账号**的额度快照（`/quota` 与 `quota` 子命令共用）。
 *
 * 5.0 没有「当前账号」这个概念（出线账号由调度器按请求决定），所以这里不叫「当前
 * 账号的额度」——它只是 `broker.acquire({})` 这一次选中谁就给谁的快照。
 *
 * 注意与控制面 `quota` 命令（走同一个函数）的区别：CLI 的
 * `zcode-proxy quota` 另有口径（`cli/claim.ts`：账号表里第一个 enabled 的账号，
 * 这是明示决定），两条路可能给出不同账号的数字。
 *
 * 额度是账号级的，凭据必须先经 broker 解析，所以这里包一层而不是让
 * `collectQuotaSnapshot` 自己去读存储。
 */
export async function quotaSnapshot(config: ProxyConfig, broker: Broker) {
  const acquired = await broker.acquire({});
  try {
    return await collectQuotaSnapshot(
      config,
      toAuthCredentialOf(acquired.credential),
      accountDeviceMid(acquired.account) ?? "",
    );
  } finally {
    acquired.release();
  }
}

/**
 * 控制面「立即刷新」一个账号（详情卡的刷新按钮走这里）。
 *
 * 走采样器的 `sampleNow`：与启动探测、即时复采、分级采同一条归一路径、同一个
 * 30s 去重（一个机制两处用）。去重命中时不报错：面板随后回读 `/api/state`，
 * 拿到的是刚刚那次采样的结果，用户看到的数据仍然是最新的。
 */
export async function refreshAccountQuota(sampler: QuotaSampler, accounts: AccountManager, label: string): Promise<void> {
  const account = await accounts.getByLabel(label);
  if (!account) throw new Error(`unknown account: ${label}`);
  await sampler.sampleNow(account.id, "detail-refresh");
}

/** 租约里的 v2 凭据 → 出线层用的 `auth/types.ts` 凭据形状。*/
function toAuthCredentialOf(credential: Account["credential"]): Credential {
  return toAuthCredential(credential);
}
