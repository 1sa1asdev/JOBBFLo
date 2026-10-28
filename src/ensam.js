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

// ------------------------------------------------------------
// One at a time within the process, too: a tick still running when its
// timer fires again is skipped, not started a second time.
//
// setInterval does not wait. On 21 Oct the production database ran out
// of disk throughput, every tick took longer than its interval, and the
// worker kept starting new ones on top: three embedding batches updating
// the same rows and waiting on each other, the pool (PG_POOL_MAX) full,
// the heartbeat queued behind them and the app's own queries starved.
// The slower the database got, the more load the worker added. Skipping
// keeps it at one of each, however slow the database is.
// ------------------------------------------------------------
export function enÅtGången(fn) {
  let pågår = false;
  return async (...args) => {
    if (pågår) return undefined;
    pågår = true;
    try {
      return await fn(...args);
    } finally {
      pågår = false;
    }
  };
}

// ------------------------------------------------------------
// The lock lives exactly as long as its connection — and that connection
// can die without the process dying. During the 21-22 Oct outage the
// database went away under a running worker: Postgres released the
// session's advisory lock, the connection emitted an 'error' nobody
// listened for, and the worker carried on as if it still held the lock.
// From then on a second worker (the next deploy's) could take it, and
// two would grade and send side by side — what the lock exists to stop.
//
// So the holder watches its lock connection, and when it breaks the
// instance stops; Railway starts it again and it waits for the lock like
// any new instance. Returns a function that disarms the watch, for an
// orderly shutdown that ends the connection on purpose.
// ------------------------------------------------------------
export function bevakaLås(klient, namn, påFörlust) {
  let avväpnad = false;
  let hänt = false;
  const förlorat = (err) => {
    if (avväpnad || hänt) return;
    hänt = true;
    console.error(`${namn}: låsets anslutning bröts (${err?.message || 'stängd'}) — låset är släppt i databasen, så den här instansen stannar`);
    påFörlust(err);
  };
  klient.on('error', förlorat);
  klient.on('end', () => förlorat());
  return () => { avväpnad = true; };
}

// ------------------------------------------------------------
// The first connection, with patience. A worker that cannot reach the
// database used to throw at startup, exit, and be restarted by Railway
// at once — over and over, each attempt another failed login at the
// pooler, which after enough of them blocks every new connection
// (ECIRCUITBREAKER) and so keeps the outage going. This waits instead,
// doubling the pause up to a minute.
// ------------------------------------------------------------
export async function anslutMedTålamod(pool, namn, { signal, start = 2000, max = 60_000 } = {}) {
  let paus = start;
  let sagt = false;
  for (;;) {
    try {
      const klient = await pool.connect();
      if (sagt) console.log(`${namn}: databasen svarar igen`);
      return klient;
    } catch (err) {
      if (signal?.aborted) return null;
      console.error(`${namn}: når inte databasen (${err.message}) — försöker igen om ${Math.round(paus / 1000)} s`);
      sagt = true;
      await new Promise((klar) => {
        const t = setTimeout(klar, paus);
        signal?.addEventListener('abort', () => { clearTimeout(t); klar(); }, { once: true });
      });
      if (signal?.aborted) return null;
      paus = Math.min(max, paus * 2);
    }
  }
}
