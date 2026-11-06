import { NextResponse } from 'next/server';
import { unstable_rethrow } from 'next/navigation';
import { ägareAvAnsökan, inteHittad } from '../../../../../src/auth.js';
import { pool } from '../../../../../src/db.js';
import { sendReply, svarsdokument, bilagorFörSvar, SVARSFILTYPER, SVARSBILAGOR } from '../../../../../src/mailer.js';
import { felsvar } from '../../../../../src/felkoder.js';

export const dynamic = 'force-dynamic';

// The documents this reply can carry, for the picker in the composer.
export async function GET(_req, { params }) {
  const { id } = await params;
  if (!(await ägareAvAnsökan(id))) return inteHittad('ansökan finns inte');
  const { dokument } = await svarsdokument(id);
  return NextResponse.json({
    dokument,
    filtyper: SVARSFILTYPER,
    nyaMax: SVARSBILAGOR.nyaMax,
    totaltMax: SVARSBILAGOR.totaltMax,
  });
}

// user-approved reply / follow-up in an existing thread. JSON when it
// is only text; multipart when files go with it ('dokument' = ids from
// GET above, 'fil' = new files).
export async function POST(req, { params }) {
  const { id } = await params;
  const profileId = await ägareAvAnsökan(id);
  if (!profileId) return inteHittad('ansökan finns inte');

  let body, suggestedReplyId, dokument = [], uppladdade = [];
  if ((req.headers.get('content-type') || '').startsWith('multipart/form-data')) {
    const form = await req.formData();
    body = String(form.get('body') || '');
    suggestedReplyId = form.get('suggestedReplyId') || null;
    dokument = form.getAll('dokument').map(String);
    for (const f of form.getAll('fil')) {
      if (typeof f?.arrayBuffer !== 'function') continue;
      uppladdade.push({ filename: f.name, bytes: Buffer.from(await f.arrayBuffer()) });
    }
  } else {
    ({ body, suggestedReplyId } = await req.json());
  }
  if (!body?.trim()) return NextResponse.json({ error: 'body krävs' }, { status: 400 });

  let bilagor;
  try {
    bilagor = await bilagorFörSvar(id, { dokument, uppladdade });
  } catch (err) {
    unstable_rethrow(err);
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }

  try {
    const result = await sendReply(id, body.trim(), { suggestedReplyId, bilagor });

    // if this was the scheduled follow-up nudge, mark it done
    if (suggestedReplyId) {
      const { rows: [sr] } = await pool.query(
        `SELECT kind FROM suggested_replies WHERE id = $1`, [suggestedReplyId]
      );
      if (sr?.kind === 'followup') {
        await pool.query(
          `UPDATE applications SET followup_sent_at = now() WHERE id = $1`, [id]
        );
      }
    }
    return NextResponse.json({ ...result, bilagor: bilagor.map((b) => b.filename) });
  } catch (err) {
    unstable_rethrow(err);
    // the same code a campaign would log for this failure (src/felkoder.js)
    return NextResponse.json(felsvar(err), { status: 500 });
  }
}
