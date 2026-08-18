/**
 * Reading the group's spreadsheet.
 *
 * One row per day per season, with how many each player got right.
 * This is the authority on scores — the chat reconstruction is only
 * ever ~93% complete, so anything that counts points reads from here.
 *
 * .xlsx is a zip of XML and there's no spreadsheet library available,
 * so it's unzipped to a temp dir and the XML read directly.
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sheet tab -> season label.
export const SHEET_SEASONS = {
  "2122":"2021/22", "2223":"2022/23", "2324":"2023/24", "2425":"2024/25", "2526":"2025/26"
};
// Column -> player name, and E = fixtures that day.
export const SHEET_COLS = { B:"Darius", C:"Ben", D:"Toby" };
export const PLAYERS = Object.values(SHEET_COLS);

// Qatar 2022 sat inside the 2022/23 season and isn't Premier League.
const NOT_PL = day => day >= "2022-11-20" && day <= "2022-12-18";

const dec = s => s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"')
                  .replace(/&apos;/g,"'").replace(/&amp;/g,"&");
const serialToDay = n => new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);

/**
 * Returns { "2023/24|2024-01-13": { matches, Darius, Ben, Toby }, ... }
 */
export function readPredictionSheet(xlsxPath){
  const dir = mkdtempSync(join(tmpdir(), "plsheet-"));
  try {
    execFileSync("unzip", ["-o", xlsxPath, "-d", dir], { stdio:"ignore" });
    const x = f => readFileSync(join(dir, "xl", f), "utf8");

    const rels = {};
    for(const m of x("_rels/workbook.xml.rels").matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) rels[m[1]] = m[2];

    const out = {};
    for(const m of x("workbook.xml").matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)){
      const season = SHEET_SEASONS[dec(m[1])];
      if(!season) continue;
      const sheet = x(rels[m[2]].replace(/^\/?xl\//, ""));

      for(const row of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)){
        const cells = {};
        for(const c of row[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)){
          if(/t="s"/.test(c[2])) continue;                 // shared string: a label, not a number
          const v = (c[3].match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          if(v != null && v !== "") cells[c[1]] = Number(v);
        }
        // Column A holds an Excel date serial on the day rows and text
        // ("August", "Gameweek 3:") everywhere else.
        if(!(cells.A > 44000 && cells.A < 47500)) continue;
        const day = serialToDay(cells.A);
        if(NOT_PL(day)) continue;
        out[`${season}|${day}`] = {
          matches: cells.E || 0,
          ...Object.fromEntries(Object.entries(SHEET_COLS).map(([col, who]) => [who, cells[col] || 0]))
        };
      }
    }
    return out;
  } finally {
    rmSync(dir, { recursive:true, force:true });
  }
}

/**
 * Per player-day counts from an import report: how many picks were
 * recovered and how many of them were right.
 */
export function readImportReport(file){
  const out = {};
  for(const line of readFileSync(file, "utf8").split("\n").slice(1)){
    if(!line.trim()) continue;
    const c = line.split("\t");
    if(!c[6]) continue;                                    // nothing mapped
    const key = `${c[2]}|${c[6].slice(0, 10)}`;
    const day = out[key] || (out[key] = Object.fromEntries(PLAYERS.map(p => [p, { n:0, ok:0 }])));
    if(!day[c[3]]) continue;
    day[c[3]].n++;
    if(c[7] === c[8]) day[c[3]].ok++;
  }
  return out;
}
