-- ============================================================
-- PINS
--
-- A four-digit code per player, so one device is one predictor and
-- nobody can tap someone else's name and see or change their calls.
--
-- The codes are checked in the database, never in the page. anon
-- loses SELECT on pl_players entirely and reads the roster through a
-- view that exposes id and name only — so the PINs cannot be pulled
-- off the REST endpoint, which is what would happen if the app
-- compared them client-side.
--
-- What this is not: real authentication. The anon key is public, the
-- login function is callable by anyone, and there are only 10,000
-- codes. The failed-login delay below turns a brute force into a
-- ~90-minute job rather than a two-second one, which is the right
-- amount of effort for a game between friends. If you ever want it
-- properly locked down that's Supabase Auth, not this.
--
-- Run after schema.sql and fix-write-path.sql. Safe to re-run.
-- ============================================================

alter table pl_players add column if not exists pin      text;
alter table pl_players add column if not exists is_admin boolean not null default false;


-- ---------- Bootstrap: make yourself the admin ----------
-- Choose your own four digits and change them here before running.
-- This is the only place a code is typed by hand; everyone else's is
-- generated below.
update pl_players set pin = '1234', is_admin = true where name = 'Toby';


-- ---------- Roster: names only ----------
drop policy if exists "anon read players" on pl_players;
drop policy if exists "anon add players"  on pl_players;
revoke select, insert, update, delete on pl_players from anon, authenticated;

create or replace view pl_players_public
with (security_invoker = off) as
  select id, name from pl_players order by name;

grant select on pl_players_public to anon, authenticated;


-- ---------- Log in ----------
-- Returns the player on a match, nothing on a miss. The pause on
-- failure is the only thing making the four digits worth anything.
create or replace function pl_login(p_name text, p_pin text)
returns table (id uuid, name text, is_admin boolean)
language plpgsql security definer set search_path = public as $fn$
begin
  return query
    select p.id, p.name, p.is_admin
      from pl_players p
     where lower(trim(p.name)) = lower(trim(p_name))
       and p.pin = trim(p_pin);
  if not found then
    perform pg_sleep(0.4);
  end if;
end;
$fn$;

revoke all on function pl_login(text, text) from public;
grant execute on function pl_login(text, text) to anon, authenticated;


-- ---------- Predict, now carrying the code ----------
-- Knowing a player's id is not enough: ids are visible in the picks
-- view, so without this check anyone could write as anyone.
drop function if exists pl_predict_batch(uuid, jsonb);
drop function if exists pl_predict_batch(uuid, text, jsonb);

create function pl_predict_batch(p_player uuid, p_pin text, p_picks jsonb)
returns table (fid bigint, ok boolean, why text)
language plpgsql security definer set search_path = public as $fn$
declare
  v_item jsonb;
  v_fid  bigint;
  v_pick text;
begin
  if not exists (select 1 from pl_players p where p.id = p_player and p.pin = trim(p_pin)) then
    perform pg_sleep(0.4);
    raise exception 'wrong code' using errcode = 'P0003';
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

revoke all on function pl_predict_batch(uuid, text, jsonb) from public;
grant execute on function pl_predict_batch(uuid, text, jsonb) to anon, authenticated;


-- ---------- Admin: add a player, get their code ----------
-- Generates the code rather than taking one, so nobody ends up with
-- 0000. Returned once; pl_roster can read it back later.
create or replace function pl_create_player(p_admin uuid, p_admin_pin text, p_name text)
returns table (id uuid, name text, pin text)
language plpgsql security definer set search_path = public as $fn$
declare
  v_pin  text;
  v_name text := trim(p_name);
begin
  if not exists (select 1 from pl_players p
                  where p.id = p_admin and p.pin = trim(p_admin_pin) and p.is_admin) then
    perform pg_sleep(0.4);
    raise exception 'not an admin' using errcode = 'P0003';
  end if;
  if v_name = '' then
    raise exception 'name required' using errcode = 'P0004';
  end if;
  if (select count(*) from pl_players) >= 10 then
    raise exception 'roster is full at 10' using errcode = 'P0004';
  end if;
  if exists (select 1 from pl_players p where lower(trim(p.name)) = lower(v_name)) then
    raise exception 'that name is taken' using errcode = 'P0004';
  end if;

  v_pin := lpad((floor(random() * 10000))::int::text, 4, '0');

  return query
    insert into pl_players (name, pin, is_admin)
    values (v_name, v_pin, false)
    returning pl_players.id, pl_players.name, pl_players.pin;
end;
$fn$;

revoke all on function pl_create_player(uuid, text, text) from public;
grant execute on function pl_create_player(uuid, text, text) to anon, authenticated;


-- ---------- Admin: read the codes back ----------
-- For when someone forgets theirs.
create or replace function pl_roster(p_admin uuid, p_admin_pin text)
returns table (name text, pin text)
language plpgsql security definer set search_path = public as $fn$
begin
  if not exists (select 1 from pl_players p
                  where p.id = p_admin and p.pin = trim(p_admin_pin) and p.is_admin) then
    perform pg_sleep(0.4);
    raise exception 'not an admin' using errcode = 'P0003';
  end if;
  return query select p.name, p.pin from pl_players p order by p.name;
end;
$fn$;

revoke all on function pl_roster(uuid, text) from public;
grant execute on function pl_roster(uuid, text) to anon, authenticated;
