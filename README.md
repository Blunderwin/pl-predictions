# Premier League Predictions

H, A or D before kick-off. One point per correct call.

A single-file static app (GitHub Pages) over a Supabase database, with fixtures and results
pushed in by a GitHub Action. Sibling to the contract whist scorekeeper — same storage
model, same no-build-step approach.

---

## What's here

| File | What it is |
|---|---|
| `index.html` | The entire app. No build step, no framework, no dependencies. |
| `schema.sql` | Run once in the Supabase SQL editor. Safe to re-run. |
| `scripts/sync-fixtures.mjs` | Pulls fixtures + results from football-data.org into Supabase. |
| `.github/workflows/sync-fixtures.yml` | Runs the sync every 3 hours. |

---

## Setup

### 1. Database

Open the Supabase SQL editor for your existing project and run `schema.sql`. That project's
URL and anon key are already baked into `index.html`, so nothing to change there.

### 2. Fixture feed

Get a free API token at <https://www.football-data.org/client/register>. The free tier
covers the Premier League at 10 requests/minute, which is roughly 100x more than this needs.
Final scores land with a short delay on the free tier — irrelevant for a game settled after
the whistle.

### 3. Repo layout

`.github/` has to sit at the **repository root**. So either push this `predictions/` folder
*as* the repo, or move `.github/` and `scripts/` up a level and change the workflow's
`run:` path to match.

### 4. Secrets

In the repo, under Settings → Secrets and variables → Actions, add three:

| Secret | Where it comes from |
|---|---|
| `FOOTBALL_DATA_TOKEN` | football-data.org, from step 2 |
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API → `service_role` key |

The service key bypasses row-level security, which is exactly why it lives in a repo secret
and never in the page.

### 5. First run

Actions → *Sync PL fixtures* → Run workflow. It should report ~380 matches written. Then
open the page, add the players, and go.

### 6. Home screen

**iOS** — open the Pages URL in *Safari* (this only works in Safari), tap Share, scroll down,
*Add to Home Screen*.
**Android** — open it in Chrome, three-dot menu, *Install app* or *Add to Home screen*.

It launches standalone with no browser chrome, because `manifest.json` sets
`display: standalone`. Two things in there are easy to get wrong and worth leaving alone:

- Every path in the manifest is **relative** (`"./"`, `"./icon-192.png"`). Manifest URLs
  resolve against the manifest's own location, so this works under
  `username.github.io/pl-predictions/` without the repo name appearing anywhere. Absolute
  paths like `/` would 404 on a project page.
- **iOS ignores the manifest's icons** and reads `<link rel="apple-touch-icon">`, which is
  why `apple-touch-icon.png` exists separately. Without it you get a screenshot of the page
  as your icon.

To change the icon, edit the colours in `scripts/make-icons.mjs` and run it. It writes the
PNGs directly — no image library needed.

There's no service worker, so it needs a connection to start. The last-seen fixtures, picks
and history are mirrored to localStorage, so a cold launch on a bad signal shows the previous
state rather than an empty page, but predictions still need the network to save.

---

## How it works

**Order.** Fixtures sort by kick-off time, then alphabetically by home team within a shared
slot — the order FotMob displays and the order the group has always written its strings in.

**Bulk entry.** The box at the top of Predict maps one character per fixture onto the open
fixtures in that order. `_` skips one. So `_AHHA` straight out of the WhatsApp group does
what it always did. A live preview highlights each button before you commit; it won't apply
a string containing typos or one longer than the fixture list. `Copy my string` gives you
the same thing back for posting to the group.

**One week at a time.** Predict pages by matchweek with prev/next rather than scrolling the
rest of the season. The bulk box maps onto the week you're looking at, so a string is read
against the fixtures in front of you.

**Who's called it, not what.** Each row carries the other players' initials — filled once
they've locked a prediction in, outlined until then. Which way they leaned stays hidden until
kick-off; the database won't serve it before then regardless.

**The nudge.** Inside 12 hours of a kick-off, anyone still missing a call for it gets named to
everyone. Chasing people was the one job the group chat was genuinely doing.

**Nobody can peek.** `pl_predictions` has no select policy at all — the REST API simply will
not serve it. Reads go through the `pl_picks_public` view, which withholds the pick until
`now() >= kickoff_utc` and exposes only *presence* before that (the little dots on each
row, showing who's called it). Your own pending picks are mirrored in localStorage, which is
why you can see them and nobody else can.

**Nobody can back-date.** Writes are checked against kick-off in Postgres, not in the app.
A fixture that starts while the page is open is rejected by the database.

**Moved kick-offs.** Both the current and the first-seen time are stored. A moved fixture
shows an amber ⚠ with the original time on hover. The lock follows the *new* time — worth
knowing when a Sunday 16:30 gets pulled to 14:00 for TV and your window quietly shrinks.

**Late joiners.** "Deadlines missed" only counts fixtures after a player's first ever pick,
so joining in February doesn't saddle you with the autumn.


---

## Backfilling previous seasons

Two halves, and they're independent.

### Fixtures and results

football-data.org's free tier only serves the current season. Past seasons come from
[football-data.co.uk](https://www.football-data.co.uk) instead — a different site, free CSVs
per season back to 1993, with date, kick-off time and full-time result. No key needed.

Run it from the repo: **Actions -> Backfill past seasons -> Run workflow**, seasons space
separated. It defaults to a dry run, so the first click reports what it *would* write and
touches nothing; untick that and run again to commit it. Keeping it in Actions means the
service key never has to leave the repo secrets.

There is a local path too if you prefer — `node scripts/backfill-fixtures.mjs 2022 2023 2024
2025 --dry-run` — but it needs `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in your shell. Ids are derived
from season + date + teams, so re-running updates rather than duplicates. Kick-off times are
converted from UK local to UTC with British Summer Time handled. Matchday isn't in the CSV
so it's inferred from each club's game count — approximate, and only used to group the
Results view.

### Your predictions

From the spreadsheet: stage the rows, check what didn't match, then write. See
`backfill-predictions.sql` — it includes a team-name normaliser, a query that lists every
row that would be silently dropped, and a strike-rate sanity check. A season of H/A/D calls
should land somewhere near 40-55%; well outside that means the rows are misaligned.

From the chat history, which is where the actual picks live:

```bash
node scripts/import-chat.mjs "Predictions prexmas 2024.txt" _chat.txt --seasons 2021,2022,2023,2024,2025 --map map.json
```

Two sources, treated as one continuous record — Snapchat from August 2021 to 22 December
2024, WhatsApp from the 25th. Format is detected per file. `map.json` translates chat names
to player names, including Snapchat's `"Me"`.

It writes three files and touches nothing:

| File | What it's for |
|---|---|
| `chat-import-report.tsv` | Every pick, the fixture it mapped to, and whether it was right |
| `chat-import-report-by-matchday.tsv` | Per player per matchday totals — **diff this against the spreadsheet** |
| `chat-import-report.sql` | Paste into the Supabase SQL editor to load it |

The SQL exists so the load goes through an already-authenticated surface rather than needing
the service key in a shell. It matches players by name and is re-runnable.

### Checking it

The group's own spreadsheet records, per day per season, how many each player got right. That
makes it a checksum for the import — a misaligned string produces perfectly plausible picks
and nothing complains.

```bash
node scripts/verify-against-sheet.mjs "PL Match Predictions.xlsx" chat-import-report.tsv
```

The number to read is the last one: of the player-days where the import recovered *every*
fixture of that day, how many match the sheet exactly. Below about 95% means the mapping is
wrong rather than merely incomplete. It caught two real faults — the 2022 World Cup being
mapped onto Premier League fixtures, and an attempt to have each message continue from where
the player left off, which turned out measurably worse because the group reposts corrected
strings.

Read the strike rates it prints before loading anything. H/A/D calls land near 40–55%; a
player well outside that has misaligned strings, not bad luck.

Five rules the real exports forced, each of which would otherwise have corrupted a season:

- **A batch covers whole days, not the next N fixtures.** Seven letters posted on Friday
  evening means Saturday's seven matches — but Friday's 20:00 kick-off is still open and
  would swallow the first letter, shifting everything after it. The importer groups the open
  fixtures by day and looks for a run of whole days whose fixture count matches the string
  length exactly, preferring the earliest. This was worth 215 extra fully-recovered
  player-days on its own.

- **Only whole messages count.** "Toby sent me this / HHAHHAA" is one person relaying
  another's calls. Picking strings out of mixed messages attributes them to the wrong
  player. Costs about 1% of messages and removes the entire class of error.
- **Case separates calls from laughter.** Of 515 candidates in the WhatsApp export, 509 were
  full caps and five of the six that weren't were "Hahahaha".
- **Off-season messages are another competition.** In June 2026 the group predicted the World
  Cup. Mapping those onto the next Premier League fixtures would be worse than no data.
- **A gameweek is ten matches**, so anything longer is celebration.

---

## Signing in

Each player has a four-digit code. The codes are checked in the database, never in the page:
anon has no SELECT on `pl_players` at all and reads the roster through `pl_players_public`,
which exposes id and name only. The code travels with every write, because knowing a
player's id isn't enough on its own — ids are visible in the picks view.

Run `add-logins.sql` after `schema.sql` and `fix-write-path.sql`. Change the four digits in
the bootstrap line before you run it; that's the only code typed by hand.

Only an admin can create players. From your account panel: type a name, hit Create, and the
generated code appears once on screen — send it on. *Show everyone's codes* reads them back
if someone loses theirs. Non-admins never see either control, and the functions behind them
re-check the admin flag server-side, so hiding the buttons isn't what's doing the work.

**This is not real authentication.** The anon key is public, the login function is callable
by anyone, and there are only 10,000 codes. A 0.4s pause on every failed attempt turns a
brute force into roughly a 90-minute job rather than a two-second one. That's the right
amount of effort for a game between friends; it is not a security boundary. Anything more
means Supabase Auth.

---

## Two tiers of truth

The group kept a spreadsheet from 2020 onward, and it is correct. The picks rebuilt from the
chat exports are about 93% complete. The two are used for different things and never mixed:

- **`pl_history` is the authority on scores.** Points, standings, season totals, the
  points-through-the-season chart. Loaded from `history.sql` plus the output of
  `build-history.mjs`.
- **`pl_predictions` is the authority on picks**, but only on days flagged `verified` —
  where the reconstruction recovered every fixture of that day *and* independently arrived at
  the spreadsheet's own number of correct calls. 1,152 of 1,737 player-days qualify.

Everywhere else is a gap: the score still counts, the picks are not reasoned from. A hole in
"how often do you call a draw" is a wrong answer rather than a missing one, so the Stats tab
uses verified days only and says so on the page.

For the live season there is no spreadsheet, the app recorded every pick itself, and both
tiers are the same thing.

## Notes

- **PostgREST caps every response at 1000 rows.** Six seasons is 2,280 fixtures and ~5,000
  picks, so `SB.get` pages through with `Range` headers. Every paged read needs a
  deterministic `order=` including a tiebreak, or rows repeat or vanish across page
  boundaries.

- **Max 10 players**, enforced in the schema.
- **No auth.** You pick your name and it sticks to the device, same trust model as the whist
  app. Fine for a group who know each other; not fine for strangers.
- **Scheduled workflows get auto-disabled after 60 days of repo inactivity.** If fixtures go
  stale in the summer, that's why — a manual dispatch re-arms it.
- **Season rollover.** The sync picks the current season automatically (July onward = the new
  one). To backfill or force a different one, dispatch the workflow with a season year.
