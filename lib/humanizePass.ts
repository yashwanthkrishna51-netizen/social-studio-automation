// The second pass: write, then line-edit.
//
// Pass one drafts. Pass two reads that draft back with real human writing beside
// it and a list of what the linter already found wrong, and rewrites the
// sentences. It is a separate call because it is a separate job: the drafting
// call cannot see its own output, has thinking disabled, and must answer in bare
// JSON, so the old "draft first, then audit your draft" instruction in the
// generate prompt had nowhere to happen.
//
// ONE RULE GOVERNS THIS FILE. A failed second pass must never cost the first.
// The draft is already paid for and already usable. Every failure path here
// returns it untouched with `applied: false`, and the caller shows it. Throwing
// would make a quality improvement into a way to lose work.
"use client";

import { callClaudeJSON, callClaudeText } from "./claudeClient";
import { buildHumanizePrompt } from "./promptBuilders";
import { formatFindings, lintContent, lintText, lintTopics, type SlopReport } from "./slopLint";
import type { VoiceSample } from "./voiceSamples";

export interface HumanizeResult<T> {
  /** The rewritten value, or the original draft when the pass could not run. */
  value: T;
  before: SlopReport;
  after: SlopReport;
  applied: boolean;
  /** Why it did not run. Shown quietly; the draft is still good. */
  note?: string;
}

const failed = <T,>(value: T, before: SlopReport, note: string): HumanizeResult<T> => ({
  value,
  before,
  after: before,
  applied: false,
  note
});

export interface DeckContent {
  eyebrow?: string;
  cover: string;
  slides: { title: string; body: string }[];
  cta: string;
}

/**
 * Rewrite a generated deck.
 *
 * The slide count and the field roles are fixed by the format contract and by
 * the renderer, so a reply that changes either is rejected outright rather than
 * coerced: a montage with four frames or a stat card whose title stopped being a
 * number is worse than the draft it replaced.
 */
export async function humanizeDeck(
  draft: DeckContent,
  opts: { voiceSamples?: VoiceSample[]; housePrefs?: string; channel?: string; maxTokens?: number } = {}
): Promise<HumanizeResult<DeckContent>> {
  const before = lintContent(draft);
  try {
    const prompt = buildHumanizePrompt({
      shape: "deck",
      draft: JSON.stringify(draft),
      voiceSamples: opts.voiceSamples,
      findings: formatFindings(before),
      channel: opts.channel,
      housePrefs: opts.housePrefs
    });
    const raw = await callClaudeJSON("humanize", prompt, { maxTokens: opts.maxTokens ?? 4000 });

    if (!raw || !Array.isArray(raw.slides) || raw.slides.length !== draft.slides.length) {
      return failed(draft, before, "the edit pass changed the slide count, so the original was kept");
    }
    const value: DeckContent = {
      eyebrow: draft.eyebrow,
      cover: typeof raw.cover === "string" && raw.cover.trim() ? raw.cover : draft.cover,
      slides: draft.slides.map((s, i) => {
        const r = raw.slides[i] || {};
        return {
          title: typeof r.title === "string" && r.title.trim() ? r.title : s.title,
          body: typeof r.body === "string" && r.body.trim() ? r.body : s.body
        };
      }),
      cta: typeof raw.cta === "string" && raw.cta.trim() ? raw.cta : draft.cta
    };
    return { value, before, after: lintContent(value), applied: true };
  } catch (e) {
    return failed(draft, before, e instanceof Error ? e.message : "the edit pass failed");
  }
}

/** Rewrite a caption, a text post, or a full article. */
export async function humanizeText(
  draft: string,
  opts: { voiceSamples?: VoiceSample[]; housePrefs?: string; channel?: string; maxTokens?: number } = {}
): Promise<HumanizeResult<string>> {
  const before = lintText(draft);
  try {
    const prompt = buildHumanizePrompt({
      shape: "text",
      draft,
      voiceSamples: opts.voiceSamples,
      findings: formatFindings(before),
      channel: opts.channel,
      housePrefs: opts.housePrefs
    });
    const out = await callClaudeText("humanize", prompt, { maxTokens: opts.maxTokens ?? 4000 });
    const value = out.trim();

    // A reply far shorter than the draft means it summarised instead of editing.
    // Half is generous; a real line-edit moves length by a little, not by most.
    if (!value || value.length < draft.trim().length * 0.5) {
      return failed(draft, before, "the edit pass returned far less text than the draft, so the original was kept");
    }
    return { value, before, after: lintText(value), applied: true };
  } catch (e) {
    return failed(draft, before, e instanceof Error ? e.message : "the edit pass failed");
  }
}

export interface PlanItemLike {
  day: number;
  channel: string;
  format: string;
  pillar: string;
  topic: string;
}

/**
 * Rewrite the topic lines of a month plan, leaving the schedule alone.
 *
 * Written in one pass, thirty-six topics converge on a single sentence shape and
 * every downstream post inherits it. Only the `topic` string is taken from the
 * reply; day, channel, format and pillar are copied from the draft, so a model
 * that reorders or reschedules cannot move anything.
 */
export async function humanizePlanTopics<T extends PlanItemLike>(
  items: T[],
  opts: { voiceSamples?: VoiceSample[]; maxTokens?: number } = {}
): Promise<HumanizeResult<T[]>> {
  const before = lintTopics(items.map((i) => i.topic));
  if (!items.length) return failed(items, before, "nothing to edit");
  try {
    const prompt = buildHumanizePrompt({
      shape: "topics",
      draft: JSON.stringify({ items: items.map(({ day, channel, format, pillar, topic }) => ({ day, channel, format, pillar, topic })) }),
      voiceSamples: opts.voiceSamples,
      findings: formatFindings(before)
    });
    const raw = await callClaudeJSON("humanize", prompt, { maxTokens: opts.maxTokens ?? 10000 });

    if (!raw || !Array.isArray(raw.items) || raw.items.length !== items.length) {
      return failed(items, before, "the edit pass changed the number of posts, so the original plan was kept");
    }
    const value = items.map((item, i) => {
      const t = raw.items[i]?.topic;
      return typeof t === "string" && t.trim() ? { ...item, topic: t.trim() } : item;
    });
    return { value, before, after: lintTopics(value.map((i) => i.topic)), applied: true };
  } catch (e) {
    return failed(items, before, e instanceof Error ? e.message : "the edit pass failed");
  }
}

/** One line for the UI: what the edit pass did, or why it did not. */
export function humanizeNote(r: HumanizeResult<unknown>): string {
  if (!r.applied) return r.note ? `Edit pass skipped: ${r.note}.` : "Edit pass skipped.";
  const delta = r.after.score - r.before.score;
  if (delta > 0) return `Edit pass: style score ${r.before.score} to ${r.after.score}.`;
  if (delta < 0) return `Edit pass ran; style score ${r.before.score} to ${r.after.score}.`;
  return `Edit pass ran; style score held at ${r.after.score}.`;
}
