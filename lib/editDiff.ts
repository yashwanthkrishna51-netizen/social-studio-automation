// What the line-editing pass changed, field by field.
//
// Without this the second pass is a black box: it rewrites the whole deck and
// the only feedback is a style score. A person cannot see what it touched, and
// cannot keep their own wording on one slide while accepting the rest.
//
// Pure, so it can be tested. The component holds the rows and applies a choice
// through the same setters the manual editors use.

export interface DeckLike {
  cover: string;
  slides: { title: string; body: string }[];
  cta: string;
}

export interface EditDiffRow {
  /** Addresses the field: "cover", "cta", or "slide:<index>:title" / ":body". */
  key: string;
  /** How the field is named to a reader, e.g. "Slide 2". */
  where: string;
  /** The pass-one wording. */
  original: string;
  /** What the editing pass returned. */
  edited: string;
  /** Which one is currently on the canvas. */
  using: "edited" | "original";
}

/**
 * Compare two decks and list only the fields that differ.
 *
 * IMPORTANT: pass both decks AFTER `coerceContent`. Comparing a raw model reply
 * against a coerced draft reports the quality firewall's own work — clamped
 * lengths, stripped URLs, dashes turned into line breaks, capitalised lines — as
 * though the line editor had made those changes, which buries the handful of
 * real edits in noise.
 *
 * Slides beyond the original's length are ignored rather than reported as
 * additions: the edit pass is rejected upstream if it changes the slide count,
 * so a mismatch here means something else went wrong and inventing rows for it
 * would only mislead.
 */
export function diffDecks(original: DeckLike, edited: DeckLike): EditDiffRow[] {
  const rows: EditDiffRow[] = [];

  const add = (key: string, where: string, a: string, b: string) => {
    if ((a || "") !== (b || "")) rows.push({ key, where, original: a || "", edited: b || "", using: "edited" });
  };

  add("cover", "Cover", original.cover, edited.cover);
  original.slides.forEach((sl, i) => {
    const e = edited.slides[i];
    if (!e) return;
    add(`slide:${i}:title`, `Slide ${i + 1} title`, sl.title, e.title);
    add(`slide:${i}:body`, `Slide ${i + 1}`, sl.body, e.body);
  });
  add("cta", "Closing", original.cta, edited.cta);

  return rows;
}

/** Where a row's chosen text should be written back. Null for cover and cta. */
export function slideTarget(key: string): { index: number; field: "title" | "body" } | null {
  const [prefix, idxRaw, field] = key.split(":");
  if (prefix !== "slide") return null;
  // Digits only. `Number("")` is 0 and `Number.isInteger(0)` is true, so a key
  // like "slide::body" would otherwise resolve to slide 0 and write the wrong
  // slide's text without any error.
  if (!/^\d+$/.test(idxRaw || "")) return null;
  if (field !== "title" && field !== "body") return null;
  return { index: Number(idxRaw), field };
}
