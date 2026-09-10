// ------------------------------------------------------------
// Turning a pasted blob into a list of contacts.
//
// People paste what they have: a column copied out of a spreadsheet, a
// signature block, a list a friend sent, "Anna Ek, Foo AB,
// anna@foo.se". The one thing all of it contains is addresses, so the
// address is the anchor and everything else on its line is a guess
// offered for correction.
//
// Nothing is validated away. A line that yields no address is kept and
// shown as unreadable, because a silently dropped row is how a paste of
// forty ends up sending thirty-eight and nobody notices which two went
// missing.
// ------------------------------------------------------------

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

// Employer, from whatever is left of the line once the address is out.
// Prefers a comma- or tab-separated field, since that is what a
// spreadsheet paste looks like; falls back to the domain, which is
// wrong often enough to need correcting and right often enough to save
// the typing.
function employerFrom(rest, email, person) {
  const fält = rest.split(/[\t;,|]/)
    .map((f) => f.trim())
    .filter(Boolean)
    // The person is never the employer. Without this,
    // "Cecilia Lund <cecilia@vardbolaget.se>" made Cecilia Lund the
    // company — a letter addressed to a person as though she were the
    // firm she works for.
    .filter((f) => f !== person);

  // A person's name is not an employer. "Anna Ek" is two capitalised
  // words and nothing else; a company name usually carries AB, HB, a
  // domain-ish word, or three words or more.
  const bolagigt = (f) => /\b(ab|hb|kb|as|oy|inc|ltd|gmbh|group|konsult|bemanning)\b/i.test(f)
    || f.split(/\s+/).length >= 3;

  const bolag = fält.find(bolagigt) || fält.find((f) => f.split(/\s+/).length > 1);
  if (bolag) return { employer: bolag, gissad: false };

  const domän = (email.split('@')[1] || '').replace(/\.(se|com|nu|net|org|io|eu|dk|no|fi)$/i, '');
  const namn = domän.split('.').pop() || domän;
  return { employer: namn.charAt(0).toUpperCase() + namn.slice(1), gissad: true };
}

// A person's name, when the line offers one. Only used as the contact
// label — it never becomes the employer.
function personFrom(fält) {
  return fält.find((f) => /^[A-ZÅÄÖ][\wåäöéèü'-]+(\s+[A-ZÅÄÖ][\wåäöéèü'-]+){1,2}$/.test(f)
    && !/\b(ab|hb|kb|group|konsult|bemanning)\b/i.test(f)) || null;
}

export function parseContacts(text) {
  const rader = String(text || '')
    .split(/[\r\n]+/)
    .map((r) => r.trim())
    .filter(Boolean);

  const ut = [];
  const sedda = new Set();

  for (const rad of rader) {
    const träff = rad.match(EMAIL);
    if (!träff) {
      // Kept, not dropped. The user needs to see which line the parser
      // could not read, or a paste of forty quietly becomes thirty-eight.
      ut.push({ email: '', employer: '', person: null, rad, status: 'oläsbar' });
      continue;
    }
    const email = träff[0].toLowerCase();
    const rest = rad.replace(träff[0], ' ').replace(/[<>()]/g, ' ').trim();
    const fält = rest.split(/[\t;,|]/).map((f) => f.trim()).filter(Boolean);

    const person = personFrom(fält);
    const { employer, gissad } = employerFrom(rest, email, person);
    ut.push({
      email,
      employer,
      person,
      rad,
      gissadArbetsgivare: gissad,
      // Within the paste itself. Duplicates against what the campaign
      // has already written to are the server's business — it knows,
      // and the client would only be guessing.
      status: sedda.has(email) ? 'dubblett' : 'ok',
    });
    sedda.add(email);
  }
  return ut;
}
