import { loadEnv } from "./env";
import { createHarness } from "./harness";
import { HarnessRenderer } from "./render";
import { runOneShot, startInteractive } from "./repl";
import { theme } from "./theme";

loadEnv();

// Don't crash if the reader (e.g. `| head`) closes the pipe early.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
});

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  if (!process.env.VENICE_API_KEY) {
    console.error(theme.red("VENICE_API_KEY is not set."));
    console.error(theme.dim("Add it to .env.local (see .env.example) or export it, then run again."));
    process.exit(1);
  }

  const harness = await createHarness();
  const renderer = new HarnessRenderer(harness.agent);

  // Dispatch: `nova "prompt"` (argv) and piped stdin run one-shot and exit;
  // an attached TTY starts the interactive loop.
  const argvPrompt = process.argv.slice(2).join(" ").trim();
  if (argvPrompt) {
    process.exit(await runOneShot(harness, renderer, argvPrompt));
  }

  if (!process.stdin.isTTY) {
    const piped = await readStdin();
    if (piped) {
      process.exit(await runOneShot(harness, renderer, piped));
    }
    console.error(theme.dim("No input. Pass a prompt as an argument, pipe one in, or run in an interactive terminal."));
    process.exit(1);
  }

  await startInteractive(harness, renderer);
}

main().catch((error) => {
  console.error(theme.red(error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exit(1);
});
