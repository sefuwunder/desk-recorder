// desk-recorder: deterministic to-do extraction from transcripts.
// Pure heuristic — no LLM, no network, no dependencies.
// Conservative by design: it would rather miss a borderline item than
// flood the list with false positives.

/** Imperative verbs that open an actionable sentence ("Call the dentist"). */
const IMPERATIVE_VERBS = new Set([
  "add", "answer", "apply", "approve", "arrange", "ask", "book", "bring", "build",
  "buy", "call", "cancel", "change", "check", "clean", "clear", "close",
  "collect", "confirm", "contact", "create", "decide", "delete", "deliver",
  "design", "do", "draft", "draw", "drop", "edit", "email", "fax", "file",
  "fill", "finalize", "find", "finish", "fix", "follow", "forward", "get",
  "handle", "invite", "join", "look", "mail", "make", "meet", "message",
  "move", "order", "organize", "pay", "phone", "pick", "plan", "post",
  "prepare", "print", "proofread", "publish", "push", "read", "record",
  "remind", "remove", "rent", "repair", "reply", "research", "reserve",
  "return", "review", "revise", "schedule", "send", "set", "share", "ship",
  "sign", "skip", "start", "stop", "submit", "sync", "take", "test",
  "text", "try", "update", "upload", "visit", "water", "write",
]);

/** Commitment phrases that can appear anywhere in a sentence. */
const PHRASE_PATTERNS: RegExp[] = [
  /\bneeds?\s+to\b/i,
  /\bhaves?\s+to\b/i, // "have to" / "has to"
  /\bmust\b/i,
  /\blet'?s\b/i,
  /\blet\s+us\b/i,
  /\bdon'?t\s+forget\b/i,
  /\bdo\s+not\s+forget\b/i,
  /\bremember\s+to\b/i,
  /\bremind\s+me\b/i,
  /\baction\s+items?\b/i,
  /\bto[-\s]?dos?\b/i, // "to-do", "to do", "todo", "todos"
  /\bfollow[-\s]?up\b/i,
  /\bmake\s+sure\b/i,
  /\b(?:we|you|i)\s+should\b/i, // "should" only with a subject — keeps it conservative
];

/** Spoken filler and discourse lead-ins at the start of a sentence. Stripped repeatedly. */
const LEADING_FILLER =
  /^(?:um|uh|er|ah|so|well|okay|ok|right|anyway|actually|please|first|second|third|fourth|fifth|finally|next|then|also)[,\s]+/i;

/** Leading action prefixes, stripped so the item reads like a task. */
const ACTION_PREFIX =
  /^(?:(?:i|we|you|they)\s+(?:need\s+to|have\s+to|has\s+to|must)|(?:don'?t|do\s+not)\s+forget\s+to|remind\s+me\s+to|remember\s+to|let'?s|let\s+us|action\s+items?\s*[:\-–]?\s*|to[-\s]?dos?\s*[:\-–]?\s*)\s*/i;

const MAX_ITEM_LEN = 140;
const MIN_ITEM_LEN = 8;

function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const part of line.split(/(?<=[.!?…])\s+/)) {
      const s = part.replace(/[.!?…\s]+$/, "").trim();
      if (s) out.push(s);
    }
  }
  return out;
}

function stripFiller(s: string): string {
  let prev: string;
  do {
    prev = s;
    s = s.replace(LEADING_FILLER, "");
  } while (s !== prev);
  return s;
}

/** True when the sentence looks like an actionable commitment. */
function isActionable(raw: string): boolean {
  const s = stripFiller(raw);
  if (!s) return false;
  const first = s.split(/\s+/, 1)[0].toLowerCase().replace(/[^a-z']/g, "").replace(/'s$/, "");
  if (IMPERATIVE_VERBS.has(first)) return true;
  return PHRASE_PATTERNS.some((re) => re.test(s));
}

/** Normalize an actionable sentence into a displayable to-do item. */
function cleanItem(raw: string): string {
  let s = stripFiller(raw.replace(/\s+/g, " ").trim());
  s = s.replace(ACTION_PREFIX, "").trim().replace(/[.,;:!?…\-–]+$/, "").trim();
  if (!s) return "";
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (s.length > MAX_ITEM_LEN) s = s.slice(0, MAX_ITEM_LEN - 1).trimEnd() + "…";
  return s;
}

/**
 * Extract to-do items from a transcript. Returns cleaned, de-duplicated
 * strings (case/whitespace-insensitive dedupe), in transcript order.
 * Empty/short transcripts and plain narrative yield an empty list.
 */
export function extractTodos(transcript: string): string[] {
  if (!transcript || !transcript.trim()) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of splitSentences(transcript)) {
    if (/\?\s*$/.test(raw)) continue; // questions are not commitments
    if (!isActionable(raw)) continue;
    const item = cleanItem(raw);
    if (item.length < MIN_ITEM_LEN || item.split(/\s+/).length < 2) continue;
    if (!/\p{L}/u.test(item)) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
