import { pool } from './db.js';

// ------------------------------------------------------------
// Contacts already in the ad text.
//
// 7265 of 26641 unaddressed ads carry an email in the description
// Arbetsförmedlingen already gave us — 27% of the pool, reachable with
// no network request, no scraping and no terms-of-service question. It
// is strictly better than reading the page, so it runs first and the
// scraper only handles what is left.
//
// The Swedish public sector makes this delicate. Their ads list the
// fackliga företrädare beside the hiring manager, every time:
//
//   veronica.rendo@igp.uu.se  saco-s@uu.se  seko@uadm.uu.se  ofr@uu.se
//
// Three of those four are union representatives. Sending a job
// application to the union would not merely fail, it would be
// embarrassing — so they are excluded by name, and every remaining
// candidate is offered for the user to choose between rather than one
// being picked for them.
// ------------------------------------------------------------

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Union branches, as they appear in Swedish public-sector ads.
const UNION = /^(saco|seko|ofr|st|kommunal|vision|vardforbundet|vårdförbundet|lararforbundet|lärarförbundet|naturvetarna|unionen|akademikerforbundet|ledarna|sveriges[a-z]*|fack|forhandling|förhandling)\b/i;

// The union is not always in the local part. "af.kronan@sverigesfarmaceuter.se"
// reads like a person at the employer until you notice the domain
// belongs to Sveriges Farmaceuter — a union, offered as the contact for
// Kronans Apotek's own vacancy. Caught in a sample of twelve, which is
// how often this happens.
const UNION_DOMAIN = /(sverigesfarmaceuter|sverigesingenjorer|sverigesingenjörer|saco\.|seko\.|kommunal\.se|vision\.se|unionen\.se|vardforbundet|vårdförbundet|lararforbundet|lärarförbundet|naturvetarna|akademssr|dik\.se|jusek|civilekonomerna|st\.org|ledarna\.se|fackforbund)/i;

// Function addresses and page furniture — nobody there is hiring.
const NOT_A_PERSON = /^(info|hello|hej|kontakt|contact|support|careers?|jobb?|jobs|ansokan|ansökan|rekrytering|recruitment|hr|noreply|no-reply|post|mail|office|admin|webmaster|privacy|dataprotection|gdpr|dpo|legal|press|media|invoice|faktura|ekonomi|security|abuse|billing|sales|marketing|kundtjanst|kundtjänst|registrator|diarium)\b/i;

// Tooling that turns up inside ad HTML but is not the employer.
const VENDOR = /(recright|sentry|wixpress|example\.|schema\.org|w3\.org|googleapis|cloudflare|jsdelivr|gravatar|teamtailor\.com$|varbi\.com$|reachmee)/i;

export function contactsInText(text) {
  const all = [...new Set((String(text || '').match(EMAIL_RE) || []).map((e) => e.toLowerCase()))]
    .filter((e) => !/\.(png|jpe?g|svg|gif|webp)$/i.test(e))
    .filter((e) => !VENDOR.test(e))
    // Never a contact, not even a fallback: a GDPR address is for data
    // requests, and offering it implies a usefulness it does not have.
    .filter((e) => !/^(privacy|dataprotection|gdpr|dpo|legal|abuse|security)@/i.test(e));

  const local = (e) => e.split('@')[0];
  const isUnion = (e) => UNION.test(local(e)) || UNION_DOMAIN.test(e);
  const named = all.filter((e) => !isUnion(e) && !NOT_A_PERSON.test(local(e)));
  const shared = all.filter((e) => !isUnion(e) && NOT_A_PERSON.test(local(e)));

  // A dot in the local part is the strongest signal of firstname.lastname
  const rank = (a, b) =>
    (local(a).includes('.') ? 0 : 1) - (local(b).includes('.') ? 0 : 1) || a.localeCompare(b);

  return {
    contacts: named.sort(rank).map((email) => ({ email, via: 'annonstexten' })),
    shared: shared.sort(rank).map((email) => ({ email, via: 'delad inkorg' })),
    unions: all.filter(isUnion).length,
  };
}

// Fills lead_scans from text alone. Writes no address the campaign can
// use: ads.apply_email is still only ever set by the user confirming.
export async function extractFromText({ searchId = null, limit = 100000 } = {}) {
  const { rows } = await pool.query(
    `SELECT a.id, a.description
     FROM ads a
     ${searchId ? 'JOIN match_results m ON m.ad_id = a.id AND m.search_id = $2' : ''}
     LEFT JOIN lead_scans ls ON ls.ad_id = a.id
     WHERE a.apply_email IS NULL
       AND a.removed_at IS NULL
       AND ls.ad_id IS NULL
       AND a.description ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}'
     LIMIT $1`,
    searchId ? [limit, searchId] : [limit]
  );

  let named = 0; let onlyShared = 0; let none = 0;
  for (const ad of rows) {
    const r = contactsInText(ad.description);
    const list = r.contacts.length ? r.contacts : r.shared;
    if (r.contacts.length) named += 1;
    else if (r.shared.length) onlyShared += 1;
    else { none += 1; continue; }

    await pool.query(
      `INSERT INTO lead_scans (ad_id, ok, contacts, only_shared, reason, host)
       VALUES ($1, true, $2::jsonb, $3, null, 'annonstexten')
       ON CONFLICT (ad_id) DO NOTHING`,
      [ad.id, JSON.stringify(list), r.contacts.length === 0]
    );
  }
  return { scanned: rows.length, named, onlyShared, none };
}
