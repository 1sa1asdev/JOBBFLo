-- ============================================================
-- The schema's explanations, moved into the schema.
--
-- db/schema.sql used to be hand-written, and its comments were the
-- best documentation of why the core tables look the way they do. It
-- was also 7 tables, 27 indexes and ~130 columns behind the real
-- database, because nothing made anyone keep it in step. It is now
-- generated from a migrated database (npm run db:schema) and checked in
-- CI, so it can no longer be wrong — and comments written in a SQL
-- file would not survive the generation.
--
-- COMMENT ON does. It travels with the schema into the generated file,
-- into pg_dump, and into Supabase's table editor. These are the old
-- file's explanations, for the tables and columns that had no comment
-- yet; the 34 column comments earlier migrations wrote are untouched.
-- ============================================================

COMMENT ON TABLE public.users IS
  'Login identity. One account = one profile.';

COMMENT ON TABLE public.profile IS
  'The user and their base CV. user_id is nullable so a seeded profile can be claimed by signing up with its email.';
COMMENT ON COLUMN public.profile.email IS
  'The Gmail address used for SMTP and IMAP.';
COMMENT ON COLUMN public.profile.about_text IS
  '"Om dig, i egna ord" — the user describing themselves, used in letters.';
COMMENT ON COLUMN public.profile.tone_text IS
  'Letter tone preferences.';
COMMENT ON COLUMN public.profile.home_lat IS
  'Where the user travels from, for the distance column. Resolved against the ad pool''s own coordinates (see postcode_coords), so no geocoding service ever sees a home address.';

COMMENT ON TABLE public.projects IS
  'The user''s projects, matched against ads. The letter generator picks which one to lead with per ad.';
COMMENT ON COLUMN public.projects.summary IS
  'One paragraph, used in letters.';

COMMENT ON TABLE public.searches IS
  'One saved search = one AI conversation. A campaign IS a search with auto-apply settings attached. Soft-deleted (deleted_at), because the inbox back-references it.';
COMMENT ON COLUMN public.searches.criteria_text IS
  'The user''s own words. Drives the vector ranking and the copilot.';
COMMENT ON COLUMN public.searches.email_alias IS
  'Plus-alias the search sends from (din+frontend@gmail.com), so replies can be traced back to it.';
COMMENT ON COLUMN public.searches.deleted_at IS
  'Soft delete: the inbox back-references must survive deletion. applications.origin_search_id is ON DELETE SET NULL for the same reason.';

COMMENT ON TABLE public.ads IS
  'GLOBAL: one row per real-world posting, whatever search found it and whatever source it came from (CLAUDE.md invariant 1). Filled by the JobStream poll and the daily snapshot; searches only read it (invariant 6).';
COMMENT ON COLUMN public.ads.external_id IS
  'Arbetsförmedlingen''s ad id. NULL for pasted ads. UNIQUE(source, external_id) is the hard dedupe.';
COMMENT ON COLUMN public.ads.fingerprint IS
  'Soft-dedupe key: employer + title + municipality, deliberately EXCLUDING deadline, since that is what changes on a repost. Matches are flagged for the user, never merged silently (invariant 4).';
COMMENT ON COLUMN public.ads.employer_type IS
  'agency | public | private | unknown — feeds response priors once there are outcomes.';
COMMENT ON COLUMN public.ads.ats_vendor IS
  'The hiring system behind apply_url: teamtailor | varbi | workday | reachmee | NULL.';
COMMENT ON COLUMN public.ads.removed_at IS
  'When the ad stopped being published — from JobStream, or from the janitor''s full snapshot. Searches read only rows where this is NULL.';

COMMENT ON TABLE public.match_results IS
  'PER-SEARCH: the same ad scores differently in different searches, and that is correct. A row is created the moment the search selects the ad, with score NULL meaning "queued, not judged yet" — the pending row IS the row that later gets its score, not a second one. Never denormalize application status onto this table; that is what the search_results view is for.';
COMMENT ON COLUMN public.match_results.score IS
  'NULL until judged. Copied from ad_checks.score, which is arithmetic over readable rows (invariant 7).';
COMMENT ON COLUMN public.match_results.matched IS
  '[{quote, why}] — verbatim ad quotes (invariant 5), used to highlight spans in the ad text.';
COMMENT ON COLUMN public.match_results.flags IS
  '[{quote, why}] — verbatim ad quotes for what the CV lacks; feeds the skills-gap report.';
COMMENT ON COLUMN public.match_results.score_requested_at IS
  'The user asked for a verdict on this ad. Requesting a score is a deliberate act on specific ads, separate from favouriting (shortlisted_at), which is free.';
COMMENT ON COLUMN public.match_results.attempts IS
  'Failed scoring attempts. One unreadable ad must not wedge the queue.';

COMMENT ON TABLE public.applications IS
  'PER-(USER, AD): UNIQUE(profile_id, ad_id) is the whole fix for the predecessor''s bug — a second search physically cannot create a second application for an ad the user already applied to.';
COMMENT ON COLUMN public.applications.origin_search_id IS
  'The search that produced it, for the inbox "find similar jobs" button. ON DELETE SET NULL + searches.deleted_at degrade it to "sökning borttagen" instead of breaking.';
COMMENT ON COLUMN public.applications.status IS
  '''sending'' is the row claiming itself before SMTP is called, so a letter Gmail accepted can never read as an unsent draft. ''undeliverable'' is a bounce, kept apart from ''rejected'' because the employer never saw it.';
COMMENT ON COLUMN public.applications.message_id IS
  'RFC Message-ID of the letter we sent. Reply matching depends on it.';
COMMENT ON COLUMN public.applications.sent_to IS
  'Recipient, written at claim time (status ''sending''), not after — it is the only thing that can find a letter whose send outcome is unknown.';
COMMENT ON COLUMN public.applications.sent_from IS
  'The plus-alias the letter went out from.';
COMMENT ON COLUMN public.applications.sending_since IS
  'When the send claim was taken. A row still ''sending'' is repaired by the Sent-folder sync.';

COMMENT ON TABLE public.letter_versions IS
  'Letter version history, for undo/redo in the revision chat.';
COMMENT ON TABLE public.email_messages IS
  'The thread, both directions.';
COMMENT ON COLUMN public.email_messages.imap_uid IS
  'For catch-up since the last seen UID after a dropped IDLE connection.';
COMMENT ON TABLE public.suggested_replies IS
  'AI-drafted replies and follow-up nudges. Never sent automatically (invariant 2).';
COMMENT ON TABLE public.interview_prep IS
  'Interview preparation, generated when an application reaches status ''interview''.';
COMMENT ON TABLE public.never_apply IS
  'Keyed on FINGERPRINT, not ad_id, so a repost with a fresh external_id stays suppressed.';
COMMENT ON TABLE public.poll_state IS
  'One global JobStream cursor: all searches score against the shared pool, never one fetch per search (invariant 3).';

COMMENT ON VIEW public.search_results IS
  'The query that fixes the predecessor''s bug: application status is a JOIN, not a sync. Same ad in two searches: two scores, one status.';
