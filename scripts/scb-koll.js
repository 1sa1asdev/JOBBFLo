// Run once when SCB_API_KEY is new: does the key work, which PeOrgNr
// form does SCB take, and do the code tables say what src/arbetsgivare.js
// assumes (sector 13 = general government; legal forms 81–89 = public)?
//
//   node scripts/scb-koll.js [orgnr]      default: Arbetsförmedlingen
//
// Prints the classification fields only — never the name, address,
// phone or e-mail SCB also sends.
import 'dotenv/config';
import { SCB_BAS, typFrånScb } from '../src/arbetsgivare.js';

const nyckel = process.env.SCB_API_KEY;
if (!nyckel) { console.error('SCB_API_KEY saknas i .env'); process.exit(1); }
const orgnr = (process.argv[2] || '2021005521').replace(/\D/g, '');
const hämta = (väg) => fetch(`${SCB_BAS}${väg}`, { headers: { 'X-API-Key': nyckel, Accept: 'application/json' } });

for (const prefix of ['16', '']) {
  const svar = await hämta(`/juridiskaenheter/${prefix}${orgnr}/full`);
  console.log(`PeOrgNr ${prefix ? '16+' : ''}nummer: HTTP ${svar.status}`);
  if (svar.ok) {
    const je = await svar.json();
    const { sektor, jurform, naringsgrenar } = je;
    console.log({ sektor, jurform, naringsgrenar, typ: typFrånScb(je).typ });
    break;
  }
}
for (const [namn, väg, filter] of [
  ['juridisk form', '/kodtabeller/jurformkoder', (k) => /^8/.test(k.kod)],
  ['sektor', '/kodtabeller/sektorkoder', (k) => /^13/.test(k.kod)],
]) {
  const svar = await hämta(väg);
  const rader = svar.ok ? await svar.json() : [];
  console.log(`\n${namn} (HTTP ${svar.status}):`);
  for (const k of rader.filter(filter)) console.log(`  ${k.kod}  ${k.klartext}`);
}
