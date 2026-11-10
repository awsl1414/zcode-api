/**
 * 端口文件的读 / 写 / 删。
 *
 * 文件本身只有一行，但三个细节错了都会变成另一个 bug：权限太宽（同机别的用户可以
 * 拿到控制端口）、写到一半被读到（CLI 把半截内容当成端口）、坏内容被当成端口
 * （CLI 去连一个毫不相干的端口）。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  controlPortPath,
  readControlPort,
  removeControlPort,
  writeControlPort,
} from "./control-port.js";

let storeDir: string;
let previous: string | undefined;

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "zcode-control-port-"));
  previous = process.env.ZCODE_PROXY_STORE_DIR;
  process.env.ZCODE_PROXY_STORE_DIR = storeDir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.ZCODE_PROXY_STORE_DIR;
  else process.env.ZCODE_PROXY_STORE_DIR = previous;
  rmSync(storeDir, { recursive: true, force: true });
});

describe("端口文件（control-port.ts）", () => {
  it("写一行十进制端口号，权限 0o600", () => {
    writeControlPort(41234);
    expect(readControlPort()).toBe(41234);
    expect(readFileSync(controlPortPath(), "utf-8")).toBe("41234\n");
    expect(statSync(controlPortPath()).mode & 0o777).toBe(0o600);
  });

  it("文件不存在时读回 null", () => {
    expect(readControlPort()).toBeNull();
  });

  it("内容不是端口时读回 null", () => {
    for (const bad of ["", "\n", "abc", "0", "70000", "12.5", "-1", "8787 8788"]) {
      writeFileSync(controlPortPath(), bad);
      expect(readControlPort()).toBeNull();
    }
  });

  it("覆盖写：上一次的端口不会残留", () => {
    writeControlPort(41234);
    writeControlPort(41235);
    expect(readControlPort()).toBe(41235);
  });

  it("删除是幂等的", () => {
    writeControlPort(41234);
    removeControlPort();
    expect(existsSync(controlPortPath())).toBe(false);
    removeControlPort();
    expect(existsSync(controlPortPath())).toBe(false);
  });
});
