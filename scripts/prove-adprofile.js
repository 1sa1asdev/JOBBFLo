// Does reading an ad into the CV's shape make matching less sensitive
// to the ad's format?
//
// The claim behind ad_profile is that format variance is the enemy: the
// same job written as an Arbetsförmedlingen notice, as Teamtailor
// marketing copy and as a scraped fragment should sit at the same
// distance from a candidate, and under raw-text embedding it does not.
//
// So: three real jobs, each written three ways, embedded both ways, and
// the number that matters is the SPREAD across formats for one job. A
// small spread means the format stopped mattering. Mock text, because
// the same job genuinely written three ways is not something the live
// pool contains.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { embedTexts, adEmbedText } from '../src/embed.js';
import { buildAdProfile, renderAdProfile } from '../src/adprofile.js';

const JOBB = {
  'fullstack-utvecklare': {
    af: `Fullstackutvecklare
Vi söker en fullstackutvecklare till vårt team i Stockholm. Du kommer att
arbeta med React och TypeScript i frontend och C#/.NET i backend. Krav: minst
två års erfarenhet av webbutveckling, goda kunskaper i JavaScript, erfarenhet
av relationsdatabaser. Meriterande: Docker, Azure, CI/CD. Anställningsform:
Tillsvidareanställning. Omfattning: Heltid. Tillträde enligt överenskommelse.`,

    teamtailor: `Är du vår nästa stjärna? ✨
Hos oss får du vara med på en resa som få andra! Vi är ett gäng
teknikentusiaster som bygger framtidens plattform, och nu behöver vi
förstärkning. Du kommer att bygga gränssnitt som miljoner människor älskar
och API:er som aldrig går ner. Vi jobbar i React, TypeScript och .NET — men
det viktigaste är inte vad du kan idag, utan hur snabbt du lär dig. Har du
några år i ryggen och gillar att ta ansvar? Då ska vi snacka. Vi erbjuder
frukost varje fredag, hybridarbete och en kultur där alla får vara sig
själva. Sök idag!`,

    skrapad: `Fullstack Developer · Stockholm · Full-time
React TypeScript .NET SQL. 2+ years experience required. Docker and Azure a
plus. Apply via link.`,
  },

  undersköterska: {
    af: `Undersköterska till äldreboende
Vi söker en undersköterska till vårt äldreboende i Stockholm. Du ansvarar för
omvårdnad, dokumentation och medicinhantering enligt delegering. Krav:
undersköterskeexamen, goda kunskaper i svenska i tal och skrift. Meriterande:
erfarenhet av demensvård. Anställningsform: Tillsvidareanställning.
Omfattning: Deltid 75%. Arbetstid: dag och kväll, helgtjänstgöring.`,

    teamtailor: `Vill du göra skillnad varje dag? ❤️
Vi på Solgläntan tror att omsorg börjar med omtanke. Hos oss möter du
fantastiska människor med livshistorier att berätta, och du får tid att
lyssna. Du kommer att stötta våra boende i vardagen, dokumentera och se till
att alla känner sig trygga. Har du undersköterskeutbildning och ett stort
hjärta? Vi erbjuder schemalagd arbetstid, friskvårdsbidrag och kollegor som
blir vänner. Välkommen till oss!`,

    skrapad: `Undersköterska · äldreomsorg · Stockholm
Deltid 75%. Undersköterskeexamen krävs. Omvårdnad, dokumentation,
delegerad medicinhantering. Demensvård meriterande.`,
  },

  restaurangbiträde: {
    af: `Restaurangbiträde
Vi söker restaurangbiträde till vår lunchrestaurang i Stockholm.
Arbetsuppgifter: förberedelse av mat, disk, kassahantering och service i
matsalen. Krav: erfarenhet av restaurangarbete, god svenska. Meriterande:
kunskaper i livsmedelshygien. Anställningsform: Behovsanställning.
Omfattning: Deltid.`,

    teamtailor: `Häng med oss i köket! 🍽️
Vi är en liten lunchkrog med stort hjärta på Södermalm, och vi letar efter
någon som gillar högt tempo och glada gäster. Du hjälper till med allt från
förberedelser till disk och kassa — ingen dag är den andra lik. Har du jobbat
i restaurang förut är det toppen, men viktigast är att du är på tå och gillar
att jobba i team. Vi bjuder på personalmat och världens bästa kollegor.`,

    skrapad: `Restaurangbiträde · Stockholm · Deltid
Förberedelse, disk, kassa, service. Restaurangerfarenhet krävs.
Livsmedelshygien meriterande.`,
  },
};

const cos = (a, b) => {
  let d = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return 1 - d / (Math.sqrt(na) * Math.sqrt(nb));
};

// The search side, unchanged: criteria only, as embedSearchQuery builds it.
const SOKNINGAR = {
  'fullstack utvecklare': 'fullstack utvecklare react typescript .net stockholm',
  'deltid vård och omsorg': 'deltidsjobb inom vård och omsorg i stockholm',
  'deltid restaurang': 'deltidsjobb restaurang café och bar i stockholm',
};

const format = ['af', 'teamtailor', 'skrapad'];

console.log('bygger profiler för 9 mockannonser…');
const rader = [];
for (const [jobb, varianter] of Object.entries(JOBB)) {
  for (const f of format) {
    const ad = { title: jobb, employer: 'Mockbolaget AB', municipality: 'Stockholm', description: varianter[f], raw: {} };
    const profil = await buildAdProfile(ad);
    rader.push({
      jobb,
      f,
      ratext: adEmbedText({ ...ad, ad_profile: null }),
      profiltext: renderAdProfile(profil),
      // Third variant: the structure AND the ad's own distinctive
      // words. The shared section headers are what compress the space
      // and cost discrimination; the ad's vocabulary is what separates
      // one role from another. Neither alone gave both.
      hybridtext: `${renderAdProfile(profil)}

## ANNONSENS EGNA ORD
${(varianter[f] || '').slice(0, 900)}`,
    });
  }
}

const sokvektorer = await embedTexts(Object.values(SOKNINGAR));
const ravektorer = await embedTexts(rader.map((r) => r.ratext));
const profilvektorer = await embedTexts(rader.map((r) => r.profiltext));
const hybridvektorer = await embedTexts(rader.map((r) => r.hybridtext));

for (const [i, [namn]] of Object.entries(Object.entries(SOKNINGAR))) {
  const sok = sokvektorer[i];
  console.log(`\n══ sökning: ${namn} ══`);
  console.log('jobb                    format        råtext   profil');

  const spridning = { ra: {}, profil: {} };
  for (const [j, r] of rader.entries()) {
    const dRa = cos(sok, ravektorer[j]);
    const dPr = cos(sok, profilvektorer[j]);
    (spridning.ra[r.jobb] ||= []).push(dRa);
    (spridning.profil[r.jobb] ||= []).push(dPr);
    console.log(`${r.jobb.padEnd(24)}${r.f.padEnd(14)}${dRa.toFixed(3)}    ${dPr.toFixed(3)}`);
  }

  console.log('\n  spridning mellan format (lägre = formatet spelar mindre roll):');
  for (const jobb of Object.keys(JOBB)) {
    const sp = (xs) => (Math.max(...xs) - Math.min(...xs)).toFixed(3);
    console.log(`    ${jobb.padEnd(24)} råtext ${sp(spridning.ra[jobb])}   profil ${sp(spridning.profil[jobb])}`);
  }
}

// Two numbers, because the average above blends two different things.
//
// SPREAD matters only for the job a search is actually about — how far
// an off-target ad sits from the query is noise either way, since it is
// never going to rank. And DISCRIMINATION is the other half: a format
// that makes everything equally close would score a perfect spread and
// be useless.
const PARAT = {
  'fullstack utvecklare': 'fullstack-utvecklare',
  'deltid vård och omsorg': 'undersköterska',
  'deltid restaurang': 'restaurangbiträde',
};
const idxFor = (jobb) => rader.map((r, k) => (r.jobb === jobb ? k : -1)).filter((k) => k >= 0);
const sp = (xs) => Math.max(...xs) - Math.min(...xs);
const snitt = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

let raTraff = []; let prTraff = []; let hyTraff = [];
let raGap = []; let prGap = []; let hyGap = [];
for (const [i, namn] of Object.keys(SOKNINGAR).entries()) {
  const sok = sokvektorer[i];
  const mal = PARAT[namn];
  const raMal = idxFor(mal).map((k) => cos(sok, ravektorer[k]));
  const prMal = idxFor(mal).map((k) => cos(sok, profilvektorer[k]));
  const hyMal = idxFor(mal).map((k) => cos(sok, hybridvektorer[k]));
  raTraff.push(sp(raMal)); prTraff.push(sp(prMal)); hyTraff.push(sp(hyMal));

  const ovriga = Object.keys(JOBB).filter((j) => j !== mal);
  const raOvr = ovriga.flatMap((j) => idxFor(j).map((k) => cos(sok, ravektorer[k])));
  const prOvr = ovriga.flatMap((j) => idxFor(j).map((k) => cos(sok, profilvektorer[k])));
  const hyOvr = ovriga.flatMap((j) => idxFor(j).map((k) => cos(sok, hybridvektorer[k])));
  raGap.push(snitt(raOvr) - snitt(raMal));
  prGap.push(snitt(prOvr) - snitt(prMal));
  hyGap.push(snitt(hyOvr) - snitt(hyMal));
}
console.log('\n══ RÄTT JOBB: hur mycket formatet stör ══');
for (const [namn, v] of [['råtext', raTraff], ['profil', prTraff], ['hybrid', hyTraff]]) {
  console.log(`  ${namn.padEnd(8)} ${snitt(v).toFixed(3)}`
    + (namn === 'råtext' ? '' : `   ${Math.round((1 - snitt(v) / snitt(raTraff)) * 100)}% mindre formatberoende`));
}
console.log('\n══ SKILJEFÖRMÅGA: avstånd till fel jobb minus rätt jobb ══');
for (const [namn, v] of [['råtext', raGap], ['profil', prGap], ['hybrid', hyGap]]) {
  console.log(`  ${namn.padEnd(8)} ${snitt(v).toFixed(3)}`
    + (namn === 'råtext' ? '' : `   ${Math.round((snitt(v) / snitt(raGap) - 1) * 100)}%`));
}

// The single number that answers the question.
let raSum = 0; let prSum = 0; let n = 0;
for (const [i] of Object.entries(Object.keys(SOKNINGAR))) {
  const sok = sokvektorer[i];
  for (const jobb of Object.keys(JOBB)) {
    const idx = rader.map((r, k) => (r.jobb === jobb ? k : -1)).filter((k) => k >= 0);
    const ra = idx.map((k) => cos(sok, ravektorer[k]));
    const pr = idx.map((k) => cos(sok, profilvektorer[k]));
    raSum += Math.max(...ra) - Math.min(...ra);
    prSum += Math.max(...pr) - Math.min(...pr);
    n += 1;
  }
}
console.log(`\n══ SLUTSATS ══`);
console.log(`  genomsnittlig formatspridning, råtext: ${(raSum / n).toFixed(3)}`);
console.log(`  genomsnittlig formatspridning, profil: ${(prSum / n).toFixed(3)}`);
console.log(`  förbättring: ${Math.round((1 - prSum / raSum) * 100)}%`);

await pool.end();
