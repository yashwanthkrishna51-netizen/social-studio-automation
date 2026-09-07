-- Allow the `kognoz-voice-samples` store key (2026-09-04).
-- Safe to run more than once. No data is touched; this only widens a CHECK.
--
-- Why: generated copy reads as machine-written, and the largest single cause was
-- that the app learned its voice from itself. Exporting a PNG filed that deck
-- under `kognoz-style-memory`, and the next generation was told to "match their
-- voice" against it — so every run imitated the previous run's AI voice.
--
-- The fix is a corpus of writing a person actually wrote: real published posts,
-- pasted in and shown to the model instead. That corpus needs somewhere to live,
-- and `store.key` is constrained to a fixed list, so a new key needs this.
--
-- Kept as a fifth blob rather than a new table on purpose: the shape is a small
-- array edited as a whole, the existing route already handles auth, versioning
-- and conflict, and a table would need policies, a route and a migration path
-- for no benefit at this size.

alter table store drop constraint if exists store_key_check;

alter table store add constraint store_key_check check (
  key in (
    'kognoz-calendar',
    'kognoz-house-prefs',
    'kognoz-style-memory',
    'kognoz-design',
    'kognoz-voice-samples'
  )
);
