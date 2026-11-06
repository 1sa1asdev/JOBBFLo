// Proves what a reply may carry, without sending anything.
//
//   node scripts/prove-reply-attachments.js
//
// A reply from the inbox can take the CV, documents the user uploaded
// before, and files picked for it. The ids of those documents come in
// with the request, so:
//
//   1. the picker lists this user's CV and documents — nobody else's
//   2. another user's document id is refused, never attached
//   3. 'cv' is the CV this application would be sent with
//   4. a file that is not a document or an image is refused, by its
//      name, whatever the browser says it is
//   5. new files stop at 4 MB together (what one request can carry),
//      everything at 18 MB (what Gmail takes once encoded)
//   6. a file name cannot carry a path
//
// On throwaway rows, removed again.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { svarsdokument, bilagorFörSvar, SVARSBILAGOR } from '../src/mailer.js';

const KÖRNING = `${Date.now()}`;
let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(60)}${info ? ` ${info}` : ''}`);
};
const vägras = async (löfte) => { try { await löfte; return null; } catch (e) { return e; } };
const MB = 1024 * 1024;

const rader = { profiler: [], ads: [] };
try {
  const profil = async (namn) => {
    const { rows: [p] } = await pool.query(
      `INSERT INTO profile (name, email, cv_file, cv_filename) VALUES ($1, $2, $3, 'cv-bas.pdf') RETURNING id`,
      [`Bevis ${namn}`, `proof+bilaga-${namn}-${KÖRNING}@example.invalid`, Buffer.from('%PDF bas')]);
    rader.profiler.push(p.id);
    return p.id;
  };
  const A = await profil('a');
  const B = await profil('b');
  const { rows: [ad] } = await pool.query(
    `INSERT INTO ads (source, external_id, fingerprint, title, employer, description)
     VALUES ('manual', $1, $1, 'Bevis', 'Bevisbolaget', 'x') RETURNING id`, [`prove-bilaga-${KÖRNING}`]);
  rader.ads.push(ad.id);
  const { rows: [app] } = await pool.query(
    `INSERT INTO applications (ad_id, profile_id, status, subject, letter_text, cv_file, cv_filename)
     VALUES ($1, $2, 'sent', 'x', 'x', $3, 'cv-for-detta-jobb.pdf') RETURNING id`,
    [ad.id, A, Buffer.from('%PDF eget')]);
  const dok = async (profileId, namn, bytes) => (await pool.query(
    `INSERT INTO attachments (profile_id, filename, mime, bytes, size_bytes)
     VALUES ($1, $2, 'application/pdf', $3, $4) RETURNING id`,
    [profileId, namn, bytes, bytes.length])).rows[0].id;
  const aDok = await dok(A, 'intyg.pdf', Buffer.from('%PDF intyg'));
  const bDok = await dok(B, 'annans.pdf', Buffer.from('%PDF annans'));

  // ---- 1 ----
  const { dokument } = await svarsdokument(app.id);
  const ids = dokument.map((d) => d.id);
  kolla('1. listan har CV:t och användarens eget dokument', ids.includes('cv') && ids.includes(aDok));
  kolla('1. men inte någon annans', !ids.includes(bDok), `${dokument.length} dokument`);

  // ---- 2 ----
  const annans = await vägras(bilagorFörSvar(app.id, { dokument: [bDok] }));
  kolla('2. en annan användares dokument vägras', annans?.status === 400, annans?.message);

  // ---- 3 ----
  const två = await bilagorFörSvar(app.id, { dokument: ['cv', aDok] });
  kolla('3. "cv" är ansökans eget CV, inte profilens', två[0]?.filename === 'cv-for-detta-jobb.pdf'
    && två[0].content.toString() === '%PDF eget', två.map((b) => b.filename).join(', '));
  kolla('3. och dokumentet följer med med sina bytes', två[1]?.content.toString() === '%PDF intyg');

  // ---- 4 ----
  const exe = await vägras(bilagorFörSvar(app.id, { uppladdade: [{ filename: 'faktura.pdf.exe', bytes: Buffer.from('MZ') }] }));
  kolla('4. en .exe vägras, också med .pdf i namnet', exe?.status === 400, exe?.message);
  const utan = await vägras(bilagorFörSvar(app.id, { uppladdade: [{ filename: 'utan-ändelse', bytes: Buffer.from('x') }] }));
  kolla('4. en fil utan ändelse vägras', utan?.status === 400);
  const bild = await bilagorFörSvar(app.id, { uppladdade: [{ filename: 'Körkort.JPG', bytes: Buffer.from('jpg') }] });
  kolla('4. en bild går, typen tagen från namnet', bild[0]?.contentType === 'image/jpeg');

  // ---- 5 ----
  const stor = await vägras(bilagorFörSvar(app.id, {
    uppladdade: [{ filename: 'a.pdf', bytes: Buffer.alloc(3 * MB) }, { filename: 'b.pdf', bytes: Buffer.alloc(2 * MB) }] }));
  kolla('5. nya filer över 4 MB tillsammans vägras', stor?.status === 400, stor?.message);
  kolla('5. under gränsen går', (await bilagorFörSvar(app.id, { uppladdade: [{ filename: 'a.pdf', bytes: Buffer.alloc(3 * MB) }] })).length === 1);
  const tung = await dok(A, 'tung.pdf', Buffer.alloc(16 * MB));
  const förMycket = await vägras(bilagorFörSvar(app.id, { dokument: [tung], uppladdade: [{ filename: 'a.pdf', bytes: Buffer.alloc(3 * MB) }] }));
  kolla(`5. allt tillsammans över ${SVARSBILAGOR.totaltMax / MB} MB vägras`, förMycket?.status === 400, förMycket?.message);

  // ---- 6 ----
  const väg = await bilagorFörSvar(app.id, { uppladdade: [{ filename: '..\\..\\etc/hemligt.txt', bytes: Buffer.from('x') }] });
  kolla('6. en sökväg i filnamnet tas bort', väg[0]?.filename === 'hemligt.txt', väg[0]?.filename);
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  if (rader.profiler.length) {
    await pool.query(`DELETE FROM attachments WHERE profile_id = ANY($1)`, [rader.profiler]).catch(() => {});
    await pool.query(`DELETE FROM applications WHERE profile_id = ANY($1)`, [rader.profiler]).catch(() => {});
  }
  if (rader.ads.length) await pool.query(`DELETE FROM ads WHERE id = ANY($1)`, [rader.ads]).catch(() => {});
  if (rader.profiler.length) await pool.query(`DELETE FROM profile WHERE id = ANY($1)`, [rader.profiler]).catch(() => {});
  await pool.end();
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
