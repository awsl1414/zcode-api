/*
 * app-dom.js — 浏览器原语：DOM 查询与创建、localStorage 安全读写。
 *
 * 这一层不认识 i18n、不认识状态，也不认识任何一页的语义：它只把「按 data-role
 * 找节点」「造一个带 class 的元素」这类重复动作收成一个词，让视图文件里剩下的都是
 * 业务判断。
 *
 * `localStorage` 的读写一律吞异常：隐私模式下 `getItem` / `setItem` 会抛，页面
 * 不该因为「这次选择存不下来」就白屏。
 */
(function (App) {
  "use strict";

  var ROLE_ATTR = App.const.ROLE_ATTR;

  function byId(id) {
    return document.getElementById(id);
  }

  function byRole(role) {
    return document.querySelector("[" + ROLE_ATTR + '="' + role + '"]');
  }

  function setText(role, text) {
    var node = byRole(role);
    if (node) node.textContent = text;
  }

  function setHidden(node, hidden) {
    if (!node) return;
    if (hidden) node.setAttribute("hidden", "");
    else node.removeAttribute("hidden");
  }

  function create(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  /** 文本按钮：按钮上不放图标字体，`aria-label` 与 `title` 都走 i18n。*/
  function button(label, className, onClick) {
    var node = create("button", className, label);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  function readStored(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStored(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* 隐私模式：这次选择不持久化，但本次会话照常生效 */
    }
  }

  /** 删掉一条存储（“没填”与“填了空串”是两件事，调用方不该自己拼这个区别）。*/
  function removeStored(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* 同上：删不掉不影响本次会话 */
    }
  }

  /**
   * 把一个字符串当文件下载（日志页的「导出 JSON」）。
   *
   * 为什么是 Blob + `<a download>` 而不是 `location.href = url`：后者对非附件
   * MIME（`application/json`）会**导航到文件**，运气好替换掉面板，运气不好把
   * 页面留在 blob 上。`download` 是浏览器唯一不会让页面离开当前位置的路径。
   *
   * 将来若出现统一的下载机制，这个函数就是它最小的替身：调用方只看
   * `(文件名, 文本, mime)` 三个参数，换实现不用改视图。
   *
   * 先挂到 body 再 click：Firefox 里未挂载的 `<a>` 不触发下载。用完立刻摘掉，
   * 并延迟一拍再 `revokeObjectURL`——同步撤销会在部分引擎里把刚开始的下载作废。
   */
  function download(fileName, text, mimeType) {
    var blob = new window.Blob([text], { type: mimeType || "text/plain" });
    var url = window.URL.createObjectURL(blob);
    var link = create("a");
    link.href = url;
    link.setAttribute("download", fileName);
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () {
      window.URL.revokeObjectURL(url);
    }, 0);
  }

  App.dom = {
    byId: byId,
    byRole: byRole,
    setText: setText,
    setHidden: setHidden,
    create: create,
    clear: clear,
    button: button,
    download: download,
  };

  App.store = { read: readStored, write: writeStored, remove: removeStored };
})(window.__zcodeApp = window.__zcodeApp || {});
