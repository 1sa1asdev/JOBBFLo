import { pool } from './db.js';

// ------------------------------------------------------------
// The platform's own settings — what the operator decides for everyone
// (platform_settings, migration 054). Changed on the admin page only;
// read wherever the platform spends.
// ------------------------------------------------------------

const STANDARD = {
  // Embedding new ads and rebuilding query vectors: the operator's spend.
  embeddings_enabled: true,
  // The OpenRouter models users may pick, per job (src/modeller.js).
  // null: the standard list there.
  llm_modeller: null,
};

export async function plattformsinställning(key) {
  const { rows: [r] } = await pool.query(`SELECT value FROM platform_settings WHERE key = $1`, [key]);
  return r ? r.value : STANDARD[key];
}

export async function sättPlattformsinställning(key, value, userId) {
  if (!(key in STANDARD)) throw new Error(`okänd plattformsinställning: ${key}`);
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2::jsonb, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(),
       updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), userId || null]);
}

export const embeddingsPåslagna = async () => Boolean(await plattformsinställning('embeddings_enabled'));
