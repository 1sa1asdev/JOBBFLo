// Proves the first-run guide and its cost estimate.
//
//   PROVE_BASE_URL=http://localhost:3100 node scripts/prove-onboarding.js
//
// Needs a server with password login on (AUTH_SECRET), against the same
// DATABASE_URL as this script.
//
//   1. a new account is sent from the start page to /valkommen
//   2. the guide reports what is set up from the profile itself
//   3. the estimate is arithmetic: free models cost nothing, twice the
//      volume costs twice as much, an unpriced model is named rather than
//      guessed, a model that reasons is flagged
//   4. through the route, the recommended models cost something, and the
//      recommendation is offered for OpenRouter
//   5. finishing (or skipping to the end) opens the app, for good
import 'dotenv/config';
import { pool } from '../src/db.js';

const BAS = process.env.PROVE_BASE_URL || 'http://localhost:3100';
const KÖRNING = `${Date.now()}`;
let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(64)}${info ? ` ${info}` : ''}`);
};

async function anrop(cookie, metod, väg, body) {
  const res = await fetch(`${BAS}${väg}`, {
    method: metod, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  let data = null; let text = null;
  try { data = await res.clone().json(); } catch { text = await res.text(); }
  return { status: res.status, data, text, location: res.headers.get('location') };
}

try {
  const email = `proof+onb-${KÖRNING}@example.invalid`;
  const res = await fetch(`${BAS}/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Bevis Onboarding', email, password: `losenord-${KÖRNING}` }),
  });
  if (res.status !== 201) throw new Error(`signup: ${res.status}`);
  const cookie = res.headers.get('set-cookie')?.split(';')[0];

  // ---- 1 ----
  const start = await anrop(cookie, 'GET', '/');
  kolla('1. nytt konto: startsidan skickar till /valkommen',
    [307, 308].includes(start.status) && /\/valkommen$/.test(start.location || ''), `${start.status} ${start.location}`);
  const guide = await anrop(cookie, 'GET', '/valkommen');
  // React marks text/value seams with <!-- --> in server HTML.
  kolla('1. guiden visas', guide.status === 200 && /Steg 1 av 3/.test((guide.text || '').replace(/<!-- -->/g, '')),
    String(guide.status));

  // ---- 2 ----
  const s1 = await anrop(cookie, 'GET', '/api/onboarding');
  kolla('2. inget kopplat än', s1.status === 200 && s1.data?.klar === false && !s1.data.gmail && !s1.data.ai && !s1.data.cv,
    JSON.stringify(s1.data));
  await pool.query(`UPDATE profile SET cv_text = 'bevis' WHERE lower(email) = $1`, [email]);
  const s2 = await anrop(cookie, 'GET', '/api/onboarding');
  kolla('2. ett CV lagt under Profil räknas i guiden', s2.data?.cv === true);

  // ---- 3 ----
  let uppskatta = null;
  try { ({ uppskatta } = await import('../src/kostnad.js')); } catch { /* old code */ }
  if (!uppskatta) {
    kolla('3. kostnadskalkylen finns', false, 'src/kostnad.js saknas');
  } else {
    const priser = new Map([
      ['bevis/billig', { prompt: 1e-7, completion: 4e-7 }],
      ['bevis/dyr', { prompt: 3e-6, completion: 1.5e-5 }],
      ['openai/gpt-oss-120b', { prompt: 1e-7, completion: 5e-7 }],
    ]);
    const val = { fast: 'bevis/billig', bulk: 'bevis/dyr', write: 'openai/gpt-oss-120b' };
    const en = uppskatta({ provider: 'openrouter', modeller: val, priser, annonserPerVecka: 50, brevPerVecka: 5 });
    const två = uppskatta({ provider: 'openrouter', modeller: val, priser, annonserPerVecka: 100, brevPerVecka: 10 });
    kolla('3. dubbel volym, dubbel kostnad', en.månad > 0 && Math.abs(två.månad - 2 * en.månad) < 1e-9,
      `$${en.månad.toFixed(2)} → $${två.månad.toFixed(2)}`);
    const gratis = uppskatta({ provider: 'openrouter', priser,
      modeller: { fast: 'x/a:free', bulk: 'x/b:free', write: 'x/c:free' } });
    kolla('3. gratismodeller kostar inget', gratis.månad === 0);
    const groq = uppskatta({ provider: 'groq', modeller: val, priser });
    kolla('3. en gratis leverantör kostar inget', groq.månad === 0);
    const okänd = uppskatta({ provider: 'openrouter', priser, modeller: { ...val, bulk: 'bevis/okand' } });
    kolla('3. modell utan pris namnges, gissas inte', okänd.okändaPriser.includes('bevis/okand'));
    kolla('3. resonerande modell flaggas', en.resonerande.includes('openai/gpt-oss-120b'));
    const kedja = uppskatta({ provider: 'openrouter', priser, modeller: { ...val, bulk: 'bevis/dyr, bevis/billig' } });
    kolla('3. en kedja räknas på första modellen', Math.abs(kedja.månad - en.månad) < 1e-12);
  }

  // ---- 4 ----
  const rek = await anrop(cookie, 'POST', '/api/settings/llm/kostnad', {
    provider: 'openrouter', fast: 'google/gemini-2.5-flash-lite', bulk: 'google/gemini-2.5-flash',
    write: 'openai/gpt-oss-120b', annonserPerVecka: 50, brevPerVecka: 5,
  });
  const nät = rek.data?.prislistaSaknas;
  kolla('4. routen räknar, och rekommenderar för OpenRouter',
    rek.status === 200 && rek.data?.rader?.length === 4 && rek.data?.rekommenderade?.bulk === 'google/gemini-2.5-flash'
      && (nät || rek.data.månad > 0),
    rek.status === 200 ? `$${rek.data.månad?.toFixed(2)}/mån${nät ? ' (prislistan nåddes inte)' : ''}` : String(rek.status));

  // ---- 5 ----
  const klar = await anrop(cookie, 'POST', '/api/onboarding');
  const igen = await anrop(cookie, 'GET', '/');
  kolla('5. klar: appen öppnas', klar.status === 200 && klar.data?.klar === true && igen.status === 200,
    `${klar.status} → ${igen.status}`);
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  await pool.query(`DELETE FROM users WHERE email = $1`, [`proof+onb-${KÖRNING}@example.invalid`]);
  await pool.query(`DELETE FROM profile WHERE email = $1`, [`proof+onb-${KÖRNING}@example.invalid`]);
  await pool.end();
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
