// Proves the shared beacon asks for every view on screen, and hands each
// view its own answer.
//
//   node scripts/prove-beacon.js
//
// lib/beacon.jsx makes one round of /api/pulse requests for every view
// subscribed to it (lib/beaconPlan.js plans them). The route answers one
// search and one address finder per request, so the plan has to:
//
//   1. make one request in the normal case — global, the open search
//      and the campaigns together
//   2. give two different searches on screen a request each, instead of
//      one silently overwriting the other, and read each list's version
//      from its own answer
//   3. not ask twice for a search two views share
//   4. ask for the campaigns once, not once per request
//
// No browser and no database: the plan is pure.
import { planera, versionFör } from '../lib/beaconPlan.js';

let fel = 0;
const kolla = (namn, ok, info = '') => {
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} ${namn.padEnd(64)}${info ? ` ${info}` : ''}`);
};
const sorterad = (f) => [...new URLSearchParams(f)].map(([k, v]) => `${k}=${v}`).sort().join('&');

// ---- 1 ----
{
  const subs = [{ del: 'global' }, { del: 'search', param: 'A' }, { del: 'kampanjer' }];
  const { frågor } = planera(subs);
  kolla('1. vanliga fallet är en förfrågan', frågor.length === 1, frågor.join(' | '));
  kolla('1. med sökningen och kampanjerna', sorterad(frågor[0]) === 'delar=kampanjer&search=A', frågor[0]);
  kolla('1. bara global ger en förfrågan utan parametrar', planera([{ del: 'global' }]).frågor.join() === '');
}

// ---- 2 ----
{
  const a = { del: 'search', param: 'A' };
  const b = { del: 'search', param: 'B' };
  const g = { del: 'global' };
  const { frågor, svarIndex } = planera([g, a, b]);
  kolla('2. två sökningar på skärmen: en förfrågan var', frågor.length === 2, frågor.join(' | '));
  kolla('2. A och B frågas om var för sig',
    frågor.some((f) => sorterad(f) === 'search=A') && frågor.some((f) => sorterad(f) === 'search=B'));
  // what the route would answer for each request
  const svar = frågor.map((f) => ({ version: 'g1', search: `v-${new URLSearchParams(f).get('search')}` }));
  kolla('2. A läser A:s version', versionFör(a, svar, svarIndex) === 'v-A', versionFör(a, svar, svarIndex));
  kolla('2. B läser B:s version', versionFör(b, svar, svarIndex) === 'v-B', versionFör(b, svar, svarIndex));
  kolla('2. global läses från första svaret', versionFör(g, svar, svarIndex) === 'g1');
}

// ---- 3 ----
{
  const { frågor } = planera([{ del: 'search', param: 'A' }, { del: 'search', param: 'A' }]);
  kolla('3. samma sökning i två vyer frågas en gång', frågor.length === 1 && sorterad(frågor[0]) === 'search=A');
}

// ---- 4 ----
{
  const subs = [{ del: 'kampanjer' }, { del: 'search', param: 'A' }, { del: 'search', param: 'B' },
    { del: 'adresser', param: 'X' }];
  const { frågor, svarIndex } = planera(subs);
  kolla('4. kampanjerna frågas en gång', frågor.filter((f) => f.includes('delar=kampanjer')).length === 1);
  kolla('4. adressökningen följer med första förfrågan', sorterad(frågor[0]).includes('adresser=X'), frågor[0]);
  const svar = [{ kampanjer: 'k1', adresser: 'x1', search: 'v-A' }, { search: 'v-B' }];
  kolla('4. adressökningen läser sitt eget svar', versionFör(subs[3], svar, svarIndex) === 'x1');
  kolla('4. ett område utan svar ger null, inte ett fel', versionFör({ del: 'kampanjer' }, [{}], () => 0) === null);
}

console.log(fel ? `\n${fel} fel` : '\nallt håller');
process.exit(fel ? 1 : 0);
