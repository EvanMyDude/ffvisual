// Scoring ticker (one event at a time, queued) and the Scoring Log slide-over.

import { escapeHtml, fmtDelta, fmtTime } from './format.js';

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createTicker(host) {
  const queue = [];
  let busy = false;

  function push(events) {
    for (const e of events) {
      // Two pending updates for the same player collapse into one.
      const pending = queue.find((q) => q.leagueId === e.leagueId && q.pid === e.pid && q.side === e.side);
      if (pending) pending.delta = Math.round((pending.delta + e.delta) * 100) / 100;
      else queue.push({ ...e });
    }
    if (!busy) next();
  }

  // Shorter dwell when a burst backs up, so the ticker never falls far behind.
  const dwellFor = (backlog) => (backlog === 0 ? 4200 : backlog <= 3 ? 3000 : backlog <= 8 ? 2000 : 1300);

  async function next() {
    const e = queue.shift();
    if (!e) {
      busy = false;
      return;
    }
    busy = true;
    if (Math.abs(e.delta) < 0.05) return next();
    const el = document.createElement('div');
    el.className = `tick tick--${e.side}${e.delta < 0 ? ' tick--neg' : ''}`;
    el.style.setProperty('--league', e.accent);
    el.innerHTML =
      `<span class="tick-pts">${fmtDelta(e.delta)}</span>` +
      `<span class="tick-name">${escapeHtml(e.name)}</span>` +
      `<span class="tick-league"><i></i>${escapeHtml(e.league)}</span>` +
      `<span class="tick-tag">${e.side === 'me' ? 'You' : 'Opp'}</span>`;
    host.appendChild(el);
    const still = reduceMotion();
    await el.animate(
      still
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 0, transform: 'translateY(18px) scale(0.98)' }, { opacity: 1, transform: 'none' }],
      { duration: 460, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' },
    ).finished;
    await sleep(dwellFor(queue.length));
    await el.animate(
      still ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-10px)' }],
      { duration: 340, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' },
    ).finished;
    el.remove();
    await sleep(160);
    next();
  }

  return { push };
}

export function createLogPanel({ button, panel, getEntries }) {
  const list = panel.querySelector('.log-list');
  const backdrop = panel.querySelector('.log-backdrop');
  const close = panel.querySelector('.log-close');
  let lastFocus = null;

  function render() {
    const entries = getEntries().slice().sort((a, b) => b.t - a.t);
    if (!entries.length) {
      list.innerHTML = '<p class="log-empty">No scoring yet. Plays show up here as they happen while this page is open.</p>';
      return;
    }
    let html = '';
    let lastDay = '';
    for (const e of entries) {
      const day = new Date(e.t).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
      if (day !== lastDay) {
        html += `<h3 class="log-day">${escapeHtml(day)}</h3>`;
        lastDay = day;
      }
      html += `<div class="log-row log-row--${e.side}${e.delta < 0 ? ' log-row--neg' : ''}" style="--league:${e.accent}">
        <span class="log-pts">${fmtDelta(e.delta)}</span>
        <span class="log-main">
          <span class="log-name">${escapeHtml(e.name)}</span>
          <span class="log-meta"><b>${e.side === 'me' ? 'You' : 'Opponent'}</b> · <i></i>${escapeHtml(e.league)}</span>
        </span>
        <time class="log-time" datetime="${new Date(e.t).toISOString()}">${fmtTime(e.t)}</time>
      </div>`;
    }
    list.innerHTML = html;
  }

  function open() {
    lastFocus = document.activeElement;
    render();
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add('is-open'));
    button.setAttribute('aria-expanded', 'true');
    close.focus();
  }

  function hide() {
    panel.classList.remove('is-open');
    button.setAttribute('aria-expanded', 'false');
    setTimeout(() => {
      if (!panel.classList.contains('is-open')) panel.hidden = true;
    }, 320);
    lastFocus?.focus?.();
  }

  button.addEventListener('click', () => (panel.hidden ? open() : hide()));
  close.addEventListener('click', hide);
  backdrop.addEventListener('click', hide);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) hide();
  });

  return {
    refresh() {
      if (!panel.hidden) render();
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
