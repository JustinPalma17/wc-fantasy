/**
 * update-scores.js
 * --------------------------------------------------------------
 * Pulls live World Cup match data from API-Football and writes
 * player stats (rating, goals, assists, cleanSheet) straight into
 * the same Firebase Realtime Database path your fantasy site reads
 * from. No changes needed to your front-end — it just sees the
 * numbers appear in the Gameweek Stats tab as if you'd typed them.
 *
 * Run with: node update-scores.js
 * Requires env vars: API_FOOTBALL_KEY, FIREBASE_DB_URL
 * Optional env var: CURRENT_GW (defaults to 1)
 * --------------------------------------------------------------
 */

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const DATA_PATH = "wc_fantasy_league_v1";
const CURRENT_GW = process.env.CURRENT_GW || "1";

// World Cup league id in API-Football. Double-check this once you have
// a key by calling: https://v3.football.api-sports.io/leagues?name=World%20Cup
const LEAGUE_ID = 1;
const SEASON = 2026;

if (!API_FOOTBALL_KEY || !FIREBASE_DB_URL) {
  console.error("Missing API_FOOTBALL_KEY or FIREBASE_DB_URL env vars.");
  process.exit(1);
}

const API_BASE = "https://v3.football.api-sports.io";

function apiHeaders() {
  return { "x-apisports-key": API_FOOTBALL_KEY };
}

function normalize(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ""); // strip punctuation/spaces
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

// PATCH only merges at this node's immediate children, so this updates
// individual playerIds inside the gameweek without touching anyone else's
// existing stats, or any other part of the database (managers, players, etc).
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
  console.log("Fetching current player/manager data from Firebase...");
  const state = await fetchCurrentState();
  const playerIndex = buildPlayerIndex(state.players);

  console.log("Checking for live World Cup fixtures...");
  const liveFixtures = await apiGet(
    `/fixtures?league=${LEAGUE_ID}&season=${SEASON}&live=all`
  );

  if (liveFixtures.length === 0) {
    console.log("No live fixtures right now. Nothing to update.");
    return;
  }

  console.log(`Found ${liveFixtures.length} live fixture(s).`);

  const updates = {};

  for (const fixture of liveFixtures) {
    const fixtureId = fixture.fixture.id;
    const statusShort = fixture.fixture.status.short; // e.g. "1H","2H","FT"
    const isFinished = statusShort === "FT" || statusShort === "AET" || statusShort === "PEN";

    const homeTeamName = fixture.teams.home.name;
    const awayTeamName = fixture.teams.away.name;
    const homeGoals = fixture.goals.home ?? 0;
    const awayGoals = fixture.goals.away ?? 0;

    console.log(`Fetching player stats for fixture ${fixtureId} (${homeTeamName} vs ${awayTeamName})...`);
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
        if (minutesPlayed === 0) return; // didn't play, skip

        const key = normalize(apiName) + "|" + normalize(teamName);
        const matchedPlayer = playerIndex.get(key);
        if (!matchedPlayer) return; // not in your player pool, skip

        const rating = stats.games && stats.games.rating ? Number(stats.games.rating) : 0;
        const goals = (stats.goals && stats.goals.total) || 0;
        const assists = (stats.goals && stats.goals.assists) || 0;
        const pos = matchedPlayer.pos;
        const cleanSheetEligible = ["GK", "DEF", "MID"].includes(pos);
        // Only mark clean sheet once the match has actually finished,
        // so it doesn't flip back and forth mid-match.
        const cleanSheet = isFinished && cleanSheetEligible && concededZero;

        updates[matchedPlayer.id] = {
          rating: Number.isFinite(rating) ? rating : 0,
          goals,
          assists,
          cleanSheet,
        };
      });
    });
  }

  console.log(`Matched ${Object.keys(updates).length} of your drafted/pooled players to live stats.`);
  await patchGameweek(CURRENT_GW, updates);
}

main().catch((err) => {
  console.error("Update failed:", err);
  process.exit(1);
});
