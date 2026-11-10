/**
 * `qr.js` 的测试：编码器 + 一个只解 byte mode / 纠错 M 的最小**解码器**。
 *
 * 「扫不出来」是这类实现最难查的故障：矩阵画得出来、尺寸也对，只是扫不动。所以这里不
 * 只断言形状，还把生成的矩阵重新读回来解成原文。解码器是独立写的一份：读格式信息、拆
 * 掩码、按之字形取码字、还原分块交错，最后对每块算一遍 RS 校验子（全零才算纠错码正确），
 * 再从数据码字里解出模式和字符。
 *
 * 编码器本身与 `qrcode` 1.5.4（npm，仅用于一次性离线比对，不进依赖）在版本 1 到 10、
 * 8 种掩码下逐格比对过。版本上限现在是 15（登录的授权链接
 * 实测 269 字节，旧上限 213 连一条都装不下），同一个对照脚本按版本 1–15 重跑了一遍：
 * 45 组（每版三种长度）逐格一致，线上那条 269 字节的链接还与参考实现选中了同一个
 * 版本（12）与同一个掩码（2）。这里不联网，靠自写解码器守住回归。
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalWindow } from "happy-dom";

/* ------------------------------------------------------------------------- */
/* 加载被测文件                                                                */
/* ------------------------------------------------------------------------- */

interface QrOptions {
  /** 输出 SVG 的像素边长。*/
  size?: number;
  /** 静区格数。*/
  margin?: number;
  /** 固定版本（缺省按长度自动选）。*/
  version?: number;
}

interface QrApi {
  encode(text: string, options?: QrOptions): boolean[][];
  toSvg(text: string, options?: QrOptions): string;
}

/** `qr.js` 原文。它和 `app-*.js` 一样是浏览器脚本，不是模块。*/
const SOURCE = readFileSync(join(import.meta.dir, "qr.js"), "utf8");

/** 在一个只带 `window` 的壳里执行它，拿到挂上去的命名空间。*/
function loadQr(): QrApi {
  const win: { __zcodeApp?: { qr: QrApi } } = {};
  new Function("window", SOURCE)(win);
  const app = win.__zcodeApp;
  if (!app) throw new Error("qr.js did not register window.__zcodeApp");
  return app.qr;
}

const qr = loadQr();

/** 登录模态要编的那条链接。*/
const LOGIN_URL =
  "https://zcode.z.ai/app/oauth/login?redirect=zcode%3A%2F%2Foauth%2Fcallback&app_version=3.17.1";

/**
 * 登录面板真正展示的那条授权地址（269 字节）。
 *
 * 上游 `/oauth/cli/init` 回的是 `https://chat.z.ai/api/oauth/authorize?…`，
 * `auth/oauth.ts` 的 `applyInterstitial` 再把 `redirect_uri` 换成一整条中转地址
 * （`https://zcode.z.ai/app/oauth/login?redirect=zcode%3A%2F%2Foauth%2Fcallback&app_version=…`
 * 的 URL 编码形态）。这一段是「扫码之后流程能在服务端收口」的全部理由，不能为了
 * 二维码好画就省掉——所以编码器得装得下它。
 */
const AUTHORIZE_URL =
  "https://chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg" +
  "&redirect_uri=https%3A%2F%2Fzcode.z.ai%2Fapp%2Foauth%2Flogin%3Fredirect%3Dzcode%253A%252F%252Foauth%252Fcallback%26app_version%3D4.8.8" +
  "&state=6167ab026ede8f0d8bbc6b92c872f24f&response_type=code";

/* ------------------------------------------------------------------------- */
/* 解码器用到的标准定值                                                        */
/* ------------------------------------------------------------------------- */

/** 每版码字总数（数据 + 纠错），下标即版本号。*/
const TOTAL_CODEWORDS = [
  0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655,
];

/** 纠错级别 M 的分块表：`ec` 每块纠错码字数，`blocks` 是 `[块数, 每块数据码字数]`。*/
interface BlockSpec {
  ec: number;
  blocks: Array<[number, number]>;
}

const ECC_M: BlockSpec[] = [
  { ec: 0, blocks: [] },
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
  /* 11–15 版：数字照 ISO/IEC 18004 表 9，并与 qrcode@1.5.4 的
     `getTotalCodewordsCount` / `getBlocksCount` 对过（见文件头）。 */
  { ec: 30, blocks: [[1, 50], [4, 51]] },
  { ec: 22, blocks: [[6, 36], [2, 37]] },
  { ec: 22, blocks: [[8, 37], [1, 38]] },
  { ec: 24, blocks: [[4, 40], [5, 41]] },
  { ec: 24, blocks: [[5, 41], [5, 42]] },
];

/** 对齐图案中心（版本 1 没有）。*/
const ALIGNMENT_CENTERS: number[][] = [
  [],
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

/** GF(256) 的指数表，本原多项式 0x11d。*/
const GF_EXP: number[] = [];
(function buildGaloisTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    x = x << 1;
    if (x & 0x100) x ^= 0x11d;
  }
})();

function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  let result = 0;
  let left = a;
  let right = b;
  while (right > 0) {
    if (right & 1) result ^= left;
    left = left << 1;
    if (left & 0x100) left ^= 0x11d;
    right = right >> 1;
  }
  return result;
}

/* ------------------------------------------------------------------------- */
/* 解码器                                                                      */
/* ------------------------------------------------------------------------- */

/** 边长推版本号：规范里边长是 `17 + 4 * version`。*/
function versionOf(size: number): number {
  if (size < 21 || (size - 17) % 4 !== 0) throw new Error(`not a QR matrix size: ${size}`);
  return (size - 17) / 4;
}

/** 格式信息第一份的 15 个格子，按位号 0（LSB）到 14 排列。*/
const FORMAT_FIRST: Array<[number, number]> = [
  [0, 8],
  [1, 8],
  [2, 8],
  [3, 8],
  [4, 8],
  [5, 8],
  [7, 8],
  [8, 8],
  [8, 7],
  [8, 5],
  [8, 4],
  [8, 3],
  [8, 2],
  [8, 1],
  [8, 0],
];

/** 格式信息第二份的 15 个格子（右上 + 左下），位号顺序同上。*/
function formatSecond(size: number): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let i = 0; i < 8; i++) cells.push([8, size - 1 - i]);
  for (let i = 8; i < 15; i++) cells.push([size - 15 + i, 8]);
  return cells;
}

function readBitValue(matrix: boolean[][], cells: Array<[number, number]>): number {
  let value = 0;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i] as [number, number];
    if (matrix[cell[0]]?.[cell[1]]) value |= 1 << i;
  }
  return value;
}

/** 格式信息的 15 位合法码字：5 位数据 + BCH(15,5)，再异或 0x5412。*/
function expectedFormat(ecc: number, mask: number): number {
  const data = (ecc << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return (((data << 10) | remainder) ^ 0x5412) & 0x7fff;
}

/** 读格式信息，返回纠错级别与掩码。两份拷贝必须一致。*/
function readFormat(matrix: boolean[][]): { ecc: number; mask: number } {
  const size = matrix.length;
  const first = readBitValue(matrix, FORMAT_FIRST);
  const second = readBitValue(matrix, formatSecond(size));
  for (let ecc = 0; ecc < 4; ecc++) {
    for (let mask = 0; mask < 8; mask++) {
      const expected = expectedFormat(ecc, mask);
      if (first === expected && second === expected) return { ecc, mask };
    }
  }
  throw new Error("format information is not a valid BCH codeword");
}

/** 掩码条件（第 mask 号掩码在该格是否翻过色）。*/
function maskFlip(mask: number, row: number, col: number): boolean {
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

/** 功能图案占掉的格子（数据不填这些位置）。*/
function functionModules(version: number): boolean[][] {
  const size = 17 + 4 * version;
  const map: boolean[][] = [];
  for (let r = 0; r < size; r++) map.push(new Array<boolean>(size).fill(false));
  const mark = (row: number, col: number): void => {
    if (row >= 0 && col >= 0 && row < size && col < size) (map[row] as boolean[])[col] = true;
  };

  /* 三个定位图案连同分隔符。*/
  const finder = (row: number, col: number): void => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) mark(row + dr, col + dc);
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  /* 定时图案。*/
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }

  /* 对齐图案（落在定位图案上的那组不存在）。*/
  const centers = ALIGNMENT_CENTERS[version] as number[];
  for (const row of centers) {
    for (const col of centers) {
      const onFinder =
        (row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6);
      if (onFinder) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(row + dr, col + dc);
    }
  }

  /* 格式信息的两份拷贝与固定深色模块。*/
  for (let i = 0; i <= 8; i++) {
    mark(i, 8);
    mark(8, i);
  }
  for (let i = 0; i < 8; i++) mark(8, size - 1 - i);
  for (let i = 0; i < 7; i++) mark(size - 1 - i, 8);
  mark(size - 8, 8);

  /* 版本信息区（版本 7 起）。*/
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      mark(b, a);
      mark(a, b);
    }
  }
  return map;
}

/** 拆掩码后按之字形取回全部码字。*/
function readCodewords(matrix: boolean[][], version: number, mask: number): number[] {
  const size = matrix.length;
  const reserved = functionModules(version);
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const row = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        if ((reserved[row] as boolean[])[col]) continue;
        const dark = (matrix[row] as boolean[])[col] !== maskFlip(mask, row, col);
        bits.push(dark ? 1 : 0);
      }
    }
  }

  const total = TOTAL_CODEWORDS[version] as number;
  if (bits.length < total * 8) throw new Error(`too few data modules: ${bits.length} < ${total * 8}`);
  const codewords: number[] = [];
  for (let i = 0; i < total; i++) {
    let value = 0;
    for (let b = 0; b < 8; b++) value = (value << 1) | (bits[i * 8 + b] as number);
    codewords.push(value);
  }
  return codewords;
}

/** 把交错的码字还原成每块的数据与纠错码字。*/
function deinterleave(
  codewords: number[],
  version: number,
): { data: number[][]; ec: number[][]; spec: BlockSpec } {
  const spec = ECC_M[version] as BlockSpec;
  const lengths: number[] = [];
  for (const [count, length] of spec.blocks) for (let i = 0; i < count; i++) lengths.push(length);

  const data: number[][] = lengths.map(() => []);
  let index = 0;
  const longest = Math.max(...lengths);
  for (let i = 0; i < longest; i++) {
    for (let b = 0; b < lengths.length; b++) {
      if (i < (lengths[b] as number)) {
        (data[b] as number[]).push(codewords[index] as number);
        index++;
      }
    }
  }

  const ec: number[][] = lengths.map(() => []);
  for (let i = 0; i < spec.ec; i++) {
    for (let b = 0; b < lengths.length; b++) {
      (ec[b] as number[]).push(codewords[index] as number);
      index++;
    }
  }
  if (index !== codewords.length) throw new Error(`codeword count mismatch: ${index} of ${codewords.length}`);
  return { data, ec, spec };
}

/** 一块的 RS 校验子：`S_i = 码字多项式在 α^i 处的取值`（i 取 0 到纠错码字数减一），
 * 全部为 0 才算纠错码正确。*/
function syndromes(block: number[], ecCount: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < ecCount; i++) {
    let value = 0;
    for (const byte of block) value = gfMultiply(value, GF_EXP[i] as number) ^ byte;
    result.push(value);
  }
  return result;
}

/** 从数据码字里读回原文（byte mode）。*/
function parseBytes(dataCodewords: number[], version: number): string {
  let position = 0;
  const read = (width: number): number => {
    let value = 0;
    for (let i = 0; i < width; i++) {
      const byte = dataCodewords[position >> 3] as number;
      value = (value << 1) | ((byte >> (7 - (position & 7))) & 1);
      position++;
    }
    return value;
  };

  const mode = read(4);
  if (mode !== 4) throw new Error(`expected byte mode, got ${mode}`);
  const count = read(version < 10 ? 8 : 16);
  let text = "";
  for (let i = 0; i < count; i++) text += String.fromCharCode(read(8));
  return text;
}

interface Extracted {
  version: number;
  ecc: number;
  mask: number;
  /** 按块还原后的数据码字（块的顺序即原文顺序）。*/
  data: number[][];
  /** 全部块的 RS 校验子。*/
  syndromes: number[];
}

/** 从矩阵里取回码字并验纠错码，不解原文。*/
function extract(matrix: boolean[][]): Extracted {
  const version = versionOf(matrix.length);
  const { ecc, mask } = readFormat(matrix);
  const codewords = readCodewords(matrix, version, mask);
  const { data, ec, spec } = deinterleave(codewords, version);

  const checks: number[] = [];
  for (let b = 0; b < data.length; b++) {
    const block = (data[b] as number[]).concat(ec[b] as number[]);
    for (const value of syndromes(block, spec.ec)) checks.push(value);
  }
  return { version, ecc, mask, data, syndromes: checks };
}

interface Decoded extends Extracted {
  text: string;
}

/** 端到端解码：矩阵进，原文出。中途任何一步不自洽都会抛错。*/
function decode(matrix: boolean[][]): Decoded {
  const extracted = extract(matrix);
  const flat = extracted.data.reduce<number[]>((all, block) => all.concat(block), []);
  return { ...extracted, text: parseBytes(flat, extracted.version) };
}

/* ------------------------------------------------------------------------- */
/* 结构断言                                                                    */
/* ------------------------------------------------------------------------- */

/** 定位图案（7x7 回字）在该处是否成立，含外围分隔符。*/
function finderProblems(matrix: boolean[][], top: number, left: number): string[] {
  const size = matrix.length;
  const problems: string[] = [];
  for (let dr = 0; dr < 7; dr++) {
    for (let dc = 0; dc < 7; dc++) {
      const ring = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      const expected = ring || core;
      if (matrix[top + dr]?.[left + dc] !== expected) problems.push(`module ${dr},${dc} at ${top},${left}`);
    }
  }
  /* 分隔符一圈全是浅色（越界的边不管）。*/
  for (let i = -1; i <= 7; i++) {
    const cells: Array<[number, number]> = [
      [top - 1, left + i],
      [top + 7, left + i],
      [top + i, left - 1],
      [top + i, left + 7],
    ];
    for (const [row, col] of cells) {
      if (row < 0 || col < 0 || row >= size || col >= size) continue;
      if (matrix[row]?.[col] !== false) problems.push(`separator ${row},${col}`);
    }
  }
  return problems;
}

/* ------------------------------------------------------------------------- */
/* 测试                                                                        */
/* ------------------------------------------------------------------------- */

describe("qr encoder", () => {
  it("encodes the login URL into a matrix of the expected size", () => {
    const matrix = qr.encode(LOGIN_URL);
    /* 93 个字符在纠错 M 下装进版本 6（容量 106 字节），边长 17 + 4 * 6 = 41。*/
    expect(LOGIN_URL.length).toBe(93);
    expect(matrix.length).toBe(41);
    for (const row of matrix) expect(row.length).toBe(41);
    /* 全是布尔值，没有 undefined 留下的洞。*/
    expect(matrix.every((row) => row.every((cell) => typeof cell === "boolean"))).toBe(true);
  });

  it("puts the three finder patterns in the corners, with their separators", () => {
    const matrix = qr.encode(LOGIN_URL);
    const size = matrix.length;
    expect(finderProblems(matrix, 0, 0)).toEqual([]);
    expect(finderProblems(matrix, 0, size - 7)).toEqual([]);
    expect(finderProblems(matrix, size - 7, 0)).toEqual([]);
    /* 右下角是数据区，不该出现定位图案。*/
    expect(finderProblems(matrix, size - 7, size - 7).length).toBeGreaterThan(0);
  });

  it("draws alternating timing patterns between the finders", () => {
    const matrix = qr.encode(LOGIN_URL);
    const size = matrix.length;
    const problems: string[] = [];
    for (let i = 8; i < size - 8; i++) {
      if (matrix[6]?.[i] !== (i % 2 === 0)) problems.push(`row 6 col ${i}`);
      if (matrix[i]?.[6] !== (i % 2 === 0)) problems.push(`row ${i} col 6`);
    }
    expect(problems).toEqual([]);
  });

  it("is deterministic", () => {
    expect(qr.encode(LOGIN_URL)).toEqual(qr.encode(LOGIN_URL));
    expect(qr.toSvg(LOGIN_URL)).toBe(qr.toSvg(LOGIN_URL));
  });

  it("picks a bigger version for longer input", () => {
    /* 纠错 M 的字节容量：v1 14 / v2 26 / v3 42 / v4 62 / v5 84 / v6 106 / v7 122 /
       v8 152 / v9 180 / v10 213。*/
    const sizes = [10, 30, 60, 100, 140, 200].map((length) => qr.encode("x".repeat(length)).length);
    expect(sizes).toEqual([21, 29, 33, 41, 49, 57]);
    /* 边长随长度单调不减。*/
    for (let i = 1; i < sizes.length; i++) expect((sizes[i] as number) > (sizes[i - 1] as number)).toBe(true);
  });

  it("encodes the authorize URL that the login panel actually shows", () => {
    /* 这条是登录流程真正要编的链接：`/oauth/cli/init` 回的授权地址再追加
       `redirect_uri` 中转参数，实测 269 字节。版本 10 / 纠错 M 的容量只有 213 字节，
       装不下时 `encode` 直接抛错，模态里就只剩一个空的二维码框。*/
    expect(AUTHORIZE_URL.length).toBe(269);
    const matrix = qr.encode(AUTHORIZE_URL);
    /* 269 字节落在版本 12（容量 287）。*/
    expect(matrix.length).toBe(17 + 4 * 12);
    const decoded = decode(matrix);
    expect(decoded.version).toBe(12);
    expect(decoded.text).toBe(AUTHORIZE_URL);
  });

  it("rejects input it cannot encode", () => {
    /* 版本 15 在纠错 M 下最多 412 字节（当前上限）。*/
    expect(qr.encode("x".repeat(412)).length).toBe(17 + 4 * 15);
    expect(() => qr.encode("x".repeat(413))).toThrow();
    /* 多字节字符不在范围内，报错而不是静默截断。*/
    expect(() => qr.encode("授权")).toThrow();
    expect(() => qr.encode("x", { version: 16 })).toThrow();
    expect(() => qr.encode(LOGIN_URL, { version: 1 })).toThrow();
  });
});

describe("qr decoder round trip", () => {
  const samples: Array<[string, string]> = [
    ["login url", LOGIN_URL],
    ["authorize url", AUTHORIZE_URL],
    ["short", "a"],
    ["lowercase", "https://bigmodel.cn/login?redirect=zcode%3a%2f%2foauth%2fcallback"],
    ["latin-1 range", "caf\u00e9 \u00fcber"],
    ["full v10", "x".repeat(213)],
    ["full v15", "w".repeat(412)],
    ["full v1", "y".repeat(14)],
  ];

  for (const [name, text] of samples) {
    it(`decodes back to the original text: ${name}`, () => {
      const decoded = decode(qr.encode(text));
      expect(decoded.text).toBe(text);
      expect(decoded.ecc).toBe(0);
      /* RS 校验子全零：纠错码字与数据码字自洽。*/
      expect(decoded.syndromes.every((value) => value === 0)).toBe(true);
    });
  }

  it("decodes every version from 1 to 15", () => {
    /* 每版能装的最大字节数（纠错 M），用满容量的文本走一遍。*/
    const capacity = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412];
    for (let version = 1; version <= 15; version++) {
      const text = "z".repeat(capacity[version - 1] as number);
      const decoded = decode(qr.encode(text, { version }));
      expect([version, decoded.version]).toEqual([version, version]);
      expect([version, decoded.text]).toEqual([version, text]);
      expect([version, decoded.syndromes.every((value) => value === 0)]).toEqual([version, true]);
    }
  });

  it("survives a flipped data module being detected by the error correction", () => {
    /* 翻转一个数据格后，校验子必须不再全零：说明纠错码真的覆盖到了数据区。*/
    const matrix = qr.encode(LOGIN_URL);
    const size = matrix.length;
    const reserved = functionModules(versionOf(size));
    let target: [number, number] | null = null;
    for (let row = size - 1; row >= 0 && target === null; row--) {
      for (let col = size - 1; col >= 0 && target === null; col--) {
        if (!(reserved[row] as boolean[])[col]) target = [row, col];
      }
    }
    if (!target) throw new Error("no data module found");
    const row = matrix[target[0]] as boolean[];
    row[target[1]] = !row[target[1]];
    /* 翻一位之后原文已经解不出来，所以这里只看校验子。*/
    expect(extract(matrix).syndromes.every((value) => value === 0)).toBe(false);
  });

  it("keeps the three corner patterns of the decoder map in sync with the encoder", () => {
    /* 解码器靠功能图案图定位数据格；这张图与编码器的布局必须逐格一致，
       否则上面的往返会解出乱码。这里额外固定一次格子数量。*/
    for (let version = 1; version <= 15; version++) {
      const size = 17 + 4 * version;
      const map = functionModules(version);
      const reserved = map.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
      const dataModules = size * size - reserved;
      const total = TOTAL_CODEWORDS[version] as number;
      /* 数据格数 = 码字位数 + 剩余位（0 到 7 位）。*/
      expect([version, dataModules >= total * 8]).toEqual([version, true]);
      expect([version, dataModules - total * 8]).toEqual([version, dataModules % 8]);
    }
  });
});

describe("qr svg rendering", () => {
  interface XmlDocument {
    documentElement: { tagName: string; getAttribute(name: string): string | null };
    querySelector(selector: string): unknown;
  }
  const parser = new (new GlobalWindow() as unknown as { DOMParser: new () => { parseFromString(text: string, type: string): XmlDocument } }).DOMParser();

  it("produces SVG that an XML parser accepts", () => {
    const svg = qr.toSvg(LOGIN_URL);
    const doc = parser.parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.documentElement.tagName.toLowerCase()).toBe("svg");
    /* 41 格加两侧各 4 格静区。*/
    expect(doc.documentElement.getAttribute("viewBox")).toBe("0 0 49 49");
  });

  it("follows the theme instead of hard-coding a colour", () => {
    const svg = qr.toSvg(LOGIN_URL);
    expect(svg).toContain('fill="currentColor"');
    /* 没有裸色值，颜色只来自 token。*/
    expect(svg.match(/#[0-9a-fA-F]{3,8}/)).toBeNull();
    expect(svg).not.toContain("rgb(");
  });

  it("merges same-colour runs into one path instead of one rect per module", () => {
    const svg = qr.toSvg(LOGIN_URL);
    expect(svg).not.toContain("<rect");
    const path = /d="([^"]*)"/.exec(svg)?.[1] ?? "";
    expect(path.length).toBeGreaterThan(0);
    /* 每段是一条水平连续黑格，段数远少于黑格数。*/
    const dark = qr.encode(LOGIN_URL).flat().filter(Boolean).length;
    expect(path.split("M").length - 1).toBeLessThan(dark);
  });

  it("honours size and margin options", () => {
    const svg = qr.toSvg(LOGIN_URL, { size: 320, margin: 2 });
    expect(svg).toContain('width="320"');
    expect(svg).toContain('height="320"');
    expect(svg).toContain('viewBox="0 0 45 45"');
    const defaults = qr.toSvg(LOGIN_URL);
    expect(defaults).toContain('width="220"');
    expect(defaults).toContain('viewBox="0 0 49 49"');
  });

  it("ships no external reference (zero CDN)", () => {
    const svg = qr.toSvg(LOGIN_URL);
    /* 只允许 SVG 命名空间那一个标识符，它不是请求目标。*/
    const withoutNamespace = svg.split('xmlns="http://www.w3.org/2000/svg"').join("");
    expect(withoutNamespace).not.toMatch(/https?:\/\//);
  });
});
