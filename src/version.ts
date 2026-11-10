/**
 * 发布版本：`package.json` 的 `version` 是唯一真源。
 *
 * 这里曾经是一份手写常量，与 `package.json` 各存一份，靠 `release.yml` 的两条
 * `sed` 同步。两处都是手写值，平时没人跑发版脚本，于是改了一处忘了另一处就会
 * 分裂，而且分裂不报错：面板读 `package.json`、CLI 与更新检查读这份常量，两边
 * 各显示各的。
 *
 * 改为派生之后这种状态不可能出现：npm 元数据与发布产物的对外身份是同一个值，
 * 这里只是把它读出来。`package.json` 由 Bun 在打包时静态内联（`bun build
 * --compile` 已验证），单文件产物不依赖运行时读盘。
 */
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
