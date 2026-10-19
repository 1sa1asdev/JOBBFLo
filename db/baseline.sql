-- ============================================================
-- BASELINE — the schema as it stood after migration 043.
--
-- Generated once, on 2026-10-19, with pg_dump --schema-only from the
-- database that had every migration up to 043 applied by hand. It is
-- frozen: never edit it. Changes go in db/migrations/ as a new file,
-- and scripts/migrate.js applies them on top of this.
--
-- Why it exists: the 43 historical migrations were written against
-- whatever the database looked like at the time and were never run in
-- sequence from an empty database — and db/schema.sql, which db:init
-- used to apply, had fallen 7 tables, 27 indexes and ~130 columns
-- behind them. A fresh install got a broken app. This file is what a
-- fresh install now starts from, and it is exactly what production
-- ran on the day it was taken.
--
-- migrate.js reads the line below to know which migrations it covers.
-- baseline-covers: 043
-- ============================================================

--
-- PostgreSQL database dump
--

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

--
-- Name: ad_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ad_checks (
    ad_id uuid NOT NULL,
    cv_key text NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    score integer,
    summary text,
    must_missing text[],
    model text,
    checked_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: ads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    external_id text,
    fingerprint text NOT NULL,
    title text NOT NULL,
    employer text NOT NULL,
    employer_type text,
    municipality text,
    region text,
    description text NOT NULL,
    apply_email text,
    apply_url text,
    ats_vendor text,
    published_at timestamp with time zone,
    deadline date,
    removed_at timestamp with time zone,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    lon double precision GENERATED ALWAYS AS (((((raw -> 'workplace_address'::text) -> 'coordinates'::text) ->> 0))::double precision) STORED,
    lat double precision GENERATED ALWAYS AS (((((raw -> 'workplace_address'::text) -> 'coordinates'::text) ->> 1))::double precision) STORED,
    embedding public.vector(768),
    embedding_model text,
    embedded_at timestamp with time zone,
    apply_email_source text,
    apply_email_found_at timestamp with time zone,
    apply_url_opened_at timestamp with time zone,
    ad_profile jsonb,
    ad_profile_at timestamp with time zone,
    ad_profile_model text,
    fts tsvector GENERATED ALWAYS AS (to_tsvector('swedish'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(description, ''::text)))) STORED,
    profile_embedding public.vector(768),
    profile_embedded_at timestamp with time zone,
    CONSTRAINT ads_apply_email_source_check CHECK ((apply_email_source = ANY (ARRAY['api'::text, 'scanned'::text, 'manual'::text]))),
    CONSTRAINT ads_source_check CHECK ((source = ANY (ARRAY['platsbanken'::text, 'linkedin'::text, 'academicwork'::text, 'manual'::text])))
);

--
-- Name: COLUMN ads.lat; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ads.lat IS 'Workplace latitude, derived from raw. AF orders coordinates [lon, lat] — index 1 is lat.';

--
-- Name: COLUMN ads.embedding_model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ads.embedding_model IS 'Which model produced this vector. Vectors from different models must never be compared.';

--
-- Name: COLUMN ads.apply_email_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ads.apply_email_source IS 'api = published by Arbetsförmedlingen; scanned = read off the ad page and confirmed by the user; manual = typed in by hand.';

--
-- Name: COLUMN ads.apply_url_opened_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ads.apply_url_opened_at IS 'Last time the user opened this ad''s application link from inside the app. Gates the "✓ Sökt" button.';

--
-- Name: COLUMN ads.ad_profile; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ads.ad_profile IS 'The ad read into the CV profile''s vocabulary — see src/adprofile.js. Used for embedding and grading so both sides of the comparison have the same shape.';

--
-- Name: applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.applications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ad_id uuid NOT NULL,
    origin_search_id uuid,
    status text DEFAULT 'drafted'::text NOT NULL,
    subject text,
    letter_text text,
    letter_version integer DEFAULT 1 NOT NULL,
    message_id text,
    sent_to text,
    sent_from text,
    sent_at timestamp with time zone,
    followup_enabled boolean DEFAULT false NOT NULL,
    followup_days integer DEFAULT 10 NOT NULL,
    followup_sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    profile_id uuid NOT NULL,
    sent_by text DEFAULT 'user'::text NOT NULL,
    applied_via_url text,
    cv_file bytea,
    cv_filename text,
    cv_mime text,
    cv_text text,
    campaign_name text,
    claim_check jsonb,
    claim_checked_version integer,
    bounced_at timestamp with time zone,
    sending_since timestamp with time zone,
    CONSTRAINT applications_sent_by_check CHECK ((sent_by = ANY (ARRAY['user'::text, 'auto'::text, 'external'::text]))),
    CONSTRAINT applications_status_check CHECK ((status = ANY (ARRAY['drafted'::text, 'sending'::text, 'sent'::text, 'replied'::text, 'interview'::text, 'rejected'::text, 'ghosted'::text, 'withdrawn'::text, 'undeliverable'::text])))
);

--
-- Name: COLUMN applications.sent_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.applications.sent_by IS 'user = sent from the app by a click; auto = a campaign sent it; external = the user applied through the ad''s own link and told us afterwards (no message_id, excluded from calibration).';

--
-- Name: COLUMN applications.applied_via_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.applications.applied_via_url IS 'The ad link the user applied through. Its host is the only handle domain-based reply matching has for an external application.';

--
-- Name: COLUMN applications.cv_file; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.applications.cv_file IS 'Optional CV for THIS application only. Wins over the search''s tailored CV and the profile''s base CV. NULL = use those, as before.';

--
-- Name: COLUMN applications.campaign_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.applications.campaign_name IS 'The campaign name as it stood when this letter was sent. A historical fact, not a mirror: it deliberately does not follow later renames, and outlives the search being deleted.';

--
-- Name: COLUMN applications.claim_check; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.applications.claim_check IS 'Result of checkClaims(): the letter''s unsupported or contradicted claims, each quoted verbatim from the letter.';

--
-- Name: COLUMN applications.claim_checked_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.applications.claim_checked_version IS 'letter_version this check ran against. Differs from letter_version = the check is stale.';

--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    filename text NOT NULL,
    mime text,
    bytes bytea NOT NULL,
    size_bytes integer NOT NULL,
    include_by_default boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    search_id uuid
);

--
-- Name: auto_apply_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auto_apply_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    search_id uuid,
    ad_id uuid,
    application_id uuid,
    score integer,
    outcome text NOT NULL,
    detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: campaign_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    search_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campaign_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])))
);

--
-- Name: email_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    direction text NOT NULL,
    message_id text,
    in_reply_to text,
    references_ids text[],
    from_addr text NOT NULL,
    from_name text,
    to_addr text,
    subject text,
    body_text text,
    imap_uid bigint,
    sent_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_messages_direction_check CHECK ((direction = ANY (ARRAY['outbound'::text, 'inbound'::text])))
);

--
-- Name: imap_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.imap_state (
    mailbox text NOT NULL,
    uid_validity bigint,
    last_seen_uid bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: interview_prep; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.interview_prep (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    questions jsonb DEFAULT '[]'::jsonb NOT NULL,
    claimed_note text,
    gaps jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: lead_scans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lead_scans (
    ad_id uuid NOT NULL,
    scanned_at timestamp with time zone DEFAULT now() NOT NULL,
    ok boolean NOT NULL,
    contacts jsonb DEFAULT '[]'::jsonb NOT NULL,
    only_shared boolean DEFAULT false NOT NULL,
    reason text,
    host text
);

--
-- Name: TABLE lead_scans; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.lead_scans IS 'Cached result of reading an ad''s application page for a contact. A suggestion awaiting the user, never an address the campaign may use — that is ads.apply_email alone.';

--
-- Name: letter_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.letter_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    version integer NOT NULL,
    subject text,
    body text NOT NULL,
    change_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: llm_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    tier text,
    prompt_tokens integer,
    completion_tokens integer,
    total_tokens integer,
    usd numeric(12,8) DEFAULT 0 NOT NULL
);

--
-- Name: TABLE llm_usage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.llm_usage IS 'One row per LLM call, with the cost computed from the price in force at the time. The basis for the monthly budget; free tiers record 0 and still count towards volume.';

--
-- Name: match_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.match_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    search_id uuid NOT NULL,
    ad_id uuid NOT NULL,
    score integer,
    summary text,
    matched jsonb DEFAULT '[]'::jsonb NOT NULL,
    flags jsonb DEFAULT '[]'::jsonb NOT NULL,
    lead_project_id uuid,
    scored_at timestamp with time zone,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    queue_rank real,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    shortlisted_at timestamp with time zone,
    score_requested_at timestamp with time zone,
    score_reused_from uuid,
    check_cv_key text,
    CONSTRAINT match_results_score_check CHECK (((score >= 0) AND (score <= 100)))
);

--
-- Name: COLUMN match_results.shortlisted_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.match_results.shortlisted_at IS 'When the user shortlisted this ad. NULL = candidate, never scored. Scoring only runs on shortlisted rows.';

--
-- Name: never_apply; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.never_apply (
    fingerprint text NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: poll_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.poll_state (
    key text NOT NULL,
    cursor_ts timestamp with time zone,
    last_run_at timestamp with time zone,
    note text
);

--
-- Name: postcode_coords; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.postcode_coords AS
 SELECT replace(((raw -> 'workplace_address'::text) ->> 'postcode'::text), ' '::text, ''::text) AS postcode,
    avg(lat) AS lat,
    avg(lon) AS lon,
    count(*) AS ads
   FROM public.ads
  WHERE ((lat IS NOT NULL) AND (((raw -> 'workplace_address'::text) ->> 'postcode'::text) IS NOT NULL))
  GROUP BY (replace(((raw -> 'workplace_address'::text) ->> 'postcode'::text), ' '::text, ''::text));

--
-- Name: profile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profile (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    phone text,
    city text,
    cv_filename text,
    cv_text text,
    about_text text,
    tone_text text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid,
    llm_provider text,
    llm_api_key_enc text,
    llm_model_smart text,
    llm_model_fast text,
    llm_base_url text,
    cv_uploaded_at timestamp with time zone,
    cv_file bytea,
    cv_mime text,
    llm_model_bulk text,
    llm_model_write text,
    llm_keys_enc jsonb DEFAULT '{}'::jsonb NOT NULL,
    cv_profile jsonb,
    cv_profile_at timestamp with time zone,
    cv_profile_model text,
    home_lat double precision,
    home_lon double precision,
    home_label text,
    cv_embedding public.vector(768),
    cv_embedding_model text,
    cv_embedded_at timestamp with time zone,
    daily_score_limit integer DEFAULT 400 NOT NULL,
    embeddings_enabled boolean DEFAULT false NOT NULL,
    monthly_budget_usd numeric(10,2),
    CONSTRAINT profile_daily_score_limit_check CHECK ((daily_score_limit > 0))
);

--
-- Name: COLUMN profile.cv_profile; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profile.cv_profile IS 'Structured understanding of cv_text, built once per upload. Every fact carries verbatim evidence from the CV.';

--
-- Name: COLUMN profile.cv_profile_model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profile.cv_profile_model IS 'Which model produced it — a profile built by a weak model should be rebuilt, not trusted.';

--
-- Name: COLUMN profile.home_label; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profile.home_label IS 'What the user typed (postcode or place). Resolved to coordinates against ads.raw, so no external geocoder is involved.';

--
-- Name: COLUMN profile.daily_score_limit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profile.daily_score_limit IS 'Most ads that may be scored in one calendar day. Counted from match_results.scored_at; finding ads is free and not counted.';

--
-- Name: COLUMN profile.embeddings_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profile.embeddings_enabled IS 'Whether the worker may spend money embedding ads. False = the embed tick is skipped entirely; existing vectors are retained untouched.';

--
-- Name: COLUMN profile.monthly_budget_usd; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profile.monthly_budget_usd IS 'Optional ceiling on model spend per calendar month. NULL = uncapped. daily_score_limit is derived from this when set.';

--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    name text NOT NULL,
    summary text NOT NULL,
    tech text[] DEFAULT '{}'::text[] NOT NULL,
    url text,
    is_active boolean DEFAULT true NOT NULL
);

--
-- Name: search_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    search_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    meta jsonb,
    CONSTRAINT search_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])))
);

--
-- Name: searches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.searches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    name text NOT NULL,
    criteria_text text NOT NULL,
    api_filters jsonb DEFAULT '{}'::jsonb NOT NULL,
    email_alias text,
    scan_enabled boolean DEFAULT true NOT NULL,
    scan_interval interval DEFAULT '01:00:00'::interval NOT NULL,
    last_scanned_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    cv_text text,
    cv_filename text,
    location text[],
    remote_ok boolean,
    cv_file bytea,
    cv_mime text,
    auto_apply_enabled boolean DEFAULT false NOT NULL,
    auto_apply_min_score integer DEFAULT 85 NOT NULL,
    auto_apply_daily_limit integer DEFAULT 3 NOT NULL,
    auto_apply_paused_reason text,
    campaign_subject text,
    campaign_letter text,
    campaign_letter_approved_at timestamp with time zone,
    apply_filter text,
    fetch_offset integer DEFAULT 0 NOT NULL,
    fetch_total integer,
    fetch_done_at timestamp with time zone,
    dropped_filters text[],
    cv_profile jsonb,
    cv_profile_at timestamp with time zone,
    cv_profile_model text,
    criteria_changed_at timestamp with time zone,
    query_embedding public.vector(768),
    query_embedding_model text,
    query_embedded_at timestamp with time zone,
    campaign_created_at timestamp with time zone,
    auto_apply_require_score boolean DEFAULT true NOT NULL,
    must_criteria text,
    location_ratio jsonb,
    send_batch_size integer DEFAULT 10,
    send_batch_minutes integer DEFAULT 5,
    last_batch_at timestamp with time zone,
    send_days smallint[],
    send_from time without time zone,
    send_to time without time zone,
    parsed_filters jsonb,
    CONSTRAINT searches_apply_filter_check CHECK ((apply_filter = ANY (ARRAY['email'::text, 'any'::text, 'external'::text]))),
    CONSTRAINT searches_send_batch_minutes_check CHECK (((send_batch_minutes >= 1) AND (send_batch_minutes <= 240))),
    CONSTRAINT searches_send_batch_size_check CHECK (((send_batch_size >= 1) AND (send_batch_size <= 50)))
);

--
-- Name: COLUMN searches.location; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.searches.location IS 'Places the user picked explicitly, municipalities and/or län. Each is routed to api_filters.municipality or .region by taxonomy type; JobSearch ORs them.';

--
-- Name: COLUMN searches.apply_filter; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.searches.apply_filter IS 'Which application methods to score: email | any | external. Applied at queue time so excluded ads cost nothing.';

--
-- Name: COLUMN searches.fetch_offset; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.searches.fetch_offset IS 'Next offset to request from JobSearch. Advances each scan, wraps to 0 when the result set is exhausted.';

--
-- Name: COLUMN searches.fetch_total; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.searches.fetch_total IS 'Total hits the API last reported for these filters — how deep the pool goes.';

--
-- Name: COLUMN searches.dropped_filters; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.searches.dropped_filters IS 'Filters JobSearch rejected (0 hits) and the broadening ladder removed. Surfaced in the UI so a silently-ignored requirement is visible.';

--
-- Name: COLUMN searches.criteria_changed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.searches.criteria_changed_at IS 'When criteria_text last changed. A match_result scored before this was judged against different criteria — stale, not invalid.';

--
-- Name: COLUMN searches.campaign_created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.searches.campaign_created_at IS 'Set when the user creates a campaign on this search; cleared when they remove it. NULL = an ordinary search, never shown in the Kampanjer list.';

--
-- Name: COLUMN searches.auto_apply_require_score; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.searches.auto_apply_require_score IS 'false = the campaign may apply to ads no model has judged, using the API filters alone. An ad that already has a score must still clear auto_apply_min_score.';

--
-- Name: COLUMN searches.must_criteria; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.searches.must_criteria IS 'Free-text hard requirement judged by the model during scoring, e.g. "bara juniora roller". Caps the score when unmet. Requires auto_apply_require_score = true to have any effect.';

--
-- Name: COLUMN searches.location_ratio; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.searches.location_ratio IS 'Optional {place: weight} split for the daily letters, keyed by the same names as searches.location. Weights are relative, not percentages. NULL = no preference, score order alone.';

--
-- Name: COLUMN searches.send_batch_size; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.searches.send_batch_size IS 'Most letters one run may send, or NULL to send the day''s whole allowance at once. The daily limit is still the ceiling.';

--
-- Name: COLUMN searches.send_batch_minutes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.searches.send_batch_minutes IS 'Quiet period between scheduled batches. A manual run ignores it — the user is standing there — but is still limited to one batch.';

--
-- Name: COLUMN searches.send_days; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.searches.send_days IS 'ISO weekdays the campaign may send on (1=Monday). NULL = any day. Evaluated in Europe/Stockholm, not UTC.';

--
-- Name: COLUMN searches.send_from; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.searches.send_from IS 'Start of the daily sending window in Europe/Stockholm. NULL = no restriction. If send_from > send_to the window wraps past midnight.';

--
-- Name: search_results; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.search_results AS
 SELECT m.search_id,
    a.id AS ad_id,
    a.title,
    a.employer,
    a.municipality,
    a.deadline,
    a.ats_vendor,
    m.score,
    m.summary,
    m.flags,
    (m.score IS NULL) AS pending,
    (m.shortlisted_at IS NOT NULL) AS shortlisted,
    m.shortlisted_at,
    (m.score_requested_at IS NOT NULL) AS score_requested,
    m.score_requested_at,
    m.queued_at,
    m.attempts,
    m.last_error,
    app.status AS application_status,
    app.sent_at,
    app.origin_search_id,
    ((app.id IS NOT NULL) AND (m.search_id <> app.origin_search_id)) AS applied_via_other_search,
    (na.fingerprint IS NOT NULL) AS suppressed
   FROM ((((public.match_results m
     JOIN public.searches s ON ((s.id = m.search_id)))
     JOIN public.ads a ON ((a.id = m.ad_id)))
     LEFT JOIN public.applications app ON (((app.ad_id = a.id) AND (app.profile_id = s.profile_id))))
     LEFT JOIN public.never_apply na ON ((na.fingerprint = a.fingerprint)))
  WHERE (a.removed_at IS NULL);

--
-- Name: suggested_replies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suggested_replies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    reply_to_id uuid,
    body text NOT NULL,
    kind text DEFAULT 'reply'::text NOT NULL,
    dismissed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT suggested_replies_kind_check CHECK ((kind = ANY (ARRAY['reply'::text, 'followup'::text])))
);

--
-- Name: taxonomy_vectors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.taxonomy_vectors (
    type text NOT NULL,
    concept_id text NOT NULL,
    label text NOT NULL,
    embedding public.vector(768) NOT NULL
);

--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: ad_checks ad_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_checks
    ADD CONSTRAINT ad_checks_pkey PRIMARY KEY (ad_id, cv_key);

--
-- Name: ads ads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ads
    ADD CONSTRAINT ads_pkey PRIMARY KEY (id);

--
-- Name: applications applications_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_message_id_key UNIQUE (message_id);

--
-- Name: applications applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_pkey PRIMARY KEY (id);

--
-- Name: applications applications_profile_ad; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_profile_ad UNIQUE (profile_id, ad_id);

--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);

--
-- Name: auto_apply_log auto_apply_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_apply_log
    ADD CONSTRAINT auto_apply_log_pkey PRIMARY KEY (id);

--
-- Name: campaign_messages campaign_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_messages
    ADD CONSTRAINT campaign_messages_pkey PRIMARY KEY (id);

--
-- Name: email_messages email_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_messages
    ADD CONSTRAINT email_messages_pkey PRIMARY KEY (id);

--
-- Name: imap_state imap_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imap_state
    ADD CONSTRAINT imap_state_pkey PRIMARY KEY (mailbox);

--
-- Name: interview_prep interview_prep_application_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interview_prep
    ADD CONSTRAINT interview_prep_application_id_key UNIQUE (application_id);

--
-- Name: interview_prep interview_prep_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interview_prep
    ADD CONSTRAINT interview_prep_pkey PRIMARY KEY (id);

--
-- Name: lead_scans lead_scans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_scans
    ADD CONSTRAINT lead_scans_pkey PRIMARY KEY (ad_id);

--
-- Name: letter_versions letter_versions_application_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.letter_versions
    ADD CONSTRAINT letter_versions_application_id_version_key UNIQUE (application_id, version);

--
-- Name: letter_versions letter_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.letter_versions
    ADD CONSTRAINT letter_versions_pkey PRIMARY KEY (id);

--
-- Name: llm_usage llm_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage
    ADD CONSTRAINT llm_usage_pkey PRIMARY KEY (id);

--
-- Name: match_results match_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match_results
    ADD CONSTRAINT match_results_pkey PRIMARY KEY (id);

--
-- Name: match_results match_results_search_id_ad_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match_results
    ADD CONSTRAINT match_results_search_id_ad_id_key UNIQUE (search_id, ad_id);

--
-- Name: never_apply never_apply_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.never_apply
    ADD CONSTRAINT never_apply_pkey PRIMARY KEY (fingerprint);

--
-- Name: poll_state poll_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.poll_state
    ADD CONSTRAINT poll_state_pkey PRIMARY KEY (key);

--
-- Name: profile profile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profile
    ADD CONSTRAINT profile_pkey PRIMARY KEY (id);

--
-- Name: profile profile_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profile
    ADD CONSTRAINT profile_user_id_key UNIQUE (user_id);

--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

--
-- Name: search_messages search_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_messages
    ADD CONSTRAINT search_messages_pkey PRIMARY KEY (id);

--
-- Name: searches searches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.searches
    ADD CONSTRAINT searches_pkey PRIMARY KEY (id);

--
-- Name: suggested_replies suggested_replies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suggested_replies
    ADD CONSTRAINT suggested_replies_pkey PRIMARY KEY (id);

--
-- Name: taxonomy_vectors taxonomy_vectors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.taxonomy_vectors
    ADD CONSTRAINT taxonomy_vectors_pkey PRIMARY KEY (type, concept_id);

--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

--
-- Name: ads_closed_with_vector_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_closed_with_vector_idx ON public.ads USING btree (id) WHERE ((embedding IS NOT NULL) AND ((removed_at IS NOT NULL) OR (deadline IS NOT NULL)));

--
-- Name: ads_deadline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_deadline ON public.ads USING btree (deadline) WHERE (removed_at IS NULL);

--
-- Name: ads_embedding_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_embedding_hnsw ON public.ads USING hnsw (embedding public.vector_cosine_ops) WHERE (embedding IS NOT NULL);

--
-- Name: ads_fingerprint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_fingerprint ON public.ads USING btree (fingerprint);

--
-- Name: ads_fingerprint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_fingerprint_idx ON public.ads USING btree (fingerprint);

--
-- Name: ads_latlon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_latlon ON public.ads USING btree (lat, lon) WHERE (lat IS NOT NULL);

--
-- Name: ads_needs_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_needs_embedding ON public.ads USING btree (published_at DESC NULLS LAST) WHERE ((embedding IS NULL) AND (removed_at IS NULL));

--
-- Name: ads_needs_profile_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_needs_profile_idx ON public.ads USING btree (published_at DESC NULLS LAST) WHERE ((ad_profile IS NULL) AND (removed_at IS NULL));

--
-- Name: ads_open_deadline_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_open_deadline_idx ON public.ads USING btree (deadline) WHERE (removed_at IS NULL);

--
-- Name: ads_open_employment_c_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_open_employment_c_idx ON public.ads USING btree ((((raw -> 'employment_type'::text) ->> 'concept_id'::text))) WHERE (removed_at IS NULL);

--
-- Name: ads_open_field_c_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_open_field_c_idx ON public.ads USING btree ((((raw -> 'occupation_field'::text) ->> 'concept_id'::text))) WHERE (removed_at IS NULL);

--
-- Name: ads_open_fts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_open_fts_idx ON public.ads USING gin (fts) WHERE (removed_at IS NULL);

--
-- Name: ads_open_group_c_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_open_group_c_idx ON public.ads USING btree ((((raw -> 'occupation_group'::text) ->> 'concept_id'::text))) WHERE (removed_at IS NULL);

--
-- Name: ads_open_muni_c_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_open_muni_c_idx ON public.ads USING btree ((((raw -> 'workplace_address'::text) ->> 'municipality_concept_id'::text))) WHERE (removed_at IS NULL);

--
-- Name: ads_open_name_c_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_open_name_c_idx ON public.ads USING btree ((((raw -> 'occupation'::text) ->> 'concept_id'::text))) WHERE (removed_at IS NULL);

--
-- Name: ads_open_region_c_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_open_region_c_idx ON public.ads USING btree ((((raw -> 'workplace_address'::text) ->> 'region_concept_id'::text))) WHERE (removed_at IS NULL);

--
-- Name: ads_open_worktime_c_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_open_worktime_c_idx ON public.ads USING btree ((((raw -> 'working_hours_type'::text) ->> 'concept_id'::text))) WHERE (removed_at IS NULL);

--
-- Name: ads_profile_vec_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ads_profile_vec_idx ON public.ads USING hnsw (profile_embedding public.vector_cosine_ops) WHERE (removed_at IS NULL);

--
-- Name: ads_source_external; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ads_source_external ON public.ads USING btree (source, external_id) WHERE (external_id IS NOT NULL);

--
-- Name: applications_auto_one_per_address; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX applications_auto_one_per_address ON public.applications USING btree (profile_id, lower(sent_to)) WHERE ((sent_by = 'auto'::text) AND (sent_to IS NOT NULL));

--
-- Name: applications_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX applications_message_id ON public.applications USING btree (message_id);

--
-- Name: applications_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX applications_status ON public.applications USING btree (status);

--
-- Name: attachments_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attachments_profile ON public.attachments USING btree (profile_id);

--
-- Name: attachments_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attachments_search ON public.attachments USING btree (search_id);

--
-- Name: auto_apply_log_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auto_apply_log_time ON public.auto_apply_log USING btree (created_at DESC);

--
-- Name: campaign_messages_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_messages_search ON public.campaign_messages USING btree (search_id, created_at);

--
-- Name: email_messages_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_messages_app ON public.email_messages USING btree (application_id, sent_at);

--
-- Name: email_messages_inreplyto; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_messages_inreplyto ON public.email_messages USING btree (in_reply_to);

--
-- Name: email_messages_msgid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_messages_msgid ON public.email_messages USING btree (message_id);

--
-- Name: lead_scans_ok; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lead_scans_ok ON public.lead_scans USING btree (ok, scanned_at DESC);

--
-- Name: llm_usage_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_usage_at ON public.llm_usage USING btree (at DESC);

--
-- Name: match_results_candidates; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX match_results_candidates ON public.match_results USING btree (search_id) WHERE ((shortlisted_at IS NULL) AND (score IS NULL));

--
-- Name: match_results_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX match_results_pending ON public.match_results USING btree (search_id, queue_rank DESC NULLS LAST) WHERE (score IS NULL);

--
-- Name: match_results_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX match_results_score ON public.match_results USING btree (search_id, score DESC);

--
-- Name: match_results_scored_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX match_results_scored_at ON public.match_results USING btree (scored_at) WHERE (scored_at IS NOT NULL);

--
-- Name: match_results_to_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX match_results_to_score ON public.match_results USING btree (search_id, score_requested_at) WHERE ((score_requested_at IS NOT NULL) AND (score IS NULL));

--
-- Name: taxonomy_vectors_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX taxonomy_vectors_hnsw ON public.taxonomy_vectors USING hnsw (embedding public.vector_cosine_ops);

--
-- Name: ad_checks ad_checks_ad_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_checks
    ADD CONSTRAINT ad_checks_ad_id_fkey FOREIGN KEY (ad_id) REFERENCES public.ads(id) ON DELETE CASCADE;

--
-- Name: applications applications_ad_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_ad_id_fkey FOREIGN KEY (ad_id) REFERENCES public.ads(id) ON DELETE CASCADE;

--
-- Name: applications applications_origin_search_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_origin_search_id_fkey FOREIGN KEY (origin_search_id) REFERENCES public.searches(id) ON DELETE SET NULL;

--
-- Name: applications applications_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profile(id) ON DELETE CASCADE;

--
-- Name: attachments attachments_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profile(id) ON DELETE CASCADE;

--
-- Name: attachments attachments_search_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_search_id_fkey FOREIGN KEY (search_id) REFERENCES public.searches(id) ON DELETE CASCADE;

--
-- Name: auto_apply_log auto_apply_log_ad_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_apply_log
    ADD CONSTRAINT auto_apply_log_ad_id_fkey FOREIGN KEY (ad_id) REFERENCES public.ads(id) ON DELETE SET NULL;

--
-- Name: auto_apply_log auto_apply_log_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_apply_log
    ADD CONSTRAINT auto_apply_log_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE SET NULL;

--
-- Name: auto_apply_log auto_apply_log_search_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_apply_log
    ADD CONSTRAINT auto_apply_log_search_id_fkey FOREIGN KEY (search_id) REFERENCES public.searches(id) ON DELETE SET NULL;

--
-- Name: campaign_messages campaign_messages_search_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_messages
    ADD CONSTRAINT campaign_messages_search_id_fkey FOREIGN KEY (search_id) REFERENCES public.searches(id) ON DELETE CASCADE;

--
-- Name: email_messages email_messages_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_messages
    ADD CONSTRAINT email_messages_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;

--
-- Name: interview_prep interview_prep_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interview_prep
    ADD CONSTRAINT interview_prep_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;

--
-- Name: lead_scans lead_scans_ad_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_scans
    ADD CONSTRAINT lead_scans_ad_id_fkey FOREIGN KEY (ad_id) REFERENCES public.ads(id) ON DELETE CASCADE;

--
-- Name: letter_versions letter_versions_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.letter_versions
    ADD CONSTRAINT letter_versions_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;

--
-- Name: match_results match_results_ad_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match_results
    ADD CONSTRAINT match_results_ad_id_fkey FOREIGN KEY (ad_id) REFERENCES public.ads(id) ON DELETE CASCADE;

--
-- Name: match_results match_results_lead_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match_results
    ADD CONSTRAINT match_results_lead_project_id_fkey FOREIGN KEY (lead_project_id) REFERENCES public.projects(id);

--
-- Name: match_results match_results_score_reused_from_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match_results
    ADD CONSTRAINT match_results_score_reused_from_fkey FOREIGN KEY (score_reused_from) REFERENCES public.match_results(id) ON DELETE SET NULL;

--
-- Name: match_results match_results_search_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.match_results
    ADD CONSTRAINT match_results_search_id_fkey FOREIGN KEY (search_id) REFERENCES public.searches(id) ON DELETE CASCADE;

--
-- Name: profile profile_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profile
    ADD CONSTRAINT profile_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: projects projects_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profile(id) ON DELETE CASCADE;

--
-- Name: search_messages search_messages_search_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_messages
    ADD CONSTRAINT search_messages_search_id_fkey FOREIGN KEY (search_id) REFERENCES public.searches(id) ON DELETE CASCADE;

--
-- Name: searches searches_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.searches
    ADD CONSTRAINT searches_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profile(id) ON DELETE CASCADE;

--
-- Name: suggested_replies suggested_replies_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suggested_replies
    ADD CONSTRAINT suggested_replies_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;

--
-- Name: suggested_replies suggested_replies_reply_to_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suggested_replies
    ADD CONSTRAINT suggested_replies_reply_to_id_fkey FOREIGN KEY (reply_to_id) REFERENCES public.email_messages(id) ON DELETE CASCADE;

--
-- PostgreSQL database dump complete
--

-- ------------------------------------------------------------
-- Reference rows the worker expects to exist. pollJobStream reads the
-- 'jobstream' cursor without a fallback, so a database without it
-- crashes the worker on its first tick. (Taken from the old
-- db/schema.sql, which carried them.)
-- ------------------------------------------------------------
INSERT INTO public.poll_state (key, cursor_ts) VALUES ('jobstream', now() - interval '1 day')
  ON CONFLICT DO NOTHING;
INSERT INTO public.poll_state (key, note) VALUES ('imap', 'lastSeenUid stored in cursor_ts=null, see imap_state')
  ON CONFLICT DO NOTHING;
