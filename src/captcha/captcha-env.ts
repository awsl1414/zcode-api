/**
 * 保留的三个 captcha 调参入口。
 *
 * 其余参数已经硬编码成常量。那些值是逆向时反复试出来的耦合参数，单独改一个只会让
 * 通过率掉下来，不构成用户配置面；需要改的人直接改代码，读得到上下文。
 *
 * 留下来的判据：调这个值会不会改变用户能感知的行为？
 * - 池上限与求解并发决定 CPU 占用（低核心数的机器要能压下来）；
 * - CPU 上限决定 captcha 求解会不会把宿主机抢死。
 * 其余全是内部节奏，不满足这一条。
 */
function rawNumber(name: string): number | null {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : null;
}

/** 正整数入口：非法值或 `0` 一律回落默认值（0 个 worker / 0 个池不会跑起来）。*/
export function captchaEnvPositiveInt(name: string, fallback: number): number {
  const raw = rawNumber(name);
  return raw !== null && raw >= 1 ? Math.floor(raw) : fallback;
}

/** 非负整数入口：`0` 有意义（例如 CPU 上限 0 = 关掉限流）。*/
export function captchaEnvNonNegativeInt(name: string, fallback: number): number {
  const raw = rawNumber(name);
  return raw !== null && raw >= 0 ? Math.floor(raw) : fallback;
}
