import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scorePoints, remainingFraction, normalizeGame, evaluateTeam, evaluateTeamAt,
  winProbability, normCdf, buildWeekAxis, axisPosition, GAME_WINDOW_MS,
} from '../js/model.js';
import { appendRun, coverage, isCovered, chunks, GAP_MS } from '../js/store.js';
import { monotonePath } from '../js/chart.js';
import { fmtPoints, fmtDelta } from '../js/format.js';

const H = 3600e3;

test('scorePoints applies league weights and ignores non-scoring keys', () => {
  const scoring = { rec: 1, rec_yd: 0.1, rec_td: 6, pts_allow_21_27: 2 };
  assert.equal(scorePoints({ rec: 5, rec_yd: 64, rec_td: 1, pts_ppr: 99, gp: 1 }, scoring), 17.4);
  assert.equal(scorePoints({ pts_allow_21_27: 1 }, scoring), 2);
  assert.equal(scorePoints(null, scoring), 0);
});

test('remainingFraction follows the game clock', () => {
  assert.equal(remainingFraction('pre', '', '15:00'), 1);
  assert.equal(remainingFraction('final', 4, '00:00'), 0);
  assert.equal(remainingFraction('live', 1, '15:00'), 1);
  assert.ok(Math.abs(remainingFraction('live', 2, '14:44') - (30 + 14 + 44 / 60) / 60) < 1e-9);
  assert.equal(remainingFraction('live', 2, '0:00'), 0.5); // halftime
  assert.ok(Math.abs(remainingFraction('live', 5, '6:00') - 0.1) < 1e-9); // overtime
});

test('normalizeGame maps Sleeper statuses', () => {
  const g = normalizeGame({ game_id: 1, status: 'in_game', start_time: 1000, metadata: { home_team: 'BUF', away_team: 'BAL', quarter_num: 3, time_remaining: '7:30' } });
  assert.equal(g.status, 'live');
  assert.equal(g.home, 'BUF');
  assert.ok(Math.abs(g.remaining - 22.5 / 60) < 1e-9);
  assert.equal(normalizeGame({ status: 'complete', metadata: { is_over: true } }).status, 'final');
  assert.equal(normalizeGame({ status: 'pre_game', metadata: {} }).remaining, 1);
});

test('normCdf matches known values', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normCdf(-1) - 0.158655) < 1e-5);
});

test('win probability is symmetric and settles when games are over', () => {
  const a = evaluateTeam([{ actual: 10, proj: 15, remaining: 0.5 }]);
  const b = evaluateTeam([{ actual: 12, proj: 10, remaining: 0.5 }]);
  const p = winProbability(a, b);
  assert.ok(p > 0.5 && p < 1);
  assert.ok(Math.abs(p + winProbability(b, a) - 1) < 1e-9);
  const done = (pts) => evaluateTeam([{ actual: pts, proj: 20, remaining: 0 }]);
  assert.equal(winProbability(done(90), done(80)), 1);
  assert.equal(winProbability(done(80), done(90)), 0);
  assert.equal(winProbability(done(80), done(80)), 0.5);
});

test('a pregame 10-point projected edge is a moderate favorite', () => {
  const team = (proj) => evaluateTeam(Array.from({ length: 9 }, () => ({ actual: 0, proj: proj / 9, remaining: 1 })));
  const p = winProbability(team(115), team(105));
  assert.ok(p > 0.6 && p < 0.72, `got ${p}`);
});

test('evaluateTeamAt uses finals before T and projections after', () => {
  const players = [
    { actual: 20, proj: 15, gameStart: 0 },
    { actual: 7, proj: 12, gameStart: 10 * H },
    { actual: 3, proj: 9, gameStart: null },
  ];
  const r = evaluateTeamAt(players, 5 * H);
  assert.equal(r.projected, 20 + 12 + 3);
  assert.ok(r.variance > 0);
});

test('week axis merges overlapping windows and collapses dead time', () => {
  const thu = Date.UTC(2026, 9, 30, 0, 15);
  const sun1 = Date.UTC(2026, 10, 1, 17, 0);
  const sun4 = sun1 + 3.4 * H;
  const snf = sun1 + 7.33 * H;
  const mnf = sun1 + 31.25 * H;
  const games = [thu, sun1, sun4, snf, mnf].map((start) => ({ start, status: 'pre' }));
  const axis = buildWeekAxis(games, sun1);
  assert.equal(axis.segments.length, 3);
  assert.equal(axis.segments[1].start, sun1);
  assert.equal(axis.segments[1].end, snf + GAME_WINDOW_MS);

  assert.equal(axisPosition(axis, thu - H), 0);
  // Friday maps to the start of Sunday's segment (dead time collapses).
  const fri = thu + 24 * H;
  assert.equal(axisPosition(axis, fri), axisPosition(axis, sun1));
  assert.equal(axisPosition(axis, mnf + 10 * H), 1);
  const a = axisPosition(axis, sun1 + H);
  const b = axisPosition(axis, sun1 + 2 * H);
  assert.ok(b > a);
  // Gutters push later segments right.
  assert.ok(axisPosition(axis, sun1, 0.02) > axisPosition(axis, sun1, 0));
});

test('appendRun extends unchanged values and starts new runs on change or gap', () => {
  const runs = [];
  appendRun(runs, 0, 0.6, 10, 8);
  appendRun(runs, 30e3, 0.6, 10, 8);
  assert.deepEqual(runs, [[0, 30e3, 600, 10, 8]]);
  appendRun(runs, 60e3, 0.65, 16, 8);
  assert.equal(runs.length, 2);
  appendRun(runs, 60e3 + GAP_MS + 1, 0.65, 16, 8);
  assert.equal(runs.length, 3, 'a long silence must not be bridged');
  appendRun(runs, 10, 0.1, 0, 0);
  assert.equal(runs.length, 3, 'out-of-order samples are ignored');
});

test('a silence longer than the scheduled poll interval allows is a gap', () => {
  const runs = [];
  const live = 2 * 30e3 + 60e3; // what main.js passes while games are live
  appendRun(runs, 0, 0.6, 10, 8, live);
  appendRun(runs, 30e3, 0.6, 10, 8, live);
  appendRun(runs, 30e3 + 25 * 60e3, 0.7, 20, 8, live); // page closed for 25 minutes
  assert.equal(runs.length, 2);
  assert.equal(runs[1][5], 1);
  assert.equal(chunks(runs).length, 2);
  // Same 25 minutes on an off day (15-minute polling) is continuous.
  const quiet = [];
  appendRun(quiet, 0, 0.6, 10, 8, 2 * 15 * 60e3 + 60e3);
  appendRun(quiet, 25 * 60e3, 0.6, 10, 8, 2 * 15 * 60e3 + 60e3);
  assert.deepEqual(quiet, [[0, 25 * 60e3, 600, 10, 8]]);
});

test('coverage splits on gaps', () => {
  const runs = [[0, 60e3, 500, 0, 0], [90e3, 120e3, 510, 1, 0], [120e3 + GAP_MS + 1, 120e3 + GAP_MS + 2, 520, 2, 0]];
  const cov = coverage(runs);
  assert.equal(cov.length, 2);
  assert.ok(isCovered(cov, 100e3));
  assert.ok(!isCovered(cov, 120e3 + GAP_MS / 2));
});

test('monotonePath does not overshoot between points', () => {
  const d = monotonePath([[0, 100], [10, 100], [11, 50], [20, 50]]);
  const ys = [...d.matchAll(/[-\d.]+,([-\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(ys.every((y) => y >= 50 && y <= 100), d);
});

test('point formatting', () => {
  assert.equal(fmtPoints(6.4), '6.4');
  assert.equal(fmtPoints(6.24), '6.24');
  assert.equal(fmtPoints(3), '3.0');
  assert.equal(fmtDelta(6.4), '+6.4');
  assert.equal(fmtDelta(-2), '−2.0');
});
