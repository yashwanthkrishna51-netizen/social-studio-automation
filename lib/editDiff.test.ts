import { describe, it, expect } from "vitest";
import { diffDecks, slideTarget, type DeckLike } from "./editDiff";

const deck = (over: Partial<DeckLike> = {}): DeckLike => ({
  cover: "Culture is what people *do*",
  slides: [
    { title: "The survey and the logs disagree", body: "The score said ownership." },
    { title: "Behaviour is the honest data", body: "Reported and observed differ." }
  ],
  cta: "See how we read it",
  ...over
});

describe("diffDecks", () => {
  it("reports nothing when the pass changed nothing", () => {
    expect(diffDecks(deck(), deck())).toEqual([]);
  });

  it("reports only the fields that actually differ", () => {
    const edited = deck({
      slides: [
        { title: "The survey and the logs disagree", body: "The score said ownership. The logs did not." },
        { title: "Behaviour is the honest data", body: "Reported and observed differ." }
      ]
    });
    const rows = diffDecks(deck(), edited);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("slide:0:body");
    expect(rows[0].where).toBe("Slide 1");
    expect(rows[0].original).toBe("The score said ownership.");
    expect(rows[0].edited).toBe("The score said ownership. The logs did not.");
  });

  it("starts every row on the edited wording", () => {
    const rows = diffDecks(deck(), deck({ cover: "Something else entirely" }));
    expect(rows.every((r) => r.using === "edited")).toBe(true);
  });

  it("covers cover, both slide fields and the closing", () => {
    const rows = diffDecks(
      deck(),
      deck({
        cover: "New cover",
        cta: "New close",
        slides: [
          { title: "New title", body: "New body" },
          { title: "Behaviour is the honest data", body: "Reported and observed differ." }
        ]
      })
    );
    expect(rows.map((r) => r.key)).toEqual(["cover", "slide:0:title", "slide:0:body", "cta"]);
  });

  it("keeps deck order, cover first and closing last", () => {
    const rows = diffDecks(deck(), deck({ cover: "a", cta: "b", slides: [
      { title: "x", body: "y" },
      { title: "z", body: "w" }
    ] }));
    expect(rows[0].key).toBe("cover");
    expect(rows[rows.length - 1].key).toBe("cta");
  });

  it("numbers slides from one for a reader, not from zero", () => {
    const rows = diffDecks(deck(), deck({ slides: [
      { title: "The survey and the logs disagree", body: "The score said ownership." },
      { title: "Changed", body: "Reported and observed differ." }
    ] }));
    expect(rows[0].where).toBe("Slide 2 title");
    expect(rows[0].key).toBe("slide:1:title");
  });

  it("ignores extra slides rather than inventing rows for them", () => {
    // The edit pass is rejected upstream if it changes the slide count, so a
    // mismatch here means something else broke. Reporting phantom additions
    // would mislead rather than help.
    const edited = deck({ slides: [...deck().slides, { title: "extra", body: "extra" }] });
    expect(diffDecks(deck(), edited)).toEqual([]);
  });

  it("survives the edited deck having fewer slides", () => {
    const edited = deck({ slides: [deck().slides[0]] });
    expect(() => diffDecks(deck(), edited)).not.toThrow();
    expect(diffDecks(deck(), edited)).toEqual([]);
  });

  it("treats a missing field as an empty string rather than undefined", () => {
    const rows = diffDecks(deck(), deck({ cta: "" }));
    expect(rows[0].edited).toBe("");
    expect(rows[0].original).toBe("See how we read it");
  });
});

describe("slideTarget", () => {
  it("parses a slide field key", () => {
    expect(slideTarget("slide:2:body")).toEqual({ index: 2, field: "body" });
    expect(slideTarget("slide:0:title")).toEqual({ index: 0, field: "title" });
  });

  it("returns null for the fields that are not slides", () => {
    expect(slideTarget("cover")).toBeNull();
    expect(slideTarget("cta")).toBeNull();
  });

  it("refuses a malformed key rather than writing to slide NaN", () => {
    for (const k of ["slide:x:body", "slide:1:eyebrow", "slide:-1:body", "slide:1", "", "slide::body"]) {
      expect(slideTarget(k), `expected "${k}" to be rejected`).toBeNull();
    }
  });

  it("round-trips every key diffDecks produces", () => {
    const rows = diffDecks(deck(), deck({ cover: "a", cta: "b", slides: [
      { title: "x", body: "y" },
      { title: "z", body: "w" }
    ] }));
    for (const r of rows) {
      const t = slideTarget(r.key);
      if (r.key === "cover" || r.key === "cta") expect(t).toBeNull();
      else expect(t).not.toBeNull();
    }
  });
});
