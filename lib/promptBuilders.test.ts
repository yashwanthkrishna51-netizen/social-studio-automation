import { describe, it, expect } from "vitest";
import { CHANNEL_IDS, DO_NOT_ASSERT, CADENCE } from "./founderProfiles";
import { PILLARS_LIST } from "../components/calendar/types";
import {
  buildArticlePrompt,
  buildCalendarPlanPrompt,
  buildCaptionPrompt,
  buildGeneratePrompt,
  buildHumanizePrompt,
  wholePrompt
} from "./promptBuilders";
import { BANNED_PHRASES } from "./slopLint";
import { DEFAULT_BUDGET } from "./coerce";
import { STUDIO_FORMATS, FORMATS, FORMAT_BRIEF, SLIDE_SLOTS, bodyBudgetFor } from "./formats";
import type { FormatId } from "./formats";

// Prompts were entirely untested. Video Kinetic returned 2-3 lines because its
// prompt asked for "one supporting line, max ~140 chars" — nothing was broken, the
// contract said to write almost nothing. These lock the contracts in place.

const promptFor = (format: FormatId) =>
  wholePrompt(buildGeneratePrompt({ topic: "Human and AI work transformation", pillar: "Human + AI", format }));

/** Every "max ~N chars" budget the prompt asks Claude for. */
const askedBudgets = (p: string) =>
  Array.from(p.matchAll(/max ~(\d+)\s*char/gi), (m) => Number(m[1]));

describe("every format still produces a prompt", () => {
  it("builds for all studio formats without throwing", () => {
    for (const f of STUDIO_FORMATS) expect(promptFor(f).length).toBeGreaterThan(200);
  });

  it("names the topic and pillar in each", () => {
    for (const f of STUDIO_FORMATS) {
      const p = promptFor(f);
      expect(p).toContain("Human and AI work transformation");
      expect(p).toContain("Human + AI");
    }
  });
});

describe("the trap: asking for more than coerceContent will keep", () => {
  it("never requests a body longer than that format's budget will keep", () => {
    // Raising a prompt budget above the clamp is silently pointless — the extra
    // characters are cut in coerceContent with no error and no signal. This test
    // caught exactly that: Story asked for 420 against a 230 default.
    for (const f of STUDIO_FORMATS) {
      const ceiling = Math.max(bodyBudgetFor(f), DEFAULT_BUDGET.cta);
      for (const n of askedBudgets(promptFor(f))) {
        expect({ format: f, asked: n, ceiling }).toMatchObject({ asked: expect.any(Number) });
        expect(n).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it("keeps Founder Video's caption within the cta budget", () => {
    // This one was live-broken: a ~280 char caption clamped to 110 lost ~60%.
    const asked = askedBudgets(promptFor("Founder Video"));
    expect(Math.max(...asked)).toBeLessThanOrEqual(DEFAULT_BUDGET.cta);
  });
});

describe("the four formats that were producing empty pages", () => {
  it("Video Kinetic asks for a sequence of beats, not one line", () => {
    const p = promptFor("Video");
    expect(p).toMatch(/exactly 4 slides/i);
    expect(p).toMatch(/sequence/i);
    // The old contract, which is what produced 2-3 lines.
    expect(p).not.toMatch(/then one supporting line appears/i);
  });

  it("Montage asks for one complete argument across its 3 frames", () => {
    const p = promptFor("Montage");
    expect(p).toMatch(/exactly 3 slides/i);
    expect(p).toMatch(/COMPLETE argument/i);
    // "standalone point" is what produced three disconnected fragments.
    expect(p).not.toMatch(/standalone point/i);
  });

  it("Article Cover asks for a standfirst instead of a placeholder hyphen", () => {
    const p = promptFor("Article Cover");
    expect(p).toMatch(/standfirst/i);
    expect(p).toMatch(/16:9/);
  });

  it("Story asks for an arc rather than one stray idea", () => {
    const p = promptFor("Story");
    expect(p).toMatch(/hook/i);
    expect(p).not.toMatch(/one supporting idea/i);
  });
});

describe("prompt slide counts match what the renderer draws", () => {
  const asksExactly = (p: string) => {
    const m = p.match(/exactly (\d+) slides/i);
    return m ? Number(m[1]) : null;
  };

  it("never asks for more slides than the format has slots", () => {
    for (const f of STUDIO_FORMATS) {
      const spec = FORMATS[f];
      if (!spec.single) continue;
      const asked = asksExactly(promptFor(f));
      if (asked === null) continue;
      expect(asked).toBeLessThanOrEqual(SLIDE_SLOTS[spec.single]);
    }
  });

  it("gives Video and Article the slots their new prompts need", () => {
    expect(SLIDE_SLOTS.video).toBeGreaterThanOrEqual(4);
    expect(SLIDE_SLOTS.article).toBeGreaterThanOrEqual(1);
  });
});

describe("FORMAT_BRIEF — what the user is told before spending credit", () => {
  it("describes every format the picker offers", () => {
    for (const f of STUDIO_FORMATS) {
      expect(FORMAT_BRIEF[f]).toBeTruthy();
      expect(FORMAT_BRIEF[f].length).toBeGreaterThan(10);
    }
  });
});

// The calendar planner writes in the names of real co-founders, so this suite is mostly
// about what the prompt is forbidden to let through — the facts research could not
// confirm. A confident false claim about a real firm is not a style problem.
describe("buildCalendarPlanPrompt", () => {
  const prompt = wholePrompt(buildCalendarPlanPrompt({
    year: 2026,
    monthName: "October",
    availableDays: [1, 2, 5, 6, 7],
    existingTopics: ["A topic already on the calendar"],
    targetCount: 36
  }));

  it("names all three publishing identities and their real names", () => {
    for (const id of CHANNEL_IDS) expect(prompt).toContain(id);
    expect(prompt).toContain("Lokesh Nigam");
    expect(prompt).toContain("Harpreet Kaur Kapoor");
  });

  it("carries every do-not-assert line verbatim", () => {
    // These are the guardrails; a paraphrase would weaken them.
    for (const line of DO_NOT_ASSERT) expect(prompt).toContain(line);
  });

  it("forbids the unverifiable claims by name", () => {
    expect(prompt).toContain("Immersion Index");
    expect(prompt).toMatch(/never say Kognoz has "two co-founders"/i);
    expect(prompt).toMatch(/never state a founding year/i);
    expect(prompt).toMatch(/never claim a Middle East office/i);
    expect(prompt).toMatch(/never name a client/i);
  });

  it("asks for the month as a campaign, with arcs that run in the right direction", () => {
    expect(prompt).toMatch(/campaign, not a list/i);
    expect(prompt).toContain("its day must come after the post it refers to");
  });

  it("states the cadence and the author split", () => {
    expect(prompt).toContain("1, 2, 5, 6, 7");
    expect(prompt).toContain(String(CADENCE.perChannel["Kognoz page"]));
    expect(prompt).toContain(String(CADENCE.perChannel.Lokesh));
    expect(prompt).toContain(String(CADENCE.perChannel.Harpreet));
  });

  it("passes existing topics through so a second month does not repeat the first", () => {
    expect(prompt).toContain("A topic already on the calendar");
    expect(prompt).toMatch(/do not repeat these subjects/i);
  });

  it("asks for an OBJECT, not a bare array", () => {
    // claudeClient's extractJson brackets on { … }. A top-level array fails to parse and
    // costs an extra corrective call.
    expect(prompt).toContain('{"items": [');
    expect(prompt).not.toMatch(/Return ONLY valid JSON[\s\S]{0,40}^\[/m);
  });

  it("enumerates every enum the coercer will snap onto", () => {
    for (const p of PILLARS_LIST) expect(prompt).toContain(p);
    for (const f of ["Carousel", "Text post", "Poll", "Founder Video"]) expect(prompt).toContain(f);
  });

  it("keeps the topic length request inside what the coercer will store", () => {
    // The same trap promptBuilders already guards for slide bodies: asking for more than
    // the coercer keeps means silent truncation nobody can see in the prompt.
    const asked = [...prompt.matchAll(/(\d+) to (\d+) characters/g)].map((m) => Number(m[2]));
    expect(asked.length).toBeGreaterThan(0);
    for (const n of asked) expect(n).toBeLessThanOrEqual(110);
  });

  it("omits the avoid-list block entirely when nothing is scheduled yet", () => {
    const fresh = wholePrompt(
      buildCalendarPlanPrompt({
        year: 2026,
        monthName: "October",
        availableDays: [1],
        existingTopics: [],
        targetCount: 4
      })
    );
    expect(fresh).not.toMatch(/ALREADY SCHEDULED/);
  });
});

// The prompt is split so the route can attach cache_control to the system half.
// That only pays off if the system half really is stable: anything volatile that
// leaks into it silently puts the input cost back to full price on every call.
describe("the system / user split", () => {
  const gen = (topic: string, format: FormatId = "Carousel") =>
    buildGeneratePrompt({ topic, pillar: "Culture", format });

  it("keeps the system half identical for two topics in the same lane", () => {
    const a = gen("Culture is what people do under pressure");
    const b = gen("Culture shows up in what teams do when nobody is watching");
    expect(a.system).toBe(b.system);
    expect(a.user).not.toBe(b.user);
  });

  it("puts the brand canon and the rules in the system half", () => {
    const { system } = gen("Culture and behaviour");
    expect(system).toContain("KOGNOZ GROUND TRUTH");
    expect(system).toContain("BANNED");
    expect(system).toContain("WRITE UNEVENLY");
  });

  it("puts the topic and the format contract in the user half", () => {
    const { system, user } = gen("Culture and behaviour");
    expect(user).toContain("Culture and behaviour");
    expect(user).toContain("Return ONLY valid JSON");
    expect(system).not.toContain("Culture and behaviour");
  });

  it("keeps the search-grounding instruction out of the cached half", () => {
    // Grounding flips per call from a UI toggle. In the system half it would
    // split the cache in two for no reason.
    const on = buildGeneratePrompt({ topic: "GCC hiring numbers", pillar: "Market Intelligence", format: "Stat Card", grounded: true });
    const off = buildGeneratePrompt({ topic: "GCC hiring numbers", pillar: "Market Intelligence", format: "Stat Card", grounded: false });
    expect(on.system).toBe(off.system);
    expect(on.user).toContain("GROUNDING");
    expect(off.user).not.toContain("GROUNDING");
  });
});

describe("the banned list has exactly one source", () => {
  it("renders every phrase the linter checks for", () => {
    const { system } = buildGeneratePrompt({ topic: "Culture", pillar: "Culture", format: "Carousel" });
    for (const phrase of BANNED_PHRASES) expect(system).toContain(`"${phrase}"`);
  });

  it("reaches the caption and article prompts too", () => {
    const caption = buildCaptionPrompt({ channel: "Lokesh", fmt: "Text post", topic: "Culture" }).system;
    const article = buildArticlePrompt({ topic: "Culture", pillar: "Culture" }).system;
    // These used to be three hand-maintained copies that had already drifted;
    // the caption list was missing a third of the phrases the deck list banned.
    for (const phrase of BANNED_PHRASES) {
      expect(caption, `caption prompt missing "${phrase}"`).toContain(`"${phrase}"`);
      expect(article, `article prompt missing "${phrase}"`).toContain(`"${phrase}"`);
    }
  });
});

describe("the prompt no longer hands the model its own clichés", () => {
  const allFormats = STUDIO_FORMATS.map((f) => promptFor(f)).join("\n");

  it("has dropped the two sentences that were being reused verbatim", () => {
    expect(allFormats).not.toContain("decisions travel two levels up before anyone commits");
    expect(allFormats).not.toContain("The survey and the behavior disagree");
  });

  it("shows at most one lane illustration, and says not to reuse it", () => {
    const p = wholePrompt(buildGeneratePrompt({ topic: "Culture and engagement", pillar: "Culture", format: "Carousel" }));
    expect(p).toContain("do not reuse this line");
    expect((p.match(/How a problem in this lane actually sounds/g) || []).length).toBe(1);
  });

  it("rotates that illustration with the seed", () => {
    const a = buildGeneratePrompt({ topic: "Culture and engagement", pillar: "Culture", format: "Carousel", seed: 0 }).system;
    const b = buildGeneratePrompt({ topic: "Culture and engagement", pillar: "Culture", format: "Carousel", seed: 1 }).system;
    expect(a).not.toBe(b);
  });
});

// BRAND_CORE claimed a Middle East presence and named "the Immersion Index";
// DO_NOT_ASSERT forbids both. Both blocks went into the calendar-plan prompt, so
// it instructed and prohibited the same claim in one breath.
describe("the brand canon no longer contradicts DO_NOT_ASSERT", () => {
  const everything = [
    wholePrompt(buildGeneratePrompt({ topic: "Culture", pillar: "Culture", format: "Carousel" })),
    wholePrompt(buildCaptionPrompt({ channel: "Lokesh", fmt: "Text post", topic: "Culture" })),
    wholePrompt(buildArticlePrompt({ topic: "Culture", pillar: "Culture" }))
  ].join("\n");

  it("does not claim a Middle East presence", () => {
    expect(everything).not.toMatch(/Middle East/);
  });

  it("does not offer the Immersion Index as approved vocabulary", () => {
    expect(everything).not.toMatch(/Immersion Index/);
  });

  it("still carries the prohibition itself in the calendar prompt", () => {
    // The ban must survive; only the contradicting instruction was removed.
    const plan = wholePrompt(
      buildCalendarPlanPrompt({ year: 2026, monthName: "October", availableDays: [1], existingTopics: [], targetCount: 4 })
    );
    expect(plan).toContain('Never write "the Immersion Index"');
    expect(plan).toContain("Never claim a Middle East office");
  });
});

describe("voice samples reach the prompt", () => {
  const samples = [
    {
      id: "a",
      channel: "Lokesh" as const,
      kind: "post" as const,
      text: "The engagement survey said ownership. The decision logs said otherwise.",
      addedAt: "2026-09-04T00:00:00.000Z"
    }
  ];

  it("lands in the cacheable half of every writing prompt", () => {
    for (const p of [
      buildGeneratePrompt({ topic: "Culture", pillar: "Culture", format: "Carousel", voiceSamples: samples }),
      buildCaptionPrompt({ channel: "Lokesh", fmt: "Text post", topic: "Culture", voiceSamples: samples }),
      buildArticlePrompt({ topic: "Culture", pillar: "Culture", voiceSamples: samples }),
      buildCalendarPlanPrompt({ year: 2026, monthName: "October", availableDays: [1], existingTopics: [], targetCount: 4, voiceSamples: samples })
    ]) {
      expect(p.system).toContain("The decision logs said otherwise.");
      expect(p.system).toContain("written by a human");
    }
  });

  it("changes nothing when there are none", () => {
    const p = buildGeneratePrompt({ topic: "Culture", pillar: "Culture", format: "Carousel", voiceSamples: [] });
    expect(p.system).not.toContain("SAMPLE 1");
  });
});

describe("buildHumanizePrompt", () => {
  it("holds the shape for a deck and forbids changing the slide count", () => {
    const p = buildHumanizePrompt({ shape: "deck", draft: '{"cover":"x"}' });
    expect(p.user).toContain("exactly the same number of slides");
    expect(p.user).toContain('{"cover":"x"}');
  });

  it("asks for bare text on a caption", () => {
    const p = buildHumanizePrompt({ shape: "text", draft: "a post" });
    expect(p.user).toContain("No JSON");
  });

  it("forbids rescheduling on a month plan", () => {
    const p = buildHumanizePrompt({ shape: "topics", draft: '{"items":[]}' });
    expect(p.user).toContain("Do not change any day, channel, format or pillar");
  });

  it("tells the editor to leave every fact alone", () => {
    const p = buildHumanizePrompt({ shape: "text", draft: "d" });
    expect(p.system).toMatch(/Every fact in the draft must survive unchanged/);
    expect(p.user).toMatch(/Keep every fact, every number/);
  });

  it("names sentence-length uniformity as the first thing to fix", () => {
    const { system } = buildHumanizePrompt({ shape: "text", draft: "d" });
    expect(system).toMatch(/1\. Every sentence is about the same length/);
  });

  it("carries the linter findings through when there are any", () => {
    const p = buildHumanizePrompt({ shape: "text", draft: "d", findings: "\n- [cover] Uses the banned phrase \"unlock\".\n" });
    expect(p.user).toContain('Uses the banned phrase "unlock"');
  });
});
