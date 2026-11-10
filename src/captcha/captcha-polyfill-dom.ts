// @ts-nocheck -- untyped happy-dom shims, same reason as captcha-happy.ts
/**
 * Window, document, navigator and screen shims for the happy-dom captcha
 * window.
 *
 * Two kinds of gap get filled here. Constructors a real browser exposes as
 * window globals (Option, Video, EventSource, RTCPeerConnection,
 * IntersectionObserver, OfflineAudioContext, ...) are absent from happy-dom,
 * and a ReferenceError inside the SDK probe chain aborts the whole collection.
 * The environment objects happy-dom does provide (navigator, screen, document,
 * window metrics) carry its defaults, which read as a bare VM to the
 * fingerprint SDK, so they are overwritten from `fp`.
 *
 * Separate from captcha-happy.ts because all of it is declaration-only
 * stubbing: no solver state, no network, no timers.
 */

export function installDomPolyfills(w, fp) {

  // Element constructor shortcuts every real browser exposes. The FeiLin
  // fingerprint SDK references `Option` as a bare identifier; missing it
  // throws inside its probe chain and degrades the fingerprint.
  if (typeof w.Option !== "function") {
    w.Option = class Option extends w.HTMLOptionElement {
      constructor(text, value, defaultSelected, selected) {
        super();
        if (text !== undefined) {
          const el = w.document.createElement("option");
          el.text = text;
          if (value !== undefined) el.value = value;
          if (defaultSelected) el.defaultSelected = true;
          if (selected) el.selected = true;
          return el;
        }
      }
    };
  }
  if (typeof w.Video !== "function" && w.HTMLVideoElement) {
    w.Video = class Video extends w.HTMLVideoElement {
      constructor() { return w.document.createElement("video"); }
    };
  }

  // happy-dom lacks alert/prompt/confirm/open/close (same stubs as
  // solve-shim.js line ~559-561)
  if (typeof w.alert !== "function") w.alert = () => {};
  if (typeof w.prompt !== "function") w.prompt = () => null;
  if (typeof w.confirm !== "function") w.confirm = () => false;
  if (typeof w.open !== "function") w.open = () => null;
  if (typeof w.close !== "function") w.close = () => {};
  try { Object.defineProperty(w, "alert", { value: w.alert, configurable: true, writable: true }); } catch (_) {}
  try { Object.defineProperty(w, "prompt", { value: w.prompt, configurable: true, writable: true }); } catch (_) {}
  try { Object.defineProperty(w, "confirm", { value: w.confirm, configurable: true, writable: true }); } catch (_) {}
  try { Object.defineProperty(w, "open", { value: w.open, configurable: true, writable: true }); } catch (_) {}
  try { Object.defineProperty(w, "close", { value: w.close, configurable: true, writable: true }); } catch (_) {}

  // happy-dom lacks browser globals that FeiLin / the pe risk engine probe.
  // A missing one throws ReferenceError inside the VM machine -> breaks the
  // collection chain. Ported from solve-shim.js's stub list.
  const extraGlobals = {
    print: () => {},
    stop: () => {},
    moveTo: () => {},
    moveBy: () => {},
    showModalDialog: () => null,
    find: () => false,
  };
  for (const [k, v] of Object.entries(extraGlobals)) {
    try { Object.defineProperty(w, k, { value: v, configurable: true, writable: true }); } catch (_) {}
  }
  // happy-dom's own open()/close() are destructive (close() tears the window
  // down); the risk engine probes them -> neutralize.
  try { Object.defineProperty(w, "open", { value: () => null, configurable: true, writable: true }); } catch (_) {}
  try { Object.defineProperty(w, "close", { value: () => {}, configurable: true, writable: true }); } catch (_) {}

  if (!w.Option) {
    w.Option = class {
      constructor(text, value, defaultSelected, selected) {
        this.text = text ?? "";
        this.value = value ?? "";
        this.selected = selected ?? defaultSelected ?? false;
        this.defaultSelected = !!defaultSelected;
        this.disabled = false;
        this.label = this.text;
        this.index = 0;
      }
    };
  }

  if (!w.EventSource) {
    w.EventSource = class {
      constructor() {
        this.readyState = 2;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
      }
      close() {
        this.readyState = 2;
      }
      addEventListener() {}
      removeEventListener() {}
    };
  }

  if (!w.Beacon) w.Beacon = class {};

  if (!w.RTCPeerConnection) {
    w.RTCPeerConnection = class {
      constructor() {}
      createDataChannel() { return {}; }
      close() {}
      createOffer() { return Promise.resolve({}); }
      setLocalDescription() { return Promise.resolve(); }
      addEventListener() {}
      removeEventListener() {}
    };
  }

  if (!w.MessageChannel) {
    w.MessageChannel = class {
      constructor() {
        this.port1 = { onmessage: null, postMessage() {}, start() {}, close() {}, addEventListener() {}, removeEventListener() {} };
        this.port2 = { onmessage: null, postMessage() {}, start() {}, close() {}, addEventListener() {}, removeEventListener() {} };
      }
    };
  }

  w.IntersectionObserver =
    w.IntersectionObserver ||
    class {
      constructor(cb) {
        this.cb = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };

  w.ResizeObserver =
    w.ResizeObserver ||
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };

  w.DeviceOrientationEvent =
    w.DeviceOrientationEvent ||
    class extends w.Event {
      constructor(type, opts) {
        super(type, opts);
      }
      alpha = null;
      beta = null;
      gamma = null;
      absolute = false;
    };

  w.DeviceMotionEvent =
    w.DeviceMotionEvent ||
    class extends w.Event {
      constructor(type, opts) {
        super(type, opts);
      }
      acceleration = null;
      accelerationIncludingGravity = null;
      rotationRate = null;
      interval = 16;
    };

  // Window-registry timers explicitly: these callbacks only touch the window
  // and must die with it (they'd otherwise survive destroyDom via the dual
  // dispatcher's host lane).
  w.requestIdleCallback = w.requestIdleCallback || ((cb) => w.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 10 }), 1));
  w.cancelIdleCallback = w.cancelIdleCallback || ((id) => w.clearTimeout(id));

  w.matchMedia =
    w.matchMedia ||
    (() => ({
      matches: false,
      media: "",
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    }));

  if (!w.visualViewport) {
    const VisualViewport = function () {};
    VisualViewport.prototype = {
      width: fp.screen.w - 16,
      height: fp.screen.h - 120,
      scale: 1,
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      onresize: null,
      onscroll: null,
      onscrollend: null,
    };
    w.VisualViewport = VisualViewport;
    w.visualViewport = Object.create(w.VisualViewport.prototype);
  }

  if (!w.indexedDB) {
    const IDBFactory = function () {};
    IDBFactory.prototype = {
      open: () => ({ onupgradeneeded: null, onsuccess: null, onerror: null }),
      deleteDatabase: () => ({}),
      databases: () => Promise.resolve([]),
    };
    w.IDBFactory = IDBFactory;
    w.indexedDB = Object.create(w.IDBFactory.prototype);
  }

  if (!w.speechSynthesis) {
    const SpeechSynthesis = function () {};
    SpeechSynthesis.prototype = {
      speak() {},
      cancel() {},
      pause() {},
      resume() {},
      getVoices: () => [],
    };
    w.SpeechSynthesis = SpeechSynthesis;
    w.speechSynthesis = Object.create(w.SpeechSynthesis.prototype);
    w.SpeechSynthesisUtterance = function () {};
  }

  w.Worker =
    w.Worker ||
    class {
      postMessage() {}
      terminate() {}
      addEventListener() {}
      removeEventListener() {}
    };

  w.Notification =
    w.Notification ||
    class {
      static permission = "default";
      static requestPermission() {
        return Promise.resolve("default");
      }
      close() {}
    };

  const audioMock = class {
    constructor() {
      this.sampleRate = 44100;
      this.currentTime = 0;
      this.state = "suspended";
    }
    createOscillator() {
      return {
        type: "sine",
        frequency: { value: 440, setValueAtTime() {} },
        connect() {},
        start() {},
        stop() {},
      };
    }
    createDynamicsCompressor() {
      return {
        threshold: { value: -24, setValueAtTime() {} },
        knee: { value: 30, setValueAtTime() {} },
        ratio: { value: 12, setValueAtTime() {} },
        attack: { value: 0.003, setValueAtTime() {} },
        release: { value: 0.25, setValueAtTime() {} },
        connect() {},
      };
    }
    createAnalyser() {
      return {
        fftSize: 2048,
        frequencyBinCount: 1024,
        getByteFrequencyData() {},
        getByteTimeDomainData() {},
        connect() {},
      };
    }
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
    destination = {};
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
    close() {
      this.state = "closed";
      return Promise.resolve();
    }
  };
  w.AudioContext = w.AudioContext || audioMock;
  w.OfflineAudioContext =
    w.OfflineAudioContext ||
    class extends audioMock {
      constructor(_channels, length, sampleRate) {
        super();
        this.length = length;
        this.sampleRate = sampleRate;
      }
      startRendering() {
        const len = this.length || 44100;
        const sr = this.sampleRate || 44100;
        const buf = new Float32Array(len);
        for (let i = 0; i < len; i += 1) {
          const t = i / sr;
          buf[i] =
            Math.sin(2 * Math.PI * 1000 * t) * Math.exp(-t * 1.2) * 0.6 +
            Math.sin(2 * Math.PI * 3000 * t) * Math.exp(-t * 1.5) * 0.25 +
            Math.sin(2 * Math.PI * 5000 * t) * Math.exp(-t * 2.0) * 0.12;
        }
        return Promise.resolve({
          numberOfChannels: 1,
          length: len,
          sampleRate: sr,
          getChannelData: () => buf,
        });
      }
    };

  w.requestAnimationFrame = w.requestAnimationFrame || ((cb) => w.setTimeout(() => cb(Date.now()), 16));
  w.cancelAnimationFrame = w.cancelAnimationFrame || ((id) => w.clearTimeout(id));

  try {
    Object.defineProperty(w.document, "hidden", { value: false, configurable: true });
    Object.defineProperty(w.document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
  } catch (_) {}

  if (!w.document.fonts) {
    w.document.fonts = {
      ready: Promise.resolve(),
      check: () => true,
      addEventListener() {},
      removeEventListener() {},
    };
  }

  if (!w.chrome) {
    w.chrome = {
      app: {
        isInstalled: false,
        InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
        RunningState: { CANNOT_RUN: "cannot_run", CAN_RUN: "can_run", RUNNING: "running" },
        getDetails() { return null; },
        getIsInstalled() { return false; },
        installState(cb) { if (cb) cb("not_installed"); },
        runningState(cb) { if (cb) cb("cannot_run"); },
      },
      csi() {
        const now = Date.now();
        return { startE: now - 100, onloadT: now, pageT: 100, tran: 15 };
      },
      loadTimes() {
        const now = Date.now() / 1000;
        return {
          requestTime: now - 0.1, startLoadTime: now - 0.1,
          commitLoadTime: now - 0.05, finishDocumentLoadTime: now,
          finishLoadTime: now, firstPaintTime: now - 0.02,
          firstPaintAfterLoadTime: 0, navigationType: "Other",
          wasFetchedViaSpdy: true, wasNpnNegotiated: true,
          npnNegotiatedProtocol: "h2", wasAlternateProtocolAvailable: false,
          connectionInfo: "h2",
        };
      },
    };
  }

  // navigator patch
  const nav = w.navigator;
  const plugins = createNavigatorPlugins(w);
  const navPatch = {
    userAgent: fp.userAgent,
    platform: fp.platform,
    language: "en-US",
    languages: ["en-US", "en"],
    vendor: "Google Inc.",
    webdriver: false,
    hardwareConcurrency: 12,
    deviceMemory: 8,
    maxTouchPoints: 0,
    cookieEnabled: true,
    plugins: plugins.plugins,
    mimeTypes: plugins.mimeTypes,
    appVersion: fp.userAgent.replace(/^Mozilla\//, ""),
    appName: "Netscape",
    appCodeName: "Mozilla",
    product: "Gecko",
    productSub: "20030107",
    vendorSub: "",
    oscpu: undefined,
    doNotTrack: null,
    sendBeacon: (url, data) => {
      try {
        const xhr = new w.XMLHttpRequest();
        xhr.open("POST", url, true);
        xhr.send(data);
        return true;
      } catch (_) {
        return false;
      }
    },
  };
  for (const [k, v] of Object.entries(navPatch)) {
    try {
      Object.defineProperty(nav, k, { value: v, configurable: true });
    } catch (_) {}
  }

  // polyfill navigator sub-objects that happy-dom lacks
  const makeNS = (protoObj) => {
    const C = new w.Function();
    C.prototype = protoObj;
    return new C();
  };

  if (!nav.connection) {
    const NetInfo = () => {};
    NetInfo.prototype = { onchange: null, effectiveType: "4g", rtt: 50, downlink: 10, saveData: false };
    w.NetworkInformation = NetInfo;
    try {
      Object.defineProperty(nav, "connection", { value: makeNS(NetInfo.prototype), configurable: true });
    } catch (_) {}
  }
  if (!nav.userAgentData) {
    const UAData = function () {};
    UAData.prototype = {
      brands: [
        { brand: "Chromium", version: fp.uaMajor },
        { brand: "Not)A;Brand", version: "24" },
      ],
      mobile: false,
      platform: "Linux",
      getHighEntropyValues: () =>
        Promise.resolve({
          brands: [
            { brand: "Chromium", version: fp.uaMajor },
            { brand: "Not)A;Brand", version: "24" },
          ],
          mobile: false,
          platform: "Linux",
          platformVersion: "6.5.0",
          architecture: "x86",
          model: "",
          uaFullVersion: fp.uaFull,
          fullVersionList: [
            { brand: "Chromium", version: fp.uaFull },
            { brand: "Not)A;Brand", version: "24.0.0.0" },
          ],
        }),
    };
    try {
      Object.defineProperty(nav, "userAgentData", { value: makeNS(UAData.prototype), configurable: true });
    } catch (_) {}
  }
  if (!w.Permissions) {
    const Perms = () => {};
    Perms.prototype = {
      query: (param) =>
        Promise.resolve({ state: param.name === "notifications" ? "prompt" : "granted", onchange: null }),
    };
    w.Permissions = Perms;
  }
  try {
    if (!nav.permissions) Object.defineProperty(nav, "permissions", { value: makeNS(w.Permissions.prototype), configurable: true });
  } catch (_) {}
  try {
    if (!nav.clipboard)
      Object.defineProperty(nav, "clipboard", {
        value: makeNS({ readText: () => Promise.resolve(""), writeText: () => Promise.resolve() }),
        configurable: true,
      });
  } catch (_) {}
  try {
    if (!nav.geolocation)
      Object.defineProperty(nav, "geolocation", {
        value: makeNS({
          getCurrentPosition: (s) => s && s({ coords: { latitude: 0, longitude: 0, accuracy: 1 } }),
          watchPosition: () => 1,
          clearWatch: () => {},
        }),
        configurable: true,
      });
  } catch (_) {}
  try {
    if (!nav.credentials)
      Object.defineProperty(nav, "credentials", {
        value: makeNS({ get: () => Promise.resolve(null), create: () => Promise.resolve(null), store: () => Promise.resolve(), preventSilentAccess: () => Promise.resolve() }),
        configurable: true,
      });
  } catch (_) {}
  try {
    if (!nav.storage)
      Object.defineProperty(nav, "storage", {
        value: makeNS({ estimate: () => Promise.resolve({ quota: 1e8, usage: 0 }), persisted: () => Promise.resolve(false), persist: () => Promise.resolve(false) }),
        configurable: true,
      });
  } catch (_) {}
  try {
    if (!nav.usb)
      Object.defineProperty(nav, "usb", {
        value: makeNS({ getDevices: () => Promise.resolve([]), requestDevice: () => Promise.reject(new Error("no devices")) }),
        configurable: true,
      });
  } catch (_) {}
  try {
    if (!nav.mediaDevices)
      Object.defineProperty(nav, "mediaDevices", {
        value: makeNS({ enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error("NotAllowedError")) }),
        configurable: true,
      });
  } catch (_) {}

  // screen
  const screenPatch = {
    width: fp.screen.w,
    height: fp.screen.h,
    availWidth: fp.screen.w,
    availHeight: fp.screen.ah,
    availLeft: 0,
    availTop: 0,
    colorDepth: 24,
    pixelDepth: 24,
    orientation: { angle: 0, type: "landscape-primary", onchange: null },
  };
  for (const [k, v] of Object.entries(screenPatch)) {
    try {
      Object.defineProperty(w.screen, k, { get: () => v, configurable: true });
    } catch (_) {}
  }

  w.outerWidth = fp.screen.w;
  w.outerHeight = fp.screen.h - 40;
  w.innerWidth = fp.screen.w - 16;
  w.innerHeight = fp.screen.h - 120;
  w.devicePixelRatio = 1;
}

function createNavigatorPlugins(w) {
  const indexed = [
    { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
    { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
    { name: "Chromium PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
  ];
  const plugins = w.PluginArray ? Object.create(w.PluginArray.prototype) : {};
  const mockIndexed = [];
  for (let i = 0; i < indexed.length; i++) {
    const p = Object.create((w.Plugin && w.Plugin.prototype) || Object.prototype);
    Object.defineProperty(p, "name", { value: indexed[i].name, configurable: true, enumerable: true });
    Object.defineProperty(p, "filename", { value: indexed[i].filename, configurable: true, enumerable: true });
    Object.defineProperty(p, "description", { value: indexed[i].description, configurable: true, enumerable: true });
    Object.defineProperty(p, "length", { value: 1, configurable: true, enumerable: true });
    Object.defineProperty(p, "0", { value: p, configurable: true, enumerable: true });
    p.item = () => p;
    p.namedItem = () => p;
    plugins[i] = p;
    mockIndexed.push(p);
  }
  Object.defineProperty(plugins, "length", { value: indexed.length, configurable: true, enumerable: true });
  plugins.item = (i) => plugins[i] ?? null;
  plugins.namedItem = (name) => mockIndexed.find((p) => p.name === name) ?? null;
  plugins.refresh = () => {};
  const mimeTypes =
    w.MimeTypeArray ? Object.create(w.MimeTypeArray.prototype) : {};
  Object.defineProperty(mimeTypes, "length", { value: 0, configurable: true, enumerable: true });
  mimeTypes.item = () => null;
  mimeTypes.namedItem = () => null;
  return { plugins, mimeTypes };
}
