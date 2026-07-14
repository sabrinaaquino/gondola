import type { Harness } from "./harness";
import type { HarnessRenderer } from "./render";

/**
 * Run one user turn with automatic model fallback.
 *
 * The currently selected model is tried first (so a user's `/model` choice is
 * honored), then the remaining harness models in order. A failed attempt that
 * produced no visible text is rolled back and retried on the next model; once
 * text has streamed we stop retrying to avoid printing a partial answer twice.
 *
 * Returns true if the turn completed successfully.
 */
export async function runTurn(harness: Harness, renderer: HarnessRenderer, text: string): Promise<boolean> {
  const { agent } = harness;
  const current = harness.currentModel();
  const candidates = [current, ...harness.models.filter((model) => model !== current)];

  for (const model of candidates) {
    harness.setModel(model);
    const startIndex = agent.state.messages.length;
    renderer.beginAttempt();

    try {
      await agent.prompt(text);
    } catch (error) {
      renderer.lastError = error instanceof Error ? error.message : "The turn failed unexpectedly.";
    }

    const erroredMessage = agent.state.messages
      .slice(startIndex)
      .some((message) => message.role === "assistant" && message.stopReason === "error");
    const failed = Boolean(renderer.lastError) || erroredMessage;

    if (!failed) {
      renderer.flush();
      return true;
    }
    if (renderer.sawText) break; // Retrying now would double the partial output.
    agent.state.messages = agent.state.messages.slice(0, startIndex); // Roll back and fall back.
  }

  renderer.error(renderer.lastError || "Venice is temporarily unavailable after trying every model.");
  return false;
}
