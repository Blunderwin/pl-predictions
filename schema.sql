-- ============================================================
-- PREMIER LEAGUE PREDICTIONS — Supabase schema
-- Run once in the SQL editor. Safe to re-run.
--
-- Two rules are enforced here rather than in the app, because the
-- app is a static page anyone can open the console on:
--   1. No prediction may be written once the fixture has kicked off.
--   2. No prediction may be READ until the fixture has kicked off.
-- Everything else is ordinary open-anon tables, same trust model as
-- the whist scorekeeper.
-- ============================================================

-- ---------- Fixtures (written only by the sync action) ----------
create table if not exists pl_fixtures (
  id               bigint primary key,          -- football-data.org match id
  season           text        not null,        -- e.g. '2026/27'
  matchday         int         not null default 0,
  kickoff_utc      timestamptz not null,
  kickoff_original timestamptz not null,        -- first time we ever saw; never overwritten
  home             text        not null,
  away             text        not null,
  home_short       text,
  away_short       text,
  status           text        not null,        -- SCHEDULED|TIMED|IN_PLAY|PAUSED|FINISHED|POSTPONED|...
  home_goals       int,
  away_goals       int,
  result           char(1) generated always as (
                     case
                       when home_goals is null or away_goals is null then null
                       when home_goals > away_goals then 'H'
                       when home_goals < away_goals then 'A'
                       else 'D'
                     end) stored,
  updated_at       timestamptz not null default now()
);
create index if not exists pl_fixtures_ko  on pl_fixtures (kickoff_utc, home);
create index if not exists pl_fixtures_md  on pl_fixtures (season, matchday);

alter table pl_fixtures enable row level security;
drop policy if exists "anon read fixtures" on pl_fixtures;
create policy "anon read fixtures" on pl_fixtures for select using (true);
-- No anon insert/update policy: only the service-role key (held by the
-- GitHub Action) can write fixtures, and service-role bypasses RLS.


-- ---------- Players ----------
create table if not exists pl_players (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  norm_name  text generated always as (lower(trim(name))) stored,
  created_at timestamptz not null default now(),
  unique (norm_name)
);
alter table pl_players enable row level security;
drop policy if exists "anon read players"  on pl_players;
drop policy if exists "anon add players"   on pl_players;
create policy "anon read players" on pl_players for select using (true);
create policy "anon add players"  on pl_players for insert
  with check ((select count(*) from pl_players) < 10);


-- ---------- Predictions ----------
create table if not exists pl_predictions (
  player_id  uuid   not null references pl_players(id) on delete cascade,
  fixture_id bigint not null references pl_fixtures(id) on delete cascade,
  pick       char(1) not null check (pick in ('H','A','D')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (player_id, fixture_id)
);
alter table pl_predictions enable row level security;

create or replace function pl_still_open(fid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from pl_fixtures f
    where f.id = fid
      and now() < f.kickoff_utc
      and f.status not in ('POSTPONED','CANCELLED','SUSPENDED')
  );
$$;

-- Deliberately NO select policy on the base table. Anon reads go
-- through pl_picks_public below, which withholds the pick itself
-- until kick-off. Without this, anyone could read the group's calls
-- straight off the REST endpoint before the deadline.
drop policy if exists "anon predict before kickoff" on pl_predictions;
drop policy if exists "anon amend before kickoff"   on pl_predictions;
create policy "anon predict before kickoff" on pl_predictions for insert
  with check (pl_still_open(fixture_id));
create policy "anon amend before kickoff" on pl_predictions for update
  using (pl_still_open(fixture_id))
  with check (pl_still_open(fixture_id));

create or replace function pl_touch() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists pl_predictions_touch on pl_predictions;
create trigger pl_predictions_touch before update on pl_predictions
  for each row execute function pl_touch();


-- ---------- The public read surface ----------
-- Presence is always visible (so the app can show who's called it),
-- the pick itself only once the whistle's gone.
create or replace view pl_picks_public
with (security_invoker = off) as
  select
    p.player_id,
    p.fixture_id,
    case when now() >= f.kickoff_utc then p.pick else null end as pick,
    (now() >= f.kickoff_utc) as revealed
  from pl_predictions p
  join pl_fixtures f on f.id = p.fixture_id;

grant select on pl_picks_public to anon, authenticated;
