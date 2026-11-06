-- Arbetsförmedlingen's occupational forecast (Yrkesbarometern, CC0):
-- per occupation and county, the chances of getting work, the
-- recruitment situation and the five-year outlook. Shown in the
-- Marknaden tab (best and worst placed occupations) and in the search
-- chat (how the market looks for what the search finds).

CREATE TABLE yrkesprognos (
  omgang           text NOT NULL,
  yb_id            text NOT NULL,
  lan              text NOT NULL,
  yrke             text NOT NULL,
  yrkesomrade      text,
  jobbmojligheter  text,
  rekrytering      text,
  prognos          text,
  text_jobb        text,
  PRIMARY KEY (omgang, yb_id, lan),
  CONSTRAINT yrkesprognos_jobbmojligheter CHECK (jobbmojligheter IN ('små', 'medelstora', 'stora')),
  CONSTRAINT yrkesprognos_lan CHECK (lan ~ '^[0-9]{2}$')
);

CREATE TABLE yrkesprognos_yrke (
  omgang      text NOT NULL,
  concept_id  text NOT NULL,
  yb_id       text NOT NULL,
  PRIMARY KEY (omgang, concept_id)
);

CREATE TABLE lan_region (
  lan                text PRIMARY KEY,
  region_concept_id  text NOT NULL UNIQUE,
  namn               text NOT NULL
);

INSERT INTO lan_region (lan, region_concept_id, namn) VALUES
  ('01', 'CifL_Rzy_Mku', 'Stockholms län'),
  ('03', 'zBon_eET_fFU', 'Uppsala län'),
  ('04', 's93u_BEb_sx2', 'Södermanlands län'),
  ('05', 'oLT3_Q9p_3nn', 'Östergötlands län'),
  ('06', 'MtbE_xWT_eMi', 'Jönköpings län'),
  ('07', 'tF3y_MF9_h5G', 'Kronobergs län'),
  ('08', '9QUH_2bb_6Np', 'Kalmar län'),
  ('09', 'K8iD_VQv_2BA', 'Gotlands län'),
  ('10', 'DQZd_uYs_oKb', 'Blekinge län'),
  ('12', 'CaRE_1nn_cSU', 'Skåne län'),
  ('13', 'wjee_qH2_yb6', 'Hallands län'),
  ('14', 'zdoY_6u5_Krt', 'Västra Götalands län'),
  ('17', 'EVVp_h6U_GSZ', 'Värmlands län'),
  ('18', 'xTCk_nT5_Zjm', 'Örebro län'),
  ('19', 'G6DV_fKE_Viz', 'Västmanlands län'),
  ('20', 'oDpK_oZ2_WYt', 'Dalarnas län'),
  ('21', 'zupA_8Nt_xcD', 'Gävleborgs län'),
  ('22', 'NvUF_SP1_1zo', 'Västernorrlands län'),
  ('23', '65Ms_7r1_RTG', 'Jämtlands län'),
  ('24', 'g5Tt_CAV_zBd', 'Västerbottens län'),
  ('25', '9hXe_F4g_eTG', 'Norrbottens län');

ALTER TABLE yrkesprognos ENABLE ROW LEVEL SECURITY;
ALTER TABLE yrkesprognos_yrke ENABLE ROW LEVEL SECURITY;
ALTER TABLE lan_region ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.yrkesprognos, public.yrkesprognos_yrke, public.lan_region FROM anon, authenticated;
  END IF;
END
$$;

COMMENT ON TABLE yrkesprognos IS
  'Arbetsförmedlingen''s Yrkesbarometer (open data, CC0), one row per edition x occupation x county; lan 00 is the national '
  'assessment. Every edition is kept: the previous one is what "worse than last time" compares against, and the history is '
  'what Jobbflo''s own outcomes will one day be held up to. Loaded by the janitor (src/yrkesbarometer.js).';
COMMENT ON COLUMN yrkesprognos.omgang IS 'Edition, e.g. 2026-1 (two a year). Sorts as text.';
COMMENT ON COLUMN yrkesprognos.yb_id IS 'The Yrkesbarometer occupation (yb_concept_id), which may span several SSYK groups.';
COMMENT ON COLUMN yrkesprognos.jobbmojligheter IS 'Chances of work now and over the coming year. NULL where AF had too little to assess.';
COMMENT ON COLUMN yrkesprognos.rekrytering IS 'brist | balans | överskott | paradox (shortage although many are looking).';
COMMENT ON COLUMN yrkesprognos.prognos IS 'Five-year outlook for demand: öka | vara oförändrad | minska.';
COMMENT ON TABLE yrkesprognos_yrke IS
  'Which Yrkesbarometer occupation an ad''s occupation (raw->occupation->concept_id, a taxonomy occupation-name) belongs to. '
  'From AF''s relations file; covers about 80 % of open ads.';
COMMENT ON TABLE lan_region IS
  'County code (as in the Yrkesbarometer) to the region concept_id the ads carry. The 21 counties are fixed in the taxonomy.';
