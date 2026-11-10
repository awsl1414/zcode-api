/*
 * theme-boot.js — 首屏防闪烁。
 *
 * 这段脚本必须**内联在 `<head>` 里、早于样式表**（服务端拼装时塞进 head 里那个首个 script 占位）。
 * 浏览器解析到这里就确定 `data-theme`，第一帧就落在正确的色板上；放到页面底部或
 * 主脚本里会先画一帧浅色再翻成深色，也就是「闪一下白底」。
 *
 * 它管两件首屏布局决策，理由是同一条：**这两个属性的值都会改变第一帧的几何**。
 *
 *   1. 把用户**手动选过**的主题写到 `<html data-theme>`。
 *      `system`（或没选过）时不写属性 —— 交给 tokens.css 里的
 *      `@media (prefers-color-scheme: dark)` 处理，这样系统主题实时变化时页面会跟着走，
 *      不需要 JS 监听。
 *
 *   2. 把侧边栏折叠态写到 `<html data-sidebar>`。侧边栏 232 ⇄ 56 是 176px
 *      的横向变化，主脚本要等到文档底部才跑：那一拍里页面已经按展开态画过一帧，
 *      刷新时能看到整片内容先右移再回弹。`app-sidebar.js` 在 `init()` 里会再写一次
 *      （同一个值的幂等写），负责「内联脚本没跑」的降级路径。
 *
 * `localStorage` 在隐私模式下会抛异常，catch 之后什么都不做：
 * 退回系统主题与展开态，页面照常工作。
 */
(function () {
  try {
    var theme = localStorage.getItem("theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
    }
    /* 键与取值与 `app-constants.js` 的 SIDEBAR_STORAGE_KEY / SIDEBAR_MODES 同源
       （这段先于所有模块执行，拿不到常量表，所以字面量在这里再写一次）。 */
    var sidebar = localStorage.getItem("zcode-sidebar");
    if (sidebar === "collapsed" || sidebar === "expanded") {
      document.documentElement.setAttribute("data-sidebar", sidebar);
    }
  } catch (error) {
    /* 隐私模式：没有 localStorage，跟随系统主题、侧边栏默认展开 */
  }
})();
