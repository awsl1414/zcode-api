/**
 * `startServer` option assembly shared by every entry that boots the proxy
 * in-process (serve).
 */
import type { ProxyConfig } from "../config/types.js";
import type { Broker } from "../accounts/broker.js";
import type { AccountManager } from "../accounts/manager.js";
import { ResponseStore } from "../responses/store.js";
import { getDefaultRequestStore } from "../proxy/request-record.js";
import type { RequestStore } from "../proxy/request-record.js";

/** 启动参数：出线口（broker）+ 账号仓（只有 async 闸门用）。*/
export interface ServerBoot {
  config: ProxyConfig;
  broker: Broker;
  accounts: AccountManager;
  debug: boolean;
  responseStore?: ResponseStore;
  /** 请求记录的持有者。与 `LogBuffer` 同寿命，见下。*/
  requests: RequestStore;
}

/**
 * Build `startServer` options, wiring the Responses store when its config gate is on.
 *
 * `requests` 缺省取进程级实例，与 `LogBuffer` 的生命周期一致：两者都是「进程里只
 * 有一份」的运行时存储，面板 / 控制面 / CLI 读的必须是代理正在写的那一份，否则重启
 * 代理（面板可以停掉再启动）之后页面看到的就是一份空仓库。测试与需要隔离的调用方
 * 自己传一个。
 */
export function buildServerOptions(
  config: ProxyConfig,
  broker: Broker,
  accounts: AccountManager,
  debug: boolean,
  requests: RequestStore = getDefaultRequestStore(),
): ServerBoot {
  const opts: ServerBoot = { config, broker, accounts, debug, requests };
  // /v1/responses 是常开协议：三条入站协议都不挂开关，store 跟着进程走。
  opts.responseStore = new ResponseStore({ maxEntries: config.responses.storeMaxEntries, ttlMs: config.responses.storeTtlMs });
  return opts;
}
