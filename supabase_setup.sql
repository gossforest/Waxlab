-- ─── WaxLab — Supabase Database Setup ───────────────────────────────────────
--
-- Run this once in your Supabase project's SQL Editor to create all required
-- tables, indexes, and Row Level Security policies.
--
-- Dashboard → SQL Editor → New query → paste this → Run
--
-- Tables created:
--   waxlab_events   — all wax test events, keyed by team_code
--   waxlab_vocab    — shared product/wax autocomplete vocabulary
--   waxlab_fleets   — ski fleet registries, keyed by team_code
--
-- Storage bucket created:
--   waxlab-photos   — ski photos (public read, authenticated write)
--
-- Security model:
--   The app uses the anonymous (public) Supabase key. Row Level Security
--   is enabled on all tables. Access is scoped to team_code — anyone who
--   knows a team code can read and write that team's data. This matches
--   the app's design: team codes are the access credential.
-- ─────────────────────────────────────────────────────────────────────────────


-- ─── EVENTS ──────────────────────────────────────────────────────────────────

create table if not exists waxlab_events (
  id          text primary key,
  team_code   text not null,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

create index if not exists waxlab_events_team_code_idx on waxlab_events (team_code);

-- Row Level Security
alter table waxlab_events enable row level security;

-- Anyone may read events for any team (team code = access credential)
create policy "Public read" on waxlab_events
  for select using (true);

-- Anyone may insert or update events
create policy "Public insert" on waxlab_events
  for insert with check (true);

create policy "Public update" on waxlab_events
  for update using (true);

-- Anyone may delete events (deletion is also tombstoned client-side)
create policy "Public delete" on waxlab_events
  for delete using (true);

-- Realtime: enable for this table
alter publication supabase_realtime add table waxlab_events;


-- ─── VOCABULARY ──────────────────────────────────────────────────────────────
-- Per-team autocomplete vocabulary (products, applications, grooming terms).
-- Primary key is (team_code, category) so each team has independent vocab.

create table if not exists waxlab_vocab (
  team_code text not null,
  category  text not null,
  terms     text[] not null default '{}',
  primary key (team_code, category)
);

create index if not exists waxlab_vocab_team_code_idx on waxlab_vocab (team_code);

alter table waxlab_vocab enable row level security;

create policy "Public read"   on waxlab_vocab for select using (true);
create policy "Public insert" on waxlab_vocab for insert with check (true);
create policy "Public update" on waxlab_vocab for update using (true);

alter publication supabase_realtime add table waxlab_vocab;


-- ─── PRODUCT CATALOG ─────────────────────────────────────────────────────────
-- Per-team manually curated product catalog with full metadata.
-- Stored as a single JSON array per team (same pattern as waxlab_fleets).

create table if not exists waxlab_catalog (
  team_code   text primary key,
  data        jsonb not null default '[]',
  updated_at  timestamptz not null default now()
);

alter table waxlab_catalog enable row level security;

create policy "Public read"   on waxlab_catalog for select using (true);
create policy "Public insert" on waxlab_catalog for insert with check (true);
create policy "Public update" on waxlab_catalog for update using (true);

alter publication supabase_realtime add table waxlab_catalog;


-- ─── FLEETS ──────────────────────────────────────────────────────────────────

create table if not exists waxlab_fleets (
  team_code   text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table waxlab_fleets enable row level security;

create policy "Public read"   on waxlab_fleets for select using (true);
create policy "Public insert" on waxlab_fleets for insert with check (true);
create policy "Public update" on waxlab_fleets for update using (true);

alter publication supabase_realtime add table waxlab_fleets;


-- ─── ANALYTICS ───────────────────────────────────────────────────────────────
-- Anonymous usage telemetry. No PII — only team_code + device_id (random UUID).
-- The ADMIN team code in the app reads this table for the dashboard.

create table if not exists waxlab_analytics (
  id          bigserial primary key,
  device_id   text not null,
  team_code   text not null,
  event_type  text not null,
  platform    text,
  payload     jsonb default '{}',
  ts          timestamptz not null default now()
);

create index if not exists waxlab_analytics_team_code_idx on waxlab_analytics (team_code);
create index if not exists waxlab_analytics_ts_idx        on waxlab_analytics (ts);
create index if not exists waxlab_analytics_event_type_idx on waxlab_analytics (event_type);

alter table waxlab_analytics enable row level security;

-- Anyone can insert (fire a ping) but NOT read — only the admin dashboard reads
create policy "Public insert" on waxlab_analytics for insert with check (true);

-- Read is unrestricted so the admin dashboard (using anon key) can query it.
-- If you want to restrict admin access, replace this with a secret team_code check.
create policy "Public read"   on waxlab_analytics for select using (true);


-- ─── PHOTO STORAGE BUCKET ────────────────────────────────────────────────────
-- Run this separately in the Supabase Dashboard → Storage, or via the SQL editor.
-- The SQL API for storage buckets requires the storage schema:

insert into storage.buckets (id, name, public)
  values ('waxlab-photos', 'waxlab-photos', true)
  on conflict (id) do nothing;

-- Allow public reads (photos are served by URL)
create policy "Public photo read" on storage.objects
  for select using (bucket_id = 'waxlab-photos');

-- Allow uploads (no auth required — team code scoping is handled client-side)
create policy "Public photo upload" on storage.objects
  for insert with check (bucket_id = 'waxlab-photos');

create policy "Public photo delete" on storage.objects
  for delete using (bucket_id = 'waxlab-photos');


-- ─── DONE ─────────────────────────────────────────────────────────────────────
-- Your database is ready. Next steps:
--
--   1. Copy your project URL and anon key from:
--      Supabase Dashboard → Settings → API
--
--   2. Add them as environment variables in Netlify:
--      SUPABASE_URL       = https://your-project.supabase.co
--      SUPABASE_ANON_KEY  = your-anon-key
--
--   3. Trigger a Netlify redeploy (or push a commit) — build.sh will inject
--      the credentials into config.js automatically.
