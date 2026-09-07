import { describe, it, expect } from "vitest";
import {
  MIN_SAMPLE_CHARS,
  coerceSamples,
  formatSamplesBlock,
  mergeSamples,
  newSample,
  pickSamples,
  samplesFromTemplate,
  type VoiceSample
} from "./voiceSamples";
import { CHANNEL_IDS } from "./founderProfiles";

const s = (id: string, channel: VoiceSample["channel"], kind: VoiceSample["kind"]): VoiceSample => ({
  id,
  channel,
  kind,
  text: `sample ${id}`,
  addedAt: "2026-09-04T00:00:00.000Z"
});

describe("pickSamples", () => {
  const all = [
    s("a", "Lokesh", "post"),
    s("b", "Lokesh", "post"),
    s("c", "Lokesh", "slide"),
    s("d", "Harpreet", "post"),
    s("e", "Kognoz page", "slide")
  ];

  it("prefers the same channel and the same kind", () => {
    const picked = pickSamples(all, { channel: "Lokesh", kind: "post", count: 2 });
    expect(picked.map((p) => p.id).sort()).toEqual(["a", "b"]);
  });

  it("falls back to the same channel before the same kind", () => {
    // Only one Lokesh post exists, so the second pick must be the Lokesh slide,
    // not Harpreet's post: whose voice it is matters more than what shape it is.
    const picked = pickSamples([s("a", "Lokesh", "post"), s("c", "Lokesh", "slide"), s("d", "Harpreet", "post")], {
      channel: "Lokesh",
      kind: "post",
      count: 2
    });
    expect(picked.map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("falls back to another channel rather than returning nothing", () => {
    const picked = pickSamples([s("d", "Harpreet", "post")], { channel: "Lokesh", kind: "slide", count: 2 });
    expect(picked.map((p) => p.id)).toEqual(["d"]);
  });

  it("never returns the same sample twice", () => {
    const picked = pickSamples(all, { channel: "Lokesh", kind: "post", count: 99 });
    expect(new Set(picked.map((p) => p.id)).size).toBe(picked.length);
    expect(picked.length).toBe(all.length);
  });

  it("returns a different order for a different seed", () => {
    const one = pickSamples(all, { channel: "Lokesh", kind: "post", count: 1, seed: 0 });
    const two = pickSamples(all, { channel: "Lokesh", kind: "post", count: 1, seed: 1 });
    expect(one[0].id).not.toBe(two[0].id);
  });

  it("is stable for the same seed", () => {
    const a = pickSamples(all, { channel: "Lokesh", kind: "post", count: 3, seed: 7 });
    const b = pickSamples(all, { channel: "Lokesh", kind: "post", count: 3, seed: 7 });
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
  });

  it("handles an empty corpus and a zero count", () => {
    expect(pickSamples([], { channel: "Lokesh", kind: "post" })).toEqual([]);
    expect(pickSamples(all, { channel: "Lokesh", kind: "post", count: 0 })).toEqual([]);
  });

  it("copes with a channel nobody has samples for", () => {
    const picked = pickSamples(all, { channel: "Nobody", kind: "post", count: 2 });
    expect(picked.length).toBe(2);
  });
});

describe("coerceSamples", () => {
  it("drops rows that are not usable", () => {
    const out = coerceSamples([
      { id: "1", channel: "Lokesh", kind: "post", text: "real", addedAt: "x" },
      { id: "2", channel: "Nobody", kind: "post", text: "wrong channel" },
      { id: "3", channel: "Lokesh", kind: "post", text: "   " },
      null,
      "nonsense"
    ]);
    expect(out.map((o) => o.text)).toEqual(["real"]);
  });

  it("defaults an unknown kind to post rather than dropping the sample", () => {
    const out = coerceSamples([{ id: "1", channel: "Harpreet", kind: "poem", text: "keep me" }]);
    expect(out[0].kind).toBe("post");
  });

  it("returns an empty array for anything that is not a list", () => {
    expect(coerceSamples(null)).toEqual([]);
    expect(coerceSamples({})).toEqual([]);
    expect(coerceSamples(undefined)).toEqual([]);
  });

  it("round-trips what newSample produces", () => {
    const made = newSample({ channel: "Lokesh", kind: "slide", text: "  spaced  ", note: " n " });
    expect(made.text).toBe("spaced");
    expect(made.note).toBe("n");
    expect(coerceSamples([made])).toHaveLength(1);
  });
});

describe("samplesFromTemplate", () => {
  const seeded = samplesFromTemplate("me@example.com");

  it("finds real writing in the agreed editorial plan", () => {
    expect(seeded.length).toBeGreaterThan(10);
  });

  it("only keeps samples long enough to carry a voice", () => {
    for (const x of seeded) expect(x.text.length).toBeGreaterThanOrEqual(MIN_SAMPLE_CHARS);
  });

  it("files every sample under a real channel", () => {
    for (const x of seeded) expect(CHANNEL_IDS).toContain(x.channel);
  });

  it("covers all three voices", () => {
    expect(new Set(seeded.map((x) => x.channel)).size).toBe(3);
  });

  it("gives every sample a stable id, so a second import is not a duplicate", () => {
    const again = samplesFromTemplate();
    expect(again.map((x) => x.id)).toEqual(seeded.map((x) => x.id));
  });
});

describe("mergeSamples", () => {
  it("adds only what is new", () => {
    const existing = [s("a", "Lokesh", "post")];
    const merged = mergeSamples(existing, [s("a", "Lokesh", "post"), s("b", "Lokesh", "post")]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("treats identical text as a duplicate even under a new id", () => {
    const existing = [{ ...s("a", "Lokesh", "post"), text: "same words" }];
    const merged = mergeSamples(existing, [{ ...s("zzz", "Harpreet", "post"), text: "same words" }]);
    expect(merged).toHaveLength(1);
  });

  it("is a no-op when importing twice", () => {
    const once = mergeSamples([], samplesFromTemplate());
    const twice = mergeSamples(once, samplesFromTemplate());
    expect(twice.length).toBe(once.length);
  });
});

describe("formatSamplesBlock", () => {
  it("is empty when there is nothing to show", () => {
    expect(formatSamplesBlock([])).toBe("");
  });

  it("includes the sample text and says it was written by a human", () => {
    const block = formatSamplesBlock([{ ...s("a", "Lokesh", "post"), text: "The logs said otherwise." }]);
    expect(block).toContain("The logs said otherwise.");
    expect(block).toContain("written by a human");
  });

  it("tells the model not to reuse the phrasing", () => {
    const block = formatSamplesBlock([s("a", "Lokesh", "post")]);
    expect(block.toLowerCase()).toContain("not what they wrote about");
  });
});
