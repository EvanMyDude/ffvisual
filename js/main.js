// Orchestration: bootstrap from Sleeper, poll on an adaptive schedule, derive
// view models, detect scoring events, record win-probability history, render.

import { CONFIG } from './config.js';
import { sleeper, positionsForLeagues, avatarUrl } from './api.js';
import {
  scorePoints, normalizeGame, evaluateTeam, evaluateTeamAt, winProbability, buildWeekAxis,
} from './model.js';
import * as store from './store.js';
import { createCard } from './render.js';
import { createTicker, createLogPanel } from './ticker.js';
import { fmtKickoff, fmtTime } from './format.js';

const MIN = 60e3;
const LEAGUE_ACCENTS = ['#d6a64f', '#6fa4e0', '#a58bdc', '#d98a6a'];
const EVENT_THRESHOLD = 1.0; // points accumulated per player before the ticker announces it
const FRESH_MS = 10 * MIN; // a longer pause between polls rebaselines instead of announcing a burst

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

const S = {
  username: params.get('user') || CONFIG.username,
  season: null,
  week: null,
  seasonType: 'regular',
  leagues: [],
  games: [], // normalized
  gamesByTeam: new Map(),
  gamesOk: false,
  gamesAt: 0,
  proj: new Map(), // pid -> { stats, team, name }
  projOk: false,
  projAt: 0,
  projTriedAt: 0,
  players: null, // fallback name/team map from /players/nfl
  playersTried: false,
  metaAt: 0,
  stateAt: 0,
  lastCoreOk: 0,
  lastMatchupsAt: 0,
  coreFailures: 0,
  log: [],
  timer: 0,
  ticking: false,
  lastDelay: MIN, // poll interval scheduled after the previous tick
};

let ticker;
let logPanel;

// ---------- bootstrap ----------

async function boot() {
  ticker = createTicker($('#ticker'));
  logPanel = createLogPanel({ button: $('#log-btn'), panel: $('#log'), getEntries: () => S.log.filter((e) => e.week === S.week) });
  S.log = store.loadLog();
  startClock();

  try {
    const state = await sleeper.state();
    S.season = state.league_season || state.season;
    S.week = state.week;
    S.seasonType = state.season_type || 'regular';
    S.stateAt = Date.now();

    const user = await sleeper.user(S.username);
    if (!user?.user_id) return fatal(`Sleeper user “${S.username}” not found.`);

    const leagues = (await sleeper.leagues(user.user_id, S.season))
      .filter((l) => l.status === 'in_season' || l.status === 'post_season');
    if (!leagues.length || S.seasonType !== 'regular' || !S.week) {
      return fatal('No live matchups right now. This page wakes up when the season is underway.', true);
    }

    store.prune(S.season, S.week);
    S.leagues = leagues.map((l, i) => ({
      id: l.league_id,
      name: l.name,
      shortName: CONFIG.leagueShortNames[l.league_id] || l.name,
      accent: LEAGUE_ACCENTS[i % LEAGUE_ACCENTS.length],
      scoring: l.scoring_settings,
      userId: user.user_id,
      users: [],
      rosters: [],
      matchups: null,
      runs: store.loadRuns(S.season, S.week, l.league_id),
      prev: {}, // side -> Map(pid -> points) from the last poll
      carry: new Map(), // "side:pid" -> points not yet announced
      card: null,
    }));
    S.positions = positionsForLeagues(leagues);

    await refreshMeta();
    const grid = $('#grid');
    grid.innerHTML = '';
    grid.style.setProperty('--n', Math.min(S.leagues.length, 3));
    for (const lg of S.leagues) {
      lg.card = createCard(lg);
      grid.appendChild(lg.card.el);
    }
    await tick();
    scheduleNightlyReload();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - S.lastMatchupsAt > MIN) runTickNow();
    });
  } catch (err) {
    console.error(err);
    $('#boot-text').textContent = 'Can’t reach Sleeper. Retrying…';
    setTimeout(boot, 30e3);
  }
}

function fatal(message, idle = false) {
  $('#boot').hidden = false;
  $('#boot').classList.toggle('is-idle', idle);
  $('#boot-text').textContent = message;
}

// ---------- data refresh ----------

async function refreshMeta() {
  await Promise.all(S.leagues.map(async (lg) => {
    const [users, rosters] = await Promise.all([sleeper.leagueUsers(lg.id), sleeper.rosters(lg.id)]);
    lg.users = users;
    lg.rosters = rosters;
    lg.myRoster = rosters.find((r) => r.owner_id === lg.userId || (r.co_owners || []).includes(lg.userId));
  }));
  S.metaAt = Date.now();
}

async function refreshGames() {
  try {
    const raw = await sleeper.games(S.seasonType, S.season, S.week);
    if (!Array.isArray(raw) || !raw.length) throw new Error('empty game feed');
    S.games = raw.map(normalizeGame);
    S.gamesByTeam = new Map();
    for (const g of S.games) {
      if (g.home) S.gamesByTeam.set(g.home, g);
      if (g.away) S.gamesByTeam.set(g.away, g);
    }
    S.gamesOk = true;
    S.gamesAt = Date.now();
  } catch (err) {
    console.warn('game clock feed unavailable', err);
    // Keep using a recent copy briefly; beyond that, stop trusting it.
    if (Date.now() - S.gamesAt > 5 * MIN) S.gamesOk = false;
  }
}

async function refreshProjections() {
  S.projTriedAt = Date.now();
  try {
    const raw = await sleeper.projections(S.season, S.week, S.seasonType, S.positions);
    if (!Array.isArray(raw) || !raw.length) throw new Error('empty projection feed');
    const map = new Map();
    for (const r of raw) {
      const p = r.player || {};
      const isDef = p.position === 'DEF';
      map.set(String(r.player_id), {
        stats: r.stats || {},
        team: r.team || p.team || null,
        name: isDef ? `${p.last_name || r.player_id} D/ST` : [p.first_name, p.last_name].filter(Boolean).join(' '),
      });
    }
    S.proj = map;
    S.projOk = true;
    S.projAt = Date.now();
  } catch (err) {
    console.warn('projection feed unavailable', err);
    if (Date.now() - S.projAt > 2 * 3600e3) S.projOk = false;
    loadPlayersFallback();
  }
}

/** Names and teams from the documented (large) players endpoint, once per session. */
async function loadPlayersFallback() {
  if (S.playersTried) return;
  S.playersTried = true;
  try {
    const all = await sleeper.players();
    const map = new Map();
    for (const [pid, p] of Object.entries(all)) {
      const isDef = p.position === 'DEF';
      map.set(pid, {
        team: p.team || (isDef ? pid : null),
        name: isDef ? `${p.last_name || pid} D/ST` : p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' '),
      });
    }
    S.players = map;
  } catch (err) {
    console.warn('players fallback unavailable', err);
  }
}

function playerInfo(pid) {
  return S.proj.get(pid) || S.players?.get(pid) || (/^[A-Z]{2,3}$/.test(pid) ? { team: pid, name: `${pid} D/ST` } : null);
}

// ---------- poll loop ----------

function runTickNow() {
  clearTimeout(S.timer);
  tick();
}

async function tick() {
  if (S.ticking) return;
  S.ticking = true;
  const now = Date.now();
  try {
    if (now - S.stateAt > 60 * MIN) await checkWeekRollover();
    if (now - S.metaAt > 30 * MIN) await refreshMeta().catch((e) => console.warn('meta refresh failed', e));
    const projDue = S.projOk ? now - S.projAt > projectionMaxAge(now) : now - S.projTriedAt > 10 * MIN;

    const [matchupResults] = await Promise.all([
      Promise.allSettled(S.leagues.map((lg) => sleeper.matchups(lg.id, S.week))),
      refreshGames(),
      projDue ? refreshProjections() : null,
    ]);

    let anyOk = false;
    const fresh = now - S.lastMatchupsAt <= FRESH_MS;
    const newEvents = [];
    matchupResults.forEach((res, i) => {
      if (res.status !== 'fulfilled' || !Array.isArray(res.value)) return;
      anyOk = true;
      const lg = S.leagues[i];
      lg.matchups = res.value;
      newEvents.push(...detectEvents(lg, now, fresh));
    });

    if (anyOk) {
      if (!S.lastCoreOk) {
        $('#boot').hidden = true;
        document.body.classList.add('is-ready');
      }
      S.lastMatchupsAt = now;
      S.lastCoreOk = now;
      S.coreFailures = 0;
    } else {
      S.coreFailures++;
    }

    // Log events before rendering so this poll's big plays get their graph dots now.
    if (newEvents.length) {
      S.log = [...S.log, ...newEvents].slice(-500);
      store.saveLog(S.log);
    }

    // Anything quieter than two missed polls (plus slack for slow fetches and
    // background-tab timer throttling) means the page was not watching.
    const maxSilence = 2 * S.lastDelay + MIN;
    for (const lg of S.leagues) {
      if (!lg.matchups) continue;
      const vm = buildViewModel(lg, now);
      if (vm.wp != null && vm.opp) {
        store.appendRun(lg.runs, now, vm.wp, round2(vm.me.score), round2(vm.opp.score), maxSilence);
        store.saveRuns(S.season, S.week, lg.id, lg.runs);
        vm.chart.runs = lg.runs;
      }
      lg.card.update(vm);
    }

    if (newEvents.length) {
      ticker.push(newEvents);
      logPanel.refresh();
    }
  } catch (err) {
    console.error('tick failed', err);
    S.coreFailures++;
  } finally {
    S.ticking = false;
    renderSync();
    S.lastDelay = nextDelay(Date.now());
    S.timer = setTimeout(tick, S.lastDelay);
  }
}

function nextDelay(now) {
  if (S.coreFailures) return Math.min(30e3 * 2 ** (S.coreFailures - 1), 5 * MIN);
  if (!S.gamesOk) return MIN;
  if (S.games.some((g) => g.status === 'live')) return 30e3;
  const pending = S.games.filter((g) => g.status === 'pre' && g.start).map((g) => g.start).sort((a, b) => a - b);
  const next = pending[0];
  if (next == null) return 15 * MIN;
  const until = next - now;
  if (until < 20 * MIN) return MIN; // kickoff imminent (or delayed)
  if (until < 12 * 3600e3) return Math.max(MIN, Math.min(5 * MIN, until - 15 * MIN));
  return 15 * MIN;
}

/**
 * Projections (~2 MB) only matter for games that haven't kicked off: refresh
 * often on game days (inactives, late scratches), rarely otherwise, and not at
 * all once every game this week has started.
 */
function projectionMaxAge(now) {
  if (!S.gamesOk) return 30 * MIN;
  const pending = S.games.filter((g) => g.status === 'pre' && g.start);
  if (!pending.length) return Infinity;
  return pending.some((g) => g.start - now < 24 * 3600e3) ? 30 * MIN : 3 * 3600e3;
}

async function checkWeekRollover() {
  try {
    const state = await sleeper.state();
    S.stateAt = Date.now();
    const season = state.league_season || state.season;
    if (state.week !== S.week || season !== S.season) location.reload();
  } catch {
    /* try again next hour */
  }
}

/** Reload once a night (after games) to pick up new deploys and a fresh week. */
function scheduleNightlyReload() {
  const t = new Date();
  t.setHours(5, 0, 0, 0);
  if (t <= new Date()) t.setDate(t.getDate() + 1);
  setTimeout(function attempt() {
    if (S.games.some((g) => g.status === 'live')) return setTimeout(attempt, 60 * MIN);
    location.reload();
  }, t - Date.now());
}

// ---------- events ----------

function detectEvents(lg, now, fresh) {
  const events = [];
  const mine = lg.matchups.find((m) => m.roster_id === lg.myRoster?.roster_id);
  if (!mine) return events;
  const theirs = mine.matchup_id != null
    ? lg.matchups.find((m) => m.matchup_id === mine.matchup_id && m.roster_id !== mine.roster_id)
    : null;
  for (const [side, m] of [['me', mine], ['opp', theirs]]) {
    if (!m) continue;
    const cur = new Map((m.starters || []).map((pid, i) => [pid, m.starters_points?.[i] ?? 0]));
    const prev = lg.prev[side];
    if (prev && fresh) {
      for (const [pid, pts] of cur) {
        if (pid === '0' || !prev.has(pid)) continue;
        const d = pts - prev.get(pid);
        if (Math.abs(d) < 0.005) continue;
        const key = `${side}:${pid}`;
        const carry = round2((lg.carry.get(key) || 0) + d);
        if (Math.abs(carry) >= EVENT_THRESHOLD) {
          lg.carry.delete(key);
          events.push({
            t: now,
            season: S.season,
            week: S.week,
            leagueId: lg.id,
            league: lg.shortName,
            accent: lg.accent,
            side,
            pid,
            name: playerInfo(pid)?.name || 'Unknown player',
            delta: carry,
          });
        } else {
          lg.carry.set(key, carry);
        }
      }
    }
    lg.prev[side] = cur;
  }
  return events;
}

// ---------- view model ----------

function teamLabel(lg, roster) {
  const user = lg.users.find((u) => u.user_id === roster?.owner_id);
  const s = roster?.settings || {};
  const record = `${s.wins ?? 0}-${s.losses ?? 0}${s.ties ? `-${s.ties}` : ''}`;
  return {
    name: user?.metadata?.team_name || user?.display_name || `Team ${roster?.roster_id ?? ''}`,
    avatar: avatarUrl(user),
    record,
  };
}

function sidePlayers(lg, m) {
  return (m.starters || []).map((pid, i) => {
    const actual = m.starters_points?.[i] ?? 0;
    if (pid === '0') return { pid, actual: 0, proj: 0, remaining: 0, state: 'empty', gameStart: null };
    const info = playerInfo(pid);
    if (!info) loadPlayersFallback(); // e.g. a starter with no projection; next poll picks it up
    const projStats = S.proj.get(pid)?.stats;
    const proj = projStats ? scorePoints(projStats, lg.scoring) : 0;
    if (!S.gamesOk || !info) return { pid, actual, proj, remaining: 0, state: 'unknown', gameStart: null };
    if (!info.team) return { pid, actual, proj, remaining: 0, state: 'final', gameStart: null }; // free agent
    const game = S.gamesByTeam.get(info.team);
    if (!game) return { pid, actual, proj, remaining: 0, state: 'final', gameStart: null }; // bye
    return { pid, actual, proj, remaining: game.remaining, state: game.status, gameStart: game.start };
  });
}

function buildViewModel(lg, now) {
  const mine = lg.matchups.find((m) => m.roster_id === lg.myRoster?.roster_id);
  const theirs = mine?.matchup_id != null
    ? lg.matchups.find((m) => m.matchup_id === mine.matchup_id && m.roster_id !== mine.roster_id)
    : null;
  const meLabel = teamLabel(lg, lg.myRoster);
  const vm = { week: S.week, me: { ...meLabel, players: [], score: 0 }, opp: null, wp: null, projAvailable: false };

  if (!mine || !theirs) {
    vm.status = { kind: 'idle', text: '' };
    return vm;
  }
  const oppRoster = lg.rosters.find((r) => r.roster_id === theirs.roster_id);
  const total = (m) => m.custom_points ?? m.points ?? 0;
  vm.me = { ...meLabel, score: total(mine), players: sidePlayers(lg, mine) };
  vm.opp = { ...teamLabel(lg, oppRoster), score: total(theirs), players: sidePlayers(lg, theirs) };

  const projAvailable = S.gamesOk && S.projOk;
  vm.projAvailable = projAvailable;
  if (projAvailable) {
    const a = evaluateTeam(vm.me.players.map((p) => ({ ...p, actual: 0 })));
    const b = evaluateTeam(vm.opp.players.map((p) => ({ ...p, actual: 0 })));
    // Use Sleeper's official totals for the points already scored.
    const meEval = { projected: vm.me.score + a.projected, variance: a.variance };
    const oppEval = { projected: vm.opp.score + b.projected, variance: b.variance };
    vm.me.projected = meEval.projected;
    vm.opp.projected = oppEval.projected;
    vm.wp = winProbability(meEval, oppEval);
    const axis = buildWeekAxis(S.games, now);
    vm.chart = {
      axis,
      runs: lg.runs,
      now,
      live: [...vm.me.players, ...vm.opp.players].some((p) => p.state === 'live'),
      kickoffs: kickoffSlots(S.games),
      events: S.log.filter((e) => e.leagueId === lg.id && e.week === S.week),
      checkpoints: checkpoints(axis, vm, now),
    };
  } else {
    vm.unavailableReason = !S.gamesOk
      ? 'Projections and win probability are unavailable right now: Sleeper’s game-clock feed isn’t responding. Live scores are unaffected.'
      : 'Projections and win probability are unavailable right now: Sleeper’s projection feed isn’t responding. Live scores are unaffected.';
  }
  vm.status = matchupStatus(vm);
  return vm;
}

/** Win probability at the end of each completed window of games, for gaps the page missed. */
function checkpoints(axis, vm, now) {
  const out = [];
  const scoreAt = (players, T) => players.reduce((s, p) => s + (p.gameStart != null && p.gameStart < T ? p.actual : 0), 0);
  // Pregame: everyone still on projection, just before the week's first kickoff.
  const first = axis.segments[0];
  if (first && now > first.start) {
    const T = first.start - 1;
    out.push({ t: T, wp: winProbability(evaluateTeamAt(vm.me.players, T), evaluateTeamAt(vm.opp.players, T)), my: 0, opp: 0 });
  }
  for (const seg of axis.segments) {
    if (!seg.final || seg.end > now) continue;
    const T = seg.end;
    const me = evaluateTeamAt(vm.me.players, T);
    const opp = evaluateTeamAt(vm.opp.players, T);
    out.push({ t: T, wp: winProbability(me, opp), my: round2(scoreAt(vm.me.players, T)), opp: round2(scoreAt(vm.opp.players, T)) });
  }
  return out;
}

function kickoffSlots(games) {
  const starts = [...new Set(games.filter((g) => g.start && !g.canceled).map((g) => g.start))].sort((a, b) => a - b);
  return starts.filter((t, i) => i === 0 || t - starts[i - 1] > 30 * MIN);
}

function matchupStatus(vm) {
  const players = [...vm.me.players, ...vm.opp.players];
  if (!S.gamesOk) return { kind: 'idle', text: '' };
  if (players.some((p) => p.state === 'live')) return { kind: 'live', text: 'Live' };
  const upcoming = players.filter((p) => p.state === 'pre' && p.gameStart).map((p) => p.gameStart).sort((a, b) => a - b);
  if (upcoming.length) return { kind: 'pre', text: fmtKickoff(upcoming[0]) };
  if (players.some((p) => p.state === 'unknown')) return { kind: 'idle', text: '' };
  const diff = vm.me.score - vm.opp.score;
  return { kind: 'final', text: `Final · ${diff > 0 ? 'Win' : diff < 0 ? 'Loss' : 'Tie'}` };
}

// ---------- header ----------

function startClock() {
  const draw = () => {
    const d = new Date();
    $('#clock-date').textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    $('#clock-time').textContent = fmtTime(d);
  };
  draw();
  setInterval(draw, 10e3);
  setInterval(renderSync, 15e3);
}

function renderSync() {
  const el = $('#sync');
  if (!S.lastCoreOk) {
    el.dataset.state = 'warn';
    el.querySelector('.sync-text').textContent = 'Connecting…';
    return;
  }
  const stale = Date.now() - S.lastCoreOk > Math.max(3 * nextDelay(Date.now()), 3 * MIN);
  el.dataset.state = stale || S.coreFailures ? 'warn' : 'ok';
  el.querySelector('.sync-text').textContent = S.coreFailures
    ? `Reconnecting · last update ${fmtTime(S.lastCoreOk)}`
    : `Updated ${fmtTime(S.lastCoreOk)}`;
  const degraded = $('#degraded');
  degraded.hidden = S.gamesOk && S.projOk;
}

const round2 = (v) => Math.round(v * 100) / 100;

boot();
