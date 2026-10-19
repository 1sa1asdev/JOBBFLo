import { NextResponse } from 'next/server';
import { aktivProfilId } from '../../../src/auth.js';
import { pool } from '../../../src/db.js';
import { calibration, skillsGap } from '../../../src/score.js';

export const dynamic = 'force-dynamic';

// calibration + skills gap — both gated on sample size at read
// time inside score.js; don't surface invented numbers early.
export async function GET() {
  const profileId = await aktivProfilId();

  const [calib, gap] = await Promise.all([
    calibration(profileId),
    skillsGap(profileId),
  ]);
  const { rows: [{ count: adCount }] } = await pool.query(
    `SELECT count(*) FROM match_results m JOIN searches s ON s.id = m.search_id
     WHERE s.profile_id = $1`, [profileId]);

  return NextResponse.json({
    calibration: calib,
    skills_gap: Number(adCount) >= 100 ? gap : { ready: false, scored: Number(adCount), needed: 100 },
  });
}
