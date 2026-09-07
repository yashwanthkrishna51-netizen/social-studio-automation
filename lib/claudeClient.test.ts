import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callClaudeJSON, callClaudeText, ClaudeError, FAST_MODEL } from "./claudeClient";

// Every retry in claudeClient is a second billable Anthropic call. These tests pin
// down exactly when one is allowed to happen. The pre-fix implementation wrapped
// everything in a bare `catch {}`, so a 429 from our own limiter or an Anthropic
// 529 silently doubled the bill; the cases below are what stops that regressing.

type Call = { body: any };
let calls: Call[] = [];

function mockFetch(responses: Array<() => any>) {
  let i = 0;
  global.fetch = vi.fn(async (_url: any, init: any) => {
    calls.push({ body: JSON.parse(init.body) });
    const make = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return make();
  }) as any;
}

const ok = (payload: any) => () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => payload
});

const httpError = (status: number, retryAfter?: string) => () => ({
  ok: false,
  status,
  headers: { get: (h: string) => (h.toLowerCase() === "retry-after" && retryAfter ? retryAfter : null) },
  json: async () => ({ error: `boom ${status}` })
});

const textReply = (text: string, stop_reason: string | null = "end_turn") =>
  ok({ content: [{ type: "text", text }], stop_reason });

beforeEach(() => {
  calls = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("callClaudeJSON — happy path", () => {
  it("makes exactly one call when the first reply parses", async () => {
    mockFetch([textReply('{"cover":"hi"}')]);
    await expect(callClaudeJSON("generate", { system: "", user: "p" })).resolves.toEqual({ cover: "hi" });
    expect(calls).toHaveLength(1);
  });

  it("tolerates prose wrapped around the JSON without a second call", async () => {
    mockFetch([textReply('Sure!\n```json\n{"cover":"hi"}\n```')]);
    await expect(callClaudeJSON("generate", { system: "", user: "p" })).resolves.toEqual({ cover: "hi" });
    expect(calls).toHaveLength(1);
  });
});

describe("callClaudeJSON — 4xx must never be retried", () => {
  it("does not buy a second call on a 429 rate limit", async () => {
    mockFetch([httpError(429, "600")]);
    await expect(callClaudeJSON("generate", { system: "", user: "p" })).rejects.toBeInstanceOf(ClaudeError);
    expect(calls).toHaveLength(1);
  });

  it("does not buy a second call on a 400 bad request", async () => {
    mockFetch([httpError(400)]);
    await expect(callClaudeJSON("generate", { system: "", user: "p" })).rejects.toBeInstanceOf(ClaudeError);
    expect(calls).toHaveLength(1);
  });

  it("does not buy a second call on a 401", async () => {
    mockFetch([httpError(401)]);
    await expect(callClaudeJSON("revise", { system: "", user: "p" })).rejects.toBeInstanceOf(ClaudeError);
    expect(calls).toHaveLength(1);
  });

  it("surfaces the status on the error so callers can react", async () => {
    mockFetch([httpError(429, "600")]);
    const err = await callClaudeJSON("generate", { system: "", user: "p" }).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.isClientError).toBe(true);
    expect(err.retryAfterMs).toBe(600_000);
  });
});

describe("callClaudeJSON — transient failures may be retried once", () => {
  it("retries a 500 exactly once and succeeds", async () => {
    mockFetch([httpError(500), textReply('{"cover":"ok"}')]);
    await expect(callClaudeJSON("generate", { system: "", user: "p" })).resolves.toEqual({ cover: "ok" });
    expect(calls).toHaveLength(2);
  });

  it("retries an overloaded 529 rather than failing the user", async () => {
    mockFetch([httpError(529), textReply('{"cover":"ok"}')]);
    await expect(callClaudeJSON("generate", { system: "", user: "p" })).resolves.toEqual({ cover: "ok" });
    expect(calls).toHaveLength(2);
  });

  it("gives up after one transient retry instead of looping", async () => {
    mockFetch([httpError(500)]);
    await expect(callClaudeJSON("generate", { system: "", user: "p" })).rejects.toBeInstanceOf(ClaudeError);
    expect(calls).toHaveLength(2);
  });
});

describe("callClaudeJSON — truncation", () => {
  it("retries a truncated reply with MORE room, not the same doomed cap", async () => {
    // The old code re-sent at the identical cap, so it truncated again:
    // two paid calls, zero usable output.
    mockFetch([textReply('{"cover":"cut off her', "max_tokens"), textReply('{"cover":"complete"}')]);
    await expect(callClaudeJSON("generate", { system: "", user: "p" }, { maxTokens: 2000 })).resolves.toEqual({ cover: "complete" });
    expect(calls).toHaveLength(2);
    expect(calls[1].body.maxTokens).toBeGreaterThan(calls[0].body.maxTokens);
  });

  it("explains truncation plainly when the roomier retry also fails", async () => {
    mockFetch([textReply("{ still cut", "max_tokens")]);
    const err = await callClaudeJSON("generate", { system: "", user: "p" }, { maxTokens: 2000 }).catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeError);
    expect(err.message).toMatch(/cut off/i);
    expect(calls).toHaveLength(2);
  });

  it("does not send the corrective 'not valid JSON' nudge for a truncation", async () => {
    // The reply wasn't malformed, it was cut short — nudging is the wrong fix.
    mockFetch([textReply("{ cut", "max_tokens"), textReply('{"ok":1}')]);
    await callClaudeJSON("generate", { system: "", user: "p" }, { maxTokens: 2000 });
    expect(calls[1].body.prompt).not.toMatch(/not valid JSON/);
  });
});

describe("callClaudeJSON — malformed but complete", () => {
  it("sends one corrective retry at the same cap", async () => {
    mockFetch([textReply("here you go, no braces at all"), textReply('{"cover":"fixed"}')]);
    await expect(callClaudeJSON("generate", { system: "", user: "p" }, { maxTokens: 2000 })).resolves.toEqual({ cover: "fixed" });
    expect(calls).toHaveLength(2);
    expect(calls[1].body.prompt).toMatch(/Return ONLY the JSON object/);
    expect(calls[1].body.maxTokens).toBe(2000);
  });

  it("stops after that one corrective retry", async () => {
    mockFetch([textReply("no json here")]);
    await expect(callClaudeJSON("generate", { system: "", user: "p" })).rejects.toBeTruthy();
    expect(calls).toHaveLength(2);
  });
});

describe("callClaudeText", () => {
  it("makes exactly one call on success", async () => {
    mockFetch([textReply("An article.")]);
    await expect(callClaudeText("article", { system: "", user: "p" })).resolves.toBe("An article.");
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 429 — the old fixed 700ms retry doubled the bill", async () => {
    mockFetch([httpError(429, "600")]);
    await expect(callClaudeText("article", { system: "", user: "p" })).rejects.toBeInstanceOf(ClaudeError);
    expect(calls).toHaveLength(1);
  });

  it("does not re-ask on an empty 200 reply", async () => {
    mockFetch([textReply("   ")]);
    await expect(callClaudeText("article", { system: "", user: "p" })).rejects.toThrow(/empty/i);
    expect(calls).toHaveLength(1);
  });

  it("keeps a truncated article rather than paying to regenerate it", async () => {
    mockFetch([textReply("A partial article that got cut", "max_tokens")]);
    await expect(callClaudeText("article", { system: "", user: "p" })).resolves.toMatch(/partial article/);
    expect(calls).toHaveLength(1);
  });

  it("retries a 5xx once", async () => {
    mockFetch([httpError(503), textReply("recovered")]);
    await expect(callClaudeText("article", { system: "", user: "p" })).resolves.toBe("recovered");
    expect(calls).toHaveLength(2);
  });
});

describe("request shape", () => {
  it("forwards task, model and search flag to the proxy", async () => {
    mockFetch([textReply('{"a":1}')]);
    await callClaudeJSON("verify", { system: "", user: "prompt text" }, { useSearch: true, model: FAST_MODEL });
    expect(calls[0].body).toMatchObject({ task: "verify", useSearch: true, model: FAST_MODEL });
  });

  it("uses the undated haiku id", () => {
    expect(FAST_MODEL).toBe("claude-haiku-4-5");
  });
});

// The prompt travels in two halves because the route attaches cache_control to
// the system one. Anything that moves volatile text into `system`, or that
// rewrites `system` on a retry, silently destroys the cache and puts the input
// cost back to full price on every call.
describe("the system half and the prompt cache", () => {
  it("sends the two halves in separate fields", async () => {
    mockFetch([textReply('{"ok":1}')]);
    await callClaudeJSON("generate", { system: "BRAND CANON", user: "the topic" });
    expect(calls[0].body.system).toBe("BRAND CANON");
    expect(calls[0].body.prompt).toBe("the topic");
  });

  it("leaves the system half byte-identical on the corrective retry", async () => {
    mockFetch([textReply("no braces here"), textReply('{"ok":1}')]);
    await callClaudeJSON("generate", { system: "BRAND CANON", user: "the topic" });
    expect(calls).toHaveLength(2);
    expect(calls[1].body.system).toBe(calls[0].body.system);
    expect(calls[1].body.prompt).toMatch(/Return ONLY the JSON object/);
  });

  it("leaves the system half byte-identical on the roomier truncation retry", async () => {
    mockFetch([textReply("{ cut", "max_tokens"), textReply('{"ok":1}')]);
    await callClaudeJSON("generate", { system: "BRAND CANON", user: "the topic" }, { maxTokens: 2000 });
    expect(calls[1].body.system).toBe("BRAND CANON");
  });

  it("carries the system half on text calls too", async () => {
    mockFetch([textReply("a post")]);
    await callClaudeText("caption", { system: "VOICE", user: "write it" });
    expect(calls[0].body.system).toBe("VOICE");
  });
});
