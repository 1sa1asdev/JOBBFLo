// Reads every ad a search holds into a requirement profile, then
// vectorises those profiles.
//
// Bounded on purpose: ads inside a search, not the whole pool. The
// profile is what the checklist reads and what the second vector is
// built from, and it is paid for once — here, or at the moment the ad
// is checked.
//
// Prints the spend, because "cheap" should be a number.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { buildPendingAdProfiles, antalUtanProfil } from '../src/adprofile.js';
import { embedPendingProfiles } from '../src/embed.js';

const TAK = Number(process.argv[2] || 600);

const spend = async () => {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return null;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { authorization: `Bearer ${key}` },
    });
    return (await r.json())?.data?.usage ?? null;
  } catch { return null; }
};

const före = await spend();
const t0 = Date.now();
let lästa = 0;
let tunna = 0;

while (lästa + tunna < TAK) {
  const r = await buildPendingAdProfiles({ limit: 15 }).catch((e) => {
    console.error('paus:', e.message.slice(0, 100));
    return null;
  });
  if (!r) { await new Promise((s) => setTimeout(s, 5000)); continue; }
  if (!r.done && !r.thin) break;
  lästa += r.done; tunna += r.thin;
  const kvar = await antalUtanProfil().catch(() => null);
  const takt = (lästa + tunna) / Math.max(1, (Date.now() - t0) / 1000);
  console.log(`${lästa} lästa${tunna ? `, ${tunna} utan text` : ''}`
    + `${kvar != null ? ` — ${kvar} kvar` : ''}, ${takt.toFixed(1)}/s`);
}

let vektorer = 0;
for (;;) {
  const n = await embedPendingProfiles({ limit: 96 }).catch((e) => {
    console.error('vektorer:', e.message.slice(0, 100));
    return 0;
  });
  if (!n) break;
  vektorer += n;
  console.log(`  ${vektorer} kravprofiler vektoriserade`);
}

const efter = await spend();
console.log(`klart: ${lästa} profiler, ${vektorer} vektorer, `
  + `${Math.round((Date.now() - t0) / 1000)}s`
  + (före != null && efter != null ? `, kostnad $${(efter - före).toFixed(3)}` : ''));
await pool.end();
