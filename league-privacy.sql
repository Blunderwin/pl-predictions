-- ============================================================
-- YOU ONLY SEE THE LEAGUES YOU'RE IN
--
-- pl_leagues and pl_league_members were readable by anon, so anyone
-- could list every league and every membership straight off the REST
-- endpoint. Hiding them in the app wouldn't have changed that.
--
-- Same approach as the picks: no anon read at all, and a function that
-- returns your own rows to someone holding your code. An admin gets
-- the full list, because managing membership needs it.
--
-- Run after leagues.sql. Safe to re-run.
-- ============================================================

drop policy if exists "anon read leagues" on pl_leagues;
drop policy if exists "anon read members" on pl_league_members;
revoke select on pl_leagues        from anon, authenticated;
revoke select on pl_league_members from anon, authenticated;
-- Both tables now carry RLS with no policies: nothing reaches anon
-- except through the functions below.


-- ---------- Your leagues, and who else is in them ----------
-- One row per (league, member). A league you're not in never appears,
-- so its membership never leaks either.
create or replace function pl_my_leagues(p_player uuid, p_pin text)
returns table (league_id uuid, name text, starts_on date, sort int, player_id uuid)
language plpgsql security definer set search_path = public as $fn$
begin
  if not exists (select 1 from pl_players p where p.id = p_player and p.pin = trim(p_pin)) then
    perform pg_sleep(0.4);
    raise exception 'wrong code' using errcode = 'P0003';
  end if;

  -- Every column reference is qualified. The OUT parameters are called
  -- league_id and player_id, so an unqualified mention of either inside
  -- the body is ambiguous and raises 42702 at runtime — which the app
  -- caught and turned into "you're in no leagues".
  return query
    select l.id, l.name, l.starts_on, l.sort, m.player_id
      from pl_leagues l
      join pl_league_members m on m.league_id = l.id
     where l.id in (select mine.league_id
                      from pl_league_members mine
                     where mine.player_id = p_player)
     order by l.sort, l.name;
end;
$fn$;

revoke all on function pl_my_leagues(uuid, text) from public;
grant execute on function pl_my_leagues(uuid, text) to anon, authenticated;


-- ---------- Every league, for the admin panel ----------
-- Includes leagues with no members yet, which is why it left joins.
create or replace function pl_all_leagues(p_admin uuid, p_admin_pin text)
returns table (league_id uuid, name text, starts_on date, sort int, player_id uuid)
language plpgsql security definer set search_path = public as $fn$
begin
  if not exists (select 1 from pl_players p
                  where p.id = p_admin and p.pin = trim(p_admin_pin) and p.is_admin) then
    perform pg_sleep(0.4);
    raise exception 'not an admin' using errcode = 'P0003';
  end if;

  return query
    select l.id, l.name, l.starts_on, l.sort, m.player_id
      from pl_leagues l
      left join pl_league_members m on m.league_id = l.id
     order by l.sort, l.name;
end;
$fn$;

revoke all on function pl_all_leagues(uuid, text) from public;
grant execute on function pl_all_leagues(uuid, text) to anon, authenticated;


-- ---------- Check ----------
-- What each player will actually see. Run this after the functions
-- above; if someone's list looks short, the membership is wrong rather
-- than the app.
select p.name as player,
       count(distinct m.league_id) as leagues,
       string_agg(distinct l.name, ', ' order by l.name) as sees
  from pl_players p
  left join pl_league_members m on m.player_id = p.id
  left join pl_leagues l        on l.id = m.league_id
 group by p.name
 order by p.name;

-- And the function itself, for one player, end to end:
--   select distinct name, starts_on from pl_my_leagues(
--     (select id from pl_players where name = 'Ben'),
--     (select pin from pl_players where name = 'Ben'));
