/**
 * Premier League seasons from football-data.co.uk.
 *
 * Shared by backfill-fixtures.mjs (which writes them to Supabase) and
 * import-whatsapp.mjs (which needs the same fixtures, with the same
 * ids, to map chat strings onto). Deriving the ids in one place is what
 * lets the import be checked offline and still line up with the rows
 * the backfill wrote.
 */
import { createHash } from "node:crypto";

const SHORT = {
  "Manchester United":"Man United", "Manchester City":"Man City", "Man United":"Man United",
  "Tottenham":"Spurs", "Sheffield United":"Sheffield Utd",
  "West Bromwich Albion":"West Brom", "Wolverhampton":"Wolves", "Wolves":"Wolves",
  "Nottingham Forest":"Nott'm Forest", "AFC Bournemouth":"Bournemouth"
};
export const short = n => SHORT[n] || n;

export const seasonLabel = y => `${y}/${String((y + 1) % 100).padStart(2, "0")}`;

// A 52-bit id from a stable natural key, offset clear of
// football-data.org's id space so the two sources can coexist.
export function fixtureId(season, date, home, away){
  const hex = createHash("sha1").update(`${season}|${date}|${home}|${away}`).digest("hex").slice(0, 12);
  return 900000000000 + (parseInt(hex, 16) % 90000000000);
}

// BST runs from the last Sunday in March 01:00 UTC to the last Sunday
// in October 01:00 UTC. A 15:00 kick-off in August is 14:00Z, in
// December it's 15:00Z.
export function bstOffsetMs(utcMs){
  const y = new Date(utcMs).getUTCFullYear();
  const lastSun = (month) => {
    const d = new Date(Date.UTC(y, month + 1, 0));
    return Date.UTC(y, month, d.getUTCDate() - d.getUTCDay(), 1);
  };
  return (utcMs >= lastSun(2) && utcMs < lastSun(9)) ? 3600e3 : 0;
}

export function ukToUtc(dmy, hm){
  const [d, m, yRaw] = dmy.split("/").map(s => s.trim());
  const y = yRaw.length === 2 ? Number(yRaw) + 2000 : Number(yRaw);
  const [hh, mm] = (hm && /^\d{1,2}:\d{2}$/.test(hm) ? hm : "15:00").split(":").map(Number);
  const naive = Date.UTC(y, m - 1, Number(d), hh, mm);
  return new Date(naive - bstOffsetMs(naive)).toISOString();
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
function parseCsv(text){
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const head = splitLine(lines[0]);
  return lines.slice(1).map(l => {
    const cells = splitLine(l);
    return Object.fromEntries(head.map((k, i) => [k, cells[i] ?? ""]));
  });
}

// Matchday isn't in the CSV. Approximate it by counting each club's
// games — good enough to group the Results view, and never used for
// anything that has to be exact.
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

export async function fetchSeason(startYear){
  const code  = String(startYear % 100).padStart(2, "0") + String((startYear + 1) % 100).padStart(2, "0");
  const label = seasonLabel(startYear);
  const url   = `https://www.football-data.co.uk/mmz4281/${code}/E0.csv`;

  const res = await fetch(url);
  if(!res.ok) throw new Error(`${url} -> ${res.status}`);
  const raw = parseCsv(await res.text());

  const rows = raw
    .filter(r => r.HomeTeam && r.AwayTeam && r.FTHG !== "" && r.FTAG !== "")
    .map(r => {
      const kickoff = ukToUtc(r.Date, r.Time);
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
        result: Number(r.FTHG) > Number(r.FTAG) ? "H" : Number(r.FTHG) < Number(r.FTAG) ? "A" : "D",
        updated_at: new Date().toISOString()
      };
    });

  assignMatchdays(rows);
  return { label, rows, missingTimes: raw.filter(r => !r.Time).length };
}
