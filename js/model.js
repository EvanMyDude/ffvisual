// Pure functions: league scoring, game clock, live projection, win probability,
// and the compressed "game time" axis used by the win-probability graph.
// Nothing in here touches the network or the DOM, so it is unit-tested in test/.

const HOUR = 3600e3;
export const GAME_WINDOW_MS = 3.5 * HOUR; // typical kickoff-to-final span
const MERGE_GAP_MS = 1 * HOUR; // windows closer than this become one segment

// ---------- scoring ----------

/** Fantasy points for a stat line under a league's scoring_settings. */
export function scorePoints(stats, scoring) {
  if (!stats || !scoring) return 0;
  let total = 0;
  for (const key in stats) {
    const weight = scoring[key];
    const value = stats[key];
    if (weight && typeof value === 'number') total += weight * value;
  }
  return Math.round(total * 100) / 100;
}

// ---------- game clock ----------

/** Normalize a game object from Sleeper's scores feed. */
export function normalizeGame(raw) {
  const m = raw.metadata || {};
  const start = Number(raw.start_time) || Date.parse(m.date_time) || null;
  let status = 'pre';
  if (m.canceled) status = 'final';
  else if (raw.status === 'complete' || m.is_over) status = 'final';
  else if (raw.status === 'in_game' || m.is_in_progress) status = 'live';
  return {
    id: String(raw.game_id),
    home: m.home_team || null,
    away: m.away_team || null,
    start,
    status,
    canceled: !!m.canceled,
    remaining: remainingFraction(status, m.quarter_num, m.time_remaining),
  };
}

/** Share of a game (0..1) still to be played. */
export function remainingFraction(status, quarterNum, timeRemaining) {
  if (status === 'final') return 0;
  if (status === 'pre') return 1;
  const q = Number(quarterNum) || 1;
  const [mm, ss] = String(timeRemaining || '15:00').split(':').map(Number);
  const clock = (Number.isFinite(mm) ? mm : 15) + (Number.isFinite(ss) ? ss : 0) / 60;
  // Regular-season overtime is a single 10-minute period; its clock alone is what is left.
  const minutesLeft = q >= 5 ? clock : (4 - q) * 15 + clock;
  return clamp(minutesLeft / 60, 0, 1);
}

// ---------- live projection & win probability ----------

/**
 * Standard deviation of a player's full-game score given their projection.
 * Fantasy scoring is right-skewed and noisy; 2*sqrt(p)+1 lands near observed
 * spreads (WR proj 12 -> ~7.9, QB proj 20 -> ~9.9, K proj 8 -> ~6.7).
 */
export function playerSd(projection) {
  return 2 * Math.sqrt(Math.max(projection, 0)) + 1;
}

/**
 * Evaluate one fantasy team.
 * players: [{ actual, proj, remaining }] where remaining is the share of that
 * player's game left (0 when final, on bye, or unknown).
 */
export function evaluateTeam(players) {
  let projected = 0;
  let variance = 0;
  for (const p of players) {
    const r = clamp(p.remaining ?? 0, 0, 1);
    const proj = Math.max(p.proj ?? 0, 0);
    projected += (p.actual ?? 0) + proj * r;
    // Remaining uncertainty shrinks with the clock (Brownian scaling).
    variance += playerSd(proj) ** 2 * r;
  }
  return { projected, variance };
}

/** P(my team finishes ahead), normal approximation on the projected margin. */
export function winProbability(mine, theirs) {
  const mu = mine.projected - theirs.projected;
  const variance = mine.variance + theirs.variance;
  if (variance < 1e-9) return mu > 0.005 ? 1 : mu < -0.005 ? 0 : 0.5;
  return normCdf(mu / Math.sqrt(variance));
}

/**
 * Evaluate a team as it stood at time T, for reconstructing history.
 * Valid only at a moment when no game is in progress: games that kicked off
 * before T are final (actual points), later games have not started (projection).
 * players: [{ actual, proj, gameStart }] with gameStart null for bye/unknown.
 */
export function evaluateTeamAt(players, T) {
  return evaluateTeam(players.map((p) => {
    if (p.gameStart == null) return { actual: p.actual, proj: 0, remaining: 0 };
    if (p.gameStart < T) return { actual: p.actual, proj: p.proj, remaining: 0 };
    return { actual: 0, proj: p.proj, remaining: 1 };
  }));
}

/** Abramowitz-Stegun 7.1.26 erf approximation (|error| < 1.5e-7). */
export function normCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

// ---------- compressed week axis ----------

/**
 * Merge the week's game windows into segments of "football time".
 * Dead time between windows (Fri, Sat, overnight) is collapsed so Sunday's
 * swings get the width they deserve.
 */
export function buildWeekAxis(games, now) {
  const windows = games
    .filter((g) => g.start && !g.canceled)
    .map((g) => {
      let end = g.start + GAME_WINDOW_MS;
      // Long or overtime games keep their window open while still live.
      if (g.status === 'live') end = Math.max(end, now + 5 * 60e3);
      return { start: g.start, end, final: g.status === 'final' };
    })
    .sort((a, b) => a.start - b.start);

  const segments = [];
  for (const w of windows) {
    const last = segments[segments.length - 1];
    if (last && w.start - last.end < MERGE_GAP_MS) {
      last.end = Math.max(last.end, w.end);
      last.final = last.final && w.final;
    } else {
      segments.push({ ...w });
    }
  }
  const total = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  return { segments, total };
}

/**
 * Map a timestamp to 0..1 along the compressed axis, given a gutter (as a
 * fraction of width) between segments. Time in dead zones maps to the start
 * of the next segment; time after the last segment maps to 1.
 */
export function axisPosition(axis, t, gutterFrac = 0) {
  const { segments, total } = axis;
  if (!segments.length || total <= 0) return 0;
  const usable = 1 - gutterFrac * (segments.length - 1);
  let offset = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const width = ((s.end - s.start) / total) * usable;
    if (t < s.start) return offset;
    if (t <= s.end) return offset + ((t - s.start) / (s.end - s.start)) * width;
    offset += width + (i < segments.length - 1 ? gutterFrac : 0);
  }
  return 1;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
