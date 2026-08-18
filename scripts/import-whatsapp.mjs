#!/usr/bin/env node
/**
 * Reconstruct historic predictions from a WhatsApp chat export.
 *
 * The insight this rests on: a message like "_AHHA" posted at 09:58 on
 * a Saturday is only meaningful against the fixtures that were still
 * open at 09:58, in kick-off order. That is exactly the mapping the
 * live app does — so with the fixture list backfilled, the group's
 * chat history IS the prediction history.
 *
 * It will not get everything right on its own. "HAHAHA" is both a
 * valid five-match call and a laugh; a string posted after part of the
 * batch kicked off shifts alignment; people repost and correct. So the
 * default is a report you read, not a write you trust.
 *
 * Export the chat from WhatsApp: chat > Export Chat > Without Media.
 *
 * Usage:
 *   node scripts/import-whatsapp.mjs chat.txt                 # report only
 *   node scripts/import-whatsapp.mjs chat.txt --write         # then insert
 *   node scripts/import-whatsapp.mjs chat.txt --map map.json  # author -> player name
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */
import { readFileSync, writeFileSync } from "node:fs";

const FILE  = process.argv[2];
const WRITE = process.argv.includes("--write");
const MAPF  = argVal("--map");
const OUT   = argVal("--out") || "whatsapp-import-report.tsv";

if(!FILE){ console.error("Usage: node scripts/import-whatsapp.mjs <export.txt> [--write] [--map map.json]"); process.exit(1); }
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

function parseLines(text){
  const out = [];
  for(const raw of text.split(/\r?\n/)){
    const m = raw.match(IOS) || raw.match(AND);
    if(!m){                                  // continuation of a multi-line message
      if(out.length) out[out.length-1].text += "\n" + raw;
      continue;
    }
    let [, d, mo, y, hh, mm, ss, ampm, author, body] = m;
    y = y.length === 2 ? 2000 + Number(y) : Number(y);
    hh = Number(hh);
    if(ampm){ const pm = /p/i.test(ampm); if(hh === 12) hh = pm ? 12 : 0; else if(pm) hh += 12; }
    // WhatsApp stamps in the exporter's local time. UK local -> UTC.
    const naive = Date.UTC(y, mo - 1, Number(d), hh, Number(mm), Number(ss || 0));
    out.push({
      ts: new Date(naive - bstOffsetMs(naive)),
      author: author.replace(/‎/g, "").trim(),
      text: body.replace(/‎/g, "").trim()
    });
  }
  return out;
}
function bstOffsetMs(utcMs){
  const y = new Date(utcMs).getUTCFullYear();
  const lastSun = (month) => {
    const dd = new Date(Date.UTC(y, month + 1, 0));
    return Date.UTC(y, month, dd.getUTCDate() - dd.getUTCDay(), 1);
  };
  return (utcMs >= lastSun(2) && utcMs < lastSun(9)) ? 3600e3 : 0;
}

const LETTERS = /^[HAD_\-.*\s]+$/i;
function asPicks(text){
  const t = text.replace(/\s/g, "");
  if(t.length < 1 || t.length > 20) return null;
  if(!LETTERS.test(t)) return null;
  const picks = [...t.toUpperCase()].map(c => "HAD".includes(c) ? c : null);
  if(!picks.some(Boolean)) return null;
  return picks;
}
// "HAHAHA", "HAHAHAHA" — laughter reads as a legal string. Flag rather
// than guess; five of these in a season is a two-minute read-through.
const looksLikeLaughter = t => /^(ha){3,}$|^(ah){3,}$/i.test(t.replace(/\s/g, ""));
// A lone "A" is a one-match call in this group's history, so it counts —
// but it's also the likeliest false positive, so it goes in the report
// marked for a look rather than being trusted.
const isSingle = t => t.replace(/\s/g, "").length === 1;

/* ---------- Main ---------- */
const messages = parseLines(readFileSync(FILE, "utf8"));
if(!messages.length){ console.error("No messages parsed — is this a WhatsApp export?"); process.exit(1); }
console.log(`${messages.length} messages, ${messages[0].ts.toISOString().slice(0,10)} to ${messages[messages.length-1].ts.toISOString().slice(0,10)}`);

const authors = [...new Set(messages.map(m => m.author))];
const nameMap = MAPF ? JSON.parse(readFileSync(MAPF, "utf8")) : {};
console.log(`Authors: ${authors.join(", ")}`);

// Fixtures and players come from the database — run the backfill first.
let fixtures = [], players = [];
if(SB_URL && SB_KEY){
  fixtures = await (await sb("pl_fixtures?select=id,season,kickoff_utc,home,away,home_short,away_short,result&order=kickoff_utc.asc")).json();
  players  = await (await sb("pl_players?select=id,name")).json();
}else{
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_KEY — the report needs the fixture list.");
  process.exit(1);
}
if(!fixtures.length){ console.error("No fixtures on file. Run backfill-fixtures.mjs first."); process.exit(1); }
console.log(`${fixtures.length} fixtures, ${players.length} players on file`);

const byName = new Map(players.map(p => [p.name.toLowerCase(), p]));
const resolve = (author) => {
  const want = (nameMap[author] || author).toLowerCase();
  return byName.get(want) || [...byName.values()].find(p => want.startsWith(p.name.toLowerCase()));
};

const unresolved = authors.filter(a => !resolve(a));
if(unresolved.length){
  console.error(`\nCan't match these chat names to players: ${unresolved.join(", ")}`);
  console.error(`Add them in the app, or pass --map with e.g. {"Ben Wright":"Ben"}`);
  process.exit(1);
}

// Same ordering rule as the app: kick-off, then home team.
fixtures.sort((a, b) => new Date(a.kickoff_utc) - new Date(b.kickoff_utc) || a.home.localeCompare(b.home));

const rows = [];        // one per resolved prediction
const report = [["status","when","author","string","fixture","kickoff","pick","result"].join("\t")];
let flagged = 0, skipped = 0;

for(const msg of messages){
  const picks = asPicks(msg.text);
  if(!picks){ skipped++; continue; }
  const player = resolve(msg.author);
  const openAt = fixtures.filter(f => new Date(f.kickoff_utc) > msg.ts);
  const laugh = looksLikeLaughter(msg.text);
  const single = isSingle(msg.text);
  if(laugh || single) flagged++;

  picks.forEach((pick, i) => {
    if(!pick) return;
    const f = openAt[i];
    if(!f){
      report.push(["NO-FIXTURE", msg.ts.toISOString(), msg.author, msg.text, "", "", pick, ""].join("\t"));
      return;
    }
    rows.push({ player_id:player.id, fixture_id:f.id, pick, created_at:msg.ts.toISOString(), updated_at:msg.ts.toISOString() });
    report.push([
      laugh ? "CHECK-LAUGH" : single ? "CHECK-SINGLE" : "OK",
      msg.ts.toISOString(), msg.author, msg.text,
      `${f.home_short} v ${f.away_short}`, f.kickoff_utc, pick, f.result || ""
    ].join("\t"));
  });
}

// Later messages win: a repost is a correction.
const dedup = new Map();
for(const r of rows) dedup.set(`${r.player_id}|${r.fixture_id}`, r);
const final = [...dedup.values()];
const overwritten = rows.length - final.length;

writeFileSync(OUT, report.join("\n"));
const hits = final.filter(r => {
  const f = fixtures.find(x => x.id === r.fixture_id);
  return f && f.result === r.pick;
}).length;

console.log(`\n${final.length} predictions reconstructed (${overwritten} superseded by later messages)`);
console.log(`${hits} of them correct — ${Math.round(hits / Math.max(1, final.length) * 100)}%`);
console.log(`${flagged} messages flagged for a look (laughter or a lone letter), ${skipped} ignored as chat`);
console.log(`\nReport written to ${OUT}. Open it in a spreadsheet and read it before writing.`);
console.log(`A strike rate wildly off 40-50% is the signal that the alignment is wrong somewhere.`);

if(!WRITE){ console.log(`\nNothing written. Re-run with --write once the report looks right.`); process.exit(0); }

for(let i = 0; i < final.length; i += 200){
  await sb("pl_predictions?on_conflict=player_id,fixture_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(final.slice(i, i + 200))
  });
}
console.log(`\n${final.length} predictions written.`);
