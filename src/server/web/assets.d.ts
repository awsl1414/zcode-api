/**
 * 非 TS 资源的模块声明（Bun 的 text / json loader）。
 *
 * `@types/bun` 已经声明了 `*.txt`（string）和 `*.html`（`HTMLBundle`，Bun 的默认
 * html loader）。这里补上本目录真正用到的两种：
 *
 *   - `*.css`：样式表，`with { type: "text" }` 取原始文本；
 *   - `*.js` ：浏览器运行时脚本，同样取原始文本（它不参与 Node 侧的模块图，
 *              只被拼进页面）。
 *
 * 通配符只在「正常解析失败」时生效，所以 `import … from "./panel.js"` 这种指向真实
 * `.ts` 文件的写法不受影响（TS 先按 `.js` → `.ts` 解析）。
 */
declare module "*.css" {
  const content: string;
  export default content;
}

declare module "*.js" {
  const content: string;
  export default content;
}
