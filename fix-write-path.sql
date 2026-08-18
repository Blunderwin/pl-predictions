-- ============================================================
-- FIX: write predictions through a function, not through the table
--
-- The original design had anon INSERT/UPDATE policies on
-- pl_predictions and no SELECT policy, so that nobody could read a
-- pick before kick-off. That reading rule is right, but it makes the
-- write fragile: an upsert on a table you have no SELECT policy for
-- runs into several separate PostgreSQL restrictions depending on how
-- PostgREST phrases the statement, and the failure surfaces as a bare
-- permission error with no useful detail.
--
-- So: no anon write policies at all. One security-definer function is
-- the only way in. It checks the deadline itself and reports per-row
-- what it accepted, which also means the app can say exactly which
-- fixture was refused and why.
--
-- Run this in the Supabase SQL editor after schema.sql. Safe to re-run.
-- ============================================================

-- ---------- 1. Diagnose first (optional, tells us what broke) ----------
-- Reproduces the app's write exactly as the anon role and rolls it
-- back. Whatever error this raises is the one the app was hitting.
--
--   begin;
--     set local role anon;
--     insert into pl_predictions (player_id, fixture_id, pick)
--     select p.id, f.id, 'H'
--       from pl_players p,
--            lateral (select id from pl_fixtures
--                      where kickoff_utc > now()
--                      order by kickoff_utc limit 1) f
--      where p.name = 'Toby'
--     on conflict (player_id, fixture_id) do update set pick = excluded.pick;
--   rollback;


-- ---------- 2. Close the direct write path ----------
drop policy if exists "anon predict before kickoff" on pl_predictions;
drop policy if exists "anon amend before kickoff"   on pl_predictions;
revoke insert, update, delete on pl_predictions from anon, authenticated;

-- pl_predictions now has RLS on and no policies whatsoever, which is
-- the strongest possible statement: no anon read, no anon write, ever.
-- Reads go through pl_picks_public, writes through pl_predict_batch.


-- ---------- 3. The one way in ----------
-- p_picks is [{"fixture_id": 12345, "pick": "H"}, ...]
create or replace function pl_predict_batch(p_player uuid, p_picks jsonb)
returns table (fixture_id bigint, accepted boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  fid  bigint;
  pk   text;
begin
  if not exists (select 1 from pl_players where id = p_player) then
    raise exception 'unknown player %', p_player using errcode = 'P0002';
  end if;

  for item in select * from jsonb_array_elements(p_picks) loop
    fid := (item->>'fixture_id')::bigint;
    pk  := upper(item->>'pick');

    if pk not in ('H','A','D') then
      fixture_id := fid; accepted := false; reason := 'not H, A or D';
      return next; continue;
    end if;

    if not exists (select 1 from pl_fixtures where id = fid) then
      fixture_id := fid; accepted := false; reason := 'no such fixture';
      return next; continue;
    end if;

    if not pl_still_open(fid) then
      fixture_id := fid; accepted := false; reason := 'kicked off';
      return next; continue;
    end if;

    insert into pl_predictions (player_id, fixture_id, pick)
    values (p_player, fid, pk::char(1))
    on conflict (player_id, fixture_id)
      do update set pick = excluded.pick, updated_at = now();

    fixture_id := fid; accepted := true; reason := null;
    return next;
  end loop;
end;
$$;

revoke all on function pl_predict_batch(uuid, jsonb) from public;
grant execute on function pl_predict_batch(uuid, jsonb) to anon, authenticated;


-- ---------- 4. Check it ----------
-- Should return accepted = true for the next fixture.
--
--   select * from pl_predict_batch(
--     (select id from pl_players where name = 'Toby'),
--     (select jsonb_agg(jsonb_build_object('fixture_id', id, 'pick', 'H'))
--        from (select id from pl_fixtures where kickoff_utc > now()
--               order by kickoff_utc limit 1) x));
