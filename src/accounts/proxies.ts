/**
 * 出口代理表（`accounts.proxies[]`）：命名、校验、生效值解析。
 *
 * 代理是**一张独立的表**，账号只引用名字。两个理由：
 *
 * 1. 同一代理会被多个账号用（公司只有一条出口就是这样）。写名字让「改一次 URL
 *    全部生效」，也让概览能按出口分组统计「这个出口上有几个账号」。
 * 2. 账号条目里写 URL 会让「这个账号直连」无法表达：不写等于继承默认代理，
 *    写了就等于绑死一个 IP。所以 {@link DIRECT_PROXY} 是一个显式值。
 *
 * 校验放在这里而不是请求链路上：代理配错的表现是「连接超时」，用户很难想到是代理，
 * 而**引用一个已停用的代理**更糟。静默降级成直连等于把真实 IP 泄出去，
 * 是本模块最危险的失败模式，所以四条规则全部在加载配置时抛错。
 */
import { PROXY_PROTOCOLS, proxyProtocol, type EgressOptions } from "../proxy/egress.js";

/** 显式直连的保留名字（与「不写」的区别见 {@link effectiveProxyName}）。*/
export const DIRECT_PROXY = "direct";

/** 代理默认启用（写 `enabled: false` 才是停用）。*/
export const DEFAULT_PROXY_ENABLED = true;

/**
 * `accounts.proxies[]` 的一条。
 *
 * `enabled` 缺省即启用：新增一条代理时用户想的是「加一条能用的」，不是「加一条
 * 待启用的」。停用是一个动作，所以要显式写 `false`。
 */
export interface ProxySpec {
  /** 唯一名，账号条目与 `risk.defaultProxy` 都用它引用。*/
  name: string;
  /** `http://` / `https://` / `socks5://` / `socks5h://` 开头。*/
  url: string;
  username?: string;
  password?: string;
  enabled?: boolean;
}

/**
 * 代理表的失败原因码。
 *
 * 靠码而不是靠匹配消息：控制面（`control/control.ts`）要把失败翻成 i18n 键，
 * 而按字符串前缀匹配错误消息的做法只要有人润色一句文案就断了。消息仍然保留，
 * 因为配置加载期的报错要先在启动日志里读得懂。
 */
export type ProxyErrorCode =
  | "empty-name"
  | "duplicate-name"
  | "reserved-name"
  | "unsupported-url"
  | "unknown-proxy"
  | "disabled-proxy"
  | "in-use";

/** 代理表的一条不合格事实（消息给日志，码给控制面）。*/
export class ProxyError extends Error {
  constructor(readonly code: ProxyErrorCode, message: string) {
    super(message);
    this.name = "ProxyError";
  }
}

/** 校验失败的错误信息前缀（配置加载期把它原样抛给启动日志，所以要说清是哪一条）。*/
function fail(code: ProxyErrorCode, message: string): never {
  throw new ProxyError(code, `accounts.proxies: ${message}`);
}

/** 名字 → 代理条目。找不到返回 `undefined`（调用方决定报错还是继承）。*/
export function findProxy(proxies: readonly ProxySpec[], name: string): ProxySpec | undefined {
  return proxies.find((proxy) => proxy.name === name);
}

/** 该条目是不是显式直连（`proxy: direct`）。*/
export function isDirectProxy(name: string | undefined): boolean {
  return name === DIRECT_PROXY;
}

/**
 * 逐条校验代理表与全部引用。
 *
 * 四类不合格全部抛错：
 * - `name` 空或重复（引用键必须可分辨）
 * - `url` 协议不在白名单（`PROXY_PROTOCOLS`）
 * - 引用了不存在的名字
 * - 引用了 `enabled: false` 的代理
 *
 * 第三条与第四条分开报错：前者是拼写问题，后者是「代理停用了但账号还指着它」，
 * 用户要做的事不同（改名 vs 启用）。
 */
export function validateProxies(
  proxies: readonly ProxySpec[],
  references: readonly { where: string; name: string | undefined }[],
): void {
  const seen = new Set<string>();
  for (const proxy of proxies) {
    if (proxy.name.trim() === "") fail("empty-name", "every proxy needs a non-empty name");
    // `direct` 是引用语法里的值（`proxy: direct`），一条同名的代理永远选不到它：
    // 存储、控制面、YAML 三处看起来都配好了，实际却是个死条目，所以在边界上拒。
    if (isDirectProxy(proxy.name)) {
      fail("reserved-name", `proxy name "${DIRECT_PROXY}" is reserved for explicit direct egress`);
    }
    if (seen.has(proxy.name)) fail("duplicate-name", `duplicate proxy name "${proxy.name}"`);
    seen.add(proxy.name);

    // 解析失败（如少了协议前缀 `127.0.0.1:1080`）与协议不认识归到同一条消息里：
    // 用户要做的都是「换成白名单里的前缀」，分成两种说法只是让报错更难对。
    let protocol: string;
    try {
      protocol = proxyProtocol(proxy.url);
    } catch {
      protocol = "";
    }
    if (!(PROXY_PROTOCOLS as readonly string[]).includes(protocol)) {
      fail(
        "unsupported-url",
        `proxy "${proxy.name}" has unsupported url "${proxy.url}"; expected one of: ${PROXY_PROTOCOLS.join(", ")}`,
      );
    }
  }

  for (const reference of references) {
    const name = reference.name;
    // 不写 = 继承（由优先级链决定），`direct` = 显式覆盖，两者都不需要在表里找。
    if (name === undefined || isDirectProxy(name)) continue;
    const target = findProxy(proxies, name);
    if (target === undefined) {
      fail("unknown-proxy", `${reference.where} references unknown proxy "${name}"`);
    }
    if ((target.enabled ?? DEFAULT_PROXY_ENABLED) === false) {
      fail(
        "disabled-proxy",
        `${reference.where} references disabled proxy "${name}"; enable it or point the reference elsewhere (falling back to direct would leak this machine's address)`,
      );
    }
  }
}

/**
 * 优先级链：`entries[].proxy` > `risk.defaultProxy` > 直连。
 *
 * 返回值里 `direct` 保留原样，不折成 `undefined`：调用方要能区分「显式直连」与
 * 「没写、继承默认」。折平这一步只发生在 {@link egressFor}。
 */
export function effectiveProxyName(
  entryProxy: string | undefined,
  defaultProxy: string | undefined,
): string | undefined {
  if (entryProxy !== undefined) return entryProxy;
  if (defaultProxy !== undefined) return defaultProxy;
  return undefined;
}

/**
 * 生效名字 → 出线参数。`undefined` / `direct` 都是直连。
 *
 * 这里**不再兜底**：名字在表里找不到就抛，因为走到这里说明配置校验被绕过了
 * （手改内存里的表、控制面写入了未校验的值），静默直连是那个最危险的失败模式。
 */
export function egressFor(proxies: readonly ProxySpec[], name: string | undefined): EgressOptions | undefined {
  if (name === undefined || isDirectProxy(name)) return undefined;
  const proxy = findProxy(proxies, name);
  if (proxy === undefined) fail("unknown-proxy", `unknown proxy "${name}"`);
  if ((proxy.enabled ?? DEFAULT_PROXY_ENABLED) === false) {
    fail(
      "disabled-proxy",
      `proxy "${name}" is disabled; refusing to fall back to direct (that would leak this machine's address)`,
    );
  }
  const options: EgressOptions = { proxyUrl: proxy.url };
  if (proxy.username !== undefined) options.username = proxy.username;
  if (proxy.password !== undefined) options.password = proxy.password;
  return options;
}

/**
 * 配置数据 → 出线参数（纯函数，不依赖 broker）。
 *
 * 长寿命子系统（`claim` / `async` / `mcp`）在创建时只有 `ProxyConfig` 与 `Account`，
 * 拿不到 broker（`policyFor` 是 private）。这个函数让它们用同一套优先级链算出生效
 * 代理，而不是各自抄一遍 `entries > default > 直连`。
 *
 * 限制：它读的是**创建时**的配置，所以运行时改代理（`setAccountProxy` /
 * `setProxy`）不会作用到已经建好的实例上，要重建实例才生效。请求链路不走这里，
 * 它用 `lease.egress`（每次发租约现算），所以推理请求的热改是立即的。
 */
export function resolveEgress(
  proxies: readonly ProxySpec[],
  entryProxy: string | undefined,
  defaultProxy: string | undefined,
): EgressOptions | undefined {
  return egressFor(proxies, effectiveProxyName(entryProxy, defaultProxy));
}

/**
 * 长寿命子系统的入口：从 `config.accounts` 的结构里取某 label 的生效代理。
 *
 * 参数用**结构类型**而不是 `AccountsConfig`：`config/types.ts` 已经 import 本模块的
 * `ProxySpec`，这里再反向 import 就成环。三个字段正好是优先级链需要的那三项。
 */
export function resolveEgressFor(
  accounts:
    | {
        proxies?: readonly ProxySpec[];
        entries: readonly { label: string; proxy?: string }[];
        risk: { defaultProxy?: string };
      }
    | undefined,
  label: string,
): EgressOptions | undefined {
  if (accounts === undefined) return undefined;
  const entryProxy = accounts.entries.find((entry) => entry.label === label)?.proxy;
  return resolveEgress(accounts.proxies ?? [], entryProxy, accounts.risk.defaultProxy);
}
