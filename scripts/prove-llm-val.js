// Proves which AI a user can choose, and where the server will call it.
//
//   node scripts/prove-llm-val.js
//
//   1. the providers are OpenRouter, LM Studio and Ollama — and the
//      database refuses any other
//   2. on OpenRouter only the operator's models can be saved, and a
//      saved model taken off the list gives way to the job's first one;
//      the operator's list replaces the standard one
//   3. with login on, a user's own model address must be public https:
//      localhost, private networks and the cloud metadata address are
//      refused when saved — and when called, before any request leaves
//   4. without login (one person, their own machine) localhost is fine
//
// No network: names are resolved by a stand-in, and the "model server"
// on localhost is a fake that counts what reaches it.
import 'dotenv/config';
import http from 'node:http';
import { pool } from '../src/db.js';
import { PROVIDERS } from '../src/providers.js';
import { STANDARDLISTA, NIVÅER, prövaVal, tillåtenKedja, glömModellista } from '../src/modeller.js';
import { prövaAdress } from '../src/adress.js';
import { llmConfig, llmText, invalidateLlmConfig } from '../src/llm.js';
import { encryptSecret } from '../src/secrets.js';
import { UPPGIFT } from '../src/uppgifter.js';

const KÖRNING = `${Date.now()}`;
let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(64)}${info ? ` ${info}` : ''}`);
};

// A resolver that knows three names and nothing else.
const DNS = { 'modell.exempel.se': '93.184.216.34', 'intern.exempel.se': '192.168.1.20', 'metadata.exempel.se': '169.254.169.254' };
const slåUpp = async (namn) => {
  if (!DNS[namn]) throw new Error('ENOTFOUND');
  return [{ address: DNS[namn], family: 4 }];
};
const strikt = { strikt: true, slåUpp };

// ---- 1 ----
kolla('1. leverantörerna är OpenRouter, LM Studio och Ollama',
  Object.keys(PROVIDERS).sort().join() === 'lmstudio,ollama,openrouter', Object.keys(PROVIDERS).join());
kolla('1. OpenRouters förval är det rekommenderade i varje lista',
  NIVÅER.every((n) => PROVIDERS.openrouter[n] === STANDARDLISTA[n][0]));
kolla('1. en borttagen leverantör kan inte sparas', /OpenRouter, LM Studio eller Ollama/.test(
  await prövaVal({ provider: 'groq', modeller: { bulk: 'llama-3.3-70b' } }) || ''));

// ---- 2 ----
const lista = STANDARDLISTA;
const rek = { fast: lista.fast[0], bulk: lista.bulk[0], write: lista.write[0], smart: lista.smart[0] };
kolla('2. de rekommenderade modellerna går att spara', (await prövaVal({ provider: 'openrouter', modeller: rek }, { lista })) === null);
kolla('2. en kedja av tillåtna modeller går att spara', (await prövaVal({ provider: 'openrouter',
  modeller: { ...rek, bulk: `${lista.bulk[0]}, ${lista.bulk[1]}` } }, { lista })) === null);
const otillåten = await prövaVal({ provider: 'openrouter', modeller: { ...rek, bulk: 'meta-llama/llama-3.3-70b-instruct:free' } }, { lista });
kolla('2. en modell utanför listan avvisas, med namn', /llama-3\.3-70b-instruct:free/.test(otillåten || ''), otillåten);
kolla('2. OpenRouter tar ingen egen adress', Boolean(await prövaVal({ provider: 'openrouter', modeller: rek, baseUrl: 'https://modell.exempel.se/v1' }, { lista })));
kolla('2. en borttagen modell ger plats för den första på listan', tillåtenKedja('x/borta', 'bulk', lista) === lista.bulk[0]);
kolla('2. i en kedja stannar de tillåtna', tillåtenKedja(`x/borta, ${lista.write[1]}`, 'write', lista) === lista.write[1]);

let profil;
let tidigareLista;
try {
  ({ rows: [profil] } = await pool.query(
    `INSERT INTO profile (name, email, llm_provider, llm_api_key_enc, llm_model_bulk, llm_model_write)
     VALUES ('Bevis Val', $1, 'openrouter', $2, 'x/borttagen-modell', $3) RETURNING id`,
    [`proof+val-${KÖRNING}@example.invalid`, encryptSecret('bevis-nyckel'), lista.write[1]]));
  const cfg = await llmConfig({ profileId: profil.id, fresh: true });
  kolla('2. sparad modell som tagits bort: anropet använder den rekommenderade', cfg?.bulk === lista.bulk[0], cfg?.bulk);
  kolla('2. sparad modell som finns kvar: används', cfg?.write === lista.write[1], cfg?.write);
  kolla('2. OpenRouters adress är fast', cfg?.baseUrl === PROVIDERS.openrouter.baseUrl);

  // the operator's list, stored, replaces the standard one
  ({ rows: [tidigareLista] } = await pool.query(`SELECT value FROM platform_settings WHERE key = 'llm_modeller'`));
  const egen = { ...STANDARDLISTA, bulk: ['x/borttagen-modell'] };
  await pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ('llm_modeller', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(egen)]);
  glömModellista(); invalidateLlmConfig();
  const cfg2 = await llmConfig({ profileId: profil.id, fresh: true });
  kolla('2. adminens lista gäller i stället för standardlistan', cfg2?.bulk === 'x/borttagen-modell', cfg2?.bulk);

  // ---- 1, in the database ----
  const vägran = await pool.query(`UPDATE profile SET llm_provider = 'groq' WHERE id = $1`, [profil.id])
    .then(() => null, (e) => e);
  kolla('1. databasen vägrar en annan leverantör', vägran?.code === '23514', vägran?.code);
} catch (err) {
  fel += 1;
  console.error('✗ beviset kraschade:', err.stack || err.message);
} finally {
  if (tidigareLista) {
    await pool.query(`UPDATE platform_settings SET value = $1::jsonb WHERE key = 'llm_modeller'`, [JSON.stringify(tidigareLista.value)]);
  } else {
    await pool.query(`DELETE FROM platform_settings WHERE key = 'llm_modeller'`);
  }
  glömModellista(); invalidateLlmConfig();
  if (profil) await pool.query(`DELETE FROM profile WHERE id = $1`, [profil.id]);
}

// ---- 3 ----
const nekas = async (url, väntat) => {
  const svar = await prövaAdress(url, strikt);
  kolla(`3. nekas: ${url}`, Boolean(svar) && (!väntat || väntat.test(svar)), svar || 'godkändes');
};
await nekas('http://modell.exempel.se/v1', /https/);
await nekas('https://localhost:1234/v1', /localhost/);
await nekas('https://127.0.0.1:1234/v1', /privat/);
await nekas('https://10.0.0.5/v1', /privat/);
await nekas('https://172.20.1.1/v1', /privat/);
await nekas('https://169.254.169.254/latest/meta-data', /privat/);
await nekas('https://[::1]:11434/v1', /privat/);
await nekas('https://[::ffff:127.0.0.1]/v1', /privat/);
await nekas('https://intern.exempel.se/v1', /privat/);
await nekas('https://metadata.exempel.se/v1', /privat/);
await nekas('https://anv:losen@modell.exempel.se/v1', /lösenord/);
await nekas('ftp://modell.exempel.se/v1');
kolla('3. godkänns: en publik https-adress', (await prövaAdress('https://modell.exempel.se/v1', strikt)) === null);
kolla('3. en lokal leverantör utan adress nekas (förvalet är localhost)',
  Boolean(await prövaVal({ provider: 'ollama' }, strikt)));

// At call time: login on, a local provider pointed at localhost. The
// fake server must see nothing.
let träffar = 0;
const server = http.createServer((req, res) => { träffar += 1; res.end('{}'); });
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
const tidigareSecret = process.env.AUTH_SECRET;
process.env.AUTH_SECRET = 'bevis-inloggning-pa';
try {
  const e = await llmText({
    config: { provider: 'ollama', apiKey: 'local', baseUrl: `http://127.0.0.1:${port}/v1`, smart: 'llama3.1', fast: 'llama3.1' },
    uppgift: UPPGIFT.TEST, tier: 'smart', maxTokens: 5, system: 's', messages: [{ role: 'user', content: 'x' }],
  }).then(() => null, (err) => err);
  kolla('3. vid anrop med inloggning: localhost nekas', Boolean(e), e?.message?.slice(0, 70));
  kolla('3. och ingen förfrågan nådde servern', träffar === 0, `${träffar} träffar`);
} finally {
  if (tidigareSecret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = tidigareSecret;
}

// ---- 4 ----
kolla('4. utan inloggning går localhost bra', (await prövaAdress('http://localhost:1234/v1', { strikt: false })) === null);
kolla('4. och en lokal leverantör på förvalsadressen godkänns',
  (await prövaVal({ provider: 'lmstudio' }, { strikt: false })) === null);

server.close();
await pool.end();
console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
