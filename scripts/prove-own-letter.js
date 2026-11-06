// Proves a letter the user writes themselves is kept as written.
//
//   node scripts/prove-own-letter.js
//
// The letter view lets the user write before (or instead of) asking for
// a generated draft. Their words are the one input here that is theirs
// alone, so:
//
//   1. the text is stored exactly as written, as version 1 "Skrivet av dig"
//   2. an empty subject gets "Ansökan: <title>", a written one is kept
//   3. it never replaces a letter that exists — generated or their own
//   4. an empty or oversized letter is refused before anything is written
//
// No model is called. On throwaway rows, removed again.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { ownLetter, EGET_BREV_MAX } from '../src/letters.js';

const KÖRNING = `${Date.now()}`;
let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(58)}${info ? ` ${info}` : ''}`);
};
const vägras = async (löfte) => { try { await löfte; return null; } catch (e) { return e; } };

const rader = { profil: null, ads: [] };
try {
  const { rows: [p] } = await pool.query(
    `INSERT INTO profile (name, email) VALUES ('Bevis eget brev', $1) RETURNING id`,
    [`proof+egetbrev-${KÖRNING}@example.invalid`]);
  rader.profil = p.id;
  const annons = async (n) => {
    const { rows: [a] } = await pool.query(
      `INSERT INTO ads (source, external_id, fingerprint, title, employer, description)
       VALUES ('manual', $1, $1, 'Lagerarbetare', 'Bevisbolaget', 'x') RETURNING id`,
      [`prove-egetbrev-${KÖRNING}-${n}`]);
    rader.ads.push(a.id);
    return a.id;
  };

  // ---- 1 + 2 ----
  const text = 'Hej!\n\nJag söker  tjänsten — med två mellanslag, ett tankstreck och "citat".\n\nMvh';
  const a1 = await annons(1);
  const app = await ownLetter(a1, { profileId: p.id, body: text });
  const { rows: [v] } = await pool.query(
    `SELECT body, change_note FROM letter_versions WHERE application_id = $1 AND version = 1`, [app.id]);
  kolla('1. texten sparas exakt som den skrevs', app.letter_text === text && v?.body === text);
  kolla('1. som version 1, "Skrivet av dig"', app.letter_version === 1 && v?.change_note === 'Skrivet av dig');
  kolla('1. som ett utkast — inget skickas', app.status === 'drafted');
  kolla('2. tomt ämne blir "Ansökan: <titel>"', app.subject === 'Ansökan: Lagerarbetare', app.subject);
  const a2 = await annons(2);
  const eget = await ownLetter(a2, { profileId: p.id, subject: '  Min rubrik ', body: 'Hej' });
  kolla('2. ett skrivet ämne behålls', eget.subject === 'Min rubrik', eget.subject);

  // ---- 3 ----
  const igen = await vägras(ownLetter(a1, { profileId: p.id, body: 'Något annat' }));
  const { rows: [kvar] } = await pool.query(`SELECT letter_text FROM applications WHERE id = $1`, [app.id]);
  kolla('3. ett befintligt brev skrivs aldrig över', igen?.status === 409 && kvar.letter_text === text, igen?.message);
  const a3 = await annons(3);
  await pool.query(
    `INSERT INTO applications (ad_id, profile_id, status, subject, letter_text, letter_version)
     VALUES ($1, $2, 'drafted', 'Genererat', 'Ett genererat brev', 1)`, [a3, p.id]);
  const överGenererat = await vägras(ownLetter(a3, { profileId: p.id, body: 'Mitt' }));
  kolla('3. inte heller ett genererat utkast', överGenererat?.status === 409);

  // ---- 4 ----
  const a4 = await annons(4);
  const tomt = await vägras(ownLetter(a4, { profileId: p.id, body: '   \n ' }));
  const långt = await vägras(ownLetter(a4, { profileId: p.id, body: 'x'.repeat(EGET_BREV_MAX + 1) }));
  const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM applications WHERE ad_id = $1`, [a4]);
  kolla('4. ett tomt brev vägras', tomt?.status === 400);
  kolla('4. ett för långt brev vägras', långt?.status === 400);
  kolla('4. och inget skrevs', n === 0);
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  if (rader.profil) {
    await pool.query(`DELETE FROM letter_versions WHERE application_id IN (SELECT id FROM applications WHERE profile_id = $1)`, [rader.profil]).catch(() => {});
    await pool.query(`DELETE FROM applications WHERE profile_id = $1`, [rader.profil]).catch(() => {});
  }
  if (rader.ads.length) await pool.query(`DELETE FROM ads WHERE id = ANY($1)`, [rader.ads]).catch(() => {});
  if (rader.profil) await pool.query(`DELETE FROM profile WHERE id = $1`, [rader.profil]).catch(() => {});
  await pool.end();
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
