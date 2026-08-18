-- ============================================================
-- BACKFILLING OLD PREDICTIONS FROM THE SPREADSHEET
--
-- Run `schema.sql` and the fixture backfill first — this matches
-- against fixtures that must already exist:
--     node scripts/backfill-fixtures.mjs 2022 2023 2024 2025
--
-- Three steps, and the middle one is the point: stage the raw rows,
-- look at what didn't match, and only then write. Going straight to
-- an INSERT silently drops every row whose team name doesn't line up,
-- and you won't notice until a strike rate looks wrong in March.
--
-- Run in the Supabase SQL editor, which connects as postgres and so
-- isn't subject to the after-kick-off write block on pl_predictions.
-- ============================================================


-- ---------- 0. Team-name normaliser ----------
-- The spreadsheet, football-data.co.uk and football-data.org all
-- spell clubs differently. Squash to a comparable key and alias the
-- handful that genuinely differ.
create or replace function pl_teamkey(t text) returns text
language sql immutable as $$
  select case lower(regexp_replace(coalesce(t,''), '[^a-zA-Z]', '', 'g'))
    when 'manutd'            then 'manunited'
    when 'manchesterunited'  then 'manunited'
    when 'manchestercity'    then 'mancity'
    when 'tottenham'         then 'spurs'
    when 'tottenhamhotspur'  then 'spurs'
    when 'nottinghamforest'  then 'nottmforest'
    when 'wolverhampton'     then 'wolves'
    when 'wolverhamptonwanderers' then 'wolves'
    when 'westbromwichalbion' then 'westbrom'
    when 'sheffieldutd'      then 'sheffieldunited'
    when 'brightonhovealbion' then 'brighton'
    when 'newcastleunited'   then 'newcastle'
    when 'leedsunited'       then 'leeds'
    when 'leicestercity'     then 'leicester'
    when 'afcbournemouth'    then 'bournemouth'
    when 'lutontown'         then 'luton'
    when 'ipswichtown'       then 'ipswich'
    else lower(regexp_replace(coalesce(t,''), '[^a-zA-Z]', '', 'g'))
  end;
$$;


-- ---------- 1. Stage the spreadsheet ----------
drop table if exists pl_stage;
create table pl_stage (
  season     text,          -- '2024/25'
  home       text,          -- however the spreadsheet spells it
  away       text,
  played_on  date,          -- optional; leave null if you haven't got it
  player     text,          -- must match pl_players.name
  pick       char(1)        -- H / A / D
);

-- Paste the rows here. One per player per match: a wide spreadsheet
-- (a column per player) unpivots into this shape easily enough — or
-- hand me the sheet and I'll generate the INSERT.
insert into pl_stage (season, home, away, played_on, player, pick) values
  ('2024/25', 'Man United',  'Fulham',   '2024-08-16', 'Ben',    'H'),
  ('2024/25', 'Man United',  'Fulham',   '2024-08-16', 'Darius', 'D'),
  ('2024/25', 'Man United',  'Fulham',   '2024-08-16', 'You',    'H');
  -- ...


-- ---------- 2. Look before you write ----------
-- Anything listed here will be dropped. Fix the names, re-stage, and
-- re-run until it comes back empty.
select s.*,
       case
         when p.id is null then 'no such player'
         when f.id is null then 'no fixture matched'
         when f2.n > 1     then 'matched ' || f2.n || ' fixtures — ambiguous'
       end as problem
from pl_stage s
left join pl_players p
       on lower(p.name) = lower(s.player)
left join lateral (
  select count(*) as n from pl_fixtures f
   where f.season = s.season
     and pl_teamkey(f.home) = pl_teamkey(s.home)
     and pl_teamkey(f.away) = pl_teamkey(s.away)
) f2 on true
left join pl_fixtures f
       on f.season = s.season
      and pl_teamkey(f.home) = pl_teamkey(s.home)
      and pl_teamkey(f.away) = pl_teamkey(s.away)
where p.id is null or f.id is null or f2.n > 1;

-- Sanity check: a season of H/A/D calls should land somewhere around
-- 40-55%. Wildly outside that means the rows are misaligned, not that
-- everyone had a bad year.
select s.player,
       count(*)                                        as calls,
       count(*) filter (where s.pick = f.result)       as correct,
       round(100.0 * count(*) filter (where s.pick = f.result) / nullif(count(*),0)) as pct
from pl_stage s
join pl_players  p on lower(p.name) = lower(s.player)
join pl_fixtures f on f.season = s.season
                  and pl_teamkey(f.home) = pl_teamkey(s.home)
                  and pl_teamkey(f.away) = pl_teamkey(s.away)
group by s.player
order by pct desc;


-- ---------- 3. Write ----------
insert into pl_predictions (player_id, fixture_id, pick, created_at, updated_at)
select p.id, f.id, upper(s.pick)::char(1),
       coalesce(f.kickoff_utc - interval '2 hours', now()),   -- plausible stamp, pre kick-off
       now()
from pl_stage s
join pl_players  p on lower(p.name) = lower(s.player)
join pl_fixtures f on f.season = s.season
                  and pl_teamkey(f.home) = pl_teamkey(s.home)
                  and pl_teamkey(f.away) = pl_teamkey(s.away)
where upper(s.pick) in ('H','A','D')
on conflict (player_id, fixture_id) do update set pick = excluded.pick, updated_at = now();

-- drop table pl_stage;
