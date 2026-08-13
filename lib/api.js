// tiny client-side fetch helper — throws on non-2xx with the API's message
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
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
