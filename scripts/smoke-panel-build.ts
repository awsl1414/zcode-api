/**
 * smoke-panel-build.ts — CI 面板产物冒烟：把 page.ts 的两个拼装函数真的跑一遍。
 *
 * 面板是「零构建链」的三层内联结构（见 src/server/web/page.ts 文件头），唯一的
 * 构建步骤就是服务端拼装：骨架占位符换成 CSS / 字典 / 脚本原文。这一步没有独立
 * 的构建产物可检查，所以冒烟 = 调 `renderPanelPage()` / `renderLoginPage()`，
 * 断言占位符全部替换、两页都不留空槽、产物规模在合理区间。
 *
 * `bun test` 的 page.test.ts / runtime-*.test.ts 断言得更细（token 完整性、无外链、
 * i18n 键覆盖…），但它们跟着测试文件走；这个脚本让 CI 有一个**独立于测试改动的
 * 面板构建门禁**——本地把 page.html 拼错、page.ts 改坏时，`bun run scripts/smoke-panel-build.ts`
 * 在任何机器上一条命令复现。
 *
 * 用法：bun run scripts/smoke-panel-build.ts（ci.yml panel-build job 调它）
 */
import {
  renderLoginPage,
  renderPanelPage,
  PAGE_APP_SCRIPT,
  PAGE_COMPONENTS_CSS,
  PAGE_TOKENS_CSS,
} from "../src/server/web/page.ts";

/** page.html 的五个占位符与 login.html 的最后一个（与 page.ts 的常量对应）。 */
const SLOTS = [
  "<!-- THEME-BOOT -->",
  "<!-- TOKENS -->",
  "<!-- COMPONENTS -->",
  "/* I18N */",
  "/* APP */",
  "/* LOGIN */",
] as const;

/** 最小规模下限：骨架 + 全部内联资源的量级。远小于它说明拼装丢了东西。 */
const MIN_PANEL_BYTES = 100_000;
const MIN_LOGIN_BYTES = 30_000;

function assert(name: string, ok: boolean, detail: string): void {
  if (!ok) {
    console.error(`FAIL ${name}: ${detail}`);
    process.exit(1);
  }
  console.log(`ok   ${name} (${detail})`);
}

const panel = renderPanelPage();
const login = renderLoginPage();

assert("panel renders", panel.startsWith("<!doctype html"), `head: ${panel.slice(0, 40)}`);
assert("login renders", login.startsWith("<!doctype html"), `head: ${login.slice(0, 40)}`);

for (const slot of SLOTS) {
  // 每个占位符要么不该出现在这页（login 页没有 APP 槽），要么必须已被替换。
  if (panel.includes(slot)) {
    console.error(`FAIL panel left slot unfilled: ${slot}`);
    process.exit(1);
  }
  if (login.includes(slot)) {
    console.error(`FAIL login left slot unfilled: ${slot}`);
    process.exit(1);
  }
}
console.log("ok   all slots filled (no placeholder survives in either page)");

assert(
  "inline assets present",
  panel.includes(PAGE_TOKENS_CSS.slice(0, 200)) &&
    panel.includes(PAGE_COMPONENTS_CSS.slice(0, 200)) &&
    panel.includes(PAGE_APP_SCRIPT.slice(0, 200)),
  "tokens.css + 拼接的组件样式 + app script",
);

assert("panel size sane", panel.length >= MIN_PANEL_BYTES, `${panel.length} bytes`);
assert("login size sane", login.length >= MIN_LOGIN_BYTES, `${login.length} bytes`);

console.log(`panel build smoke passed: panel=${panel.length}B login=${login.length}B`);
