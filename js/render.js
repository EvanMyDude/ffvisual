// Matchup card: built once per league, then updated in place each poll so
// numbers can tween and the graph keeps its DOM.

import { createWpChart } from './chart.js';
import { escapeHtml } from './format.js';

const ACCENT_MIN = 1.0; // points gained in one poll before the score lights up
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createCard(league) {
  const el = document.createElement('section');
  el.className = 'card';
  el.style.setProperty('--league', league.accent);
  el.innerHTML = `
    <header class="card-head">
      <div class="league"><i class="league-dot"></i><span class="league-name">${escapeHtml(league.name)}</span></div>
      <div class="status"><span class="status-week"></span><span class="status-state"><i class="status-dot"></i><span class="status-text"></span></span></div>
    </header>
    <div class="matchup">
      ${sideHtml('me')}
      ${sideHtml('opp')}
    </div>
    <div class="wp">
      <div class="wp-row">
        <span class="wp-num wp-num--me"><span class="wp-val">--</span><small>%</small></span>
        <div class="wp-mid">
          <div class="wp-bar"><i class="wp-bar-me"></i><i class="wp-bar-opp"></i></div>
          <div class="wp-label">Win probability <span class="wp-est">Estimated</span></div>
        </div>
        <span class="wp-num wp-num--opp"><span class="wp-val">--</span><small>%</small></span>
      </div>
      <div class="wp-chart"></div>
    </div>
    <p class="card-note" hidden></p>
    <div class="card-empty" hidden></div>`;

  const q = (s) => el.querySelector(s);
  const sides = { me: bindSide(el.querySelector('.side--me')), opp: bindSide(el.querySelector('.side--opp')) };
  const chart = createWpChart(q('.wp-chart'));
  const wpMe = numberTween(q('.wp-num--me .wp-val'), (v) => Math.round(v));
  const wpOpp = numberTween(q('.wp-num--opp .wp-val'), (v) => Math.round(v));

  function update(vm) {
    q('.status-week').textContent = `Week ${vm.week}`;
    const st = q('.status-state');
    st.dataset.state = vm.status.kind;
    q('.status-text').textContent = vm.status.text;

    const empty = q('.card-empty');
    const hasMatchup = !!vm.opp;
    el.classList.toggle('is-empty', !hasMatchup);
    empty.hidden = hasMatchup;
    q('.matchup').hidden = !hasMatchup;
    if (!hasMatchup) {
      empty.innerHTML = `<div class="card-empty-title">No matchup this week</div><div class="card-empty-sub">${escapeHtml(vm.me.name)} · ${escapeHtml(vm.me.record)}</div>`;
      q('.wp').hidden = true;
      q('.card-note').hidden = true;
      return;
    }

    sides.me.update(vm.me, 'me', vm.projAvailable);
    sides.opp.update(vm.opp, 'opp', vm.projAvailable);

    const wpOk = vm.wp != null;
    q('.wp').hidden = !wpOk;
    el.classList.toggle('no-wp', !wpOk);
    const note = q('.card-note');
    note.hidden = wpOk;
    note.textContent = wpOk ? '' : vm.unavailableReason;
    if (!wpOk) return;

    const pct = vm.wp * 100;
    wpMe.set(pct);
    wpOpp.set(100 - pct);
    q('.wp-bar-me').style.flexGrow = Math.max(pct, 0.0001);
    q('.wp-bar-opp').style.flexGrow = Math.max(100 - pct, 0.0001);
    q('.wp-num--me').classList.toggle('is-fav', pct >= 50);
    q('.wp-num--opp').classList.toggle('is-fav', pct < 50);
    chart.update(vm.chart);
  }

  return { el, update };
}

function sideHtml(side) {
  return `
    <div class="side side--${side}">
      <div class="team">
        <span class="avatar"><img alt="" referrerpolicy="no-referrer" hidden><span class="avatar-initials"></span></span>
        <span class="team-text"><span class="team-name"></span><span class="team-record"></span></span>
      </div>
      <div class="score" aria-live="off"><span class="score-int">0</span><span class="score-dec">.00</span></div>
      <div class="proj"><span class="proj-label">Proj</span><span class="proj-val">--</span></div>
      <div class="pips"><span class="pips-dots"></span><span class="pips-text"></span></div>
    </div>`;
}

function bindSide(root) {
  const q = (s) => root.querySelector(s);
  const img = q('.avatar img');
  const scoreEl = q('.score');
  const intEl = q('.score-int');
  const decEl = q('.score-dec');
  let avatarSrc = null;
  let bumpTimer = null;
  let lastScore = null;

  const score = numberTween(null, null, (v) => {
    const fixed = Math.max(v, -999).toFixed(2);
    const [i, d] = fixed.split('.');
    intEl.textContent = i;
    decEl.textContent = `.${d}`;
  });
  const proj = numberTween(q('.proj-val'), (v) => v.toFixed(1));

  img.addEventListener('error', () => {
    img.hidden = true;
  });

  return {
    update(team, side, projAvailable) {
      q('.team-name').textContent = team.name;
      q('.team-record').textContent = team.record;
      q('.avatar-initials').textContent = initials(team.name);
      if (team.avatar !== avatarSrc) {
        avatarSrc = team.avatar;
        img.hidden = !avatarSrc;
        if (avatarSrc) {
          img.onload = () => (img.hidden = false);
          img.src = avatarSrc;
        }
      }

      if (lastScore != null && team.score >= lastScore + ACCENT_MIN) {
        // Brief accent on the side that scored a real play, then settle back to neutral.
        // Yardage trickles (a few tenths per poll) just count up quietly.
        scoreEl.classList.remove('is-bump');
        void scoreEl.offsetWidth;
        scoreEl.classList.add('is-bump');
        clearTimeout(bumpTimer);
        bumpTimer = setTimeout(() => scoreEl.classList.remove('is-bump'), 1800);
      }
      lastScore = team.score;
      score.set(team.score);

      const projRow = q('.proj');
      projRow.hidden = !projAvailable;
      if (projAvailable) proj.set(team.projected);

      const pips = q('.pips');
      const counts = { live: 0, pre: 0, final: 0 };
      for (const p of team.players) if (counts[p.state] != null) counts[p.state]++;
      const known = counts.live + counts.pre + counts.final;
      pips.hidden = known === 0;
      if (known) {
        // Final first, then live, then yet to play: reads like a progress meter.
        const order = [...team.players].filter((p) => counts[p.state] != null)
          .sort((a, b) => rank(a.state) - rank(b.state));
        q('.pips-dots').innerHTML = order.map((p) => `<i class="pip pip--${p.state}"></i>`).join('');
        const parts = [];
        if (counts.live) parts.push(`${counts.live} live`);
        if (counts.pre) parts.push(`${counts.pre} to play`);
        if (!counts.live && !counts.pre) parts.push('all final');
        q('.pips-text').textContent = parts.join(' · ');
      }
    },
  };
}

const rank = (s) => ({ final: 0, live: 1, pre: 2 })[s] ?? 3;

function initials(name) {
  return String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join('') || '?';
}

/** Tween a number on screen with easeOutCubic. */
function numberTween(el, format, write) {
  let current = null;
  let raf = 0;
  const out = write || ((v) => (el.textContent = format(v)));
  return {
    set(target) {
      if (current == null || reduceMotion()) {
        current = target;
        out(target);
        return;
      }
      const from = current;
      if (Math.abs(target - from) < 1e-6) return;
      const start = performance.now();
      const dur = Math.min(1400, 500 + Math.abs(target - from) * 60);
      cancelAnimationFrame(raf);
      const step = (now) => {
        const k = Math.min((now - start) / dur, 1);
        const e = 1 - (1 - k) ** 3;
        current = from + (target - from) * e;
        out(current);
        if (k < 1) raf = requestAnimationFrame(step);
        else current = target;
      };
      raf = requestAnimationFrame(step);
    },
  };
}
