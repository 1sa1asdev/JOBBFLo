import { randomUUID } from 'node:crypto';

// ------------------------------------------------------------
// One user's history, moved from one Jobbflo database into their
// account in another — the local install into the hosted one.
//
// Not a dump and restore: the cloud already holds other users and its
// own ad pool, so this moves ONE profile's rows into ONE existing
// account, and nothing else.
//
//   - What is the user's is found by walking the foreign keys from the
//     profile (searches, applications, mail, checklists, reads, …), so a
//     table added later moves too.
//   - Every row gets a NEW id. A moved row can therefore only point at
//     rows moved with it, the target profile, or the shared ad pool —
//     never into anyone else's.
//   - Ads are matched in the target's pool by (source, external_id);
//     those it lacks (closed long ago) are added, a private ad becomes
//     the target profile's.
//   - Encrypted secrets and vectors stay behind: secrets are encrypted
//     with the source's key, vectors are recomputed.
//   - Campaigns arrive PAUSED. A campaign running in two databases sends
//     two letters to the same employer; the user restarts it in the cloud
//     once the local one is off.
//
// Only into an account with no searches or applications yet, and only
// between databases on the same migration.
// ------------------------------------------------------------

// Candidates nobody looked at are left behind: the cloud's own scan finds
// them again, and moving them would drag thousands of ads along.
const RADFILTER = {
  match_results: 'AND (t.score IS NOT NULL OR t.shortlisted_at IS NOT NULL OR t.score_requested_at IS NOT NULL)',
};
// Per-run state, not history.
const UTESLUTNA = new Set(['users', 'profile', 'ads', 'imap_sync_requests', 'rate_limits',
  'platform_settings', 'error_log', 'lead_scans', 'poll_state', 'schema_migrations', 'taxonomy_vectors']);
// What of the profile row itself does not move: identity, the account
// link, secrets, and state that belongs to the target.
const PROFIL_STANNAR = /^(id|user_id|email|created_at|updated_at|onboarded_at|gmail_verified_at|gmail_error|gmail_error_at)$|_enc$/;

const citera = (namn) => `"${String(namn).replace(/"/g, '""')}"`;

async function schemaversion(db) {
  const { rows: [r] } = await db.query(`SELECT max(version) AS v FROM schema_migrations`);
  return r?.v || null;
}

// Columns, their types, and every single-column foreign key.
async function karta(db) {
  const { rows: kolumner } = await db.query(
    `SELECT c.relname AS tabell, a.attname AS kolumn, t.typname AS typ, a.attnotnull AS krävs
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_type t ON t.oid = a.atttypid
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attgenerated = ''
     ORDER BY c.relname, a.attnum`);
  const { rows: fk } = await db.query(
    `SELECT src.relname AS tabell, a.attname AS kolumn, dst.relname AS mot
     FROM pg_constraint c JOIN pg_class src ON src.oid = c.conrelid
     JOIN pg_class dst ON dst.oid = c.confrelid
     JOIN pg_namespace n ON n.oid = src.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND n.nspname = 'public' AND array_length(c.conkey, 1) = 1`);
  const per = {};
  for (const k of kolumner) (per[k.tabell] ||= { kolumner: [], fk: {} }).kolumner.push(k);
  for (const f of fk) if (per[f.tabell]) per[f.tabell].fk[f.kolumn] = f.mot;
  return per;
}

// Tables that belong to a user: a foreign key to the profile, or to a
// table that does — in an order where every parent comes first.
function ägdaTabeller(per) {
  const ägda = new Set();
  let ändrat = true;
  while (ändrat) {
    ändrat = false;
    for (const [t, info] of Object.entries(per)) {
      if (ägda.has(t) || UTESLUTNA.has(t)) continue;
      if (Object.values(info.fk).some((mot) => mot === 'profile' || ägda.has(mot))) { ägda.add(t); ändrat = true; }
    }
  }
  const ordning = [];
  const besökt = new Set();
  const besök = (t) => {
    if (besökt.has(t)) return;
    besökt.add(t);
    for (const mot of Object.values(per[t].fk)) if (ägda.has(mot) && mot !== t) besök(mot);
    ordning.push(t);
  };
  [...ägda].sort().forEach(besök);
  return ordning;
}

const harId = (info) => info.kolumner.some((k) => k.kolumn === 'id' && k.typ === 'uuid');

function värdeFör(k, v) {
  if (v == null) return null;
  if (k.typ === 'vector' || /_enc$/.test(k.kolumn)) return null;
  if (k.typ === 'jsonb' || k.typ === 'json') return JSON.stringify(v);
  return v;
}

async function infoga(db, tabell, kolumner, rader) {
  const STEG = Math.max(1, Math.floor(30000 / Math.max(1, kolumner.length)));
  for (let i = 0; i < rader.length; i += Math.min(STEG, 200)) {
    const del = rader.slice(i, i + Math.min(STEG, 200));
    const params = [];
    const values = del.map((rad) => `(${kolumner.map((k) => {
      params.push(värdeFör(k, rad[k.kolumn]));
      return `$${params.length}${k.typ === 'jsonb' ? '::jsonb' : ''}`;
    }).join(', ')})`);
    await db.query(
      `INSERT INTO public.${citera(tabell)} (${kolumner.map((k) => citera(k.kolumn)).join(', ')})
       VALUES ${values.join(', ')}`, params);
  }
}

export async function flyttaHistorik({ från, till, frånProfil, tillProfil, logg = () => {} }) {
  const [vFrån, vTill] = await Promise.all([schemaversion(från), schemaversion(till)]);
  if (vFrån !== vTill) {
    throw new Error(`databaserna är på olika migrationer (${vFrån} och ${vTill}) — uppdatera den äldre först`);
  }
  const { rows: [mål] } = await till.query(
    `SELECT (SELECT count(*) FROM searches WHERE profile_id = $1)::int
          + (SELECT count(*) FROM applications WHERE profile_id = $1)::int AS n,
            EXISTS (SELECT 1 FROM profile WHERE id = $1) AS finns`, [tillProfil]);
  if (!mål?.finns) throw new Error('målkontot finns inte — logga in i molnappen en gång först');
  if (mål.n > 0) throw new Error('målkontot har redan sökningar eller ansökningar — flytten görs bara till ett nytt konto');

  const per = await karta(från);
  const ordning = ägdaTabeller(per);

  // ---- read everything that is the source profile's, consistently ----
  await från.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const lästa = {};
  const gamlaId = { profile: new Set([frånProfil]) };
  try {
    for (const t of ordning) {
      const info = per[t];
      const villkor = Object.entries(info.fk)
        .filter(([, mot]) => mot === 'profile' || gamlaId[mot])
        .map(([kol, mot]) => `t.${citera(kol)} = ANY($${mot === 'profile' ? 1 : 2}::uuid[])`);
      if (!villkor.length) continue;
      // A table that points at the profile AND at a parent (attachments by
      // profile and by search) belongs by either.
      const ids = [...new Set(Object.entries(info.fk).filter(([, mot]) => mot !== 'profile' && gamlaId[mot])
        .flatMap(([, mot]) => [...gamlaId[mot]]))];
      // Both parameters are always typed in the query, whichever the
      // conditions use, so the statement binds the same two every time.
      const { rows } = await från.query(
        `SELECT t.* FROM public.${citera(t)} t
         WHERE $1::uuid[] IS NOT NULL AND $2::uuid[] IS NOT NULL
           AND (${villkor.join(' OR ')}) ${RADFILTER[t] || ''}`,
        [[frånProfil], ids]);
      lästa[t] = rows;
      if (harId(info)) gamlaId[t] = new Set(rows.map((r) => r.id));
    }
    const { rows: [profil] } = await från.query(`SELECT * FROM profile WHERE id = $1`, [frånProfil]);
    lästa.profile = profil;

    // The ads the history points at, and the profile's private ones.
    const adId = new Set();
    for (const t of ordning) {
      const adKol = Object.entries(per[t].fk).filter(([, mot]) => mot === 'ads').map(([k]) => k);
      for (const r of lästa[t] || []) for (const k of adKol) if (r[k]) adId.add(r[k]);
    }
    const { rows: annonser } = await från.query(
      `SELECT * FROM ads WHERE id = ANY($1::uuid[]) OR owner_profile_id = $2`, [[...adId], frånProfil]);
    lästa.ads = annonser;
  } finally {
    await från.query('COMMIT').catch(() => {});
  }

  // ---- write it into the target, all or nothing ----
  const nya = { profile: new Map([[frånProfil, tillProfil]]), ads: new Map() };
  const räkning = {};
  await till.query('BEGIN');
  try {
    // Ads: the target's own copy when it has one, else a new row.
    const nycklar = lästa.ads.filter((a) => a.external_id);
    const { rows: finns } = nycklar.length ? await till.query(
      `SELECT id, source, external_id FROM ads
       WHERE (source, external_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
      [nycklar.map((a) => a.source), nycklar.map((a) => a.external_id)]) : { rows: [] };
    const iMål = new Map(finns.map((a) => [`${a.source}\u0000${a.external_id}`, a.id]));
    const nyaAnnonser = [];
    for (const a of lästa.ads) {
      const träff = a.external_id && iMål.get(`${a.source}\u0000${a.external_id}`);
      if (träff && !a.owner_profile_id) { nya.ads.set(a.id, träff); continue; }
      const id = randomUUID();
      nya.ads.set(a.id, id);
      nyaAnnonser.push({ ...a, id, owner_profile_id: a.owner_profile_id ? tillProfil : null,
        // a private ad's key must not collide with the source's copy
        external_id: träff ? `${a.external_id}-flyttad-${id.slice(0, 8)}` : a.external_id });
    }
    await infoga(till, 'ads', per.ads.kolumner, nyaAnnonser);
    räkning.ads = { matchade: lästa.ads.length - nyaAnnonser.length, tillagda: nyaAnnonser.length };

    const självref = [];
    for (const t of ordning) {
      const info = per[t];
      const rader = [];
      let hoppade = 0;
      nya[t] ||= new Map();
      for (const r of lästa[t] || []) {
        const ny = { ...r };
        if (harId(info)) { ny.id = randomUUID(); nya[t].set(r.id, ny.id); }
        let ok = true;
        for (const [kol, mot] of Object.entries(info.fk)) {
          if (r[kol] == null) continue;
          if (mot === t) { självref.push({ t, kol, id: ny.id, gammal: r[kol] }); ny[kol] = null; continue; }
          const m = nya[mot]?.get(r[kol]);
          if (m) { ny[kol] = m; continue; }
          // Points at something that did not move (a row filtered out).
          const k = info.kolumner.find((x) => x.kolumn === kol);
          if (k?.krävs) { ok = false; break; }
          ny[kol] = null;
        }
        if (!ok) { hoppade += 1; continue; }
        // Campaigns arrive paused (see the top of the file).
        if (t === 'searches' && ny.auto_apply_enabled) {
          ny.auto_apply_enabled = false;
          ny.auto_apply_paused_reason = 'Flyttad från din lokala Jobbflo. Starta den här när den lokala är avstängd.';
        }
        rader.push(ny);
      }
      await infoga(till, t, info.kolumner, rader);
      räkning[t] = hoppade ? { flyttade: rader.length, hoppade } : rader.length;
    }
    // A row pointing at another row of its own table, once both exist.
    for (const { t, kol, id, gammal } of självref) {
      const m = nya[t].get(gammal);
      if (m) await till.query(`UPDATE public.${citera(t)} SET ${citera(kol)} = $2 WHERE id = $1`, [id, m]);
    }

    // The profile row itself: the CV and settings, onto the target's.
    const kol = per.profile.kolumner.filter((k) => !PROFIL_STANNAR.test(k.kolumn) && k.typ !== 'vector');
    const tilldelningar = kol
      .map((k, i) => `${citera(k.kolumn)} = $${i + 2}${k.typ === 'jsonb' ? '::jsonb' : ''}`)
      .join(', ');
    await till.query(
      `UPDATE profile SET ${tilldelningar}, updated_at = now() WHERE id = $1`,
      [tillProfil, ...kol.map((k) => värdeFör(k, lästa.profile[k.kolumn]))]);

    await till.query('COMMIT');
  } catch (err) {
    await till.query('ROLLBACK').catch(() => {});
    throw err;
  }
  logg(räkning);
  return räkning;
}
