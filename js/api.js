// Thin fetch layer over Sleeper's public API.
// `api.sleeper.app/v1` endpoints are documented; `api.sleeper.com` endpoints
// (game clock, projections) are undocumented and treated as optional.

const V1 = 'https://api.sleeper.app/v1';
const UNDOC = 'https://api.sleeper.com';

async function getJSON(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // no-cache: always revalidate so we see Sleeper's CDN refresh, not a stale browser copy.
    const res = await fetch(url, { cache: 'no-cache', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Fantasy positions to request projections for, expanded from roster slots.
const SLOT_POSITIONS = {
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
};

export function positionsForLeagues(leagues) {
  const set = new Set();
  for (const l of leagues) {
    for (const slot of l.roster_positions || []) {
      if (slot === 'BN' || slot === 'IR' || slot === 'TAXI') continue;
      for (const p of SLOT_POSITIONS[slot] || [slot]) set.add(p);
    }
  }
  return [...set];
}

export const sleeper = {
  state: () => getJSON(`${V1}/state/nfl`),
  user: (username) => getJSON(`${V1}/user/${encodeURIComponent(username)}`),
  leagues: (userId, season) => getJSON(`${V1}/user/${userId}/leagues/nfl/${season}`),
  leagueUsers: (leagueId) => getJSON(`${V1}/league/${leagueId}/users`),
  rosters: (leagueId) => getJSON(`${V1}/league/${leagueId}/rosters`),
  matchups: (leagueId, week) => getJSON(`${V1}/league/${leagueId}/matchups/${week}`),
  // ~5 MB; only used as a name fallback when the projections feed is down.
  players: () => getJSON(`${V1}/players/nfl`, 60000),

  // Undocumented.
  games: (seasonType, season, week) => getJSON(`${UNDOC}/scores/nfl/${seasonType}/${season}/${week}`),
  projections: (season, week, seasonType, positions) =>
    getJSON(
      `${UNDOC}/projections/nfl/${season}/${week}?season_type=${seasonType}` +
        positions.map((p) => `&position[]=${encodeURIComponent(p)}`).join(''),
      30000,
    ),
};

export function avatarUrl(user) {
  const custom = user?.metadata?.avatar;
  if (custom && /^https:\/\//.test(custom)) return custom;
  return user?.avatar ? `https://sleepercdn.com/avatars/thumbs/${user.avatar}` : null;
}
