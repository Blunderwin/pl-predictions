-- ============================================================
-- AUTHORITATIVE HISTORY
--
-- The group kept a spreadsheet from 2020 onward: one row per day per
-- season, with how many each player got right. It is correct. The
-- reconstruction from the chat exports is about 93% complete, so the
-- two are kept apart rather than merged:
--
--   pl_history      is right about SCORES. Standings, points, season
--                   totals — all of it reads from here.
--
--   pl_predictions  is right about PICKS, but only on the days flagged
--                   verified below. Everywhere else it has holes, and
--                   a hole in "how often did you call a draw" is a
--                   wrong answer rather than a missing one.
--
-- verified = the reconstruction recovered every fixture of that day
-- AND independently arrived at the sheet's own number of correct
-- calls. Anything else is a gap: the score still counts, the picks
-- are not to be reasoned from.
--
-- Run after schema.sql. Then load the rows with the output of
--   node scripts/build-history.mjs "PL Match Predictions.xlsx" chat-import-report.tsv
-- ============================================================

create table if not exists pl_history (
  player_id  uuid    not null references pl_players(id) on delete cascade,
  season     text    not null,
  played_on  date    not null,
  correct    int     not null,          -- from the spreadsheet: authoritative
  matches    int     not null,          -- fixtures that day
  recovered  int     not null default 0,-- picks rebuilt from the chat history
  verified   boolean not null default false,
  primary key (player_id, season, played_on)
);
create index if not exists pl_history_season on pl_history (season, played_on);

alter table pl_history enable row level security;
drop policy if exists "anon read history" on pl_history;
create policy "anon read history" on pl_history for select using (true);
-- No anon write policy: loaded from the SQL editor, same as the fixtures.


-- Which player-days may be used for pick-level statistics. The app
-- joins predictions to this before computing anything about HOW
-- someone predicts, as opposed to how well they scored.
create or replace view pl_verified_days
with (security_invoker = off) as
  select player_id, season, played_on
    from pl_history
   where verified;

grant select on pl_verified_days to anon, authenticated;


-- Coverage per season, for the note the app shows on the Stats tab.
create or replace view pl_coverage
with (security_invoker = off) as
  select
    season,
    player_id,
    sum(correct)                                    as points,
    sum(matches)                                    as matches,
    sum(recovered)                                  as recovered,
    count(*)                                        as days,
    count(*) filter (where verified)                as verified_days
  from pl_history
  group by season, player_id;

grant select on pl_coverage to anon, authenticated;
