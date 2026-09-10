import { NextResponse } from 'next/server';
import { llmJson } from '../../../../../src/llm.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ------------------------------------------------------------
// Reading a pasted blob with a model, safely.
//
// The local parser assumes one contact per line, which is true of a
// spreadsheet column and false of most things people actually paste:
//
//   Foo Bemanning AB
//   Anna Ek, HR-chef
//   anna.ek@foobemanning.se
//   ---
//   Techrytera | Rekrytering | kontakt@techrytera.se, 070-123 45 67
//
// A model reads those without being told the shape. What it must never
// do is invent one — a hallucinated address sends a real letter to a
// stranger who never appeared in the paste. So every address it returns
// is checked against the input text, and one that is not there verbatim
// is dropped. Same rule the ad quotes live under, for the same reason.
//
// And the reverse: every address in the input that the model failed to
// return is added back. The model is here to structure the text, not to
// decide what counts — a contact it overlooks is a contact the user
// pasted and expects to see.
// ------------------------------------------------------------
const EMAIL_G = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// Loose enough that punctuation and case do not count as a difference,
// tight enough that "Inkåp" still fails against "Inköp".
const jämför = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const SYSTEM = `Du läser en klistrad lista med kontaktuppgifter och gör den strukturerad.

Listan kan se ut hur som helst: en rad per kontakt, ett block per kontakt,
kolumner från ett kalkylblad, signaturer, eller text med adresser inbakade.

För varje KONTAKT du hittar, svara med:
- email: adressen, exakt som den står i texten
- employer: företaget eller organisationen. Inte personens namn.
- person: personens namn om det finns, annars null
- title: personens roll om den finns (HR-chef, rekryterare), annars null

Regler:
- Hitta ALDRIG på en adress. Ta bara med adresser som står i texten.
- En person är aldrig en arbetsgivare. "Anna Ek" är person, "Foo AB" är arbetsgivare.
- Står inget företag: gissa utifrån adressens domän och sätt guessed: true.
- Telefonnummer, adresser och orter är inte arbetsgivare.
- Flera adresser till samma företag är flera kontakter.

Svara med JSON: {"contacts":[{"email":"...","employer":"...","person":null,"title":null,"guessed":false}]}`;

export async function POST(req) {
  const { text } = await req.json();
  const råtext = String(text || '').trim();
  if (!råtext) return NextResponse.json({ contacts: [] });

  // Everything the text actually contains, as the authority on what
  // may be returned and what must not be missing.
  const iTexten = new Set(
    [...råtext.matchAll(EMAIL_G)].map((m) => m[0].toLowerCase())
  );
  if (!iTexten.size) {
    return NextResponse.json({ contacts: [], note: 'ingen adress i texten' });
  }

  let r;
  try {
    r = await llmJson({
      tier: 'fast',
      maxTokens: 3000,
      system: SYSTEM,
      messages: [{ role: 'user', content: råtext.slice(0, 20000) }],
    });
  } catch (err) {
    // The local parser still ran on the client, so a model outage costs
    // quality, not the feature.
    return NextResponse.json(
      { error: `kunde inte tolka: ${err.message}`, contacts: [] }, { status: 502 });
  }

  const sedda = new Set();
  const contacts = [];
  let påhittade = 0;

  for (const k of r?.contacts || []) {
    const email = String(k?.email || '').trim().toLowerCase();
    if (!iTexten.has(email)) { påhittade += 1; continue; }
    if (sedda.has(email)) continue;
    sedda.add(email);

    // The employer cannot be required verbatim — it is legitimately
    // inferred from the domain when the text names no company. But when
    // the model DOES claim to have read one, it should be in the text:
    // "Dagab Inköp och Logistik AB" came back as "Dagab Inkåp", a
    // transcription slip that would go out on a letter. Not in the text
    // and not from the domain means it is a guess, and gets marked as
    // one so the eye lands there during review.
    const employer = String(k.employer || '').trim();
    const iText = employer && jämför(råtext).includes(jämför(employer));
    const frånDomän = employer
      && jämför(email.split('@')[1] || '').includes(jämför(employer).slice(0, 6));

    contacts.push({
      email,
      employer,
      person: k.person ? String(k.person).trim() : null,
      title: k.title ? String(k.title).trim() : null,
      gissadArbetsgivare: Boolean(k.guessed) || !(iText || frånDomän),
      rad: email,
    });
  }

  // Anything the model walked past. Kept with the domain as a stand-in
  // employer so the row is editable rather than absent.
  for (const email of iTexten) {
    if (sedda.has(email)) continue;
    const domän = (email.split('@')[1] || '').replace(/\.[a-z.]+$/i, '');
    const namn = domän.split('.').pop() || domän;
    contacts.push({
      email,
      employer: namn.charAt(0).toUpperCase() + namn.slice(1),
      person: null,
      title: null,
      gissadArbetsgivare: true,
      rad: email,
      missadAvModellen: true,
    });
  }

  return NextResponse.json({
    contacts,
    // Reported rather than hidden: if a model starts inventing
    // addresses, that is worth seeing rather than silently correcting.
    påhittade,
  });
}
