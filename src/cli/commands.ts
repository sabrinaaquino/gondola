import type { Harness } from "./harness";
import type { HarnessRenderer } from "./render";
import { theme } from "./theme";

export interface CommandContext {
  harness: Harness;
  renderer: HarnessRenderer;
  /** Ask the REPL to shut down (used by /exit). */
  requestExit(): void;
}

interface SlashCommand {
  name: string;
  aliases?: string[];
  summary: string;
  run(argument: string, ctx: CommandContext): void;
}

const COMMANDS: SlashCommand[] = [
  {
    name: "help",
    summary: "show this help",
    run(_argument, { renderer }) {
      const rows = COMMANDS.map((command) => {
        const names = [command.name, ...(command.aliases ?? [])].map((name) => `/${name}`).join(", ");
        return `  ${names.padEnd(18)}${command.summary}`;
      });
      renderer.write(theme.dim(`${rows.join("\n")}\n`));
    },
  },
  {
    name: "model",
    summary: "show or switch the active Venice model",
    run(argument, { harness, renderer }) {
      if (argument) {
        harness.setModel(argument);
        renderer.info(`model → ${argument}`);
      } else {
        renderer.info(`model: ${harness.currentModel()}`);
      }
    },
  },
  {
    name: "models",
    summary: "list the fallback models",
    run(_argument, { harness, renderer }) {
      renderer.info(harness.models.join(", "));
    },
  },
  {
    name: "tools",
    summary: "list the available tools",
    run(_argument, { harness, renderer }) {
      renderer.info(harness.tools.map((tool) => tool.name).join(", "));
    },
  },
  {
    name: "cwd",
    summary: "show the working directory",
    run(_argument, { harness, renderer }) {
      renderer.info(harness.cwd);
    },
  },
  {
    name: "reset",
    summary: "clear the conversation transcript",
    run(_argument, { harness, renderer }) {
      harness.agent.reset();
      renderer.info("conversation cleared.");
    },
  },
  {
    name: "clear",
    summary: "clear the screen",
    run() {
      console.clear();
    },
  },
  {
    name: "exit",
    aliases: ["quit"],
    summary: "leave the harness",
    run(_argument, { requestExit }) {
      requestExit();
    },
  },
];

const LOOKUP = new Map<string, SlashCommand>(
  COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])].map((name) => [name, command] as const)),
);

/** Parse and dispatch a `/command args` line. Returns false for unknown commands. */
export function runSlashCommand(line: string, ctx: CommandContext): boolean {
  const [name, ...rest] = line.slice(1).trim().split(/\s+/);
  const command = LOOKUP.get(name.toLowerCase());
  if (!command) {
    ctx.renderer.notice(`unknown command: /${name} (try /help)`);
    return false;
  }
  command.run(rest.join(" "), ctx);
  return true;
}
