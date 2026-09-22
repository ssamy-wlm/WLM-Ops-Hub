# CLAUDE.md — WLM Ops Hub project memory

This file is the standing set of rules for working on this repo, plus a
lean, current snapshot of where the project actually is. Read it at the
start of every session before touching anything. Keep the "Current State"
section updated whenever a major architectural decision is made or a phase
ships — treat this file as the project's memory, not a one-time note.

**This file is intentionally lean and auto-loaded every session — it holds
only standing rules, the current snapshot, and durable lessons, never the
dated narrative behind them.** The full, dated history (every shipped
feature/fix write-up, incident post-mortem, and flagged/deferred note, in
original chronological order) lives in `DECISIONS.md` at the repo root,
which is **not** auto-loaded — read it when a "why was it built this way"
question needs the full backstory. Every "see below"/"documented below"
reference in this file that used to point at that history now means
"see DECISIONS.md."

## Session protocol

At the start of every session: read this file first, in full, before
touching anything else. Then ask the user **"What is today's task? Nothing
else will be in scope."** and do not begin any work until they answer.

## Working efficiently

1. **Read only what's relevant.** Read specific sections/line ranges or grep
   for the symbol in question — never re-read a whole file when a targeted
   search answers the question.
2. **Don't re-verify what's already confirmed this session.** If a fact,
   file state, or check result was already established earlier in the same
   session, use it — don't re-run the same read/check again "to be sure."
3. **Keep progress narration brief.** One line per step while working. Save
   full detail (what changed, what was verified, what's left) for the final
   summary at the end of the task.
4. **Signal task completion explicitly.** When a task is fully done, say:
   "This task is complete — recommend starting a fresh session for the next
   task."

## What this app is

Three independent, single-file HTML+JS+CSS apps, each its own portal, with
**zero shared code between them**:
- `client.html` — Client & Production Tracker (services, bundles, franchises, catalog)
- `index.html` — Admin/Ops portal (users, admins, payroll, business settings, org chart, messages)
- `user.html` — Team member portal ("My Work", time off, messages)

Backend: Vercel serverless functions in `api/*.js`, backed by Supabase
Postgres (`ops_*` tables). No framework, no build step, no bundler.

## Standing architectural rules

These are hard constraints established after real production incidents.
Don't relitigate them without an explicit decision from the user.

1. **Per-record sync, never whole-table replace.** All writes go through
   `api/ops-sync.js` as an upsert/update of the *specific rows that changed*
   — never "replace the whole list." All reads go through `api/ops-state.js`,
   which assembles a role-filtered snapshot server-side from the signed
   session token. There is no "PUT the whole record" code path anywhere, on
   purpose — a stale or empty browser simply has nothing to overwrite anyone
   else's data with.

2. **Never diff old-vs-new state on a page load or a timer.** This is the
   single most important rule in this codebase. A function that runs on
   every load (or on an interval) and compares "what's stored now" to "what
   it maybe should be" is the exact pattern that corrupted real client and
   user data, repeatedly, before it was found and ripped out (see the
   disabled-functions list below). The only place a "current vs incoming"
   comparison is allowed is **inside a single API request, comparing the row
   already fetched for that write against the payload in that same
   request** — i.e. reacting to one specific action, once, at the moment it
   happens. Never a background reconciliation pass. This applies to
   everything, including future features — the notification system (below)
   is built this way on purpose.

3. **Zero shared code across the three frontends.** `client.html`,
   `index.html`, and `user.html` do not import from each other and share no
   JS module. Any fix or feature that needs to exist in more than one of them
   must be hand-duplicated in each file separately — there is no shortcut.
   Concrete recurring-bug example: PR #188's no-weekend-due-date rule was
   added to `client.html`'s rollover only; `user.html`'s independently-
   written `userMarkServiceDone()` kept producing weekend due dates for
   months until PR #209. **When fixing any shared-behavior bug, grep all
   three files for the pattern before considering it done** — don't assume
   a fix in one portal covers the others.

4. **Role/tier is server-side only, from a signed token.** `lib/opsSession.js`
   issues and verifies a signed session token (`signSession`/`verifySession`)
   containing `{id, role, level, name, email}`. `tierOf(session)` derives
   `'super' | 'manager' | 'member'` from it. The server never trusts a role
   claimed by the request body or read from `localStorage`. A member's write
   to `clients` is validated field-by-field server-side
   (`checkMemberClientWrite` in `api/ops-sync.js`) — an out-of-scope edit
   REJECTS the whole record with a clear reason, never a silent partial
   merge. The session token itself is stored client-side under a
   **portal-scoped** localStorage key — `wl_ops_token_admin` for
   `index.html`, `wl_ops_token_member` for `user.html` — never a single
   shared key across the three frontends. See the 2026-07-10 entry below for
   why: one shared key let the most-recently-authenticated portal on the
   origin silently overwrite every other open tab's session token, even one
   that never re-logged in. `client.html` has no login of its own (it's
   always embedded as an iframe in one of the other two) and reads whichever
   scoped key matches its embedding parent, using the same `?usermode=1`
   query param `_applyViewerTier()` already relies on to detect a user.html
   embed. Logging out of either portal clears both scoped keys, not just its
   own — an admin/member logout must never leave a still-valid token behind
   for another tab to inherit.

5. **Document-model Supabase schema convention.** Every `ops_*` table is
   `id text primary key, data jsonb not null` (+ `updated_at`/`created_at`,
   sometimes `deleted_at`). RLS is enabled with **zero policies** on every
   table — only the server-side service-role key (used inside `api/*.js`,
   via `lib/supabaseAdmin.js`) can read or write. The browser never talks to
   Supabase directly.

6. **Destructive or high-blast-radius operations need a typed confirmation
   and a thorough dry run.** No auto-anything. The pattern: dry-run computes
   and reports full before/after diffs and writes nothing; the actual write
   requires a token bound to the exact reviewed data, checked **server-side**,
   plus the user typing an exact confirmation phrase — also checked
   server-side, not just gated in the UI. These tools are one-time-use by
   nature: once the job they were built for is done and verified, remove the
   tool (endpoint, UI card, JS functions) rather than leaving a standing
   capability with no ongoing purpose — see the removal of the delete-and-
   replace client migration tool and the duplicate-service cleanup tool below.

7. **Never guess on ambiguous source data.** If a data mapping is unclear or
   garbled, flag it back to the user explicitly rather than inferring intent.
   When instructed, import verbatim/standalone rather than force-fitting into
   a structure that wasn't confirmed.

8. **Non-retroactivity.** Editing a shared definition (e.g. the Service
   Catalog) must never silently change data already assigned to a client —
   freeze the resolved value on the record at assignment time, don't
   re-derive it live from the shared definition on every render.

9. **Verification standard, every change:** `node --check` on extracted
   inline JS for any touched HTML file; a div-balance check on any nontrivial
   HTML edit; Playwright for anything UI-facing — and confirm the element
   under test is actually inside the *visible* container, not just present
   somewhere in the DOM (a real class of false-positive found twice in this
   project: `getComputedStyle` on an element still reports its own `display`
   value even when a hidden ancestor means nobody can see it). For pure
   server-side logic with no live Supabase access available, write a Node
   script that imports and exercises the real exported functions directly.

10. **Branch + PR per feature, with a Vercel preview.** Two tiers of risk,
    two different approval paths:
    - **Low-risk — may merge straight to main:** docs-only changes,
      read-only features (viewers, reports, logs), additive UI (a new card,
      button, or panel that doesn't change existing behavior), styling/CSS.
    - **Everything else requires plan → dry-run → the user's explicit
      approval before merge:** anything touching data writes, migrations,
      auth/login, sync (`api/ops-sync.js`/`api/ops-state.js`), or
      role/permission logic. Never merge one of these without the user's
      explicit test/confirmation on the Vercel preview, unless told
      otherwise for that specific change.
    When in doubt about which tier a change falls into, ask before merging.
    **GitHub auto-merge** (2026-07-29): enabled on a PR (via
    `enable_pr_auto_merge`) only for the low-risk tier above, and only when
    the diff touches nothing under `api/`, `lib/`, `supabase/migrations/`, or
    any sync/auth/permission logic anywhere else — everything else stays
    fully manual, exactly as before this. Branch protection on `main`
    requires the Vercel status check to pass and requires review from Code
    Owners (`.github/CODEOWNERS` — `api/`, `lib/`, `supabase/migrations/`
    require the owner's explicit approval, hard-gated by GitHub itself,
    independent of this agent's own judgment). `index.html`/`user.html`/
    `client.html` aren't in CODEOWNERS — each mixes safe and risky changes in
    the same file, so that tiering stays the judgment call above, same as
    always. When in doubt, don't enable auto-merge.

11. **No live Supabase/database access from this environment.** The Supabase
    MCP server requires an interactive OAuth approval step that a
    non-interactive session cannot complete. When live data is needed for
    verification, ask the user to use an existing in-app export (e.g. the
    "Export Backup (JSON)" button, which hits `/api/ops-state` fresh) or a
    SQL query pasted back — don't assume MCP DB access will work.

12. **A PR adding a file under `supabase/migrations/` may not be merged
    until that migration is confirmed applied against the live Supabase
    project.** As of 2026-08-05 this is enforced, not just a rule to
    remember: `.github/workflows/supabase-migrations.yml` runs a read-only
    `supabase db push --dry-run` against production on every PR and fails
    the check if anything committed to `main` hasn't been applied yet, then
    auto-applies on every push to `main` and re-verifies itself. See
    `supabase/MIGRATIONS.md` for the one-time setup this depends on and
    exactly how it works. This agent still has no live DB access (rule #11)
    — the workflow is what closes that gap now, not this agent doing the
    apply by hand. Three outages happened before this existed
    (`ops_notifications`, `ops_org_links.deleted_at`, then
    `ops_error_log.archived_at`, all documented below) from exactly this
    step being skipped or merged mid-flight. The Business Setup schema-drift
    check (`api/schema-drift.js`) still exists as a secondary, human-facing,
    in-app view — the CI workflow doesn't depend on it and doesn't require
    its hand-maintained `EXPECTED_TABLES`/`EXPECTED_COLUMNS` lists to be kept
    in sync, which is itself one of the reasons the old approach missed
    things. **Hard rule going forward:** no task involving a schema/
    migration change is "done" until the migration is confirmed applied on
    production AND the Business Setup schema-drift panel shows 0 pending —
    a merged migration file alone is not enough (see the three outages this
    caused, documented below).
    **Pipeline status (2026-09-21):** `apply-on-merge` has NEVER actually
    run — `SUPABASE_DB_URL` was never set and the migration ledger was
    never bootstrapped (see the "Open items" entry in DECISIONS.md), so
    every push to `main` since this workflow was built has failed both its
    steps for a reason unrelated to that commit's own changes. Both steps
    now carry `continue-on-error: true` (same STEP-level treatment as
    `check-prod-current`'s 2026-08-20 neutralization, and for the same
    confirmed-live reason: job-level continue-on-error still reports the
    job's conclusion as failure to the commit) — merges no longer produce
    a false-red status or a failure email. This does **not** change the
    rule above: migrations stay manual + hand-verified against production
    until the pipeline is actually bootstrapped, and this agent still has
    no live DB access (rule #11) to do that bootstrap itself.

13. **Data-path PRs require a post-merge integrity check.** Any PR touching
    `api/ops-sync.js`, any `api/*` write path, auth/session, or a cron must
    get a read-only Supabase data-integrity check after merge — not just
    "app loads / no errors," but an assertion of actual correctness: counts,
    orphans, and every field the PR writes. This closes the gap that let a
    real bug (the meeting-parse auto-updater's ambiguous-task-match issue,
    see DECISIONS.md) reach `main` unreviewed. **Any new automated write
    path — a cron, webhook, or parser that mutates records with no human
    clicking save — must be flagged for review BEFORE merge**, since these
    are the highest-risk category and the hardest to catch after the fact.

## Current state (as of 2026-09-17)

- Data (live-verified 2026-09-17): 89 clients, 9 users, 4 admins, ~589
  tasks, 23 tables. RLS enabled on all tables, 0 policies — access is
  service-role + server-side role checks by design (no anon access). NOTE:
  client count was 87 earlier this month; reconcile active/inactive against
  the CSV (the old "85 active" figure predates this).
- Security (audit 2026-09-17): no credential leak (user passwords +
  primaryAdminPw stripped for every tier at every response path);
  server-side role enforcement on every endpoint; no secrets in code or git
  history; scrypt password hashing in use. Residuals: third-party platform
  creds stored plaintext-at-rest in `ops_settings` (super-tier-only on
  read); dead seed functions carry hardcoded default passwords
  (unreachable — see the gremlin list below).
- Clobber class FULLY ADDRESSED: #395 (report fields), #396
  (dueDateChangeRequest), #400 (generic `preserveMissingFields` across 8
  tables — "key absent" class), #401 (re-pull fresh state on 6 admin edit
  paths — "key present but stale" class). C1 CLOSED.
- Other shipped this session: #392/#393 (dead-code + orphaned endpoint
  removal), #394 (daily digests → weekday mornings, DST-safe), #397
  (backup fail-loud on incomplete capture), time-off notifications
  (2026-09-17 — submission now notifies both super admins regardless of
  submitter tier, decision notifications fixed for admin submitters via
  a server-stamped `userId`, `reviewedBy`/`approvedBy` now server-
  authoritative instead of a hardcoded `'Admin'` literal — held for
  preview approval, see DECISIONS.md), linked dual-role identity merge in
  `api/cron-overdue-check.js`'s hierarchy-escalation block (2026-09-17 —
  a dual-role person's admin-id/employee-id overdue counts, session
  activity, and completed work now merge into one canonical total instead
  of splitting/double-counting; reported once, never twice, in the
  inactivity roster — **merged**), twice-daily overdue self-nag
  (2026-09-18 — 8 AM + 2 PM EST via two new `vercel.json` cron entries;
  anyone with a merged overdue count ≥5 gets emailed their own summary,
  quiet-hours respected via a newly-additive `insertNotifications()`
  `opts.directory` pass-through that closes a latent stale-cache risk;
  no super/owner exemption — held for preview approval, see DECISIONS.md),
  "Added by you" fixed to be viewer-aware on self-assigned tasks in
  `index.html` (2026-09-18 — was hardcoded regardless of who's looking;
  `user.html` needed no change, confirmed — see DECISIONS.md).
- Reported-tab data-integrity fix (2026-09-22 — held for preview
  approval): root-caused "Reported items flash then vanish" to a
  cross-session client-side cache leak, not the two re-render hypotheses
  in the original report — the `/api/ops-state` polling BroadcastChannel
  coordinator (`OPS_STATE_SYNC_CHANNEL`) is the exact same unscoped
  channel name in `index.html`/`user.html`/`client.html`, and a
  background pull could silently adopt a DIFFERENT session's (e.g. a
  sibling `user.html` tab's member-tier-filtered) response with no token
  check, overwriting the admin's fuller local task list. Fixed in all
  three files (rule #3) by threading the token through the broadcast/
  claim and gating every reuse point on token match — reproduced live,
  then confirmed closed, via Playwright. Also added inline Delete and a
  "Find & merge duplicate" action to each Reported row, both reusing
  existing, already-working write paths (`deleteTaskInline`/
  `mergeTaDuplicate`) rather than new ones — see DECISIONS.md.
- Gemini parser retry hardening (2026-09-22 — held for review, `api/`
  path): `callGemini()` in `api/process-transcript.js` now also retries
  on 503/`UNAVAILABLE` (transient model overload), not just 429 — same
  backoff schedule, same shared chokepoint. A persistent overload that
  survives every retry now surfaces a clean "Gemini is busy right now —
  please try again in a minute" message to the user instead of raw
  JSON/HTML, via a `.friendlyMessage` property on the thrown error that
  only the HTTP response body reads; `logError()`/`ops_error_log` still
  gets the real diagnostic (`err.message`/`.stack`) unchanged — see
  DECISIONS.md.
- Open — Phase 2: deferred `salesFunnelLevel`/`earnsCommission` edit-payload
  exclusion (now unblocked by #400); transcript-truncation intake loss;
  assignment-email rate-limiting; error-log pruning (broken `archived_at`
  column) + capture-size cap; W1 fire-and-forget (67/70 admin writes don't
  confirm the server before showing success). Phase 3: report-flag data
  repair (4 tasks + the blog-posts task). Hygiene: feed/session retention
  windows.

## Disabled seed/auto-run functions ("gremlins") — never re-enable

These ran unconditionally (or on a resettable browser-local flag) on every
page load and were the direct cause of repeated real production data
corruption (duplicate/phantom accounts, payRate silently reverted, deleted
org-chart people reappearing). Function bodies are left in the files,
unreferenced, as a documented record — restoring a call site for any of
these needs an explicit, separate decision from the user. Full incident
write-ups for each batch are in DECISIONS.md; this is the verified,
current list only — confirmed via `grep` that every one below still has
zero live call sites (only comment references).

**`client.html`** (4 present, disabled; 2 fully removed, listed for completeness):
`seedTeamMembers()`, `purgeJoePlumber()`, `migrateClientNames()`,
`reassignSocialMediaToSherine()` — disabled, bodies still present.
`seedWLMClients()`, `backfillMissingServices()` — **fully deleted from the
file** (2026-08-19, along with the `WLM_SEED_DATA` array they depended on),
not just disabled; listed here only so a future search for either name
isn't mistaken for a live gap.

**`index.html`** (18, all disabled, bodies still present):
`_assignBrightwheelExportToAbby()`, `_seedMissingAdmins()`,
`_fixAdminAccessLevels()`, `_reconcileDualIdentityIds()`,
`_migrateProbation()`, `_reassignSocialMediaToSherine()`,
`_seedAssmaaWorkload()`, `seedStaticUsers()`, `_seedCoreTeam()`,
`_cleanupPlaceholderSeedUsers()`, `_restoreMisarchivedRealWorkers()`,
`_fixAssmaaPayRate()`, `_recreateSarahIbrahim()`,
`_fixSarahIbrahimPassword()`, `_removeDuplicateAssmaaRecord()`,
`_removeDeadAbbySeedDuplicate()`, `_unhideRestoredYehia()`,
`_syncUsersToOrgChart()`.

(`_seedCoreTeam()` is only ever called from inside `seedStaticUsers()`'s
own body — with `seedStaticUsers()` itself having no live call site, the
call is transitively dead too.)

## Key lessons / durable rules

- **Clobber class:** whole-object writes (`row = {...inc}`, raw `{id,
  data}` upserts) silently wipe any field lacking a `cur`-fallback. Two
  sub-classes: "key absent" (stale client omits a field → generic
  `preserveMissingFields`) and "key present but stale" (full-form Edit
  modals resubmit stale values for untouched fields → re-pull fresh state
  before save). Any legitimate field-clear MUST send an explicit
  null/false — never clear-by-omission, or the merge refuses the clear.
  Keep member/admin branch protections in sync.
- **Cron / `utcHour` lockstep:** the `vercel.json` cron schedule and the
  handler's in-code `utcHour` gate must change together, or the job fires
  and the handler silently bails. Vercel crons are UTC and ignore DST;
  `0 11 * * *` = 7 AM EDT / 6 AM EST (in the 6–7 AM window year-round).
- **Digest timing:** daily digests run weekdays at 11:00 UTC and
  deliberately bypass weekend quiet-hours (weekends are handled by the
  weekday-only schedule). That exemption is scoped to this one cron; all
  other email paths respect quiet hours; the backup email is also exempt.
- **Health checks test correctness, not just liveness** — counts +
  error-log alone missed the clobber (a write that succeeds while
  corrupting). The post-merge check also asserts reports-flagged-but-
  missing-metadata, pending due-date-request integrity, and any new
  write-warning signatures.
- **RLS:** enabled on all tables with zero policies BY DESIGN. The app
  reaches the database only server-side via the service-role key (which
  bypasses RLS); there is no client-direct DB access. Access control is
  enforced in server code (role bands). Do NOT treat the empty-policy
  state as a bug. Revisit and add RLS policies only if client-direct
  database access (e.g. a browser using the anon/publishable key) is ever
  introduced.
- **"write warning(s)" are benign:** the server role-guard correctly
  dropping a manager-tier admin's unauthorized orgNodes/orgLinks/settings
  writes — not data loss.

---

**Historical decision log: see `DECISIONS.md`.**
