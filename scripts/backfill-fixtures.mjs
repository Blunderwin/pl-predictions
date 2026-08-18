#!/usr/bin/env node
/**
 * Backfill past Premier League seasons from football-data.co.uk.
 *
 * Note the .co.uk — a different outfit to football-data.org, and the
 * reason this is possible at all: the .org free tier only serves the
 * current season, while .co.uk publishes a free CSV per season back to
 * 1993 with date, kick-off time and full-time result. No key, no quota.
 *
 * Fixture ids have to be invented, since the CSV has none. They're
 * derived deterministically from season + date + teams, so re-running
 * updates rows rather than duplicating them, and they sit in a range
 * that can't collide with football-data.org's ids (which are small
 * positive integers).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY
 * Usage: node scripts/backfill-fixtures.mjs 2022 2023 2024 2025
 *        (season start years; 2022 means 2022/23)
 */
import { createHash } from "node:crypto";

const SB_URL = need("SUPABASE_URL").replace(/\/$/, "");
const SB_KEY = need("SUPABASE_SERVICE_KEY");
const DRY    = process.argv.includes("--dry-run");
const YEARS  = process.argv.slice(2).filter(a => /^\d{4}$/.test(a)).map(Number);

if(!YEARS.length){
  console.error("Give me one or more season start years, e.g. 2022 2023 2024 2025");
  process.exit(1);
}

function need(k){
  const v = process.env[k];
  if(!v && !process.argv.includes("--dry-run")){ console.error(`Missing env ${k}`); process.exit(1); }
  return v || "";
}

// football-data.co.uk's own long names, mapped to the short names the
// app displays. Anything not listed falls through unchanged.
const SHORT = {
  "Manchester United":"Man United", "Manchester City":"Man City", "Man United":"Man United",
  "Tottenham":"Spurs", "Nott'm Forest":"Nott'm Forest", "Sheffield United":"Sheffield Utd",
  "West Bromwich Albion":"West Brom", "Wolverhampton":"Wolves", "Wolves":"Wolves",
  "Newcastle":"Newcastle", "Leicester":"Leicester", "Brighton":"Brighton",
  "Crystal Palace":"Crystal Palace", "Bournemouth":"Bournemouth", "Leeds":"Leeds",
  "West Ham":"West Ham", "Aston Villa":"Aston Villa", "Nottingham Forest":"Nott'm Forest"
};
const short = n => SHORT[n] || n;

// A 52-bit id from a stable natural key. Offset well clear of
// football-data.org's id space so the two sources can coexist.
function fixtureId(season, date, home, away){
  const hex = createHash("sha1").update(`${season}|${date}|${home}|${away}`).digest("hex").slice(0, 12);
  return 900000000000 + (parseInt(hex, 16) % 90000000000);
}

// CSV rows are "DD/MM/YYYY" (or "DD/MM/YY" in older files) plus "HH:MM"
// UK local. Convert to a real UTC instant, honouring British Summer
// Time — a 15:00 in August is 14:00Z, in December it's 15:00Z.
function toUtc(dmy, hm){
  const [d, m, yRaw] = dmy.split("/").map(s => s.trim());
  const y = yRaw.length === 2 ? Number(yRaw) + 2000 : Number(yRaw);
  const [hh, mm] = (hm && /^\d{1,2}:\d{2}$/.test(hm) ? hm : "15:00").split(":").map(Number);
  const naive = Date.UTC(y, m - 1, Number(d), hh, mm);
  return new Date(naive - bstOffsetMs(naive)).toISOString();
}
// BST runs from the last Sunday in March 01:00 UTC to the last Sunday
// in October 01:00 UTC.
function bstOffsetMs(utcMs){
  const y = new Date(utcMs).getUTCFullYear();
  const lastSun = (month) => {
    const d = new Date(Date.UTC(y, month + 1, 0));       // last day of month
    return Date.UTC(y, month, d.getUTCDate() - d.getUTCDay(), 1);
  };
  return (utcMs >= lastSun(2) && utcMs < lastSun(9)) ? 3600e3 : 0;
}

// Minimal CSV reader: these files are plain, but a few club names have
// carried stray quotes over the years.
function parseCsv(text){
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const head = splitLine(lines[0]);
  return lines.slice(1).map(l => {
    const cells = splitLine(l);
    return Object.fromEntries(head.map((k, i) => [k, cells[i] ?? ""]));
  });
}
function splitLine(line){
  const out = []; let cur = "", q = false;
  for(const ch of line){
    if(ch === '"'){ q = !q; continue; }
    if(ch === "," && !q){ out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

async function sb(path, init){
  const res = await fetch(SB_URL + "/rest/v1/" + path, {
    ...init,
    headers: { apikey:SB_KEY, Authorization:`Bearer ${SB_KEY}`, "Content-Type":"application/json", ...(init?.headers||{}) }
  });
  if(!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
  return res;
}

// Matchday isn't in the CSV. Derive it by ordering each club's games:
// a fixture belongs to matchday N if it's the Nth game of the season
// for its home side. Reruns and rearranged games make this approximate,
// which is fine — it only groups the Results view.
function assignMatchdays(rows){
  const played = new Map();
  rows.sort((a, b) => new Date(a.kickoff_utc) - new Date(b.kickoff_utc));
  for(const r of rows){
    const h = (played.get(r.home) || 0) + 1;
    const a = (played.get(r.away) || 0) + 1;
    played.set(r.home, h); played.set(r.away, a);
    r.matchday = Math.max(h, a);
  }
  return rows;
}

async function season(startYear){
  const code = String(startYear % 100).padStart(2, "0") + String((startYear + 1) % 100).padStart(2, "0");
  const label = `${startYear}/${String((startYear + 1) % 100).padStart(2, "0")}`;
  const url = `https://www.football-data.co.uk/mmz4281/${code}/E0.csv`;

  const res = await fetch(url);
  if(!res.ok) throw new Error(`${url} -> ${res.status}`);
  const raw = parseCsv(await res.text());

  const rows = raw
    .filter(r => r.HomeTeam && r.AwayTeam && r.FTHG !== "" && r.FTAG !== "")
    .map(r => {
      const kickoff = toUtc(r.Date, r.Time);
      return {
        id: fixtureId(label, r.Date, r.HomeTeam, r.AwayTeam),
        season: label,
        matchday: 0,
        kickoff_utc: kickoff,
        kickoff_original: kickoff,
        home: r.HomeTeam,
        away: r.AwayTeam,
        home_short: short(r.HomeTeam),
        away_short: short(r.AwayTeam),
        status: "FINISHED",
        home_goals: Number(r.FTHG),
        away_goals: Number(r.FTAG),
        updated_at: new Date().toISOString()
      };
    });

  assignMatchdays(rows);
  const noTime = raw.filter(r => !r.Time).length;
  console.log(`${label}: ${rows.length} matches${noTime ? `, ${noTime} without a kick-off time (defaulted to 15:00)` : ""}`);

  if(DRY){
    console.log("  sample:", JSON.stringify(rows[0], null, 2));
    return;
  }
  for(let i = 0; i < rows.length; i += 100){
    await sb("pl_fixtures?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(i, i + 100))
    });
  }
  console.log(`  written`);
}

for(const y of YEARS){
  try { await season(y); }
  catch(e){ console.error(`  ${y} failed: ${e.message}`); }
}
