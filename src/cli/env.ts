import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Minimal .env loader for the CLI harness. The web app relies on Next.js to load
 * `.env.local`, but the terminal harness runs under plain Node/tsx, so we load it
 * ourselves. Values already present in the real environment win.
 */
export function loadEnv(cwd = process.cwd()): void {
  for (const file of [".env.local", ".env"]) {
    let raw: string;
    try {
      raw = readFileSync(path.join(cwd, file), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key || key in process.env) continue;
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}
