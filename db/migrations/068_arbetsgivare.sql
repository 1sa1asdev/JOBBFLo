-- What kind of employer stands behind an ad: a company, the public
-- sector, a staffing agency or a recruitment firm. Read from SCB's
-- company register by organisation number, or guessed from the name
-- where SCB has no answer (or no key is set).

CREATE TABLE arbetsgivare (
  orgnr        text PRIMARY KEY,
  typ          text NOT NULL,
  kalla        text NOT NULL,
  sni          text,
  jurform      text,
  sektor       text,
  scb_status   text,
  scb_forsokt  timestamptz,
  uppdaterad   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT arbetsgivare_orgnr CHECK (orgnr ~ '^[0-9]{10}$' AND substr(orgnr, 3, 1) >= '2'),
  CONSTRAINT arbetsgivare_typ CHECK (typ IN ('foretag', 'offentlig', 'bemanning', 'rekrytering')),
  CONSTRAINT arbetsgivare_kalla CHECK (kalla IN ('scb', 'namn')),
  CONSTRAINT arbetsgivare_scb_status CHECK (scb_status IN ('hittad', 'saknas'))
);

ALTER TABLE arbetsgivare ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.arbetsgivare FROM anon, authenticated;
  END IF;
END
$$;

COMMENT ON TABLE arbetsgivare IS
  'One row per employer organisation number seen in Platsbanken ads: what kind of employer it is (src/arbetsgivare.js). '
  'Feeds the per-employer-type view of the Marknaden tab. Holds only what the classification needs — no name, address, '
  'phone or e-mail, although SCB returns them — and never a sole trader: their organisation number is a personal '
  'identity number (third digit 0 or 1), which the orgnr check refuses, so it is neither stored here nor sent to SCB. '
  'Source when kalla = scb: SCB:s allmänna företagsregister, bearbetat av Jobbflo (the terms require both).';
COMMENT ON COLUMN arbetsgivare.typ IS
  'foretag | offentlig (sector 13*, general government) | bemanning (SNI 78.2/78.3, hires staff out) | rekrytering (SNI 78.1, recruits for others).';
COMMENT ON COLUMN arbetsgivare.kalla IS
  'scb = from the register by organisation number; namn = guessed from the employer name, used until SCB answers.';
COMMENT ON COLUMN arbetsgivare.sni IS 'Primary SNI code (rangordning 1), digits only.';
COMMENT ON COLUMN arbetsgivare.scb_status IS
  'hittad = SCB knew the number (re-read after 180 days); saknas = SCB answered 404 (asked again after 30); NULL = not asked yet.';
