/**
 * 账号的设备指纹（`X-Device-Mid`，风控硬约束）。
 *
 * deviceMid 属于账号，进程级没有这个值：官方客户端的 deviceMid 是本地随机生成的
 * UUIDv4，装机时定一次，服务端不签发
 * （`apps/zcode-cli/packages/adapters/src/device/cli-device-mid.ts`），所以
 * 「每个账号 = 一台虚拟设备」。建号时生成，此后永不改变。
 *
 * 为什么要有这个函数：所有消费点（额度、领取、加速卡、桥接、控制面）都问同一个
 * 问题，所以答案只写一次。凭据只有一种形态，`credential.identity` 处处可读，
 * 所以这里不再需要按 kind 判别。
 */
import type { Account } from "./types.js";

export function accountDeviceMid(account: Account): string {
  return account.credential.identity.deviceMid;
}
