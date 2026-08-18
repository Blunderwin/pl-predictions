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
const LETTERS = /^[HAD_\-.*\s]+$/;                 // deliberately case-sensitive
export function asPicks(text){
  const t = text.replace(/\s/g, "");
  if(t.length < 1 || t.length > 24) return null;
  if(!LETTERS.test(t)) return null;
  const picks = [...t].map(c => "HAD".includes(c) ? c : null);
  return picks.some(Boolean) ? picks : null;
}
// Strictly alternating H and A: "HAHA" is laughter, "HAHHA" has a
// double and is a real call.
const isLaughter = t => { const s = t.replace(/\s/g, ""); return s.length >= 4 && (/^(HA)+$/.test(s) || /^(AH)+$/.test(s)); };
const isChanting = t => { const s = t.replace(/\s/g, ""); return s.length >= 6 && new Set(s).size === 1; };
const isSingle   = t => t.replace(/\s/g, "").length === 1;

const iso  = d => d.toISOString().slice(0, 16).replace("T", " ");
const flat = t => t.replace(/\s+/g, " ").slice(0, 60);

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

const nameMap = MAPF ? JSON.parse(readFileSync(MAPF, "utf8")) : {};
const who = a => nameMap[a] || a;

const rows = [], report = [["status","when","season","author","message","fixture","kickoff","pick","result"].join("\t")];
const counts = { chat:0, offSeason:0, tooLong:0, overrun:0, laughter:0, chanting:0, single:0, ok:0 };
const posters = new Set();

for(const msg of messages){
  const picks = asPicks(msg.text);
  if(!picks){ counts.chat++; continue; }

  const season = seasonAt(msg.ts);
  if(!season){
    counts.offSeason++;
    report.push(["OFF-SEASON", iso(msg.ts), "", who(msg.author), flat(msg.text), "", "", "", ""].join("\t"));
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

  const openAt = fixtures.filter(f => new Date(f.kickoff_utc) > msg.ts && f.season === season);
  picks.forEach((pick, i) => {
    if(!pick) return;
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
  "-- Re-runnable: conflicts update the pick rather than erroring.",
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
