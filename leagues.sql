-- ============================================================
-- LEAGUES
--
-- A prediction belongs to a player, not to a league. You call each
-- fixture once and that call counts in every league you're in —
-- otherwise the same person would have to enter the same string three
-- times, which is the thing this app exists to stop.
--
-- So a league is just a membership list plus an optional start date.
-- It scopes who you're ranked against, not what you predicted.
--
-- starts_on is what separates "Predictions 26'" — a competition that
-- began this season — from "OG Predictions", which counts everything
-- back to 2021. Null means all of it.
--
-- Run after add-logins.sql. Safe to re-run.
-- ============================================================

create table if not exists pl_leagues (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  norm_name  text generated always as (lower(trim(name))) stored,
  starts_on  date,                       -- null = count everything
  sort       int  not null default 0,
  created_at timestamptz not null default now(),
  unique (norm_name)
);

create table if not exists pl_league_members (
  league_id uuid not null references pl_leagues(id)  on delete cascade,
  player_id uuid not null references pl_players(id)  on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (league_id, player_id)
);

alter table pl_leagues        enable row level security;
alter table pl_league_members enable row level security;

drop policy if exists "anon read leagues" on pl_leagues;
drop policy if exists "anon read members" on pl_league_members;
create policy "anon read leagues" on pl_leagues        for select using (true);
create policy "anon read members" on pl_league_members for select using (true);
-- No anon write policies: everything goes through the admin functions.
revoke insert, update, delete on pl_leagues        from anon, authenticated;
revoke insert, update, delete on pl_league_members from anon, authenticated;


-- ---------- The four to start with ----------
-- Only OG Predictions reaches back. Everything else starts with the
-- current season, so a league founded now isn't credited with results
-- from before it existed.
create or replace function pl_season_start() returns date
language sql stable as $$
  select min(kickoff_utc)::date from pl_fixtures
   where season = (select max(season) from pl_fixtures);
$$;

insert into pl_leagues (name, starts_on, sort) values
  ('OG Predictions',    null,                 1),
  ('AMM Senior League', pl_season_start(),    2),
  ('Predictions 26''',  pl_season_start(),    3),
  ('Unwin Family',      pl_season_start(),    4)
on conflict (norm_name) do update set starts_on = excluded.starts_on, sort = excluded.sort;

-- Everyone currently on the books joins the two that are obviously
-- theirs. The other two are yours to fill in from the app.
insert into pl_league_members (league_id, player_id)
select l.id, p.id
  from pl_leagues l cross join pl_players p
 where l.norm_name in ('og predictions', 'predictions 26''')
on conflict do nothing;


-- ---------- Admin: manage leagues ----------
create or replace function pl_league_set_member(
  p_admin uuid, p_admin_pin text, p_league uuid, p_player uuid, p_member boolean)
returns void
language plpgsql security definer set search_path = public as $fn$
begin
  if not exists (select 1 from pl_players p
                  where p.id = p_admin and p.pin = trim(p_admin_pin) and p.is_admin) then
    perform pg_sleep(0.4);
    raise exception 'not an admin' using errcode = 'P0003';
  end if;

  if p_member then
    insert into pl_league_members (league_id, player_id)
    values (p_league, p_player)
    on conflict do nothing;
  else
    delete from pl_league_members
     where league_id = p_league and player_id = p_player;
  end if;
end;
$fn$;

create or replace function pl_league_create(
  p_admin uuid, p_admin_pin text, p_name text, p_starts_on date default null)
returns table (id uuid, name text)
language plpgsql security definer set search_path = public as $fn$
declare v_name text := trim(p_name);
begin
  if not exists (select 1 from pl_players p
                  where p.id = p_admin and p.pin = trim(p_admin_pin) and p.is_admin) then
    perform pg_sleep(0.4);
    raise exception 'not an admin' using errcode = 'P0003';
  end if;
  if v_name = '' then raise exception 'name required' using errcode = 'P0004'; end if;
  -- A new league starts with the current season unless told otherwise.
  p_starts_on := coalesce(p_starts_on, pl_season_start());
  if exists (select 1 from pl_leagues l where l.norm_name = lower(v_name)) then
    raise exception 'that league already exists' using errcode = 'P0004';
  end if;

  return query
    insert into pl_leagues (name, starts_on, sort)
    values (v_name, p_starts_on, (select coalesce(max(sort), 0) + 1 from pl_leagues))
    returning pl_leagues.id, pl_leagues.name;
end;
$fn$;

revoke all on function pl_league_set_member(uuid, text, uuid, uuid, boolean) from public;
revoke all on function pl_league_create(uuid, text, text, date)              from public;
grant execute on function pl_league_set_member(uuid, text, uuid, uuid, boolean) to anon, authenticated;
grant execute on function pl_league_create(uuid, text, text, date)              to anon, authenticated;


-- ---------- Check ----------
select l.name, l.starts_on, count(m.player_id) as members,
       string_agg(p.name, ', ' order by p.name) as who
  from pl_leagues l
  left join pl_league_members m on m.league_id = l.id
  left join pl_players p        on p.id = m.player_id
 group by l.id, l.name, l.starts_on, l.sort
 order by l.sort;
