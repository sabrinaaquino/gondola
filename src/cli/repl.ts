import readline from "node:readline";
import type { Harness } from "./harness";
import type { HarnessRenderer } from "./render";
import { runSlashCommand, type CommandContext } from "./commands";
import { runTurn } from "./turn";
import { PROMPT, theme } from "./theme";

function banner(harness: Harness): string {
  return [
    "",
    theme.bold("  Venice Harness") + theme.dim("  ·  a self-editing agentic coding harness"),
    theme.dim(`  cwd: ${harness.cwd}`),
    theme.dim(`  model: ${harness.currentModel()}  ·  Venice + Pi`),
    theme.dim("  type a request, or /help. Ctrl-C aborts, twice exits."),
    "",
    "",
  ].join("\n");
}

/** Interactive terminal loop for a TTY session. Resolves when the user exits. */
export function startInteractive(harness: Harness, renderer: HarnessRenderer): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let busy = false;
  let interruptArmed = false;
  let exiting = false;

  const ctx: CommandContext = {
    harness,
    renderer,
    requestExit: () => {
      exiting = true;
      rl.close();
    },
  };

  const showPrompt = () => {
    if (!exiting) {
      rl.setPrompt(PROMPT);
      rl.prompt();
    }
  };

  renderer.write(banner(harness));
  showPrompt();

  rl.on("line", (raw) => {
    const line = raw.trim();
    if (busy || exiting) return;
    if (!line) {
      showPrompt();
      return;
    }
    interruptArmed = false;

    if (line.startsWith("/")) {
      runSlashCommand(line, ctx);
      showPrompt();
      return;
    }

    busy = true;
    rl.pause();
    void runTurn(harness, renderer, line).finally(() => {
      busy = false;
      rl.resume();
      showPrompt();
    });
  });

  rl.on("SIGINT", () => {
    if (busy) {
      harness.agent.abort();
      renderer.notice("^C aborted");
      return;
    }
    if (interruptArmed) {
      exiting = true;
      rl.close();
      return;
    }
    interruptArmed = true;
    renderer.write(theme.dim("\n  press Ctrl-C again to exit\n"));
    showPrompt();
  });

  return new Promise<void>((resolve) => {
    rl.on("close", () => {
      renderer.write(theme.dim("\n  goodbye.\n"));
      resolve();
    });
  });
}

/** Run a single prompt non-interactively (argv or piped stdin). Returns an exit code. */
export async function runOneShot(harness: Harness, renderer: HarnessRenderer, prompt: string): Promise<number> {
  const abort = () => harness.agent.abort();
  process.on("SIGINT", abort);
  try {
    const ok = await runTurn(harness, renderer, prompt);
    renderer.flush();
    return ok ? 0 : 1;
  } finally {
    process.off("SIGINT", abort);
  }
}
