#!/usr/bin/env node
/**
 * Backfill past Premier League seasons from football-data.co.uk.
 *
 * Note the .co.uk — a different outfit to football-data.org, and the
 * reason this is possible at all: the .org free tier only serves the
 * current season, while .co.uk publishes a free CSV per season back to
 * 1993. No key, no quota.
 *
 * The fetching and the id derivation live in lib/pl-csv.mjs, shared
 * with import-whatsapp.mjs. That sharing is load-bearing: the import
 * maps chat strings onto fixture ids, so if the two derived ids
 * differently the import would write rows pointing at nothing.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY
 * Usage: node scripts/backfill-fixtures.mjs 2022 2023 2024 2025 [--dry-run]
 */
import { fetchSeason } from "./lib/pl-csv.mjs";

const DRY   = process.argv.includes("--dry-run");
const YEARS = process.argv.slice(2).filter(a => /^\d{4}$/.test(a)).map(Number);

if(!YEARS.length){
  console.error("Give me one or more season start years, e.g. 2022 2023 2024 2025");
  process.exit(1);
}

function need(k){
  const v = process.env[k];
  if(!v && !DRY){ console.error(`Missing env ${k}`); process.exit(1); }
  return v || "";
}
const SB_URL = need("SUPABASE_URL").replace(/\/$/, "");
const SB_KEY = need("SUPABASE_SERVICE_KEY");

async function sb(path, init){
  const res = await fetch(SB_URL + "/rest/v1/" + path, {
    ...init,
    headers: { apikey:SB_KEY, Authorization:`Bearer ${SB_KEY}`, "Content-Type":"application/json", ...(init?.headers||{}) }
  });
  if(!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
  return res;
}

async function season(startYear){
  const { label, rows, missingTimes } = await fetchSeason(startYear);
  console.log(`${label}: ${rows.length} matches${missingTimes ? `, ${missingTimes} without a kick-off time (defaulted to 15:00)` : ""}`);

  if(DRY){ console.log("  sample:", JSON.stringify(rows[0], null, 2)); return; }

  // result is a generated column in Postgres — send the goals, not the outcome.
  const payload = rows.map(({ result, ...r }) => r);
  for(let i = 0; i < payload.length; i += 100){
    await sb("pl_fixtures?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(payload.slice(i, i + 100))
    });
  }
  console.log("  written");
}

for(const y of YEARS){
  try { await season(y); }
  catch(e){ console.error(`  ${y} failed: ${e.message}`); }
}
