import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Valid document ID pattern: lowercase letters, digits, hyphens, separated by slashes */
export const ID_PATTERN = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/;

/** Six months in milliseconds (used for staleness checks) */
export const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;

/** Valid document types */
export const VALID_TYPES = ["summary", "detail", "decision", "reference"] as const;

/** Package version, read from package.json */
export const VERSION: string = (() => {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(thisDir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
})();
