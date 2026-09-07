// Voice samples — real, human-written copy the model imitates.
//
// This exists because the app was previously learning its voice from itself.
// `saveStyleExample` fired on every PNG export and filed that deck under
// "APPROVED EXAMPLES the team finalized earlier. Match their voice", so each
// generation copied the previous generation's machine voice, six slots deep.
// Nobody had approved a voice; somebody had clicked download.
//
// A banned-word list can remove the obvious tells. It cannot supply a voice.
// "Sound like a person" is close to unspecifiable in the abstract and easy to
// learn from examples, so the fix is a corpus of writing a human actually wrote
// and would sign their name to.
//
// Everything here is pure. Storage is the existing `store` blob under
// `kognoz-voice-samples`; see lib/storeClient.ts.
import type { ChannelId } from "./founderProfiles";
import { CHANNEL_IDS } from "./founderProfiles";
import { PLAN_TEMPLATE } from "./calendarTemplate";

/**
 * What the sample is an example of. A LinkedIn post and a slide body are
 * different writing problems: one is prose read top to bottom, the other is
 * compressed text sitting inside a fixed frame. Mixing them teaches the wrong
 * rhythm, so a sample carries which one it is and `pickSamples` prefers a match.
 */
export type SampleKind = "post" | "article" | "slide";

export const SAMPLE_KINDS: SampleKind[] = ["post", "article", "slide"];

export interface VoiceSample {
  id: string;
  /** Whose voice this is. Channel is the strongest signal, so it is matched first. */
  channel: ChannelId;
  kind: SampleKind;
  /** The writing itself, verbatim. Never paraphrase a sample; the phrasing is the point. */
  text: string;
  /** Optional note from whoever added it, e.g. "his best performing post". Not sent to the model. */
  note?: string;
  addedBy?: string;
  addedAt: string;
}

/**
 * Below this, a sample is too short to carry a voice — it shows word choice but
 * no rhythm, no paragraphing, no sense of how the writer gets from one idea to
 * the next. Roughly 25 words.
 */
export const MIN_SAMPLE_CHARS = 140;

/** How many samples go into a prompt. More is not better past this: the model starts collaging. */
export const DEFAULT_SAMPLE_COUNT = 4;

export function isChannelId(v: unknown): v is ChannelId {
  return typeof v === "string" && (CHANNEL_IDS as string[]).includes(v);
}

export function isSampleKind(v: unknown): v is SampleKind {
  return typeof v === "string" && (SAMPLE_KINDS as string[]).includes(v);
}

/**
 * Blob storage is schemaless and this one is edited by hand, so anything read
 * back is validated rather than trusted. A malformed row is dropped, not thrown
 * on: one bad paste should not empty the corpus.
 */
export function coerceSamples(raw: unknown): VoiceSample[] {
  if (!Array.isArray(raw)) return [];
  const out: VoiceSample[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    if (!text) continue;
    if (!isChannelId(o.channel)) continue;
    out.push({
      id: typeof o.id === "string" && o.id ? o.id : makeId(),
      channel: o.channel,
      kind: isSampleKind(o.kind) ? o.kind : "post",
      text,
      note: typeof o.note === "string" && o.note.trim() ? o.note.trim() : undefined,
      addedBy: typeof o.addedBy === "string" ? o.addedBy : undefined,
      addedAt: typeof o.addedAt === "string" ? o.addedAt : new Date(0).toISOString()
    });
  }
  return out;
}

let idCounter = 0;
function makeId(): string {
  idCounter += 1;
  return `vs_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function newSample(fields: {
  channel: ChannelId;
  kind: SampleKind;
  text: string;
  note?: string;
  addedBy?: string;
}): VoiceSample {
  return {
    id: makeId(),
    channel: fields.channel,
    kind: fields.kind,
    text: fields.text.trim(),
    note: fields.note?.trim() || undefined,
    addedBy: fields.addedBy,
    addedAt: new Date().toISOString()
  };
}

/**
 * Rotate a list by `seed`. Without this the same three samples reach the model on
 * every run and the output converges on those three; the corpus would be broad
 * and the voice narrow anyway. Studio already keeps a `seed` that changes on
 * "Regenerate afresh", so rotation is free.
 */
function rotate<T>(xs: T[], seed: number): T[] {
  if (xs.length < 2) return xs.slice();
  const k = ((Math.trunc(seed) % xs.length) + xs.length) % xs.length;
  return [...xs.slice(k), ...xs.slice(0, k)];
}

/**
 * Choose which samples to show the model, best match first.
 *
 * Tiers, in order: same voice and same kind of writing; then same voice, any
 * kind; then the right kind in another voice; then anything at all. A caption in
 * the right person's voice beats a perfect slide sample written by someone else,
 * which is why channel outranks kind.
 */
export function pickSamples(
  all: VoiceSample[],
  opts: { channel?: string; kind?: SampleKind; count?: number; seed?: number }
): VoiceSample[] {
  const { channel, kind, count = DEFAULT_SAMPLE_COUNT, seed = 0 } = opts;
  if (count <= 0) return [];

  const sameChannel = (s: VoiceSample) => !!channel && s.channel === channel;
  const sameKind = (s: VoiceSample) => !!kind && s.kind === kind;

  const tiers: VoiceSample[][] = [
    all.filter((s) => sameChannel(s) && sameKind(s)),
    all.filter((s) => sameChannel(s) && !sameKind(s)),
    all.filter((s) => !sameChannel(s) && sameKind(s)),
    all.filter((s) => !sameChannel(s) && !sameKind(s))
  ];

  const picked: VoiceSample[] = [];
  const seen = new Set<string>();
  for (const tier of tiers) {
    for (const s of rotate(tier, seed)) {
      if (picked.length >= count) return picked;
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      picked.push(s);
    }
  }
  return picked;
}

/**
 * Render samples for a prompt.
 *
 * The framing matters as much as the samples. "Match their voice" against AI text
 * is what caused the original problem, so this block says plainly that these were
 * written by people, names what to take from them (rhythm, sentence shape, how a
 * thought is finished) and what to leave (topic, facts, phrasing). Returns "" when
 * there are no samples, so callers can concatenate unconditionally.
 */
export function formatSamplesBlock(samples: VoiceSample[]): string {
  if (!samples.length) return "";
  const body = samples
    .map((s, i) => `--- SAMPLE ${i + 1} (${s.channel}, ${s.kind}) ---\n${s.text}`)
    .join("\n\n");
  return `
WRITING BY THE PEOPLE YOU ARE WRITING FOR. Every sample below was written by a human and published. This is the target.

${body}
--- END SAMPLES ---

Read them for how these people write, not what they wrote about. Take the sentence lengths and how they vary, where a thought is allowed to run long and where it stops short, how a point is opened and how it is finished, how much is left for the reader to do. Do not reuse their topics, their facts, their numbers, or their phrasing. A sentence lifted from a sample is a failure, not a match.
`;
}

/**
 * The 36 hand-written posts in lib/calendarTemplate.ts, as voice samples.
 *
 * That file is described in its own header as "fixed editorial data agreed with
 * the client" — real writing, already approved, already in this repo, and until
 * now reaching no prompt at all. It is the cheapest corpus available and it means
 * the feature is useful before anyone pastes anything in.
 *
 * `copy` is the LinkedIn text: the whole post for a Text post or Poll, the
 * accompanying caption for everything else. Both are prose in a person's voice,
 * so both file as "post". Slide-kind samples are not seeded from here — the one
 * hand-written deck in that file (DEFAULT_CONTENT) states two things
 * DO_NOT_ASSERT forbids, and seeding a voice corpus with content the brand rules
 * ban would teach exactly the wrong thing.
 */
export function samplesFromTemplate(addedBy?: string): VoiceSample[] {
  const out: VoiceSample[] = [];
  for (const item of PLAN_TEMPLATE) {
    const text = (item.copy || "").trim();
    if (text.length < MIN_SAMPLE_CHARS) continue;
    if (!isChannelId(item.ch)) continue;
    out.push({
      id: `vs_tmpl_${item.n}`,
      channel: item.ch,
      kind: "post",
      text,
      note: `From the agreed editorial plan (item ${item.n}, ${item.fmt})`,
      addedBy,
      addedAt: new Date().toISOString()
    });
  }
  return out;
}

/** Merge imported samples into an existing list without creating duplicates. */
export function mergeSamples(existing: VoiceSample[], incoming: VoiceSample[]): VoiceSample[] {
  const byId = new Set(existing.map((s) => s.id));
  const byText = new Set(existing.map((s) => s.text.trim()));
  const added = incoming.filter((s) => !byId.has(s.id) && !byText.has(s.text.trim()));
  return [...existing, ...added];
}
