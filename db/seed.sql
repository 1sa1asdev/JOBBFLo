-- ============================================================
-- SEED — profile + projects.
--
-- EDIT THIS WITH YOUR REAL CV BEFORE RUNNING. Everything below is a
-- placeholder, and the grading is only as good as what you put here:
-- the checklist answers each requirement in an ad against THIS text,
-- and quotes it back to you. A skeleton CV produces a skeleton verdict.
--
-- Keep your real version out of git. The file is committed with
-- placeholders on purpose — a CV is personal data, and this repo is
-- public.
-- ============================================================

INSERT INTO profile (name, email, phone, city, cv_filename, cv_text, cv_parsed, about_text, tone_text)
VALUES (
  'Anna Andersson',
  'du@example.com',
  NULL,
  'Stockholm',
  'cv.pdf',
  $cv$
UTBILDNING
Yrkeshögskolan — Fullstack JavaScript (pågående, examen 2027)
  React, TypeScript, Node.js, Express, SQL, REST-API:er, Git, agila metoder.
Tidigare: systemutveckling .NET (C#, .NET, SQL Server).

PROJEKT
Bokningstjänst — React/TypeScript-frontend, Node-backend.
  Ansvarade för hela gränssnittet: komponentarkitektur, state-hantering, API-integration.

ARBETSLIVSERFARENHET
Vård & omsorg — timanställd. Högt tempo, ansvar, bemötande.
Café/service — kundkontakt, kassavana, stresstålighet.

SPRÅK
Svenska (modersmål), engelska (flytande).

TEKNIK
JavaScript, TypeScript, React, Node.js, C#, .NET, SQL, HTML/CSS, Git.
$cv$,
  '{"tech":["JavaScript","TypeScript","React","Node.js","C#",".NET","SQL","Git"],"experience":["Vård & omsorg","Café / service","Yrkeshögskolan"],"languages":["Svenska","Engelska"]}'::jsonb,
  'Fullstack-student med bakgrund i .NET-systemutveckling. Söker främst frontend- eller fullstackroller, gärna React. Tidigare erfarenhet från vård och café — van vid högt tempo och kundkontakt.',
  'Rakt på sak, inga floskler. Nämn konkreta projekt istället för adjektiv. Undvik "passionerad" och "driven".'
);

INSERT INTO projects (profile_id, name, summary, tech, url)
SELECT id,
  'Bokningstjänst',
  'Bokningstjänst byggd under utbildningen: React/TypeScript-frontend mot en Node-backend. Jag hade hand om hela gränssnittet — komponentarkitektur, state-hantering och API-integration.',
  ARRAY['React','TypeScript','Node.js'],
  NULL
FROM profile;

INSERT INTO projects (profile_id, name, summary, tech, url)
SELECT id,
  'Fullstack-grupprojekt',
  'Grupprojekt med Express-API, Postgres och React-frontend. Agilt arbetssätt med sprintar, kodgranskning och Git-flöde.',
  ARRAY['Node.js','Express','PostgreSQL','React'],
  NULL
FROM profile;
