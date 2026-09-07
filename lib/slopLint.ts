// The slop linter — does the output actually follow the rules the prompt states?
//
// Until now the banned-word list existed only as prompt text. Nothing checked
// whether the model obeyed it, so a violation shipped silently and a regression
// in the prompt was invisible. This file is the check, and it is also the single
// source of the list: lib/promptBuilders.ts imports BANNED_PHRASES from here so
// the rule the model is given and the rule it is measured against cannot drift.
//
// Two kinds of check live here, and they are not equally trustworthy.
//
//   Lexical    A banned phrase, an em dash, an emoji. Objective: the string is
//              either there or it is not. These carry real weight.
//   Structural Sentence-length uniformity, repeated openers, symmetric framing.
//              These are the tells that survive a clean ban list — machine prose
//              gives itself away by rhythm long before vocabulary. They are also
//              noisy on short text, so the thresholds are set to fire only on
//              clear cases and they carry less weight.
//
// Everything is pure and synchronous. No I/O, no model call.

export type Severity = "high" | "medium" | "low";

export interface SlopFinding {
  /** Stable identifier, safe to branch on. */
  rule: string;
  severity: Severity;
  /** One sentence, written to be shown to a person. */
  message: string;
  /** Which part of the piece, e.g. "cover" or "slide 2". */
  where?: string;
  /** The offending text itself, so the finding can be acted on without hunting. */
  evidence?: string;
}

export interface SlopReport {
  /** 0 to 100. Higher is more human. Not a truth, a nudge. */
  score: number;
  findings: SlopFinding[];
}

export interface LintSegment {
  where: string;
  text: string;
  /** Headlines get the colon rule; bodies get the rhythm rules. */
  role?: "headline" | "body";
}

// ---------------------------------------------------------------------------
// The rules, as data. Imported by lib/promptBuilders.ts — edit here only.
// ---------------------------------------------------------------------------

/**
 * Phrases that mark writing as machine-made. Ported from the three copies that
 * used to live inline in the generate, caption and article prompts; this is
 * their union, which is why the caption prompt now bans a few more things than
 * it did.
 */
export const BANNED_PHRASES: string[] = [
  "not just",
  "isn't just",
  "it's about",
  "the key is",
  "here's the thing",
  "let that sink in",
  "read that again",
  "imagine",
  "picture this",
  "in today's world",
  "in a world where",
  "game-changer",
  "game changing",
  "unlock",
  "leverage",
  "seamless",
  "journey",
  "navigate",
  "landscape",
  "dive",
  "delve",
  "robust",
  "holistic",
  "elevate",
  "revolutionize",
  "supercharge",
  "cutting-edge",
  "synergy",
  "harness",
  "foster",
  "realm",
  "tapestry"
];

/** Hedges. A senior partner states a thing or does not say it. */
export const HEDGES: string[] = ["we believe", "in our view", "arguably", "perhaps", "may well"];

const WEIGHT: Record<Severity, number> = { high: 12, medium: 6, low: 3 };

/** At most this many findings per rule, so one repeated slip does not bury everything else. */
const MAX_PER_RULE = 3;

// Explicit ranges rather than \p{Extended_Pictographic}: the project targets
// ES2017 and Unicode property escapes need ES2018.
const EMOJI_RE =
  /[\u2300-\u23FF\u2460-\u24FF\u25A0-\u27BF\u2B00-\u2BFF\uFE0F\u2190-\u21FF]|[\uD83C-\uD83E][\uDC00-\uDFFF]/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Match a banned phrase, including its inflections.
 *
 * "unlock" has to catch "unlocks", "unlocked" and "unlocking" — an inflected
 * cliché is exactly as much of a cliché, and a plain `\bunlock\b` misses all
 * three. Single words get suffixes; multi-word phrases ("not just", "it's
 * about") are matched literally, since inflecting them makes no sense.
 *
 * The silent-e branch is what makes "leveraging", "diving" and "navigating"
 * work: those drop the "e" before "ing", so the stem has to be tried too.
 */
function phraseRegex(phrase: string): RegExp {
  const body = escapeRe(phrase);
  const lead = /^[a-z0-9]/i.test(phrase) ? "\\b" : "";

  // Anything with a space or an apostrophe is a fixed phrase.
  if (!/^[a-z][a-z-]*$/i.test(phrase)) {
    const tail = /[a-z0-9]$/i.test(phrase) ? "\\b" : "";
    return new RegExp(`${lead}${body}${tail}`, "i");
  }

  const alts = [`${body}(?:s|es|d|ed|ing)?`];
  if (/e$/i.test(phrase)) alts.push(`${escapeRe(phrase.slice(0, -1))}(?:ing|ed)`);
  return new RegExp(`${lead}(?:${alts.join("|")})\\b`, "i");
}

const BANNED_RES = BANNED_PHRASES.map((p) => ({ phrase: p, re: phraseRegex(p) }));
const HEDGE_RES = HEDGES.map((p) => ({ phrase: p, re: phraseRegex(p) }));

/**
 * Curly apostrophes are what the model actually emits, and "isn’t just" must
 * match the rule written as "isn't just". Normalised before every match.
 */
export const normalizeQuotes = (s: string) => String(s || "").replace(/[’‘]/g, "'").replace(/[“”]/g, '"');

/**
 * Split one line into sentences. Hand-written rather than a regex split because
 * the obvious `(?<=[.!?])\s+` needs ES2018 lookbehind and this project targets
 * ES2017, and because a naive split breaks "3.5x" in half.
 */
function splitSentences(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== "." && c !== "!" && c !== "?") continue;
    // A dot between digits is a decimal point, not a full stop.
    if (c === "." && /\d/.test(line[i - 1] || "") && /\d/.test(line[i + 1] || "")) continue;
    // A dot after a single letter is an initial or an abbreviation: "C.E.O.",
    // "U.S.". Sentences almost never end on a one-letter word.
    if (c === "." && /[A-Za-z]/.test(line[i - 1] || "") && !/[A-Za-z]/.test(line[i - 2] || "")) continue;
    // Absorb a run of terminators, e.g. "?!".
    let j = i;
    while (j + 1 < line.length && /[.!?]/.test(line[j + 1])) j++;
    const next = line[j + 1];
    // Mid-word, so an abbreviation or a URL fragment. Not a boundary.
    if (next !== undefined && !/\s/.test(next)) {
      i = j;
      continue;
    }
    const piece = line.slice(start, j + 1).trim();
    if (piece) out.push(piece);
    start = j + 1;
    i = j;
  }
  const tail = line.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Split into sentences. Line breaks count as boundaries: slide bodies are
 * line-structured by lib/coerce.ts's structureBody, and a line there is a
 * sentence in every way that matters to rhythm.
 */
export function sentencesOf(text: string): string[] {
  return String(text || "")
    .split(/\n+/)
    .flatMap((line) => splitSentences(line.trim()))
    .filter(Boolean);
}

const wordCount = (s: string) => (s.match(/[A-Za-z0-9'’\-]+/g) || []).length;

/**
 * Coefficient of variation of sentence length: standard deviation over mean.
 *
 * This is the single most reliable structural tell. Machine prose settles into
 * one sentence length and stays there; people write a fourteen-word sentence,
 * then a four-word one, because emphasis needs the contrast. Returns null when
 * there is too little text to say anything.
 */
export function lengthVariation(text: string): number | null {
  const lens = sentencesOf(text).map(wordCount).filter((n) => n > 0);
  if (lens.length < 6) return null;
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  if (mean <= 0) return null;
  const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
  return Math.sqrt(variance) / mean;
}

/**
 * Below this, sentence lengths are suspiciously even. Set deliberately low: real
 * human copy from this project's own editorial plan measures around 0.23, so
 * anything above 0.18 must not fire. This flags metronomic text only.
 */
export const MIN_LENGTH_VARIATION = 0.18;

const trim = (s: string, n = 80) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function lexicalFindings(seg: LintSegment): SlopFinding[] {
  const out: SlopFinding[] = [];
  const t = normalizeQuotes(seg.text);
  if (!t.trim()) return out;

  for (const { phrase, re } of BANNED_RES) {
    const m = t.match(re);
    if (m) {
      out.push({
        rule: "banned-phrase",
        severity: "high",
        message: `Uses the banned phrase "${phrase}".`,
        where: seg.where,
        evidence: m[0]
      });
    }
  }

  for (const { phrase, re } of HEDGE_RES) {
    const m = t.match(re);
    if (m) {
      out.push({
        rule: "hedging",
        severity: "medium",
        message: `Hedges with "${phrase}". State it or drop it.`,
        where: seg.where,
        evidence: m[0]
      });
    }
  }

  if (/[—–]/.test(t)) {
    out.push({
      rule: "dash",
      severity: "high",
      message: "Contains an em or en dash. Use separate sentences.",
      where: seg.where,
      evidence: trim(t.match(/[^—–]{0,30}[—–][^—–]{0,30}/)?.[0] || "")
    });
  }

  if (EMOJI_RE.test(t)) {
    out.push({ rule: "emoji", severity: "high", message: "Contains an emoji or symbol character.", where: seg.where });
  }

  if (/!/.test(t)) {
    out.push({ rule: "exclamation", severity: "medium", message: "Contains an exclamation mark.", where: seg.where });
  }

  if (/(^|\s)#[A-Za-z]/.test(t)) {
    out.push({ rule: "hashtag", severity: "medium", message: "Contains a hashtag.", where: seg.where });
  }

  if (seg.role === "headline" && /\w:\s/.test(t)) {
    out.push({
      rule: "colon-headline",
      severity: "medium",
      message: 'Headline uses the "X: the Y of Z" shape.',
      where: seg.where,
      evidence: trim(t)
    });
  }

  // "It is not X, it is Y" / "X, not Y" / "not X but Y". Balanced antithesis is
  // the most overused rhetorical move in machine copy.
  const symmetry = t.match(/\bnot\s+[^.,;!?]{2,40}[,.]?\s+(but|it['’]s|it is)\s+/i) || t.match(/,\s*not\s+[a-z][^.,;!?]{2,40}[.]/i);
  if (symmetry) {
    out.push({
      rule: "symmetry",
      severity: "medium",
      message: "Uses a balanced not-X-but-Y construction.",
      where: seg.where,
      evidence: trim(symmetry[0])
    });
  }

  // Three short items in a row, purely for rhythm.
  const tricolon = t.match(/\b([A-Za-z]+),\s+([A-Za-z]+),?\s+and\s+([A-Za-z]+)\b/);
  if (tricolon && [tricolon[1], tricolon[2], tricolon[3]].every((w) => w.length <= 12)) {
    out.push({
      rule: "tricolon",
      severity: "low",
      message: "Uses a three-item list for rhythm.",
      where: seg.where,
      evidence: trim(tricolon[0])
    });
  }

  const first = sentencesOf(t)[0];
  if (seg.role !== "headline" && first && /\?\s*$/.test(first)) {
    out.push({
      rule: "question-hook",
      severity: "medium",
      message: "Opens on a rhetorical question.",
      where: seg.where,
      evidence: trim(first)
    });
  }

  return out;
}

/** Rhythm checks that only make sense across the whole piece. */
function structuralFindings(segments: LintSegment[]): SlopFinding[] {
  const out: SlopFinding[] = [];
  const bodies = segments.filter((s) => s.role !== "headline" && (s.text || "").trim());

  const joined = bodies.map((s) => s.text).join("\n");
  const cv = lengthVariation(joined);
  if (cv !== null && cv < MIN_LENGTH_VARIATION) {
    out.push({
      rule: "uniform-sentence-length",
      severity: "medium",
      message: `Every sentence is close to the same length (variation ${cv.toFixed(2)}). Vary it: let one run long and one stop short.`
    });
  }

  // The same opening two words twice is a template showing through.
  const openers = new Map<string, string[]>();
  for (const s of bodies) {
    for (const sent of sentencesOf(s.text)) {
      const key = (sent.match(/[A-Za-z'’]+/g) || []).slice(0, 2).join(" ").toLowerCase();
      if (key.split(" ").length < 2) continue;
      openers.set(key, [...(openers.get(key) || []), s.where]);
    }
  }
  for (const [key, wheres] of openers) {
    if (wheres.length >= 2) {
      out.push({
        rule: "repeated-opener",
        severity: "low",
        message: `${wheres.length} sentences open with "${key}".`,
        where: wheres.join(", ")
      });
    }
  }

  // Every body the same size, across four or more of them.
  if (bodies.length >= 4) {
    const lens = bodies.map((s) => s.text.trim().length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
    if (mean > 0 && sd / mean < 0.12) {
      out.push({
        rule: "uniform-segment-length",
        severity: "low",
        message: "Every slide is the same length. Let one be markedly shorter than the rest."
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export function lintSegments(segments: LintSegment[]): SlopReport {
  const raw = [...segments.flatMap(lexicalFindings), ...structuralFindings(segments)];

  const perRule = new Map<string, number>();
  const findings: SlopFinding[] = [];
  for (const f of raw) {
    const n = perRule.get(f.rule) || 0;
    if (n >= MAX_PER_RULE) continue;
    perRule.set(f.rule, n + 1);
    findings.push(f);
  }

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const penalty = findings.reduce((sum, f) => sum + WEIGHT[f.severity], 0);
  return { score: Math.max(0, 100 - penalty), findings };
}

/** For a caption, a post or an article: one block of prose. */
export function lintText(text: string, where = "text"): SlopReport {
  return lintSegments([{ where, text, role: "body" }]);
}

/** For a generated deck. Field names match lib/coerce.ts's CoercedContent. */
export function lintContent(content: {
  cover?: string;
  cta?: string;
  slides?: { title?: string; body?: string }[];
}): SlopReport {
  const segments: LintSegment[] = [];
  if (content.cover) segments.push({ where: "cover", text: content.cover, role: "headline" });
  (content.slides || []).forEach((s, i) => {
    if (s.title) segments.push({ where: `slide ${i + 1} title`, text: s.title, role: "headline" });
    if (s.body) segments.push({ where: `slide ${i + 1}`, text: s.body, role: "body" });
  });
  if (content.cta) segments.push({ where: "closing", text: content.cta, role: "headline" });
  return lintSegments(segments);
}

/** For the month plan: the topic lines, which are written as one batch and drift into one shape. */
export function lintTopics(topics: string[]): SlopReport {
  return lintSegments(topics.map((t, i) => ({ where: `topic ${i + 1}`, text: t, role: "body" })));
}

/**
 * Render findings for the humanize prompt. Empty string when the draft is clean,
 * so the caller can concatenate unconditionally.
 */
export function formatFindings(report: SlopReport): string {
  if (!report.findings.length) return "";
  const lines = report.findings.map((f) => `- ${f.where ? `[${f.where}] ` : ""}${f.message}${f.evidence ? ` Found: "${f.evidence}"` : ""}`);
  return `
PROBLEMS FOUND IN THE DRAFT BY AUTOMATED CHECK. Fix every one of these:
${lines.join("\n")}
`;
}
