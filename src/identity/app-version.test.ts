/**
 * 客户端版本探测的单测。
 *
 * 探测的真实输入是「这台机器上装了什么」，所以用例只喂受控的路径：平台与几个
 * 环境变量可以注入，路径全部落在临时目录里。`/Applications` 那条写死在代码里，
 * 它的取值函数单独测。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectInstalledApp, isValidAppVersion, readPlistVersion } from "./app-version.js";

const TMP = join(tmpdir(), `zcode-app-version-${process.pid}-${Date.now()}`);
const ORIGINAL_HOME = process.env.HOME;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  /* 兜底路径是 `~/.zcode/cli/config.json`；HOME 指到临时目录，它就不存在了 */
  process.env.HOME = TMP;
});

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  rmSync(TMP, { recursive: true, force: true });
});

/** 在临时目录里写一个文件，返回它的路径。*/
function writeAt(relative: string, content: string): string {
  const path = join(TMP, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
  return path;
}

/** Windows 的客户端布局，根目录换到临时目录。*/
function windowsEnv(localAppData: string): NodeJS.ProcessEnv {
  return { ...process.env, LOCALAPPDATA: localAppData };
}

describe("readPlistVersion", () => {
  it("picks CFBundleShortVersionString out of the XML", () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>ZCode</string>
  <key>CFBundleShortVersionString</key>
  <string>3.17.2</string>
  <key>CFBundleVersion</key>
  <string>999</string>
</dict>
</plist>`;
    expect(readPlistVersion(plist)).toBe("3.17.2");
  });

  it("returns null when the key is absent", () => {
    expect(readPlistVersion("<plist><dict><key>CFBundleName</key><string>ZCode</string></dict></plist>")).toBeNull();
  });
});

describe("detectInstalledApp", () => {
  it("returns null for paths that do not exist, without throwing", () => {
    expect(detectInstalledApp("win32", windowsEnv(join(TMP, "missing")))).toBeNull();
  });

  it("reads the Electron package.json on Windows", () => {
    const path = writeAt("Programs/ZCode/resources/app/package.json", JSON.stringify({ version: "3.17.2" }));
    expect(detectInstalledApp("win32", windowsEnv(TMP))).toEqual({ version: "3.17.2", path });
  });

  it("falls through to ~/.zcode/cli/config.json when the client is absent", () => {
    const path = writeAt(".zcode/cli/config.json", JSON.stringify({ version: "3.16.0" }));
    expect(detectInstalledApp("win32", windowsEnv(join(TMP, "missing")))).toEqual({ version: "3.16.0", path });
  });

  it("rejects a version that is not x.y.z and keeps looking", () => {
    writeAt("Programs/ZCode/resources/app/package.json", JSON.stringify({ version: "3.17" }));
    const fallback = writeAt(".zcode/cli/config.json", JSON.stringify({ version: "3.16.0" }));
    expect(detectInstalledApp("win32", windowsEnv(TMP))).toEqual({ version: "3.16.0", path: fallback });
  });

  it("treats a malformed JSON file as no version at all", () => {
    writeAt("Programs/ZCode/resources/app/package.json", "{ not json");
    expect(detectInstalledApp("win32", windowsEnv(TMP))).toBeNull();
  });
});

describe("isValidAppVersion", () => {
  it("accepts three numeric parts and nothing else", () => {
    expect(isValidAppVersion("3.17.2")).toBe(true);
    expect(isValidAppVersion("3.17")).toBe(false);
    expect(isValidAppVersion("3.17.2-beta")).toBe(false);
    expect(isValidAppVersion(" 3.17.2 ")).toBe(false);
  });
});
