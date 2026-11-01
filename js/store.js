// Persistence for win-probability history and the scoring log.
// localStorage can be unavailable or throw (private windows, blocked storage);
// every access is guarded and the page works without it, just without memory.

const PREFIX = 'ffv1:';
const RUN_CAP = 5000;
const LOG_CAP = 500;

/**
 * Upper bound on silence between samples before it counts as a gap, whatever
 * the poll interval was. The slowest poll interval is 15 minutes.
 */
export const GAP_MS = 45 * 60e3;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: keep running without persistence */
  }
}

// ---------- win-probability runs ----------
// A run is [startT, lastSeenT, wpPermille, myScore, oppScore, gapBefore]: one
// value held across consecutive polls. Storing runs (not every poll) keeps a
// week small. gapBefore = 1 marks that the page was not watching just before
// this run started, so the graph must not connect it to the previous run.

/**
 * Pure: extend the last run if nothing changed, otherwise start a new one.
 * maxSilence is the longest quiet spell that still counts as continuous
 * watching; callers derive it from the poll interval they actually scheduled.
 */
export function appendRun(runs, now, wp, my, opp, maxSilence = GAP_MS) {
  const w = Math.round(wp * 1000);
  const last = runs[runs.length - 1];
  if (last && now <= last[1]) return runs; // clock went backwards; ignore
  const gap = !!last && now - last[1] > Math.min(maxSilence, GAP_MS);
  if (last && !gap && last[2] === w && last[3] === my && last[4] === opp) {
    last[1] = now;
  } else {
    runs.push(gap ? [now, now, w, my, opp, 1] : [now, now, w, my, opp]);
  }
  if (runs.length > RUN_CAP) runs.splice(0, runs.length - RUN_CAP);
  return runs;
}

/** Pure: does the page have no observation between the previous run and this one? */
export function startsAfterGap(prev, run) {
  return !prev || run[5] === 1 || run[0] - prev[1] > GAP_MS;
}

/** Pure: split runs into continuously observed chunks. */
export function chunks(runs) {
  const out = [];
  runs.forEach((run, i) => {
    if (startsAfterGap(runs[i - 1], run)) out.push([run]);
    else out[out.length - 1].push(run);
  });
  return out;
}

/** Pure: time intervals the page actually observed, as [[start, end], ...]. */
export function coverage(runs) {
  return chunks(runs).map((c) => [c[0][0], c[c.length - 1][1]]);
}

export function isCovered(intervals, T) {
  return intervals.some(([a, b]) => T >= a && T <= b);
}

const runKey = (season, week, leagueId) => `runs:${season}:${week}:${leagueId}`;

export function loadRuns(season, week, leagueId) {
  const runs = read(runKey(season, week, leagueId), []);
  return Array.isArray(runs) ? runs : [];
}

export function saveRuns(season, week, leagueId, runs) {
  write(runKey(season, week, leagueId), runs);
}

// ---------- scoring log ----------

export function loadLog() {
  const log = read('log', []);
  return Array.isArray(log) ? log : [];
}

export function saveLog(log) {
  write('log', log.slice(-LOG_CAP));
}

// ---------- housekeeping ----------

/** Drop history from other seasons and from weeks before last week. */
export function prune(season, week) {
  const keep = (s, w) => String(s) === String(season) && Number(w) >= week - 1;
  try {
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFIX + 'runs:')) continue;
      const [, , s, w] = key.split(':');
      if (!keep(s, w)) stale.push(key);
    }
    stale.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
  saveLog(loadLog().filter((e) => keep(e.season, e.week)));
}
