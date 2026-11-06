// Arbetsförmedlingen's assessment words (src/yrkesbarometer.js), as the
// app says them. Shared by the Marknaden tab and the search chat card.
export const JOBB = { stora: 'Stora möjligheter', medelstora: 'Medelstora möjligheter', små: 'Små möjligheter' };
export const REKRYTERING = {
  brist: 'brist på sökande',
  balans: 'balans',
  överskott: 'många sökande',
  paradox: 'brist trots många sökande',
};
export const PROGNOS = { öka: 'efterfrågan ökar', 'vara oförändrad': 'oförändrad efterfrågan', minska: 'efterfrågan minskar' };

export const kortLäge = (y) => [JOBB[y.jobbmojligheter], REKRYTERING[y.rekrytering], PROGNOS[y.prognos]]
  .filter(Boolean).join(' · ');

export const ÄNDRING = { bättre: '↑ bättre än förra bedömningen', sämre: '↓ sämre än förra bedömningen' };
