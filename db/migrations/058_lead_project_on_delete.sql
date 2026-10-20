-- ============================================================
-- match_results.lead_project_id had no ON DELETE rule, so erasing an
-- account whose candidates were tied to one of its projects failed
-- half-way: the cascade from the profile removed the project while
-- match_results still pointed at it. Found moving real history into a
-- test copy of the cloud, where the account then could not be deleted.
--
-- A candidate loses its project link with the project; both belong to
-- the same user and go in the same erasure anyway.
-- ============================================================
ALTER TABLE public.match_results DROP CONSTRAINT match_results_lead_project_id_fkey;
ALTER TABLE public.match_results ADD CONSTRAINT match_results_lead_project_id_fkey
  FOREIGN KEY (lead_project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
