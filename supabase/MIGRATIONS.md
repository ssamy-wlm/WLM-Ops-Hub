# Applying migrations to production

Three real incidents (`ops_notifications`, `ops_org_links.deleted_at`,
`ops_error_log.archived_at` — see CLAUDE.md) all had the same root cause:
this repo had **no mechanism at all** that applied `supabase/migrations/*.sql`
to production. Every migration was a hand-copy-paste-into-the-SQL-editor
step, and that step got forgotten three times.

`.github/workflows/supabase-migrations.yml` closes that gap:

- **Every PR** gets a read-only check confirming production has already
  applied every migration committed to `main` — merging is blocked if not.
- **Every push to `main`** auto-applies anything new, then re-checks itself.

This file is the one-time setup required before that workflow can run, plus
what to do if something ever goes wrong.

## One-time setup (do this once, by hand, before the workflow can do anything)

### 1. Get a direct database connection string

Supabase dashboard → your project → **Settings → Database → Connection
string → URI**. Use the **direct connection (port 5432)**, not the
transaction-mode pooler on port 6543 — the pooler can reject some of the
statement patterns migrations use. Copy the full `postgresql://...` URL,
password included.

### 2. Add it as a GitHub secret

Repo → **Settings → Secrets and variables → Actions → New repository
secret** → name it `SUPABASE_DB_URL`, paste the connection string. This is
the only secret the workflow needs.

### 3. Reconcile history — READ THIS BEFORE RUNNING `db push` FOR THE FIRST TIME

This project has never used the Supabase CLI before, so its migration-history
bookkeeping (a `supabase_migrations.schema_migrations` table the CLI
maintains on the remote database) has never been initialized. Two of the ten
committed migration files —
`20260629120000_init_realtime_schema.sql` and
`20260629130000_ops_hub_core_schema.sql` — are **abandoned, superseded
scaffolding** from before this app's current document-model schema was
settled on (see `api/schema-drift.js`'s own comment on this). They were
superseded by `20260630120000_ops_hub_document_schema.sql` before any real
app code ever used them, and — this is the important part — that later
migration **actively tries to `DROP` the earlier one's tables**, but only if
they're empty; it refuses (safely, raises an exception, changes nothing) if
they have any rows.

**Verified locally, end-to-end, against a real Postgres 16 instance:**
running `supabase db push` for the first time against a truly fresh database
replays all 10 files in order — migration `20260629130000` creates
`ops_settings_singleton` **and seeds it with one row** (`insert ... values
(true) on conflict do nothing`), then the very next migration
(`20260630120000`) tries to drop that now-non-empty table and **fails**:

```
ERROR: public.ops_settings_singleton has 1 row(s) — refusing to drop.
```

No data is lost when this happens (the guard is doing exactly its job), but
the very first bootstrap run WILL stop here if you don't handle it first.
Since these two files were, per CLAUDE.md, never actually run against real
production (the schema was superseded before going live), the fix is to
tell the CLI's history table "these two are already handled, don't run
them" — **without** executing their SQL:

```
supabase migration repair --status applied 20260629120000 20260629130000 --db-url "<your connection string>"
```

(`--status applied` tells the CLI "believe this ran already, skip it."
`--status reverted` — a similarly-named but opposite flag — means the
opposite, "this hasn't run, try it again." Verified locally: using
`reverted` here reproduces the exact failure above.)

If, when you actually run this, either of those two tables turns out to
already exist with real data on production (unexpected, but this repo has
had schema surprises before) — stop, don't run `migration repair`, and
treat that as its own investigation.

### 4. Run the real bootstrap push, once, by hand — watch the output

```
supabase db push --db-url "<your connection string>"
```

It will list all 8 remaining migrations and ask for confirmation. Since
every statement in every migration file is written idempotently (`create
table if not exists`, `add column if not exists`, `create or replace
function`, `drop trigger if exists` before recreating), this is safe to run
even if some of these were already applied by hand in the past — verified
locally: running it a second time in a row reports `"Remote database is up
to date"` with zero statements executed.

### 5. Turn the PR check into a required status check

Repo → **Settings → Branches → main → Require status checks to pass** → add
`Check production is current (read-only)`. This makes the gate actually
block merges, not just show a red X someone can ignore.

### 6. Confirm the `ops_error_log` guard specifically

PR #202's trigger (`ops_error_log_archive_guard`) was applied to production
by hand on 2026-08-05. Confirmed correct against a real Postgres instance
running the exact committed migration file:

```sql
-- Trigger points at the narrow guard, not the shared block-all function:
select tgname, p.proname from pg_trigger t
join pg_proc p on p.oid = t.tgfoid join pg_class c on c.oid = t.tgrelid
where c.relname = 'ops_error_log' and not t.tgisinternal;
-- expect: ops_error_log_block_mutations | ops_error_log_archive_guard

-- ops_feed / ops_time_off_ledger still use the ORIGINAL shared function,
-- untouched by this migration:
select c.relname, t.tgname, p.proname from pg_trigger t
join pg_proc p on p.oid = t.tgfoid join pg_class c on c.oid = t.tgrelid
where c.relname in ('ops_feed','ops_time_off_ledger') and not t.tgisinternal;
-- expect: both rows show ops_block_mutations, not the error-log-specific one
```

If you want the belt-and-suspenders functional check too (an
`archived_at`-only UPDATE succeeds; DELETE fails; an UPDATE touching `data`
or `created_at` fails) — the exact four statements are in the git history
of this file's introducing PR.

## Ongoing: what happens on every future migration

Nothing manual. Commit a new file under `supabase/migrations/`, open a PR —
the PR check confirms prod is currently caught up (independent of this PR).
Merge to `main` — the apply job runs the new file and self-verifies. If
anything goes wrong at any point, the relevant GitHub Action run goes red
and the NEXT PR's check will also fail until it's fixed — there is no path
back to a silent gap.

## Constraints this was built around (don't relax without re-reading these)

- **Shared prod/preview database** (see CLAUDE.md) — the apply job only
  triggers on `push` to `main`, never on a PR/branch push, which is what
  triggers a Vercel *preview* build. A preview deploy structurally cannot
  reach the write path.
- **Append-only tables** (`ops_error_log`, `ops_feed`, `ops_time_off_ledger`)
  — this pipeline applies whatever SQL is committed; it does not evaluate
  whether a new migration weakens an append-only guarantee. That review
  still belongs to CODEOWNERS + the human reviewing the PR, same as before.
- **Idempotency is what makes auto-apply safe here** — every existing
  migration follows the `if not exists`/`or replace`/`drop ... if exists`
  pattern. Any future migration that doesn't follow this pattern (a bare
  `drop table`, a data-mutating `update` with no guard) is a materially
  different risk than anything this pipeline has been tested against —
  write those especially carefully, and consider a manual apply for that
  one instead.
