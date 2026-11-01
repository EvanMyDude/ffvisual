// Display formatting shared by the cards, graph, ticker and log.

/** 6.4 -> "6.4", 6.24 -> "6.24", 3 -> "3.0" */
export function fmtPoints(v) {
  const r = Math.round((v ?? 0) * 100) / 100;
  return Number.isInteger(r * 10) ? r.toFixed(1) : r.toFixed(2);
}

export function fmtDelta(v) {
  return `${v >= 0 ? '+' : '−'}${fmtPoints(Math.abs(v))}`;
}

export function fmtTime(t) {
  return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function fmtDayTime(t) {
  const d = new Date(t);
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${fmtTime(t)}`;
}

export function fmtKickoff(t) {
  const d = new Date(t);
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${fmtTime(t)}`.toUpperCase();
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
