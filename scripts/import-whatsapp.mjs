#!/usr/bin/env node
/**
 * Reconstruct historic predictions from a WhatsApp chat export.
 *
 * The idea: a message like "_AHHA" posted at 09:58 on a Saturday is
 * only meaningful against the fixtures still open at 09:58, in
 * kick-off order. That's the same mapping the live app does, so with
 * the fixture list to hand the chat history IS the prediction history.
 *
 * What the real export taught us, and what this now handles:
 *
 *   Multi-line messages are one line per day, posted as a block.
 *   Stripping the newlines concatenates them in kick-off order, which
 *   is the right answer as long as the days are consecutive.
 *
 *   Off-season messages are a different competition. In the 2026 close
 *   season the group predicted the World Cup, in a "15th - HHHAD"
 *   format with several matches a day. Mapping those onto the next
 *   Premier League fixtures would be worse than useless, so anything
 *   outside a known season window is dropped rather than guessed at.
 *
 *   Long strings are usually celebration. A Premier League gameweek is
 *   ten matches, so "AHHHHHHHHHHH" after a late winner is not a call.
 *
 * Nothing is written without --write, and the report is the point.
 *
 * Usage:
 *   node scripts/import-whatsapp.mjs _chat.txt --seasons 2024,2025
 *   node scripts/import-whatsapp.mjs _chat.txt --seasons 2024,2025 --write
 *
 * Fixtures come from football-data.co.uk with the same ids the
 * backfill writes, so the report can be checked before the database
 * has anything in it. --write needs SUPABASE_URL and
 * SUPABASE_SERVICE_KEY, and needs the fixture backfill run first.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fetchSeason } from "./lib/pl-csv.mjs";

const FILE    = process.argv[2];
const WRITE   = process.argv.includes("--write");
const MAPF    = argVal("--map");
const OUT     = argVal("--out") || "whatsapp-import-report.tsv";
const SEASONS = (argVal("--seasons") || "").split(",").filter(Boolean).map(Number);
const MAX_RUN = Number(argVal("--max") || 10);   // longest believable batch

if(!FILE || !SEASONS.length){
  console.error("Usage: node scripts/import-whatsapp.mjs <export.txt> --seasons 2024,2025 [--write] [--map map.json]");
  process.exit(1);
}
function argVal(flag){ const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i+1] : null; }

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

/* ---------- Parsing the export ---------- */
// iOS:     [05/08/2022, 19:15:23] Ben Wright: HAHHA
// Android: 05/08/2022, 19:15 - Ben Wright: HAHHA
const IOS = /^‎?\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?\]\s*([^:]{1,40}):\s*(.*)$/i;
const AND = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?\s+-\s+([^:]{1,40}):\s*(.*)$/i;

export function parseLines(text){
  const out = [];
  for(const raw of text.split(/\r?\n/)){
    const line = raw.replace(/‎/g, "");
    const m = line.match(IOS) || line.match(AND);
    if(!m){                                  // continuation of a multi-line message
      if(out.length) out[out.length-1].text += "\n" + line;
      continue;
    }
    let [, d, mo, y, hh, mm, ss, ampm, author, body] = m;
    y = y.length === 2 ? 2000 + Number(y) : Number(y);
    hh = Number(hh);
    if(ampm){ const pm = /p/i.test(ampm); if(hh === 12) hh = pm ? 12 : 0; else if(pm) hh += 12; }
    const naive = Date.UTC(y, mo - 1, Number(d), hh, Number(mm), Number(ss || 0));
    out.push({ ts:new Date(naive - bst(naive)), author:author.trim(), text:body.trim() });
  }
  return out.map(m => ({ ...m, text: m.text.replace(/\s*<This message was edited>\s*/gi, "").trim() }));
}
function bst(utcMs){
  const y = new Date(utcMs).getUTCFullYear();
  const lastSun = (month) => {
    const dd = new Date(Date.UTC(y, month + 1, 0));
    return Date.UTC(y, month, dd.getUTCDate() - dd.getUTCDay(), 1);
  };
  return (utcMs >= lastSun(2) && utcMs < lastSun(9)) ? 3600e3 : 0;
}

const LETTERS = /^[HAD_\-.*\s]+$/;
export function asPicks(text){
  const t = text.replace(/\s/g, "");
  if(t.length < 1 || t.length > 24) return null;
  // Case is the cleanest signal in the whole export: across 515
  // candidate messages, 509 were typed in full caps and five of the
  // six that weren't are laughter. Anything not shouted isn't a call.
  if(!LETTERS.test(t)) return null;
  const picks = [...t].map(c => "HAD".includes(c) ? c : null);
  if(!picks.some(Boolean)) return null;
  return picks;
}
// Strictly alternating H and A. "HAHA" and "AHAH" are laughter;
// "HAHHA" has a double and is a real call, so alternation is the test.
export const looksLikeLaughter = t => {
  const s = t.replace(/\s/g, "");
  return s.length >= 4 && (/^(HA)+$/.test(s) || /^(AH)+$/.test(s));
};
export const isSingle  = t => t.replace(/\s/g, "").length === 1;
export const isChanting = t => { const s = t.replace(/\s/g, ""); return s.length >= 6 && new Set(s.toUpperCase()).size === 1; };

/* ---------- Main ---------- */
const iso  = d => d.toISOString().slice(0, 16).replace("T", " ");
const flat = t => t.replace(/\s+/g, " ").slice(0, 60);

if(process.argv[1].endsWith("import-whatsapp.mjs")){
  await main();
}

async function main(){
  const messages = parseLines(readFileSync(FILE, "utf8"));
  if(!messages.length){ console.error("No messages parsed — is this a WhatsApp export?"); process.exit(1); }
  console.log(`${messages.length} messages, ${iso(messages[0].ts)} to ${iso(messages[messages.length-1].ts)}`);

  // Fixtures, and the window each season occupies. A message outside
  // every window is another competition or the close season.
  const fixtures = [];
  const windows  = [];
  for(const y of SEASONS){
    const { label, rows } = await fetchSeason(y);
    fixtures.push(...rows);
    // Open the window a fortnight early: calls for the opening
    // weekend get posted before a ball is kicked.
    windows.push({
      label,
      from: new Date(new Date(rows[0].kickoff_utc).getTime() - 14*24*3600e3),
      to:   new Date(rows[rows.length-1].kickoff_utc)
    });
    console.log(`  ${label}: ${rows.length} fixtures, ${iso(new Date(rows[0].kickoff_utc))} to ${iso(new Date(rows[rows.length-1].kickoff_utc))}`);
  }
  fixtures.sort((a,b)=> new Date(a.kickoff_utc) - new Date(b.kickoff_utc) || a.home.localeCompare(b.home));
  const seasonAt = d => (windows.find(w => d >= w.from && d <= w.to) || {}).label || null;

  const nameMap = MAPF ? JSON.parse(readFileSync(MAPF, "utf8")) : {};
  const rows = [], report = [["status","when","season","author","message","fixture","kickoff","pick","result"].join("\t")];
  const counts = { offSeason:0, chat:0, tooLong:0, laughter:0, single:0, chant:0, overrun:0, ok:0 };
  const posters = new Set();

  for(const msg of messages){
    const picks = asPicks(msg.text);
    if(!picks){ counts.chat++; continue; }

    const season = seasonAt(msg.ts);
    if(!season){
      counts.offSeason++;
      report.push(["OFF-SEASON", iso(msg.ts), "", msg.author, flat(msg.text), "", "", "", ""].join("\t"));
      continue;
    }
    if(picks.length > MAX_RUN){
      counts.tooLong++;
      report.push(["TOO-LONG", iso(msg.ts), season, msg.author, flat(msg.text), "", "", "", ""].join("\t"));
      continue;
    }
    const laugh = looksLikeLaughter(msg.text), single = isSingle(msg.text), chant = isChanting(msg.text);
    if(laugh) counts.laughter++; if(single) counts.single++; if(chant) counts.chant++;
    posters.add(msg.author);

    const openAt = fixtures.filter(f => new Date(f.kickoff_utc) > msg.ts && f.season === season);
    picks.forEach((pick, i) => {
      if(!pick) return;
      const f = openAt[i];
      if(!f){
        counts.overrun++;
        report.push(["PAST-END", iso(msg.ts), season, msg.author, flat(msg.text), "", "", pick, ""].join("\t"));
        return;
      }
      counts.ok++;
      rows.push({ author:msg.author, fixture:f, pick, ts:msg.ts,
                  status: laugh ? "CHECK-LAUGH" : chant ? "CHECK-CHANT" : single ? "CHECK-SINGLE" : "OK" });
      report.push([
        laugh ? "CHECK-LAUGH" : chant ? "CHECK-CHANT" : single ? "CHECK-SINGLE" : "OK",
        iso(msg.ts), season, msg.author, flat(msg.text),
        `${f.home_short} v ${f.away_short}`, f.kickoff_utc, pick, f.result
      ].join("\t"));
    });
  }

  // Later messages win: a repost is a correction.
  const dedup = new Map();
  for(const r of rows) dedup.set(`${r.author}|${r.fixture.id}`, r);
  const final = [...dedup.values()];

  writeFileSync(OUT, report.join("\n"));

  console.log(`\nmessages ignored as chat: ${counts.chat}`);
  console.log(`dropped, outside a season window: ${counts.offSeason}`);
  console.log(`dropped, longer than ${MAX_RUN} picks: ${counts.tooLong}`);
  console.log(`picks that ran past the end of the season: ${counts.overrun}`);
  console.log(`flagged for a look — laughter ${counts.laughter}, chanting ${counts.chant}, lone letter ${counts.single}`);
  console.log(`\n${final.length} predictions reconstructed (${rows.length - final.length} superseded)`);

  // The number that matters. H/A/D calls land near 40-55%; well outside
  // that, the strings are misaligned rather than the callers unlucky.
  const bySeason = {};
  for(const r of final){
    const k = `${r.fixture.season}|${r.author}`;
    const b = bySeason[k] || (bySeason[k] = { n:0, ok:0 });
    b.n++; if(r.pick === r.fixture.result) b.ok++;
  }
  console.log("\nstrike rate by season and player:");
  Object.entries(bySeason).sort().forEach(([k,v])=>{
    const [s, who] = k.split("|");
    console.log(`  ${s}  ${who.padEnd(16)} ${String(v.ok).padStart(3)}/${String(v.n).padEnd(3)}  ${Math.round(v.ok/v.n*100)}%`);
  });

  // Per-matchday totals, to diff against the spreadsheet.
  const md = {};
  for(const r of final){
    const k = `${r.fixture.season}\t${r.fixture.matchday}\t${r.author}`;
    const b = md[k] || (md[k] = { n:0, ok:0 });
    b.n++; if(r.pick === r.fixture.result) b.ok++;
  }
  const mdFile = OUT.replace(/\.tsv$/, "") + "-by-matchday.tsv";
  writeFileSync(mdFile, ["season\tmatchday\tplayer\tcorrect\tplayed",
    ...Object.entries(md).sort().map(([k,v])=> `${k}\t${v.ok}\t${v.n}`)].join("\n"));

  console.log(`\nreport:            ${OUT}`);
  console.log(`matchday totals:   ${mdFile}   <- diff this against the spreadsheet`);

  if(!WRITE){ console.log(`\nNothing written. Re-run with --write once both files read right.`); return; }

  const players = await (await sb("pl_players?select=id,name")).json();
  const byName = new Map(players.map(p => [p.name.toLowerCase(), p]));
  const resolve = a => byName.get((nameMap[a] || a).toLowerCase())
                    || [...byName.values()].find(p => (nameMap[a] || a).toLowerCase().startsWith(p.name.toLowerCase()));
  const unresolved = [...posters].filter(a => !resolve(a));
  if(unresolved.length){
    console.error(`\nCan't match these chat names to players: ${unresolved.join(", ")}`);
    console.error(`Pass --map with e.g. {"Tobias Unwin":"Toby"}`);
    process.exit(1);
  }

  const payload = final.map(r => ({
    player_id: resolve(r.author).id, fixture_id: r.fixture.id, pick: r.pick,
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
}
