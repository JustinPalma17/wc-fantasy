/**
 * backfill-scores.js
 * --------------------------------------------------------------
 * Same idea as update-scores.js, but for matches that ALREADY
 * happened (not currently live). Pulls all finished fixtures in
 * a date range, computes stats, and writes them into a specific
 * gameweek in Firebase.
 *
 * Run with: node backfill-scores.js
 * Requires env vars: API_FOOTBALL_KEY, FIREBASE_DB_URL, GW, FROM_DATE, TO_DATE
 * Example: GW=1 FROM_DATE=2026-06-11 TO_DATE=2026-06-17
 * --------------------------------------------------------------
 */

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const DATA_PATH = "wc_fantasy_league_v1";
const GW = process.env.GW;
const FROM_DATE = process.env.FROM_DATE; // format: YYYY-MM-DD
const TO_DATE = process.env.TO_DATE; // format: YYYY-MM-DD

const LEAGUE_ID = 1; // FIFA World Cup in API-Football. Verify if results look wrong.
const SEASON = 2026;

if (!API_FOOTBALL_KEY || !FIREBASE_DB_URL || !GW || !FROM_DATE || !TO_DATE) {
  console.error("Missing one of: API_FOOTBALL_KEY, FIREBASE_DB_URL, GW, FROM_DATE, TO_DATE");
  process.exit(1);
}

const API_BASE = "https://v3.football.api-sports.io";

function apiHeaders() {
  return { "x-apisports-key": API_FOOTBALL_KEY };
}

function normalize(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: apiHeaders() });
  if (!res.ok) throw new Error(`API-Football error ${res.status} on ${path}`);
  const json = await res.json();
  return json.response || [];
}

function buildFirebaseUrl(path) {
  const url = new URL(FIREBASE_DB_URL);
  const basePath = url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}/${path}.json`;
  return url.toString();
}

function firebaseGetUrl() {
  return buildFirebaseUrl(DATA_PATH);
}

function firebaseGameweekUrl(gw) {
  return buildFirebaseUrl(`${DATA_PATH}/gameweeks/${gw}`);
}

async function fetchCurrentState() {
  const res = await fetch(firebaseGetUrl());
  if (!res.ok) throw new Error(`Firebase read failed: HTTP ${res.status}`);
  const json = await res.json();
  return json || { players: [], managers: [], gameweeks: {} };
}

async function patchGameweek(gw, updates) {
  if (Object.keys(updates).length === 0) {
    console.log("No matching player updates to write — skipping save.");
    return;
  }
  const res = await fetch(firebaseGameweekUrl(gw), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`Firebase write failed: HTTP ${res.status}`);
  console.log(`Wrote stats for ${Object.keys(updates).length} player(s) to gameweek ${gw}.`);
}

function buildPlayerIndex(players) {
  const index = new Map();
  (players || []).forEach((p) => {
    const key = normalize(p.name) + "|" + normalize(p.team);
    index.set(key, p);
  });
  return index;
}

async function main() {
  console.log(`Backfilling gameweek ${GW} for matches between ${FROM_DATE} and ${TO_DATE}...`);

  console.log("Fetching current player/manager data from Firebase...");
  const state = await fetchCurrentState();
  const playerIndex = buildPlayerIndex(state.players);

  console.log("Fetching finished fixtures in this date range...");
  const fixtures = await apiGet(
    `/fixtures?league=${LEAGUE_ID}&season=${SEASON}&from=${FROM_DATE}&to=${TO_DATE}&status=FT-AET-PEN`
  );

  if (fixtures.length === 0) {
    console.log("No finished fixtures found in this date range. Nothing to backfill.");
    console.log("If matches definitely happened, double check LEAGUE_ID and SEASON are correct.");
    return;
  }

  console.log(`Found ${fixtures.length} finished fixture(s).`);

  const updates = {};

  for (const fixture of fixtures) {
    const fixtureId = fixture.fixture.id;
    const homeTeamName = fixture.teams.home.name;
    const awayTeamName = fixture.teams.away.name;
    const homeGoals = fixture.goals.home ?? 0;
    const awayGoals = fixture.goals.away ?? 0;

    console.log(`Fetching player stats for fixture ${fixtureId} (${homeTeamName} ${homeGoals}-${awayGoals} ${awayTeamName})...`);
    const playerStatsByTeam = await apiGet(`/fixtures/players?fixture=${fixtureId}`);

    playerStatsByTeam.forEach((teamBlock) => {
      const teamName = teamBlock.team.name;
      const concededZero =
        (teamName === homeTeamName && awayGoals === 0) ||
        (teamName === awayTeamName && homeGoals === 0);

      (teamBlock.players || []).forEach((entry) => {
        const apiName = entry.player.name;
        const stats = (entry.statistics && entry.statistics[0]) || {};
        const minutesPlayed = (stats.games && stats.games.minutes) || 0;
        if (minutesPlayed === 0) return;

        const key = normalize(apiName) + "|" + normalize(teamName);
        const matchedPlayer = playerIndex.get(key);
        if (!matchedPlayer) return;

        const rating = stats.games && stats.games.rating ? Number(stats.games.rating) : 0;
        const goals = (stats.goals && stats.goals.total) || 0;
        const assists = (stats.goals && stats.goals.assists) || 0;
        const pos = matchedPlayer.pos;
        const cleanSheetEligible = ["GK", "DEF", "MID"].includes(pos);
        const cleanSheet = cleanSheetEligible && concededZero;

        // If a player appears in multiple fixtures within the same date
        // range (shouldn't normally happen in a single gameweek, but just
        // in case), this keeps a running total rather than overwriting.
        const prior = updates[matchedPlayer.id] || { rating: 0, goals: 0, assists: 0, cleanSheet: false };
        updates[matchedPlayer.id] = {
          rating: rating || prior.rating,
          goals: prior.goals + goals,
          assists: prior.assists + assists,
          cleanSheet: prior.cleanSheet || cleanSheet,
        };
      });
    });
  }

  console.log(`Matched ${Object.keys(updates).length} of your drafted/pooled players to finished-match stats.`);
  await patchGameweek(GW, updates);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
