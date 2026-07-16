import type { LabConfig, WorkflowPolicy } from "./types";

// Turn a workflow policy into concrete behavioral directives.
//
// This is the shared "harness-benefit" surface: the SAME translation is used by
// (a) the Lab's live evaluation runner, so a challenger config actually behaves
// differently from the champion, and (b) the live agent's system prompt, so a
// promoted policy actually changes what Entity does. Without a shared instantiation
// like this, an evaluation would only prove that two version ids ran, not that two
// behaviorally distinct harnesses ran (Harness Updating != Harness Benefit).

export function policyDirectives(policy: WorkflowPolicy | undefined): string[] {
  if (!policy) return [];
  const lines: string[] = [];
  if (policy.requireAnalyzeBeforeAnimate) {
    lines.push("Before animating an image (calling generate_video from an image), you MUST first call analyze_media on that image and use the result. Never animate an image you have not inspected.");
  }
  if (policy.useSeparateCritic) {
    lines.push("Use a distinct critic step: after producing a candidate, review it (for example with analyze_media) and only keep it if it holds up.");
  }
  if (policy.conceptCount > 1) {
    lines.push(`Generate ${policy.conceptCount} distinct low-cost concepts first, then choose the single strongest one to develop.`);
  }
  if (policy.reviseBelowQuality !== null && policy.maxRevisions > 0) {
    lines.push(`If the result is below ${policy.reviseBelowQuality}/10 quality, revise it up to ${policy.maxRevisions} time(s) before finishing.`);
  }
  return lines;
}

/**
 * Render a workflow policy as a system-prompt block, or "" when the policy adds
 * no directives (so callers can drop it cleanly). Empty when there is no config,
 * keeping every caller a no-op until a policy is actually in force.
 */
export function policyPromptBlock(config: LabConfig | undefined): string {
  const lines = policyDirectives(config?.workflowPolicy);
  if (!lines.length) return "";
  return ["# Active workflow policy (promoted by Gondola Lab)", ...lines.map((line) => `- ${line}`)].join("\n");
}
