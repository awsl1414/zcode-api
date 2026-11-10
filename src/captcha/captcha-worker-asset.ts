// @ts-nocheck — the file-asset import below is a Bun extension with no type
// declaration.
/**
 * captcha-worker-asset.ts — sole carrier of Bun's `with { type: "file" }`
 * import: it is what embeds the pre-bundled worker into `bun build --compile`
 * binaries (`new Worker(new URL(...))` does not survive compilation).
 *
 * Only a compiled binary resolves this module: the import target is a
 * gitignored build input produced by scripts/build-fork-worker.ts, and source
 * runs load the sibling captcha-worker-entry.ts instead (see
 * captcha-worker-dispatch.ts). Importers must reach it via DYNAMIC import so
 * a source run never parses the attribute.
 */
import entryPath from "./captcha-worker-entry.bundle.js" with { type: "file" };

export default entryPath;
