// Cost controls for the Anthropic proxy, kept separate from the route so the
// arithmetic that decides what we spend is unit-testable. A mistake in here is
// a mistake that costs real money, so nothing in this file touches I/O.

export const MODEL_ALLOWLIST = [
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001"
] as const;
export type AllowedModel = (typeof MODEL_ALLOWLIST)[number];

export type Task =
  | "generate"
  | "revise"
  | "caption"
  | "article"
  | "verify"
  | "designNote"
  | "calendarPlan"
  | "humanize";
export const TASKS: Task[] = [
  "generate",
  "revise",
  "caption",
  "article",
  "verify",
  "designNote",
  "calendarPlan",
  "humanize"
];

// claude-sonnet-5 is $2/$10 per MTok against claude-sonnet-4-6's $3/$15 — cheaper
// and newer. 4.6 stays allowlisted purely as a rollback target.
export const DEFAULT_MODEL_FOR_TASK: Record<Task, AllowedModel> = {
  generate: "claude-sonnet-5",
  revise: "claude-haiku-4-5",
  caption: "claude-sonnet-5",
  article: "claude-sonnet-5",
  verify: "claude-sonnet-5",
  designNote: "claude-haiku-4-5",
  calendarPlan: "claude-sonnet-5",
  // The pass that decides whether the copy reads as human. Judgment-heavy, and
  // the one call in the app where a weaker model shows immediately.
  humanize: "claude-sonnet-5"
};

/**
 * Extended thinking, off.
 *
 * This is the single most important line in this file. On claude-sonnet-4-6,
 * OMITTING the `thinking` parameter meant no thinking. On claude-sonnet-5, omitting
 * it means adaptive thinking runs BY DEFAULT. So moving to sonnet-5 silently turned
 * reasoning on for every call, and that cost money three separate ways:
 *
 *   1. Thinking tokens bill as OUTPUT tokens — the most expensive kind.
 *   2. claudeClient drops `thinking` blocks when it flattens the reply to text, so
 *      we paid for reasoning nobody ever saw.
 *   3. Thinking spends the same max_tokens budget as the answer, so the JSON got
 *      truncated and the client had to buy a roomier retry.
 *
 * Verified against the live API: with `thinking` omitted the reply came back as
 * blocks {thinking: 1, text: 1}; with it disabled, {text: 1} and equally valid JSON.
 *
 * These are short, tightly-specified writing tasks with hard per-field character
 * limits, and they produced good output on sonnet-4-6 with no thinking at all. So
 * disabled is both the cheapest setting and the one matching known-good behaviour.
 */
export const THINKING: { type: "disabled" } = { type: "disabled" };

export type ThinkingConfig = { type: "disabled" } | { type: "adaptive" };

/**
 * Thinking, per task. Off everywhere except the humanize pass.
 *
 * The reasoning in the block above still holds for drafting: those are short,
 * tightly-specified writing tasks with hard per-field character limits, and
 * paying output-token rates for reasoning that claudeClient then throws away is
 * pure waste.
 *
 * Humanize is the exception, and it is the one place the cost buys something.
 * That call has to hold a draft, a set of human writing samples and a list of
 * faults in its head at once, then decide which sentences to break and which to
 * leave. That is judgment, not transcription. It is also the call that replaces
 * the old "draft first, then audit your draft" instruction, which was asking for
 * exactly this and had nowhere to do it.
 *
 * `effort` is kept low deliberately: the task is bounded and the draft is
 * already written, so this buys a scratchpad rather than a long deliberation.
 */
export const THINKING_FOR_TASK: Record<Task, ThinkingConfig> = {
  generate: { type: "disabled" },
  revise: { type: "disabled" },
  caption: { type: "disabled" },
  article: { type: "disabled" },
  verify: { type: "disabled" },
  designNote: { type: "disabled" },
  calendarPlan: { type: "disabled" },
  humanize: { type: "adaptive" }
};

/** Only sent when the task's thinking is on. Omitted otherwise. */
export const EFFORT_FOR_TASK: Partial<Record<Task, "low" | "medium" | "high">> = {
  humanize: "low"
};

export function thinkingFor(task: Task): ThinkingConfig {
  return THINKING_FOR_TASK[task] ?? THINKING;
}

/**
 * Billing is on ACTUAL output_tokens, never on the cap. A generous cap therefore
 * costs nothing, while a tight one truncates mid-JSON and sends the client into a
 * corrective retry — two paid calls for zero usable output.
 *
 * `grounded` caps are higher because a web-search request runs a server-side loop
 * (search -> read -> search -> answer) whose output_tokens accumulate across every
 * internal turn, not just the final message. Real logged calls came back at 2,769
 * and 4,057 output tokens against a 2,400 cap — truncating every time.
 */
export const TOKENS: Record<Task, { def: number; cap: number; groundedDef?: number; groundedCap?: number }> = {
  generate: { def: 2000, cap: 2400, groundedDef: 3000, groundedCap: 4500 },
  revise: { def: 1500, cap: 1800 },
  caption: { def: 1000, cap: 1200 },
  article: { def: 3000, cap: 3500 },
  verify: { def: 2500, cap: 3000, groundedDef: 3000, groundedCap: 4500 },
  designNote: { def: 800, cap: 1000 },
  // A month is ~36 entries at ~60 tokens each, so ~2,400 output tokens — which is
  // EXACTLY the plain `generate` cap, and the reason this is its own task rather than a
  // reuse of that one. On truncation claudeClient retries at def x 1.75, and that retry
  // is only real if the cap leaves room for it: at generate's 2000/2400 the roomier
  // retry gets clamped straight back to 2400 and truncates identically, buying a second
  // call for nothing. 4000 x 1.75 = 7000, comfortably inside 8000.
  calendarPlan: { def: 4000, cap: 8000 },
  // One task, three very different payloads: a deck (~800 output tokens), a
  // 1,200-word article (~2,000), or 36 rewritten calendar topics (~2,400). The
  // caller asks for what it needs and clampMaxTokens holds the ceiling.
  //
  // The cap is high for two reasons that compound. Billing is on actual output,
  // never on the cap, so headroom is free. And this is the one task with
  // thinking ON, which spends the SAME max_tokens budget as the answer — the
  // exact trap documented above, where a tight cap truncates the JSON and buys a
  // second call for nothing. def x 1.75 = 7,000 stays well inside the cap, so
  // claudeClient's roomier retry is real rather than clamped straight back.
  humanize: { def: 4000, cap: 12000 }
};

// calendarPlan is deliberately absent: the founder research is already done and written
// down in lib/founderProfiles.ts, so grounding it again would cost roughly 3.5x per run
// to rediscover facts nobody would review.
export const SEARCH_ALLOWED_TASKS: Task[] = ["generate", "verify"];

export const RATE_LIMIT_PER_HOUR = 60;
export const RATE_LIMIT_PER_DAY = 200;
export const SEARCH_LIMIT_PER_HOUR = 10;
export const MAX_SEARCHES_PER_REQUEST = 2;

/**
 * Dynamic filtering (web_search_20260209 run through code execution), OFF.
 *
 * The theory was that filtering results with code before they reach the context
 * window would cut input tokens. Measured against the live API, it does the
 * opposite on this workload — and it is the reason grounded generation felt slow.
 *
 * Matched pair, identical prompt, max_uses=2, two runs each:
 *
 *   dynamic filtering   16.7s / 208.3s   in=31,848 / 31,987   ~$0.095
 *   direct              13.3s /  14.7s   in=25,027 / 25,317   ~$0.078
 *
 * Two things to notice. Direct is ~17% cheaper, consistently, because the code
 * execution wrapper carries ~6,700 extra input tokens (its tool definitions alone
 * measured 5,953 vs 2,805). And far more important: filtering blew past 200s in
 * half its runs, while direct held 13-15s every time. That tail is fatal in
 * production — the route's 60s serverless ceiling would bill the call and discard
 * the answer, and the client would then retry and pay again.
 *
 * Flip back to true only with fresh measurements showing the tail latency gone.
 */
export const USE_DYNAMIC_FILTERING = false;

/**
 * Search tool variants in preference order. The route walks down this ladder on a
 * 400, so an unsupported tool version degrades grounding to a cheaper-but-working
 * variant instead of breaking it. A 400 is never billed, so stepping down is free.
 */
export function searchToolLadder(model: AllowedModel): Array<Record<string, unknown>> {
  const base = { name: "web_search", max_uses: MAX_SEARCHES_PER_REQUEST };
  // Dynamic filtering runs search from inside code execution, so it needs a model
  // with programmatic tool calling. Sonnet has it; haiku does not.
  const canFilter = USE_DYNAMIC_FILTERING && model.startsWith("claude-sonnet");
  return [
    ...(canFilter ? [{ type: "web_search_20260209", ...base }] : []),
    { type: "web_search_20260209", ...base, allowed_callers: ["direct"] },
    { type: "web_search_20250305", ...base }
  ];
}

/** USD per 1M tokens. Keep in sync with MODEL_ALLOWLIST. */
export const PRICING: Record<AllowedModel, { in: number; out: number; cacheWrite: number; cacheRead: number }> = {
  "claude-sonnet-5": { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-sonnet-4-6": { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 }
};

/** Web search is $10 per 1,000 searches, on top of tokens. */
export const USD_PER_SEARCH = 0.01;

export function isAllowedModel(model: string): model is AllowedModel {
  return (MODEL_ALLOWLIST as readonly string[]).includes(model);
}

/**
 * Clamp the client's requested output cap. `body.maxTokens` arrives from the
 * browser and was previously unbounded — a client could ask for 200000.
 */
export function clampMaxTokens(task: Task, requested?: unknown, useSearch = false): number {
  const t = TOKENS[task];
  const def = (useSearch && t.groundedDef) || t.def;
  const cap = (useSearch && t.groundedCap) || t.cap;
  const asked = typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? requested : def;
  return Math.min(Math.floor(asked), cap);
}

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
}

export function searchCount(usage: AnthropicUsage | undefined | null): number {
  const n = usage?.server_tool_use?.web_search_requests;
  return typeof n === "number" && n > 0 ? n : 0;
}

/** What this single call actually cost, in USD. */
export function costUsd(model: AllowedModel, usage: AnthropicUsage | undefined | null, searches: number): number {
  const p = PRICING[model];
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return (
    (n(usage?.input_tokens) * p.in +
      n(usage?.output_tokens) * p.out +
      n(usage?.cache_creation_input_tokens) * p.cacheWrite +
      n(usage?.cache_read_input_tokens) * p.cacheRead) /
      1_000_000 +
    searches * USD_PER_SEARCH
  );
}
