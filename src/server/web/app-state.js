/*
 * app-state.js — 跨模块共享的可变状态，全页只有这一处。
 *
 * 拆成多个文件之后，每个模块自己持有的状态（日志缓冲、设置快照、删除目标…）留在
 * 那个模块内部；只有两样东西是多个模块都要读写的，所以单列在这里：
 *
 *   lastState   最近一次 `/api/state` 或 `state` 事件的载荷，视图渲染的唯一输入
 *   activeView  当前视图，决定横幅挂在哪一页、事件流是否该连着
 *
 * 鉴权凭据不在这里：控制面用会话 Cookie，页面读不到它，也就不必持有它。
 * 唯一的例外是 `username`，它来自 `GET /api/session`，只用于设置页显示当前登录的人。
 *
 * 引用方式：`App.state.lastState`，不要先取出来存成局部变量再反复用，那样会拿到
 * 一份过期快照。其余模块内部状态不要搬进来，否则这个文件会重新长成一个全局背包。
 *
 * `App.views` 注册表也在这里建：视图文件各自往里挂自己的入口（`App.views.logs`
 * 等等），由 `app.js` 的 `renderState` 统一调用。先建空对象，后面每个文件只管填。
 */
(function (App) {
  "use strict";

  App.state = {
    username: "",
    lastState: null,
    activeView: App.const.VIEW_OVERVIEW,
  };

  App.views = {};
})(window.__zcodeApp = window.__zcodeApp || {});
