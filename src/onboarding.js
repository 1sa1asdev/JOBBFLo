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
            -- a provider without its key does nothing: after a move of
            -- history (src/flytt.js) the provider arrives and the key
            -- does not, and the guide must still ask for it
            llm_provider IS NOT NULL
              AND (llm_api_key_enc IS NOT NULL OR llm_provider IN ('ollama', 'lmstudio')) AS ai,
            cv_text IS NOT NULL AS cv
     FROM profile WHERE id = $1`, [profileId]);
  return p ? { namn: p.name, klar: Boolean(p.onboarded_at), gmail: p.gmail, ai: p.ai, cv: p.cv } : null;
}

// How far into actually using the app a user is: the "Kom igång" panel
// on Översikt (components/KomIgang.jsx) ticks its steps from these, so a
// step counts however it was done.
export async function framsteg(profileId) {
  const { rows: [r] } = await pool.query(
    `SELECT
       (SELECT count(*) FROM searches WHERE profile_id = $1 AND deleted_at IS NULL)::int AS sökningar,
       (SELECT count(*) FROM ad_checks WHERE profile_id = $1 AND score IS NOT NULL)::int AS bedömda,
       (SELECT count(*) FROM applications WHERE profile_id = $1)::int AS brev,
       (SELECT count(*) FROM applications WHERE profile_id = $1 AND sent_at IS NOT NULL)::int AS skickade`,
    [profileId]);
  return r;
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
