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

Open the Pages URL on your phone and *Add to Home Screen*. It runs standalone, dark, no
browser chrome.

---

## How it works

**Order.** Fixtures sort by kick-off time, then alphabetically by home team within a shared
slot — the order FotMob displays and the order the group has always written its strings in.

**Bulk entry.** The box at the top of Predict maps one character per fixture onto the open
fixtures in that order. `_` skips one. So `_AHHA` straight out of the WhatsApp group does
what it always did. A live preview highlights each button before you commit; it won't apply
a string containing typos or one longer than the fixture list. `Copy my string` gives you
the same thing back for posting to the group.

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

```bash
node scripts/backfill-fixtures.mjs 2022 2023 2024 2025
```

Add `--dry-run` to see what it would write without touching the database. Ids are derived
from season + date + teams, so re-running updates rather than duplicates. Kick-off times are
converted from UK local to UTC with British Summer Time handled. Matchday isn't in the CSV
so it's inferred from each club's game count — approximate, and only used to group the
Results view.

### Your predictions

From the spreadsheet: stage the rows, check what didn't match, then write. See
`backfill-predictions.sql` — it includes a team-name normaliser, a query that lists every
row that would be silently dropped, and a strike-rate sanity check. A season of H/A/D calls
should land somewhere near 40-55%; well outside that means the rows are misaligned.

From the WhatsApp history instead, if the spreadsheet has gaps:

```bash
node scripts/import-whatsapp.mjs chat.txt
```

Export the chat without media first. It maps each message's string onto the fixtures that
were open at that timestamp — the same operation the app does live — and writes a TSV report
rather than touching the database. `--write` once the report reads correctly. It flags
laughter ("hahaha" is a legal five-match call) and lone letters for a manual look.

---

## Notes

- **Max 10 players**, enforced in the schema.
- **No auth.** You pick your name and it sticks to the device, same trust model as the whist
  app. Fine for a group who know each other; not fine for strangers.
- **Scheduled workflows get auto-disabled after 60 days of repo inactivity.** If fixtures go
  stale in the summer, that's why — a manual dispatch re-arms it.
- **Season rollover.** The sync picks the current season automatically (July onward = the new
  one). To backfill or force a different one, dispatch the workflow with a season year.
