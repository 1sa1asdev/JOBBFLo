import { NextResponse } from 'next/server';
import { pool } from '../../../src/db.js';
import { calibration, skillsGap } from '../../../src/score.js';

export const dynamic = 'force-dynamic';

// calibration + skills gap — both gated on sample size at read
// time inside score.js; don't surface invented numbers early.
export async function GET() {
  const { rows: [profile] } = await pool.query(`SELECT id FROM profile LIMIT 1`);
  if (!profile) return NextResponse.json({ error: 'ingen profil' }, { status: 404 });

  const [calib, gap] = await Promise.all([
    calibration(profile.id),
    skillsGap(profile.id),
  ]);
  const { rows: [{ count: adCount }] } = await pool.query(`SELECT count(*) FROM match_results`);

  return NextResponse.json({
    calibration: calib,
    skills_gap: Number(adCount) >= 100 ? gap : { ready: false, scored: Number(adCount), needed: 100 },
  });
}
