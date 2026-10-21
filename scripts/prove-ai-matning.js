// Proves every AI call is measured by task, by what it belongs to, and
// at the price actually charged.
//
//   node scripts/prove-ai-matning.js
//
// A fake OpenAI-compatible server answers in place of OpenRouter and a
// local model, so nothing is spent and no key is needed.
//
//   1. an OpenRouter call asks for the real cost (usage.include) and the
//      row stores what OpenRouter reported, marked "leverantör"
//   2. the row says what the call was for and what it belonged to
//      (uppgift, ad, search, application) and whose it was
//   3. a local model costs nothing, marked "gratis", and is not asked
//      for a cost it cannot report
//   4. a call whose ad is later deleted keeps its cost, without the ad
import 'dotenv/config';
import http from 'node:http';
import { pool } from '../src/db.js';
import { llmText } from '../src/llm.js';
import { UPPGIFT } from '../src/uppgifter.js';

const KÖRNING = `${Date.now()}`;
let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(62)}${info ? ` ${info}` : ''}`);
};

// The fake provider: remembers what it was asked, answers with usage.
const frågor = [];
const server = http.createServer((req, res) => {
  let kropp = '';
  req.on('data', (d) => { kropp += d; });
  req.on('end', () => {
    const b = JSON.parse(kropp || '{}');
    frågor.push(b);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { content: 'svar' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500,
        // only a provider that was asked reports a cost
        ...(b.usage?.include ? { cost: 0.001234 } : {}) },
    }));
  });
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const bas = `http://127.0.0.1:${server.address().port}/v1`;

// Metering is fire-and-forget; wait for the row.
async function rad(villkor, params) {
  for (let i = 0; i < 40; i += 1) {
    const { rows: [r] } = await pool.query(`SELECT * FROM llm_usage WHERE ${villkor}`, params);
    if (r) return r;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  return null;
}

let profil; let ad; let sök; let ansökan;
try {
  ({ rows: [profil] } = await pool.query(
    `INSERT INTO profile (name, email) VALUES ('Bevis', $1) RETURNING id`, [`proof+matning-${KÖRNING}@example.invalid`]));
  ({ rows: [ad] } = await pool.query(
    `INSERT INTO ads (source, external_id, fingerprint, title, employer, description)
     VALUES ('manual', $1, $1, 'Bevis', 'Bevis AB', 'x') RETURNING id`, [`prove-matning-${KÖRNING}`]));
  ({ rows: [sök] } = await pool.query(
    `INSERT INTO searches (profile_id, name, criteria_text) VALUES ($1, 'Bevis', 'x') RETURNING id`, [profil.id]));
  ({ rows: [ansökan] } = await pool.query(
    `INSERT INTO applications (ad_id, profile_id, status, subject, letter_text) VALUES ($1, $2, 'drafted', 's', 'l') RETURNING id`,
    [ad.id, profil.id]));

  // ---- 1 + 2: OpenRouter ----
  const openrouter = { provider: 'openrouter', apiKey: 'bevis', baseUrl: bas, profileId: profil.id,
    fast: 'bevis/modell', smart: 'bevis/modell', bulk: 'bevis/modell', write: 'bevis/modell' };
  await llmText({ config: openrouter, tier: 'bulk', system: 's', messages: [{ role: 'user', content: 'x' }],
    uppgift: UPPGIFT.BEDÖMA, koppling: { adId: ad.id, searchId: sök.id, applicationId: ansökan.id } });
  kolla('1. OpenRouter ombeds rapportera kostnaden', frågor.at(-1)?.usage?.include === true);
  const r1 = await rad(`profile_id = $1 AND provider = 'openrouter'`, [profil.id]);
  kolla('1. raden har den rapporterade kostnaden, märkt "leverantör"',
    Number(r1?.usd) === 0.001234 && r1?.usd_källa === 'leverantör', `${r1?.usd} (${r1?.usd_källa})`);
  kolla('2. uppgiften står på raden', r1?.uppgift === 'bedöma', r1?.uppgift);
  kolla('2. kopplad till annons, sökning, ansökan och ägare',
    r1?.ad_id === ad.id && r1?.search_id === sök.id && r1?.application_id === ansökan.id && r1?.profile_id === profil.id);
  kolla('2. tokens sparas', r1?.prompt_tokens === 1200 && r1?.completion_tokens === 300);

  // ---- 3: a local model ----
  const lokal = { ...openrouter, provider: 'lmstudio', apiKey: 'local' };
  await llmText({ config: lokal, tier: 'fast', system: 's', messages: [{ role: 'user', content: 'x' }],
    uppgift: UPPGIFT.LÄSA_KRAV, koppling: { adId: ad.id } });
  kolla('3. en lokal modell ombeds inte rapportera kostnad', !frågor.at(-1)?.usage);
  const r3 = await rad(`profile_id = $1 AND provider = 'lmstudio'`, [profil.id]);
  kolla('3. kostar ingenting, märkt "gratis"', Number(r3?.usd) === 0 && r3?.usd_källa === 'gratis' && r3?.uppgift === 'läsa_krav',
    `${r3?.usd} (${r3?.usd_källa})`);

  // ---- 4 ----
  await pool.query(`DELETE FROM applications WHERE id = $1`, [ansökan.id]);
  await pool.query(`DELETE FROM ads WHERE id = $1`, [ad.id]);
  const r4 = await rad(`id = $1`, [r1.id]);
  kolla('4. annonsen raderad: kostnaden finns kvar, utan koppling',
    r4 && Number(r4.usd) === 0.001234 && r4.ad_id === null && r4.application_id === null);
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  if (profil) await pool.query(`DELETE FROM llm_usage WHERE profile_id = $1`, [profil.id]).catch(() => {});
  await pool.query(`DELETE FROM profile WHERE email = $1`, [`proof+matning-${KÖRNING}@example.invalid`]).catch(() => {});
  await pool.query(`DELETE FROM ads WHERE external_id = $1`, [`prove-matning-${KÖRNING}`]).catch(() => {});
  server.close();
  await pool.end();
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
