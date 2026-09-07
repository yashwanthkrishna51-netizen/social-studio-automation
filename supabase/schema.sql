-- Kognoz Social Studio — Supabase schema

-- Users — simple username/password auth (no OAuth/email-provider dependency;
-- M365-hosted mail wasn't compatible with Google OAuth, and magic link needs an
-- email service; admin-managed credentials instead). This table IS the allowlist:
-- no row, no login. Passwords are bcrypt hashes, never plaintext — see
-- scripts/add-user.mjs, the only supported way to create one.
-- ⚠  OUT OF DATE — this does NOT match the live database.
--
--    The production `users` table has ELEVEN columns, not four. Verified against the
--    live table on 1 Sep 2026:
--
--      id               uuid, default-generated, primary key
--      username         text  NOT NULL, no default   <- an insert MUST supply this
--      password_hash    text  NOT NULL               <- bcrypt, cost 12
--      name             text  NOT NULL
--      email            text  NOT NULL               <- what lib/auth.ts looks up by
--      role             text  default 'member'       <- values seen: 'member', 'admin'
--      token_version    int   default 0
--      failed_attempts  int   default 0
--      lockout_level    int   default 0
--      locked_until     timestamptz, nullable
--      created_at       timestamptz default now()
--
--    The exact DDL — constraints, indexes, the role check — was never committed, so it
--    is not reproduced here rather than guessed at. Anyone standing up a fresh project
--    must dump the real schema from the live database first; running the block below
--    would create a table the app can still read but that no longer matches production.
--
--    Note also that `role`, `token_version`, `failed_attempts`, `lockout_level` and
--    `locked_until` are written by nobody and read by nobody. Someone built the shape of
--    roles, session revocation and login lockout; none of it is implemented in the app.
--    There is no lockout despite the columns.
--
--    To add a user, use supabase/add-user.sql or `npm run add-user` — both supply
--    `username` and are kept in step with the live table.

create table if not exists users (
  email text primary key,
  name text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

alter table users enable row level security;
-- No public policies — only the server route (service-role key) reads this table.

-- Replaces artifact window.storage with shared server storage (PRD §3.2).
-- Same key semantics as v3: GET/PUT /api/store?key=... , JSON values, last-write-wins.
create table if not exists store (
  -- Keep in sync with STORE_KEYS in lib/supabase.ts. An existing database is
  -- widened by supabase/migrations/2026-09-04_voice_samples.sql, not by this file.
  key text primary key check (
    key in ('kognoz-calendar', 'kognoz-house-prefs', 'kognoz-style-memory', 'kognoz-design', 'kognoz-voice-samples')
  ),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text, -- user email, for "who edited last" (P2 nicety, §15) — populate now, surface later
  -- Optimistic-locking token, bumped on every successful write. A client sends the
  -- version it read; a mismatch means someone else wrote first and the request is
  -- rejected with 409 rather than silently overwriting their work.
  version int not null default 1
);

-- Row Level Security on; no public policies. All access goes through the
-- server route using the service-role key, which bypasses RLS by design.
-- This just makes sure no client-side anon-key access is ever possible.
alter table store enable row level security;

-- Seed empty rows so GET never 404s on first run (client can PUT to fill them).
insert into store (key, value) values
  ('kognoz-calendar', '{}'::jsonb),
  ('kognoz-house-prefs', '{}'::jsonb),
  ('kognoz-style-memory', '{}'::jsonb),
  ('kognoz-design', '{}'::jsonb)
on conflict (key) do nothing;

-- Optional (P1/P2): API call log for admin spend visibility (§3.1, §14).
create table if not exists api_call_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_email text not null,
  task text not null,
  model text not null,
  input_tokens int,
  output_tokens int
);

-- Cost telemetry (added with the spend-reduction pass). Every column is
-- nullable / additive so this is safe to run against an existing table.
-- `use_search` is what the hourly web-search bucket counts; `ok` distinguishes
-- billed successes from failed attempts, which are logged too so that retries
-- and errors still count against the rate limit.
alter table api_call_log add column if not exists use_search boolean not null default false;
alter table api_call_log add column if not exists ok boolean not null default true;
alter table api_call_log add column if not exists max_tokens int;
alter table api_call_log add column if not exists stop_reason text;
alter table api_call_log add column if not exists error_type text;
alter table api_call_log add column if not exists cache_creation_input_tokens int;
alter table api_call_log add column if not exists cache_read_input_tokens int;
alter table api_call_log add column if not exists web_search_requests int;
alter table api_call_log add column if not exists cost_usd numeric(10, 6);

-- The rate limiter counts rows per user over a rolling window on every call,
-- and the search bucket filters on use_search.
create index if not exists api_call_log_user_time_idx on api_call_log (user_email, created_at desc);
create index if not exists api_call_log_search_idx on api_call_log (user_email, created_at desc) where use_search;

alter table api_call_log enable row level security;


-- ---------------------------------------------------------------------------
-- Activity trail (added 2026-09-01). Full, commented DDL — including the
-- v_all_activity view and the retention policy — lives in
-- supabase/migrations/2026-09-01_activity_log.sql. Reproduced here so a fresh
-- project gets the table; run the migration for the view.
--
-- NOTE this project is SHARED with another app ("Team Pulse"), which owns
-- audit_log, login_ip_throttle and tasks, and co-owns users. Nothing here
-- reads or writes any of them: the activity screen is Social Studio only.
-- v_all_activity unions this table with api_call_log and nothing else.
-- ---------------------------------------------------------------------------
create table if not exists studio_activity (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  actor_email  text not null,   -- email, not a uuid: SSO users have no `users` row
  actor_name   text,
  action       text not null,   -- allowlisted in lib/activityEvents.ts, not by CHECK
  entity       text,
  entity_id    text,
  entity_label text,
  screen       text,
  ip           text,
  user_agent   text,
  session_id   text,            -- groups one sign-in's events into a visit
  meta         jsonb
);

create index if not exists studio_activity_actor_time_idx on studio_activity (actor_email, created_at desc);
create index if not exists studio_activity_time_idx       on studio_activity (created_at desc);

alter table studio_activity enable row level security;
