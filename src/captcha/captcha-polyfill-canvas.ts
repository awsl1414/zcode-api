// @ts-nocheck -- untyped happy-dom shims, same reason as captcha-happy.ts
/**
 * Canvas and WebGL shims for the happy-dom captcha window.
 *
 * The FeiLin fingerprint SDK reads canvas pixels and WebGL vendor strings.
 * happy-dom ships a canvas element with no rendering context, so every probe
 * either throws or comes back zeroed and the fingerprint reads as a headless
 * VM. These shims answer with what a desktop Chrome returns; the
 * vendor/renderer strings and the canvas image come from `fp`.
 *
 * Separate from captcha-happy.ts because the 2D context alone is forty-one
 * no-op members: declaration-only code that shares nothing with the window
 * setup.
 */

export function installCanvasPolyfills(w, fp) {
  const proto = w.HTMLCanvasElement.prototype;
  const nativeGetContext = typeof proto.getContext === "function" ? proto.getContext : null;
  proto.getContext = function (type, ...rest) {
    if (/webgl/i.test(type)) {
      return makeWebGLMock(this);
    }
    if (nativeGetContext) {
      try {
        const ctx = nativeGetContext.call(this, type, ...rest);
        if (ctx) return ctx;
      } catch (_) {}
    }
    return make2DStub(this);
  };

  function makeWebGLMock(canvas) {
    return {
      canvas,
      getParameter(p) {
        if (p === 7936) return "WebKit";
        if (p === 7937) return "WebKit WebGL";
        if (p === 7938) return "WebGL 1.0 (OpenGL ES 2.0 Chromium)";
        if (p === 35724) return "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)";
        if (p === 0x9245) return fp.webglUnmaskedVendor;
        if (p === 0x9246) return fp.webglUnmaskedRenderer;
        return "Intel Inc.";
      },
      getExtension(name) {
        if (name === "WEBGL_debug_renderer_info") {
          return { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
        }
        return null;
      },
      getSupportedExtensions() {
        return [
          "ANGLE_instanced_arrays", "EXT_blend_minmax", "EXT_color_buffer_half_float",
          "EXT_disjoint_timer_query", "EXT_float_blend", "EXT_frag_depth",
          "EXT_shader_texture_lod", "EXT_texture_compression_bptc",
          "EXT_texture_compression_rgtc", "EXT_texture_filter_anisotropic",
          "EXT_sRGB", "KHR_parallel_shader_compile", "OES_element_index_uint",
          "OES_fbo_render_mipmap", "OES_standard_derivatives",
          "OES_texture_float", "OES_texture_float_linear",
          "OES_texture_half_float", "OES_texture_half_float_linear",
          "OES_vertex_array_object", "WEBGL_color_buffer_float",
          "WEBGL_compressed_texture_astc", "WEBGL_compressed_texture_etc",
          "WEBGL_compressed_texture_etc1", "WEBGL_compressed_texture_s3tc",
          "WEBGL_compressed_texture_s3tc_srgb", "WEBGL_debug_renderer_info",
          "WEBGL_debug_shaders", "WEBGL_depth_texture", "WEBGL_draw_buffers",
          "WEBGL_lose_context", "WEBGL_multi_draw",
        ];
      },
      getContextAttributes() {
        return {
          alpha: true, antialias: true, depth: true,
          failIfMajorPerformanceCaveat: false, powerPreference: "default",
          premultipliedAlpha: true, preserveDrawingBuffer: false,
          stencil: false, desynchronized: false,
        };
      },
      getShaderPrecisionFormat() {
        return { precision: 23, rangeMin: 127, rangeMax: 127 };
      },
    };
  }

  function make2DStub(canvas) {
    return {
      canvas,
      fillRect() {},
      clearRect() {},
      getImageData: (_x, _y, w2 = 1, h2 = 1) => new w.ImageData(w2, h2),
      putImageData() {},
      createImageData: (w2 = 1, h2 = 1) => new w.ImageData(w2, h2),
      setTransform() {},
      transform() {},
      drawImage() {},
      save() {},
      restore() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      bezierCurveTo() {},
      quadraticCurveTo() {},
      closePath() {},
      clip() {},
      stroke() {},
      fill() {},
      arc() {},
      rect() {},
      ellipse() {},
      translate() {},
      scale() {},
      rotate() {},
      fillText() {},
      strokeText() {},
      measureText: (t) => ({ width: String(t).length * 8 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      createPattern: () => ({}),
      isPointInPath: () => false,
      font: "10px sans-serif",
      textBaseline: "alphabetic",
      textAlign: "start",
      fillStyle: "#000",
      strokeStyle: "#000",
      globalAlpha: 1,
      lineWidth: 1,
      shadowBlur: 0,
      shadowColor: "",
    };
  }

  const nativeToDataURL = typeof proto.toDataURL === "function" ? proto.toDataURL : null;
  proto.toDataURL = function (...a) {
    try {
      if (nativeToDataURL) return nativeToDataURL.apply(this, a);
    } catch (_) {}
    return fp.canvasImage;
  };
  if (typeof proto.toBlob !== "function") {
    proto.toBlob = (cb) => cb && cb(new w.Blob());
  }

  w.OffscreenCanvas =
    w.OffscreenCanvas ||
    class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return proto.getContext.call(this);
      }
    };
}
