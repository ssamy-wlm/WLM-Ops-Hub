-- DOCUMENTATION-ONLY: this describes a change already applied directly to
-- production by Sarah (2026-09-14), verified live (handle_new_user dropped,
-- 6 trigger functions confirmed to now have a pinned search_path). It is
-- committed here purely so this repo matches the live database and the
-- Business Setup schema-drift panel (api/schema-drift.js) stays clean —
-- per CLAUDE.md's migration-apply pipeline precedent (see
-- supabase/MIGRATIONS.md section 7), an idempotent migration re-applied via
-- the auto-apply CI pipeline against an already-matching database is a safe,
-- verified no-op. DO NOT hand-run this against production again.
--
-- Background: this closes out the two Supabase linter WARN categories
-- reported in an earlier session (function_search_path_mutable, plus a
-- leftover Supabase-Auth-template trigger/function pair).
--
-- 1) drop the on_auth_user_created trigger + handle_new_user() function:
--    both are dead leftovers from an abandoned Supabase-Auth-based
--    prototype (public.profiles / public.clients / public.tasks +
--    unreferenced task-board.html) that predates this app's real
--    architecture. This app's real session model is its own signed-token
--    scheme (lib/opsSession.js) — a full-codebase check found zero
--    supabase.auth.* calls anywhere in the actual product code, confirming
--    these two objects are genuinely unused, not a mistaken removal.
--
-- 2) pin search_path on 6 genuinely live, in-use trigger functions
--    (defense-in-depth hygiene per Supabase's function_search_path_mutable
--    advisory — none of these six do dynamic SQL or reference unqualified
--    custom objects, so this is a metadata-only, behavior-preserving
--    change, not a functional one).
--
-- NOTE ON A NAMING DISCREPANCY, flagged rather than silently resolved:
-- this repo's own supabase/migrations/20260818090000_ops_payroll.sql
-- defines the append-only-guard FUNCTION as public.ops_payroll_guard()
-- and names the TRIGGER (which invokes that function) ops_payroll_block_
-- mutations. Sarah's own live-database verification found the real,
-- currently-deployed FUNCTION is named ops_payroll_block_mutations() —
-- not ops_payroll_guard() as the migration file's text would suggest. This
-- migration uses Sarah's live-verified name, per her direct instruction.
-- The discrepancy itself is not resolved here (a live rename outside of a
-- tracked migration, or a docs/reality drift of some other kind) — noted
-- for whoever next touches ops_payroll's schema history.

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

alter function public.ops_block_mutations()          set search_path = public, pg_catalog;
alter function public.set_updated_at()               set search_path = public, pg_catalog;
alter function public.ops_set_updated_at()            set search_path = public, pg_catalog;
alter function public.ops_error_log_archive_guard()   set search_path = public, pg_catalog;
alter function public.ops_backups_guard()             set search_path = public, pg_catalog;
alter function public.ops_payroll_block_mutations()   set search_path = public, pg_catalog;
