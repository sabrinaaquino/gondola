// Gondola automated PR reviewer.
//
// A self-contained Node script (no repo dependencies, no build) that reads a
// pull request's diff, asks a Venice model for a focused code review, and posts
// (or updates) a single review comment on the PR. Runs from GitHub Actions.
//
// Required env: VENICE_API_KEY, GITHUB_TOKEN, REPO ("owner/name"), PR_NUMBER.
// Optional env: VENICE_REVIEW_MODEL.

const VENICE_API_KEY = process.env.VENICE_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.REPO;
const PR_NUMBER = process.env.PR_NUMBER;
const PRIMARY_MODEL = (process.env.VENICE_REVIEW_MODEL || "zai-org-glm-5-2").trim();
const FALLBACK_MODEL = "qwen3-5-35b-a3b";

const MARKER = "<!-- gondola-ai-review -->";
const MAX_DIFF_CHARS = 55_000;
const GITHUB_API = "https://api.github.com";
const VENICE_API = "https://api.venice.ai/api/v1";

// Advisory reviewer: never block the PR on our own failure.
function skip(message) {
  console.log(`[gondola-review] ${message}`);
  process.exit(0);
}

if (!VENICE_API_KEY) skip("VENICE_API_KEY is not set; skipping review. Add it as a repository secret to enable Gondola PR review.");
if (!GITHUB_TOKEN || !REPO || !PR_NUMBER) skip("Missing GITHUB_TOKEN, REPO, or PR_NUMBER; skipping review.");

function githubHeaders(accept = "application/vnd.github+json") {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "gondola-pr-reviewer",
  };
}

async function github(path, init = {}) {
  const response = await fetch(`${GITHUB_API}${path}`, { ...init, headers: { ...githubHeaders(init.accept), ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  return response;
}

async function getPullRequest() {
  const meta = await (await github(`/repos/${REPO}/pulls/${PR_NUMBER}`)).json();
  const diff = await (await github(`/repos/${REPO}/pulls/${PR_NUMBER}`, { accept: "application/vnd.github.v3.diff" })).text();
  return { meta, diff };
}

async function upsertComment(body) {
  const comments = await (await github(`/repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100`)).json();
  const existing = Array.isArray(comments) ? comments.find((comment) => typeof comment.body === "string" && comment.body.includes(MARKER)) : undefined;
  if (existing) {
    await github(`/repos/${REPO}/issues/comments/${existing.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) });
    console.log(`[gondola-review] updated review comment ${existing.id}`);
  } else {
    await github(`/repos/${REPO}/issues/${PR_NUMBER}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) });
    console.log("[gondola-review] created review comment");
  }
}

const SYSTEM_PROMPT = `You are Gondola's automated code reviewer for a TypeScript / Next.js repository (a Venice-powered AI agent app). Review only the provided unified diff.

Focus on what matters and what a linter cannot catch:
- Correctness bugs, logic errors, off-by-one, wrong conditionals, and unhandled edge cases.
- Security issues: injection, path traversal, SSRF, leaked secrets or tokens, unsafe use of untrusted input, missing auth checks.
- Concurrency and resource problems: races, unawaited promises, leaks, missing cleanup or abort handling.
- Error handling, input validation, and API/contract mismatches.
- Adherence to clear repo conventions visible in the diff.

Rules:
- Be concise and specific. Reference file paths and the relevant code. Do not restate what the PR does at length.
- Skip pure formatting and style nits that tooling handles.
- Only raise an issue you can justify from the diff. Do not speculate about code you cannot see. If unsure, say so briefly.
- If nothing is wrong, say so plainly.

Respond in GitHub-flavored markdown with exactly these sections:
### Summary
One or two sentences.
### Blocking issues
Must-fix correctness or security problems, each as a bullet with the file and a short explanation. Write "None." if there are none.
### Suggestions
Non-blocking improvements. Write "None." if there are none.
### Nitpicks
Optional minor notes. Write "None." if there are none.

End with a single line: **Verdict:** followed by one of "Looks good", "Approve with comments", or "Request changes".`;

async function reviewWithVenice(prompt) {
  const models = [...new Set([PRIMARY_MODEL, FALLBACK_MODEL])];
  let lastError;
  for (const model of models) {
    try {
      const response = await fetch(`${VENICE_API}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${VENICE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          max_completion_tokens: 1600,
          temperature: 0.2,
          venice_parameters: { enable_web_search: "off", disable_thinking: true, strip_thinking_response: true },
        }),
      });
      if (!response.ok) {
        lastError = new Error(`Venice ${model} failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
        continue;
      }
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content?.trim();
      if (content) return { content, model };
      lastError = new Error(`Venice ${model} returned an empty review.`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Venice review failed.");
}

async function main() {
  const { meta, diff } = await getPullRequest();

  if (meta.draft) skip("PR is a draft; skipping review.");
  if (!diff.trim()) {
    await upsertComment(`${MARKER}\n## Gondola review\n\nNo code changes to review.`);
    return;
  }

  const truncated = diff.length > MAX_DIFF_CHARS;
  const diffForModel = truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff;
  const prompt = [
    `Pull request: ${meta.title ?? "(untitled)"}`,
    meta.body ? `\nDescription:\n${String(meta.body).slice(0, 2_000)}` : "",
    `\nChanged files: ${meta.changed_files ?? "?"} (+${meta.additions ?? "?"} / -${meta.deletions ?? "?"})`,
    truncated ? `\nNote: the diff was truncated to the first ${MAX_DIFF_CHARS} characters; review what is shown and say so.` : "",
    `\nUnified diff:\n\n\`\`\`diff\n${diffForModel}\n\`\`\``,
  ].filter(Boolean).join("\n");

  let review;
  try {
    review = await reviewWithVenice(prompt);
  } catch (error) {
    await upsertComment(`${MARKER}\n## Gondola review\n\nThe automated review could not run this time: ${error instanceof Error ? error.message : "unknown error"}.`).catch(() => undefined);
    skip(`review failed: ${error instanceof Error ? error.message : error}`);
    return;
  }

  const footer = [
    "",
    "---",
    `<sub>Automated review by Gondola via Venice (\`${review.model}\`). Advisory only; a human still decides.${truncated ? " Diff truncated." : ""}</sub>`,
  ].join("\n");
  await upsertComment(`${MARKER}\n## Gondola review\n\n${review.content}\n${footer}`);
}

main().catch((error) => skip(`unexpected error: ${error instanceof Error ? error.message : error}`));
