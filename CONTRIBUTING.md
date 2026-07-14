# Contributing to Gondola

Thanks for your interest in improving Gondola, a voice and vision AI companion and self-editing terminal harness powered by the [Venice AI](https://venice.ai) API and orchestrated by Pi Agent Core.

This guide covers how to set up the project, the checks to run before opening a pull request, and the conventions we follow.

## Ground rules

- **Venice is the only model provider.** Every model capability (chat, vision, transcription, speech, web search, image, video, music, embeddings) must go through the Venice API. Please do not add other inference providers.
- **Keep it local-first and private.** User data (conversations, memory, transcripts, vectors, keys) stays on the user's machine under `.gondola/` and `.env.local`. Never send it anywhere else, and never commit it.
- **No secrets in the repo.** `.env.local`, `.gondola/`, and personal exports are git-ignored. Double-check `git status` before committing.

## Prerequisites

- Node.js 20 or newer (the code relies on `AbortSignal.any`, `AbortSignal.timeout`, and `structuredClone`).
- A Venice inference API key.

## Local setup

```bash
git clone https://github.com/sabrinaaquino/gondola.git
cd gondola
npm install --ignore-scripts
cp .env.example .env.local   # then add your VENICE_API_KEY
```

Run the web companion:

```bash
npm run dev
```

Run the terminal harness:

```bash
npm run harness
```

## Before you open a pull request

Please make sure all of these pass:

```bash
npm run typecheck   # tsc --noEmit, must be clean
npm test            # node --test over src/lib/*.test.ts
```

If you changed UI, do a quick manual pass in `npm run dev`. If you touched the harness, sanity-check it with `npm run harness`.

## Project layout

| Path | What lives there |
| --- | --- |
| `src/app/` | Next.js web companion (UI, API routes, streaming) |
| `src/cli/` | Terminal harness (`main.ts`, REPL, coding and Venice tools) |
| `src/lib/` | Shared core: Venice client, memory, model/stream setup, skills, MCP, sub-agents, search, compaction |
| `src/components/` | React components for the web UI |
| `bin/nova.mjs` | Entry point for the `nova` command |
| `public/` | Static assets |

Conversations, agents, memory, skills, connections, automations, and generated media persist locally under `.gondola/` (git-ignored).

## Coding conventions

- **TypeScript, strict.** No `any` unless truly unavoidable; prefer precise types. Keep `npm run typecheck` clean.
- **React:** function components and hooks. Keep client state minimal and colocated.
- **Style:** match the surrounding code. Favor small, focused functions and clear names over cleverness. Avoid em dashes and ampersands in user-facing copy (spell out "and"), matching the existing voice.
- **Comments** explain intent and trade-offs, not the obvious. Do not narrate the code.
- **Safety:** file and shell tools are confined and gated behind confirmation for destructive actions. Preserve those guardrails. Never weaken the sandbox or auto-confirm destructive operations.
- **No debug cruft.** Remove temporary logging and instrumentation before submitting.

## Commits and pull requests

- Keep PRs small and focused on one change. Large, mixed PRs are hard to review.
- Write commit messages that explain the "why," not just the "what."
- Fill out the pull request template: summary, related issue, how you tested it, and the checklist.
- Link the issue your PR addresses (`Closes #123`).

## Reporting bugs and requesting features

Open an issue using the templates under **Issues**. For bugs, include steps to reproduce, what you expected, what happened, and your OS and Node version. For features, describe the problem you are trying to solve, not just the solution you have in mind.

## Security

Do not open a public issue for security problems. Instead, report them privately to the maintainer via a GitHub security advisory or direct message. Never include API keys or personal data in issues, PRs, or logs.

## Code of conduct

By participating you agree to uphold our [Code of Conduct](./CODE_OF_CONDUCT.md).
