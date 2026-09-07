// BRAND_CORE + Practice Lanes + lane detector (§6.1/§6.2 in the PRD).
// Injected into every fresh generation and caption. This is the firm's
// ground-truth language, agreed with the client — do not paraphrase it lightly.
//
// TWO DELIBERATE DEPARTURES from the original text, both to remove a
// contradiction that was reaching the model inside a single prompt:
//
//   1. "the Middle East" is gone from the positioning line. DO_NOT_ASSERT in
//      lib/founderProfiles.ts says research could not confirm a Middle East
//      office or market presence, and names Gurugram, Kuala Lumpur and Makati
//      City as the verified ones. The calendar-plan prompt carried both blocks,
//      so it told the model to say a thing and forbade the same thing.
//   2. "the Immersion Index(TM)" is gone. Same source: the phrase has no public
//      footprint connected to Kognoz. The five conditions it named are real and
//      are kept; only the unverified label is dropped.
//
// If the client confirms either claim, restore it HERE and delete the matching
// line from DO_NOT_ASSERT in the same change. Never restore it in one place only.
export const BRAND_CORE = `KOGNOZ GROUND TRUTH (canon; from the firm's website):
Positioning: "Your people are your strategy." Kognoz helps organizations across India and Southeast Asia unlock what their people are capable of, through culture, talent, and organization consulting built on behavioral science and scaled by AI.
Method: We measure behavior, not opinion. Every organizational problem shows up first as behavior, long before it reaches a dashboard.
Augmented Intelligence(TM): behavioral science, scaled by AI, with people always making the call. AI recommends; a human always decides.
Proof: 650,000+ jobs architected, 50,000+ leadership assessments, 200+ enterprises, 12 countries. Konverz AI is the firm's talent platform.`;

export type PracticeLane = "culture" | "talent" | "org" | "aiwork" | "family";

interface LaneSpec {
  /** Heading, kept in the exact wording the prompt used to carry. */
  heading: string;
  /** In-lane concepts and vocabulary. */
  concepts: string;
  /**
   * Illustrations of how a problem in this lane actually sounds.
   *
   * Split out of the prose so exactly ONE reaches any given prompt. Previously
   * every generation saw the same one or two, and the model reliably reused
   * them — which is a large part of why every deck sounded like every other
   * deck. One example teaches the register; the same example every time
   * teaches the sentence.
   */
  examples: string[];
  /** What this lane must not borrow. Blended-practice content reads as generic consulting. */
  offLimits: string;
}

const LANE_SPECS: Record<PracticeLane, LaneSpec> = {
  culture: {
    heading: "THIS PIECE LIVES IN THE CULTURE LANE.",
    concepts:
      "In-lane concepts: the five conditions Kognoz reads culture through (Purpose, Ownership, Mastery, Trust, Wellbeing); behavior versus survey; psychological safety read through speak-up behavior; what teams do under pressure; rituals, recognition, and manager behavior as culture's transmission mechanism.",
    examples: [
      "engagement scores look fine, but the energy is gone",
      "people nod in the room, then nothing changes",
      "the same two people speak in every meeting and nobody notices",
      "praise is public, correction is private, and neither travels"
    ],
    offLimits:
      "OFF-LIMITS here (they belong to other practices): org structure, decision rights, spans and layers, Decision Architecture (Organization Design); succession depth and bench strength (Talent & Leadership); AI adoption mechanics and the Work Spectrum (Human + AI Work Design); founder and family dynamics (Family Business)."
  },
  talent: {
    heading: "THIS PIECE LIVES IN THE TALENT & LEADERSHIP LANE.",
    concepts:
      "In-lane concepts: succession depth and bench strength; readiness and time-to-ready; hidden high performers invisible to managers; leadership assessment through behavior; regretted attrition without early warning; nationalization pipelines (Saudization, Emiratization); internal mobility.",
    examples: [
      "when a key person resigns, there's no one ready",
      "the successor list has three names and all three report to the same person",
      "the people the system rates highest are not the people the work depends on",
      "the exit interview says pay, the calendar said something else six months earlier"
    ],
    offLimits:
      "OFF-LIMITS here: the five culture conditions and culture diagnosis (Culture); org structure and decision rights (Organization Design); AI work redesign and the Spectrum (Human + AI Work Design); family governance (Family Business)."
  },
  org: {
    heading: "THIS PIECE LIVES IN THE ORGANIZATION DESIGN LANE.",
    concepts:
      "In-lane concepts: Decision Architecture (structure matched to the weight of decisions, authority pushed to where the work is); decision rights and accountability; operating models that the business has outgrown; spans, layers, and job architecture.",
    examples: [
      "everything needs three sign-offs and nobody feels accountable",
      "the decision took nine days and eight of them were waiting",
      "two teams own the same number and neither owns the outcome",
      "the structure was designed for a company a third of this size"
    ],
    offLimits:
      "OFF-LIMITS here: engagement, psychological safety, and the five culture conditions (Culture); succession and assessments (Talent & Leadership); the Human-AI Work Spectrum (Human + AI Work Design); family power structures (Family Business)."
  },
  aiwork: {
    heading: "THIS PIECE LIVES IN THE HUMAN + AI WORK DESIGN LANE.",
    concepts:
      "In-lane concepts: the Human-AI Work Spectrum (human-led, human + AI together, AI-led) with trust thresholds per decision type; task decomposition; work redesigned around what people and AI each do best; AI-led HR reinvention; adoption as behavior change, not training.",
    examples: [
      "you bought the AI, but nothing about how work happens changed",
      "the tool drafts in seconds and the approval still takes four days",
      "the licences are all assigned and a quarter of them have never been opened",
      "people use it for the work they were already fastest at"
    ],
    offLimits:
      "OFF-LIMITS here: deep culture diagnosis and the five conditions in detail (Culture); succession and bench (Talent & Leadership); full org restructuring language (Organization Design); family dynamics (Family Business)."
  },
  family: {
    heading: "THIS PIECE LIVES IN THE FAMILY BUSINESS LANE.",
    concepts:
      "In-lane concepts: the lived power structure versus the org chart; succession as a transfer of real decisions, not a date; generational alignment; governance that respects legacy while professionalizing; the founder's weight in every room.",
    examples: [
      "the org chart says one thing; real authority sits elsewhere",
      "the succession date is set and the decisions have not moved",
      "the professional hire has the title and the founder still takes the call",
      "everyone defers to a person who is not in the meeting"
    ],
    offLimits:
      "OFF-LIMITS here: corporate frameworks quoted cold (the Spectrum, the five conditions) unless translated into family language; generic HR vocabulary."
  }
};

/**
 * Rendered lane text. Exported so tests and callers can see a lane without
 * routing to it. `seed` selects which single illustration is shown.
 */
export function laneText(lane: PracticeLane, seed = 0): string {
  const spec = LANE_SPECS[lane];
  const i = ((Math.trunc(seed) % spec.examples.length) + spec.examples.length) % spec.examples.length;
  return `${spec.heading}
${spec.concepts}
How a problem in this lane actually sounds, as ONE example of register only — do not reuse this line: "${spec.examples[i]}"
${spec.offLimits}`;
}

/**
 * Back-compatible rendering of the five lanes, one string each.
 *
 * Kept because it was exported before and reads well in isolation; it shows the
 * first illustration. Prompts should call `laneContext`, which rotates.
 */
export const PRACTICE_LANES: Record<PracticeLane, string> = {
  culture: laneText("culture"),
  talent: laneText("talent"),
  org: laneText("org"),
  aiwork: laneText("aiwork"),
  family: laneText("family")
};

/** The lane a topic belongs to, or null when nothing matches. */
export function laneFor(topicText: unknown): PracticeLane | null {
  const t = String(topicText || "").toLowerCase();
  if (/family|founder|promoter|next.?gen|generational|patriarch|legacy/.test(t)) return "family";
  if (
    /organi[sz]ation|org design|structure|decision right|operating model|span|layer|job architecture|sign.?off|accountab/.test(
      t
    )
  )
    return "org";
  if (/talent|succession|bench|readiness|assessment|leadership pipeline|attrition|retention|hiring|mobility|hipo/.test(t))
    return "talent";
  if (/\bai\b|agent|automation|copilot|spectrum|augmented|technology|reinvent.*hr|hr.*ai/.test(t)) return "aiwork";
  if (/culture|engag|immersion|psycholog|safety|ritual|values|behavio/.test(t)) return "culture";
  return null;
}

// Detector — keyword routing on the topic, priority order matters:
// family -> org -> talent -> aiwork -> culture -> general fallback.
// PRD §16 unit test: "internal mobility ... AI skills" must route talent, not aiwork.
export function laneContext(topicText: unknown, seed = 0): string {
  const lane = laneFor(topicText);

  if (!lane)
    return `SUBJECT DISCIPLINE: choose ONE Kognoz practice lens for this piece (Culture, Talent & Leadership, Organization Design, Human + AI Work Design, or Family Business) and stay strictly inside it. Do not blend frameworks from different practices.`;
  return (
    laneText(lane, seed) +
    `\nSUBJECT DISCIPLINE: stay strictly inside this lane. Do not import the off-limits concepts. If the topic genuinely touches a second practice, keep this lane primary and give the other at most one closing sentence that names it as adjacent work.`
  );
}
