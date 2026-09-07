// Client-side Claude caller — ported from kognoz-social-studio-v3.jsx's
// callClaudeJSON/callClaudeText, but re-pointed at OUR /api/claude proxy
// instead of https://api.anthropic.com directly.
//
// Why this had to change (not just a style choice): the reference jsx's
// direct fetch to api.anthropic.com carries no API key at all — it only
// works inside the Claude-artifact sandbox, where the platform injects
// access for the running artifact. There is no such sandbox in a standalone
// deploy. The key lives in Vercel's server env only (see .env.example) and
// is never sent to, or readable from, the browser. This file never touches
// it — every call here is a same-origin fetch to our own Next.js route.
//
// RETRY POLICY (this is a spend control, not just error handling). Every retry
// here is a second billable Anthropic call, so each one has to earn its place:
//
//   4xx (bad request, 401, 429 rate limit)  -> never retry. A 400 fails
//        identically the second time, and retrying a 429 makes it worse.
//   network error / 5xx / 529 overloaded    -> retry once, backing off and
//        respecting Retry-After. These produce no output, so nothing was billed.
//   200 but stop_reason "max_tokens"        -> the reply was truncated mid-JSON.
//        Retrying at the SAME cap is guaranteed to truncate again: two paid calls,
//        zero usable output. Retry once with more room instead.
//   200, complete, but unparseable          -> the one case a corrective retry
//        actually fixes. Retry once asking for bare JSON.
//
// The old code used a bare `catch {}` around everything, so a 429 from our own
// limiter or an Anthropic 529 silently doubled the bill.
"use client";

// Hand-duplicated from costControls' `Task` rather than imported, because this file is
// "use client" and that one is server-shared. The two can drift silently, so they are
// changed together.
export type ClaudeTask =
  | "generate"
  | "revise"
  | "caption"
  | "article"
  | "verify"
  | "designNote"
  | "calendarPlan"
  | "humanize";

export const FAST_MODEL = "claude-haiku-4-5";

/**
 * A prompt in two halves. Structurally identical to `BuiltPrompt` in
 * lib/promptBuilders.ts, redeclared here for the same reason ClaudeTask is:
 * this file is "use client" and that one pulls in the whole brand canon, which
 * has no business in the transport layer.
 *
 * `system` is the stable half and the route attaches cache_control to it, so
 * anything volatile put in there quietly costs money on every call.
 */
export interface PromptParts {
  system: string;
  user: string;
}

const REQUEST_TIMEOUT_MS = 90_000;

interface CallOpts {
  model?: string;
  maxTokens?: number;
  useSearch?: boolean;
}

interface ProxyResult {
  text: string;
  stopReason: string | null;
}

export class ClaudeError extends Error {
  status: number | null;
  retryAfterMs: number | null;
  constructor(message: string, status: number | null = null, retryAfterMs: number | null = null) {
    super(message);
    this.name = "ClaudeError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
  /** 4xx: deterministic. A second identical call would fail identically. */
  get isClientError() {
    return this.status !== null && this.status >= 400 && this.status < 500;
  }
  /** Network failure or 5xx: transient, and nothing was billed. Worth one retry. */
  get isTransient() {
    return this.status === null || this.status >= 500;
  }
}

async function callProxy(task: ClaudeTask, prompt: PromptParts, opts: CallOpts = {}): Promise<ProxyResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch("/api/claude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task,
        prompt: prompt.user,
        system: prompt.system,
        model: opts.model,
        maxTokens: opts.maxTokens,
        useSearch: opts.useSearch
      }),
      signal: controller.signal
    });
  } catch (e) {
    throw new ClaudeError(e instanceof Error && e.name === "AbortError" ? "request timed out" : "network error");
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const header = res.headers.get("retry-after");
    const retryAfterMs = header && !Number.isNaN(Number(header)) ? Number(header) * 1000 : null;
    throw new ClaudeError(data?.error || `HTTP ${res.status}`, res.status, retryAfterMs);
  }

  const content = (data?.content || []) as { type: string; text?: string }[];
  return {
    text: content
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join(""),
    stopReason: data?.stop_reason ?? null
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One transport-level retry, for failures that cost nothing and may succeed on a
 * second try. 4xx never gets here.
 */
async function callProxyResilient(task: ClaudeTask, prompt: PromptParts, opts: CallOpts): Promise<ProxyResult> {
  try {
    return await callProxy(task, prompt, opts);
  } catch (e) {
    if (e instanceof ClaudeError && e.isClientError) throw e;
    if (!(e instanceof ClaudeError) || !e.isTransient) throw e;
    await sleep(e.retryAfterMs ?? 1200);
    return await callProxy(task, prompt, opts);
  }
}

const extractJson = (text: string) => {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a === -1 || b <= a) throw new Error("no json");
  return JSON.parse(text.slice(a, b + 1));
};

export async function callClaudeJSON(task: ClaudeTask, prompt: PromptParts, opts: CallOpts = {}): Promise<any> {
  const first = await callProxyResilient(task, prompt, opts);
  try {
    return extractJson(first.text);
  } catch {
    // Truncated: the model ran out of room mid-object. Give it more room rather
    // than buying the identical truncation a second time.
    if (first.stopReason === "max_tokens") {
      const roomier = { ...opts, maxTokens: Math.round((opts.maxTokens ?? 2000) * 1.75) };
      const retry = await callProxyResilient(task, prompt, roomier);
      try {
        return extractJson(retry.text);
      } catch {
        throw new ClaudeError(
          "the model's reply was cut off before it finished. Try a shorter topic or fewer slides."
        );
      }
    }
    // Complete but malformed — the only case a corrective nudge actually fixes.
    // Appended to the USER half only. Adding it to the system half would change
    // the cached prefix and throw away the cache entry on every corrective retry.
    const fixed = await callProxyResilient(
      task,
      {
        ...prompt,
        user: prompt.user + "\n\nIMPORTANT: your previous reply was not valid JSON. Return ONLY the JSON object, nothing else."
      },
      opts
    );
    return extractJson(fixed.text);
  }
}

export async function callClaudeText(task: ClaudeTask, prompt: PromptParts, opts: CallOpts = {}): Promise<string> {
  const { text, stopReason } = await callProxyResilient(task, prompt, opts);
  const trimmed = text.trim();
  if (!trimmed) {
    // An empty 200 is not a transport failure; re-asking the same question the
    // same way is unlikely to help and always costs. Surface it instead.
    throw new ClaudeError("the model returned an empty reply");
  }
  if (stopReason === "max_tokens") {
    // Usable, just cut short. Return it — throwing away paid output to buy it
    // again would be the expensive choice.
    console.warn(`[claude] ${task} hit the output cap; returning the partial reply`);
  }
  return trimmed;
}
