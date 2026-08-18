#!/usr/bin/env node
/**
 * Check a reconstruction against the group's own spreadsheet.
 *
 * The spreadsheet is the authority: one row per day per season, with
 * the number each player got right. That makes it a checksum for the
 * chat import, which is otherwise unverifiable — a misaligned string
 * produces plausible-looking picks and nothing complains.
 *
 * The number that matters is the last one printed: of the player-days
 * where the import recovered every fixture, how many match the sheet
 * exactly. Anything below ~95% means the mapping is wrong somewhere,
 * not merely incomplete.
 *
 * Reads .xlsx directly — it's a zip of XML, and there's no spreadsheet
 * library here.
 *
 * Usage:
 *   node scripts/verify-against-sheet.mjs "PL Match Predictions.xlsx" chat-import-report.tsv
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [XLSX, REPORT] = process.argv.slice(2);
if(!XLSX || !REPORT){
  console.error('Usage: node scripts/verify-against-sheet.mjs <sheet.xlsx> <chat-import-report.tsv>');
  process.exit(1);
}

// Sheet tab -> season, and the days to ignore. Qatar 2022 sat inside
// the 2022/23 season and isn't Premier League.
const SEASONS = { "2122":"2021/22", "2223":"2022/23", "2324":"2023/24", "2425":"2024/25", "2526":"2025/26" };
const IGNORE  = d => d >= "2022-11-20" && d <= "2022-12-18";
const COLS    = { B:"Darius", C:"Ben", D:"Toby" };      // and E = matches that day

const dir = mkdtempSync(join(tmpdir(), "xlsx-"));
try {
  execFileSync("unzip", ["-o", XLSX, "-d", dir], { stdio:"ignore" });
  const truth = readWorkbook(dir);
  compare(truth, readReport(REPORT));
} finally {
  rmSync(dir, { recursive:true, force:true });
}

function readWorkbook(dir){
  const x = f => readFileSync(join(dir, "xl", f), "utf8");
  const dec = s => s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"')
                    .replace(/&apos;/g,"'").replace(/&amp;/g,"&");

  const shared = [...x("sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => dec([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join("")));

  const rels = {};
  for(const m of x("_rels/workbook.xml.rels").matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) rels[m[1]] = m[2];

  const truth = {};
  for(const m of x("workbook.xml").matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)){
    const season = SEASONS[dec(m[1])];
    if(!season) continue;
    const sheet = x(rels[m[2]].replace(/^\/?xl\//, ""));
    for(const r of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)){
      const cells = {};
      for(const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)){
        const t = (c[2].match(/t="([^"]+)"/) || [])[1];
        const v = (c[3].match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if(v == null || t === "s") continue;               // dates and counts are numeric
        cells[c[1]] = Number(v);
      }
      // Column A is an Excel date serial on the day rows, text elsewhere.
      if(!(cells.A > 44000 && cells.A < 47500)) continue;
      const day = new Date(Math.round((cells.A - 25569) * 86400000)).toISOString().slice(0, 10);
      if(IGNORE(day)) continue;
      truth[`${season}|${day}`] = {
        matches: cells.E || 0,
        ...Object.fromEntries(Object.entries(COLS).map(([col, who]) => [who, cells[col] || 0]))
      };
    }
  }
  return truth;
}

function readReport(file){
  const mine = {};
  for(const line of readFileSync(file, "utf8").split("\n").slice(1)){
    if(!line.trim()) continue;
    const c = line.split("\t");
    if(!c[6]) continue;                                    // nothing mapped
    const k = `${c[2]}|${c[6].slice(0, 10)}`;
    const m = mine[k] || (mine[k] = Object.fromEntries(Object.values(COLS).map(w => [w, {n:0, ok:0}])));
    if(!m[c[3]]) continue;
    m[c[3]].n++;
    if(c[7] === c[8]) m[c[3]].ok++;
  }
  return mine;
}

function compare(truth, mine){
  const players = Object.values(COLS);
  const totals = {};
  let recovered = 0, possible = 0, complete = 0, exact = 0;
  const wrong = [];

  for(const key of Object.keys(truth).sort()){
    const t = truth[key], m = mine[key];
    const [season] = key.split("|");
    const agg = totals[season] || (totals[season] = Object.fromEntries(players.map(p => [p, {sheet:0, mine:0}])));
    for(const p of players){
      agg[p].sheet += t[p];
      possible += t.matches;
      if(!m) continue;
      agg[p].mine += m[p].ok;
      recovered += m[p].n;
      if(m[p].n !== t.matches) continue;                   // only judge days recovered in full
      complete++;
      if(m[p].ok === t[p]) exact++;
      else wrong.push(`${key} ${p}: sheet ${t[p]}, mine ${m[p].ok} of ${t.matches}`);
    }
  }

  console.log("season    player   sheet   mine    gap");
  for(const [season, agg] of Object.entries(totals).sort()){
    for(const p of players){
      const { sheet, mine: got } = agg[p];
      console.log(`${season}  ${p.padEnd(7)} ${String(sheet).padStart(6)} ${String(got).padStart(6)} ${String(sheet-got).padStart(6)}`);
    }
  }

  console.log(`\ncoverage: ${recovered} of ${possible} player-matches (${(recovered/possible*100).toFixed(1)}%)`);
  console.log(`\nplayer-days recovered in full: ${complete}`);
  console.log(`  matching the spreadsheet exactly: ${exact} (${(exact/complete*100).toFixed(1)}%)`);
  console.log(`  disagreeing: ${wrong.length}`);
  wrong.slice(0, 20).forEach(w => console.log("    " + w));
  if(wrong.length > 20) console.log(`    ... and ${wrong.length - 20} more`);
  console.log(`\nBelow ~95% exact means the mapping is wrong, not just incomplete.`);
}
