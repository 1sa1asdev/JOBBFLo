-- Keep every industry code SCB gives an employer, with its share, so the
-- employer type can be recomputed when the rule changes instead of asking
-- SCB again — and ask again for the employers that were judged before the
-- rule looked past the main code.

ALTER TABLE arbetsgivare ADD COLUMN naringsgrenar jsonb;

COMMENT ON COLUMN arbetsgivare.naringsgrenar IS
  'Every SNI code SCB gives the employer, by rank, with its share of the business: [{"sni":"70100","andel":62},{"sni":"78100","andel":38}]. '
  'The type is computed from these (src/arbetsgivare.js typFrånScb), so a changed rule is applied by recomputing, '
  'not by asking SCB again (omklassaLagrade). NULL for name guesses, and for rows read before migration 070.';

-- Read before the secondary-industry rule (staffing or recruitment from
-- 25 % of the business counts), these were judged on the main code
-- alone. Only a company can come out differently, so those are marked
-- unasked and the janitor reads them again — which also fills the
-- column above.
UPDATE arbetsgivare SET scb_status = NULL
WHERE kalla = 'scb' AND typ = 'foretag' AND naringsgrenar IS NULL;
