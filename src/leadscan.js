// ------------------------------------------------------------
// Finding the person behind an ad.
//
// Most link-only ads point at an ATS built to replace email, so a naive
// read of the application page finds nothing. But several of them name
// the recruiter on a page of their own and link to it — Teamtailor does
// this on 77 of one campaign's ads alone — and that page carries a
// mailto. Two steps, not one:
//
//   job page  ->  <meta property="article:author"> -> /people/…
//   person page ->  mailto: + name + job title
//
// The author tag is the reliable route. A Teamtailor job page also lists
// "Colleagues" further down, so picking the first /people/ link by
// position would return a random co-worker rather than the recruiter.
//
// One hop, only ever to a page the ad itself pointed at, and only when
// the user asks for that ad. Nothing is followed beyond that, nothing is
// indexed, and nothing is mailed on what comes back: it is a suggestion
// with a name and a role attached so the user can judge it.
// ------------------------------------------------------------

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// Things that look like addresses but are not people: tracking, tooling,
// asset filenames, and the placeholder domains that turn up in markup.
const JUNK = /(sentry|wixpress|example\.|\.png$|\.jpg$|\.jpeg$|\.gif$|\.webp$|@2x|schema\.org|w3\.org|domain\.com|yourdomain|sentry\.io|googleapis|cloudflare|jsdelivr|gravatar)/i;

// A shared inbox is worth offering, but a named person is worth more — a
// letter to martina.nunes@ is read by Martina, one to info@ by whoever
// is on duty.
// Page furniture that is never a contact, not even a poor one. A cookie
// banner's GDPR notice is not a shared inbox you might write to as a
// fallback — it is a legal address for data requests, and offering it
// implies a usefulness it does not have. Of 21 Teamtailor ads that
// yielded "a shared inbox", 16 were exactly this: dataprotection@ eight
// times, privacy@ eight. Those ads have no contact, and saying so is
// more use than a suggestion that wastes a letter.
const NEVER = /^(privacy|dataprotection|data\.protection|gdpr|dpo|legal|abuse|security|webmaster|noreply|no-reply)@/i;

// Two kinds of non-person here, and both matter. Shared inboxes are the
// obvious ones. The second kind cost a real miss: a Teamtailor footer
// carries a GDPR notice, so dataprotection@ and privacy@ were returned
// as "named contacts" for two employers — they have no dot and are not
// obviously generic, yet nobody there is hiring anyone.
const GENERIC = new RegExp(
  '^(' + [
    // shared inboxes
    'info', 'hello', 'hej', 'kontakt', 'contact', 'support', 'careers?',
    'jobb?', 'jobs', 'rekrytering', 'recruitment', 'hr', 'noreply',
    'no-reply', 'post', 'mail', 'office', 'admin', 'webmaster',
    // functions that appear in page furniture, never a hiring manager
    'privacy', 'dataprotection', 'data\\.protection', 'gdpr', 'dpo',
    'legal', 'press', 'media', 'invoice', 'faktura', 'ekonomi',
    'security', 'abuse', 'billing', 'sales', 'marketing',
  ].join('|') + ')@', 'i');

// Sites this app must not read programmatically. CLAUDE.md says LinkedIn
// and Academic Work are paste-in only because their terms forbid it — a
// rule about how ads get IN that applies just as much to reading an
// address OUT.
const FORBIDDEN = [
  ['linkedin.com', 'LinkedIn'],
  ['academicwork.se', 'Academic Work'],
  ['indeed.com', 'Indeed'],
  ['glassdoor.', 'Glassdoor'],
  ['blocket.se', 'Blocket'],
];

export function normaliseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

export function blockedBy(url) {
  const host = (normaliseUrl(url) || '').toLowerCase();
  const hit = FORBIDDEN.find(([d]) => host.includes(d));
  return hit ? hit[1] : null;
}

// One page per host at a time, and never twice within a second. A user
// working down a list of a thousand is not a crawl, but from the other
// end it can look exactly like one.
const lastFetch = new Map();
const MIN_GAP_MS = 1000;

async function getHtml(url, timeoutMs) {
  const host = new URL(url).host;
  const since = Date.now() - (lastFetch.get(host) || 0);
  if (since < MIN_GAP_MS) await new Promise((r) => setTimeout(r, MIN_GAP_MS - since));
  lastFetch.set(host, Date.now());

  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      // Identifies the app rather than pretending to be a person.
      'user-agent': 'Mozilla/5.0 (compatible; jobbflo/1.0; +lead-finder)',
      accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`sidan svarade ${res.status}`);
  return res.text();
}

function emailsIn(html) {
  const seen = new Set();
  const keep = (list) => list.filter((e) => {
    const v = e.toLowerCase();
    if (JUNK.test(v) || seen.has(v)) return false;
    seen.add(v);
    return true;
  }).map((e) => e.toLowerCase());

  // A mailto is an address someone put there deliberately, so it
  // outranks one that merely appears in the text.
  const mailto = keep([...html.matchAll(/mailto:([^"'?>\s]+)/gi)].map((m) => m[1]));
  const text = keep(html.match(EMAIL_RE) || []);
  const rank = (a, b) => {
    const g = (GENERIC.test(a) ? 1 : 0) - (GENERIC.test(b) ? 1 : 0);
    if (g) return g;
    const d = (a.split('@')[0].includes('.') ? 0 : 1) - (b.split('@')[0].includes('.') ? 0 : 1);
    return d || a.localeCompare(b);
  };
  return [...mailto.sort(rank), ...text.sort(rank)];
}

const attr = (html, re) => (html.match(re) || [])[1] || null;

// The recruiter's own page, per the ad's structured metadata. Falls back
// to a /people/ link only when it appears BEFORE the Colleagues heading,
// since everything after it is co-workers rather than the contact.
function recruiterPage(html, base) {
  const author = attr(html,
    /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)["']/i)
    || attr(html,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:author["']/i);
  if (author && /\/people\//i.test(author)) return new URL(author, base).href;

  const cutoff = html.search(/>\s*Colleagues\s*</i);
  const head = cutoff > 0 ? html.slice(0, cutoff) : html;
  const link = attr(head, /href=["']([^"']*\/people\/[^"']+)["']/i);
  return link ? new URL(link, base).href : null;
}

export async function scanForEmails(url, { timeoutMs = 15000 } = {}) {
  const target = normaliseUrl(url);
  if (!target) return { ok: false, reason: 'ingen länk' };

  const blocked = blockedBy(target);
  if (blocked) {
    return {
      ok: false,
      blocked,
      reason: `${blocked} tillåter inte att sidan läses automatiskt — öppna länken och kopiera adressen själv.`,
    };
  }

  let html;
  try { html = await getHtml(target, timeoutMs); }
  catch (err) {
    return { ok: false, reason: `kunde inte hämta sidan (${String(err?.message || err).slice(0, 60)})` };
  }
  const host = new URL(target).host;

  // Step one: the ad page itself. Only addresses that look like a
  // PERSON are kept — the point of this feature is the individual
  // responsible for the hire, and a letter to info@ or careers@ lands in
  // the same shared queue the ATS was built to feed. A shared inbox is
  // offered only if the search turns up nothing else at all.
  const onAd = emailsIn(html).filter((e) => !NEVER.test(e));
  const contacts = onAd
    .filter((e) => !GENERIC.test(e))
    .map((email) => ({ email, via: 'annonssidan' }));

  // Step two: the named recruiter, when the ad points at one.
  const person = recruiterPage(html, target);
  if (person && !blockedBy(person)) {
    try {
      const phtml = await getHtml(person, timeoutMs);
      // "Martina Nunes - Sales Talent Acquisition Specialist - Teamtailor"
      const title = (attr(phtml, /<title[^>]*>([^<]+)</i) || '').trim();
      const [name, role] = title.split(/\s+[-–|]\s+/);
      for (const email of emailsIn(phtml)) {
        if (contacts.some((c) => c.email === email)) continue;
        contacts.unshift({
          email,
          name: name?.trim() || null,
          role: role?.trim() || null,
          via: 'kontaktsidan',
          url: person,
        });
      }
    } catch { /* the ad page's own findings still stand */ }
  }

  if (contacts.length) return { ok: true, contacts, host };

  // Nothing named anywhere. A shared inbox is better than giving up, but
  // it is offered as the fallback it is rather than mixed in with people.
  const shared = onAd.filter((e) => GENERIC.test(e));
  return shared.length
    ? { ok: true, host, onlyShared: true, contacts: shared.map((email) => ({ email, via: 'delad inkorg' })) }
    : { ok: false, reason: 'ingen kontaktperson på sidan', host };
}
