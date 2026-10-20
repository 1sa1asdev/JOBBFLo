import { NextResponse } from 'next/server';
import { currentUserId, aktivProfilId } from '../../../../src/auth.js';
import { exportera } from '../../../../src/konto.js';
import { inomTakt, klientAdress, förMånga } from '../../../../src/takt.js';

export const dynamic = 'force-dynamic';

// Everything Jobbflo holds about the caller, as one JSON file.
export async function GET() {
  await aktivProfilId();
  const userId = await currentUserId();
  if (!userId) {
    return NextResponse.json({ error: 'exporten gäller ett konto — det finns inget utan inloggning' }, { status: 400 });
  }
  // A walk of every table: fine now and then, not in a loop.
  if (!(await inomTakt('export', userId))) return förMånga();
  const datum = new Date().toISOString().slice(0, 10);
  return new NextResponse(JSON.stringify(await exportera(userId), null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="jobbflo-${datum}.json"`,
      'cache-control': 'no-store',
    },
  });
}
