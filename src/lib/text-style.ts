/**
 * Keep assistant conversation copy aligned with the app's punctuation style.
 * A comma is the least disruptive replacement for an em dash in natural prose.
 */
export function removeEmDashes(text: string): string {
  return text
    .replace(/&mdash;/gi, "\u2014")
    .replace(/^[ \t]*\u2014[ \t]*/gm, "")
    .replace(/[ \t]*\u2014[ \t]*$/gm, "")
    .replace(/[ \t]*\u2014[ \t]*/g, ", ")
    .replace(/,\s*([,.;:!?])/g, "$1");
}
