import { pool } from './db.js';
import { llmJson } from './llm.js';
import { parseCriteria, scanSearch } from './score.js';
import { mergeReparsed, orterIFilter } from './filterMerge.js';

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

  // re-parse layer-1 filters from the merged criteria, keeping what
  // the user switched by hand unless this message spoke to it
  const { filters: parsed } = await parseCriteria(criteria);
  const { filters, behållna } = mergeReparsed({
    current: search.api_filters, prevParsed: search.parsed_filters, newParsed: parsed,
  });
  if (behållna.length) console.log(`omtolkning: behöll handvalda filter ${behållna.join(', ')}`);

  await pool.query(
    `UPDATE searches SET criteria_text = $2, api_filters = $3, parsed_filters = $4,
       location = $5::text[]
     WHERE id = $1`,
    [searchId, criteria, JSON.stringify(filters), JSON.stringify(parsed || {}), orterIFilter(filters)]
  );
  await pool.query(
    `INSERT INTO search_messages (search_id, role, content) VALUES ($1, 'assistant', $2)`,
    [searchId, reply]
  );

  // Criteria changed. Clear the free candidate pool — those were found
  // under the old filters and may not match the new ones — but NEVER
  // touch a row the user favourited or paid to have scored. Deleting
  // those threw away human decisions and bought verdicts alike, which
  // is what made editing the criteria feel like it reset the search.
  //
  // Scores made under the old criteria are now merely stale: they stay,
  // and `scored_at < criteria_changed_at` lets the UI say so and offer
  // a re-score rather than deciding for the user.
  const { rowCount: dropped } = await pool.query(
    `DELETE FROM match_results
     WHERE search_id = $1 AND shortlisted_at IS NULL AND score IS NULL`,
    [searchId]
  );
  await pool.query(
    `UPDATE searches SET criteria_changed_at = now(), fetch_offset = 0,
       fetch_total = NULL, fetch_done_at = NULL
     WHERE id = $1`, [searchId]
  );
  const { rows: [kept] } = await pool.query(
    `SELECT count(*) FILTER (WHERE shortlisted_at IS NOT NULL) AS favoriter,
            count(score) AS bedomda
     FROM match_results WHERE search_id = $1`, [searchId]
  );
  console.log(`kriterier ändrade: ${dropped} kandidater rensade, `
    + `${kept.favoriter} favoriter och ${kept.bedomda} bedömningar behållna`);
  scanSearch(searchId, { pages: 2 }).catch((e) =>
    console.error(`rescan ${searchId}:`, e.message)
  );

  return { reply, criteria, filters };
}
