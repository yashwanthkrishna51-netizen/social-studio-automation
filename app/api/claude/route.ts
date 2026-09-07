import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase";
import {
  MODEL_ALLOWLIST,
  TASKS,
  DEFAULT_MODEL_FOR_TASK,
  SEARCH_ALLOWED_TASKS,
  RATE_LIMIT_PER_HOUR,
  RATE_LIMIT_PER_DAY,
  SEARCH_LIMIT_PER_HOUR,
  searchToolLadder,
  isAllowedModel,
  clampMaxTokens,
  thinkingFor,
  EFFORT_FOR_TASK,
  costUsd,
  searchCount,
  type AllowedModel,
  type Task
} from "@/lib/costControls";

// PRD §3.1 + §13. This route is a dumb, hardened proxy: prompt TEXT itself
// (BRAND_CORE, lane context, format specs, LINE_RULE, grounding/voice blocks,
// contracts) is composed client-side in lib/promptBuilders.ts. This route only
// enforces the rules the PRD nails down: model allowlist, search gating, rate
// limit, spend logging, sanitized errors — plus the cost controls below.

// A non-streaming call with web search can run well past Vercel's default
// serverless timeout. A timeout still bills the Anthropic call but throws the
// result away, and the client then retries — paying twice for one answer.
export const maxDuration = 60;

interface ClaudeRequestBody {
  task: Task;
  prompt: string;
  /**
   * The stable half of the prompt: brand canon, rules, voice samples. Sent as a
   * real system block with cache_control so it is billed at cache-read rates
   * after the first call. Optional — an older client that sends only `prompt`
   * still works, it just pays full price.
   */
  system?: string;
  model?: string;
  maxTokens?: number;
  useSearch?: boolean;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userEmail = session.user.email;

  let body: ClaudeRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { task, prompt, system, useSearch = false } = body;

  if (!TASKS.includes(task)) {
    return NextResponse.json({ error: `Unknown task: ${task}` }, { status: 400 });
  }
  if (!prompt || typeof prompt !== "string") {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  const model = body.model ?? DEFAULT_MODEL_FOR_TASK[task];
  if (!isAllowedModel(model)) {
    return NextResponse.json(
      { error: `Model not allowed: ${model}. Allowed: ${MODEL_ALLOWLIST.join(", ")}` },
      { status: 400 }
    );
  }

  if (useSearch && !SEARCH_ALLOWED_TASKS.includes(task)) {
    return NextResponse.json(
      { error: `useSearch not permitted for task "${task}". Allowed for: ${SEARCH_ALLOWED_TASKS.join(", ")}` },
      { status: 400 }
    );
  }

  const supabase = getSupabaseServerClient();

  // Every attempt is logged — successes AND failures — so retries and errored
  // calls count against the ceiling. Logging only successes (the old behaviour)
  // left the limiter leaky in exactly the runaway case it exists to stop.
  const logAttempt = async (fields: Record<string, unknown>) => {
    const { error } = await supabase.from("api_call_log").insert({
      user_email: userEmail,
      task,
      model,
      use_search: useSearch,
      ...fields
    });
    if (error) console.error("spend log insert failed", error.message);
  };

  const now = Date.now();
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const countSince = async (since: string, searchOnly = false) => {
    let q = supabase
      .from("api_call_log")
      .select("id", { count: "exact", head: true })
      .eq("user_email", userEmail)
      .gte("created_at", since);
    if (searchOnly) q = q.eq("use_search", true);
    const { count, error } = await q;
    if (error) {
      // Visible failure, but don't hard-block the request over a logging-table issue.
      console.error("rate limit check failed", error.message);
      return null;
    }
    return count ?? 0;
  };

  const limited = (message: string, retryAfter: number) =>
    NextResponse.json({ error: message }, { status: 429, headers: { "Retry-After": String(retryAfter) } });

  const hourCount = await countSince(oneHourAgo);
  if (hourCount !== null && hourCount >= RATE_LIMIT_PER_HOUR) {
    return limited(`Rate limit reached (${RATE_LIMIT_PER_HOUR}/hour). Try again shortly.`, 600);
  }

  const dayCount = await countSince(oneDayAgo);
  if (dayCount !== null && dayCount >= RATE_LIMIT_PER_DAY) {
    return limited(`Daily limit reached (${RATE_LIMIT_PER_DAY}/day). Try again tomorrow.`, 3600);
  }

  if (useSearch) {
    const searchCount = await countSince(oneHourAgo, true);
    if (searchCount !== null && searchCount >= SEARCH_LIMIT_PER_HOUR) {
      return limited(
        `Web-search limit reached (${SEARCH_LIMIT_PER_HOUR}/hour). Grounded generation and fact-checking cost several times a normal request — try again shortly, or generate without grounding.`,
        600
      );
    }
  }

  // Clamped server-side. Previously `useSearch` overrode any client value and
  // `body.maxTokens` was unbounded — a client could post 200000.
  const maxTokens = clampMaxTokens(task, body.maxTokens, useSearch);

  const thinking = thinkingFor(task);

  const anthropicBody: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    // Explicit, not omitted. On sonnet-5 an absent `thinking` means adaptive
    // thinking runs by default — see THINKING_FOR_TASK in lib/costControls.ts.
    thinking,
    messages: [{ role: "user", content: prompt }]
  };

  // Effort only means something when thinking is on; sending it alongside
  // disabled thinking is at best noise.
  const effort = thinking.type === "adaptive" ? EFFORT_FOR_TASK[task] : undefined;
  if (effort) anthropicBody.output_config = { effort };

  // The cacheable half. Every prompt in lib/promptBuilders.ts is split so that
  // the brand canon, the rules and the voice samples land here and repeat
  // byte-for-byte between calls, while the topic and the format contract stay in
  // the user turn. Without this the whole prompt was one user message paid for in
  // full every time, which is why the brand context had to stay thin.
  //
  // Caching is a prefix match, so a change anywhere in this block invalidates it.
  // Watch cache_read_input_tokens in api_call_log: a steady zero means something
  // volatile has leaked into the system half.
  if (typeof system === "string" && system.trim()) {
    anthropicBody.system = [
      { type: "text", text: system, cache_control: { type: "ephemeral" } }
    ];
  }

  const ladder = useSearch ? searchToolLadder(model) : [];
  if (useSearch) anthropicBody.tools = [ladder[0]];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Server misconfigured: ANTHROPIC_API_KEY missing" }, { status: 500 });
  }

  const send = (payload: Record<string, unknown>) =>
    fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(payload)
    });

  const failNetwork = async () => {
    // §13: never expose raw provider errors with keys/headers. Network-level failure only.
    await logAttempt({ ok: false, max_tokens: maxTokens, error_type: "NetworkError" });
    return NextResponse.json({ error: "Failed to reach Anthropic API", name: "NetworkError" }, { status: 502 });
  };

  let anthropicRes: Response;
  let data: any;

  // Walk the search-tool ladder. A tool version this account or model doesn't accept
  // comes back as a 400 during request validation — before any inference and before
  // any search — so stepping down to a simpler variant costs nothing and keeps
  // grounding working rather than failing the user outright.
  for (let rung = 0; ; rung++) {
    try {
      anthropicRes = await send(anthropicBody);
    } catch {
      return await failNetwork();
    }
    try {
      data = await anthropicRes.json();
    } catch {
      await logAttempt({ ok: false, max_tokens: maxTokens, error_type: "NonJsonUpstreamResponse" });
      return NextResponse.json({ error: "Unreadable response from Anthropic API" }, { status: 502 });
    }

    const toolRejected =
      !anthropicRes.ok &&
      anthropicRes.status === 400 &&
      useSearch &&
      rung + 1 < ladder.length &&
      /tool|allowed_callers|code_execution|web_search/i.test(String(data?.error?.message ?? ""));
    if (!toolRejected) break;

    console.warn(
      `[claude] search tool "${ladder[rung].type}" rejected (${data?.error?.message}); falling back to "${ladder[rung + 1].type}"`
    );
    anthropicBody.tools = [ladder[rung + 1]];
  }

  if (!anthropicRes.ok) {
    // Pass through the error TYPE/MESSAGE (useful, visible per product principle #4)
    // but never headers or the key.
    await logAttempt({
      ok: false,
      max_tokens: maxTokens,
      error_type: data?.error?.type ?? `http_${anthropicRes.status}`
    });
    const headers: Record<string, string> = {};
    const retryAfter = anthropicRes.headers.get("retry-after");
    if (retryAfter) headers["Retry-After"] = retryAfter;
    return NextResponse.json(
      { error: data?.error?.message ?? "Anthropic API error", type: data?.error?.type ?? "unknown" },
      { status: anthropicRes.status, headers }
    );
  }

  const searches = searchCount(data?.usage);

  // Awaited, not fire-and-forget: on Vercel a floating promise can be cut off when
  // the response returns, which silently drops spend rows and under-counts the limit.
  await logAttempt({
    ok: true,
    max_tokens: maxTokens,
    stop_reason: data?.stop_reason ?? null,
    input_tokens: data?.usage?.input_tokens ?? null,
    output_tokens: data?.usage?.output_tokens ?? null,
    cache_creation_input_tokens: data?.usage?.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: data?.usage?.cache_read_input_tokens ?? null,
    web_search_requests: searches,
    cost_usd: costUsd(model, data?.usage, searches)
  });

  // stop_reason lets the client tell a truncated reply (retrying at the same cap
  // is guaranteed waste) from a genuinely malformed one.
  return NextResponse.json({ content: data.content, usage: data.usage, stop_reason: data.stop_reason });
}
