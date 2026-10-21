// ------------------------------------------------------------
// One of a kind, by waiting rather than by giving up.
//
// The worker and the janitor each hold a Postgres advisory lock for
// their whole life, so two of them can never run at once. They used to
// exit when the lock was taken — and Railway starts the NEW container of
// a deploy before it stops the old one. The new one saw the old one's
// lock, said "en annan worker kör redan — avslutar", and exited cleanly;
// then the old one was stopped, and nothing was left running. That
// happened on every deploy and every variable change, and production sat
// with no worker until someone restarted it by hand.
//
// So a second instance waits for the lock instead: when the old one
// stops, its connection closes, the lock is released, and the new one
// takes over within one interval. Two never run at once, and a deploy
// never leaves none.
// ------------------------------------------------------------
export async function väntaPåLås(klient, nyckel, namn, { signal, intervall = 10_000 } = {}) {
  let sagt = false;
  for (;;) {
    const { rows: [r] } = await klient.query('SELECT pg_try_advisory_lock($1) AS fick', [nyckel]);
    if (r.fick) {
      if (sagt) console.log(`${namn}: den förra har stängt — tar över`);
      return true;
    }
    if (!sagt) {
      console.log(`${namn}: en annan ${namn} håller låset — väntar tills den har stängt`);
      sagt = true;
    }
    if (signal?.aborted) return false;
    await new Promise((klar) => {
      const t = setTimeout(klar, intervall);
      signal?.addEventListener('abort', () => { clearTimeout(t); klar(); }, { once: true });
    });
    if (signal?.aborted) return false;
  }
}
