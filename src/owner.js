import { pool } from './db.js';

// ------------------------------------------------------------
// Whose profile. The one question every profile query has to answer.
//
// For a long time nothing asked it: 27 places read the profile with
// `SELECT ... FROM profile LIMIT 1`, and ten wrote it with an UPDATE
// that had no WHERE at all. Correct while there is one row. With two,
// the second user's letter is written from the first user's CV, sent
// under the first user's name, billed to the first user's key — and a
// CV upload by either overwrites both.
//
// There are two honest answers, and this file and src/auth.js hold them:
//
//   the row knows      an application, a search, an ad check each carry
//                      profile_id. Worker code acting on one of them
//                      uses that, and needs nothing from here.
//
//   the caller knows   an API route acts for whoever made the request:
//                      aktivProfilId() in src/auth.js.
//
// What is left is code with neither — a script, or the LLM key lookup,
// which is called from everywhere and handed no context yet. That code
// asks endaProfilId(), which answers only when there is exactly one
// profile and refuses otherwise. Guessing is the bug this replaces, so
// "I cannot tell" is an error, never a first row.
// ------------------------------------------------------------

export class FleraProfilerError extends Error {
  constructor() {
    super('Det finns flera profiler, och den här koden vet inte vilken den arbetar för. '
      + 'Sätt AUTH_SECRET så att varje anrop har en inloggad användare.');
    this.code = 'FLERA_PROFILER';
    this.status = 409;
  }
}

export async function endaProfilId() {
  const { rows } = await pool.query(`SELECT id FROM profile LIMIT 2`);
  if (rows.length > 1) throw new FleraProfilerError();
  if (!rows.length) {
    const err = new Error('ingen profil — kör npm run db:seed');
    err.status = 404;
    throw err;
  }
  return rows[0].id;
}
