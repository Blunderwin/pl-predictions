-- ============================================================
-- SEEING YOUR OWN CALLS BEFORE KICK-OFF
--
-- pl_picks_public withholds every pick until the whistle, which is
-- what stops anyone peeking. The side effect is that your own calls
-- vanish on any device that didn't make them — the app could only say
-- "called on another device", which is useless.
--
-- Your four-digit code fixes it: this returns one player's own picks,
-- and only to someone who can produce that player's code. Nobody
-- learns anything about anyone else.
--
-- Run after add-logins.sql. Safe to re-run.
-- ============================================================

create or replace function pl_my_picks(p_player uuid, p_pin text)
returns table (fixture_id bigint, pick char(1))
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not exists (select 1 from pl_players p where p.id = p_player and p.pin = trim(p_pin)) then
    perform pg_sleep(0.4);
    raise exception 'wrong code' using errcode = 'P0003';
  end if;

  return query
    select pr.fixture_id, pr.pick
      from pl_predictions pr
     where pr.player_id = p_player;
end;
$fn$;

revoke all on function pl_my_picks(uuid, text) from public;
grant execute on function pl_my_picks(uuid, text) to anon, authenticated;
