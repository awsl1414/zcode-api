/**
 * 运行时策略的持久化。
 *
 * 为什么单独一个文件，而不是写回 `config.yaml`：
 *
 * `config/edit.ts` 不再有 `updateConfigYaml`：运行时账号编辑走账号仓，不写回
 * config.yaml。那条理由对账号成立，对**策略**不成立。
 * `accounts.routing` / `stickiness` / `risk` 本身就住在 config.yaml 里，没有别的仓。
 * 于是只剩两条路：做 `accounts:` 段的 YAML 定向改写，或者落到一个 sidecar。
 *
 * 选 sidecar 的原因是可预测：YAML 定向改写要处理嵌套块、注释、缩进和用户手写的
 * 等价写法（行内 flow、引号、锚点），任何一处没覆盖都会把用户的配置文件改坏；
 * 而 sidecar 是一份我们完全掌控的 JSON，坏了删掉就回到 config.yaml 的基线。
 *
 * 语义严格分层：
 *
 *   持久化覆盖  >  config.yaml  >  内置默认值
 *
 * 也就是说 sidecar 只存「用户显式改过的字段」，没改过的字段永远跟着 config.yaml 走。
 * 用户在 YAML 里调了默认值，不会被一份陈旧的 sidecar 悄悄盖掉。
 *
 * 两段内容共用一个文件：全局策略（`routing` / `stickiness` / `risk`）与账号级覆盖
 * （`entries`，键是 label）。账号级覆盖同样只记「运行时改过的字段」，不存整份生效值。
 * 生效值是从 `config.yaml` 的 `accounts.entries[]` 继承来的，落一份整的快照会让
 * 「配置改了、sidecar 还是旧值」变成永久状态。
 *
 * 读写走 `storage/store.ts` 的同一个 `JsonStore`，但开了 `plaintext`：这里存的是
 * 策略，没有凭据，而「删掉坏文件就回到 config.yaml 基线」这条恢复路径只有在文件
 * 可读时才对用户成立。文件形状是一份裸的
 * `{routing, stickiness, risk, entries}`，不包 `{version, payload}`：没有格式版本
 * 可判，磁盘上的旧文件原样读，写一次之后形状也不变。
 */
import { jsonStore } from "../storage/index.js";
import type { JsonStore } from "../storage/index.js";
import type { AccountsRouting, AccountsStickiness } from "./routing.js";
import type { RuntimeOverride } from "./types.js";

const POLICY_FILE_NAME = "policy.json";

/** 账号级覆盖：键是 label，值是显式改过的字段（同一账号多次改动逐字段合并）。*/
export type PersistedAccountOverrides = Record<string, RuntimeOverride>;

/** 全局策略只存用户改过的字段，所以每段都是 Partial。*/
export interface PersistedPolicy {
  routing?: Partial<AccountsRouting>;
  stickiness?: Partial<AccountsStickiness>;
  risk?: { jitterHeartbeat?: boolean };
  /** 账号级覆盖，键是 label（与 `X-ZCode-Account` 同口径）。*/
  entries?: PersistedAccountOverrides;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 一条账号级覆盖的取值域校验，与 `AccountOverrides.validate` 同一套规则。
 *
 * 重复一份而不是直接调它：那边收到非法值要抛错（命令面必须报错），这里读的是一份
 * 可能被手改过的文件，坏字段应当被丢掉而不是让启动失败。
 */
function pickOverride(raw: unknown): RuntimeOverride | null {
  if (!isPlainObject(raw)) return null;
  const out: RuntimeOverride = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.maxConcurrency === "number" && Number.isInteger(raw.maxConcurrency) && raw.maxConcurrency >= 0) {
    out.maxConcurrency = raw.maxConcurrency;
  }
  if (typeof raw.weight === "number" && Number.isInteger(raw.weight) && raw.weight >= 1) {
    out.weight = raw.weight;
  }
  if (typeof raw.expiresAt === "number" && Number.isFinite(raw.expiresAt)) out.expiresAt = raw.expiresAt;
  // 代理引用：只接受非空字符串。名字是否真的存在于 `accounts.proxies`
  // 由 broker 在启动时按当时的代理表校验，这里不做（读一份可能被手改过的文件，
  // 坏引用应当被报出来而不是让整个 sidecar 读废）。
  if (typeof raw.proxy === "string" && raw.proxy.trim() !== "") out.proxy = raw.proxy.trim();
  return Object.keys(out).length > 0 ? out : null;
}

/** 账号级覆盖整段：label 为空或值全不合法的那一条直接丢。*/
function pickEntries(raw: unknown): PersistedAccountOverrides | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: PersistedAccountOverrides = {};
  for (const [label, value] of Object.entries(raw)) {
    if (label.trim().length === 0) continue;
    const override = pickOverride(value);
    if (override) out[label] = override;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 只挑已知字段，别把文件里的杂项带进运行时。字段校验交给 control 层。*/
function pickKnown(raw: unknown): PersistedPolicy | null {
  if (!isPlainObject(raw)) return null;
  const out: PersistedPolicy = {};
  if (isPlainObject(raw.routing)) out.routing = raw.routing as Partial<AccountsRouting>;
  if (isPlainObject(raw.stickiness)) out.stickiness = raw.stickiness as Partial<AccountsStickiness>;
  if (isPlainObject(raw.risk)) {
    const jitter = raw.risk.jitterHeartbeat;
    if (typeof jitter === "boolean") out.risk = { jitterHeartbeat: jitter };
  }
  const entries = pickEntries(raw.entries);
  if (entries) out.entries = entries;
  return out;
}

const store: JsonStore<PersistedPolicy> = jsonStore<PersistedPolicy>({
  fileName: POLICY_FILE_NAME,
  plaintext: true,
  fallback: () => ({}),
  revive: pickKnown,
});

/**
 * 读持久化的策略覆盖。
 *
 * 文件不存在、读不了、JSON 坏了，一律返回空对象：策略不是启动的硬依赖，
 * 一份坏文件不该让代理起不来（与账号仓对损坏凭据的处理一致）。
 */
export function readPolicyOverrides(): Promise<PersistedPolicy> {
  return store.load();
}

/**
 * 把一段补丁合并进持久化覆盖并落盘。
 *
 * 合并而不是覆盖：用户先改 `order`、再改 `strategy`，两次补丁都要留住。
 * 明确传 `undefined` 的字段视为「不改」，只有给了值才写，与
 * `applyRoutingPolicy` 的逐字段语义一致。
 *
 * 读改写三步是完整的：`save` 写完才返回，所以命令面回 `ok` 时文件已经落地。
 */
export async function mergePolicyOverrides(patch: PersistedPolicy): Promise<PersistedPolicy> {
  const current = await readPolicyOverrides();
  const next: PersistedPolicy = {
    ...(current.routing || patch.routing
      ? { routing: { ...current.routing, ...patch.routing } }
      : {}),
    ...(current.stickiness || patch.stickiness
      ? { stickiness: { ...current.stickiness, ...patch.stickiness } }
      : {}),
    ...(current.risk || patch.risk ? { risk: { ...current.risk, ...patch.risk } } : {}),
    // 账号级覆盖按 label 逐条合并：改 a 的并发不能把 b 的记录带走。
    ...(current.entries || patch.entries
      ? { entries: mergeEntries(current.entries, patch.entries) }
      : {}),
  };
  await writePolicyOverrides(next);
  return next;
}

/** 两份账号级覆盖按 label 合并，同一个 label 内部再逐字段合并。*/
function mergeEntries(
  current: PersistedAccountOverrides | undefined,
  patch: PersistedAccountOverrides | undefined,
): PersistedAccountOverrides {
  const out: PersistedAccountOverrides = {};
  for (const [label, override] of Object.entries({ ...current, ...patch })) {
    out[label] = { ...current?.[label], ...override };
  }
  return out;
}

/**
 * 把一条账号级覆盖合并进持久化文件。
 *
 * 只写本次显式改过的字段，所以「先调并发、再调权重」两次调用都会留住。键用 label：
 * 它既是 `X-ZCode-Account` 的口径，也是 `config.yaml` 的 `accounts.entries[]` 的
 * 引用键，重启后按 label 灌回内存不需要额外的 id 映射。
 */
export async function persistAccountOverride(label: string, patch: RuntimeOverride): Promise<PersistedPolicy> {
  const current = await readPolicyOverrides();
  const entries: PersistedAccountOverrides = { ...current.entries };
  entries[label] = { ...entries[label], ...patch };
  const next: PersistedPolicy = { ...current, entries };
  await writePolicyOverrides(next);
  return next;
}

/**
 * 删掉某个 label 的账号级覆盖（`resetAccountOverrides` 与账号删除用）。
 *
 * 删空的 `entries` 整段去掉，文件里不留 `entries: {}` 这种空壳。
 * 这个 label 本来就没有覆盖时不写文件：删除是幂等的，没东西可删就不该留下一次
 * 无意义的写盘（也会把「清一个不存在的 label」变成一次多余的格式规范化）。
 */
export async function clearPersistedOverride(label: string): Promise<PersistedPolicy> {
  const current = await readPolicyOverrides();
  if (!current.entries || !(label in current.entries)) return current;
  const rest: PersistedAccountOverrides = { ...current.entries };
  delete rest[label];
  const next: PersistedPolicy = { ...current };
  if (Object.keys(rest).length > 0) next.entries = rest;
  else delete next.entries;
  await writePolicyOverrides(next);
  return next;
}

/** 写策略覆盖（原子写，见 `storage/store.ts`）。*/
export function writePolicyOverrides(policy: PersistedPolicy): Promise<void> {
  return store.save(policy);
}
