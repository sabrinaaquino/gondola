// Next.js runs `register()` once when the server process starts. This is our
// gateway daemon bootstrap: start the heartbeat scheduler and auto-start any
// enabled messaging channels so the agent is reachable and proactive without a
// browser tab open. Guarded to the Node.js runtime.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { ensureSchedulerStarted } = await import("./lib/scheduler");
    const { startChannels } = await import("./lib/gateway");
    ensureSchedulerStarted();
    await startChannels().catch(() => undefined);
  } catch {
    // A bootstrap failure must not crash the server; features can be started
    // on demand via their API routes.
  }
}
