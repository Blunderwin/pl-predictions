-- ============================================================
-- WHY DOES IT THINK THE MATCH HAS STARTED?
-- Paste into the Supabase SQL editor. Read-only, safe to re-run.
-- ============================================================

-- 1. What the database believes about the next few fixtures.
--    still_open_by_time and policy_says_open should agree. If the
--    first is true and the second is false, the status filter in
--    pl_still_open() is what's blocking the write, not the clock.
select
  f.home_short || ' v ' || f.away_short   as fixture,
  f.season,
  f.matchday,
  f.status,
  f.kickoff_utc,
  f.kickoff_utc at time zone 'Europe/London' as kickoff_uk,
  now()                                    as db_now,
  f.kickoff_utc > now()                    as still_open_by_time,
  f.kickoff_utc - now()                    as time_until,
  pl_still_open(f.id)                      as policy_says_open
from pl_fixtures f
where f.kickoff_utc > now() - interval '7 days'
order by f.kickoff_utc
limit 15;


-- 2. What's actually on file, per season. If the only rows are
--    historic, the sync workflow hasn't landed and everything really
--    has kicked off — the fix is step 4, not a bug.
select
  season,
  count(*)                                          as fixtures,
  count(*) filter (where kickoff_utc > now())       as upcoming,
  count(*) filter (where result is not null)        as settled,
  min(kickoff_utc)                                  as first_kickoff,
  max(kickoff_utc)                                  as last_kickoff
from pl_fixtures
group by season
order by season;


-- 3. Every distinct status value present. pl_still_open() blocks
--    POSTPONED, CANCELLED and SUSPENDED; anything unexpected here
--    (or a trailing space) is worth knowing about.
select status, count(*), min(kickoff_utc) as earliest
from pl_fixtures
group by status
order by count(*) desc;


-- 4. Prove the write path directly, without going near the app.
--    Swap in a real player name. Returns true if the policy would
--    accept a prediction for the next fixture right now.
select
  p.name,
  f.home_short || ' v ' || f.away_short as next_fixture,
  f.kickoff_utc,
  pl_still_open(f.id)                   as would_accept
from pl_players p
cross join lateral (
  select * from pl_fixtures
  where kickoff_utc > now()
  order by kickoff_utc
  limit 1
) f;
