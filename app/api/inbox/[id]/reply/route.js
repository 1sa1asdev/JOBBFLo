import { NextResponse } from 'next/server';
import { pool } from '../../../../../src/db.js';
import { sendReply } from '../../../../../src/mailer.js';

export const dynamic = 'force-dynamic';

// user-approved reply / follow-up in an existing thread
export async function POST(req, { params }) {
  const { id } = await params;
  const { body, suggestedReplyId } = await req.json();
  if (!body?.trim()) return NextResponse.json({ error: 'body krävs' }, { status: 400 });

  try {
    const result = await sendReply(id, body.trim(), { suggestedReplyId });

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
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
