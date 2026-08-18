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

-- pl_predictions carries RLS with NO policies at all, which is the
-- strongest statement available: anon can neither read it nor write it
-- directly. Reads go through pl_picks_public, which withholds the pick
-- until kick-off; writes go through pl_predict_batch, which enforces
-- the deadline and reports per fixture what it accepted. Granting anon
-- a direct upsert instead makes the write depend on how PostgREST
-- happens to phrase the statement against a table with no SELECT
-- policy, which fails in ways that are hard to read.
revoke insert, update, delete on pl_predictions from anon, authenticated;

-- Output names must not collide with any column the body touches:
-- inside PL/pgSQL an OUT parameter called fixture_id is indistinguishable
-- from pl_predictions.fixture_id in the ON CONFLICT target (42702).
-- Return type changes, so this drops rather than replaces.
drop function if exists pl_predict_batch(uuid, jsonb);

create function pl_predict_batch(p_player uuid, p_picks jsonb)
returns table (fid bigint, ok boolean, why text)
language plpgsql security definer set search_path = public as $fn$
declare
  v_item jsonb;
  v_fid  bigint;
  v_pick text;
begin
  if not exists (select 1 from pl_players where id = p_player) then
    raise exception 'unknown player %', p_player using errcode = 'P0002';
  end if;

  for v_item in select * from jsonb_array_elements(p_picks) loop
    v_fid  := (v_item->>'fixture_id')::bigint;
    v_pick := upper(v_item->>'pick');

    if v_pick is null or v_pick not in ('H','A','D') then
      fid := v_fid; ok := false; why := 'not H, A or D'; return next; continue;
    end if;

    if not exists (select 1 from pl_fixtures where id = v_fid) then
      fid := v_fid; ok := false; why := 'no such fixture'; return next; continue;
    end if;

    if not pl_still_open(v_fid) then
      fid := v_fid; ok := false; why := 'kicked off'; return next; continue;
    end if;

    insert into pl_predictions (player_id, fixture_id, pick)
    values (p_player, v_fid, v_pick::char(1))
    on conflict (player_id, fixture_id)
      do update set pick = excluded.pick, updated_at = now();

    fid := v_fid; ok := true; why := null; return next;
  end loop;
end;
$fn$;

revoke all on function pl_predict_batch(uuid, jsonb) from public;
grant execute on function pl_predict_batch(uuid, jsonb) to anon, authenticated;

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
