// ------------------------------------------------------------
// Next's hook for an error no route caught. Written to error_log
// (src/fellogg.js) and shown on /admin.
//
// The Node runtime only: the edge middleware has no database. The
// import must sit INSIDE the runtime check — Next removes that branch
// from the edge build, but not code after an early return, and the
// edge bundle then fails on pg and dotenv.
// ------------------------------------------------------------
export async function register() {}

export async function onRequestError(err, request) {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { loggaFel } = await import('./src/fellogg.js');
    await loggaFel({
      källa: 'app', väg: request?.path, metod: request?.method, fel: err, digest: err?.digest || null,
    });
  }
}
