-- ============================================================
-- What reading an ad page found, kept.
--
-- Scanning is a network round trip to somebody else's server, so doing
-- it again every time the tab is opened is both slow and rude. The
-- result is cached per ad: the page is read once, and the user can come
-- back to the suggestion whenever they like.
--
-- Storing the finding is NOT the same as acting on it. Nothing here is
-- an address the app will write to — ads.apply_email stays the only
-- thing the campaign reads, and it is still only ever set by the user
-- confirming one of these.
-- ============================================================
CREATE TABLE lead_scans (
  ad_id      uuid PRIMARY KEY REFERENCES ads(id) ON DELETE CASCADE,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  ok         boolean NOT NULL,
  contacts   jsonb NOT NULL DEFAULT '[]'::jsonb,
  only_shared boolean NOT NULL DEFAULT false,
  reason     text,
  host       text
);

CREATE INDEX lead_scans_ok ON lead_scans (ok, scanned_at DESC);

COMMENT ON TABLE lead_scans IS
  'Cached result of reading an ad''s application page for a contact. A suggestion awaiting the user, never an address the campaign may use — that is ads.apply_email alone.';
