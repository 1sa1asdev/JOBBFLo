// ------------------------------------------------------------
// Tiny client-side fetch helper — throws on non-2xx with the API's
// message, and never has the same GET in flight twice.
//
// Two callers asking for the same thing at the same moment is the
// normal case here, not an edge: React runs every effect twice in
// development, a poll can land while a view is still loading its first
// copy, and two components legitimately want the same ad. Measured on
// one ad opening: two identical /api/ads/<id> requests, 1716ms and
// 1847ms, against a route that answers in 150ms on its own — they were
// queueing behind each other on one dev server.
//
// So identical GETs share one request while it is in flight. Nothing is
// cached after it resolves: this removes duplicates, it does not serve
// stale data, and every later call goes to the server as before.
// ------------------------------------------------------------
const pågående = new Map();

export async function api(path, opts = {}) {
  const metod = (opts.method || 'GET').toUpperCase();
  const nyckel = metod === 'GET' ? path : null;
  if (nyckel && pågående.has(nyckel)) return pågående.get(nyckel);

  const svar = (async () => {
    const res = await fetch(path, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  })();

  if (!nyckel) return svar;
  pågående.set(nyckel, svar);
  try {
    return await svar;
  } finally {
    pågående.delete(nyckel);
  }
}

export const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' }).toUpperCase() : '—';

export function daysUntil(d) {
  if (!d) return null;
  return Math.ceil((new Date(d) - Date.now()) / 86400000);
}

export function timeAgo(d) {
  if (!d) return '';
  const min = Math.floor((Date.now() - new Date(d)) / 60000);
  if (min < 1) return 'nyss';
  if (min < 60) return `${min} min sedan`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} tim sedan`;
  const days = Math.floor(h / 24);
  return `${days} ${days === 1 ? 'dag' : 'dagar'} sedan`;
}
