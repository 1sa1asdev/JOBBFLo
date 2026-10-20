// Why sign-in came back to /login, by code. The page shows only these
// texts: a free-text ?fel= would let anyone link to our own login page
// with a message of their choosing ("ring det här numret").
export const LOGIN_FEL = {
  avbruten: 'Inloggningen avbröts.',
  'annan-webblasare': 'Inloggningen startades i en annan webbläsare eller har gått ut. Försök igen härifrån.',
  'lank-gammal': 'Länken har gått ut eller redan använts. Försök igen.',
  'konto-finns': 'Det finns redan ett konto med den adressen.',
  'inte-paslagen': 'Google-inloggning är inte påslagen här.',
  'for-manga': 'För många inloggningsförsök. Vänta tio minuter och försök igen.',
  okant: 'Inloggningen gick inte igenom. Försök igen.',
};

export const loginFelText = (kod) => (kod ? LOGIN_FEL[kod] || LOGIN_FEL.okant : null);
