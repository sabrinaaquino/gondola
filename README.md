# Gondola

**One Venice API key. A self-editing coding agent that also sees, listens, speaks, and creates.**

An agentic **coding harness** that runs in your terminal, like OpenCode, powered entirely by the [Venice AI](https://venice.ai) API and orchestrated by Pi Agent Core. It reads, writes, edits, and runs code in its working directory, so when launched inside its own repository it can **improve and edit itself**. It also keeps the companion's Venice capabilities: live web research, seeing images, generating image, video, music, and speech, plus durable local memory.

The same codebase also ships the **web companion** (Gondola): a voice and vision chat with an animated presence, a media tray, an agent workspace, one-click connections, and scheduled automations, for when you want the rich UI.

## Requirements

- Node.js 20+ (the harness and app use `AbortSignal.any`, `AbortSignal.timeout`, and `structuredClone`)
- A Venice inference API key

## Setup

1. Install dependencies:

   ```bash
   npm install --ignore-scripts
   ```

2. Create `.env.local` from `.env.example` and add your Venice inference key:

   ```bash
   cp .env.example .env.local
   ```

   ```bash
   # .env.local
   VENICE_API_KEY=your_venice_inference_key
   ```

   `.env.example` also documents two optional, server-only keys: `VENICE_ADMIN_KEY` (surfaces account balance and usage analytics in the API X-Ray) and `TELEGRAM_BOT_TOKEN` (enables the Telegram channel, which you can also paste directly in the UI).

## Run the terminal harness

```bash
npm run harness
```

or, after `npm link`, run the `nova` command from any project directory:

```bash
nova
```

You get an interactive agentic loop in the terminal. Type a request in plain language and the harness investigates, edits files, and runs commands to carry it out. It operates on the **current working directory**, so running it inside this repo lets it edit its own source; running it in another project turns it into a general coding agent.

Slash commands: `/help`, `/model [id]`, `/models`, `/tools`, `/cwd`, `/reset`, `/clear`, `/exit`. Press Ctrl-C once to abort the current turn, twice to exit.

### Harness tools

- **Coding:** `read_file`, `write_file`, `edit_file`, `list_dir`, `search_code` (ripgrep), `run_shell`, with real read, write, and execution scoped to the working directory.
- **Venice capabilities:** `search_web` (grounded live research), `analyze_image` (see an image file), `generate_image` / `generate_video` / `generate_music`, and `speak` (text-to-speech played locally).
- **Memory:** `memory` and `search_memory` for durable local facts.

The harness streams replies as it works and prints each tool call and result. If the primary Venice model is unavailable it automatically falls back to the next compatible model. Generated media is saved under `.gondola/media/`.

## Run the web companion

```bash
npm run dev
```

Open the local address printed in the terminal. Allow microphone or camera access only when you want to use those features. The inference key stays on the server and is never shipped to the browser.

## What it does

### Voice
- Hands-free voice mode with automatic end-of-turn detection. Just start talking, pause naturally, and it responds.
- Press-to-dictate for typing with your voice.
- Pipeline: Venice speech-to-text → Pi agent → Venice text-to-speech, with streaming replies and progressive audio so it starts speaking before the full answer is generated.
- Configurable voice, speed, and optional emotion-directed delivery; interrupt at any time.

### Vision
- Optional camera awareness: it samples frames (and short motion clips in talkative mode) to notice gestures, expressions, and things you show it. In text mode these observations arrive as written notes; it only speaks them aloud during a voice session, so turning on the camera never starts it talking on its own.
- An abstract animated presence reacts and reshapes its form, palette, and motion to match the moment.
- Ask what it sees, and it inspects the latest frame. It never claims a continuous live feed.

### Creation
- Generate images, video, and music through Venice, collected in an in-app media tray.
- Potentially expensive video and music jobs are quoted first and only run automatically under a configurable spend threshold; above it, the agent asks you to confirm the exact price.

### Knowledge and memory
- Grounded live web search through Venice for current, changing information (news, scores, schedules, prices, weather), with source links.
- Typed long-term memory (bio, preferences, important notes, projects, relationships, environment, and the agent's own identity) that persists locally, with optional auto-capture and an approval workflow you control from the Memory tab.
- Long conversations are automatically compacted so context stays coherent over time.

### Reasoning
- For reasoning-capable models, typed chats can surface the model's live thinking in a collapsible trace (similar to Cursor or ChatGPT), so you can watch how it works through a request.
- Voice, vision, and background turns skip the trace to stay fast.

### Workspace
- **Agents vs chats:** a regular chat uses your shared personal memory. An agent is a separate, reusable persona with its own name, description, instructions, skills, and MCP servers, plus an optional isolated memory so it only sees its own private notes (with isolation off it still reads your personal memory, so it knows who you are).
- Revisit or delete past chats from the history, and switch the conversation model from the picker (staff, beta, and offline models are hidden).
- **Connections:** link Telegram (message your agent from your phone, running through the same queue and memory as the browser) and one-click MCP integrations (Gmail, Google Calendar, Slack, Notion, GitHub, Linear) or any custom HTTP/stdio MCP server.
- **Automations:** schedule prompts that run on their own cadence, even with no tab open, and deliver the result to the conversation or to Telegram.

## Why Pi is here

Pi Agent Core is the orchestration harness. It manages the conversation loop, streaming events, tool calls, memory, compaction, and sub-agents. It does not replace Venice. Every model capability, including chat, vision, transcription, speech, web search, image, video, and music, goes through the Venice API.

## Architecture

Two front ends share one Venice + Pi core:

- **Terminal harness** (`src/cli/`, launched by `bin/nova.mjs`): a Pi `Agent` loop over Pi's `NodeExecutionEnv`, which provides the sandboxed working-directory filesystem and shell that the coding tools build on. It runs directly on Node via `tsx`, with no server or browser.
- **Web companion** (`src/app/`): the browser handles the UI, webcam/mic capture, and audio playback; local Next.js API routes keep the Venice key private and stream agent events back as newline-delimited JSON.
- Both reuse the same libraries in `src/lib/` (Venice client, memory, model/stream setup, skills, MCP).
- Conversations, agents, memory, skills, connections, automations, and generated media persist locally under `.gondola/` (git-ignored).

## Reliability

- Web search is grounded, generic, and time-bounded, with no hardcoded topics or endpoints.
- API routes validate input and cap request/upload sizes (messages, frames, motion clips, audio).
- Closing a request or tab aborts the in-flight Venice work so nothing keeps running or spending in the background.
- The webcam is captured on demand rather than recorded continuously, reducing CPU and cost.
- Object URLs, audio buffers, in-memory caches, and agent sessions are bounded and cleaned up.
- Malformed stream lines are skipped instead of ending a turn, and React error boundaries keep a single failure from taking down the app.

## Practical limits and safety

- The harness runs shell commands and edits files in its working directory autonomously. It is instructed to avoid destructive actions and never touch secrets, but you should run it on code you have under version control and review its diffs.
- Vision is sampled rather than continuous video streaming, which keeps it responsive and inexpensive.
- Voice uses a transcription → agent → speech pipeline rather than full-duplex realtime audio.
- Video and music jobs are asynchronous and can consume meaningful Venice credits, so the agent quotes first.
- This is a local, single-user tool, not a production security or multi-tenant deployment.

## Roadmap

The Telegram channel and scheduled automations described above are now wired into the web companion, backed by `src/lib/gateway.ts`, `scheduler.ts`, and `channels-store.ts`. See [PLAN.md](./PLAN.md) for the product and implementation plan.
