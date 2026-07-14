#!/usr/bin/env node
// Thin launcher for the Venice harness. Runs the TypeScript CLI through the
// locally installed tsx, preserving the caller's working directory so the
// harness operates on (and can edit) whatever project it is launched from.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "src", "cli", "main.ts");

// Run through Node's tsx import hook (no separate tsx supervisor process).
const child = spawn(process.execPath, ["--import", "tsx", entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
});
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (error) => {
  console.error("Failed to launch the Venice harness:", error.message);
  console.error('Run "npm install" in the project, then "npm run harness".');
  process.exit(1);
});
