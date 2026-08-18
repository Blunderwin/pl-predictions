#!/usr/bin/env node
/**
 * Pull Premier League fixtures + results from football-data.org and
 * upsert them into pl_fixtures.
 *
 * Runs in GitHub Actions, never in the browser: the API token and the
 * Supabase service key stay as repo secrets, and there is no CORS to
 * fight. Node 20+ (native fetch), no dependencies.
 *
 * Env:
 *   FOOTBALL_DATA_TOKEN   football-data.org API token (free tier is fine)
 *   SUPABASE_URL          https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role key — bypasses RLS, hence secret
 *   PL_SEASON             optional, e.g. 2026 for 2026/27. Defaults to
 *                         the season that's currently running.
 */

const TOKEN   = need("FOOTBALL_DATA_TOKEN");
const SB_URL  = need("SUPABASE_URL").replace(/\/$/, "");
const SB_KEY  = need("SUPABASE_SERVICE_KEY");
const SEASON  = Number(process.env.PL_SEASON || currentSeasonStart());
const LABEL   = `${SEASON}/${String((SEASON + 1) % 100).padStart(2, "0")}`;

function need(k){
  const v = process.env[k];
  if(!v) { console.error(`Missing env ${k}`); process.exit(1); }
  return v;
}

// A season starting in July runs into the following May, so anything
// before July still belongs to the previous year's season.
function currentSeasonStart(){
  const d = new Date();
  return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
}

async function fd(path){
  const res = await fetch("https://api.football-data.org/v4" + path, {
    headers: { "X-Auth-Token": TOKEN }
  });
  if(!res.ok) throw new Error(`football-data ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sb(path, init){
  const res = await fetch(SB_URL + "/rest/v1/" + path, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers || {})
    }
  });
  if(!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
  return res;
}

const short = t => t.shortName || t.tla || t.name;

function toRow(m){
  return {
    id: m.id,
    season: LABEL,
    matchday: m.matchday ?? 0,
    kickoff_utc: m.utcDate,
    home: m.homeTeam.name,
    away: m.awayTeam.name,
    home_short: short(m.homeTeam),
    away_short: short(m.awayTeam),
    status: m.status,
    home_goals: m.score?.fullTime?.home ?? null,
    away_goals: m.score?.fullTime?.away ?? null,
    updated_at: new Date().toISOString()
  };
}

// Two rows are "the same" if nothing the app renders has moved.
const WATCHED = ["matchday","kickoff_utc","home","away","home_short","away_short","status","home_goals","away_goals"];
function changed(next, prev){
  if(!prev) return true;
  return WATCHED.some(k => String(next[k] ?? "") !== String(prev[k] ?? ""));
}

async function main(){
  console.log(`Season ${LABEL} (start ${SEASON})`);

  const data = await fd(`/competitions/PL/matches?season=${SEASON}`);
  const matches = data.matches || [];
  if(!matches.length){ console.log("No matches returned — nothing to do."); return; }
  console.log(`football-data returned ${matches.length} matches`);

  const existingRows = await (await sb(
    `pl_fixtures?select=id,matchday,kickoff_utc,kickoff_original,home,away,home_short,away_short,status,home_goals,away_goals&season=eq.${encodeURIComponent(LABEL)}`
  )).json();
  const existing = new Map(existingRows.map(r => [r.id, r]));
  console.log(`${existing.size} already on file`);

  const payload = [];
  const moves = [];
  for(const m of matches){
    const row = toRow(m);
    const prev = existing.get(row.id);
    if(!changed(row, prev)) continue;

    // kickoff_original is written once, on first sight, and is what
    // lets the app flag a fixture that's been shifted for TV.
    row.kickoff_original = prev?.kickoff_original || row.kickoff_utc;
    if(prev && prev.kickoff_utc !== row.kickoff_utc){
      moves.push(`${row.home_short} v ${row.away_short}: ${prev.kickoff_utc} -> ${row.kickoff_utc}`);
    }
    payload.push(row);
  }

  if(!payload.length){ console.log("Nothing changed."); return; }

  for(let i = 0; i < payload.length; i += 100){
    const chunk = payload.slice(i, i + 100);
    await sb("pl_fixtures?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(chunk)
    });
    console.log(`upserted ${chunk.length}`);
  }

  const settled = payload.filter(r => r.status === "FINISHED").length;
  console.log(`${payload.length} rows written (${settled} finished)`);
  if(moves.length){
    console.log(`\n${moves.length} kick-off change${moves.length === 1 ? "" : "s"}:`);
    moves.forEach(m => console.log("  " + m));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
