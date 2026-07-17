/**
 * Conservative client-side classifier for the bounded persistence loop. It is
 * intentionally limited to explicit action verbs so ordinary conversation,
 * questions, approvals and paid media do not unexpectedly create repeat turns.
 */
export function shouldPersistTask(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (text.length < 12 || text.startsWith("/")) return false;
  if (/^(yes|no|ok(?:ay)?|thanks?|thank you|hello|hi|hey)\b[.!?]*$/.test(text)) return false;
  if (/\b(image|video|music|song|soundscape)\b/.test(text) && /\b(generate|create|make|compose|animate)\b/.test(text)) return false;
  if (/\b(confirm|approve|allow|deny|permission)\b/.test(text) && text.split(/\s+/).length < 18) return false;
  return /\b(fix|implement|build|change|update|install|configure|refactor|debug|repair|migrate|deploy|publish|organize|rename|move|delete|create|write|edit|run|test|verify|research|investigate|analyze|audit|review|complete|finish)\b/.test(text);
}
