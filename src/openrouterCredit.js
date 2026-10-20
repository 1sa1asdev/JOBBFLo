// ------------------------------------------------------------
// What is left on an OpenRouter key. Only OpenRouter publishes this; the
// other providers bill afterwards or are free, and inventing a number
// for them would be worse than saying nothing.
//
// Used for a user's own key (their budget panel) and for the platform's
// key (the admin page) — never one in place of the other.
// ------------------------------------------------------------
export async function openrouterKredit(key) {
  if (!key) return null;
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
