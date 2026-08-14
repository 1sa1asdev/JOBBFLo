import { pool } from './db.js';
import { llmJson } from './llm.js';
import { parseCriteria, scanSearch } from './score.js';

// ------------------------------------------------------------
// The search-criteria conversation. Each saved search is one
// chat: user messages refine criteria_text, which drives both
// layer-1 filters and layer-2 scoring.
// ------------------------------------------------------------

const MERGE_SYSTEM = `Du hjälper en jobbsökande att förfina sina sökkriterier.

Du får de NUVARANDE kriterierna (fritext) och ett NYTT meddelande från användaren.
Slå ihop dem till en uppdaterad kriterietext som fångar allt användaren sagt hittills —
inklusive undantag och nyanser ("okej med lite .NET, men inte mainframe-legacy").

Svara ENDAST med JSON, inga kodstaket:
{"criteria": "den sammanslagna kriterietexten", "reply": "kort bekräftelse till användaren på svenska, nämn vad som ändrades"}`;

export async function chatTurn(searchId, userMessage) {
  const { rows: [search] } = await pool.query(
    `SELECT * FROM searches WHERE id = $1 AND deleted_at IS NULL`, [searchId]
  );
  if (!search) throw new Error(`no search ${searchId}`);

  await pool.query(
    `INSERT INTO search_messages (search_id, role, content) VALUES ($1, 'user', $2)`,
    [searchId, userMessage]
  );

  const { criteria, reply } = await llmJson({
    tier: 'write',
    maxTokens: 1000,
    system: MERGE_SYSTEM,
    messages: [{
      role: 'user',
      content: `## NUVARANDE KRITERIER\n${search.criteria_text}\n\n## NYTT MEDDELANDE\n${userMessage}`,
    }],
  });

  // re-parse layer-1 filters from the merged criteria
  const { filters } = await parseCriteria(criteria);

  await pool.query(
    `UPDATE searches SET criteria_text = $2, api_filters = $3 WHERE id = $1`,
    [searchId, criteria, JSON.stringify(filters)]
  );
  await pool.query(
    `INSERT INTO search_messages (search_id, role, content) VALUES ($1, 'assistant', $2)`,
    [searchId, reply]
  );

  // stale scores: criteria changed, so re-score this search's pool.
  // match_results are per-search, so this touches nothing else.
  await pool.query(`DELETE FROM match_results WHERE search_id = $1`, [searchId]);
  scanSearch(searchId, { limit: 30 }).catch((e) =>
    console.error(`rescan ${searchId}:`, e.message)
  );

  return { reply, criteria, filters };
}
