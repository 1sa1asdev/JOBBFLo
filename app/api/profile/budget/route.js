import { NextResponse } from 'next/server';
import { pool } from '../../../../src/db.js';
import { unitCosts, spendThisMonth } from '../../../../src/prices.js';
import { decryptSecret } from '../../../../src/secrets.js';

export const dynamic = 'force-dynamic';

// What is left at the provider. Only OpenRouter publishes this; the
// others either bill afterwards or are free, and inventing a number for
// them would be worse than saying nothing.
async function providerCredit(provider, key) {
  if (provider !== 'openrouter' || !key) return null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const { data } = await res.json();
    const bought = Number(data.total_credits) || 0;
    const used = Number(data.total_usage) || 0;
    return { bought, used, left: bought - used };
  } catch { return null; }
}

export async function GET() {
  const { rows: [p] } = await pool.query(
    `SELECT monthly_budget_usd, daily_score_limit, llm_provider,
            llm_api_key_enc, llm_model_bulk, llm_model_write
     FROM profile LIMIT 1`);
  if (!p) return NextResponse.json({ error: 'ingen profil' }, { status: 400 });

  const [unit, spent, credit] = await Promise.all([
    unitCosts(),
    spendThisMonth(),
    providerCredit(p.llm_provider, decryptSecret(p.llm_api_key_enc)
      || process.env.OPENROUTER_API_KEY),
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

  await pool.query(`UPDATE profile SET ${sets.join(', ')}`, vals);
  return GET();
}
