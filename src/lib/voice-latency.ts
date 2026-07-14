export interface EarlySpeechSegment {
  segment: string;
  rest: string;
}

/**
 * Pull one natural opening segment from a response that is still streaming.
 * Wait until the next sentence has started so an abbreviation at the end of
 * the latest network chunk is not mistaken for a finished thought. Very long
 * opening sentences may break at a comma so voice never waits indefinitely.
 */
export function takeEarlySpeechSegment(text: string): EarlySpeechSegment | undefined {
  const leadingWhitespace = text.length - text.trimStart().length;
  const content = text.slice(leadingWhitespace);
  if (!content) return undefined;

  const sentenceBoundary = /[.!?]["')\]]*\s+(?=[\p{Lu}\p{N}"'“‘*-])/gu;
  let match: RegExpExecArray | null;
  while ((match = sentenceBoundary.exec(content))) {
    const end = match.index + match[0].trimEnd().length;
    const segment = content.slice(0, end).trim();
    if (segment.length >= 24 || segment.split(/\s+/).length >= 5) {
      return { segment, rest: content.slice(end).trimStart() };
    }
  }

  if (content.length < 190) return undefined;
  const window = content.slice(0, 175);
  const preferredBreaks = [...window.matchAll(/[,;:]\s+/g)];
  const preferred = preferredBreaks.reverse().find((candidate) => candidate.index !== undefined && candidate.index >= 90);
  const end = preferred?.index !== undefined
    ? preferred.index + preferred[0].trimEnd().length
    : window.lastIndexOf(" ");
  if (end < 80) return undefined;
  return { segment: content.slice(0, end).trim(), rest: content.slice(end).trimStart() };
}
