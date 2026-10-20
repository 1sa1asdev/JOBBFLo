import { NextResponse } from 'next/server';
import { aktivProfilId } from '../../../../src/auth.js';
import { pool } from '../../../../src/db.js';
import { unitCosts, spendThisMonth } from '../../../../src/prices.js';
import { decryptSecret } from '../../../../src/secrets.js';
import { openrouterKredit } from '../../../../src/openrouterCredit.js';

export const dynamic = 'force-dynamic';

// Only OpenRouter publishes what is left on a key.
const providerCredit = (provider, key) => (provider === 'openrouter' ? openrouterKredit(key) : null);

export async function GET() {
  const profileId = await aktivProfilId();
  const { rows: [p] } = await pool.query(
    `SELECT monthly_budget_usd, daily_score_limit, llm_provider,
            llm_api_key_enc, llm_model_bulk, llm_model_write
     FROM profile WHERE id = $1`, [profileId]);
  if (!p) return NextResponse.json({ error: 'ingen profil' }, { status: 400 });

  // The user's own spend and the credit left on THEIR key. Asking
  // OpenRouter with the server's key would show the operator's balance
  // as if it were the user's.
  const [unit, spent, credit] = await Promise.all([
    unitCosts(),
    spendThisMonth(profileId),
    providerCredit(p.llm_provider, decryptSecret(p.llm_api_key_enc)),
  ]);

  const budget = p.monthly_budget_usd == null ? null : Number(p.monthly_budget_usd);

  // How much work a budget buys, at what this install's own calls have
  // actually cost. Not a price-list estimate: the averages come from
  // llm_usage, so they carry this user's CV length and ad lengths.
  //
  // Scoring is what scales — letters are a handful a day and cost a
  // tenth as much — so the capacity is expressed in ads judged, with
  // letters shown separately rather than mixed into one number.
  const remaining = budget == null ? null : Math.max(0, budget - spent.usd);
  const daysLeft = (() => {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return Math.max(1, end - now.getDate() + 1);
  })();

  const perMonth = budget == null ? null : Math.floor(budget / unit.score);
  const capacity = budget == null ? null : {
    month: perMonth,
    week: Math.floor(perMonth / 4.35),
    day: Math.floor(perMonth / 30.4),
    // What today can still afford given what the month has already used
    todayLeft: Math.floor((remaining / daysLeft) / unit.score),
  };

  return NextResponse.json({
    provider: p.llm_provider,
    models: { bulk: p.llm_model_bulk, write: p.llm_model_write },
    credit,
    budget,
    spent,
    remaining,
    daysLeft,
    unit,
    capacity,
    dailyScoreLimit: p.daily_score_limit,
  });
}

export async function PATCH(req) {
  const { monthly_budget_usd, daily_score_limit } = await req.json();
  const sets = [];
  const vals = [];

  if (monthly_budget_usd !== undefined) {
    const v = monthly_budget_usd === null ? null
      : Math.max(0, Math.min(1000, Number(monthly_budget_usd) || 0));
    vals.push(v); sets.push(`monthly_budget_usd = $${vals.length}`);
  }
  if (daily_score_limit !== undefined) {
    vals.push(Math.max(1, Math.min(2000, Number(daily_score_limit) || 1)));
    sets.push(`daily_score_limit = $${vals.length}`);
  }
  if (!sets.length) return NextResponse.json({ error: 'inget att ändra' }, { status: 400 });

  vals.push(await aktivProfilId());
  await pool.query(`UPDATE profile SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  return GET();
}
