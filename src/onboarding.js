import { pool } from './db.js';
import { aktivProfilId } from './auth.js';
import { inloggningsläge } from './authMode.js';

// ------------------------------------------------------------
// The first-run guide's state, read from what is actually set up rather
// than from ticks the guide keeps itself — so a step done under Profil
// counts here too.
// ------------------------------------------------------------
export async function onboardingStatus(profileId) {
  const { rows: [p] } = await pool.query(
    `SELECT name, onboarded_at,
            gmail_verified_at IS NOT NULL AS gmail,
            llm_provider IS NOT NULL AS ai,
            cv_text IS NOT NULL AS cv
     FROM profile WHERE id = $1`, [profileId]);
  return p ? { namn: p.name, klar: Boolean(p.onboarded_at), gmail: p.gmail, ai: p.ai, cv: p.cv } : null;
}

// Does the start page send this request to the guide? Never without
// login — one person on their own machine set things up long ago.
export async function behöverOnboarding() {
  if (inloggningsläge() === 'av') return false;
  const s = await onboardingStatus(await aktivProfilId());
  return Boolean(s && !s.klar);
}

export async function avslutaOnboarding(profileId) {
  await pool.query(
    `UPDATE profile SET onboarded_at = COALESCE(onboarded_at, now()), updated_at = now() WHERE id = $1`,
    [profileId]);
}
