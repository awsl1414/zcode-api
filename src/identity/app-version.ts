/**
 * 本机官方 ZCode 客户端的版本探测。
 *
 * 版本号写死 = 随我们发版走，而它本该随用户装的官方客户端走。旧一版是持续的弱
 * 信号，比官方新更糟：上游没见过那个版本，可能直接判伪造。所以这里读
 * 用户已经装上的那个客户端，读不到才回默认值。
 *
 * 探测只读文件，不发网络请求，也不带任何依赖：`Info.plist` 是 XML，正则取
 * `CFBundleShortVersionString` 就够；两个 `package.json` 直接 `JSON.parse`。
 *
 * 失败一律当 `null`。没装官方客户端（只用 CLI，或压根没装）是正常情况，不是
 * 配置错误，不该让 `loadConfig` 起不来。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 客户端版本号的形状。三段的点分数字，官方发布线一直是这个写法。*/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** 一次成功的探测：值，以及读的是哪个文件。*/
export interface DetectedAppVersion {
  /** 通过 {@link VERSION_PATTERN} 校验的版本号。*/
  version: string;
  /** 探测到的客户端文件路径，设置页用它告诉用户读的是哪个客户端。*/
  path: string;
}

/** 一个候选文件，加上它自己的读法。*/
interface Candidate {
  path: string;
  /** 从文件原文里取出未校验的版本串；取不到回 `null`。*/
  read: (raw: string) => string | null;
}

/** macOS 的 `Info.plist`：`<key>CFBundleShortVersionString</key><string>3.17.2</string>`。*/
const PLIST_VERSION = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/;

/**
 * 从 `Info.plist` 原文里取 `CFBundleShortVersionString`。
 *
 * `Info.plist` 是 XML，取一个键用正则可读，不值得为这一个键引一个 XML 解析器。
 * 导出只为了单测：macOS 下那个路径写死在 `/Applications`，不能为了测试去改它。
 */
export function readPlistVersion(raw: string): string | null {
  return PLIST_VERSION.exec(raw)?.[1]?.trim() ?? null;
}

/** Electron 的 `app/package.json`：读 `version`。*/
function readPackageJsonVersion(raw: string): string | null {
  const parsed = parseJsonObject(raw);
  return parsed ? stringField(parsed, "version") : null;
}

/**
 * `~/.zcode/cli/config.json` 没有固定契约，这里认两个最常见的键名。
 *
 * 本机实测（3.17.2 的客户端 + CLI）这个文件只有 `plugins` 与 `mcp` 两段，没有
 * 版本字段，所以它只是兜底：拿不到就继续往默认值走。
 */
function readCliConfigVersion(raw: string): string | null {
  const parsed = parseJsonObject(raw);
  if (!parsed) return null;
  return stringField(parsed, "version") ?? stringField(parsed, "appVersion");
}

/** 解析成对象；不是合法 JSON 或顶层不是对象都回 `null`。*/
function parseJsonObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** 取一个非空字符串字段。*/
function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** 用户主目录：先看环境变量（`HOME` / `USERPROFILE`），再问系统。*/
function homeDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = (env.HOME ?? env.USERPROFILE ?? "").trim();
  return fromEnv !== "" ? fromEnv : homedir();
}

/** 按平台排好的候选文件。平台专属的排前面，`~/.zcode` 兜底。*/
function candidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Candidate[] {
  const list: Candidate[] = [];
  if (platform === "darwin") {
    list.push({
      path: "/Applications/ZCode.app/Contents/Info.plist",
      read: readPlistVersion,
    });
  } else if (platform === "win32") {
    const localAppData = (env.LOCALAPPDATA ?? "").trim();
    if (localAppData !== "") {
      list.push({
        path: join(localAppData, "Programs", "ZCode", "resources", "app", "package.json"),
        read: readPackageJsonVersion,
      });
    }
  } else {
    list.push({
      path: "/opt/ZCode/resources/app/package.json",
      read: readPackageJsonVersion,
    });
  }
  list.push({
    path: join(homeDir(env), ".zcode", "cli", "config.json"),
    read: readCliConfigVersion,
  });
  return list;
}

/**
 * 探测本机官方客户端，连路径一起返回；找不到（或读到的不是三段的点分数字）
 * 返回 `null`。
 *
 * 候选按顺序试，第一个有效的胜出。一个候选读失败不影响后面的：客户端目录权限
 * 不对、`package.json` 写坏了，都还有兜底。
 */
export function detectInstalledApp(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): DetectedAppVersion | null {
  for (const candidate of candidates(platform, env)) {
    let raw: string;
    try {
      raw = readFileSync(candidate.path, "utf-8");
    } catch {
      continue;
    }
    /* 文件在但不是认得的格式（JSON 写坏了、不是 JSON）：读法自己回 null，换下一个候选 */
    const trimmed = candidate.read(raw)?.trim();
    if (trimmed && VERSION_PATTERN.test(trimmed)) {
      return { version: trimmed, path: candidate.path };
    }
  }
  return null;
}

/** 版本号是否是 `x.y.z`（`config.yaml` 的手写值与探测结果用同一个判据）。*/
export function isValidAppVersion(value: string): boolean {
  return VERSION_PATTERN.test(value);
}
