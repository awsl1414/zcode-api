/*
 * app-chat-attachments.js — 聊天附件的存储层。
 *
 * 职责只有一件：图片 blob 的存取与清理。文本文件不走这里——它们的内容作为
 * 消息正文的一部分（「[文件: foo.ts]」标注）随会话存 localStorage，量小且
 * 天然是文本；**图片 base64 绝不进 localStorage**（会话存的是文本正文，
 * 塞进几张图就能把 5MB 配额打爆），图片 blob 存 IndexedDB，消息里只存引用
 * （`{kind:"image", id, name, thumb}`）与一张小缩略图。
 *
 * 三条架构决策：
 *
 *   1. **降级链**：IndexedDB 打不开（隐私模式、配额被禁用）→ 图片退化为
 *      「仅本次页面生存期有效」的内存 Map——功能照常，刷新即失，附带一次性
 *      提示（提示的时机与文案归聊天视图）。写入中配额爆掉（QuotaExceeded）→
 *      同样落内存。调用方拿 `{id, persisted}` 自己决定要不要提示。
 *   2. **孤儿清理**：blob 的引用只存在于会话消息里，而会话可能被删除、被撤回、
 *      根本没发出去。`pruneExcept(referencedIds)` 在进视图（会话清单恢复后）与
 *      删会话时调用，把没有任何引用的 blob 删掉——不清理的话，IndexedDB 会
 *      慢慢变成一个只进不出的垃圾场。
 *   3. **data URL 缓存**：发消息时每条带图的历史消息都要重新组装 content 数组
 *      （无状态协议），blob → data URL 的 FileReader 转换按 id 缓存一次，之后
 *      的每轮发送直接命中。
 *
 * 为什么不用 `fetch` 一个 blob: URL 再转 base64 之类的取巧路径：FileReader 的
 * readAsDataURL 是这条转换的规范路径，浏览器与测试环境（happy-dom）都直接支持。
 *
 * 测试口径：happy-dom 没有 `window.indexedDB`，运行时测试要么不装 IndexedDB
 * （走内存降级路径），要么在 `window` 上装一个极小的假实现（见 runtime.test.ts
 * 的 `installFakeIndexedDB`）——本模块只依赖 `open / transaction / objectStore`
 * 这层最小接口，不做能力嗅探之外的浏览器分支。
 */
(function (App) {
  "use strict";

  var C = App.const;

  var DB_NAME = C.CHAT_IMAGE_DB_NAME;
  var DB_VERSION = C.CHAT_IMAGE_DB_VERSION;
  var STORE = C.CHAT_IMAGE_STORE;

  /** 已打开的连接（懒开，进程内复用；open 失败后不再重试，会话期内都是降级态）。*/
  var dbPromise = null;
  /** IndexedDB 不可用（undefined 或打开失败）：本轮页面生存期一律走内存。*/
  var idbBroken = false;

  /** 内存降级桶：id → Blob。仅本次页面生存期有效。*/
  var memoryBlobs = new Map();
  /** blob → data URL 的缓存（内存桶与 idb 条目共用一份）。*/
  var dataUrls = new Map();

  /* ---- 基础设施 ---------------------------------------------------------- */

  function idbAvailable() {
    return !idbBroken && typeof window !== "undefined" && !!window.indexedDB;
  }

  function requestToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error);
      };
    });
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        /* 库是新建的（或版本升级）：图片仓只有一把 id 主键，结构就这么多。*/
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error);
      };
    });
    return dbPromise;
  }

  /** 单步事务里跑一个 objectStore 操作，按 request 事件收尾（见文件头第 2 点）。*/
  function withStore(mode, run) {
    return openDb().then(function (db) {
      var tx = db.transaction(STORE, mode);
      return requestToPromise(run(tx.objectStore(STORE)));
    });
  }

  /** 任何 IndexedDB 失败都把本轮会话打进内存降级态：不反复撞同一堵墙。*/
  function degrade() {
    idbBroken = true;
    dbPromise = null;
  }

  /* ---- 缩略图 ------------------------------------------------------------ */

  /**
   * blob → 小缩略图（JPEG data URL）。画布不可用（隐私设置、happy-dom）返回
   * `null`：调用方在「没有缩略图」时显示占位块，blob 到手后直接显示原图。
   *
   * 缩略图只用于持久化后的兜底显示，发送给模型的永远是原图的 data URL——
   * 这里压不压尺寸都不影响上游看到什么。
   *
   * 安全网：解码器一个回调都不给（隐私扩展、测试环境、极端格式）时，半秒后
   * 放弃。`finish` 幂等，onload / onerror / 计时器谁先到谁生效，不会重复 resolve。
   */
  function makeThumb(blob) {
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (value) {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        var url = window.URL.createObjectURL(blob);
        var img = new window.Image();
        img.onload = function () {
          try {
            var edge = C.CHAT_THUMB_MAX_EDGE;
            var scale = Math.min(1, edge / Math.max(img.naturalWidth || edge, img.naturalHeight || edge));
            var width = Math.max(1, Math.round((img.naturalWidth || edge) * scale));
            var height = Math.max(1, Math.round((img.naturalHeight || edge) * scale));
            var canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            var ctx = canvas.getContext("2d");
            if (!ctx || typeof ctx.drawImage !== "function") {
              window.URL.revokeObjectURL(url);
              finish(null);
              return;
            }
            ctx.drawImage(img, 0, 0, width, height);
            var dataUrl = canvas.toDataURL("image/jpeg", C.CHAT_THUMB_JPEG_QUALITY);
            window.URL.revokeObjectURL(url);
            finish(dataUrl.startsWith("data:image/jpeg") ? dataUrl : null);
          } catch {
            finish(null);
          }
        };
        img.onerror = function () {
          window.URL.revokeObjectURL(url);
          finish(null);
        };
        img.src = url;
        setTimeout(function () {
          window.URL.revokeObjectURL(url);
          finish(null);
        }, C.CHAT_THUMB_TIMEOUT_MS);
      } catch {
        finish(null);
      }
    });
  }

  /* ---- 存取 -------------------------------------------------------------- */

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      /* window. 前缀的理由见 app-view-chat.js 的 readFileAsText。 */
      var reader = new window.FileReader();
      reader.onload = function () {
        resolve(typeof reader.result === "string" ? reader.result : null);
      };
      reader.onerror = function () {
        reject(reader.error);
      };
      reader.readAsDataURL(blob);
    });
  }

  /**
   * 存一张图片 blob，回 `{id, persisted}`。
   *
   * `persisted: true` = 已进 IndexedDB（刷新后还能回来）；`false` = 落在内存桶
   * （idb 不可用 / 配额爆掉），仅本次页面生存期有效。两种情况的 id 都能通过
   * `dataUrlOf` / `objectUrlOf` 取回内容——降级只影响「刷新后还在不在」。
   */
  function putImage(blob) {
    var id = "img" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    if (!idbAvailable()) {
      memoryBlobs.set(id, blob);
      return Promise.resolve({ id: id, persisted: false });
    }
    return openDb()
      .then(function () {
        return withStore("readwrite", function (store) {
          return store.put(blob, id);
        });
      })
      .then(function () {
        return { id: id, persisted: true };
      })
      .catch(function () {
        /* 打开失败或写入配额爆掉：降级为内存，本图本次有效（视图负责提示）。*/
        degrade();
        memoryBlobs.set(id, blob);
        return { id: id, persisted: false };
      });
  }

  function memoryBlobOf(id) {
    var blob = memoryBlobs.get(id);
    if (blob) return Promise.resolve(blob);
    return Promise.resolve(null);
  }

  function storedBlobOf(id) {
    return withStore("readonly", function (store) {
      return store.get(id);
    }).catch(function () {
      degrade();
      return null;
    });
  }

  /** id → Blob（内存桶优先——它是降级态下唯一的真身；否则查 IndexedDB）。*/
  function blobOf(id) {
    if (memoryBlobs.has(id)) return memoryBlobOf(id);
    if (!idbAvailable()) return Promise.resolve(null);
    return storedBlobOf(id);
  }

  /**
   * id → 完整 data URL（发消息组装 `image_url` 用）。按 id 缓存；取不到 blob
   * （被清理 / 降级后刷新）回 `null`，调用方降级为一条「图片已不在本机」的文本。
   */
  function dataUrlOf(id) {
    if (dataUrls.has(id)) return Promise.resolve(dataUrls.get(id));
    return blobOf(id)
      .then(function (blob) {
        if (!blob) return null;
        return blobToDataUrl(blob).then(function (dataUrl) {
          if (dataUrl) dataUrls.set(id, dataUrl);
          return dataUrl;
        });
      })
      .catch(function () {
        return null;
      });
  }

  /** id → 显示用 object URL（气泡里的 `<img src>`；页面生存期缓存，不主动撤销）。*/
  function objectUrlOf(id) {
    return blobOf(id).then(function (blob) {
      return blob ? window.URL.createObjectURL(blob) : null;
    });
  }

  /** 删一批 id（切会话删除 / 预览条里单张移除）。内存桶与 idb 都清，缓存作废。*/
  function removeImages(ids) {
    var listed = [];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (id && !listed.includes(id)) listed.push(id);
    }
    if (listed.length === 0) return Promise.resolve();
    for (var j = 0; j < listed.length; j++) {
      memoryBlobs.delete(listed[j]);
      dataUrls.delete(listed[j]);
    }
    if (!idbAvailable()) return Promise.resolve();
    return openDb()
      .then(function () {
        var chain = Promise.resolve();
        for (var k = 0; k < listed.length; k++) {
          (function (id) {
            chain = chain.then(function () {
              return withStore("readwrite", function (store) {
                return store.delete(id);
              });
            });
          })(listed[k]);
        }
        return chain;
      })
      .catch(function () {
        /* 清理失败不提示：孤儿最多占点配额，下次进视图还会再试 */
      });
  }

  /**
   * 孤儿清理：删掉 `keepIds` 之外的全部 blob。
   *
   * 进视图（会话清单恢复后）与删会话后各跑一次。内存桶同口径清理——降级态下
   * 删掉的会话里的图也不该继续占内存。回删除条数（测试断言用）。
   */
  function pruneExcept(keepIds) {
    var keep = {};
    for (var i = 0; i < keepIds.length; i++) keep[keepIds[i]] = true;
    var removedMemory = [];
    memoryBlobs.forEach(function (blob, id) {
      void blob;
      if (!keep[id]) removedMemory.push(id);
    });
    for (var m = 0; m < removedMemory.length; m++) {
      memoryBlobs.delete(removedMemory[m]);
      dataUrls.delete(removedMemory[m]);
    }
    if (!idbAvailable()) return Promise.resolve(removedMemory.length);
    return openDb()
      .then(function () {
        return withStore("readonly", function (store) {
          return store.getAllKeys();
        });
      })
      .then(function (keys) {
        var orphans = [];
        for (var k = 0; k < keys.length; k++) {
          var key = String(keys[k]);
          if (!keep[key]) orphans.push(key);
        }
        if (orphans.length === 0) return 0;
        return removeImages(orphans).then(function () {
          return orphans.length;
        });
      })
      .catch(function () {
        degrade();
        return removedMemory.length;
      });
  }

  /** 仅供降级提示与测试：当前是否处于「IndexedDB 不可用」的降级态。*/
  function isDegraded() {
    return idbBroken || !idbAvailable();
  }

  App.attachments = {
    makeThumb: makeThumb,
    putImage: putImage,
    dataUrlOf: dataUrlOf,
    objectUrlOf: objectUrlOf,
    removeImages: removeImages,
    pruneExcept: pruneExcept,
    isDegraded: isDegraded,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
