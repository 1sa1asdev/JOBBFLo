import { pool } from './db.js';

// ------------------------------------------------------------
// An error nobody caught, written where the admin page shows it.
// Never throws: logging a failure must not become a second one.
// ------------------------------------------------------------
export async function loggaFel({ källa, väg = null, metod = null, fel, digest = null }) {
  try {
    const meddelande = String(fel?.message || fel || 'okänt fel').slice(0, 300);
    await pool.query(
      `INSERT INTO error_log (källa, väg, metod, meddelande, digest) VALUES ($1, $2, $3, $4, $5)`,
      [källa, väg ? String(väg).split('?')[0].slice(0, 200) : null, metod, meddelande, digest]);
    if (Math.random() < 0.02) {
      await pool.query(`DELETE FROM error_log WHERE at < now() - interval '30 days'`);
    }
  } catch { /* the log is best-effort */ }
}

// For the worker and the janitor: anything that escapes every catch.
export function fångaProcessfel(källa) {
  process.on('unhandledRejection', (fel) => {
    console.error(`${källa}: ohanterat löfte:`, fel?.message || fel);
    loggaFel({ källa, fel });
  });
  process.on('uncaughtException', (fel) => {
    console.error(`${källa}: ohanterat fel:`, fel?.message || fel);
    // A process in an unknown state is restarted by its host; the log
    // gets a moment to land first.
    loggaFel({ källa, fel }).finally(() => process.exit(1));
  });
}
