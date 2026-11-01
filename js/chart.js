// Win-probability graph: one SVG per matchup card.
// x = compressed football time across the week, y = my estimated win %.
// Area above 50% is tinted "me", below is tinted "opponent". Time the page was
// not watching is drawn as a hatched gap, never as an interpolated line.

import { axisPosition } from './model.js';
import { GAP_MS, coverage, chunks as splitChunks } from './store.js';
import { fmtDayTime, fmtPoints } from './format.js';

let uid = 0;
const PAD = { top: 10, right: 34, bottom: 24, left: 2 };
const GUTTER_PX = 14;
const MAJOR_EVENT = 5; // points; TD-sized plays get a dot on the line

export function createWpChart(container) {
  const id = `wp${++uid}`;
  container.classList.add('wpc');
  container.innerHTML = `
    <svg class="wpc-svg" aria-hidden="true">
      <defs>
        <linearGradient id="${id}-gme" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="wpc-stop-me" stop-opacity="0.34"/>
          <stop offset="1" class="wpc-stop-me" stop-opacity="0.02"/>
        </linearGradient>
        <linearGradient id="${id}-gopp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="wpc-stop-opp" stop-opacity="0.02"/>
          <stop offset="1" class="wpc-stop-opp" stop-opacity="0.34"/>
        </linearGradient>
        <pattern id="${id}-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" class="wpc-hatch-line"/>
        </pattern>
        <clipPath id="${id}-above"><rect class="wpc-clip-above"/></clipPath>
        <clipPath id="${id}-below"><rect class="wpc-clip-below"/></clipPath>
      </defs>
      <g class="wpc-static"></g>
      <g class="wpc-now"><circle class="wpc-now-ring" r="9"/><circle class="wpc-now-dot" r="4.5"/></g>
      <line class="wpc-cross" y1="0" y2="0" x1="0" x2="0" />
    </svg>
    <div class="wpc-tip" hidden></div>`;

  const svg = container.querySelector('svg');
  const staticLayer = svg.querySelector('.wpc-static');
  const nowLayer = svg.querySelector('.wpc-now');
  const cross = svg.querySelector('.wpc-cross');
  const tip = container.querySelector('.wpc-tip');
  let data = null;
  let size = { w: 0, h: 0 };
  let hoverIndex = []; // [{x, y, html}] for tooltips
  let gapsPx = []; // [{x0, x1}]
  let nowPlaced = false;

  const ro = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    if (Math.abs(width - size.w) < 1 && Math.abs(height - size.h) < 1) return;
    size = { w: width, h: height };
    nowPlaced = false;
    draw();
  });
  ro.observe(container);

  function draw() {
    if (!data || size.w < 40 || size.h < 40) return;
    const { w, h } = size;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);

    const plotW = w - PAD.left - PAD.right;
    const plotH = h - PAD.top - PAD.bottom;
    const y0 = PAD.top;
    const yMid = y0 + plotH / 2;
    const yBot = y0 + plotH;
    const { axis, runs, now, events, checkpoints, kickoffs, live } = data;
    const gutterFrac = axis.segments.length > 1 ? GUTTER_PX / plotW : 0;
    const X = (t) => PAD.left + axisPosition(axis, t, gutterFrac) * plotW;
    const Y = (permille) => y0 + (1 - permille / 1000) * plotH;

    svg.querySelector('.wpc-clip-above').setAttribute('x', 0);
    svg.querySelector('.wpc-clip-above').setAttribute('y', 0);
    svg.querySelector('.wpc-clip-above').setAttribute('width', w);
    svg.querySelector('.wpc-clip-above').setAttribute('height', yMid);
    svg.querySelector('.wpc-clip-below').setAttribute('x', 0);
    svg.querySelector('.wpc-clip-below').setAttribute('y', yMid);
    svg.querySelector('.wpc-clip-below').setAttribute('width', w);
    svg.querySelector('.wpc-clip-below').setAttribute('height', h - yMid);

    const parts = [];

    // Segment bands: each block is a stretch of football (Thu night, Sunday, Monday night).
    for (const seg of axis.segments) {
      const xa = X(seg.start);
      const xb = X(seg.end);
      parts.push(`<rect class="wpc-band" x="${xa}" y="${y0}" width="${Math.max(xb - xa, 1)}" height="${plotH}" rx="3"/>`);
    }

    // Kickoff labels along the bottom: "SUN 1PM", then "4PM", "8PM" within a segment.
    let lastLabelEnd = -Infinity;
    let lastDay = '';
    for (const k of kickoffs) {
      const x = X(k);
      const d = new Date(k);
      const day = d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
      const hr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        .replace(':00', '').replace(/\s?([AP])M/i, '$1');
      const label = day !== lastDay ? `${day} ${hr}` : hr;
      const width = label.length * 6.4;
      if (x < lastLabelEnd + 10 || x + width > PAD.left + plotW + PAD.right) continue;
      parts.push(`<line class="wpc-tick" x1="${x}" x2="${x}" y1="${yBot}" y2="${yBot + 4}"/>`);
      parts.push(`<text class="wpc-xlabel${day !== lastDay ? ' wpc-xlabel--day' : ''}" x="${x}" y="${h - 6}">${label}</text>`);
      lastLabelEnd = x + width;
      lastDay = day;
    }

    // Y reference: faint 0/100 rails, a dashed 50% midline, tiny right-edge labels.
    parts.push(`<line class="wpc-rail" x1="${PAD.left}" x2="${PAD.left + plotW}" y1="${y0}" y2="${y0}"/>`);
    parts.push(`<line class="wpc-rail" x1="${PAD.left}" x2="${PAD.left + plotW}" y1="${yBot}" y2="${yBot}"/>`);
    parts.push(`<line class="wpc-mid" x1="${PAD.left}" x2="${PAD.left + plotW}" y1="${yMid}" y2="${yMid}"/>`);
    parts.push(`<text class="wpc-ylabel" x="${w - 2}" y="${y0 + 4}">100</text>`);
    parts.push(`<text class="wpc-ylabel" x="${w - 2}" y="${yMid + 4}">50</text>`);
    parts.push(`<text class="wpc-ylabel" x="${w - 2}" y="${yBot + 3}">0</text>`);

    // Split runs into observed chunks; anything between chunks is a gap.
    const chunks = splitChunks(runs);

    gapsPx = [];
    const axisStart = axis.segments[0]?.start ?? now;
    const addGap = (ta, tb) => {
      const xa = X(ta);
      const xb = X(tb);
      if (xb - xa < 3) return; // the gap fell in dead time; nothing was missed
      gapsPx.push({ x0: xa, x1: xb });
      parts.push(`<rect class="wpc-gap" x="${xa}" y="${y0}" width="${xb - xa}" height="${plotH}" fill="url(#${id}-hatch)"/>`);
      if (xb - xa > 70) parts.push(`<text class="wpc-gap-label" x="${(xa + xb) / 2}" y="${y0 + 14}">NOT WATCHING</text>`);
    };
    if (!chunks.length) {
      if (now > axisStart) addGap(axisStart, now);
    } else {
      if (chunks[0][0][0] - axisStart > GAP_MS) addGap(axisStart, chunks[0][0][0]);
      for (let i = 1; i < chunks.length; i++) {
        const prevChunk = chunks[i - 1];
        addGap(prevChunk[prevChunk.length - 1][1], chunks[i][0][0]);
      }
    }

    // Line + area per chunk.
    hoverIndex = [];
    for (const chunk of chunks) {
      const pts = [];
      for (const [t, t2, wp, my, opp] of chunk) {
        const xa = X(t);
        const xb = X(t2);
        pts.push([xa, Y(wp)]);
        if (xb - xa > 0.5) pts.push([xb, Y(wp)]);
        hoverIndex.push({ x: xb, y: Y(wp), t: t2, html: tipHtml(t2, wp, my, opp) });
      }
      const p = thin(pts);
      const line = monotonePath(p);
      const first = p[0];
      const last = p[p.length - 1];
      if (p.length > 1 && last[0] - first[0] >= 2) {
        const area = `${line}L${last[0]},${yMid}L${first[0]},${yMid}Z`;
        parts.push(`<path class="wpc-area" d="${area}" fill="url(#${id}-gme)" clip-path="url(#${id}-above)"/>`);
        parts.push(`<path class="wpc-area" d="${area}" fill="url(#${id}-gopp)" clip-path="url(#${id}-below)"/>`);
      }
      if (p.length > 1) {
        parts.push(`<path class="wpc-line wpc-line--me" d="${line}" clip-path="url(#${id}-above)"/>`);
        parts.push(`<path class="wpc-line wpc-line--opp" d="${line}" clip-path="url(#${id}-below)"/>`);
      }
    }

    // Reconstructed checkpoints inside gaps: hollow, unconnected, explained on hover.
    const cov = coverage(runs);
    for (const c of checkpoints) {
      if (cov.some(([a, b]) => c.t >= a && c.t <= b)) continue;
      const x = X(c.t);
      const y = Y(Math.round(c.wp * 1000));
      parts.push(`<circle class="wpc-checkpoint" cx="${x}" cy="${y}" r="4"/>`);
      hoverIndex.push({
        x, y, t: c.t,
        html: `${tipHtml(c.t, Math.round(c.wp * 1000), c.my, c.opp)}<div class="wpc-tip-note">${c.t < (axis.segments[0]?.start ?? 0) ? 'Reconstructed pregame estimate' : 'Reconstructed after these games went final'}</div>`,
      });
    }

    // Major scoring plays as small dots on the line.
    for (const e of events) {
      if (e.delta < MAJOR_EVENT) continue;
      // Events are logged on the same poll that records a run, so they sit inside one.
      const run = runs.find((r) => e.t >= r[0] && e.t <= r[1]);
      if (!run) continue;
      parts.push(`<circle class="wpc-event wpc-event--${e.side}" cx="${X(e.t)}" cy="${Y(run[2])}" r="3"/>`);
    }

    staticLayer.innerHTML = parts.join('');
    hoverIndex.sort((a, b) => a.x - b.x);

    // Current value: a persistent dot that glides to its new position.
    const lastRun = runs[runs.length - 1];
    if (lastRun && now - lastRun[1] <= GAP_MS) {
      nowLayer.style.display = '';
      nowLayer.classList.toggle('is-live', !!live);
      nowLayer.classList.toggle('is-me', lastRun[2] >= 500);
      nowLayer.classList.toggle('no-anim', !nowPlaced);
      nowLayer.style.transform = `translate(${X(lastRun[1])}px, ${Y(lastRun[2])}px)`;
      nowPlaced = true;
      // Re-enable the glide after this frame.
      requestAnimationFrame(() => nowLayer.classList.remove('no-anim'));
    } else {
      nowLayer.style.display = 'none';
    }
    cross.setAttribute('y1', y0);
    cross.setAttribute('y2', yBot);
  }

  // ---------- hover ----------
  svg.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const gap = gapsPx.find((g) => x >= g.x0 && x <= g.x1);
    let html = null;
    let cx = x;
    let nearest = null;
    for (const p of hoverIndex) {
      if (!nearest || Math.abs(p.x - x) < Math.abs(nearest.x - x)) nearest = p;
    }
    if (nearest && Math.abs(nearest.x - x) <= 14) {
      html = nearest.html;
      cx = nearest.x;
    } else if (gap) {
      html = '<div class="wpc-tip-note">Page was closed or offline here, so there is no data.</div>';
    }
    if (!html) return hideTip();
    tip.innerHTML = html;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(cx - tw / 2, 0), size.w - tw)}px`;
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.classList.add('is-on');
  });
  svg.addEventListener('pointerleave', hideTip);
  function hideTip() {
    tip.hidden = true;
    cross.classList.remove('is-on');
  }

  return {
    update(next) {
      data = next;
      draw();
    },
    destroy() {
      ro.disconnect();
    },
  };
}

function tipHtml(t, permille, my, opp) {
  return `<div class="wpc-tip-time">${fmtDayTime(t)}</div>` +
    `<div class="wpc-tip-row"><b>${(permille / 10).toFixed(permille % 10 ? 1 : 0)}%</b> est. win</div>` +
    (my != null ? `<div class="wpc-tip-row">${fmtPoints(my)} – ${fmtPoints(opp)}</div>` : '');
}

/** Keep at most two points per 0.75px column (first and last), so a dense day
 *  stays light while vertical jumps keep both ends. */
function thin(pts) {
  const out = [];
  let bucket = null;
  let first = null;
  let last = null;
  const flush = () => {
    if (!first) return;
    out.push(first);
    if (last !== first && last[1] !== first[1]) out.push([Math.max(last[0], first[0] + 0.01), last[1]]);
  };
  for (const p of pts) {
    const b = Math.floor(p[0] / 0.75);
    if (b !== bucket) {
      flush();
      bucket = b;
      first = p;
    }
    last = p;
  }
  flush();
  return out;
}

/** Monotone cubic interpolation (Fritsch-Carlson, as in d3.curveMonotoneX). */
export function monotonePath(pts) {
  const n = pts.length;
  if (n === 0) return '';
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const r = (v) => Math.round(v * 100) / 100;
  const secant = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    secant.push(dx > 0 ? (pts[i + 1][1] - pts[i][1]) / dx : 0);
  }
  const tangent = new Array(n);
  tangent[0] = secant[0];
  tangent[n - 1] = secant[n - 2];
  for (let i = 1; i < n - 1; i++) {
    const s0 = secant[i - 1];
    const s1 = secant[i];
    if (s0 * s1 <= 0) tangent[i] = 0;
    else {
      const h0 = pts[i][0] - pts[i - 1][0];
      const h1 = pts[i + 1][0] - pts[i][0];
      const p = (s0 * h1 + s1 * h0) / (h0 + h1);
      tangent[i] = Math.sign(s0) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) * 2;
    }
  }
  let d = `M${r(pts[0][0])},${r(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const dx = (x1 - x0) / 3;
    d += `C${r(x0 + dx)},${r(y0 + tangent[i] * dx)},${r(x1 - dx)},${r(y1 - tangent[i + 1] * dx)},${r(x1)},${r(y1)}`;
  }
  return d;
}
