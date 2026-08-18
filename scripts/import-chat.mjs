#!/usr/bin/env node
/**
 * Reconstruct historic predictions from the group's chat history.
 *
 * The idea: a message like "_AHHA" posted at 09:58 on a Saturday is
 * only meaningful against the fixtures still open at 09:58, in
 * kick-off order. That's the same mapping the live app does, so with
 * the fixture list to hand the chat history IS the prediction history.
 *
 * Takes both exports — Snapchat to 22 Dec 2024, WhatsApp from the
 * 25th — and treats them as one continuous record.
 *
 * Rules learned from the real files, each of which would otherwise
 * have corrupted a season:
 *
 *   Only whole messages count. "Toby sent me this / HHAHHAA" is one
 *   person relaying another's calls; picking strings out of mixed
 *   messages would attribute them to the wrong player. Costs about 1%
 *   of messages and removes the entire class of error.
 *
 *   Case separates calls from laughter. Across the WhatsApp export 509
 *   of 515 candidates were full caps, and five of the six that weren't
 *   were "Hahahaha".
 *
 *   Off-season messages are another competition. In June 2026 the
 *   group predicted the World Cup; mapping those onto the next
 *   Premier League fixtures would be worse than having no data.
 *
 *   A gameweek is ten matches, so a longer string is celebration.
 *
 * Nothing is written without --write. The report is the point, and the
 * per-matchday totals exist to be diffed against the spreadsheet.
 *
 * Usage:
 *   node scripts/import-chat.mjs snap.txt _chat.txt --seasons 2021,2022,2023,2024,2025 --map map.json
 *   ... --write            (needs SUPABASE_URL and SUPABASE_SERVICE_KEY, and the fixture backfill run first)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fetchSeason } from "./lib/pl-csv.mjs";
import { parseChat } from "./lib/chat-parse.mjs";

const args    = process.argv.slice(2);
const FILES   = args.filter(a => !a.startsWith("--") && !isValueOf(a));
const WRITE   = args.includes("--write");
const MAPF    = argVal("--map");
const OUT     = argVal("--out") || "chat-import-report.tsv";
const SEASONS = (argVal("--seasons") || "").split(",").filter(Boolean).map(Number);
const MAX_RUN = Number(argVal("--max") || 10);
const LOOSE   = !args.includes("--strict");  // take pick lines out of messages that also carry prose
// The group tolerated a late call — a message posted after the whistle
// still counted. Without a grace window every pick in that batch is
// thrown away, which is the single largest source of missing coverage.
const GRACE_H = Number(argVal("--grace") ?? 0);

function argVal(flag){ const i = args.indexOf(flag); return i > -1 ? args[i + 1] : null; }
function isValueOf(a){ const i = args.indexOf(a); return i > 0 && args[i - 1].startsWith("--") && args[i - 1] !== "--write"; }

if(!FILES.length || !SEASONS.length){
  console.error("Usage: node scripts/import-chat.mjs <export.txt> [more.txt] --seasons 2021,2022 [--map map.json] [--write]");
  process.exit(1);
}

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
if(WRITE && (!SB_URL || !SB_KEY)){ console.error("--write needs SUPABASE_URL and SUPABASE_SERVICE_KEY"); process.exit(1); }

async function sb(path, init){
  const res = await fetch(SB_URL + "/rest/v1/" + path, {
    ...init,
    headers: { apikey:SB_KEY, Authorization:`Bearer ${SB_KEY}`, "Content-Type":"application/json", ...(init?.headers||{}) }
  });
  if(!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
  return res;
}

/* ---------- What counts as a call ---------- */
const PICK_LINE = /^[HAD_\-.*]+$/;                 // deliberately case-sensitive
// A batch is often labelled with the day it covers: "Sat: HAHHDDH",
// "Sunday: DDDA", "15th - HHHAD". The label is not a pick.
const DAY_LABEL = /^\s*(?:(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)[a-z]*|\d{1,2}(?:st|nd|rd|th)?)\s*[:\-–]\s*/i;
// Naming someone else means the message is carrying their calls rather
// than the sender's — "Toby sent me this / HHAHHAA".
const NAMES_SOMEONE = /\b(darius|toby|tobes|tobias|ben)\b/i;

export function asPicks(text, loose = LOOSE){
  const lines = String(text).split("\n").map(l => l.trim()).filter(Boolean);
  const picks = [];
  let prose = 0;
  for(const line of lines){
    const s = line.replace(DAY_LABEL, "").replace(/\s/g, "");
    if(s && s.length <= 20 && PICK_LINE.test(s)){ picks.push(...s); continue; }
    prose++;
  }
  if(!picks.length || picks.length > 24) return null;
  // A message that is nothing but calls is safe on its own. One with
  // prose around them is only safe once we know it isn't relaying
  // somebody else's.
  if(prose && (!loose || NAMES_SOMEONE.test(text))) return null;
  return picks.map(c => "HAD".includes(c) ? c : null);
}
// Strictly alternating H and A: "HAHA" is laughter, "HAHHA" has a
// double and is a real call.
const isLaughter = t => { const s = t.replace(/\s/g, ""); return s.length >= 4 && (/^(HA)+$/.test(s) || /^(AH)+$/.test(s)); };
const isChanting = t => { const s = t.replace(/\s/g, ""); return s.length >= 6 && new Set(s).size === 1; };
const isSingle   = t => t.replace(/\s/g, "").length === 1;

const iso  = d => d.toISOString().slice(0, 16).replace("T", " ");
const flat = t => t.replace(/\s+/g, " ").slice(0, 60);

/**
 * A batch covers whole days, not "the next N fixtures".
 *
 * Someone posting seven letters on Friday evening means Saturday's
 * seven matches — even though Friday's 20:00 kick-off is still open
 * and would otherwise swallow the first letter and shift the rest.
 * Verified against the group's spreadsheet: this was the single
 * largest remaining source of disagreement.
 *
 * So: group the open fixtures by day and look for a run of whole days
 * whose fixture count is exactly the length of the string, preferring
 * the earliest such run. Only fall back to consuming fixtures in order
 * when no run matches, which is the case for a partial batch.
 */
const MAX_SKIP = 3;                          // don't leap further than a few days to find a fit
function alignToDays(n, open){
  const days = [];
  for(const f of open){
    const d = f.kickoff_utc.slice(0, 10);
    if(!days.length || days[days.length - 1].day !== d) days.push({ day:d, list:[] });
    days[days.length - 1].list.push(f);
  }
  for(let start = 0; start < Math.min(days.length, MAX_SKIP); start++){
    let sum = 0;
    for(let k = start; k < days.length; k++){
      sum += days[k].list.length;
      if(sum === n) return days.slice(start, k + 1).flatMap(d => d.list);
      if(sum > n) break;
    }
  }
  return open;
}

/* ---------- Go ---------- */
const messages = [];
for(const file of FILES){
  const { source, messages: msgs, authors, orphaned } = parseChat(readFileSync(file, "utf8"));
  if(!msgs.length){ console.error(`${file}: nothing parsed`); process.exit(1); }
  console.log(`${file}: ${source}, ${msgs.length} messages, ${iso(msgs[0].ts)} to ${iso(msgs[msgs.length-1].ts)}`
            + (authors ? ` (authors: ${authors.join(", ")})` : "")
            + (orphaned ? ` [${orphaned} before the first date separator, skipped]` : ""));
  messages.push(...msgs);
}
messages.sort((a, b) => a.ts - b.ts);

const fixtures = [], windows = [];
for(const y of SEASONS){
  const { label, rows } = await fetchSeason(y);
  fixtures.push(...rows);
  windows.push({
    label,
    from: new Date(new Date(rows[0].kickoff_utc).getTime() - 14*24*3600e3),  // calls land before a ball is kicked
    to:   new Date(rows[rows.length - 1].kickoff_utc)
  });
  console.log(`  ${label}: ${rows.length} fixtures`);
}
fixtures.sort((a, b) => new Date(a.kickoff_utc) - new Date(b.kickoff_utc) || a.home.localeCompare(b.home));
const seasonAt = d => (windows.find(w => d >= w.from && d <= w.to) || {}).label || null;

// A break in the fixture list means the league has stopped and the
// group is predicting something else — Qatar 2022 sat inside the
// 2022/23 season, and those calls would otherwise be mapped onto
// whatever Premier League match happened to be next.
const BREAK_DAYS = 25;   // international breaks run ~13 days; Qatar 2022 stopped the league for 43
const breaks = [];
for(let i = 1; i < fixtures.length; i++){
  const prev = new Date(fixtures[i-1].kickoff_utc), next = new Date(fixtures[i].kickoff_utc);
  if(fixtures[i].season !== fixtures[i-1].season) continue;
  if(next - prev > BREAK_DAYS * 24*3600e3) breaks.push({ from:prev, to:next });
}
if(breaks.length) console.log(`  mid-season breaks ignored: ${breaks.map(b=>`${b.from.toISOString().slice(0,10)}..${b.to.toISOString().slice(0,10)}`).join(", ")}`);
const inBreak = d => breaks.some(b => d > b.from && d < b.to);

const nameMap = MAPF ? JSON.parse(readFileSync(MAPF, "utf8")) : {};
const who = a => nameMap[a] || a;

const rows = [], report = [["status","when","season","author","message","fixture","kickoff","pick","result"].join("\t")];
const counts = { chat:0, offSeason:0, inBreak:0, tooLong:0, overrun:0, laughter:0, chanting:0, single:0, ok:0 };
const posters = new Set();
// Every message maps from the next open fixture, including ones the
// author has already called. Continuing from where they left off was
// tried and is measurably worse against the group's own spreadsheet:
// the group reposts corrected strings often, and under continuation a
// repost consumes the *following* fixtures instead of overwriting,
// inventing predictions. Restarting means a repost simply supersedes.

for(const msg of messages){
  const picks = asPicks(msg.text);
  if(!picks){ counts.chat++; continue; }

  const season = seasonAt(msg.ts);
  if(!season){
    counts.offSeason++;
    report.push(["OFF-SEASON", iso(msg.ts), "", who(msg.author), flat(msg.text), "", "", "", ""].join("\t"));
    continue;
  }
  if(inBreak(msg.ts)){
    counts.inBreak++;
    report.push(["MID-SEASON-BREAK", iso(msg.ts), season, who(msg.author), flat(msg.text), "", "", "", ""].join("\t"));
    continue;
  }
  if(picks.length > MAX_RUN){
    counts.tooLong++;
    report.push(["TOO-LONG", iso(msg.ts), season, who(msg.author), flat(msg.text), "", "", "", ""].join("\t"));
    continue;
  }

  const laugh = isLaughter(msg.text), chant = isChanting(msg.text), single = isSingle(msg.text);
  if(laugh) counts.laughter++;
  if(chant) counts.chanting++;
  if(single) counts.single++;
  posters.add(msg.author);

  const cutoff = new Date(msg.ts.getTime() - GRACE_H * 3600e3);
  const stillOpen = fixtures.filter(f => new Date(f.kickoff_utc) > cutoff && f.season === season);
  const openAt = alignToDays(picks.length, stillOpen);
  picks.forEach((pick, i) => {
    if(!pick) return;                                   // "_" skips a fixture
    const f = openAt[i];
    if(!f){
      counts.overrun++;
      report.push(["PAST-END", iso(msg.ts), season, who(msg.author), flat(msg.text), "", "", pick, ""].join("\t"));
      return;
    }
    counts.ok++;
    const status = laugh ? "CHECK-LAUGH" : chant ? "CHECK-CHANT" : single ? "CHECK-SINGLE" : "OK";
    rows.push({ author: who(msg.author), fixture: f, pick, ts: msg.ts });
    report.push([status, iso(msg.ts), season, who(msg.author), flat(msg.text),
                 `${f.home_short} v ${f.away_short}`, f.kickoff_utc, pick, f.result].join("\t"));
  });
}

// Later messages win: a repost is a correction.
const dedup = new Map();
for(const r of rows) dedup.set(`${r.author}|${r.fixture.id}`, r);
const final = [...dedup.values()];

writeFileSync(OUT, report.join("\n"));

console.log(`\nignored as chat: ${counts.chat}`);
console.log(`dropped, outside a season window: ${counts.offSeason}`);
console.log(`dropped, inside a mid-season break: ${counts.inBreak}`);
console.log(`dropped, longer than ${MAX_RUN} picks: ${counts.tooLong}`);
console.log(`picks running past the end of a season: ${counts.overrun}`);
console.log(`flagged — laughter ${counts.laughter}, chanting ${counts.chanting}, lone letter ${counts.single}`);
console.log(`\n${final.length} predictions reconstructed (${rows.length - final.length} superseded)`);

// H/A/D calls land near 40-55%. Well outside that and the strings are
// misaligned rather than the callers unlucky.
const tally = {};
for(const r of final){
  const k = `${r.fixture.season}|${r.author}`;
  const t = tally[k] || (tally[k] = { n:0, ok:0 });
  t.n++; if(r.pick === r.fixture.result) t.ok++;
}
console.log("\nstrike rate by season and player:");
let lastSeason = null;
Object.entries(tally).sort().forEach(([k, v]) => {
  const [s, name] = k.split("|");
  if(s !== lastSeason){ console.log(""); lastSeason = s; }
  console.log(`  ${s}  ${name.padEnd(16)} ${String(v.ok).padStart(3)}/${String(v.n).padEnd(3)}  ${Math.round(v.ok / v.n * 100)}%`);
});

const md = {};
for(const r of final){
  const k = `${r.fixture.season}\t${r.fixture.matchday}\t${r.author}`;
  const t = md[k] || (md[k] = { n:0, ok:0 });
  t.n++; if(r.pick === r.fixture.result) t.ok++;
}
const mdFile = OUT.replace(/\.tsv$/, "") + "-by-matchday.tsv";
writeFileSync(mdFile, ["season\tmatchday\tplayer\tcorrect\tplayed",
  ...Object.entries(md).sort((a,b)=>{
    const [as,am]=a[0].split("\t"), [bs,bm]=b[0].split("\t");
    return as.localeCompare(bs) || Number(am)-Number(bm) || a[0].localeCompare(b[0]);
  }).map(([k, v]) => `${k}\t${v.ok}\t${v.n}`)].join("\n"));

console.log(`\nreport:          ${OUT}`);
console.log(`matchday totals: ${mdFile}   <- diff against the spreadsheet`);

// SQL rather than a direct write, so the load goes through the Supabase
// editor — an already-authenticated surface — instead of needing the
// service key exported into a shell.
const sqlFile = OUT.replace(/\.tsv$/, "") + ".sql";
const esc = s => String(s).replace(/'/g, "''");
const chunks = [];
for(let i = 0; i < final.length; i += 500) chunks.push(final.slice(i, i + 500));
writeFileSync(sqlFile, [
  "-- Historic predictions reconstructed from the group's chat history.",
  "-- Run pl_fixtures backfill for every season below FIRST, or these",
  "-- match nothing: " + SEASONS.map(y => `${y}/${String((y+1)%100).padStart(2,"0")}`).join(", "),
  "-- Re-runnable. The delete matters: a re-import can map a pick onto a",
  "-- different fixture than last time, so an upsert alone would leave the",
  "-- old row behind. Only the seasons listed above are touched, so the",
  "-- live season's real picks are safe.",
  "",
  "delete from pl_predictions where fixture_id in (",
  "  select id from pl_fixtures where season in (" +
    SEASONS.map(y => `'${y}/${String((y+1)%100).padStart(2,"0")}'`).join(", ") + "));",
  "",
  ...chunks.map(chunk =>
    "insert into pl_predictions (player_id, fixture_id, pick, created_at, updated_at)\n" +
    "select p.id, v.fixture_id, v.pick, v.created_at, now()\n" +
    "from (values\n" +
    chunk.map((r, i) =>
      `  ('${esc(r.author)}'${i ? "" : "::text"}, ${r.fixture.id}${i ? "" : "::bigint"}, ` +
      `'${r.pick}'${i ? "" : "::char(1)"}, '${r.ts.toISOString()}'${i ? "" : "::timestamptz"})`
    ).join(",\n") +
    "\n) as v(player, fixture_id, pick, created_at)\n" +
    "join pl_players p on lower(p.name) = lower(v.player)\n" +
    "on conflict (player_id, fixture_id) do update\n" +
    "  set pick = excluded.pick, updated_at = now();"
  ),
  "",
  "-- Check: every player should come back near 40-55%.",
  "select f.season, p.name, count(*) as calls,",
  "       count(*) filter (where pr.pick = f.result) as correct,",
  "       round(100.0 * count(*) filter (where pr.pick = f.result) / count(*)) as pct",
  "  from pl_predictions pr",
  "  join pl_fixtures f on f.id = pr.fixture_id",
  "  join pl_players  p on p.id = pr.player_id",
  " group by f.season, p.name order by f.season, p.name;",
  ""
].join("\n"));
console.log(`sql to paste:    ${sqlFile}   (${chunks.length} statement${chunks.length===1?"":"s"}, ${final.length} rows)`);

if(!WRITE){ console.log(`\nNothing written to the database. Paste the SQL, or re-run with --write.`); process.exit(0); }

const players = await (await sb("pl_players?select=id,name")).json();
const byName = new Map(players.map(p => [p.name.toLowerCase(), p]));
const resolve = a => byName.get(who(a).toLowerCase());
const unresolved = [...posters].filter(a => !resolve(a));
if(unresolved.length){
  console.error(`\nCan't match these chat names to players: ${unresolved.join(", ")}`);
  console.error(`Add them to the map file, e.g. {"Tobias Unwin":"Toby","Me":"Toby"}`);
  process.exit(1);
}

const payload = final.map(r => ({
  player_id: byName.get(r.author.toLowerCase()).id,
  fixture_id: r.fixture.id, pick: r.pick,
  created_at: r.ts.toISOString(), updated_at: new Date().toISOString()
}));
for(let i = 0; i < payload.length; i += 200){
  await sb("pl_predictions?on_conflict=player_id,fixture_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(payload.slice(i, i + 200))
  });
}
console.log(`\n${payload.length} predictions written.`);
