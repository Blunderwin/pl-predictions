#!/usr/bin/env node
/**
 * Build the authoritative history from the spreadsheet.
 *
 * Two tiers of truth, and keeping them apart is the whole point:
 *
 *   The spreadsheet is right about SCORES. Every point, every season
 *   standing, every total comes from here.
 *
 *   The chat reconstruction is right about PICKS, but only ~93% of
 *   them, and only provably so on the days where its recovered count
 *   and its correct count both match the sheet. Those days get
 *   verified = true, and are the only ones the pick-level stats
 *   (draw specialist, herd, team affinity, head-to-head) may use.
 *
 * A day where the reconstruction is short is a gap: the score still
 * counts, the picks are not to be reasoned from.
 *
 * Usage:
 *   node scripts/build-history.mjs "PL Match Predictions.xlsx" chat-import-report.tsv > history-load.sql
 */
import { readPredictionSheet, readImportReport, PLAYERS } from "./lib/sheet.mjs";

const [XLSX, REPORT] = process.argv.slice(2);
if(!XLSX || !REPORT){
  console.error('Usage: node scripts/build-history.mjs <sheet.xlsx> <chat-import-report.tsv> > history-load.sql');
  process.exit(1);
}

const truth = readPredictionSheet(XLSX);
const mine  = readImportReport(REPORT);

const rows = [];
const stats = { days:0, verified:0, short:0, over:0, mismatch:0 };

for(const key of Object.keys(truth).sort()){
  const [season, day] = key.split("|");
  const t = truth[key];
  if(!t.matches) continue;
  const m = mine[key];

  for(const player of PLAYERS){
    const recovered = m ? m[player].n  : 0;
    const rebuilt   = m ? m[player].ok : 0;
    // Verified means: every fixture of that day was recovered, and the
    // reconstruction independently arrives at the sheet's own number.
    const verified  = recovered === t.matches && rebuilt === t[player];
    stats.days++;
    if(verified) stats.verified++;
    else if(recovered < t.matches) stats.short++;
    else if(recovered > t.matches) stats.over++;
    else stats.mismatch++;

    rows.push({ season, day, player, correct: t[player], matches: t.matches, recovered, verified });
  }
}

const esc = s => String(s).replace(/'/g, "''");
const chunks = [];
for(let i = 0; i < rows.length; i += 500) chunks.push(rows.slice(i, i + 500));

console.log(`-- Authoritative history, from the group's spreadsheet.`);
console.log(`-- ${rows.length} player-days. Scores here are the truth; the`);
console.log(`-- verified flag says whether the reconstructed picks for that`);
console.log(`-- day may be used for pick-level statistics.`);
console.log(`-- verified ${stats.verified} · short ${stats.short} · over-recovered ${stats.over} · disagreeing ${stats.mismatch}`);
console.log(`-- Re-runnable.`);
console.log("");
for(const chunk of chunks){
  console.log("insert into pl_history (player_id, season, played_on, correct, matches, recovered, verified)");
  console.log("select p.id, v.season, v.played_on, v.correct, v.matches, v.recovered, v.verified");
  console.log("from (values");
  console.log(chunk.map((r, i) =>
    `  ('${esc(r.player)}'${i ? "" : "::text"}, '${r.season}'${i ? "" : "::text"}, '${r.day}'${i ? "" : "::date"}, ` +
    `${r.correct}${i ? "" : "::int"}, ${r.matches}${i ? "" : "::int"}, ${r.recovered}${i ? "" : "::int"}, ` +
    `${r.verified}${i ? "" : "::boolean"})`
  ).join(",\n"));
  console.log(") as v(player, season, played_on, correct, matches, recovered, verified)");
  console.log("join pl_players p on lower(p.name) = lower(v.player)");
  console.log("on conflict (player_id, season, played_on) do update set");
  console.log("  correct = excluded.correct, matches = excluded.matches,");
  console.log("  recovered = excluded.recovered, verified = excluded.verified;");
  console.log("");
}
console.log("-- Check: these totals are what the app will show as the season standings.");
console.log("select season, p.name, sum(correct) as points, sum(matches) as matches,");
console.log("       sum(recovered) as picks_recovered,");
console.log("       count(*) filter (where verified) as verified_days, count(*) as days");
console.log("  from pl_history h join pl_players p on p.id = h.player_id");
console.log(" group by season, p.name order by season, points desc;");

console.error(`${rows.length} player-days: ${stats.verified} verified, ${stats.short} short, ${stats.over} over-recovered, ${stats.mismatch} recovered in full but disagreeing`);
