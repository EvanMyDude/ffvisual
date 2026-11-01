// Checks js/model.js scorePoints() against Sleeper's own numbers: for every
// starter in every matchup of the user's leagues this week, apply the league's
// scoring_settings to the player's raw stat line and compare with the
// starters_points Sleeper reports. Run with `make verify-scoring`.
//
// The stats feed and the (CDN-cached, up to a few minutes stale) matchups feed
// update independently, so players in games still in progress can differ by a
// few yards. Only players whose games are final (or not started) count as
// failures; in-progress differences are reported for information.
import { scorePoints, normalizeGame } from '../js/model.js';

const username = process.argv[2] || 'evanestes';
const V1 = 'https://api.sleeper.app/v1';
const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

const state = await get(`${V1}/state/nfl`);
const { season, week, season_type: seasonType } = state;
const user = await get(`${V1}/user/${username}`);
const leagues = (await get(`${V1}/user/${user.user_id}/leagues/nfl/${season}`))
  .filter((l) => l.status === 'in_season' || l.status === 'post_season');

const stats = await get(`https://api.sleeper.com/stats/nfl/${season}/${week}?season_type=${seasonType}` +
  ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((p) => `&position[]=${p}`).join(''));
const statsById = new Map(stats.map((s) => [String(s.player_id), s.stats]));
const teamById = new Map(stats.map((s) => [String(s.player_id), s.team || s.player?.team]));
const games = (await get(`https://api.sleeper.com/scores/nfl/${seasonType}/${season}/${week}`)).map(normalizeGame);
const liveTeams = new Set(games.filter((g) => g.status === 'live').flatMap((g) => [g.home, g.away]));

let checked = 0;
let mismatches = 0;
let inFlux = 0;
for (const league of leagues) {
  const matchups = await get(`${V1}/league/${league.league_id}/matchups/${week}`);
  for (const m of matchups) {
    m.starters.forEach((pid, i) => {
      if (pid === '0') return;
      const expected = m.starters_points[i] ?? 0;
      const actual = scorePoints(statsById.get(String(pid)) || {}, league.scoring_settings);
      checked++;
      if (Math.abs(actual - expected) > 0.011) {
        const live = liveTeams.has(teamById.get(String(pid)) || pid);
        if (live) inFlux++;
        else mismatches++;
        console.log(`${live ? 'in-progress' : 'MISMATCH'} ${league.name} pid=${pid}: computed ${actual} vs sleeper ${expected}`);
      }
    });
  }
}
console.log(`week ${week}: ${checked} starters checked, ${mismatches} mismatches in settled games, ${inFlux} in-progress differences (feed timing)`);
process.exit(mismatches ? 1 : 0);
