function resolveUserTimeZone(): string {
  const candidates = [
    process.env.NOVA_TIME_ZONE,
    process.env.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    "UTC",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
      return candidate;
    } catch {
      // Ignore an invalid environment override and continue to a safe fallback.
    }
  }
  return "UTC";
}

export const USER_TIME_ZONE = resolveUserTimeZone();

const LIVE_WEB_PATTERN = /(?:https?:\/\/\S+|\b(?:search(?: the)? web|search online|look (?:it |this )?up|find online|browse|research|latest|current|currently|today|tomorrow|tonight|right now|live|recent|newest|up[ -]?to[ -]?date|breaking|news|weather|forecast|price|prices|exchange rate|score|scores|result|results|winner|schedule|fixture|standings|lineup|lineups|odds|next (?:game|match|event|flight)|election|president|prime minister|ceo|law|laws|regulation|regulations|recommend|recommendation|trending|viral|outage|open now|near me|in stock|availability|release date|changelog)\b)/i;
const LIVE_WEB_QUESTION_PATTERN = /\b(?:what (?:happened|changed|just happened|are people saying)|who (?:won|is leading)|when (?:is|are|does|do|will) (?:the )?(?:next|latest|new|upcoming)|where (?:is|are|will) (?:the )?(?:next|latest|new|upcoming)|is .{0,50} (?:still available|available now|open|down|online)|has .{0,50} (?:released|launched|changed|shipped)|on x|on twitter|social sentiment)\b/i;
const LIVE_SOFTWARE_PATTERN = /\b(?:api|sdk|library|framework|package|model|software|service)\b.{0,80}\b(?:docs?|documentation|version|release|availability|available|deprecated|deprecation|pricing|limits?|status|update|support(?:ed|s)?)\b/i;
const CLOCK_QUERY_PATTERN = /\b(?:(?:what(?:'s| is)|tell me|give me)\s+(?:the\s+)?(?:current\s+)?(?:date(?: and time)?|time|day)|what\s+(?:date|time|day)\s+is\s+it|current\s+(?:date(?: and time)?|time))\b/i;
const EXPLICIT_WEB_REQUEST_PATTERN = /(?:https?:\/\/\S+|\b(?:search(?: the)? web|search online|look (?:it |this )?up online|find online|browse(?: the)? web|internet|on x|on twitter)\b)/i;
const LOCAL_FILE_REFERENCE_PATTERN = /(?:^|[\s`'"(])(?:\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)*\.(?:md|mdx|txt|json|ya?ml|toml|tsx?|jsx?|mjs|cjs|css|scss|html?|py|rb|rs|go|java|kt|swift|sh|zsh|fish|sql|csv|xml|svg|env)(?=$|[\s`'"),:;?!])/i;
const LOCAL_FILE_ACTION_PATTERN = /\b(?:read|open|inspect|check|review|summari[sz]e|explain|edit|change|update|write|fix|debug|look at|take a look at)\b/i;

export function isLocalFileRequest(message: string): boolean {
  return LOCAL_FILE_REFERENCE_PATTERN.test(message)
    && LOCAL_FILE_ACTION_PATTERN.test(message)
    && !EXPLICIT_WEB_REQUEST_PATTERN.test(message);
}

export function needsLiveWebResearch(message: string): boolean {
  const withoutClockQuestion = message.replace(CLOCK_QUERY_PATTERN, "");
  if (isLocalFileRequest(withoutClockQuestion)) return false;
  return LIVE_WEB_PATTERN.test(withoutClockQuestion)
    || LIVE_WEB_QUESTION_PATTERN.test(withoutClockQuestion)
    || LIVE_SOFTWARE_PATTERN.test(withoutClockQuestion);
}

export function currentDateTimeContext(now = new Date()): string {
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: USER_TIME_ZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(now);
  return `The user's current local date and time is ${local} (${USER_TIME_ZONE}). The current UTC timestamp is ${now.toISOString()}. Treat this clock as authoritative for relative dates and times.`;
}
