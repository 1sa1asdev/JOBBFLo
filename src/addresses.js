import { pool } from './db.js';

// ------------------------------------------------------------
// Where a user's letter for an ad goes.
//
// Two kinds of address (migration 050): the employer's, on the shared ad
// (ads.apply_email — published by Arbetsförmedlingen, or read by the
// server off the employer's own application page), and one a user typed
// in themselves (ad_contacts), which is theirs alone.
//
// Every query that decides a recipient, counts candidates or guards
// against writing twice uses THIS expression, so the campaign, the
// "why is nothing sending" card, the company cooldown and a manual send
// can never disagree about where a letter goes — and one user's
// typed-in address can never reach another user's letters.
// ------------------------------------------------------------
export const adressFör = (ad, profil) =>
  `COALESCE((SELECT ac.email FROM ad_contacts ac
             WHERE ac.ad_id = ${ad}.id AND ac.profile_id = ${profil}), ${ad}.apply_email)`;

// Did the server itself read this address off the ad's application page?
// That is the only way an address a user hands us may become shared: it
// then comes from the employer, not from the user. The client's claim
// that it was "scanned" is not evidence.
export async function serverLästAdressen(adId, email) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM lead_scans ls, jsonb_array_elements(ls.contacts) c
     WHERE ls.ad_id = $1 AND lower(c->>'email') = lower($2)`, [adId, email]);
  return rowCount > 0;
}

// An address turned out not to work (bounced, or refused by the
// receiving server). Forget it where it came from: the user's own copy,
// and the shared one only if that is what failed — clearing the shared
// address for a typo in someone's personal one would take a working
// address away from everyone.
export async function glömAdress(adId, profileId, email) {
  const { rowCount: egen } = await pool.query(
    `DELETE FROM ad_contacts WHERE ad_id = $1 AND profile_id = $2 AND lower(email) = lower($3)`,
    [adId, profileId, email]);
  const { rowCount: delad } = await pool.query(
    `UPDATE ads SET apply_email = NULL, apply_email_source = NULL, apply_email_found_at = NULL
     WHERE id = $1 AND lower(apply_email) = lower($2)`, [adId, email]);
  return { egen: egen > 0, delad: delad > 0 };
}
