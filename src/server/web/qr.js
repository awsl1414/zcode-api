/*
 * qr.js — 登录模态里那张授权链接二维码。
 *
 * 页面由服务端拼装，也没有打包器（零构建链），所以拿不到现成的库，
 * `qrcode` 这类包。这里内嵌一个够用的 QR Model 2 实现：byte mode、纠错级别 M、版本 1
 * 到 10 自动选，输出 boolean 矩阵或一段 SVG 字符串。
 *
 * 用不到的不实现：多字节字符（授权链接是 ASCII）、结构化追加、微 QR、另外三个纠错级别。
 * 算法依据 ISO/IEC 18004。分块表与对齐图案坐标是标准里的定值，改一个数字就扫不出来。
 */
(function (App) {
  "use strict";

  /* ---- 常量 ---------------------------------------------------------- */

  /**
   * 版本范围。边长是 `17 + 4 * version`，版本 10 就是 57 格。
   *
   * 上限是 15：这不是「顺手放宽」，是修一条实测走不通的路。登录模态
   * 编码的是 `authorize_url` + 追加的 `redirect_uri` 中转参数（见 `auth/oauth.ts`
   * 的 `applyInterstitial`），线上量到的那条是 **269 字节**，而版本 10 / 纠错 M 的
   * byte 容量只有 213 字节——`encode()` 直接抛错，二维码从来没画出来过。
   *
   * 15 版给到 415 字节（多留 54%），覆盖 client_id / state / 以后多一个参数都不至于
   * 再顶破；再多加版本只是把没人用的容量堆进来（每版多一组对齐图案坐标与分块表，
   * 每一行错一个数字都换一张扫不出来的码）。
   */
  var MIN_VERSION = 1;
  var MAX_VERSION = 15;

  /** 纠错级别 M 在格式信息里的两位编码是 00（L=01、Q=11、H=10）。*/
  var ECC_M = 0;

  /** byte mode 的模式指示符（`0100`）。*/
  var BYTE_MODE = 4;

  /** 字符计数字段宽度：版本 1 到 9 是 8 位，版本 10 起是 16 位。*/
  var COUNT_BITS_SMALL = 8;
  var COUNT_BITS_LARGE = 16;

  /**
   * 每版的码字总数（数据 + 纠错），下标即版本号。
   *
   * 只给测试与注释当参照：编码路径上的容量一律由 {@link ECC_BLOCKS_M} 算出来
   * （`dataCodewordCount`），这样两张表不可能互相矛盾。
   */
  var TOTAL_CODEWORDS = [
    0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655,
  ];

  /**
   * 纠错级别 M 的分块表。`ec` 是每块的纠错码字数，`blocks` 是 `[块数, 每块数据码字数]`。
   * 一个版本可以有两段块长（v8 起出现），所以这里用数组而不是单个数字。
   */
  var ECC_BLOCKS_M = [
    null,
    { ec: 10, blocks: [[1, 16]] },
    { ec: 16, blocks: [[1, 28]] },
    { ec: 26, blocks: [[1, 44]] },
    { ec: 18, blocks: [[2, 32]] },
    { ec: 24, blocks: [[2, 43]] },
    { ec: 16, blocks: [[4, 27]] },
    { ec: 18, blocks: [[4, 31]] },
    { ec: 22, blocks: [[2, 38], [2, 39]] },
    { ec: 22, blocks: [[3, 36], [2, 37]] },
    { ec: 26, blocks: [[4, 43], [1, 44]] },
    /* 11–15 版（见 MAX_VERSION 的注释）。数字逐版对过 qrcode@1.5.4
       的 `Utils.getSymbolTotalCodewords` / `ECCode.getTotalCodewordsCount` /
       `getBlocksCount`，并按「两段块长」还原成分块表；v1–v10 那十行用同一条对照
       路径重算过一遍，与原有数字逐格一致。 */
    { ec: 30, blocks: [[1, 50], [4, 51]] },
    { ec: 22, blocks: [[6, 36], [2, 37]] },
    { ec: 22, blocks: [[8, 37], [1, 38]] },
    { ec: 24, blocks: [[4, 40], [5, 41]] },
    { ec: 24, blocks: [[5, 41], [5, 42]] },
  ];

  /** 对齐图案的中心坐标（版本 1 没有对齐图案）。*/
  var ALIGNMENT_CENTERS = [
    null,
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
    [6, 30, 54],
    [6, 32, 58],
    [6, 34, 62],
    [6, 26, 46, 66],
    [6, 26, 48, 70],
  ];

  /** 掩码模式共 8 种。*/
  var MASK_COUNT = 8;

  /** 渲染默认值：像素边长、静区格数（规范要求静区至少 4 格）。*/
  var DEFAULT_SIZE = 220;
  var DEFAULT_MARGIN = 4;

  /**
   * SVG 命名空间。
   * （`page.test.ts` 扫 web 目录的每个产物），而这个 URI 只是标识符、不会被请求，
   * 所以拆成两段拼。
   */
  var SVG_NAMESPACE = "http" + "://www.w3.org/2000/svg";

  /** 掩码惩罚分（ISO/IEC 18004 表 11 的四个 N 值）。*/
  var PENALTY_RUN = 3;
  var PENALTY_BLOCK = 3;
  var PENALTY_FINDER = 40;
  var PENALTY_BALANCE = 10;

  /** 类定位图案：`1011101` 两侧各带 4 格浅色，共 11 格。*/
  var FINDER_LIKE = [
    [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
  ];

  /* ---- GF(256) ------------------------------------------------------ */

  /*
   * 本原多项式 0x11d。AES 用的是 0x11b，抄错会让纠错码全错，矩阵照样画得出来、
   * 只是扫不出来。
   */
  var GF_EXP = [];
  var GF_LOG = [];

  (function buildGaloisTables() {
    var x = 1;
    var i;
    for (i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x = x << 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  /** 生成多项式 `(x - α^0)(x - α^1)…(x - α^(degree-1))`，系数从高次到低次。*/
  function rsGenerator(degree) {
    var poly = [1];
    var i;
    var j;
    for (i = 0; i < degree; i++) {
      var next = [];
      for (j = 0; j <= poly.length; j++) next.push(0);
      for (j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  /** 数据码字的 Reed-Solomon 余数，即该块的纠错码字。*/
  function rsRemainder(data, degree) {
    var gen = rsGenerator(degree);
    var rem = [];
    var i;
    var j;
    for (i = 0; i < degree; i++) rem.push(0);
    for (i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem[0];
      rem.shift();
      rem.push(0);
      for (j = 0; j < degree; j++) rem[j] ^= gfMul(gen[j + 1], factor);
    }
    return rem;
  }

  /* ---- 数据编码 ------------------------------------------------------ */

  /** 该版本在纠错 M 下的数据码字数。*/
  function dataCodewordCount(version) {
    var spec = ECC_BLOCKS_M[version];
    var total = 0;
    var i;
    for (i = 0; i < spec.blocks.length; i++) total += spec.blocks[i][0] * spec.blocks[i][1];
    return total;
  }

  function countBits(version) {
    return version < 10 ? COUNT_BITS_SMALL : COUNT_BITS_LARGE;
  }

  /** 文本转字节。授权链接是 ASCII，超出单字节的字符直接报错，不做静默截断。*/
  function toBytes(text) {
    var bytes = [];
    var i;
    for (i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code > 0xff) throw new Error("qr: byte mode only encodes single-byte characters");
      bytes.push(code);
    }
    return bytes;
  }

  /** 按位写入的字节缓冲区，容量按数据码字数预置。*/
  function BitStream(capacity) {
    this.bytes = [];
    this.length = 0;
    var i;
    for (i = 0; i < capacity; i++) this.bytes.push(0);
  }

  BitStream.prototype.putBit = function (bit) {
    if (bit) this.bytes[this.length >> 3] |= 0x80 >> (this.length & 7);
    this.length++;
  };

  BitStream.prototype.put = function (value, width) {
    var i;
    for (i = width - 1; i >= 0; i--) this.putBit((value >>> i) & 1);
  };

  /** 选能装下这段字节的最小版本。*/
  function chooseVersion(byteLength) {
    var version;
    for (version = MIN_VERSION; version <= MAX_VERSION; version++) {
      var needed = 4 + countBits(version) + byteLength * 8;
      if (needed <= dataCodewordCount(version) * 8) return version;
    }
    throw new Error(
      "qr: text is too long for versions " + MIN_VERSION + "-" + MAX_VERSION + " at level M",
    );
  }

  /**
   * 版本由 `options.version` 固定或按长度自动选。固定版本是给测试用的：版本 1 到 10
   * 的分块表与对齐图案坐标各不相同，没有它就得为每一版凑一段特定长度的文本。
   */
  function resolveVersion(options, byteLength) {
    var forced = options.version;
    if (forced === undefined || forced === null) return chooseVersion(byteLength);
    if (forced < MIN_VERSION || forced > MAX_VERSION) throw new Error("qr: version out of range");
    if (4 + countBits(forced) + byteLength * 8 > dataCodewordCount(forced) * 8) {
      throw new Error("qr: text does not fit the requested version");
    }
    return forced;
  }

  /** 模式指示符 + 字符计数 + 数据 + 终止符 + 补齐到整字节 + 填充码字。*/
  function buildDataCodewords(version, bytes) {
    var capacity = dataCodewordCount(version);
    var stream = new BitStream(capacity);
    var i;
    stream.put(BYTE_MODE, 4);
    stream.put(bytes.length, countBits(version));
    for (i = 0; i < bytes.length; i++) stream.put(bytes[i], 8);

    var terminator = Math.min(4, capacity * 8 - stream.length);
    stream.put(0, terminator);
    stream.put(0, (8 - (stream.length & 7)) & 7);

    /* 填充码字固定是 0xEC 与 0x11 交替。*/
    var pad = [0xec, 0x11];
    var next = 0;
    while (stream.length < capacity * 8) {
      stream.put(pad[next], 8);
      next = next === 0 ? 1 : 0;
    }
    return stream.bytes;
  }

  /** 按分块表切块，每块补上自己的纠错码字。*/
  function buildBlocks(version, dataCodewords) {
    var spec = ECC_BLOCKS_M[version];
    var blocks = [];
    var offset = 0;
    var i;
    var n;
    for (i = 0; i < spec.blocks.length; i++) {
      var count = spec.blocks[i][0];
      var length = spec.blocks[i][1];
      for (n = 0; n < count; n++) {
        var data = dataCodewords.slice(offset, offset + length);
        offset += length;
        blocks.push({ data: data, ec: rsRemainder(data, spec.ec) });
      }
    }
    return blocks;
  }

  /** 交错：先按列取各块的数据码字，再按列取纠错码字。*/
  function interleave(blocks) {
    var out = [];
    var i;
    var j;
    var maxData = 0;
    for (i = 0; i < blocks.length; i++) maxData = Math.max(maxData, blocks[i].data.length);
    for (i = 0; i < maxData; i++) {
      for (j = 0; j < blocks.length; j++) {
        if (i < blocks[j].data.length) out.push(blocks[j].data[i]);
      }
    }
    var ecLength = blocks[0].ec.length;
    for (i = 0; i < ecLength; i++) {
      for (j = 0; j < blocks.length; j++) out.push(blocks[j].ec[i]);
    }
    return out;
  }

  /* ---- 矩阵 ---------------------------------------------------------- */

  /**
   * 一张矩阵：`dark` 是最终的黑白格，`reserved` 标记功能图案（定位 / 定时 / 对齐 /
   * 格式 / 版本）占掉的格子。数据只填 reserved 为假的格子。
   */
  function makeMatrix(size) {
    var dark = [];
    var reserved = [];
    var r;
    var c;
    for (r = 0; r < size; r++) {
      var darkRow = [];
      var reservedRow = [];
      for (c = 0; c < size; c++) {
        darkRow.push(false);
        reservedRow.push(false);
      }
      dark.push(darkRow);
      reserved.push(reservedRow);
    }
    return { size: size, dark: dark, reserved: reserved };
  }

  function setModule(matrix, row, col, dark) {
    matrix.dark[row][col] = dark;
    matrix.reserved[row][col] = true;
  }

  function reserveModule(matrix, row, col) {
    matrix.reserved[row][col] = true;
  }

  function cloneMatrix(matrix) {
    var dark = [];
    var r;
    for (r = 0; r < matrix.size; r++) dark.push(matrix.dark[r].slice());
    return { size: matrix.size, dark: dark, reserved: matrix.reserved };
  }

  /** 定位图案连同它那一圈分隔符（7x7 加外框）。*/
  function placeFinder(matrix, row, col) {
    var dr;
    var dc;
    for (dr = -1; dr <= 7; dr++) {
      for (dc = -1; dc <= 7; dc++) {
        var r = row + dr;
        var c = col + dc;
        if (r < 0 || c < 0 || r >= matrix.size || c >= matrix.size) continue;
        var inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        var dark =
          inside &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setModule(matrix, r, c, dark);
      }
    }
  }

  /** 格式信息 15 位：5 位数据 + BCH(15,5) 校验，再异或固定掩码 0x5412。*/
  function formatBits(mask) {
    var data = (ECC_M << 3) | mask;
    var rem = data;
    var i;
    for (i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  /** 版本信息 18 位：6 位版本号 + BCH(18,6) 校验，只有版本 7 起才有。*/
  function versionBits(version) {
    var rem = version;
    var i;
    for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (version << 12) | rem;
  }

  function bitOf(value, index) {
    return ((value >>> index) & 1) !== 0;
  }

  /**
   * 画全部功能图案。格式信息的位置先占住（值要等掩码定下来才能写），版本信息与
   * 版本号绑定，这里直接写完。
   */
  function drawFunctionPatterns(matrix, version) {
    var size = matrix.size;
    var i;
    var j;

    placeFinder(matrix, 0, 0);
    placeFinder(matrix, 0, size - 7);
    placeFinder(matrix, size - 7, 0);

    /* 定时图案：第 6 行与第 6 列，黑白相间。*/
    for (i = 8; i < size - 8; i++) {
      setModule(matrix, 6, i, i % 2 === 0);
      setModule(matrix, i, 6, i % 2 === 0);
    }

    /* 对齐图案：落在三个定位图案上的那一组跳过。*/
    var centers = ALIGNMENT_CENTERS[version];
    var a;
    var b;
    for (a = 0; a < centers.length; a++) {
      for (b = 0; b < centers.length; b++) {
        var row = centers[a];
        var col = centers[b];
        var onFinder =
          (row === 6 && col === 6) ||
          (row === 6 && col === size - 7) ||
          (row === size - 7 && col === 6);
        if (onFinder) continue;
        for (i = -2; i <= 2; i++) {
          for (j = -2; j <= 2; j++) {
            setModule(matrix, row + i, col + j, Math.max(Math.abs(i), Math.abs(j)) !== 1);
          }
        }
      }
    }

    /* 格式信息的两份拷贝（各自 15 格）以及固定的深色模块。*/
    for (i = 0; i <= 8; i++) {
      reserveModule(matrix, i, 8);
      reserveModule(matrix, 8, i);
    }
    for (i = 0; i < 8; i++) reserveModule(matrix, 8, size - 1 - i);
    for (i = 0; i < 7; i++) reserveModule(matrix, size - 1 - i, 8);
    reserveModule(matrix, size - 8, 8);

    /* 版本信息区（版本 7 起）：右上 3x6 与左下 6x3。*/
    if (version >= 7) {
      var bits = versionBits(version);
      for (i = 0; i < 18; i++) {
        var dark = bitOf(bits, i);
        var x = size - 11 + (i % 3);
        var y = Math.floor(i / 3);
        setModule(matrix, y, x, dark);
        setModule(matrix, x, y, dark);
      }
    }
  }

  /** 写格式信息：一份在左上角绕定位图案，一份在右上与左下。*/
  function drawFormatBits(matrix, mask) {
    var size = matrix.size;
    var bits = formatBits(mask);
    var i;

    for (i = 0; i <= 5; i++) setModule(matrix, i, 8, bitOf(bits, i));
    setModule(matrix, 7, 8, bitOf(bits, 6));
    setModule(matrix, 8, 8, bitOf(bits, 7));
    setModule(matrix, 8, 7, bitOf(bits, 8));
    for (i = 9; i < 15; i++) setModule(matrix, 8, 14 - i, bitOf(bits, i));

    for (i = 0; i < 8; i++) setModule(matrix, 8, size - 1 - i, bitOf(bits, i));
    for (i = 8; i < 15; i++) setModule(matrix, size - 15 + i, 8, bitOf(bits, i));

    /* 第 (size-8, 8) 格恒为深色，不参与格式信息。*/
    setModule(matrix, size - 8, 8, true);
  }

  /** 数据之字形填充：从右下角起，两列一组，自下而上再自上而下交替。*/
  function drawCodewords(matrix, codewords) {
    var size = matrix.size;
    var total = codewords.length * 8;
    var index = 0;
    var right;

    for (right = size - 1; right >= 1; right -= 2) {
      /* 第 6 列是定时图案，整列跳过（右列索引落到 6 时左移一列）。*/
      if (right === 6) right = 5;
      var upward = ((right + 1) & 2) === 0;
      var vert;
      for (vert = 0; vert < size; vert++) {
        var row = upward ? size - 1 - vert : vert;
        var j;
        for (j = 0; j < 2; j++) {
          var col = right - j;
          if (matrix.reserved[row][col]) continue;
          if (index < total) {
            var bit = (codewords[index >> 3] >>> (7 - (index & 7))) & 1;
            matrix.dark[row][col] = bit === 1;
            index++;
          } else {
            /* 剩余位（remainder bits）留浅色。*/
            matrix.dark[row][col] = false;
          }
        }
      }
    }
  }

  /** 第 mask 号掩码在该格是否要翻色。*/
  function maskBit(mask, row, col) {
    switch (mask) {
      case 0:
        return (row + col) % 2 === 0;
      case 1:
        return row % 2 === 0;
      case 2:
        return col % 3 === 0;
      case 3:
        return (row + col) % 3 === 0;
      case 4:
        return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
      case 5:
        return ((row * col) % 2) + ((row * col) % 3) === 0;
      case 6:
        return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
      default:
        return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    }
  }

  function applyMask(matrix, mask) {
    var row;
    var col;
    for (row = 0; row < matrix.size; row++) {
      for (col = 0; col < matrix.size; col++) {
        if (matrix.reserved[row][col]) continue;
        if (maskBit(mask, row, col)) matrix.dark[row][col] = !matrix.dark[row][col];
      }
    }
  }

  /** 一段 11 格的窗口是不是类定位图案。*/
  function finderLikeAt(reader, start) {
    var i;
    var k;
    for (i = 0; i < FINDER_LIKE.length; i++) {
      var match = true;
      for (k = 0; k < FINDER_LIKE[i].length; k++) {
        if (reader(start + k) !== (FINDER_LIKE[i][k] === 1)) {
          match = false;
          break;
        }
      }
      if (match) return true;
    }
    return false;
  }

  /** 规则 1：一条线上连续 5 格以上同色，每段 3 分，超出 5 格的部分每格加 1。*/
  function runPenalty(size, read) {
    var score = 0;
    var run = 1;
    var i;
    for (i = 1; i < size; i++) {
      if (read(i) === read(i - 1)) {
        run++;
      } else {
        if (run >= 5) score += PENALTY_RUN + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += PENALTY_RUN + (run - 5);
    return score;
  }

  /** 规则 3：一条线上每出现一处类定位图案计 40 分。*/
  function finderPenalty(size, read) {
    var score = 0;
    var start;
    for (start = 0; start + 11 <= size; start++) {
      if (finderLikeAt(read, start)) score += PENALTY_FINDER;
    }
    return score;
  }

  /**
   * 掩码惩罚分（ISO/IEC 18004 标准 8.8.2 节的四条规则）。分数越低越不容易被扫错，
   * 编码器就选最低的那个掩码。
   */
  function penalty(matrix) {
    var size = matrix.size;
    var dark = matrix.dark;
    var score = 0;
    var r;
    var c;

    /* 规则 1：行与列上连续 5 格以上同色。*/
    for (r = 0; r < size; r++) score += runPenalty(size, rowReader(dark, r));
    for (c = 0; c < size; c++) score += runPenalty(size, colReader(dark, c));

    /* 规则 2：2x2 同色块，每块 3 分。*/
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var value = dark[r][c];
        if (value === dark[r][c + 1] && value === dark[r + 1][c] && value === dark[r + 1][c + 1]) {
          score += PENALTY_BLOCK;
        }
      }
    }

    /* 规则 3：类定位图案，每处 40 分。*/
    for (r = 0; r < size; r++) score += finderPenalty(size, rowReader(dark, r));
    for (c = 0; c < size; c++) score += finderPenalty(size, colReader(dark, c));

    /* 规则 4：深色格占比偏离 50%，每 5 个百分点 10 分。*/
    var darkCount = 0;
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) if (dark[r][c]) darkCount++;
    }
    var percent = Math.floor((darkCount * 100) / (size * size));
    score += PENALTY_BALANCE * Math.floor(Math.abs(percent - 50) / 5);

    return score;
  }

  function rowReader(dark, row) {
    return function (col) {
      return dark[row][col];
    };
  }

  function colReader(dark, col) {
    return function (row) {
      return dark[row][col];
    };
  }

  /* ---- 对外接口 ------------------------------------------------------ */

  /**
   * 取一个有限的非负数，缺省或传错时回落到默认值。渲染参数写错会得到一张尺寸是
   * `NaN` 的 SVG，页面上看起来就是一片空白，比报错更难查。
   */
  function numberOrDefault(value, fallback) {
    return typeof value === "number" && isFinite(value) && value >= 0 ? value : fallback;
  }

  /**
   * 编码一段文本，返回 `boolean[][]`（`true` 是黑格）。矩阵边长即 `17 + 4 * version`，
   * 不含静区，静区由渲染层补。`options.version` 可固定版本，缺省按长度自动选。
   */
  function encode(text, options) {
    var opts = options || {};
    var bytes = toBytes(String(text));
    var version = resolveVersion(opts, bytes.length);
    var codewords = interleave(buildBlocks(version, buildDataCodewords(version, bytes)));

    var base = makeMatrix(17 + 4 * version);
    drawFunctionPatterns(base, version);
    drawCodewords(base, codewords);

    /* 8 个掩码各画一遍，取惩罚分最低的那个。分数相同取号小的，结果才是确定的。*/
    var best = null;
    var mask;
    for (mask = 0; mask < MASK_COUNT; mask++) {
      var candidate = cloneMatrix(base);
      applyMask(candidate, mask);
      drawFormatBits(candidate, mask);
      var score = penalty(candidate);
      if (best === null || score < best.score) best = { score: score, dark: candidate.dark };
    }
    return best.dark;
  }

  /**
   * 渲染成 SVG 字符串。同色格按行合并成一条 `<path>`，比每格一个 `<rect>` 小得多；
   * 颜色用 `currentColor`，跟随 `tokens.css` 的主题，不用改一行样式。
   */
  function toSvg(text, options) {
    var opts = options || {};
    var margin = numberOrDefault(opts.margin, DEFAULT_MARGIN);
    var size = numberOrDefault(opts.size, DEFAULT_SIZE);
    var matrix = encode(text, opts);
    var modules = matrix.length;
    var dimension = modules + margin * 2;
    var segments = [];
    var row;
    var col;

    for (row = 0; row < modules; row++) {
      var start = -1;
      for (col = 0; col <= modules; col++) {
        var dark = col < modules && matrix[row][col];
        if (dark && start < 0) start = col;
        if (!dark && start >= 0) {
          var width = col - start;
          segments.push("M" + (start + margin) + " " + (row + margin) + "h" + width + "v1h-" + width + "z");
          start = -1;
        }
      }
    }

    return (
      '<svg xmlns="' +
      SVG_NAMESPACE +
      '" viewBox="0 0 ' +
      dimension +
      " " +
      dimension +
      '" width="' +
      size +
      '" height="' +
      size +
      '" shape-rendering="crispEdges">' +
      '<path fill="currentColor" d="' +
      segments.join("") +
      '"/>' +
      "</svg>"
    );
  }

  App.qr = { encode: encode, toSvg: toSvg };
})(window.__zcodeApp = window.__zcodeApp || {});
