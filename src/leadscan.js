// ------------------------------------------------------------
// Reading an application page for a contact address.
//
// Most link-only ads point at an ATS whose whole purpose is to replace
// email, so this fails more often than it succeeds — a sample of ten
// found addresses on four. That is still the difference between 1082
// unreachable ads and several hundred reachable ones, and every
// Teamtailor page in the sample named the recruiter outright.
//
// Deliberately NOT a crawler. One request, for one page, when the user
// asks for that ad — the same page they were about to open themselves.
// Nothing is followed, nothing is indexed, and nothing is mailed on the
// strength of it: what comes back is a suggestion the user confirms.
// ------------------------------------------------------------

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// Things that look like addresses but are not people: tracking, tooling,
// asset filenames, and the placeholder domains that turn up in markup.
const JUNK = /(sentry|wixpress|example\.|\.png$|\.jpg$|\.jpeg$|\.gif$|\.webp$|@2x|schema\.org|w3\.org|domain\.com|yourdomain|email\.com$|sentry\.io|googleapis|cloudflare|jsdelivr|gravatar)/i;

// A shared inbox is worth offering, but a named person is worth more —
// a letter to jessika.warvne@ is read by Jessika, one to info@ is read
// by whoever is on duty. Ordered so the better guess is offered first.
const GENERIC = /^(info|hello|hej|kontakt|contact|support|careers?|jobb?|jobs|rekrytering|recruitment|hr|noreply|no-reply|post|mail|office|admin|webmaster)@/i;

function rank(a, b) {
  const ga = GENERIC.test(a) ? 1 : 0;
  const gb = GENERIC.test(b) ? 1 : 0;
  if (ga !== gb) return ga - gb;
  // a dot in the local part usually means firstname.lastname
  const da = a.split('@')[0].includes('.') ? 0 : 1;
  const db = b.split('@')[0].includes('.') ? 0 : 1;
  if (da !== db) return da - db;
  return a.localeCompare(b);
}

// Ads carry links written by hand, and some arrive without a scheme —
// "www.netlight.com" threw "Failed to parse URL" rather than being
// fetched. Repairing it here is cheaper than a stored value nobody
// notices is broken.
export function normaliseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

export async function scanForEmails(url, { timeoutMs = 15000 } = {}) {
  const target = normaliseUrl(url);
  if (!target) return { ok: false, reason: 'ingen länk' };

  let res;
  try {
    res = await fetch(target, {
      redirect: 'follow',
      headers: {
        // Identifies the app rather than pretending to be a person, and
        // accepts html only — no point downloading a PDF to regex it.
        'user-agent': 'Mozilla/5.0 (compatible; jobbflo/1.0; +lead-finder)',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, reason: `kunde inte hämta sidan (${String(err?.message || err).slice(0, 60)})` };
  }
  if (!res.ok) return { ok: false, reason: `sidan svarade ${res.status}` };

  const html = await res.text();

  // mailto: links are an address someone put there on purpose, so they
  // outrank one that merely appears in the text.
  const mailto = [...html.matchAll(/mailto:([^"'?>\s]+)/gi)].map((m) => m[1].toLowerCase());
  const inText = (html.match(EMAIL_RE) || []).map((e) => e.toLowerCase());

  const seen = new Set();
  const keep = (list) => list.filter((e) => {
    if (JUNK.test(e) || seen.has(e)) return false;
    seen.add(e);
    return true;
  });

  const found = [...keep(mailto).sort(rank), ...keep(inText).sort(rank)];
  return found.length
    ? { ok: true, emails: found.slice(0, 6), host: new URL(target).host }
    : { ok: false, reason: 'ingen adress på sidan', host: new URL(target).host };
}
