import { pool } from './db.js';
import { embedConfig } from './embed.js';
import { embeddingCoverage } from './refresh.js';
import { embeddingsPåslagna } from './platform.js';
import { openrouterKredit } from './openrouterCredit.js';
import { modellista, NIVÅER, NIVÅNAMN } from './modeller.js';
import { priceTable } from './prices.js';

// ------------------------------------------------------------
// What the operator sees: the platform's own spend and health, and the
// users — counts and costs, never their content. A CV, a letter or a
// mail thread is the user's; nothing here selects one.
// ------------------------------------------------------------

// One ad embedded, measured on the current provider (OpenAI
// text-embedding-3-small via OpenRouter, 768 dims).
const KOSTNAD_PER_ANNONS = 0.0000125;

// The models users may pick on OpenRouter, per job: each with its price
// and how many users have it as their choice — a count, not who.
export async function modellöversikt() {
  const [lista, priser, { rows }] = await Promise.all([
    modellista({ färsk: true }),
    priceTable(),
    pool.query(
      `SELECT llm_model_fast AS fast, llm_model_bulk AS bulk, llm_model_write AS write, llm_model_smart AS smart
       FROM profile WHERE llm_provider = 'openrouter'`),
  ]);
  const förstaModell = (v) => String(v || '').split(',')[0].trim();
  const perMiljon = (n) => (Number.isFinite(n) ? Math.round(n * 1e6 * 100) / 100 : null);
  return Object.fromEntries(NIVÅER.map((n) => [n, {
    namn: NIVÅNAMN[n],
    modeller: lista[n].map((id) => ({
      id,
      in: perMiljon(priser.get(id)?.prompt),
      ut: perMiljon(priser.get(id)?.completion),
      // null when OpenRouter's catalogue could not be read just now
      finns: priser.size ? priser.has(id) : null,
      användare: rows.filter((r) => förstaModell(r[n]) === id).length,
    })),
  }]));
}

export async function översikt() {
  const cfg = embedConfig();
  const [täckning, påslagna, kredit, pool_, takt, tillstånd, användare, spend] = await Promise.all([
    embeddingCoverage(),
    embeddingsPåslagna(),
    // The platform's key: the only bill the operator carries.
    cfg.provider === 'openrouter' ? openrouterKredit(cfg.key) : null,
    pool.query(
      `SELECT count(*) FILTER (WHERE removed_at IS NULL AND (deadline IS NULL OR deadline >= current_date))::int AS öppna,
              count(*)::int AS totalt
       FROM ads`),
    pool.query(
      `SELECT count(*)::int AS nya FROM ads WHERE created_at > now() - interval '24 hours'`),
    pool.query(
      `SELECT key, last_run_at, note FROM poll_state
       WHERE key IN ('jobstream', 'janitor_snapshot', 'janitor_snapshot_fel', 'janitor_sweep', 'imap_worker_alive')`),
    pool.query(
      `SELECT count(*)::int AS totalt,
              count(*) FILTER (WHERE role = 'admin')::int AS admin,
              count(*) FILTER (WHERE disabled_at IS NOT NULL)::int AS spärrade,
              count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS nya_veckan
       FROM users`),
    pool.query(
      `SELECT coalesce(sum(usd), 0)::float AS usd, count(DISTINCT profile_id)::int AS profiler
       FROM llm_usage WHERE at > now() - interval '30 days'`),
  ]);
  const { rows: fel } = await pool.query(
    `SELECT källa, väg, metod, meddelande, count(*)::int AS antal, max(at) AS senast
     FROM error_log WHERE at > now() - interval '7 days'
     GROUP BY källa, väg, metod, meddelande ORDER BY max(at) DESC LIMIT 25`);
  const st = Object.fromEntries(tillstånd.rows.map((r) => [r.key, r]));
  const kvar = Math.max(0, täckning.total - täckning.embedded);
  const sedan = (k) => (st[k]?.last_run_at ? Math.round((Date.now() - new Date(st[k].last_run_at)) / 1000) : null);
  return {
    modeller: await modellöversikt(),
    plattformsnyckel: { satt: Boolean(cfg.key), kredit },
    embeddings: {
      påslagna,
      leverantör: cfg.provider,
      modell: cfg.model,
      ...täckning,
      kvar,
      kvarUsd: Math.ceil(kvar * KOSTNAD_PER_ANNONS * 100) / 100,
      helaPoolenUsd: Math.ceil(täckning.total * KOSTNAD_PER_ANNONS * 100) / 100,
    },
    pool: { ...pool_.rows[0], nyaDygnet: takt.rows[0].nya },
    worker: {
      senastLevande: st.imap_worker_alive?.last_run_at || null,
      sekunderSedan: sedan('imap_worker_alive'),
      jobstream: { senast: st.jobstream?.last_run_at || null, sekunderSedan: sedan('jobstream') },
      ögonblicksbild: { senast: st.janitor_snapshot?.last_run_at || null, not: st.janitor_snapshot?.note || null },
      ögonblicksbildFel: st.janitor_snapshot_fel
        ? { senast: st.janitor_snapshot_fel.last_run_at, not: st.janitor_snapshot_fel.note } : null,
      städning: { senast: st.janitor_sweep?.last_run_at || null, not: st.janitor_sweep?.note || null },
    },
    användare: användare.rows[0],
    användarnasKostnad30d: spend.rows[0],
    // Uncaught errors, grouped, last 7 days (error_log).
    fel,
  };
}

// Every account, with what it costs and does — not what it says.
export async function användarlista() {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.role, u.created_at, u.disabled_at,
            u.auth_id IS NOT NULL AS google,
            p.id AS profile_id, p.name,
            p.gmail_verified_at IS NOT NULL AS gmail, p.gmail_error,
            coalesce(k.usd, 0)::float AS kostnad_30d,
            k.senast AS senast_aktiv,
            coalesce(a.skickade, 0)::int AS skickade,
            coalesce(c.kampanjer, 0)::int AS aktiva_kampanjer
     FROM users u
     LEFT JOIN profile p ON p.user_id = u.id
     LEFT JOIN LATERAL (SELECT sum(usd) AS usd, max(at) AS senast FROM llm_usage
                        WHERE profile_id = p.id AND at > now() - interval '30 days') k ON true
     LEFT JOIN LATERAL (SELECT count(*) AS skickade FROM applications
                        WHERE profile_id = p.id AND sent_at IS NOT NULL) a ON true
     LEFT JOIN LATERAL (SELECT count(*) AS kampanjer FROM searches
                        WHERE profile_id = p.id AND auto_apply_enabled AND deleted_at IS NULL) c ON true
     ORDER BY u.created_at DESC`);
  return rows;
}

// ------------------------------------------------------------
// Blocking. Sign-in is refused at once (src/auth.js), the mailbox closes
// at the manager's next comparison, and every running campaign is
// paused with the reason — a blocked account must not keep sending.
// Unblocking only lets them back in: their campaigns stay paused until
// they start them themselves.
// ------------------------------------------------------------
// av: the admin's own profile id. Compared by profile, not by account:
// without login there is no account id, and the operator is still the
// one profile there is.
export async function sättSpärr(userId, spärrad, { av }) {
  const { rows: [själv] } = await pool.query(
    `SELECT 1 FROM profile WHERE user_id = $1 AND id = $2`, [userId, av]);
  if (själv) throw Object.assign(new Error('du kan inte spärra ditt eget konto'), { status: 400 });
  const klient = await pool.connect();
  try {
    await klient.query('BEGIN');
    const { rows: [u] } = await klient.query(
      `UPDATE users SET disabled_at = CASE WHEN $2 THEN COALESCE(disabled_at, now()) ELSE NULL END
       WHERE id = $1 RETURNING id, disabled_at`, [userId, Boolean(spärrad)]);
    if (!u) throw Object.assign(new Error('kontot finns inte'), { status: 404 });
    if (spärrad) {
      await klient.query(
        `UPDATE searches s SET auto_apply_enabled = false,
           auto_apply_paused_reason = 'Kontot är spärrat av administratören.'
         FROM profile p WHERE p.id = s.profile_id AND p.user_id = $1 AND s.auto_apply_enabled`, [userId]);
    }
    await klient.query('COMMIT');
    return u;
  } catch (err) {
    await klient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    klient.release();
  }
}
