// Proves that no code path picks a profile by guessing.
//
// 27 places used to read "the profile" as `FROM profile LIMIT 1` and
// ten wrote it with an UPDATE that had no WHERE. With one row that is
// correct; with two, one user's letter is written from the other's CV,
// sent in their name, billed to their key. This checks both halves:
//
//   static    no query in src/ or app/ reads the first profile, no
//             UPDATE of profile lacks a WHERE, and no code reads a
//             user's Gmail credentials from the environment — so none
//             of it can come back quietly in a new route
//   dynamic   with a second profile present, everything that has no
//             owner to go on REFUSES instead of answering with the
//             first row: the owner lookup, the LLM key lookup, the
//             request helper in local mode, and — if the dev server is
//             running — a real API route
//
// The second profile is a throwaway and is deleted again. While it
// exists the worker's model calls refuse too, which is the point.
//
// Run: node scripts/prove-profile-scope.js
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../src/db.js';
import { endaProfilId } from '../src/owner.js';
import { llmConfig, invalidateLlmConfig } from '../src/llm.js';

let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(56)}${info ? ` ${info}` : ''}`);
};
const vägrar = async (fn) => {
  try { await fn(); return null; } catch (err) { return err; }
};

// ------------------------------------------------------------
// static
// ------------------------------------------------------------
function* filer(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* filer(p);
    else if (/\.(js|jsx)$/.test(e.name)) yield p;
  }
}
const förstaRaden = [];
const utanWhere = [];
// A user's mail credentials live on their profile (src/credentials.js).
// Reading them from the environment is how one user's mail goes out
// through another's account.
const gmailUrMiljön = [];
// Same for AI: a user's key, provider and models live on their profile.
// The one exception is the platform's own key for embedding the shared
// ad pool, read in src/embed.js and nowhere else.
const aiUrMiljön = [];
// Built from the providers the app knows, so a new provider is covered
// without anyone remembering to add it here. Platform settings that
// happen to end in _KEY (JOBSTREAM_API_KEY, ENCRYPTION_KEY) are not AI
// keys and stay allowed.
const { PROVIDERS } = await import('../src/providers.js');
const leverantörer = Object.keys(PROVIDERS).map((p) => p.toUpperCase()).join('|');
const AI_ENV = new RegExp(
  `process\\.env\\.(${leverantörer})_(API_KEY|KEY|MODEL_[A-Z]+|BASE_URL)\\b`
  + '|process\\.env\\[`\\$\\{[^}]+\\}_(API_KEY|KEY|MODEL_[A-Z]+)`\\]'
  + '|process\\.env\\.LLM_(PROVIDER|MODEL_[A-Z]+)\\b');
// And every model call says whose it is — profileId, or an explicit
// config for the "test this key" button. A call without one would fall
// back to "the only profile", which refuses the day there are two.
const anropUtanÄgare = [];
function anropsArgument(kod, start) {
  const i = kod.indexOf('{', start);
  if (i < 0) return '';
  let djup = 0;
  for (let j = i; j < kod.length && j < i + 6000; j++) {
    if (kod[j] === '{') djup += 1;
    else if (kod[j] === '}' && --djup === 0) return kod.slice(i, j + 1);
  }
  return kod.slice(i, i + 6000);
}
for (const dir of ['src', 'app', 'lib']) {
  for (const f of filer(dir)) {
    const t = readFileSync(f, 'utf8');
    // Comments are allowed to name the old pattern; code is not.
    const kod = t.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    if (/FROM\s+profile\s+LIMIT\s+1\b/i.test(kod)) förstaRaden.push(f);
    for (const m of kod.matchAll(/UPDATE\s+profile\s+SET[\s\S]*?`/gi)) {
      if (!/\bWHERE\b/i.test(m[0])) utanWhere.push(f);
    }
    if (/process\.env\.GMAIL_(USER|APP_PASSWORD)\b/.test(kod)) gmailUrMiljön.push(f);
    if (!/[\\/]embed\.js$/.test(f) && AI_ENV.test(kod)) aiUrMiljön.push(f);
    if (!/[\\/]llm\.js$/.test(f)) {
      for (const m of kod.matchAll(/\b(llmJson|llmText|fråga)\(\s*\{/g)) {
        const arg = anropsArgument(kod, m.index);
        if (!/\bprofileId\b|\bconfig\b/.test(arg)) {
          const rad = kod.slice(0, m.index).split('\n').length;
          anropUtanÄgare.push(`${f}:${rad}`);
        }
      }
    }
  }
}
kolla('no query reads "the first profile"', !förstaRaden.length, förstaRaden.join(', '));
kolla('no UPDATE of profile without a WHERE', !utanWhere.length, utanWhere.join(', '));
kolla('no Gmail credentials read from the environment', !gmailUrMiljön.length, gmailUrMiljön.join(', '));
kolla('no user AI keys or models read from the environment', !aiUrMiljön.length, aiUrMiljön.join(', '));

// Every route that is handed someone's row — an [id] in the path, or a
// search id in the request — must ask whose it is before it touches it
// (src/auth.js ägareAv*). Ads included: the pool is shared, but a manual
// ad is its maker's alone, so an ad route asks ägareAvAnnons — and so
// does any route handed an adId in the request. A new route that forgets
// fails here, not in production; scripts/prove-owner-checks.js then
// proves the checks hold at runtime.
const utanÄgarkontroll = [];
for (const f of filer('app/api')) {
  if (!/route\.js$/.test(f)) continue;
  const väg = f.replace(/^app[\\/]api[\\/]/, '').replace(/[\\/]route\.js$/, '');
  const kod = readFileSync(f, 'utf8');
  const tarId = /\[id\]/.test(väg) || /\bsearchId\b/.test(kod) || /\badId\b/.test(kod);
  // No \b before "ä": JavaScript's word boundary only knows ASCII, so it
  // never matches there and every route looked unchecked.
  if (tarId && !/ägareAv(Sökning|Ansökan|Förslag|Bilaga|Annons)\(/.test(kod)) utanÄgarkontroll.push(väg);
}
kolla('every route taking someone\'s id checks the owner', !utanÄgarkontroll.length, utanÄgarkontroll.join(', '));
kolla('every model call says whose it is', !anropUtanÄgare.length, anropUtanÄgare.join(', '));

// ------------------------------------------------------------
// dynamic — one profile: everything answers as before
// ------------------------------------------------------------

// A run killed mid-way (Ctrl+C, or output piped into `head`) never
// reaches its cleanup, and the throwaway profile it left behind makes
// the worker refuse every model call and mail login — by design, since
// it cannot tell whose they are. So a leftover is removed first.
const { rowCount: kvarlämnade } = await pool.query(
  `DELETE FROM profile WHERE email = 'proof+scope@example.invalid'`);
if (kvarlämnade) console.log(`· tog bort ${kvarlämnade} kvarlämnad testprofil från en avbruten körning`);

const { rows: [äkta] } = await pool.query(`SELECT id, name FROM profile LIMIT 2`);
const { rows: [{ n: antal }] } = await pool.query(`SELECT count(*)::int AS n FROM profile`);
if (antal !== 1) {
  console.log(`· ${antal} profiler redan — hoppar över den dynamiska delen, den kräver exakt en`);
  await pool.end();
  process.exit(fel ? 1 : 0);
}
kolla('one profile: the owner lookup answers', (await endaProfilId()) === äkta.id);

// ------------------------------------------------------------
// dynamic — two profiles: nothing may pick one
// ------------------------------------------------------------
const { rows: [andra] } = await pool.query(
  `INSERT INTO profile (name, email, cv_text)
   VALUES ('Testperson Tvåa', 'proof+scope@example.invalid', 'Ett annat CV.')
   RETURNING id`);
try {
  const e1 = await vägrar(() => endaProfilId());
  kolla('two profiles: the owner lookup refuses', e1?.code === 'FLERA_PROFILER');

  invalidateLlmConfig();
  const e2 = await vägrar(() => llmConfig({ fresh: true }));
  // Falling back to the server's env key would be a quieter failure —
  // the operator billed for every user — so it must throw, not return.
  kolla('two profiles: the LLM key lookup refuses', e2?.code === 'FLERA_PROFILER',
    e2 ? '' : 'svarade med en nyckel');

  // The request helper (aktivProfilId in src/auth.js) reads cookies
  // through next/headers, so it only exists inside Next. It is tested
  // the way it is used: through a real route, if the dev server is up.
  // In local mode it must not fall back to the first row, and the route
  // must not hand the first profile's data to a request it cannot
  // attribute.
  const svar = await fetch('http://localhost:3000/api/profile', { signal: AbortSignal.timeout(20000) })
    .catch(() => null);
  // The server must be looking at THIS database for its answer to mean
  // anything. Run against a scratch database while the dev server sits
  // on the real one, it answers with the real profile — a profile this
  // database has never seen — and that is a test setup, not a leak.
  const text = svar ? await svar.text() : '';
  let svarsId = null;
  try { svarsId = JSON.parse(text)?.id || null; } catch { /* not JSON — an error page */ }
  if (svar && svar.ok && svarsId && svarsId !== äkta.id && svarsId !== andra.id) {
    console.log('· dev-servern använder en annan databas — hoppar över route-kontrollen');
  } else if (svar) {
    kolla('two profiles: /api/profile does not answer with a profile',
      !svar.ok && !text.includes(äkta.name), `HTTP ${svar.status}`);
  } else {
    console.log('· dev-servern svarar inte — hoppar över route-kontrollen');
  }
} finally {
  await pool.query(`DELETE FROM profile WHERE id = $1`, [andra.id]);
  invalidateLlmConfig();
}

// And back to one: the same calls answer again.
kolla('one profile again: the owner lookup answers', (await endaProfilId()) === äkta.id);
// "Answers again", not "has a key": a profile with no AI settings
// correctly gets no config. This used to read Boolean(config), which
// passed in CI only because the old environment fallback invented a
// local LM Studio config for a profile that had none.
const e4 = await vägrar(() => llmConfig({ fresh: true }));
kolla('one profile again: the LLM lookup answers instead of refusing', !e4, e4?.message?.slice(0, 50));

console.log(fel ? `\n${fel} fel` : '\nallt stämmer');
await pool.end();
process.exitCode = fel ? 1 : 0;
