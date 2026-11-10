/**
 * Solver backend dispatch.
 *
 * 只有一个后端：`captcha-happy.ts` 的 happy-dom 求解器。执行位置（每次求解一个
 * worker thread，配置了常驻预热池就用池，没有 entry 时进程内回退 —— issue #54）
 * 在 captcha-worker-dispatch.ts 里决定。
 *
 * 没有后端选择开关：除 `happy` 之外的后端都实现不全，暴露开关只会让配置把一个
 * 能跑的部署改坏。
 */
import { solveViaWorkerOrInProcess, stopCaptchaWorkers } from "./captcha-worker-dispatch.js";

export async function runCaptchaSolve(scene: string, region: string, prefix: string): Promise<string> {
  return solveViaWorkerOrInProcess({ scene, region, prefix });
}

/** Worker-per-solve needs no concurrency plumbing — kept for the pool API. */
export function setCaptchaSolverConcurrency(_n: number): void {}

/** Worker-per-solve terminates itself; the persistent warm pool
 *  (`ZCODE_CAPTCHA_WARM_WORKERS`) is terminated here. 由 `stopCaptchaPool` /
 *  shutdownCaptcha 链调用。*/
export function shutdownCaptchaSolver(): void {
  stopCaptchaWorkers();
}

export function captchaSolverConcurrency(): number {
  return 4;
}
