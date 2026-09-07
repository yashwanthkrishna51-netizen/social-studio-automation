import { createClient } from "@supabase/supabase-js";

// Server-only client. Uses the service-role key — never import this file from
// a "use client" component. Route handlers only.
export function getSupabaseServerClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — set in Vercel env (see .env.example)"
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// Keep in sync with the CHECK constraint on store.key — schema.sql and
// supabase/migrations/2026-09-04_voice_samples.sql. A key added here but not
// there is accepted by the route and rejected by the database.
export const STORE_KEYS = [
  "kognoz-calendar",
  "kognoz-house-prefs",
  "kognoz-style-memory",
  "kognoz-design",
  // Real, human-written posts the model imitates. See lib/voiceSamples.ts for
  // why this is not the same thing as kognoz-style-memory.
  "kognoz-voice-samples"
] as const;

export type StoreKey = (typeof STORE_KEYS)[number];
