# CLAUDE.md — WLM Ops Hub project memory

This file is the standing set of rules for working on this repo, plus a
running summary of where the project actually is. Read it at the start of
every session before touching anything. Keep the "Current State" section
updated whenever a major architectural decision is made or a phase ships —
treat this file as the project's memory, not a one-time note.

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

## Current state (as of 2026-07-10)

**Client & data counts (as of 2026-08-06):** 86 clients total — 83 active,
3 inactive (Built-Rite Closets, Hebron Veterinary Hospital, Wisdom and
Youth — deactivated via the app, intentional; clients are never deleted,
only active/inactive). 276 services total. Frequencies in use: monthly
(177), yearly (93), one-time (4), weekly (2) — **no quarterly services
exist**, which is why `client.html`'s missing `calcNextDue()` quarterly
case (see Deferred/known gaps below) is currently harmless.

**Architecture facts confirmed this session (2026-08-06):**
- `ops_error_log`, `ops_feed`, `ops_time_off_ledger` are append-only via DB
  triggers. `ops_feed` and `ops_time_off_ledger` use the **shared**
  `ops_block_mutations()` function (hard-blocks all UPDATE/DELETE, no
  exceptions). `ops_error_log` uses its **own dedicated**
  `ops_error_log_archive_guard()` function (see the Migration-apply
  pipeline entry below): blocks DELETE, blocks UPDATE to `id`/`data`/
  `created_at`, but permits an UPDATE that only changes `archived_at` (soft-
  archive cleanup). Never modify the shared function when changing
  error-log behavior — that would weaken the PTO ledger's and feed's
  tamper-proofing too.
- **Sales Funnel access model:** a `salesFunnelLevel` field
  (`'viewer'|'editor'|'owner'|null`) on each user/admin record. Legacy
  `salesFunnelAccess:true` resolves to `'editor'`. `tier==='super'` (Super
  Admin/Owner) always resolves to `'owner'` regardless of any stored field.
  Michael Eruzione (`u_1783268590854`) is a non-super `'owner'` grant (the
  Google-Drive-style carve-out — see the Admin Controls entry below).
  Enforced in `api/ops-state.js` + `api/ops-sync.js`.
- **No-weekend due-date rule:** Saturday → Friday (−1), Sunday → Monday
  (+1), via `adjustOffWeekend()`. Must be applied on every due-date
  computation path in **all three portals** — see rule #3's concrete
  example above and the recurring-rollover entry below.
- **Sub-item shape** (tasks nested under a service/project item):
  `{id, ts, done, text, assigneeId, assigneeName}`.

**Client data:** 85 active clients live in production, generated from the
authoritative CSV mapping and verified 100% match (client count, per-client
service counts, every service name/bundle/frequency, the Servpro→Yonkers
franchise nesting, and all known intentional duplicates/standalones) against
a live export. See PR #74 for the migration and franchise feature. The
delete-and-replace migration tool (`api/migrate-client-data.js`) that
performed this has since been removed — its one-time job was done and
verified, and it deleted every client record on commit, so it wasn't kept
around as a standing capability. A separate one-time duplicate-service
cleanup (5 redundant service copies across 4 clients) also ran successfully
and was removed the same way — see rule #6 above.

**Auto-run-on-load functions — DISABLED, must never be re-enabled.** These
ran unconditionally (or on a resettable browser-local flag) on every page
load and were the direct cause of repeated real data corruption. Their
function bodies are left in the files, unreferenced, as a record of what
they did — do not restore a call site for any of these without an explicit,
separate decision from the user:

- `client.html`: `seedTeamMembers()`, `purgeJoePlumber()`, `seedWLMClients()`,
  `backfillMissingServices()`, `migrateClientNames()`,
  `reassignSocialMediaToSherine()`
- `index.html`: `_assignBrightwheelExportToAbby()`, `_seedMissingAdmins()`,
  `_fixAdminAccessLevels()`, `_reconcileDualIdentityIds()`,
  `_migrateProbation()`, `_reassignSocialMediaToSherine()`,
  `_seedAssmaaWorkload()`, `seedStaticUsers()` / `_seedCoreTeam()`,
  `_cleanupPlaceholderSeedUsers()`, `_restoreMisarchivedRealWorkers()`,
  `_fixAssmaaPayRate()`, `_recreateSarahIbrahim()`,
  `_fixSarahIbrahimPassword()`, `_removeDuplicateAssmaaRecord()`,
  `_removeDeadAbbySeedDuplicate()`, `_unhideRestoredYehia()` — this batch
  (disabled 2026-07-09) is confirmed as the exact mechanism behind a real
  production incident: on any browser/device with an empty or cleared local
  cache, `seedStaticUsers()` re-seeded a stale 11-person hardcoded roster
  (creating 4 people who were never actually hired and a duplicate Yehia
  Elaify) before the first real cloud pull resolved, and one of the other
  "one-time idempotent fix" functions in the same load — each guarded only by
  a local `localStorage` flag or purely local record state, none checking the
  server first — found that poisoned local array "changed" and pushed it to
  the cloud via `cloudAutoSync()`, producing a single batch write across 8
  real `ops_users` rows sharing one identical `updated_at`
  (2026-07-08T14:47:37.177480+00) and knocking Assmaa Fouad's payRate back
  down to a stale hardcoded 5 (real rate: 5.5).

- `index.html`: `_syncUsersToOrgChart()` (disabled 2026-07-13) — ran after
  every `orgLoad()` (page load, every Business Setup tab switch, every cloud
  pull) and silently re-added/re-derived org-chart nodes by diffing the live
  `ops_users` list against current chart state on every call — the same
  forbidden load/timer diff pattern as the batch above, just in the org
  chart instead of `ops_users` directly. `orgLoad()` itself also carried a
  second copy of the same pattern — an id-based merge loop that re-added any
  `ORG_NODES_DEFAULT` entry missing from saved state on every load — also
  removed. This is why deleted org-chart people (Mo Money, Sally Smooth,
  Viral Vera, Art Agent, and others) kept reappearing: nothing ever
  tombstoned them, so the next load/tab-switch/pull always silently
  re-derived and re-added them. A person is now only ever added to the chart
  by a deliberate action — `_orgAddPerson()`, called from a one-time
  `confirm()` prompt at user/admin creation time, or the existing manual
  "+ Add" panel — never automatically. Real delete/tombstone support was
  added alongside this (see the entry below); `_orgGetExcluded()` /
  `_orgAddExcluded()` are also unreferenced now, superseded by the real
  tombstone mechanism.

**User/admin data cleanup, admin-as-member bug (2026-07-09):** an admin
opening the embedded tracker was seeing the member "View only" treatment.
Investigated for a propagation/code bug first (see the cache-bust fix on
PR #91) — confirmed via live data that this was actually bad data, not a
code bug: Emily Rovillo and David Joslin each had a **duplicate row in
`ops_users`** (Emily's duplicate carried `role:'member'`), which is how a
real admin session could resolve identity to a member record. Removed
directly against production: those 2 duplicate `ops_users` rows, 6 phantom
placeholder rows (Aileen Casey, Brian Bynes, Carol Rucker, Jamil Ahmed,
Neha, and a misspelled duplicate "Yehia Elaify" — all traced to the
disabled `_seedCoreTeam()` seed batch documented above), and Emily's stray
`ops_admins` record. The database now holds exactly **5 real users**
(Sherine, Assmaa, Sarah, Michael, Yehia Elafify — note the corrected
spelling, distinct from the removed misspelled duplicate) and **2 dynamic
admins** (David — level `owner`; Abby — level `production_manager`), plus
the separate primary-admin login (Sarah Samy, `super`/`owner` tier — not an
`ops_admins` row at all, see the `PRIMARY_ADMIN_EMAIL` branch in
`api/ops-auth.js`). No code fix was needed for the tier bug itself — a
person's live `viewerTier` comes only from their signed session token
(`tierOf(session)` in `lib/opsSession.js`, decoded from the token alone,
never re-derived from a table lookup), so once a real admin token is
issued a duplicate `ops_users` row can never downgrade it mid-session. The
residual risk is narrower, at login time only: `api/ops-auth.js` already
checks `ops_admins` before `ops_users` with an early return, so an admin
whose typed credentials match their own admin record always gets an admin
token regardless of any stray duplicate — the actual incident required the
person's credentials to land on the duplicate `ops_users` row instead
(mismatched/stale password against their real admin record). Preventing
recurrence is a data-hygiene problem (catching a duplicate email/name
across both tables before it causes a wrong login), not a code-ordering
one — flagged for the user, not built here.

**Shared-token session collision, Access Level badge fallback (2026-07-10):**
two related follow-on bugs surfaced after the admin-as-member cleanup above.
(1) The Admin Accounts screen showed "Creative Manager" as the Access Level
badge for admins whose real level didn't literally string-match one of the
six canonical values (e.g. missing entirely) — `_getLevelInfo()`'s fallback
silently defaulted to that specific, most-restricted role regardless of who
hit it, even though every actual permission check elsewhere already treats a
missing/unmatched level as fully unrestricted. Fixed the fallback to show
"Admin" (matching that real behavior) and normalized the comparison
(trim/lowercase) so incidental whitespace/casing no longer falls through
either — display-only, no permission change. (2) A real Save-blocking bug:
the Super Admin (owner) could open the Edit modal for an admin or user, but
the save silently dropped with `"users: dropped — restricted table, caller
role is member"` from `api/ops-sync.js`. Traced with live-driven Playwright
reproductions of the actual `saveEditAdmin()`/`saveEditUser()` functions —
confirmed `tierOf(session)` is computed exactly once in `ops-sync.js`, from
the identical `requireSession`/`tierOf` used by `ops-state.js`, with no
override anywhere in the file, so the server was not misresolving anything
— it was correctly resolving *the token it was handed*. Root cause: all
three frontends stored their session token under one shared, unscoped
localStorage key (`wl_ops_token`). `index.html` and `user.html` are each
independent login flows that unconditionally overwrite that key on success;
`_opsToken()` re-reads it fresh from localStorage on every call, never
cached from login. So if the same browser profile had a `user.html` tab
where anyone logged in as a team member *after* an already-open `index.html`
admin tab had loaded, the member's token silently clobbered the shared key —
the admin tab's on-screen state (resolved from an earlier, pre-clobber pull)
looked fine, but its next Save read the now-member token fresh and sent it,
and the server correctly returned a member-tier drop for that token. Fixed
by scoping the key per portal (see rule #4 above) — `client.html` (which has
no login of its own) picks the right one via the existing `?usermode=1`
embed signal. Logout in either portal now clears both scoped keys, and a
one-time cleanup removes the old shared key so it can't linger as a dead
credential; a browser with only the old key falls through to a clean login
screen post-deploy rather than a stale or broken state, matching the
existing fail-closed pattern `restoreAdminSession()` already used for a
missing/invalid token.

**Franchise/location feature:** a client can hold `locations[]`, each with
its own independent `services[]` (e.g. Servpro as the parent client with a
nested "Yonkers" franchise). Built in `client.html` only — due dates,
alerts, calendar, schedule, and My Work all walk franchise services too via
`_allClientServices()`. Franchise services do **not** get a mirrored entry
in the Bundles/Projects tab (that mirror stays client-services-only) — a
direct Mark Done button was added to the Services tab instead.

**Notification system:** event-triggered, server-side only, inside
`api/ops-sync.js` — never a load-time scan (rule #2 above, applied to this
feature specifically). Three events (service/task assigned, time-off
approved/denied, new message), each individually toggleable via
`ops_settings.notificationSettings`, checked server-side at fire time. New
`ops_notifications` table, per-recipient-filtered, synced into all three
frontends. Email via Resend is wired but dormant — attempts only if
`RESEND_API_KEY` is set (the correct, already-consistent env var name across
the codebase), fails silently/logged otherwise. See PR #75.

**Service Catalog:** admin-editable bundles/services, Supabase-backed, single
source of truth (replaced the old hardcoded `BUNDLE_DEFS`). Non-retroactive
by design (rule #8). Members can suggest; admins approve. See PR #70.

**Org chart real delete + link sync fix (2026-07-13):** fixes deleted
org-chart people reappearing (root cause: the auto-reconciliation disabled
above, plus deletes never actually persisting anywhere). Three changes,
one PR: (1) killed the auto-reconciliation everywhere it fired — see the
disabled-functions entry above; (2) real soft-delete for org nodes/links,
reusing `ops_org_nodes.deleted_at` (already present in the schema but never
used until now) and a new matching column on `ops_org_links` — a node
delete tombstones the node itself and only the specific link rows already
connected to it (computed client-side in `deleteOrgBubble()` before
removal), never a cascade; `api/ops-state.js` filters both tables on
`deleted_at is null`, `api/ops-sync.js` sets it via
`tombstones.orgNodes`/`tombstones.orgLinks`, gated to `tier === 'super'`
same as the existing org-chart upserts — never a hard SQL DELETE; (3) a
second, independent bug found during this work: `orgLinks` were stored as
bare `[from,to]` array pairs with no `.id`, and the sync engine's
dirty-check (`_opsDirty`) requires every row to have an `.id` to ever be
considered for push — so links have never actually synced to the cloud.
Fixed by migrating link storage to `{id, from, to}` objects (id synthesized
`"<from>_<to>"`, matching the pre-existing `ops_org_links` schema comment),
migrated on load via `_migrateOrgLinks()`. Adding a person to the chart is
now a deliberate action only: creating a user or admin shows a one-time
`confirm()` — "Add [Name] to the company structure chart?" — the org-chart
write happens only on explicit confirmation, via the new `_orgAddPerson()`
helper; skipping it leaves that person off the chart permanently, no retry.
`ORG_NODES_DEFAULT` also shrank from 18 to 9 real people in this same PR —
CODE only: Mo Money, Sally Smooth, Viral Vera, Art Agent, Carol Rucker,
Brian Bynes, Aileen Casey, Neha, and Jamil Ahmed (the same phantom-seed
placeholders documented in the 2026-07-09 entry below, same root cause) were
removed, and "Yehia Elaify" corrected to the real spelling "Yehia Elafify".
The corresponding stale rows already sitting in the live `ops_org_nodes`
table were deliberately NOT touched by this PR — that is a separate,
later, dry-run-approved step (rule #6), not bundled with the code fix.

**Outage: `ops_org_links.deleted_at` migration shipped without being applied
to prod (2026-07-13) — RESOLVED, migration now applied.** The org chart fix
above added `supabase/migrations/20260713120000_org_links_deleted_at.sql`
and a matching `.is('deleted_at', null)` filter on `ops_org_links` in
`api/ops-state.js`. The migration was never run against the live Supabase
project. Every `/api/ops-state` call queries `ops_org_nodes` and
`ops_org_links` in the same `Promise.all` used to assemble the rest of the
response; the missing column made the `ops_org_links` query error, and the
handler treats any single query error in that batch as fatal — the whole
endpoint 500'd for every caller, not just the org-chart section. Since
`client.html`'s tier resolution (`_applyViewerTier`) only ever runs inside
a *successful* `/api/ops-state` response, this meant **every session,
including the primary admin (owner tier)**, stayed pinned to the
fail-closed member/view-only default — surfaced as "the Tracker's client
view is stuck read-only for admins," investigated at length across PRs
#115/#116 (retry logic, then a viewerId diagnostic) before the real
schema-lag cause was found. The column has since been applied directly to
the live database; `/api/ops-state` now succeeds normally and tier
resolution works as designed. This is the **second** outage from this
exact root cause (a migration merging in the same PR as code that depends
on it, without a step that guarantees it's actually applied before that
code reaches production) — the first being `ops_notifications`. See the
"pending Supabase migrations" gap below for the fix under consideration.

**Admin Controls tab (2026-08-05):** a new top-level tab in `index.html`,
visible only to Super Admin (`tier==='super'`, currently David + Sarah),
consolidating 7 admin/system panels that had accumulated across Business
Setup and Users: Error Log, Pending Migrations (schema drift), Password
Security Migration, Sales Funnel Access, Platforms & Tools, Import Clients
(one-time), and Email Notifications. Each panel moved verbatim — same ids,
same endpoints, same behavior, no rebuild — the nav item and page-section
are new, the panels themselves are not. Visibility is server-enforced by
each panel's own endpoint (`api/error-log.js`, `api/schema-drift.js`,
`api/import-legacy-data.js` already require `tierOf(session)==='super'`;
`api/ops-state.js` already nulls `passwordMigrationStatus` for any non-super
tier) — the nav-item hiding is the same "UX convenience, not the actual
security boundary" pattern already used for every other role-gated nav item
here, not a new security mechanism. Two access-narrowing side effects of
strict `tier==='super'` gating on the whole tab were flagged to Sarah rather
than silently decided: (1) Sales Funnel Access previously also let a
non-super admin granted Sales Funnel Owner level manage funnel access
(Google-Drive-style carve-out — see `_mySalesFunnelLevel`) — **resolved
2026-08-05, same day, via Sarah's explicit follow-up**: the nav item's gate
is now `tier==='super' OR _mySalesFunnelLevel==='owner'`, and everything
inside the tab except the Sales Funnel Access card itself is wrapped in
two `#admin-controls-super-only-wrap[-2]` containers shown only for
`tier==='super'` — so a non-super Funnel Owner who opens the tab sees
Sales Funnel Access (and the tab is relabeled "Sales Funnel Access" for
them) and nothing else; every other panel's endpoint still independently
requires `tierOf(session)==='super'` server-side regardless of what this
wrapper shows, so this is scoping, not a new security boundary. (2)
`production_manager` (Abby) previously kept Business Setup, which included
Platforms & Tools with no additional gate; moving it into the
Super-Admin-only tab means she loses the ability to add/edit platforms,
even though she still creates users day-to-day — this one was accepted
as-is (no follow-up requested).

**Migration-apply pipeline (2026-08-05) — closes the recurring "migration
merged but never applied to prod" failure, after a third instance
(`ops_error_log.archived_at`, PR #187/#202).** Investigated the actual
deploy pipeline first: there was no CI at all in this repo (`.github/`
held only `CODEOWNERS`), no `supabase/config.toml`, no Supabase CLI
dependency anywhere — migrations had never been anything but a hand-copied
SQL-editor step. Built `.github/workflows/supabase-migrations.yml`
(two jobs: a read-only `supabase db push --dry-run` against prod on every
PR that fails the check if anything committed to `main` isn't applied yet;
a real `supabase db push` on every push to `main` that self-verifies
afterward) plus `supabase/MIGRATIONS.md`, the setup/runbook doc. The
apply job only triggers `on: push: branches: [main]` — that trigger is
structurally disjoint from what triggers a Vercel *preview* build (a PR/
branch push), which is the load-bearing safety property for this app's
shared prod/preview database (rule #4-adjacent constraint, see
`supabase/MIGRATIONS.md`).

Verified for real, not just read — spun up a local Postgres 16 instance
(stubbing the `auth`/`storage` schemas and `anon`/`authenticated`/
`service_role` roles a real Supabase project provisions by default, which
vanilla Postgres doesn't) and ran the actual CLI against it repeatedly:
full first-time replay of all 10 migrations, idempotent re-run (confirmed
`"Remote database is up to date"`, zero statements executed), a dummy
pending migration correctly detected and blocked by the PR-check script and
then correctly applied and self-verified by the merge-job script (exact
script bodies extracted from the committed YAML, not retyped), and the
`ops_error_log_archive_guard` trigger's actual behavior (archived_at-only
UPDATE succeeds, DELETE fails, UPDATE touching `data`/`created_at` fails,
`ops_feed`/`ops_time_off_ledger` untouched, still on the original shared
`ops_block_mutations` function).

That local replay surfaced a real, previously-unknown landmine: migration
`20260629130000_ops_hub_core_schema.sql` (abandoned scaffolding, superseded
before ever being used by app code — see `api/schema-drift.js`'s own
comment on this) both creates AND seeds one row into
`ops_settings_singleton`, and the very next migration
(`20260630120000_ops_hub_document_schema.sql`) tries to drop that table but
**refuses if it has any rows** — so a naive first-time full replay would
have stopped there with a "refusing to drop" error on Sarah's very first
bootstrap attempt. No data at risk (the guard did exactly its job), but
without knowing this in advance it would have looked like the pipeline was
broken. `supabase/MIGRATIONS.md` documents the fix: `supabase migration
repair --status applied 20260629120000 20260629130000` marks those two
abandoned files as already-handled (skip, don't run) before the real first
`db push` — verified locally that this exact sequence produces a clean,
complete bootstrap with no errors.

**Not yet done — requires Sarah, live DB access this agent doesn't have**:
generating the `SUPABASE_DB_URL` GitHub secret, running the one-time
`migration repair` + bootstrap `db push` by hand, enabling the new check as
a required branch-protection status check, and confirming the
`ops_error_log_archive_guard` trigger matches on the real live database
(exact verification SQL is in `supabase/MIGRATIONS.md`). Held for approval
per this PR's own review gate — not merged until confirmed.

**No-weekend due dates — recurring rollover gap closed (2026-08-06).** PR
#188 added the rule that a due date must never land on Sat/Sun
(`adjustOffWeekend()` in `client.html`, Sat→Fri −1, Sun→Mon +1) and routed
every due-date computation in `client.html` through it, including its
`calcNextDue()` recurring-rollover helper. Three monthly services still
rolled forward onto Saturday 2026-09-05 on a later health audit (The
Windsor Learning Center, Shapiro Auctions, Fern Wood Flooring) — root cause
was **not** a gap in `client.html`; every path there was already correctly
adjusted. It was `user.html`'s own, independently-written
`userMarkServiceDone()` (the team-member portal's "Mark Done"/Status-
dropdown completion path) — zero-shared-code (rule #3) meant PR #188's fix
in `client.html` never touched this separate implementation, which computed
`svc.due` via raw `setMonth`/`setDate`/`setFullYear` + `toISOString()` with
no weekend check at all. Any recurring service marked done by a team member
from My Work (not an admin via the Tracker) could roll onto a weekend every
cycle. Fixed by adding `user.html`'s own `adjustOffWeekend()` +
`calcNextDue()` (hand-duplicated, matching `client.html`'s logic, keeping
this file's existing `quarterly` case that `client.html`'s copy doesn't
have) and funneling `userMarkServiceDone()`'s rollover through it — the
project mirror (`proj.due=svc.due`) already copied from the now-corrected
value in the same write. Verified end-to-end with Playwright (real "Done"
status-dropdown click, frozen clock, stateful ops-sync/ops-state mock
echoing the accepted write back) for both the Saturday→Friday and
Sunday→Monday cases, plus direct unit checks against the extracted
functions. Pure client-side JS — no migration/prod-state change involved.
Flagged, not fixed (out of scope): `client.html`'s own `calcNextDue()` has
no `quarterly` case at all — a quarterly-freq service marked done via the
admin Tracker wouldn't advance its due date, a separate pre-existing gap.

**Session fixes catalogue (through 2026-08-06)** — bug fixes from this
session not otherwise given their own entry above; don't re-investigate
these:
- **My Work duplicate services (PR #189):** a reference-equality bug in the
  "everything on clients I'm assigned to" view was double-listing services.
  Fixed by comparing on ID instead of object reference.
- **Notification click-through (PRs #191, #198):** notifications now deep-
  link to the exact service by ID, for every notification type, for both
  employees and admins. The earlier "wrong target" regression was a
  toggle-close bug plus a missing admin-side click-through handler.
- **Workload person-click (PR #201):** the one-time contextual tip chip
  (`_maybeShowTip`) was missing `pointer-events:none`, so it silently
  intercepted clicks meant for the Person column in the Workload table.
  Long-running click-through bug, now closed.
- **Status colors (PR #192):** all four `workStatus` states are color-coded
  everywhere (green=done, red=stuck, blue=in progress, gray=not started)
  via one shared `_svcStatusMeta()` helper per portal.
- **My Work employee redesign (PRs #193, #200):** services collapsed into
  one table plus compact stat tiles. Project Tasks and "Your Assigned
  Steps" were deliberately kept as separate cards, not merged in.
- **Progress Reports "This Year" count (PR #199):** recovered a fix that
  got orphaned when PR #197 merged mid-flight.
- **Error-log archive guard (PR #202):** see the architecture facts and
  Migration-apply pipeline entries above/below.
- **Weekend rollover in `user.html` (PR #209):** the team-member "Done"
  path now weekend-adjusts too — see the dedicated entry above.

**Data corrections & notable records, this session (direct SQL / in-app
actions, verified):**
- Grade.us Recipient Lists → Sherine; Web Page Edits → WebLight (Done,
  Copywriting, Assmaa); AI Report → HSCM (Done, SEO, Assmaa).
- Leese Flooring `projects[]` cleaned (removed a duplicate GBP mirror and an
  orphan `Grade_Us_12` entry, synced FAQ/Town Pages) — now in sync with
  `services[]`.
- Russ Hudson: "Course Home Page Management" → Assmaa; new "Monthly
  Practice Video Editing & Email Prep" service → Assmaa; "Upcoming Course
  Postings" sub-item added.
- 53 weekend-landing services bulk-moved off Sat/Sun; a later health audit
  found 3 more that had rolled back onto Saturday (Windsor Learning Center,
  Shapiro Auctions, Fern Wood Flooring — see the recurring-rollover entry
  above) — root cause was the `user.html` gap, fixed in PR #209; those 3
  were manually re-moved to Friday in the meantime.
- Fern Wood Flooring FAQ → Assmaa. **Naming trap:** this client is "Fern
  Wood Flooring" (with a space) — NOT "Fernwood." Watch for this on future
  work; a lookup by the wrong spelling will silently miss the record.
- RastaRant added (new client + 3 website services, assigned to Abby).
  Shopify password intentionally **not** stored in-app — kept in Business
  Setup credentials / the team's password manager, per existing convention.
- Michael Eruzione set to Sales Funnel `owner` (see the architecture facts
  entry above for what that grants).

**Overview "Team Assessment" % done was reading the wrong signal
(2026-08-06).** The per-person completion metric on the Overview page
(shipped in PR #207) computed % done from `_chIsDoneThisCycle` — Client
Health's "has a `lastDone` AND isn't currently overdue" heuristic, i.e. a
snapshot of whether the current cycle *looks* caught up, not whether the
person ever actually marked anything done. Confirmed live: Sherine, 43
assigned services, 0 ever marked `workStatus==='done'`, showed 97% — every
one of her services simply has a far-future due date, so the heuristic read
each one as "done" regardless of real status. Fixed to Sarah's explicit
formula: `workStatus==='done'` count ÷ total assigned (a service with no
`workStatus` set counts as NOT done, never excluded from the denominator).
A person with 0 assigned services now shows 0%/"—" and still appears in the
list, instead of the previous 100%-with-nothing-assigned bug. Overdue/at-risk
bucketing got its own local `_taSvcDueStatus()` (workStatus-aware) rather
than editing the shared `_chSvcDueStatus` — that function also drives
Client Health, which wasn't reported as wrong and stayed untouched. Layout:
the card's `max-height`/`overflow-y:auto` was removed so the full roster
renders stacked, no inner scrollbar (the roster itself was already dynamic
— `_timeOffRoster()` reads live `ops_users`/`ops_admins`, so a new hire
appears automatically with no code change). Recent Activity restyled in the
same PR: dropped the per-type boxed icon (dead code anyway, since the feed
here is already filtered to `type:'client'` only) for a single small green
checkmark, one stacked line per event instead of two. Verified against the
task's exact five reported cases via Playwright with live-shaped data —
Sherine/Michael/Abby (all real-zero-done) now show 0%, Assmaa (12/21) shows
57%, David (0 assigned) shows 0%/"—" and still appears.

**Overview follow-up: layout gap + "at risk" wording (2026-08-07).**
Two more fixes on top of the entry above, same page. (1) Once Team
Assessment's roster render became unbounded (previous entry), CSS Grid's
default `align-items:stretch` made the Recent Activity `.card` stretch to
match Team Assessment's height every row, while Recent Activity's own
content stayed capped at a fixed `max-height:460px;overflow-y:auto` — a
small nested scrollbar floating inside a big empty gap whenever the roster
was much taller than the activity feed. Fixed by adding
`align-items:start` to the shared grid container (each card now sizes to
its own content) and removing the fixed max-height/overflow — if the page
needs to scroll, the whole page scrolls now, never a box inside a box. (2)
The per-person "N overdue · N at risk" label was replaced with plain
"due in X days" language (Sarah: "at risk" wasn't actionable and the count
didn't map to an obvious window): most-overdue not-done dated service ->
"overdue by X days" (red); none overdue, soonest upcoming is today ->
"due today" (amber); soonest upcoming later -> "due in X days" (amber if
≤7 days, neutral otherwise); no not-done dated services -> "nothing due".
A small "N due this week" count rides alongside when non-zero. Built via
a new local `_taDueLabel()`/`_taDaysBetween()` pair, reusing the exact
same not-done/dated service classification `_taSvcDueStatus()` already
computes — the label can never drift from the % done or overdue bucket
counts shown next to it. Verified against the task's own live data
reference (Sherine: 43 not-done, 0 overdue, 28 due within 7 days, soonest
due today) via Playwright — reproduces "due today" exactly, plus separate
overdue/due-soon/nothing-due cases, and confirmed zero "at risk" text
remains anywhere on the page.

**Time-off day-count undercounted — real root cause was a timezone bug,
not naive subtraction (2026-08-08).** Reported live: Aug 10-13, 2026
(Mon-Thu) stored `days:3` instead of 4. The task's own hypothesis was a
naive `endDate - startDate` subtraction, but reading the actual code
(`_calcBusinessDays()` in `index.html`, and its own inline copy in
`user.html`'s `submitTimeOffRequest()`) showed both already had a correct-
looking *inclusive weekday-counting loop* — the real bug was
`new Date(dateStr)` on a bare `'YYYY-MM-DD'` string, which JS parses as
UTC midnight. In any negative-UTC-offset timezone (confirmed by actually
running the existing code under `TZ=America/New_York`, not assumed), that
UTC instant reads back as the *previous* calendar day locally, so
`.getDay()` silently misclassified the real start date's weekday — Monday
Aug 10 read as Sunday and got dropped, reproducing the exact `3` instead
of `4`. Fixed both copies the same way `adjustOffWeekend()`/`calcNextDue()`
already do elsewhere in this codebase: parse the y/m/d integers directly
into a LOCAL `Date`, never `new Date(dateStr)`. Verified under three
timezones (UTC, America/New_York, Asia/Tokyo) to confirm the fix is
timezone-independent, plus Playwright end-to-end through both the admin
"Log Time Off" ledger tool and the employee-facing `user.html` request
form. `daysManuallySet` entries were already correctly bypassing the
auto-calc (untouched). Append-only ledger (rule on `ops_time_off_ledger`)
means this fixes future entries only — Sarah re-enters the wrong Aug 10-13
entry herself; the old wrong row stays as an immutable audit record, by
design.

Flagged, not fixed (out of scope — a *different* computation, same root-
cause pattern): `getTimeOffBalance()` (`index.html`) and
`getMyTimeOffBalance()` (`user.html`) both bucket ledger entries by year
via `new Date(e.startDate).getFullYear()`, which has the identical UTC-
parse quirk — confirmed live (`TZ=America/New_York`,
`new Date('2026-01-01').getFullYear()` returns `2025`), so a Jan 1 entry
would misbucket into the prior year's balance. Not touched — this task was
day-count only. Also flagged, not fixed: the "Specific Days" time-off entry
mode (pick arbitrary individual dates, each always worth 1 day) has no
weekend restriction at all — a deliberately different, existing model from
the date-range calc this task fixed, not the reported bug.

**Time-off ledger edit/undo — implemented as reversing entries, append-only
protection untouched (2026-08-10).** Sarah wanted a way to edit or undo a
time-off log entry; `ops_time_off_ledger` stays fully append-only (DB
trigger blocks UPDATE/DELETE, see rule above) — no exception was carved
into it for this, unlike the earlier `ops_error_log_archive_guard` narrow
exception. Instead, Undo/Edit in `index.html`'s Time Off Ledger (Super
Admin/Owner only — same tier `api/ops-sync.js` already restricts ALL
`ops_time_off_ledger` writes to, confirmed by reading `insertNewOnly()`:
every write is `.upsert(..., {onConflict:'id', ignoreDuplicates:true})`,
which is INSERT-ON-CONFLICT-DO-NOTHING at the SQL level — never an UPDATE,
even before the trigger would catch one) are pure accounting-style
reversing entries:
- **Undo** appends one new entry: same employee/type/dates, `days` negated,
  `isReversal:true`, `reversalOf:<originalId>`. The original is never
  touched.
- **Edit** = Undo (reverse the original) + a fresh entry with the edited
  values via the exact same `logTimeOffEntry()` path every normal entry
  uses (so it gets the already-fixed weekday-inclusive day count for free),
  tagged `correctionOf:<originalId>` for the audit chain.
- Balance math (`getTimeOffBalance()`/`getMyTimeOffBalance()`) needed
  **zero changes** — both already just sum every entry's `days` for the
  year, so a reversal's negative value cancels its original automatically.
  UI-side, an entry is detected as "reversed" purely by another entry
  existing with `reversalOf` pointing at it (never a flag mutated on the
  original) — rendered struck-through with a REVERSED badge, and its
  Undo/Edit buttons disappear (can't reverse an already-reversed entry).

**Verified, not assumed, that no UPDATE/DELETE is ever issued**: read
`insertNewOnly()`'s actual Supabase call (confirmed INSERT-ON-CONFLICT-
DO-NOTHING), then reproduced the exact write sequence (original + reversal
+ correction, all three via plain INSERT) against a real local Postgres
with the actual `ops_time_off_ledger` append-only trigger installed —
all three inserts succeeded, and a direct UPDATE/DELETE attempt against
the same table both failed with the trigger's exception, confirming the
protection this feature relies on is real and unweakened. Playwright (23
checks): logged a 4-day entry, undid it (2 ledger rows, original
unchanged at days=4, reversal at days=-4, balance drops **4 used → 0
used**), then edited a separate 3-day entry to 5 days (reversal -3 +
correction +5, balance shows **5 used**, not 3+5=8 — confirms no double-
counting), confirmed a non-super admin sees no Undo/Edit buttons and a
direct function call is refused client-side, and confirmed every captured
`ops-sync` call across the whole flow carried no delete/tombstone request.

Found and fixed alongside (small, in the same function touched):
`logTimeOffEntry()` never called `cloudAutoSync()` after writing — every
other similar admin write action in this file does. Left unpushed, a
reversal/correction would sync only on the next 30s pull-driven dirty
check rather than immediately; added the same explicit push call the
undo/edit paths need anyway, applying it to the plain "Log Time Off" path
too for consistency (same effect either way, just immediate instead of
next accidental catch-up).

**PR #224's "missing `cloudAutoSync()`" premise was wrong — it added a
second, redundant call — plus sick-overflow-into-vacation auto-spill
(2026-08-11).** Two issues from the same task.

Issue 1 (Undo/Edit buttons reportedly not appearing in production):
exhaustively investigated and **no code defect found**. Checked every
hypothesis the task raised, each via real Playwright reproduction, not
just reasoning: (a) the button-render code is present on `main` and in the
deployed template — `renderAdminTimeOffLedger()`'s `${actions}`
interpolation is intact, `startEditTimeOffEntry`/`undoTimeOffEntry` both
present; (b) a fresh real `doLogin()` AND the `restoreAdminSession()`
reload path both correctly resolve `_adminLevel==='owner'` and render both
buttons with realistic seeded ledger data; (c) `api/ops-auth.js`'s two
issuance paths (`PRIMARY_ADMIN_EMAIL` branch and the regular admin-row
branch) both correctly issue `level:'owner'` for super-tier admins — no
server-side mismatch; (d) the buttons were confirmed genuinely visible and
clickable via real `.isVisible()`/`.boundingBox()`/`click({trial:true})`
checks, not just present in the DOM (the exact class of false-positive
CLAUDE.md's verification standard calls out); (e) only one
`renderAdminTimeOffLedger`/`#tolHistoryList` exists — no stale duplicate
view. Nothing in this repo's code explains the reported symptom. Leading
hypothesis, NOT fixed here because it's outside this session's ability to
confirm or safely act on: a stale browser cache on Sarah's device, or she
was looking at a non-production URL. `vercel.json` was deliberately left
untouched rather than adding speculative cache-control headers against an
unconfirmed cause. If the buttons are still missing after a hard refresh
on the actual production URL, that's a live discrepancy this investigation
could not reproduce and needs a fresh, narrower repro (exact URL, browser,
account) rather than another blind code audit.

Issue 2 (sick overflow should auto-spill into vacation instead of going
negative): implemented as **Option A** — a pure calculation over the
ledger, via a new `_applySickSpill(usedSickRaw, usedVacationRaw, entSick,
entVacation)` helper (hand-duplicated in both `index.html` and `user.html`
per rule #3), called from `getTimeOffBalance()`/`getMyTimeOffBalance()`
right before the returned `sick`/`vacation` objects are built. The ledger
itself is never written to for this — a sick entry stays a sick entry
forever, only the derived/displayed balance spills the excess into
vacation, capped at whatever vacation actually has remaining. Chosen over
Option B (splitting into a real sick+vacation entry pair at write time)
because it composes for free with #224's reversals: undoing the
overflow-causing entry just changes the raw sick sum this function reads,
which flows straight back through the same math — no separate "un-spill"
step, no risk of the reversal targeting the wrong entry type. Verified
against the exact task example: Assmaa with 6/6 sick already used, log a
7th sick day → sick shows **0 used / 0 remaining (of 6)**, not -1;
vacation shows **1 used / 14 remaining (of 15)**. Undoing that 7th entry
restores sick to 6/0-remaining and vacation back to 0/15 — confirms the
spill and its reversal both round-trip cleanly, no double-counting. Also
verified: no-overflow (values pass through unchanged), exactly-at-
entitlement (no spill), both sick and vacation fully exhausted (sick goes
negative exactly as before — spill only ever pulls from vacation that
actually has room), a partial spill (vacation absorbs what it can, sick
keeps the remainder as overage), and the on-probation case (0/0
entitlements, nothing to spill into, raw values pass through).

**Real bug found and fixed while building Issue 2's verification test,
not itself part of either reported issue:** `logTimeOffEntry()` called
`cloudAutoSync()` **twice** per single log/edit/undo action — once mid-
function (added by PR #224, whose commit message claimed the function
"never called `cloudAutoSync()`," which was false) and once already at the
end of the function (present since well before #224, commit `38c87b7`).
Production is very likely not showing literal duplicate ledger rows from
this — `insertNewOnly()`'s `.upsert(payload,{onConflict:'id',
ignoreDuplicates:true})` was already confirmed idempotent against a real
Postgres instance during #224's own work, so the second push of an
already-accepted row should be a silent no-op server-side. But this is
exactly the class of bug CLAUDE.md rule #2 exists to prevent — an
unnecessary second live network push per write, resting entirely on the
server's upsert semantics happening to save it — and it was directly
reproducible: an isolated Playwright test logging one manual 6-day sick
entry, with a stateful `/api/ops-sync` + `/api/ops-state` round-trip mock
(append-then-echo-back, matching real upsert-then-pull behavior), showed
the entry landing **twice** in the locally-reconciled ledger after the
double push. Removed the redundant mid-function call, kept the pre-
existing one at the end (after the form resets and the ledger re-renders,
matching every other admin write action's convention in this file).
Re-ran the isolation test after the fix: exactly one entry, no duplicate.
This was found, diagnosed to its exact root commit via `git blame`, and
fixed as part of this same PR rather than filed separately, since it
directly affects the append-only ledger this task was already touching and
Issue 2's own verification depended on the ledger not silently
double-writing.

**Daily backup snapshots (ops_backups) + admin restore viewer, and the
Vercel Hobby-plan limits it collided with (2026-08-18).** Built a daily
automated snapshot of every `ops_*` data table into a new `ops_backups`
table, plus an Admin Controls "Data Backups" panel (Super Admin/Owner
only) to list/download snapshots, take an on-demand manual snapshot, and
restore one — restore follows the full rule #6 pattern (dry run computes a
per-table diff and an HMAC `reviewToken`; confirm requires typing
`RESTORE <backup-id>` exactly, both re-checked server-side) and is
deliberately upsert-only, never deleting a row that's live but absent from
the snapshot. New migration `20260817130000_ops_backups.sql`: a dedicated
`ops_backups_guard()` trigger (blocks all UPDATE; blocks DELETE except on
`daily-auto` rows, matching the narrow-exception pattern already
established for `ops_error_log`). Shared logic lives in `lib/opsBackup.js`
(`BACKUP_TABLE_PK` per-table primary-key map, since this schema isn't
uniformly `id`; `APPEND_ONLY_TABLES` special-cases `ops_feed`/
`ops_time_off_ledger` to insert-missing-only, since their DB trigger blocks
all UPDATE/DELETE unconditionally). Deliberately excludes `ops_error_log`
and `ops_session_activity` from the snapshot/restore scope — diagnostic/log
tables, not restorable business data.

This shipped as its own scheduled cron (`api/cron-backup.js`, a second
`vercel.json` crons entry) and immediately hit two separate Vercel Hobby
plan ceilings in sequence, each only visible once the *previous* one was
fixed and a real deploy was attempted:

1. **Cron-count limit.** Two `crons` entries exceeded the plan's per-project
   cron limit, failing every production deploy. Fixed by removing the
   `api/cron-backup.js` entry from `vercel.json` and instead calling the
   same `buildBackupSnapshot`/`insertBackupRow`/`pruneOldDailyBackups`
   logic from the end of `api/cron-overdue-check.js`'s own run — piggy-
   backing the daily snapshot onto the one remaining cron slot. The backup
   step runs unconditionally, independent of the overdue-notifications
   toggle and of whether the overdue-side client read succeeds, so neither
   a disabled toggle nor an overdue-side error silently stops the daily
   backup; a backup failure is caught, logged, and reported in the
   response's `backup` field without turning the endpoint's own overdue
   work into a failure.
2. **Function-count limit.** Separately, the app had grown to 14 files
   under `api/`, exceeding the Hobby plan's 12-serverless-function cap —
   also a hard deploy-blocker, unrelated to the cron-count issue above
   (confirmed by finding the identical immediate deployment failure on a
   commit that predated the cron fix). Fixed by deleting two files outright
   rather than just trimming call sites: `api/cron-backup.js` (fully
   redundant once its logic moved into `cron-overdue-check.js` per the fix
   above — keeping it around unscheduled would still have cost one of the
   12 function slots for nothing) and `api/import-legacy-data.js` (the
   one-time Phase 5 client importer — its job was done and verified back
   when it ran, so per rule #6 it was due for removal regardless of the
   function-count pressure; this just made it non-optional). Removing the
   importer also meant removing its Admin Controls UI card and JS
   (`runClientImportDryRun`/`confirmClientImport`/etc.) from `index.html`
   per rule #6's "remove the tool: endpoint, UI card, JS functions"
   language — leaving the frontend calling a deleted endpoint would have
   silently 404'd for any admin who clicked it. `lib/legacyDataTransform.js`
   was noticed to already be fully orphaned (no import anywhere, including
   from `import-legacy-data.js` itself, despite its header comment
   referencing that file) — left alone as out of scope for this fix, since
   it costs no serverless-function slot; flagged here instead of silently
   deleted.

Net effect: 12 files under `api/`, exactly at the Hobby plan's limit — any
future new endpoint needs an existing one removed or folded in first, not
just added.

**Task Assignments (admin) + Daily Tasks (employee) — port of the
standalone WebLight Media Email Tracker (2026-08-19).** New `ops_tasks`
table (migration `20260819100000_ops_tasks.sql`, plain mutable table like
`ops_clients`/`ops_users`) plus two new UI sections: "Task assignments" in
`index.html` (admin: sees/assigns every task, Import & Parse box, List/
Calendar toggle, filters, slide-in detail panel, edit modal) and "Daily
tasks" in `user.html` (employee: two tabs — My assigned tasks / Add-import
tasks — scoped to their own tasks only, no assignee dropdown, no team
roster). "My Work" was not touched. Per the Hobby-plan function-count limit
above, **no new `api/*.js` file was added** — three existing endpoints were
extended instead:

- `api/ops-sync.js`: a new `c.tasks` write block. Admins have full CRUD/
  reassign; members may only create a new task (forced server-side to
  `origin:'self'`, `assigneeId`/`assignedById` forced to their own id
  regardless of what the client sends) or touch status/notes/tags on a task
  already assigned to them — every other field is admin-only
  (`TASK_KEYS_MEMBER_MAY_NOT_TOUCH`, same allow-list pattern as
  `CLIENT_SCALAR_KEYS_MEMBER_MAY_NOT_TOUCH`, which also gained a new
  `clientEmails` entry for the salvage field below). A task's assignee
  actually changing (including a brand-new task created WITH an assignee)
  fires an in-app + email notification via a new
  `fireOpsTaskAssignmentNotifications()` — deliberately reusing the
  existing `insertNotifications()` mechanism (which already sends the
  email itself via Resend for every other assignment-type event in this
  file) rather than the separate `api/send-assignment-email.js` tool the
  original build spec named — same effect, one fewer moving part, no new
  session/tier friction. Also fixed, found while building this: an admin
  UPDATE to an existing task with a stale/falsy `assignedById` (e.g. a
  second quick edit before the next 30s pull catches up) used to silently
  blank an already-correctly-set value — an update now preserves
  `cur.assignedById` when the incoming value is falsy, mirroring the
  Contract-End-date/`serviceAreas` "never let an absent field blank a real
  value" convention already used elsewhere in this codebase.
- `api/ops-state.js`: a new `tasks` field, scoped exactly like
  `notifications` — a member gets only tasks where they're the assignee OR
  the creator, unconditionally on tier; every admin tier sees every task.
- `api/process-transcript.js`: a new `mode:'taskEmail'` branch, completely
  separate from the pre-existing Roadmap meeting-transcript extractor this
  file already had (different system prompt, different category/type
  vocabulary, different output shape) — sharing the file only because of
  the function-count limit above. Unlike the Roadmap mode's loose optional
  static-key check, this mode requires a real signed ops session
  (`requireSession`), since the extracted tasks get written under that
  caller's identity. Client-matching (sender email → a client's new
  `clientEmails[]`/legacy `clientEmail` → case-insensitive name → sender-
  domain vs client-website-domain) is deliberately plain deterministic
  code, never left to the model to guess — a wrong auto-match would
  silently attach a task to the wrong client. Only `status:'active'`
  clients are ever queried as match candidates, so an inactive client can
  never receive a parsed task. The Roadmap mode's own code path is
  byte-for-byte untouched.
- `lib/opsBackup.js`: added `ops_tasks` to `BACKUP_TABLE_PK` so tasks are
  included in the existing daily/manual snapshot and restore flow — no
  separate mechanism.

Two small deviations from the original build spec, made after investigating
the actual codebase rather than guessing, both confirmed with Sarah before
implementing: (1) email mechanism above (`insertNotifications()` instead of
`api/send-assignment-email.js`); (2) the spec's `Type` field listed
"Task | Client Update | New Service | New Sale | Follow-up …" with a
trailing ellipsis (no complete list given) — built as a fixed 5-value enum,
ellipsis dropped, rather than free text. `Category` is the fixed 6-value
enum the spec did fully specify (`Production/Updates/Sales/Admin/Other/
Invoices-Payments`, the last displayed as "Invoices" in the UI). Reply
status is free text (matches the mockup's varied values like "4h"/"1d"/"—"
directly, no invented bucket list). A `service` free-text field was added
to the task shape to reconcile a spec inconsistency: section 2's data model
didn't list it, but section 4's edit-modal field list did — added as a
plain optional string, not linked to the real Service Catalog.

**Not done in this change, by design:** the actual tracker→client email
mapping data (the spec's own plan was for Sarah's operator to load that
separately via connector once the `clientEmails[]` field existed — this
change only adds the field and its member-write protection, no data). Per
rule #12, this PR's migration must be confirmed applied to production
before merge, same as every migration-adding PR.

**Task Assignments email-parser: live-roster owner matching + server-
enforced scope (2026-08-19).** First installment of a larger "make the
parser behave like Sarah's original app" batch, shipped as its own focused
PR per that batch's own instruction. Two changes, same code path:

1. `api/process-transcript.js`'s `taskEmail` mode now asks the model for an
   `ownerName` per extracted task, matched against a LIVE roster built
   fresh from `ops_users`/`ops_admins` on every request (name + title/
   level, e.g. `"Rana Ayman — Designer"`) — never a hardcoded example list.
   This deliberately avoids the exact failure mode already present in this
   same file's OTHER mode (the Roadmap meeting-transcript extractor's
   `SYSTEM_PROMPT`, which still hardcodes `sarah/david/emily/jacob/rania` as
   example owners) — that mode is untouched, its own flaw flagged below,
   not fixed here since it's a separate feature. Matching is deterministic
   (`matchOwner()`): exact full-name match first, then a first-name match
   ONLY if it's unambiguous — two people sharing a first name resolve to
   `null` (left for a human to assign), never a coin-flip.
2. The extracted-task list is filtered server-side by the CALLER's own
   scope before any of it is returned, computed from the signed session
   token alone (the request body carries only `{mode, text}` — nothing
   about the caller's role for a modified client to spoof): an admin/super
   caller sees everything, unfiltered; anyone else sees only tasks matched
   to themselves or to a direct report (`users[].managerId` pointing at
   them — the SAME field index.html's assignment-escalation notifications
   already read, so a "manager-tier" employee like Sherine is nothing more
   than a plain member whom other members' `managerId` happens to point
   at, not a distinct tier). A task matched to someone outside that scope
   is silently dropped from the HTTP response — a member never even
   receives it, let alone gets a chance to import it. An unmatched-owner
   task is left `null` (unassigned) for an admin caller, exactly as
   before, but defaults to the caller themselves for a member — matching
   how `api/ops-sync.js` already treated an unassigned member-created task
   before this change.
   
   This second half required a matching write-side change:
   `api/ops-sync.js`'s task-creation path previously forced EVERY
   non-admin-created task to `assigneeId: session.id` unconditionally, with
   no exception — meaning even if the parser correctly matched a task to
   Sherine's report Rana, saving it would have silently overwritten that
   back to Sherine. Fixed by computing the same "self + direct reports" set
   server-side at write time (via the existing `getDirectory()` helper) and
   allowing a member to create a new task with `assigneeId` set to anyone
   in that set — silently falling back to themselves for anyone outside it
   (never a hard rejection, matching this block's existing "force-correct,
   don't reject" convention for the CREATE path). An individual contributor
   with no reports gets exactly the old behavior back, since their
   allowed-set is just `{self}`. Updating an EXISTING task is unchanged —
   still member-restricted to a task already assigned to them, still only
   status/notes/tags. `api/ops-state.js` needed NO change at all: its
   existing member read-scope (`assigneeId === session.id ||
   assignedById === session.id`) already covers "tasks I created for
   someone else," so once Sherine creates Rana's task, both of them
   already see it correctly — that scoping was already exactly right for
   this, just previously unreachable because nothing could write such a
   row.

Verified with two Node scripts exercising the real, byte-identical
`api/process-transcript.js` and `api/ops-sync.js` against in-memory fakes
(rule #9 pattern, no live DB access per rule #11): 21/21 checks on the
parse+scope side (admin sees all three tasks including two different
matched owners and one unmatched; Sherine sees her own + Rana's, Michael's
is dropped, an unmatched one defaults to her; Rana sees only her own, her
manager Sherine's task is dropped; an ambiguous two-"Sam" roster never
resolves to a guess; client-matching is unaffected; the prompt sent to the
model contains the live roster and NOT the stale Roadmap-mode names) and
15/15 on the write-side scope (Sherine creating a task for report Rana is
honored; Sherine attempting one for non-report Michael silently falls back
to herself; Rana cannot assign to her own manager either; admin remains
fully unrestricted; the existing "not your task" update rejection is
unchanged). `index.html`/`user.html` both now default a parsed task's
`assigneeId` to whatever the server resolved, instead of always `null`
(admin) or always self (employee) — freely reassignable afterward exactly
as before.

**Flagged, not fixed — separate items in the same "parser quality" batch,
each its own PR:** due-date extraction from relative language ("by
Friday"), dropping the "Type" field, fixing client detection (including a
possible "WebLight Media (Internal)" pseudo-client that this agent cannot
confirm exists in production without live DB access — rule #11), and
cross-transcript/existing-task dedupe+merge. The Roadmap mode's own stale
hardcoded owner-name list (`sarah/david/emily/jacob/rania` in this same
file's OTHER `SYSTEM_PROMPT`) is a pre-existing, separate flaw, not touched
by this PR — flagged here since this PR fixes the identical problem in the
sibling mode.
**Security & Cleanup item #11 (password hashing) — investigation found this
was already shipped, one genuine gap closed (2026-08-19).** Given as the
highest-risk, do-last item of a 4-part batch ("stop storing `ops_users`
passwords in cleartext... add a hashing library... one-time cutover...
login change"). Reading the actual code before writing anything found the
entire feature already merged to `main` (commit `d56f0d0`, 2026-07-25,
predating this batch by three weeks) and never previously written up here
— an existing documentation gap, not new work: `lib/passwordHash.js`
(scrypt via Node's built-in `crypto`, chosen deliberately over bcrypt/
argon2 to avoid a new dependency or native-binary build step that could
fail on Vercel, self-identifying `"scrypt:<salt>:<hash>"` stored value so
`isHashed()` can tell a migrated row from legacy plaintext with one cheap
check); `api/ops-auth.js` verifies a hash-or-plaintext on every login
(covering `ops_users`, `ops_admins`, and the primary admin's
`ops_settings.primaryAdminPw` alike) and lazily upgrades a row to a hash
on its own next successful login; `api/ops-sync.js` hashes any new/changed
password the instant it's written (`hashIncomingPasswords()` for admin-
created/edited users and admins, an explicit hash in `selfPasswordChange`)
so no code path has written a fresh cleartext password since that commit;
`api/ops-state.js` exposes a Super-Admin-only `passwordMigrationStatus`
count (hashed/legacy/total), rendered read-only in the existing Admin
Controls "Password Security Migration" card. No schema/migration change
was ever needed — the hash lives in the same existing `password` field,
told apart by its own prefix. `ADMIN_CREDENTIALS`/`ADMIN_CREDS` (out of
scope per Sarah's decision on the separate item #10) was never touched by
that commit or by this one.

The one literal gap against this batch's acceptance criteria ("no
cleartext passwords remain in `ops_users`"): the existing design is
lazy-only — an account that hasn't logged in or changed its password since
2026-07-25 is still sitting on legacy plaintext today, with no way to
force it. Closed by adding a genuine one-time cutover, matching the
spec's own explicitly-offered alternative ("hash everything in the
cutover") and CLAUDE.md rule #6's guarded-action pattern (mirroring
`api/ops-backups.js`'s restore flow byte-for-byte: dry run reads live data
and returns only names/table/count, writes nothing, returns an HMAC
`reviewToken`; confirm requires typing `HASH ALL LEGACY PASSWORDS` exactly
and re-derives the token from data read fresh at that moment, refusing
with 409 if live data changed since the dry run). No new `api/*.js` file
(the 12-function Hobby-plan cap has no headroom) — added as two new
top-level `action` values on the existing `api/ops-sync.js` POST endpoint,
Super Admin/Owner only, and a matching card/modal in `index.html`'s
Admin Controls tab. Each affected row is hashed and written individually
(`.update(...).eq('id', row.id)`, never a bulk table replace, per rule #1)
and re-checked with `isHashed()` immediately before writing — guards
against double-hashing a row that self-upgraded via a normal login in the
gap between the dry run and the confirm click, which would otherwise
permanently lock that person out.

Verified two ways, no live DB access being available (rule #11): (1) a
Node script (`lib/passwordHash.js`'s established rule #9 pattern) running
the real, byte-identical `api/ops-sync.js` against an in-memory fake
Supabase client — 25/25 checks, including that an already-hashed account
is never touched, a stale reviewToken is refused with 409 after live data
changes, a non-super caller gets 403, and — the acceptance criterion that
actually matters — every newly-hashed account's original plaintext
password still verifies successfully against its new stored hash (i.e.
nobody's real login credential changes); (2) Playwright against the real
`index.html` UI with a mocked `/api/ops-sync` — 16/16 checks covering the
full dry-run-then-confirm modal flow, the confirm button staying disabled
until the exact phrase is typed, and the request never carrying a
password value. `api/ops-auth.js` itself was not touched by this PR at
all (confirmed via `git diff`), so the existing, already-verified login
behavior (hash-or-plaintext compare, lazy upgrade) is unaffected by
construction — the "verified login on preview" acceptance criterion still
needs a real click-through on the Vercel preview before merge, same as
every other batch item in this set.
**Security & Cleanup batch, item #13 — removed WLM_SEED_DATA; root-caused
the org-chart node mismatch (2026-08-19).** Deleted the ~139 KB hardcoded
`WLM_SEED_DATA` client array from `client.html` (the original Excel-import
seed — unused since Supabase became the source of truth) along with its
only two remaining references, `seedWLMClients()` and
`backfillMissingServices()` — both already fully dead (never called;
already documented in this file's own disabled-functions history at the
2026-07-09 entry) and now referencing a deleted constant, so nothing of
value was lost by removing the bodies too. Confirmed via grep: zero
remaining references anywhere in the file. One new orphan noticed as a
side effect: `migrateServicesToProjects()`'s only caller was
`seedWLMClients()`, so it's now unreferenced too — flagged, not touched
(out of scope for this PR; it's a well-formed, general function, not
obviously safe to delete without separately confirming nothing else
should call it).

**Org-chart node mismatch (~27 `ops_org_nodes` rows vs. 9 real people) —
root cause found by reading the actual code, not guessed:** there is no
code path anywhere that removes or deduplicates an org-chart node when
the person it represents leaves, gets archived, or already has a node
under a different id — grepped for `archiveUser`/`_orgRemovePerson`/any
call site that touches `orgNodes` in response to a user-record change and
found none. Node removal is 100% manual, one at a time, via
`deleteOrgBubble()`'s own explicit tombstone — it was never wired to fire
automatically from anywhere else. Combined with the already-documented
2026-07-13 entry above ("the corresponding stale rows already sitting in
the live `ops_org_nodes` table were deliberately NOT touched by this PR
— that is a separate, later, dry-run-approved step"), this fully explains
the count: legacy rows from before `ORG_NODES_DEFAULT` shrank from 18 to
9 were never cleaned up, and every person who's left or been re-added
since has just added to the pile, with nothing ever subtracting from it.

Ruled out, not just assumed: traced whether a stale browser's full local
`orgNodes` array could resurrect an already-tombstoned node via
`orgSave()`'s `cloudAutoSync()` push — `orgLoad()` only refreshes the
in-memory `orgNodes` variable on an explicit pull, never on the 30s
background live-sync poll (`fromLiveSync===true` skips it), so a long-open
tab's stale in-memory copy really can get pushed back via any unrelated
`orgSave()` call (e.g. dragging one bubble). But `upsertRows()`'s payload
is only `{id, data}` — Postgres upsert never touches a column absent from
the payload — so this can't actually clear a tombstoned row's
`deleted_at` back to null. Confirmed this mechanism is real but not the
cause of the specific symptom reported here.

**Proposed reconcile (NOT executed — no data deletion without an approved
plan, per CLAUDE.md rule #6):** a dry-run tool, same pattern as every
other destructive-operation tool in this codebase — compute and display
which `ops_org_nodes` rows don't match any currently-active `ops_users`/
`ops_admins` record by name (cross-referenced, not just matched against
the 9-entry `ORG_NODES_DEFAULT`, so a real person who isn't in the
hardcoded defaults is never mistakenly flagged), require Sarah's typed
confirmation, then tombstone (never hard-delete) exactly the confirmed
set via the same `deleted_at` mechanism `deleteOrgBubble()` already uses.
A separate, smaller code fix worth considering afterward (not part of
this proposal, flagging only): make `orgLoad()` also refresh the in-memory
`orgNodes`/`orgLinks` variables on the background live-sync poll when the
server data actually changed, closing the stale-tab-clobbers-newer-state
window described above — lower priority since it can't resurrect a
tombstoned row, only produce a spurious no-op-equivalent write.

**Task parser quality batch — dropped the "Type" field (2026-08-19).**
First of several focused PRs off a "make the Task Assignments parser
behave like Sarah's original app" spec. This one removes the `type` field
entirely — it only ever read "Task" in practice and added a column/select/
detail-row nobody used. Removed from: `api/process-transcript.js`'s
`taskEmail` extraction schema and prompt (`TASK_TYPES` deleted), the Task
Assignments list column/filter/edit-modal in `index.html`, and the Daily
Tasks detail view in `user.html` (which never had an edit path for it —
display-only). `api/ops-sync.js`'s `TASK_KEYS_MEMBER_MAY_NOT_TOUCH` also
dropped `'type'` — found and fixed as part of the same change, not a
separate bug: leaving it in that list would have permanently rejected any
member status/notes/tags update on a task with legacy stored `type` data
the instant the client stopped sending the field, since
`JSON.stringify(cur.type) !== JSON.stringify(undefined)` is `true` even
though nothing meaningful changed. Verified with a Node script reproducing
exactly that scenario against the real `api/ops-sync.js` (rule #9) — a
member updating only status/notes on a task with legacy `type:'Client
Update'` data succeeds, not rejected. Existing rows that still carry a
stored `type` value are untouched (no migration, this is a document-model
jsonb field — it just stops being read or written going forward).

**Task parser quality batch — due date extraction + due-date sort
(2026-08-19).** Another focused PR off the "make the parser behave like
Sarah's original app" spec. `api/process-transcript.js`'s `taskEmail`
prompt now includes today's real date and weekday (computed fresh per
request — plain server-side `new Date()`, not a Workflow script, so this
is fine) as the reference point for relative language, plus explicit
resolution rules for the phrasings the spec named: "by/this &lt;weekday&gt;"
(the next occurrence, today if today IS that weekday), "next &lt;weekday&gt;"
(that weekday next week, never this week), "next week" (next week's
Monday), "end of month" (last day of the CURRENT month), "tomorrow"/
"today", and "in N days/weeks". A new `validDueDate()` guards the
returned value before it's ever used: `Date` silently ROLLS OVER an
out-of-range date instead of failing (`"2026-02-30"` normalizes to March
2) — checking `getTime()` alone would let that corrupted value through
as if it were real, so this round-trips the parsed year/month/day back
out and compares them to the original string, dropping to `''` (treated
identically to "no due date mentioned") on any mismatch or non-ISO
format. `index.html`'s Task Assignments list now sorts by due date as the
PRIMARY key (undated tasks last — "nothing to act on yet" rather than
implying urgency), with priority only as a tie-breaker among tasks
sharing a due date or lacking one, via a new `_taSortByDue()` applied
inside `_taFilteredTasks()` so every consumer (list view, filters, quick
filters) gets the same order for free. Verified with Node scripts against
the real, byte-identical `api/process-transcript.js` (malformed and
impossible dates both drop to `''`, a valid date passes through
unchanged, the prompt actually carries today's date and the resolution
rules) and the real, extracted `_taSortByDue()` (dated-before-undated,
earlier-date-first, priority tie-breaking both among same-dated and
among undated tasks, and confirms the input array itself is never
mutated).

**Task parser quality batch — client detection widened (2026-08-19).**
Another focused PR off the same spec. `api/process-transcript.js`'s
`matchClient()` (deterministic, never LLM-guessed — same conviction as
`matchOwner()`) gained three more signals, all checked in the same
most-confident-first order as before: a new `recipientEmail`/
`recipientName` pair is now extracted alongside the existing sender
fields (a task can be about something WebLight is sending TO a client,
not just receiving from one) and checked the same way sender email/name/
domain already were; and, lowest-confidence, an unambiguous mention of
the client's own name inside the task's subject/notes text — including a
parenthetical-stripped variant (`"WebLight Media (Internal)"` ->
`"WebLight Media"`), since nobody types the qualifier verbatim when
writing about their own internal work. "Unambiguous" is load-bearing
here: the text-mention check only accepts a match when exactly one active
client's name (or stripped name) appears — confirmed with the exact
"Fern Wood Flooring" vs a hypothetical shorter "Fern Wood" overlap
(the same client CLAUDE.md already flags a spelling trap for elsewhere)
correctly resolving to unassigned rather than guessing either one. A
minimum-length guard (4 chars) keeps a short/generic client name from
matching all over unrelated text. Confirmed against Sarah's specific
example: "WebLight Media (Internal)" already exists as an active client
record in production (per Sarah directly — not independently verified,
no live DB access, rule #11), so no data change was needed, only the
matching logic. Verified with a Node script against the real, byte-
identical `matchClient()`/`matchClientByTextMention()`: recipient email
and recipient name both resolve a client; the Internal client resolves
via both its full and stripped name; a task with genuinely no client
signal stays unassigned; the short-name guard holds; the ambiguous-
overlap case resolves to unassigned, not a guess; and the pre-existing
sender-email match is unaffected.

**Task parser quality batch — cross-transcript dedupe/merge + mark-done
detection (2026-08-19).** Last item of the "make the parser behave like
Sarah's original app" spec (item #5), highest-risk of the batch so
built last, with a design choice confirmed with Sarah first: deterministic
similarity matching, not an LLM judging duplicates — same "plain code,
reviewable, no guessing" conviction as `matchClient()`/`matchOwner()`
already use for this feature.

`api/process-transcript.js` gained a new `alreadyDone` boolean per
extracted task (true only when the text explicitly says that specific
item is finished — never inferred from a task merely sounding routine)
and a two-stage dedupe pipeline, both purely deterministic:

1. **Within-batch** (`dedupeWithinBatch()`): collapses duplicates
   mentioned more than once across the pasted text — e.g. four meeting
   transcripts all referencing the same follow-up — BEFORE anything is
   compared against storage. `isSameTask()` requires matching client AND
   matching assignee AND a subject token-overlap (Jaccard) similarity
   ≥0.6 (`subjectSimilarity()`, stopword-filtered) — a near-miss on
   wording alone is never enough; a similar-sounding task about a
   different client never merges. Merging is purely additive: notes
   concatenated, tags unioned, earliest non-empty due date wins,
   `alreadyDone` becomes true if any merged mention says so.
2. **Against existing storage**: each survivor is checked against
   existing NOT-done `ops_tasks` (a Done task is never a merge target —
   the goal is stopping a still-open item from doubling, not reopening
   finished work), scoped exactly like the owner-matching filter (an
   admin can match against anyone's task; a member/manager-tier caller
   only against one already in their own scope — self, or a direct
   report). A match attaches `mergeIntoId`/`mergeIntoSubject` to the
   response — the endpoint itself never touches existing data; it only
   tells the client which row to fold into instead of inserting a new
   one.

`index.html`'s `runTaskEmailParse()` and `user.html`'s
`runDtEmailParse()` both now branch on `mergeIntoId`: when present, the
merge is deliberately narrow and additive ONLY — notes appended (never
overwritten), tags unioned, due date filled only if the existing task
doesn't already have one, status escalated to Done only if the text
said so. Every other field of the existing task (assignee, client,
category, priority, service, replyStatus, etc.) is left completely
untouched — a wrong fuzzy match costs at most a stray note, never
corrupts someone's real tracked work. This was the deliberate reason to
avoid a full-object overwrite on merge, even though the existing
admin-edit path already allows one: a fuzzy similarity match is a much
weaker signal than a human clicking Save on a specific row, so it gets a
narrower blast radius. `alreadyDone` on a brand-new (non-merged) task
sets its initial `status` to `'Done'` instead of the usual `'Not
started'`.

Verified two ways, no live DB access (rule #11): (1) a Node script
against the real, byte-identical `api/process-transcript.js` — four
near-duplicate mentions collapse to one task with all four notes
preserved; a genuinely different subject is never merged; a brand-new
`alreadyDone` task gets `status:'Done'`; a similar-subject/same-client
candidate correctly matches an existing open task by id; the same
subject with a DIFFERENT (unmatched) client does not match; an existing
task already marked Done is never offered as a merge target; and a
member's merge candidates are correctly scoped (an existing task
entirely outside their scope is dropped by the earlier owner-scope
filter before the merge step ever runs, same as any other out-of-scope
task). (2) Playwright against the real `index.html` UI end-to-end
(mocked `/api/process-transcript`/`/api/ops-state`/`/api/ops-sync`): a
merge produces exactly one net-new task plus the existing task correctly
updated (not a third duplicate row) — notes appended, tags unioned, due
date filled in, client/assignee left untouched, status unchanged (no
`alreadyDone`) — while a separate brand-new `alreadyDone` task is
created with `status:'Done'`. 8/8 checks passing.

**Task parser quality batch — "Assigned Tasks" schedule tab, separate
from parsing (2026-08-19).** Last of the focused PRs off the same spec.
Before this, Task Assignments was one single page: the "Import & parse"
card sat directly above the existing List/Calendar(month-only) toggle,
filters, and table — no separation between "bring in new tasks" and
"browse/schedule what's already assigned." Split into two sub-tabs
(`setTaSubtab()`, new `#ta-subtab-parse`/`#ta-subtab-assigned` wraps): the
parse card now lives alone under "📧 Add / Import"; everything else
(view toggle, filters, category pills, list/calendar) moved under "🗓
Assigned Tasks." Switching sub-tabs is a pure display toggle, same
pattern as the existing List/Calendar toggle it sits next to — no new
data-fetch, and switching INTO "Assigned Tasks" re-renders so anything
imported (or changed by someone else, picked up by the normal live-sync
poll) while parked on the parse tab shows fresh.

The view toggle itself grew from 2 options (List/Calendar-month-only) to
4 (List/Day/Week/Month) per the spec's explicit "Day / Week / Month
views (a schedule you can map work across)" ask. `_taCalDate` is kept as
the ONE shared "current period" anchor across all three calendar-style
views (previously only Month used it) — `_taShiftPeriod(delta)` shifts it
by day/week/month depending on which view is active, rather than three
separate date variables that could drift from each other when switching
views. New `_renderTaDay()`/`_renderTaWeek()` sit alongside the existing
`_renderTaCalendar()` (month), reusing the same due-date bucketing and
overdue-coloring conventions.

"Assigning/reassigning reflects immediately in the assignee's Daily
Tasks" needed NO new plumbing — `_taReassign()` already pushed via
`cloudAutoSync()` immediately on every reassignment (list row, detail
panel, or edit modal), and both portals already poll `/api/ops-state`
on their existing live-sync interval; this requirement was already true
of the existing architecture, confirmed rather than assumed via the
Playwright check below (a reassignment produces an `ops-sync` push
carrying the new `assigneeId` within the same interaction, no manual
refresh triggered).

Verified via Playwright against the real `index.html` UI (mocked
`/api/ops-state`/`/api/ops-sync`): the parse sub-tab is visible by
default and the assigned-tasks sub-tab hidden, switching flips both
correctly; List is the default view within Assigned Tasks; switching to
Day/Week/Month each correctly shows a task due today in that view's
grid/list; switching back to List works; and reassigning a task from the
list row's inline dropdown fires an `ops-sync` push carrying the new
assignee, immediately, in the same interaction.

**Task Assignments: quick-filter/view button resize + calendar
completeness (2026-08-19).** Reported as two display bugs plus a request
to verify a suspected data-completeness issue before touching anything
persistence-related.

Root cause of the resize bug: `toggleTaQuickFilter()` and the category-
pill renderer toggled a button's class between `btn-outline` (inactive)
and `btn-primary` (active) to show which filter was on. `.btn-primary`
sets `width:100%` (it's designed for a full-width primary action button,
e.g. "Save"), so an "active" quick-filter or category pill would balloon
out to fill its row instead of just changing color — the exact "changes
dimensions" symptom reported. `setTaView()` (List/Calendar) had a milder
version of the same class of bug: toggling `btn-outline` on/off entirely
changes the border width, shifting the box size by a couple of pixels.
Fixed by introducing `.btn-toggle-active` — a modifier class that only
sets background/color/border-*color*, layered on top of a `btn btn-sm
btn-outline` base that never changes between the two states. Applied to
all three affected controls (quick filters, List/Calendar toggle, and the
category pills — the pills weren't named in the report but have the
identical `btn-primary` bug, found while fixing the reported ones and
fixed in the same pass since it's the same root cause in the same page).

Calendar view: removed the hard `dayTasks.slice(0,3)` per day — a day
cell now renders every task due that day (the cell just grows taller;
`min-height` keeps empty days from looking cramped) instead of silently
hiding anything past the 3rd with a "+N more" that didn't lead anywhere.
Added a new `#taCalUndated` banner above the grid, populated whenever
any visible task has no `dueDate` at all (those can never appear on a
date grid by definition) — reports the count and, on click, switches to
List view where every task, dated or not, always renders. Before this,
an undated task was simply invisible on the calendar with no indication
it existed at all.

**Completeness/persistence check, run before touching anything (per the
task's own instruction to stop and flag rather than patch the UI if this
turned up a real data-loss bug): parsed a 19-task transcript and
verified the full path — no bug found.** Tested at two levels: (1)
Playwright against the real `index.html` UI with a stateful mock server
(an in-memory `Map` keyed by task id standing in for `ops_tasks`, so a
push really accumulates and a subsequent pull really reflects what was
stored, not a canned response) — all 19 tasks render in the List table
immediately after parsing, the `ops-sync` push carries all 19, the
mock store ends up with 19 distinct ids (no collision), and after a full
page reload (session restored from localStorage, a fresh `/api/ops-state`
pull) all 19 are still present and still render. (2) A Node script
against the real, byte-identical `api/ops-sync.js` (rule #9 pattern,
no live DB access per rule #11): pushed 19 brand-new tasks directly,
confirmed `applied.tasks === 19`, zero `rejected`, zero `warnings`, and
19 distinct rows actually stored. `_taGenId()`'s id scheme
(`Date.now()` + a 7-char base36 random suffix) was the leading
suspicion going in — a tight synchronous loop calling it 19 times can
easily return the same millisecond for all of them, leaving only the
random suffix as real entropy — but 36^7 ≈ 78 billion possibilities
makes a real collision at n=19 astronomically unlikely, and no
collision occurred in the actual test runs either. No code path was
found that drops, truncates, or batches tasks during save/sync; the
19-of-19 result held at every stage checked.

**Task Assignments: `assignedDate` field — resolve due dates from the
transcript's own date, not the parse date (2026-08-20).** Reported gap: an
old meeting transcript pasted in days after the meeting had its relative
due-date language ("by end of week") resolved against today's real date
instead of the meeting's own date, and nothing on a task recorded when it
was actually assigned versus when it happened to be parsed.

`api/process-transcript.js`'s `taskEmail` prompt now asks the model to
first determine one `assignedDate` for the WHOLE parsed text (a meeting/
transcript header with a date, an email "Date:" header, or a phrase like
"as of 8/18"), falling back to today's real date if none is found in the
text — this is asked once per parse, not per task, since every task
extracted from one pasted document shares the same source date. Every
per-task `dueDate`'s relative-language resolution ("by Friday", "next
week", "end of month", etc.) is now explicitly anchored to THAT
assignedDate rather than today's real date, which is still given to the
model separately (needed to resolve a bare "8/18"-style date's year).
Server-side, `assignedDate` is re-validated through the exact same
`validDueDate()` round-trip guard already used for `dueDate` (an
out-of-range or malformed model-reported date is never trusted) and
falls back to the request's own `todayIso` — computed once per request
and threaded into the prompt builder too, so the "today" the model sees
and the fallback used server-side can never disagree. Verified against the
task's own acceptance example: an assignedDate of 2026-08-18 (extracted
from the text) is applied to every task from that parse regardless of
when it's actually parsed; a dateless transcript falls back to the real
parse-time date; a malformed/impossible model-reported date (e.g.
"2026-02-30") falls back the same way `validDueDate()` already treats an
impossible `dueDate`; and the dedupe-within-batch merge (#245) preserves
the shared value across a merge.

`api/ops-sync.js` gained the matching write-side guarantees: `assignedDate`
added to `TASK_KEYS_MEMBER_MAY_NOT_TOUCH` (same admin-only scalar-identity
treatment as `dueDate`/`category` — without this, a member could backdate
their own aging metric by editing it on a task already assigned to them);
a brand-new task (either portal's manual "New Task" path, or a member's
own self-created task, not just a parsed one) gets `assignedDate` forced
to today server-side if the client didn't send one, so it's never blank
regardless of entry path; an admin's update to an existing task preserves
the stored `assignedDate` when the incoming payload omits it, the same
falsy-preservation convention already used for `assignedById` on this
exact code path — an accidental resave must never reset a task's aging
anchor back to "today."

Client-side, both `index.html`'s `saveTaskEdit()` (manual create/edit) and
`runTaskEmailParse()`/`user.html`'s `runDtEmailParse()` (parsed-task
creation) default `assignedDate` the same way, and both portals' detail
panels gained an "Assigned" row (`_taFormatShortDate()`/
`_dtFormatShortDate()`, formatting as "Aug 18") plus a same-portal age
label ("2 days ago"/"today"), computed from y/m/d components rather than
`new Date(isoString)` directly — the exact timezone-parsing bug class
already fixed once in this codebase's time-off day-count entry, so it was
avoided here from the start rather than reintroduced. The task list view
in both portals shows a compact "· Assigned Aug 18" addition to the
existing category subtitle line under the subject, rather than a new
table column — Task Assignments already removed its "Type" column for
being clutter nobody used (see the entry above), so a full 8th/5th column
here was deliberately avoided in favor of the same subtitle-line pattern
`emailReceivedDate` already uses in the detail panel.

Two scope decisions made and flagged rather than guessed silently: (1) no
"response-speed"/"aging" report or dashboard exists anywhere in this
codebase today (`replyStatus` is free text, manually typed, per an earlier
documented decision) — this task's request to "feed the response-speed/
aging metrics from assignedDate" is satisfied minimally by exposing
`assignedDate` itself plus a `_taDaysSinceAssigned()`/`_dtDaysSinceAssigned()`
helper and displaying the resulting age label, WITHOUT inventing a new
metrics dashboard nothing asked for; a dedicated aging/response-speed
report would be its own separately-scoped feature. (2) the existing
`emailReceivedDate` field (optional, per-task, editable, already shown in
both detail panels as "Email received") is conceptually adjacent but
deliberately left untouched — it is when an email itself arrived, editable
and sometimes blank by design, whereas `assignedDate` is a required,
never-blank anchor that drives due-date math and aging for every task
regardless of source. The two coexist rather than being merged into one
field. (3) `assignedDate` is not exposed as an editable input in either
portal's edit modal — it's set once (by the parser, or defaulted at manual
creation) and preserved thereafter; making it manually editable would need
its own explicit decision given it's now a permission-gated field.

Verified with Node scripts against the real, byte-identical
`api/process-transcript.js` (11/11: dated-transcript propagation, dateless
fallback, malformed-date fallback, the prompt itself asking for and
correctly anchoring to assignedDate, and dedupe-merge preserving it) and
`api/ops-sync.js` (9/9: insert-defaulting for both admin and member
create paths, honoring an explicit parsed value, admin-update
preservation, the member anti-backdating rejection, and a normal
status-only member update still succeeding). Playwright against both real
portal UIs (6/6 `index.html`, 5/5 `user.html`): list-row subtitle, detail
panel date + age label, and the "no assignedDate at all" case rendering
as "—" rather than "NaN"/"undefined" in either portal. All four of this
session's pre-existing Task Assignments Playwright regression suites
(button/calendar, schedule tab, dedupe/merge, 19-task completeness) re-run
clean against the combined file — 43/43, no regressions from this change.

**Task parser: client roster in prompt + broadened owner detection +
review-before-assign staging (2026-08-20).** Three related changes, one
PR, since the third depends on knowing both auto-detected fields exist.

**A. Client detection** — `buildTaskEmailSystemPrompt()` now takes the
live active client name list (same list `matchClientByTextMention()`
already draws from, including "WebLight Media (Internal)") and asks the
model for a new `clientName` field per task, matched to the EXACT name in
that list, best-matching a near-miss/phonetic spelling (e.g. "surf pro" →
"Servpro") rather than requiring an exact spelling in the source text.
Server-side, `matchClientByName()` re-validates the model's output against
the real list before trusting it — a hallucinated or slightly-off name is
never treated as a match. This is the PRIMARY client-detection signal now,
checked before the existing code-side `matchClient()` (email/domain/text-
mention), which remains as the fallback for whatever the model leaves
empty or gets wrong — same precedence relationship `ownerName`/
`matchOwner()` already has with the roster.

**B. Owner detection broadened** — the `ownerName` prompt bullet now
explicitly covers per-person ownership language beyond an explicit
"assigned to X": possessive framing ("X's priorities", "X's tasks" — a
list introduced this way belongs to X for every item under it), stated
future commitments ("X will…", "X agreed to…", "X is going to…"), and
reported speech ("X shared they'll…", "X mentioned she's going to…").
Still only ever resolves to a name from the live roster (`matchOwner()`
unchanged); still empty if no specific person is identifiable.

**C. Review-before-assign staging (the main change)** — parsing no longer
writes anywhere. `runTaskEmailParse()` (`index.html`) and
`runDtEmailParse()` (`user.html`) now populate an in-memory-only
`_taStagedTasks`/`_dtStagedTasks` array instead of pushing into the real
task list and calling `cloudAutoSync()`/`_scheduleCloudPush()` — nothing
reaches `ops_tasks`, no assignment notification fires, and nothing shows
in Assigned Tasks/My assigned tasks until a new "✅ Save / assign these"
button (`commitStagedTasks()`/`commitDtStagedTasks()`) is clicked. This
applies to EVERY extracted task, including a dedupe-matched merge
candidate (`mergeIntoId`) — a merge also mutates `ops_tasks`, so it waits
for commit too, deferred from where it used to happen automatically at
parse time. A staged row renders as an editable review card: subject
(read-only), then either (a) a new-task row with editable assignee
(`index.html` only — `user.html` shows a read-only "👤 &lt;name&gt;" badge
instead, since a member can't assign to anyone else, the same existing
role split every other member-facing surface in this app already
enforces), client, due date, priority, and category selects, all
pre-filled from the server's auto-detection but freely changed before
committing; or (b) a merge-candidate row, shown read-only ("↪ Will merge
into existing task: X") with no editable fields, since editing them
wouldn't apply to a merge anyway — just a Discard button. Discarding a row
removes it from staging only, no network call, nothing committed.
Committing applies the identical narrow/additive merge logic that used to
run automatically (notes appended, tags unioned, due date filled only if
missing, status escalated to Done only if the text said so) to whichever
rows still carry a `mergeIntoId`, builds a plain new task from every other
row's current (possibly edited) field values, pushes both in one
`_taSaveTasks()`/`dbSet(DB_KEYS.tasks)` + sync call, clears staging, and
switches to Assigned Tasks/My assigned tasks so the result is immediately
visible. The role-scope filter on parse itself (`callerTaskScope()` in
`api/process-transcript.js`) is unchanged — a member/manager-tier caller
still never receives an out-of-scope task in the HTTP response, staging or
otherwise.

No new `api/*.js` file — both parts touch only the existing
`process-transcript.js` endpoint and are pure client-side state in the two
portals; still exactly 12 files under `api/`.

Verified with a Node script against the real, byte-identical
`api/process-transcript.js` (13/13: exact clientName match, "WebLight
Media (Internal)" exact match, empty-clientName fallback to the existing
`matchClient()` domain signal, a hallucinated clientName never trusted,
and the prompt itself carrying the live client list plus the broadened
ownerName language) — the existing 53/53 process-transcript checks re-run
clean alongside it. Playwright against the real `index.html` UI: 26/26
(staging populates without touching Assigned Tasks or firing an ops-sync
call, auto-detected client/owner pre-filled, editing a field takes effect,
discarding a row drops it, committing pushes exactly the remaining rows
with edits intact and switches to Assigned Tasks) + 9/9 (a merge row
committed applies the exact same additive merge as before, with no
duplicate row created). Playwright against the real `user.html` UI: 17/17
(no assignee select anywhere in staging — exactly the client/priority/
category selects — the assignee shown as read-only text instead, editing
the client takes effect, committing lands in My assigned tasks only).
Three pre-existing Task Assignments Playwright suites needed updating (not
because of a regression — because they asserted the OLD auto-commit
behavior this task deliberately replaced): the dedupe/merge suite and the
19-task completeness suite now check the staging state first, then click
commit, then re-run the exact same post-commit assertions they always
had; both re-run clean. The schedule-tab and button/calendar suites needed
no changes and re-run clean as-is.

**Task Assignments/Daily Tasks: undo-import, "New" highlight, phonetic
name-matching, date write-rules (2026-08-20).** A five-part batch, one PR,
touching `api/process-transcript.js`, `api/ops-sync.js`, and both
`index.html`/`user.html`.

1. **Phonetic/fuzzy name-matching.** `buildTaskEmailSystemPrompt()`'s
   `ownerName` bullet gained the same near-miss/mis-heard tolerance
   `clientName` already had (e.g. "Shereen"/"Shireen" → "Sherine"), with an
   explicit example. `clientName`'s existing guidance was left functionally
   unchanged (it already covered this — see the 2026-08-19 "client
   detection widened" entry). On the code side, `matchClientByName()` (the
   deterministic re-validation of the model's own output against the real
   client list) gained a phonetic fallback: exact match first, then a
   Levenshtein-distance-based similarity check (`_phoneticSimilarity()`,
   normalized lowercase/alnum-only strings, 0.7 threshold, 4-char minimum,
   unambiguous-best-match-only) — catches the model returning something
   close-but-not-exact without ever guessing on a genuinely weak signal.
   `matchOwner()` was deliberately NOT given the same code-side fuzzy
   fallback — the task only asked for it on the client side, and a wrong
   client match is worse than a wrong owner match (owner is just
   assignment, easily reassigned; client drives what a task is "about").
2. **Effort-based due-date estimation.** The `dueDate` prompt bullet used
   to return an empty string whenever no due-date language was found.
   Replaced with an ESTIMATE requirement: quick/low-effort tasks (a short
   email, a call, a single post) land a few days out; substantial
   multi-step tasks (build a website, produce a video) land proportionally
   further out — weeks or more, no fixed maximum — still resolved relative
   to `assignedDate`, never today's real date. `validDueDate()`'s
   round-trip guard is unchanged and still the only thing standing between
   a malformed/impossible model-reported date and storage.
3. **Date write-rules, server-enforced in `api/ops-sync.js`:**
   `assignedDate` is now FULLY immutable post-creation — the admin-update
   branch no longer reads `inc.assignedDate` at all, only ever
   `cur.assignedDate`, so not even a direct API call can change it (there
   was already no UI path to attempt this — `assignedDate` has never had
   an editable input in either portal). `dueDate` gets a new
   `dueDateLocked` boolean: false at creation (both admin- and
   member-created paths), and the first time an admin's incoming `dueDate`
   actually differs from what's stored, it flips to `true` and every
   subsequent `dueDate` on that task is ignored server-side thereafter —
   an unchanged resave never locks it. `dueDateLocked` was added to
   `TASK_KEYS_MEMBER_MAY_NOT_TOUCH` (a member could never touch `dueDate`
   itself already, but the new boolean needed the same protection).
   `index.html`'s edit modal mirrors this optimistically (disables the
   `tem-due` input and shows a "🔒 Locked" label once `dueDateLocked` is
   true) so the UI reflects the lock immediately rather than waiting on
   the next pull; `saveTaskEdit()` computes the same lock transition
   client-side the server will independently re-derive. **Reconciled, not
   silently dropped:** an earlier draft of this same request also asked
   for a hard "member's own due date capped to today+14 days" rule; the
   final, more deliberately-written version of the spec replaced that with
   "no fixed maximum" (item 2 above) and its own date-rules section no
   longer mentioned a member cap at all. Treated the later, fully-formatted
   version as the authoritative one and did not implement the +14-day cap
   — flagged back to the user rather than silently included or silently
   dropped, since the two drafts genuinely contradicted each other.
4. **Undo an import.** Every task from one parse action — staged or
   already committed — now carries an `importBatchId` (client-generated,
   one per parse call, purely a grouping key, never a permission/audit
   field). Pre-commit: the staging list groups rows by batch and offers an
   "Undo this import" button per batch that clears just those staged rows,
   no network call (nothing in staging has ever reached `ops_tasks`).
   Post-commit: a new `tombstones.taskIds` block in `api/ops-sync.js`
   issues a genuine hard SQL DELETE against `ops_tasks` — deliberately NOT
   the soft `deleted_at` tombstone pattern `ops_org_nodes`/`ops_org_links`
   use, since `ops_tasks` is a plain document-model table with no
   `deleted_at` column and no append-only guard (confirmed by reading its
   migration before choosing this). Permission scoping: admin/super may
   delete any task id; a member may only delete a task where they
   themselves are `assignedById` — enforced against the real stored row,
   never trusted from the client — which is exactly "a batch they
   themselves committed," since `assignedById` is always server-forced to
   the caller at insert time regardless of what the client sends. Each
   portal tracks its own session-only `_taRecentImportBatches`/
   `_dtRecentImportBatches` (in-memory, cleared on reload) mapping a
   committed batch to the specific task ids IT created, rendered as a
   small "Undo this import" strip on the parse sub-tab; deliberately
   excludes merge-candidate rows from the delete set — a merge only ever
   appends notes/tags/etc. to a PRE-EXISTING task, so "undo" for a merge
   would mean un-appending text, which was out of scope and not attempted
   (flagged here, not built). The tombstone-id push itself reuses the
   exact same "already-sent" localStorage dedup pattern
   `deletedOrgNodeIds`/`deletedOrgLinkIds` already established in
   `index.html`'s `cloudPushAll()`, hand-duplicated into `user.html`'s
   `cloudPushData()` (which had no tombstone mechanism at all before this).
5. **"New" highlight — reuses the Roadmap tab's existing `_rmIsNew`/
   `rm-card-new`/`rm-new-tag` pattern, but the two portals needed two
   different anchors for what "new" means, not one shared mechanism:**
   `index.html` (admin) added `_taIsNew()`, the same page-load-timestamp
   marker `_rmIsNew` already uses (`wl_ta_page_load` in sessionStorage,
   recorded once per session in `loadTaskAssignments()`), compared against
   a new `lastAssignedAt` timestamp that's bumped whenever a task's
   assigneeId actually changes — a brand-new task, a reassignment via the
   list row's inline dropdown (`_taReassign()`), or a reassignment via the
   edit modal (`saveTaskEdit()`) all bump it; this reads as "recently
   added or (re)assigned, so you can see what just came in," clearing only
   on the next page load, same as Roadmap's own cards. `user.html`
   (employee) does NOT use a page-load marker at all — `_dtIsNew()` is
   simply "not yet in my own `wl_dt_seen_ids`," reusing the EXACT existing
   mechanism `renderDailyTasks()` already maintained for the "N new
   assigned" count badge (an id is added to that list only in
   `openDtDetailPanel()`) — this maps directly onto "shows a highlight
   until the assignee has seen it, clearing when they open it," which a
   page-load marker cannot express (a task assigned to me yesterday that I
   still haven't opened must stay flagged today). `openDtDetailPanel()`
   now also re-renders the list immediately after marking an id seen, so
   opening a task visibly drops its own highlight right away rather than
   waiting for an unrelated re-render. Every staged (not-yet-committed) row
   in both portals' staging lists is unconditionally shown with the New
   treatment — staging is by definition always "from the current import."
   New CSS: `.ta-row-new`/`.ta-staging-new` (index.html, reusing
   `.rm-new-tag` directly for the pill) and `.dt-row-new`/
   `.dt-staging-new`/`.dt-new-tag` (user.html, a full hand-duplicated copy
   since this file shares no CSS with index.html either).

No new `api/*.js` file — still exactly 12 files under `api/`, same Hobby-
plan headroom as before. Verified: `node --check` on both server files;
`node:test`'s `--experimental-test-module-mocks` against the real,
byte-identical `api/ops-sync.js` with an in-memory fake Supabase client
(18/18 — dueDateLocked lifecycle, assignedDate immutability against a raw
API call, member write-restriction rejections, admin-vs-member tombstone
delete scoping); a similarly real-code Node check against
`api/process-transcript.js` (23/23 — phonetic match/no-match/ambiguous-tie
cases, prompt content, `validDueDate`/`matchOwner` regressions unchanged).
Playwright against the real `index.html` UI (21/21: staging batch
grouping + New tags + pre-commit undo with zero network calls, commit
pushes and renders the New highlight, recent-imports strip fires a real
`tombstones.taskIds` request and empties the list, due-date lock UI
disables after one change) and the real `user.html` UI (14/14: same batch/
undo/New-highlight flow, plus confirming opening one task clears only its
own tag and a member's undo is scoped to their own committed batch).
Four pre-existing Task Assignments Playwright suites re-run: three passed
unmodified; `verify_ta_staging.js` needed one selector update
(`#ta-staging-list > div` → `.ta-staging-new`) since the new per-batch
grouping added a wrapper level — a structural change from this task, not a
regression — and passes 26/26 after the fix. Two unrelated pre-existing
failures (`verify_task_assignments_ui.js`'s stale `#taViewCalBtn`
reference from before the Day/Week/Month schedule tab existed;
`verify_overview_revamp.js`/`verify_progress_reports.js`, both from other
in-flight/unmerged work) were confirmed to fail identically against
unmodified `main` and are out of scope for this PR.
**Overview revamp: Team Assessment as a numbers table + Recent Activity
wrap/scroll (2026-08-20).** Two related layout/content changes to
Overview's top row, one PR.

**Layout (`.ov-top-grid`):** inverted the earlier "both cards reflow
fluidly" design (2026-08-20, same day, earlier revision) — Team
Assessment is now a FIXED-width column (`flex:0 0 460px`) that never
resizes or reflows on its own; Recent Activity alone takes whatever width
is left and is the only thing that reflows on resize. No `flex-wrap` at
all now — the two columns never stack into rows at any width, which is a
deliberate, explicit exception to every other Overview/Service-Schedule
responsive pass in this codebase (all of which treated any horizontal
page scroll as a bug to fix): a window narrower than roughly Team
Assessment's fixed width plus Recent Activity's practical minimum will
now scroll the page horizontally rather than collapsing Team Assessment,
per this task's explicit "must not reflow or resize" instruction.

**Team Assessment, replaced (not just restyled):** the old card-list-
with-sparkline is now a plain 6-column table (Person, Tasks assigned,
Tasks done, Services assigned, Services done, Total % done) — the
sparkline and its entire underlying "done events over the last 10 weeks"
trend computation (`taWeekKeys`/`taDoneWeeksByName`) are removed outright,
along with the now-unused due-date bucketing/labeling
(`_taSvcDueStatus`/`_taDueLabel`/`_taDaysBetween`) none of the new columns
need. Tasks come from `ops_tasks` (`dbGet(DB_KEYS.tasks)`) filtered by
`assigneeId`, done = `status==='Done'` — no active/inactive concept
exists on a task. Services come from active clients'
`c.services[]`/`c.locations[].services[]`, excluding cancelled/archived
(`_chIsInactiveService` — "same filter as Client Health" per this task's
own instruction), done = `workStatus==='done'`. Total % = (tasks done +
services done) ÷ (tasks assigned + services assigned); 0-of-either still
renders (0%/"—"), never hidden from the roster.

**Confirmed with Sarah before building, not guessed:** the task's own
wording for the services-done column was "done = done-this-cycle" —
which is the literal name of Client Health's `_chIsDoneThisCycle`
heuristic (`lastDone` is set AND not currently overdue). This dashboard's
own % done was changed AWAY from that exact heuristic on 2026-08-06 after
it produced a real misleading result (Sherine: 43 services assigned, 0
ever marked done, showed 97%, because her due dates were simply far in
the future) — reusing it here for the services-done column would have
silently reintroduced that same failure mode into the new Total % column
too, since it shares the same numerator/denominator idea. Asked directly;
confirmed keeping the already-fixed `workStatus==='done'` definition for
both tasks and services, not the cycle heuristic.

**Recent Activity — wrap, don't truncate, and scroll:** the per-event row
had `white-space:nowrap;overflow:hidden;text-overflow:ellipsis` — a long
description/detail line was cut off mid-sentence with no way to read the
rest and no scrollbar to reach it (the exact truncate-to-a-sliver pattern
already fixed on the Service Schedule calendar and (separately,
independently) on this exact row by two different concurrent sessions
earlier this same day — except neither of those actually touched this
row; re-confirmed by reading the live code before starting, not assumed
from memory). Fixed the same way: `white-space:normal;overflow-wrap:
anywhere`, `align-items:flex-start` so the checkmark sits with the first
line. `#ov-activity-list` itself now has `max-height:460px;overflow-y:
auto` so a long list (capped at 30 events) scrolls inside its own card
instead of growing the page — this reverses the 2026-08-07 "let the card
grow unbounded" decision, but that decision's own reasoning (Team
Assessment's then-unbounded roster stretching Recent Activity's container
via CSS Grid's default stretch) no longer applies: Team Assessment is now
a fixed-width, naturally-short table, and `align-items:flex-start` on
`.ov-top-grid` already prevents any stretch-to-match regardless of either
card's height.

Verified with Playwright against the real `index.html` UI (23/23): table
data correctness for a person with mixed tasks/services (including a
cancelled service correctly excluded, and a service with `lastDone` set
but `workStatus` not `'done'` correctly counted as NOT done — proving the
cycle heuristic isn't back in play) and a person with zero assigned work
(renders 0/"—", not a false 100%); zero sparkline bars or trend text left
over; Team Assessment's width unchanged across a resize while Recent
Activity's width changes; a long Recent Activity description renders in
full with zero ellipsis characters and a visibly taller (wrapped) row;
`#ov-activity-list` has a real bounded `max-height` with `overflow-y:
auto` and content taller than its box (genuinely scrollable, not just
styled to look like it); page height stays reasonable rather than being
blown out by 15 long wrapped rows. Existing Recent Activity
filtering/ordering suite re-run clean (18/18, unaffected — only the
row's own CSS changed, not which events qualify or their order). The
old Team Assessment Playwright suite is now obsolete, not a regression —
it asserted card-list/sparkline/due-label behavior that no longer exists
by design; superseded by the new suite above.

**Overview: Team Assessment/Recent Activity stacked instead of
side-by-side (2026-08-20).** The fixed/flexible two-column split from the
entry above (Team Assessment pinned to 460px, Recent Activity taking the
rest) was replaced with a simple stacked layout: `.ov-top-grid` is now
`display:flex;flex-direction:column` (dropped the per-child `flex:0 0
460px`/`flex:1` rules entirely) — Team Assessment renders first, full
width, with Recent Activity below it, also full width. Nothing inside
either card changed — Team Assessment's 6-column table, Recent Activity's
wrap/scroll behavior (`#ov-activity-list`'s bounded `max-height`/
`overflow-y:auto`), the sparkline removal, all untouched. Verified with a
new Playwright suite (13/13: Team Assessment is the first child and sits
above Recent Activity, both cards match the grid's full width at two
different viewport widths, table content and wrap/scroll both regression-
checked) and by updating the prior suite's now-superseded "Team Assessment
stays fixed-width" assertion to its opposite ("Team Assessment now resizes
like Recent Activity, and the two are stacked, not side-by-side") — that
suite's other 21 checks (data correctness, sparkline removal, wrap/scroll)
re-run clean, confirming this was a pure layout change.

**Task Assignments: per-person Daily Tasks view (admin) + "Blocked" task
status (2026-08-20).** Two parts, one PR, `index.html`-only for part A,
both portals for part B — no new `api/*.js` file, still 12.

**A. Per-person Daily Tasks view.** A third Task Assignments sub-tab,
"👤 By Person" (`ta-subtab-person`), lists every active member/admin from
`_timeOffRoster()` with a tasks-assigned/done/% summary and a red (has an
overdue task)/amber (has a Blocked one, no overdue)/no-dot indicator. The
per-person summary itself is NOT a new computation — `refreshAdminOverview()`'s
inline Team Assessment math (tasksAssigned/tasksDone/servicesAssigned/
servicesDone/pctDone) was pulled out into a shared `_personWorkSummary()` +
`_activeServicesForAssessment()`/`_pctDoneColor()`, and BOTH Team Assessment
and this new roster call the same functions — the explicit "per-person
counts match Team Assessment" requirement is structural, not just tested.

Clicking a person does NOT build a second, parallel rendering path.
`openPersonDailyView(personId)` sets a new `_taPersonViewId`, which
`_taFilteredTasks()` checks ahead of the normal assignee-filter dropdown —
so the EXISTING Assigned Tasks List/Day/Week/Month rendering, inline
reassign-dropdown, "New" flag, and edit-modal machinery all apply for free,
now narrowed to one person. The assignee filter select is hidden (it's
redundant once locked to one person) and replaced with a "Viewing X's
tasks · ← Back to team" banner; the nav highlight is flipped back onto
"By Person" so it doesn't look like you silently landed on a different
tab. `closePersonDailyView()` clears `_taPersonViewId`, restores the
filter, and returns to the roster. This reuse choice was deliberate over
literally reusing `user.html`'s simpler Daily Tasks render markup (which
the original ask suggested) — the admin's own Assigned Tasks view already
has every capability this feature needs (reassign, edit, due-date lock UI)
and is a strict superset of the data an employee sees; rebuilding a second
render pipeline just to match column count exactly would have meant
duplicating (and now maintaining in two places) all of that editing logic
for no functional gain.

**B. "Blocked" status + `blockReason`.** Added to both portals' status
selects (`tem-status` in `index.html`, `dt-status-select` in `user.html`),
ordered Not started → In progress → Blocked → Done. A required
`blockReason` text field appears only when status is set to Blocked
(`_taToggleBlockReasonField()`/`_dtToggleBlockReasonField()`), validated
client-side the same way `saveTaskEdit()` already requires a non-empty
`subject` — no server-side requiredness check, matching that existing
convention (this is a data-quality nicety, not a permission boundary).
Clearing status away from Blocked clears `blockReason` too, in both
portals, so a stale reason never lingers on a task that's moved on.
Server-side, `blockReason` is deliberately NOT added to
`TASK_KEYS_MEMBER_MAY_NOT_TOUCH` (documented inline) — a member marking
their OWN task Blocked needs to write `status` (already allowed) and
`blockReason` together in one request, and treating it like status/notes/
tags is what makes that possible with zero other server change; the
existing "not your task" ownership check still applies regardless, so this
only ever widens what a member can touch on a task already theirs, never
whose tasks they can touch. Visually mirrors (not duplicates under a third
name) Workload's existing "Stuck" service-status red treatment: a
`_taStatusColor()`/`_dtStatusColor()` red for the status text, a small
"🚧 Blocked" badge next to the subject (tooltipped with the reason), and a
light red row tint (`.ta-row-blocked`/`.dt-row-blocked`, hand-duplicated
per the zero-shared-code rule) that combines harmlessly with the existing
amber "New" row tint if a task happens to be both.

Verified: `node --check` on `api/ops-sync.js`; div-balance on both HTML
files (delta unchanged vs. `main`); a `node:test`
`--experimental-test-module-mocks` run against the real, byte-identical
`api/ops-sync.js` (22/22, extending the existing date-rules suite — a
member can set `status:'Blocked'`+`blockReason` on their own task, and a
DIFFERENT member still can't touch that task at all, confirming
`blockReason` widens field-scope only, never the ownership check); a new
Playwright suite against the real `index.html` UI (22/22: roster
summary/dots, per-person counts cross-checked directly against
`_personWorkSummary()`, entering/exiting person view, editing/reassigning
from inside it and confirming the sync push, the Blocked-with-no-reason
save rejection, the Blocked badge/row-tint rendering); a new Playwright
suite against `user.html` (10/10: the Blocked option, the required-reason
rejection, the badge/tint, and blockReason clearing when status moves off
Blocked). Every pre-existing Task Assignments/Overview/Daily Tasks
Playwright suite re-run clean (no regressions).

**Deferred to a follow-up PR, per the task's own instruction ("build after
the above"):** a team-wide "Needs Attention" view (Overdue/Due
today/Blocked/Unassigned across everyone, in one place) plus a daily
digest email to the owner and auto-reminders to employees, reusing the
existing 13:00 UTC `cron-overdue-check` + `insertNotifications`/Resend
pipeline rather than a new endpoint. **Built 2026-08-20 — see the entry
below.**

**Needs Attention view + Unassigned filter + digest/reminders + fix
user-side filter buttons (2026-08-20).** The follow-up from the entry
above, plus two more items bundled into the same PR. `index.html` +
`user.html` + `api/cron-overdue-check.js` — no new `api/*.js` file, still
12.

**A. "Needs Attention" view.** A fourth Task Assignments sub-tab,
"⚠️ Needs Attention" (`ta-subtab-attention`), groups every task team-wide
into four sections — Overdue, Due Today, Blocked, Unassigned — via a new
`_taNeedsAttentionBuckets()`. Each bucket reuses the EXACT SAME predicates
already established elsewhere in this file (`_taIsOverdue()`/
`_taIsDueToday()`, `status==='Blocked'`, `!assigneeId`) rather than
inventing new ones, so this view can never disagree with what the List
view's own quick filters or the Blocked badge would show for the same
task. Each row's click-through reuses `openTaDetailPanel()` — the exact
same detail/edit path every other task view in this file already uses, so
editing/reassigning/status changes from here go through the normal
`ops_tasks` sync and the same write-rules (assignedDate immutable,
dueDate-locks-after-one-change) automatically. **Scope decision, flagged
rather than assumed:** this view is task-scope only (`ops_tasks`) — it
does NOT pull in Client Health/Workload's separate service-level overdue/
"Stuck" signals, even though the original spec's own wording ("consolidates
what's scattered across Client Health/Workload/Task Assignments") could be
read more broadly. The four bucket names (Blocked/Unassigned specifically)
are task-only concepts in this codebase, and the digest counts in Part C
below map 1:1 onto these same four task buckets — mixing in a fifth,
service-shaped data source would have been a materially larger, riskier
feature than what the acceptance criteria actually describes. Client
Health and Workload remain untouched, their own dashboards.

**B. "Unassigned" as a quick filter, not a tab.** Added to the existing
Overdue/Due Today quick-filter row (`taFilterUnassignedBtn`,
`toggleTaQuickFilter('unassigned')`) — `_taQuickFilter` gained a third
value, same single-select toggle mechanism, same `.btn-toggle-active`
sizing convention as the other two. `_taFilteredTasks()` gained one more
line (`!t.assigneeId`). "Assignable inline" needed no new code at all —
the List view's existing per-row assignee `<select>` (`_taReassign()`)
already works on any row the filter surfaces, including an unassigned one
(whose select just defaults to "Unassigned").

**C. Daily digest + employee self-reminders — reuses `cron-overdue-check`,
no new function, no new cron entry.** A new block in the SAME handler,
entirely separate from the pre-existing service-overdue escalation block
above it (different table, different notification `type`s, different
recipients) and deliberately NOT gated behind the existing `overdueEnabled`
toggle, which only ever governed that service-side escalation — this new
block always runs, same as the daily backup snapshot already does in this
file. Computes the same four buckets `_taNeedsAttentionBuckets()` computes
client-side (hand-duplicated server-side as `taskIsOverdue()`/
`taskIsDueToday()`, mirroring `_taIsOverdue()`/`_taIsDueToday()`) fresh
from `ops_tasks` on every invocation — no per-item idempotency stamp,
unlike the service-overdue block's `overdueNotifiedFor`, because a daily
digest/reminder is SUPPOSED to repeat every day the underlying task is
still overdue/due-today; stamping to suppress repeats would be exactly
backwards for this feature. Two notification types: `attentionDigest` (one
row per super/owner admin — "the owner" — with a single summary line:
counts for all four buckets plus a comma-list of affected people's names)
and `taskReminder` (one row per person who has at least one of THEIR OWN
overdue/due-today tasks, counting only those two buckets — never Blocked/
Unassigned, which aren't "your own work" concepts — worded in second
person, e.g. "You have 2 overdue and 1 due today. Take a look when you get
a chance!", deliberately not framed as a report visible to anyone else).
Both ride the exact same `insertNotifications()` (in-app + Resend email
when configured) every other notification type in this codebase already
uses.

**D. Fixed employee-side filter/view buttons (`user.html`) to match
admin's #246 convention.** Two spots had the exact bug #246 already fixed
on the admin side: the category pills (`dtCategoryPills`, in
`loadDailyTasks()`) used `btn-primary` for their active state — `width:
100%`, so the active pill visibly ballooned to fill its row instead of
just changing color — and the List/Calendar view toggle (`setDtView()`)
used a bare `btn` (no `btn-outline`) for active, which has no border and
so subtly changed the button's own box size between states. Both fixed
the same way admin's copy already was: base class always `btn btn-sm
btn-outline`, only a new `.btn-toggle-active` modifier (added to
`user.html`'s stylesheet, hand-duplicated from `index.html`'s copy —
zero-shared-code rule) toggled on top. `dtTabMineBtn`/`dtTabImportBtn`
(the My-assigned/Add-import SUB-TAB buttons) were deliberately left
untouched — admin's own equivalent sub-tab buttons (Add/Import, Assigned
Tasks, By Person, Needs Attention) still use the older bare-`btn`-active
pattern too, so leaving these alone actually matches admin's current look
more faithfully than "fixing" them would have.

Verified: `node --check` on `api/cron-overdue-check.js`; syntax-checked
both HTML files' inline `<script>` blocks; div-balance on both (delta
unchanged vs. `main`); a `node:test` `--experimental-test-module-mocks`
run against the real, byte-identical `api/cron-overdue-check.js` with an
in-memory fake Supabase client (13/13 — all four bucket counts, the digest
notification's recipient/body/affected-names, the reminder notification's
recipient/body/framing); a new Playwright suite against the real
`index.html` UI (16/16 — all four Needs Attention sections with correct
counts/subjects, a Done task never appearing in any bucket, row
click-through opening the real detail panel, the Unassigned filter
narrowing the list, inline reassignment clearing a task out of the
Unassigned filter view, toggling the filter off restoring the full list);
a new Playwright suite against `user.html` (10/10 — the view toggle and
category pills both using `btn-toggle-active` correctly, no `btn-primary`
anywhere in the pills, real bounding-box checks confirming no resize on
toggle, and that filtering by category still actually filters). Every
pre-existing Task Assignments/Overview/Daily Tasks Playwright suite
re-run clean (no regressions).

**Task parser: structured `[Name]` owner markers (2026-08-21).**
`buildTaskEmailSystemPrompt()`'s `ownerName` bullet gained explicit
guidance for the team's own meeting-notes/Quick-Notes export format —
"Next steps: [Name] Task: …" — which the existing prose-only patterns
("X will…", "X's priorities", etc.) didn't cover: a task line prefixed
with a person's name in brackets (`[Abby Conklin] Process payments…`), a
"Name — task" or "Name: task" prefix, or a bulleted/listed task under a
heading that names a person. These structured markers are explicitly
called out as AT LEAST as strong a signal as the prose patterns, and the
prompt now says a task carrying one should almost never end up with an
empty `ownerName` — the marker itself already names the owner, so there's
nothing left to infer. Pure prompt-content change; `matchOwner()`'s own
exact/unambiguous-first-name matching and the review-before-assign staging
flow (`et.assigneeId||null` pre-filling the staged row) were already
correct for this — once the model extracts the right `ownerName`, the
existing pipeline (server-side `matchOwner()` -> `assigneeId` in the
response -> staging's pre-filled assignee dropdown, freely editable by the
admin) already satisfies "arrives already chosen, admin reviews/edits, no
hunting through the transcript" with no further code change needed.
`process-transcript.js` only, per the task's own scope — nothing else
touched.

Verified with `node --check` and a Node script against the real,
byte-identical `buildTaskEmailSystemPrompt()`/`matchOwner()` (13/13 — the
new prompt content for all three marker forms and the "should almost
never be empty" language, existing prose/phonetic guidance still present,
and `matchOwner()` correctly resolving each of the acceptance example's 5
names — Abby, Sherine, Michael, Rana, David — against a matching roster).
The pre-existing phonetic/prompt-content regression suite re-run clean
(23/23) — no live-model call is possible in this environment (no API
access), so the model's own extraction accuracy on a real transcript
still needs a click-through verification on the Vercel preview before
merge.

**Task parser: staging debug hint for an unmatched `ownerName` +
dropped instructional subtext (2026-08-21).** Two small changes off the
same request, `process-transcript.js` + `index.html` only (per the task's
own final scope — an earlier draft of the same request had also asked for
`user.html`, but the request was revised down to admin-only before this
was built, so `user.html`'s staging view is untouched).

1. `handleTaskEmailMode()`'s per-task response object gained `ownerRaw` —
   the model's raw `ownerName` string, carried through unconditionally
   (even when `matchOwner()` couldn't resolve it to anyone on the roster).
   Purely a debug/visibility field: nothing server-side ever reads it back,
   it exists only so the staging UI can show what the model actually said
   when the auto-fill from the previous entry (structured `[Name]` markers,
   see above) comes up empty.
2. `runTaskEmailParse()` carries `ownerRaw` onto the staged row;
   `_renderTaStaging()` shows a small "detected: {ownerRaw}." hint next to
   the assignee dropdown, but ONLY when `assigneeId` is still null AND
   `ownerRaw` is non-empty — a task the model already matched shows no
   hint at all, since there's nothing to debug there. `commitStagedTasks()`
   strips `ownerRaw` out (alongside the pre-existing `mergeIntoId`/
   `mergeIntoSubject` strip) before anything reaches `ops_tasks` — it was
   never meant to be a stored field.
3. The staging card's instructional subtext ("Auto-detected assignee/
   client are pre-filled — edit anything...") was removed outright, per
   the task's own explicit "admin doesn't need it" — the card title
   ("🔎 Review before assigning") and the existing per-batch "N task(s)
   from this import" line (added for the undo-import feature) are both
   untouched.

Verified with `node --check` on `process-transcript.js`; syntax-check +
div-balance on `index.html` (delta unchanged vs. `main`); a `node:test`
`--experimental-test-module-mocks` run against the real
`handleTaskEmailMode()` with the Anthropic SDK itself mocked to a
deterministic fake response (7/7 — a matched task still carries `ownerRaw`
alongside its resolved `assigneeId`, an unmatched task gets `assigneeId:
null` + the raw string, and a task with no `ownerName` at all gets
`ownerRaw: ''` rather than `undefined`); a new Playwright suite against
the real `index.html` UI (6/6 — the old subtext is gone while the title
and per-batch count line remain, the hint renders only for the unmatched
task and never for the matched one, and `ownerRaw` never leaks into a
committed `ops_tasks` row). Every pre-existing Task Assignments Playwright
suite and the phonetic/prompt-content regression suite re-run clean (no
regressions).

**Repurposed the Summaries tab into Team Production Analytics (2026-08-21).**
The old "📝 Progress Summaries" feature (manually-triggered Weekly/Monthly/
Yearly write-ups, generated from `wl_clients_db`'s legacy project/task/
progressLog model via `_collectTrackerData()`, saved local-only to
`wl_weekly_summaries`/`wl_monthly_summaries`/`wl_yearly_summaries` —
confirmed these three keys were never pushed through `cloudPullAll()`'s
`_applyServerArray()` calls, i.e. genuinely local-only, never synced) is
removed outright: the 3 generate buttons, their 3 modals, and every
function that supported them (`_collectTrackerData()`,
`_renderTrackerPreview()`, `open*SummaryModal()`, `preview*Summary()`,
`generate*Summary()`, `refreshSummaryLists()`, `render*Summaries()`,
`deleteSummary()`, `switchSummaryTab()`).

In its place: a read-only **Team Production Analytics** view, reading
`ops_tasks` (`dbGet(DB_KEYS.tasks)`) + active client services
(`_activeServicesForAssessment()`) — no new endpoint, reusing the exact
same `_personWorkSummary()`/`_pctDoneColor()` helpers Overview's Team
Assessment and Task Assignments' "By Person" roster already share, so
these numbers can never disagree with either. Three parts: (1) team-wide
stat cards (Tasks/Services Assigned & Done, Overdue, Blocked, Team % Done);
(2) a per-person table extending Team Assessment's own 6 columns with two
more — Overdue and Blocked, both task-only concepts (`_taIsOverdue()`,
`status==='Blocked'`) since services have neither; (3) a "Services
Completed — Last 8 Weeks" bar chart, Monday-anchored real calendar weeks,
bucketed by each service's `lastDone`. The weekly trend is deliberately
**services-only** — `ops_tasks` has no completion-date field (only
`assignedDate`/`dueDate`), so a task-completion trend can't be built from
real data without guessing; per rule #7, the card's own subtitle says so
rather than fabricating a task number.

The internal tab id (`'summaries'`/`#admin-summaries`) is unchanged on
purpose — every role-visibility rule in `applyAdminRoleRestrictions()`
keys off that id, not the label, so leaving it alone kept the existing
Creative/Production/Account Manager visibility rules working with zero
risk. Only the user-visible label changed (nav: "Team analytics"; page
header, help-panel entry, `ADMIN_TAB_TITLES`, and the Account Manager
role's own description text: "Team Production Analytics"). The
`restrict-insights-actions` CSS rule and its accompanying comments were
trimmed — the old `#summaryGenerateBtns`/`.summary-del-btn` selectors are
gone along with the elements they targeted, since the new view has no
write actions left to restrict at all (read-only for everyone, same as
Workload/Client Health); Live Feed's Clear button restriction is
untouched.

Verified: syntax-checked extracted `<script>` blocks; div-balance (delta
unchanged vs. `main`); `ls api/*.js | wc -l` still 12; grepped clean for
every removed identifier (`weeklySummaries`, `generateWeeklySummary`,
`refreshSummaryLists`, `summaryGenerateBtns`, etc. — zero remaining
references); a new Playwright suite against the real `index.html` UI
(20/20 — nav label and page header repurposed, all three old modals gone,
team stat cards match hand-computed totals across 2 people/3 tasks/2
services including one overdue and one blocked, the per-person table
shows both new columns correctly, the weekly trend renders and is honestly
labeled services-only, and the Refresh button re-renders without clearing
anything). Re-ran the existing Overview regression suite (24/24) and the
Task Assignments "By Person"/Blocked suite (22/22) — both share
`_personWorkSummary()`/`_activeServicesForAssessment()`/`_pctDoneColor()`
with the new view and passed unchanged, confirming those weren't touched.
**Removed the standalone Progress Reports tab; per-client progress now
lives on each client card (2026-08-21).** `client.html` had its own
"📊 Progress Reports" nav item/page (`nav-reports`/`page-reports`,
`renderReports()`) — a per-client breakdown of three separate metrics
(this month's done÷due, this year's completion, current overdue health)
plus a 12-month table and recent progress-log entries. Removed outright:
the nav item, the page section, `renderReports()`, its two small helpers
(`_rptIsOverdue()`/`_rptPctColor()`), and the `PAGE_META`/`showPage()`
entries that referenced it. In its place, each client card in the Client &
Production Tracker's grid now shows a "Services done" line — `X/Y (Z%)`,
or "—" when a client has zero active services — computed via the
already-existing `_svcCycleStats(c)` (the exact same active-services-done-
this-cycle math the client-detail header and Overview's stat cards already
share, so this can never disagree with either). This is deliberately a
SEPARATE line from the card's pre-existing "Overall progress" bar, which
is bundle/project completion % — a different metric that stayed untouched.

Removing the page surfaced one real cross-file dependency, found by
reading the code rather than assumed: `user.html`'s own sidebar had a
"Progress Reports" nav item (`openTrackerPage('reports',this)`) that deep-
linked into the now-gone `client.html?page=reports` — left as-is, this
would have silently blanked the entire embedded Tracker (every
`.page-section` gets deactivated by `showPage()` before it tries and fails
to activate the missing one). Removed that nav item too, plus its now-
dangling `HELP_CONTENT.reports` entry and its key in
`EMPLOYEE_HELP_SECTION_KEYS` — all three were wired to the same dead
target. `index.html`'s own, unrelated "📊 Reports" nav/section
(`showSection('reports')`, a static-demo daily/weekly/monthly personal
work-report screen with no connection to client/service data) was
confirmed to be a completely different, pre-existing feature and left
untouched.

Verified: syntax-checked extracted `<script>` blocks in both `client.html`
and `user.html`; div-balance on both (delta unchanged vs. `main` in each);
a new Playwright suite against the real `client.html` UI (10/10 — the nav
item and page section are both gone, a client with a 2-of-3-done mix of
active/cancelled services shows "2/3 (67%)" with the cancelled service
correctly excluded from the denominator, a zero-active-service client
shows "—" with no `NaN`, and the pre-existing "Overall progress" line is
untouched) and a new Playwright suite against the real `user.html` UI
(5/5 — the nav item is gone, the help-panel keys/content no longer
reference it, and the remaining Tracker nav item still opens the iframe
successfully).
**Live Feed refresh actually pulls fresh cloud data + Workload accordion
(2026-08-21).** Two small independent fixes, one PR, `index.html` only.

**Live Feed.** `refreshLiveFeed()` was purely local — it only ever read
`dbGet(DB_KEYS.feed)` and re-rendered, so an admin with the tab already
open (or reopening it) saw whatever `ops_feed` happened to be cached
locally, never a fresh pull, unless the unrelated 30s live-sync poll
(`cloudPullAll()`, which already calls the plain `refreshLiveFeed()` at
its own end) happened to have run recently. Fixed by adding a new
`refreshLiveFeedFromCloud()` wrapper that awaits `cloudPullAll(true)`
rather than duplicating the read+render itself — `cloudPullAll()` already
calls `refreshLiveFeed()` internally once the pull lands, so having the
new wrapper call it too would just be a redundant second render, and
having `refreshLiveFeed()` itself call `cloudPullAll()` would recurse
infinitely against `cloudPullAll`'s own existing call back into it. The
new wrapper is used at exactly the two user-facing entry points this task
asked for — the Live Feed tab-switch handler and a new "🔄 Refresh" button
placed next to the existing "🗑 Clear Feed" button — while every other
existing call site of the plain `refreshLiveFeed()` (right after a local
`dbPush(DB_KEYS.feed, event)`, `clearFeed()`'s own post-clear render, the
pre-existing 15s local-only auto-refresh interval) is left untouched,
since none of those are meant to trigger a network round-trip. The button
disables itself with a "⏳ Refreshing…" label for the duration of the pull
and restores afterward, including on a failed pull (falls back to a plain
local `refreshLiveFeed()` so the button never gets stuck mid-request).

**Workload accordion.** `_workloadExpanded` is a single `Set` shared
between two separate dashboards — the main Workload view and "My Team's
Work" (whose row ids carry an `'mtw_'` prefix specifically so the two
can't collide in the same Set) — confirmed by reading `toggleWorkloadDetail()`
before changing it. The ask was for the Workload view specifically, so the
accordion behavior only clears other non-`mtw_`-prefixed ids from the Set
before adding the newly-opened one; "My Team's Work" keeps its existing
independent multi-expand behavior, since changing that wasn't asked for
and the two dashboards' state already can't collide by id prefix. Opening
one Workload person's "▸ Details" now auto-collapses any other Workload
person already expanded; closing the only open one leaves all collapsed.

Verified: syntax-check on the extracted `<script>` blocks, div-balance
(delta unchanged vs. `main`, confirming the only additions were two
`<button>` elements plus JS with no HTML div impact), and a new Playwright
suite against the real `index.html` UI (14/14 — the Refresh button's
presence, that opening the Live Feed tab and clicking Refresh both issue a
fresh `/api/ops-state` call and render newly-appeared team activity, that
the button re-enables/relabels itself afterward, and the full Workload
accordion sequence: two people's details expand and collapse correctly,
opening a second person's details collapses the first, and closing the
only open one leaves both collapsed). The pre-existing Recent Activity
Playwright suite (an unrelated Overview-page feed, not this Live Feed tab)
re-run clean — no regressions.

**Hotfix: `client.html` was fatally broken on `main` after two parallel
Claude sessions independently did the same three tasks (2026-08-21).**
Two separate Claude sessions were dispatched the identical "Live Feed
refresh/Workload accordion, remove Progress Reports/add per-client card
progress, repurpose Summaries into Team Production Analytics" batch at
essentially the same time. Both produced their own PRs for all three
(#262/#265/#267 from one session, #263/#264/#266 from the other) — #263
(the calendar cell-height fix, isolated, no overlap) merged cleanly, but
the other five all touched the same `client.html`/`index.html` regions and
were merged with an incompletely-resolved conflict, confirmed live on
`main` by actually parsing the files rather than assuming: `client.html`
had `const cycle` declared TWICE in the same scope inside
`renderClientGrid()`'s per-card loop — a real `SyntaxError`
("Identifier 'cycle' has already been declared") that failed the ENTIRE
inline `<script>` block, meaning the whole Client & Production Tracker
(embedded in both `index.html` and `user.html`) was non-functional, not
just the per-client-progress feature. `index.html` had two
`<div id="admin-summaries">` blocks nested inside each other, two
`id="tpa-team-stats"` elements, and two `function
renderTeamProductionAnalytics(){` definitions, with one session's "legacy
generator" section divider ending up wrapping the OTHER session's analytics
markup — non-fatal (duplicate `function` declarations don't throw, unlike
`const`) but genuinely broken (duplicate ids, unreachable/dead markup,
whichever function definition happened to load last silently winning).

Fixed by reconciling to ONE coherent implementation per spot, not by
picking one PR wholesale — each session's version was actually read and
compared before deciding:
- **Client card ("Services done" line):** kept the version with an
  `activeOverdue` count and overdue badge (`Services: X/Y done (Z%)` +
  `N overdue`) over the plainer version with no overdue signal — genuinely
  more complete, and `_svcCycleStats()`'s `activeOverdue` field itself
  had already merged in cleanly with no duplication, so nothing else
  needed to change to use it.
- **Team Production Analytics:** kept this session's own version (correct,
  established "never hide a zero-assigned person" convention — see the
  2026-08-06 Sherine-97%-incident entry above — vs. the other session's
  `.filter(r=>r.totalAssigned>0)`, which silently re-introduced exactly the
  bug that convention exists to prevent) as the base, but ADOPTED the other
  session's genuinely better idea: Overdue/Blocked now combine BOTH tasks
  (`_taIsOverdue()`, `status==='Blocked'`) AND services
  (`_chSvcDueStatus()==='overdue'`, `_svcStatus()==='stuck'`, services'
  closest analog to "blocked") instead of counting task-side only — this
  session's original version undercounted by ignoring service-side
  overdue/stuck entirely. Column/stat-card label changed to "Blocked/Stuck"
  to stay honest about now meaning two different underlying concepts, same
  reasoning the other session used for its own version of this label.

Verified: actually parsed all three files with `new Function()` per
extracted `<script>` block (confirms the fatal `client.html` error is
gone, and `index.html`/`user.html` remain clean); div-balance on all three
against their established baselines (`client.html` 0, `index.html` -2,
`user.html` -1 — all matched, no new imbalance); grepped for zero
remaining duplicate ids (`id="..."` occurring more than once) and zero
duplicate top-level `function` declarations in both files (one
pre-existing, unrelated duplicate — `addPlatformRow()` in `index.html` —
confirmed via `git show` to already exist before ANY of today's PRs, so
left alone as out of scope for this hotfix); re-ran every one of today's
own Playwright regression suites (Live Feed/Workload 14/14, Overview
24/24, Task Assignments By-Person/Blocked 22/22, per-client-card-progress
10/10 — 2 assertions updated to match the intentionally-kept richer design,
not a regression) plus a new suite specifically exercising the consolidated
service-side overdue/stuck logic (7/7 — confirms a person with zero tasks
but an overdue+stuck service still shows nonzero Overdue/Blocked, the
"Blocked/Stuck" label appears everywhere it should, exactly one
`#admin-summaries` element exists, and the discarded session's
`_tpaPersonOverdueBlocked()` helper is gone).

**Task delete button + inline status dropdown (2026-08-21).** Two related
additions to Task Assignments (`index.html`) and Daily Tasks (`user.html`),
one PR, both files, no new `api/*.js` file — still 12.

**1. Hard delete.** A "🗑 Delete" button in the Edit Task modal
(`index.html`)/detail panel (`user.html`), plus an inline ✕ button on every
task-list row in both portals. Reuses the exact same `tombstones.taskIds`
hard-SQL-DELETE mechanism the import-undo feature (2026-08-20) already
established in `api/ops-sync.js` — `ops_tasks` has no `deleted_at` column,
so this was already a genuine delete, not a soft state; no schema change
needed. The ONE server-side change: broadened the member permission check
from `assignedById===session.id` only (the import-undo feature's own
narrower "a batch you yourself committed" scope) to
`assignedById===session.id OR assigneeId===session.id`, so a member can
now also delete a task simply because it's assigned to them — the same
"your task" definition already used for every other member-write on this
table (the `cur.assigneeId !== session.id` "not your task" rejection right
above it in the same file). This was a deliberate, reasoned generalization
of the existing mechanism rather than a literal re-read of "reuse the same
permission scope" — the import-undo feature's assignedById-only rule made
sense for *that* feature (undoing your own import batch) but would have
been inconsistent and confusing as the definition of "your task" for a
general-purpose Delete button, which a member reaches from a task actually
assigned to them. Admin/super still delete any task unconditionally,
exactly as before. Client-side, deleting removes the task from the local
list, appends its id to the existing `DB_KEYS.deletedTaskIds` tombstone
queue (already wired into both portals' sync-push functions since the
import-undo feature — no new push-side code needed), and re-renders. The
modal/panel Delete button is hidden for a brand-new, unsaved task (nothing
exists server-side yet to delete).

**2. Inline status dropdown.** The task list's Status column is now a
`<select>` (Not started/In progress/Blocked/Done) in both portals, writing
through the normal sync path immediately on change — no separate save
step, matching the existing inline-reassign dropdown's own convention.
Setting Blocked prompts (via `prompt()`, standing in for the edit modal's
own required text field since there's no second input available inline)
for a reason exactly like the modal/panel already requires; cancelling or
leaving it empty reverts the dropdown to its previous value and pushes
nothing, rather than silently saving a reason-less Blocked status.
Existing server-side write-rules (member-touchable fields, due-date lock,
etc.) are unaffected — this only ever writes `status`/`blockReason`,
already-allowed fields.

Verified: `node --check` on `api/ops-sync.js`; syntax-checked both HTML
files' inline `<script>` blocks; div-balance on both (delta unchanged vs.
`main`); `ls api/*.js | wc -l` still 12; a `node:test`
`--experimental-test-module-mocks` run against the real, byte-identical
`api/ops-sync.js` (6/6 — a member can now delete a task assigned to them
even if someone else created it, the original "created it themselves" case
still works unchanged, an unrelated task is still rejected with a clear
reason, admin/super still deletes anything); a new Playwright suite against
the real `index.html` UI (17/17 — inline status dropdown writes through
immediately, Blocked prompts and requires a non-empty reason, cancelling
reverts the dropdown with no sync call, inline row delete and modal delete
both remove the task and send a real tombstone request, the modal's Delete
button is hidden for a new task) and the real `user.html` UI (15/15 — same
coverage for the inline dropdown, detail-panel delete, and inline row
delete). Every pre-existing Task Assignments/Daily Tasks Playwright suite
re-run clean (By Person/Blocked 22/22, Needs Attention/Unassigned 16/16,
Daily Tasks Blocked 10/10, schedule tab 15/15, calendar/buttons 11/11,
staging 26/26, staging merge 9/9, 19-task completeness 12/12) — no
regressions from adding a column to the shared list-table markup.

**Task delete permission scope narrowed back to self-created only
(2026-08-21).** The Task delete feature's server-side scope (PR #269,
same day) had briefly broadened a member's `tombstones.taskIds` delete
permission from `assignedById===session.id` (self-created) to also allow
`assigneeId===session.id` (assigned to them), reasoning that "your task"
should mean the same thing for delete as it does for every other
member-write on `ops_tasks`. Per explicit instruction, reverted: a member
may delete only a task they themselves created (`assignedById`) —
`assigneeId` is no longer sufficient. Admin/super unaffected, still delete
any task unconditionally.

**Flagged, not fixed (out of scope for this narrowly-worded change):**
neither `index.html`'s nor `user.html`'s Delete UI (inline row ✕, edit
modal/detail-panel button) currently distinguishes "a task I created" from
"a task merely assigned to me" — both render unconditionally for any task
a member can see. A member clicking Delete on a task assigned to them but
created by someone else will now have the optimistic local removal
silently rejected server-side (surfaced only as a sync `rejected` entry,
not a UI error), reappearing on the next full pull — a confusing "phantom
delete" from that member's perspective. Not touched here since the actual
instruction was a one-line server permission revert, not a UI change;
worth a follow-up decision (hide the button when `assignedById !==
currentUser.id`, or surface the rejection as a toast) if this scope is
meant to stay this narrow going forward.

Verified: `node --check` on `api/ops-sync.js`; re-ran the existing
`node:test` permission-scope suite with its assertions updated to the
narrower behavior (6/6 — a member can no longer delete a task merely
assigned to them; the original self-created case, the unrelated-task
rejection, and admin's unconditional access are all unchanged) plus the
pre-existing date-rules suite for regressions (unaffected).
**Sidebar reorder task — no change needed, already correct (2026-08-21).**
Asked to reorder the admin sidebar's nav groups to Operations → People &
HR → Insights → Resources. Read the actual markup before touching
anything (same "verify against primary sources" discipline as the earlier
#263 investigation this session) and found the four
`admin-nav-group-label` divs are already in exactly that order, with no
JS anywhere that reorders them at runtime. Confirmed via a diff against
`origin/main` — zero changes. Flagged back rather than opening a no-op PR.

**Live Feed narrowed to user/employee activity only, manual buttons
removed (2026-08-21).** Two changes, one PR, `index.html` only.

**Type allowlist.** `LIVE_FEED_USER_ACTIVITY_TYPES = ['login','nav',
'admin','timeoff']` — a new shared filter (`_feedUserActivityOnly()`)
applied once, at the point both `refreshLiveFeed()` and `filterFeed()`
read `dbGet(DB_KEYS.feed)`, so the list, the type-filter's own option set,
and the three stat cards (Total Events/Sessions Today/Active Users) all
compute from the identical already-scoped array and can never disagree.
`client` (service done/overdue/client updates — the thing this task
explicitly says never belongs here), `goal`, `report` (now just the
broadcast-announcement feature, since the old summary-generator's own
`report` events were removed along with that feature on 2026-08-21
earlier the same day), and `message` are all excluded now, not just
`client` — the task's own wording ("Show only ... login, nav, admin")
read as an allowlist, not "exclude client and leave everything else." The
type-filter `<select>`'s options were trimmed to match (Goals/Tasks &
Services/Reports removed) — leaving them would have offered choices that
can only ever show "No activity recorded," which is worse than not
offering them. `timeoff` included per the task's own suggested default
("if you want HR actions") — it's unambiguously employee activity, not
client-service work, so no reason to leave it out.

**No manual buttons.** Removed the "🔄 Refresh" button (added earlier
today by the Live Feed refresh PR) and "🗑 Clear Feed" outright, along
with `clearFeed()`. `refreshLiveFeedFromCloud()` — the exact `cloudPullAll
(true)` wrapper #262 built — is kept and still fires automatically every
time the Live Feed tab is opened (`switchAdminTab`'s own hook, unchanged);
that tab-open trigger IS the "auto-refresh every session" this task asks
for, so no new plumbing was needed, only removing the now-redundant manual
button and its disable/relabel logic. Removing Clear Feed made the whole
`restrict-insights-actions` body-class mechanism fully dead — it existed
for exactly one purpose (hiding that button for Creative/Production/
Account Manager) and Team Production Analytics had already taken its only
other consumer away in an earlier change today — so the CSS rule, the
`isRestrictedManagerLevel` toggle, and their comments were removed too,
rather than left as an inert no-op mechanism.

Verified: syntax-checked the extracted `<script>` block; div-balance
(delta unchanged vs. `main`); `ls api/*.js | wc -l` still 12; grepped clean
for `feedRefreshBtn`/`clearFeedBtn`/`clearFeed(`/`restrict-insights-
actions` — zero remaining references; a new Playwright suite against the
real `index.html` UI (23/23 — opening the tab auto-pulls, neither manual
button exists anywhere, all four allowed types render, all five excluded
types are absent, the type-filter dropdown offers only the four allowed
options, the three stat cards compute from the same filtered set, and
filtering by type still works against the reduced set). Re-ran the Live
Feed/Workload accordion suite from earlier today — its Refresh-button
assertions were rewritten to match the new no-button/auto-refresh-on-open
behavior (not a regression, that suite's own premise was superseded by
this task) and its unrelated Workload-accordion coverage re-run unchanged,
13/13. Recent Activity (Overview's separate feed) and the Overview revamp
suite both re-run clean (18/18, 24/24) — confirming neither reads
`ops_feed` in a way this change could have touched.

**Client save was wiping `clientEmails` and other non-form fields — fixed
with a server-side merge, `client.html` needed no changes (2026-08-24).**
Reported live: `clientEmails` loaded onto ~25 clients (the salvage-import
field the task parser's client-matching reads — see the 2026-08-19 Task
Assignments entry above) was blanked after those clients were next saved
from the UI. Investigated `client.html` first, since that's where the
report pointed — found NO bug there. `saveClient()`'s edit path already
does `Object.assign(clients[idx], data)` (a correct merge, not a
reconstruction) where `data` only holds form-collected fields, so any
field absent from `data` — like `clientEmails`, which has no UI input
anywhere in this file by design (loaded via a one-time admin salvage
import, never member-facing) — survives locally exactly as it already
was. `saveService()` and `saveNotes()` are the same pattern, and
`serviceAreas` already had an explicit "never let an absent field
blank-overwrite a real value" guard predating this task. Confirmed via
`git diff --stat origin/main -- client.html` that this file is genuinely
untouched by the fix.

Root cause was entirely server-side, in `api/ops-sync.js`: `upsertRows()`
(the admin client-write path) and the member write's own
`.update({data:...})` call both do a raw Postgres JSONB column REPLACE of
the whole `data` value — never a merge. So the FIRST time any browser
whose local cache predates `clientEmails` (or `sitePlatform`/
`hostingProvider`/service `platforms`, etc.) being set out-of-band pushed
a dirty client row — even for an unrelated edit — that unknown field was
silently deleted. Fixed by extending the exact pattern already established
for this class of bug (`preserveMissingPasswordField`/
`preserveMissingPayrollFields`, both used in this same file): a new
`preserveMissingClientFields(incoming, current)` that does
`{...current, ...incoming}` — a key PRESENT in `incoming` (even falsy,
e.g. a deliberate `website:''` clear) always wins; a key entirely ABSENT
from `incoming` falls back to `current`. Unlike the payroll helper this
uses key presence, not `hasContent()`-style truthiness, since a client
edit form legitimately clears fields to empty strings and that must not
be un-done. A companion `_mergeClientItemsById()` applies the same
presence-merge to `services[]` (top-level and nested inside
`locations[]`) matched by `id` — fills in a missing field on a service
present on both sides, but never resurrects a service present only in
`current` (a real delete/removal must still work). Wired in on both write
paths: admin's `incoming.map(inc => preserveMissingClientFields(inc,
byId.get(inc.id)?.data))` before `upsertRows()`, and the member path's
single-row `.update()`. Every existing notification-diff loop and
`checkMemberClientWrite()`'s scope check still run against the RAW
`incoming` payload, unaffected by the merge — the merge only changes what
reaches storage, never what's evaluated for permissions/notifications.

Found and fixed one collateral bug while building this:
`checkMemberClientWrite()` compared `current[key]` against `incoming[key]`
for every key in `CLIENT_SCALAR_KEYS_MEMBER_MAY_NOT_TOUCH` (which already
included `clientEmails`, added during the task-parser work) even when
`incoming` didn't have the key at all — `undefined !== <real value>`
rejected the member's ENTIRE write with "members cannot edit
client.clientEmails" any time their stale cache simply lacked the field,
even though they never touched it. Fixed by skipping the comparison when
`!(key in incoming)` — safe because the write-time merge above always
falls back to `current`'s value for an absent key regardless, so omission
can never sneak an actual change through; a key present with a genuinely
different value is still rejected exactly as before.

Deliberately not built: a `clientEmails`/`sitePlatform`/`hostingProvider`
input in the Edit Client form. The server-side merge already protects
every browser's cache state regardless of what the form does or doesn't
expose, and `clientEmails` was intentionally designed admin-salvage-only,
never member-facing — adding a form field wasn't needed for the fix and
would have cut against that existing design intent.

Verified two ways, no live DB access (rule #11): (1) a `node:test`
`--experimental-test-module-mocks` run against the real, byte-identical
`api/ops-sync.js` with an in-memory fake Supabase client (17/17) — an
admin resave from a stale cache (missing `clientEmails` entirely)
preserves it while still applying a real edit; a deliberate `website:''`
clear is honored, not restored; service-level `platforms`/`sitePlatform`/
`hostingProvider` survive an edit to an unrelated service field, matched
by id, with no duplication; a service genuinely removed from `incoming`
is NOT resurrected; the same field-preservation applies recursively to a
franchise location's nested `services[]`; a member's stale-cache save
omitting `clientEmails` is no longer wrongly rejected and the field still
survives; a member EXPLICITLY changing `clientEmails` is still rejected
(security check intact); a member editing a service not assigned to them
is still rejected (unrelated regression check). (2) A Playwright run
against the real `client.html` UI (6/6) — mocked `/api/ops-auth`/
`/api/ops-state`/`/api/ops-sync`, seeded one client with `clientEmails`
and one service with `platforms`/`sitePlatform`/`hostingProvider`, opened
the real Edit Client modal, changed only the Website field, saved, and
confirmed the captured sync push carried the real edit AND all four
untouched fields unchanged. Pre-existing regression suites re-run clean:
`verify_ops_sync_date_rules.mjs`, `verify_task_delete_permission_scope.mjs`,
and the `checkMemberClientWrite` suite from the submit-for-review feature.
`node --check` passed on `api/ops-sync.js`; `client.html` (unchanged) was
still syntax-checked per this task's explicit instruction, since it's the
exact file broken by the 2026-08-21 parallel-session hotfix. Function
count unaffected — still 12 files under `api/`.

**View Consolidation + Admin/User Parity batch — PR 4: org chart stopped
from re-adding departed people (2026-08-24).** First of five PRs in this
batch (suggested order PR4→PR2→PR1→PR3→PR5, one at a time, each merged
before the next starts — `index.html`/`user.html`/`client.html` cascade-
conflict badly when run in parallel, see the 2026-08-21 parallel-session
hotfix entry above). `index.html` only.

**Root cause, found by reading the code, not guessed:** `ORG_NODES_DEFAULT`
(the canonical org-chart layout `orgLoad()` falls back to) still literally
contained Emily Rovillo, Mostafa Jamal, and Yehia Elafify — plus Sherine's
name had drifted to "Sherine Magdy" in that same array. `orgLoad()` resets
`orgNodes` straight from `ORG_NODES_DEFAULT` in three cases: no
`wl_org_nodes` in localStorage yet, a `wl_org_layout_ver` mismatch, or a
JSON-parse exception — none of which know or care whether a node has since
been tombstoned. Traced the exact mechanism that makes a regenerated
departed-person node STICK rather than just flicker away on the next pull:
`_opsDirty()` treats any row with no matching entry in its last-known-synced
snapshot as dirty and pushes it in full; since the server (`api/ops-
state.js`) filters `ops_org_nodes` on `deleted_at is null`, a tombstoned
person's row is never in a fresh pull's `serverArr` — so `_applyServerArray`'s
own "don't drop a dirty record just because the server doesn't have it yet"
safeguard (correct and necessary for a genuinely new, not-yet-pushed node)
re-adds the regenerated Emily/Mostafa/Yehia node right back into the merged
local array on every subsequent pull, indefinitely, until deleted again —
which just re-triggers the same regeneration path on the next fresh
browser/cache-clear/layout-version bump. This is a real, load-bearing
safeguard for legitimate new nodes, so it was NOT touched; the actual fix is
upstream of it — stop `ORG_NODES_DEFAULT` from ever containing a departed
person in the first place. Confirmed via grep that this file's other
Emily/Yehia/Mostafa references (`_seedCoreTeam`/`seedStaticUsers`,
`_cleanupPlaceholderSeedUsers`, `_unhideRestoredYehia`,
`_tagSeededPlaceholderUsers`'s `ops_users`-side placeholder logic, and the
admin-duplicate-id fix around line 11815) are either already-disabled
load-time functions (per this file's own disabled-functions list above) or
govern a different table (`ops_users`/`ops_admins`, not `ops_org_nodes`) —
none of them write org-chart nodes, so none needed touching. `_syncUsersToOrgChart()`
(the original 2026-07-13 auto-reconciliation this file already disabled)
remains fully unreferenced, confirmed via grep — it is not what's causing
this.

**Fix:** removed Emily/Mostafa/Yehia from `ORG_NODES_DEFAULT` and their
3 links from `ORG_LINKS_DEFAULT`; corrected Sherine's default name to
"Sherine Amin". The 5 intentional placeholder roles (Carol Rucker/Aileen
Casey/Neha/Brian Bynes/Jamil Ahmed) and 4 of the 10 real team members
(Rana Ayman, Kyle Harriman, Michael Eruzione, Sarah Ibrahim) were already
absent from this array before this fix — per the task's own framing, they
"live only in the DB" (added via the manual "+ Add" panel), which is
exactly why they never regenerated; only rows actually present in
`ORG_NODES_DEFAULT` could regenerate, and now that's down to the 6
people who should be there (David, Abby, Sarah Samy, Jacob, Sherine,
Assmaa). Also bumped `ORG_LAYOUT_VERSION` (`v5_20260501` → `v6_20260824`)
— this is the file's own documented, pre-existing mechanism for exactly
this situation ("every device will reset to the new defaults exactly once
on next load"), needed because a browser that already has Emily/Mostafa/
Yehia baked into its `wl_org_nodes` localStorage under the OLD version
would otherwise keep using that poisoned local copy forever (the "layout
version matches" branch never re-diffs against `ORG_NODES_DEFAULT`).
The one-time reset this bump triggers momentarily drops any locally-cached
extra node not in the (now smaller) defaults array from that browser's
`orgNodes`, but self-heals on the very next successful pull — a
legitimately-existing server-side node (Rana, the placeholders, etc.) is
never "dirty" against its last snapshot, so `_applyServerArray`'s merge
takes the server's copy for it regardless of what the momentarily-reset
local array has, restoring it with no data loss and no tombstone/delete
ever generated for it.

Flagged, not touched here (out of scope, no live DB access — rule #11):
the live `ops_org_nodes` row for Sherine may still literally say
"Sherine Magdy" in production today if it was never renamed through the
UI — this fix stops the WRONG name from ever being regenerated again, but
correcting an already-wrong live row is a one-time UI action (open her
bubble, rename, save) for Sarah to do, not something this change can do
without live data access. Likewise, if Emily/Mostafa/Yehia are currently
sitting resurrected in production `ops_org_nodes` at the time this merges,
they need one more manual delete through the org chart UI after this
ships — after that, per this fix, they stay gone.

Verified: `node --check`-equivalent syntax check (`new Function()` per
extracted `<script>` block) on `index.html` — all 5 blocks parse clean. A
new Playwright suite (13/13) against the real `index.html` UI (`initOrgChart()`
runs automatically ~300ms after `DOMContentLoaded` since `#org-canvas` is
unconditionally in the DOM, no login/tab-nav needed to exercise `orgLoad()`):
a completely fresh browser (empty localStorage) loads the corrected 6-node
default with no Emily/Mostafa/Yehia and Sherine correctly named; a browser
pre-poisoned with the OLD version + all 3 departed people baked into
`wl_org_nodes` gets reset by the version bump, purging them and fixing
Sherine's name, with `wl_org_layout_ver` confirmed bumped in localStorage
afterward; a browser already on the CURRENT version with legitimate extra
people (a placeholder and a real team member not in `ORG_NODES_DEFAULT`)
is left completely untouched — confirming the fix only fires the reset
where it's supposed to, never wiping real DB-sourced org-chart data.

**View Consolidation + Admin/User Parity batch — PR 2: retired the legacy
"Project Tasks" grouping from employee My Work (2026-08-24).** Second of
five PRs in this batch (suggested order PR4→PR2→PR1→PR3→PR5, one at a
time — see PR 4's entry above for why: these files cascade-conflict badly
under parallel sessions, per the 2026-08-21 hotfix). `user.html` only.

`loadMyAssignments()`'s `(c.projects||[]).forEach(p=>{...})` block used to
build its own separate card grouping — "Project Tasks," labeled "A
separate, older grouping — ad-hoc bundle/project tasks assigned to you, not
recurring services" — with its own inline mark-done checkboxes
(`userMarkTaskDone()`) and a progress slider + note field
(`userUpdateProgress()`). This is a genuinely different, older data model
(`c.projects[].tasks[]`/`.subprojects[]`) from the newer ops_tasks-based
Task Assignments/Daily Tasks system, and — per this task's own framing —
had no admin-side equivalent view at all; this exact grouping is what
surfaced the Leese Flooring project to the owner as looking orphaned/
inconsistent.

Removed the grouping and its two now-dead write functions entirely (zero
remaining call sites, confirmed via grep) rather than just hiding them —
per rule #6's "remove the tool, not just its call site" convention. A
genuine assignment is NOT orphaned by this: bundle/project rows now feed
into the SAME unified table (`_myWorkServicesTable()`/`myServiceItems`)
recurring services already use, one row per project a person is on or has
open tasks/sub-items on, with a compact summary (open-task count or
sub-item count, plus `% complete`) in the notes column and `category` set
to the project's own `type` (or "Bundle"). Clicking the row deep-links
straight into the Tracker at that exact project via `openTrackerTo()`'s
existing `?openProject=` support (client.html's own `_openDeepLinkFromUrl()`
already expands and highlights the right project block on load) — the same
target the old grouping's "Open ↗" link used. `openMyWorkItemInTracker()`
gained an optional second `projId` argument for this; the services-table
row template passes it only when present, so real-service rows (no
`projId`) are unaffected.

This is also what makes admin and employee task views consistent, per this
PR's acceptance criteria: `client.html`'s Bundles/Projects tab
(`renderProjects()`) already lets anyone on a project
(`canEdit=SESSION.isAdmin||onProject`) check off tasks and log progress
themselves, with real permission parity between an admin and an assigned
member (member-scope enforced server-side via `checkMemberClientWrite`,
same as every other client write) — so retiring My Work's own duplicate
editing UI doesn't remove any capability, it just means both roles now
reach bundle/project work through the one shared Tracker view instead of
each having their own copy of it. Verified this parity holds, not assumed:
`renderTaskRow()`'s mark-done checkbox and `openProjectModal()`'s "Log"
progress button are both available to a project member, unconditionally.

Stats (`projCount`/`dueWeekCount`/`dueMonthCount`/`clientIds`) are computed
identically to before — the removal only changed how a bundle/project
assignment is *rendered*, not whether it's counted. The unrelated,
still-existing "Other work on this client" opt-in box (surfaces a client's
OTHER services to someone already assigned to at least one) used to share
a variable (and, via the removed wrapper, an incidental "Project Tasks"
label) with the retired grouping — untangled into its own
`otherClientWorkHtml` variable, unlabeled, so it's no longer visually
associated with a grouping that no longer exists. "Your Assigned Steps"
(sub-items on services not otherwise assigned to this person) is a
separate, already-independent feature and was not touched.

**Not in scope for this PR, flagged instead:** `client.html` has its own,
separate "My Work" page (`renderMyWork()`, its own `nav-my-work` tab inside
the Tracker itself — kept, per its own comment, because at least one
restricted admin role has no other way to reach a personal work view) with
the identical "Project Tasks"-labeled grouping and the identical
`userMarkTaskDone`-style pattern, independently authored per the zero-
shared-code rule. This task's own scope explicitly named "(employee
user.html)," and client.html's copy serves a different, admin-role
audience with different risk considerations — left untouched here rather
than silently folded in. Worth its own follow-up decision if the same
"admin/employee consistency" goal should extend to it.

Verified: `node --check`-equivalent syntax check (`new Function()` per
extracted `<script>` block) on `user.html` — clean. Div-balance delta
unchanged vs. `main` (both −1). Grepped clean for zero remaining
`userMarkTaskDone`/`userUpdateProgress`/`taskCardsHtml` references anywhere
in the file. A new Playwright suite against the real `user.html` UI
(13/13): the old "Project Tasks" label and its subtext are both gone; a
person whose ONLY assignment anywhere is a bundle/project task (no
recurring services at all) is confirmed NOT to hit the "No work assigned
yet" empty state — the exact "would this orphan a real assignment"
question this task asked to check; the row shows the open-task count and
`% complete`; the old inline slider/mark-done controls are gone from the
rendered HTML; `as-proj-count` still reflects the bundle assignment;
clicking the row opens the Tracker iframe with both `openClient=` and
`openProject=` set to the exact ids; and a client with genuinely zero
assignments still correctly shows the empty state (unaffected).

**View Consolidation + Admin/User Parity batch — PR 1: Team Production
Analytics replaces Team Assessment as the Overview landing (2026-08-24).**
Third of five PRs in this batch (order PR4→PR2→**PR1**→PR3→PR5).
`index.html` only.

Moved Team Production Analytics' entire content (stat cards, "Services
Completed — Last 8 Weeks" chart, Per-Person Breakdown table — same ids,
`tpa-team-stats`/`tpa-weekly-trend`/`tpa-person-table`/`tpa-person-empty`,
same `renderTeamProductionAnalytics()` function, byte-identical logic) from
its own standalone "Team analytics" tab/page (`#admin-summaries`) onto the
Overview page (`#admin-overview`), replacing the old "Team Assessment"
6-column table outright — its computation block in `refreshAdminOverview()`
is deleted, replaced with a single call to `renderTeamProductionAnalytics()`
(already fully self-contained: reads its own DOM targets, no-ops if
they're absent), so nothing is duplicated. Recent Activity stays exactly
where it was, unchanged, directly below the per-person table inside
`.ov-top-grid`. The "Team analytics" nav item and the standalone
`#admin-summaries` page-section are both deleted outright (not just
hidden) — `HELP_CONTENT.summaries`/its `ADMIN_TOUR_STEPS` entry/its
`ADMIN_HELP_SECTION_KEYS` entry/its `ADMIN_TAB_TITLES` entry all removed
alongside it, and `HELP_CONTENT.overview`'s tip/learnMore copy updated to
describe what's actually on the page now. Since Overview is already the
default active tab/page-section, "opening the app lands on Team Production
Analytics" needed no new default-page logic — it's already true once
Analytics lives there. Live Feed, Workload, and Needs Attention are
untouched, confirmed via grep (zero lines touched in any of their code).

**Found and fixed as a side effect, not the task's own ask:** the
`switchAdminTab` wrapper installed to fire `renderTeamProductionAnalytics()`
on the (now-removed) 'summaries' tab click also called a `refreshSummaryLists()`
— a function that no longer exists anywhere in the file (its last real
definition was removed when the old manually-generated Progress Summaries
feature was repurposed into Team Production Analytics on 2026-08-21, but
these two call sites survived that cleanup). Since JS throws a
`ReferenceError` on a call to an undefined function, clicking "Team
analytics" in production today would have thrown immediately after
rendering — a real, previously-undiscovered break. Retiring the tab
removes these dead call sites along with it, closing the bug as a
byproduct rather than something that needed its own separate fix.

**Role-visibility adjustment required, and made — flagged for visibility
since it touches a permission-sensitive area:** `applyAdminRoleRestrictions()`'s
`CREATIVE_MANAGER_ROLE` branch had a `showOnly` whitelist of
`['tracker','messages','summaries','livefeed', ...]` — she was explicitly
granted 'summaries' (Team Production Analytics) but NOT 'overview' (the
old company-wide Team Assessment table wasn't meant for her). Retiring
'summaries' without any other change would have silently revoked her only
path to Analytics entirely, the exact "access disappears because the tab
it lived on disappeared" failure this PR must avoid. Fixed by replacing
'summaries' with 'overview' in her whitelist — she now sees the Overview
tab, which (after this PR) contains exactly the content she already had
access to (Analytics + a Recent Activity strip that shows nothing more
sensitive than what her existing Tracker access already exposes) — not
new capability, the same access relocated. The other two restricted roles
(`account_manager`/`production_manager`) already had BOTH 'overview' and
'summaries' unhidden before this PR (confirmed by reading `hideTabs`,
which lists neither), so they needed no equivalent adjustment. Creative
Manager's pre-existing auto-navigate-to-Tracker-on-login behavior is
untouched — she still lands on Tracker first, same as before; Overview/
Analytics is now just a tab she can click to, that she couldn't before.

Verified: syntax-checked all 5 extracted `<script>` blocks (`new Function()`
per block) — clean. Div-balance delta unchanged vs. `main` (−2, both). A
new Playwright suite against the real `index.html` UI (16/16): the "Team
analytics" nav item and `#admin-summaries` page-section are both gone;
Overview (default-active) shows the Per-Person Breakdown table, the weekly
trend chart, and the stat cards; the old "Team Assessment" title is gone;
Recent Activity still renders with the real feed event; Live Feed/Workload
nav items still exist; clicking Live Feed then back to Overview throws no
JS errors (confirms the dead `refreshSummaryLists()` bug is actually
closed, not just theoretically); a `creative_manager`-level session now
sees the Overview nav item and can reach the same Analytics content
through it, while Users stays hidden (unaffected). Three pre-existing
suites re-run: `verify_overview_revamp.js`'s layout (Part 1) and Recent
Activity (Part 3) sections re-run clean (11/11 once its own obsolete
`#ov-team-assessment` data-correctness section — Part 2 — was skipped,
noted in the test file as superseded by this PR's own suite, not a
regression); `verify_overview_stacked_layout.js` re-run with its two
`#ov-team-assessment`-targeting assertions (both about the literal old
title/row-count) understood as the same kind of expected supersession,
its other 11/13 checks (positioning, width, Recent Activity wrap/scroll)
passing clean; `verify_tpa_service_side_overdue_stuck.js` updated (its
navigation click to the removed 'summaries' tab is no longer needed since
Analytics is already on the already-active Overview tab; its
`#admin-summaries`-count assertion flipped from expecting exactly 1 to
expecting exactly 0, matching the tab's retirement) and re-run clean,
7/7. `verify_help_panel.js`'s one pre-existing failure (a stale
`user.html` expectation predating the 2026-08-21 Progress Reports removal)
and `verify_help_btn_visibility.js`'s port-8935 dependency (an old one-off
before/after comparison script, not a standing suite) were both confirmed
unrelated by reproducing the identical result against unmodified `main` —
out of scope for this PR.

**View Consolidation + Admin/User Parity batch — PR 3: admin visibility
into employee Goals (2026-08-24).** Fourth of five PRs in this batch
(order PR4→PR2→PR1→**PR3**→PR5). `index.html` only.

Employees have a full Goals page (`user.html`, `ops_goals` —
`{id, user (name string), title, type, target, due, status, createdAt}`)
but admins had zero visibility into it before this. New "Goals" nav item
under People & HR (`switchAdminTab(this,'goals')`) + `#admin-goals`
page-section + `renderAdminGoals()`, listing every active team member
(`_timeOffRoster()` — the same roster Workload/Team Production Analytics
already use, so "every team member" here can never disagree with those
dashboards) with their goals, or "No goals set yet" if none — a person
with zero goals still appears, never silently hidden, matching this
codebase's established roster convention. `adminMarkGoalAchieved()`/
`adminDeleteGoal()` reuse the identical action set (and identical write
pattern: `dbSet` + `cloudAutoSync()`) the employee's own `markGoalAchieved()`/
`deleteGoal()` already have on their own goals — extended here to any
person's, since "edit the goal model" doesn't offer anything beyond
status/delete on either side. No new field invented (no "approval" status
— the model has none, and inventing one wasn't asked for). **No new API
function**, confirmed literal: `ops_goals` was already a fully unrestricted
read/write table server-side (`api/ops-sync.js`'s `ADMIN_TABLES` set does
NOT include `'goals'`), so an admin writing any person's goal was already
permitted by the existing sync endpoint — this PR is UI-only.

**Found, not touched — an entirely separate, pre-existing dead mockup,
flagged for visibility:** `index.html` already has its OWN, unrelated
"🎯 Goals" nav item and `#sec-goals` page-section, reached through a
different top-level nav (`showSection('goals',this)`, not
`switchAdminTab`) — but it's 100% static fake content (hardcoded
"3 / 5 completed", a "Create Goal" button that only closes its modal and
shows a toast) with no read/write to `DB_KEYS.goals` or any real data
at all. This is a leftover from before the current admin-nav/
`switchAdminTab` shell existed and is unrelated to the real feature built
here — left alone, not fixed, since this task was scoped to adding real
visibility, not auditing every pre-existing dead screen in the file.

**Flagged, not fixed (pre-existing, not introduced here):** neither this
admin view's delete action nor the employee's own long-standing
`deleteGoal()` in `user.html` issues an actual server-side delete —
both just remove the row from the local array and let the normal dirty-
push sync whatever remains, so a deleted goal's row can persist
indefinitely in `ops_goals` even though it disappears from every UI.
Adding a real tombstone mechanism would be a new capability this task's
"no new API function" scope didn't ask for — flagged for a future
decision rather than silently building it in.

**Scope decision, flagged rather than assumed:** Creative Manager's
narrow `showOnly` whitelist (see PR 1's entry above) was NOT given
`'goals'` — her role is deliberately kept to the smallest set this batch
already established (Overview, Tracker, Messages, Live feed, plus My
Team's Work when she manages someone), and this task didn't ask to widen
that. `production_manager`/`account_manager` see the new tab
unconditionally (it's not in either role's `hideTabs`), matching how they
already see every other team-wide dashboard added since their roles were
scoped.

Verified: syntax-checked all extracted `<script>` blocks (`new Function()`
per block) — clean. Div-balance delta unchanged vs. `main` (−2, both).
`git diff --stat origin/main -- user.html` confirms zero changes — the
employee Goals UI is byte-for-byte untouched. A new Playwright suite
against the real `index.html` UI (13/13): the Goals nav item exists and
opens `#admin-goals`; the page title updates to "Goals"; a person with
goals (Alice) and a person with none (Bob) both appear, Bob showing "No
goals set yet"; marking Alice's active goal achieved pushes a real
`ops-sync` call with the updated status and both her goals show Achieved
after re-render; deleting a goal pushes a sync call whose payload no
longer includes that goal's id.

**View Consolidation + Admin/User Parity batch — PR 5: sub-tab button
styling parity, the last of five PRs (2026-08-24).** Order was
PR4→PR2→PR1→PR3→**PR5**. `index.html` + `user.html`, display-only.

The Add/Import vs. Assigned-Tasks/By-Person/Needs-Attention sub-tab
buttons (`setTaSubtab()`, Task Assignments) and the Add/Import vs.
My-assigned sub-tab buttons (`setDtTab()`, Daily Tasks) both still
toggled active state by adding/removing the bare `btn-outline` class
itself — the exact bug already fixed everywhere else in these two files
(List/Calendar/Day/Week/Month view toggles, category pills, quick
filters) via `.btn-toggle-active`: toggling `btn-outline` on/off changes
the button's border width between states, and `setTaSubtab()`'s very
first button additionally had NO `btn-outline` in its active-state class
at all (bare `btn btn-sm`), which — combined with `.btn-primary`'s
`width:100%` not even being in play here — still meant a visibly
different box size/weight than its inactive siblings. Fixed both
functions to always keep `btn btn-sm btn-outline` as the base class,
toggling only `.btn-toggle-active` on top, matching every other toggle in
both files. Also found and fixed the same bug at a second call site:
`openPersonDailyView()` (index.html) manually re-flips the "Assigned
Tasks"/"By Person" highlight after drilling into one person (so "By
Person" stays visually selected even though the Assigned Tasks content
is what's actually showing, pre-filtered) — this used the identical
bare-class toggle and needed the identical fix.

Purely cosmetic — no tab-switching logic, content, or data changed;
verified by confirming the actual sub-tab content still swaps correctly
(not just the button's own class) at every click site touched.

Verified: syntax-checked both files' extracted `<script>` blocks — clean.
Div-balance unchanged in both (`index.html` −2, `user.html` −1, matching
`main`). A new Playwright suite (20/20) against both real UIs: each
button's class always includes `btn-outline` regardless of active state;
real `boundingBox()` width comparisons confirm zero resize when toggling
between active/inactive (not just a class-name check); `openPersonDailyView()`
correctly keeps "By Person" highlighted rather than "Assigned Tasks"; and
the actual tab content (`#ta-subtab-assigned`, `#dtTabImport`) becomes
visible on click, confirming the real switch still works, not just its
button styling. Every pre-existing Task Assignments/Daily Tasks
Playwright suite touching these buttons re-run clean (schedule tab
15/15, calendar/buttons 11/11, staging 26/26, 19-task completeness 12/12,
Daily Tasks Blocked 10/10, Daily Tasks staging 17/17, category-pill fix
10/10). One pre-existing, unrelated failure
(`verify_ta_person_view_blocked.js`'s stale `#ov-team-assessment`
selector, retired by PR 1 above) was confirmed to fail identically
against unmodified `main` — out of scope for this PR.

**This completes the View Consolidation + Admin/User Parity batch** (PR
4 → PR 2 → PR 1 → PR 3 → PR 5, all five merged).

**Employee My Work renamed/restructured into My Services + My Tasks
(2026-08-24).** `user.html` only. The nav group still reads "My Work" as
the umbrella label (still accurate — it groups both child sections), but
the two child items are now "My Services" (was "My Work") and "My Tasks"
(was "Daily tasks"), with matching page headers, `HELP_CONTENT.mywork`'s
label, the `showSection()` titles map, and every other user-visible string
that said "My Work"/"Daily tasks" (notification-dropdown footer link,
per-user preferences panel copy, the toast on new-notification, etc.) —
grepped for both strings afterward to confirm nothing user-facing was
missed. The `as-proj-count` stat tile's label changed from "Tasks" to
"Services" — with a real "My Tasks" section now existing, the old label
was a direct terminology collision with a different feature; this is
exactly the ambiguity the task's own "plain labels: Services = client
services; Tasks = daily/weekly tasks" instruction targets.

Folded the "Your Assigned Steps (from other services)" box — explicitly
self-labeled "a separate, older grouping" — directly into the same
unified services table (`myServiceItems`) recurring/bundle rows already
use, rather than just relabeling the box in place. A step-only row (a
sub-item assigned to this person on a service they don't otherwise own)
gets `category:'Your Step'` and `notes:'Your step: "<text>"'` so it reads
clearly as a partial-ownership row, and carries the service's real
`subitems[]` array — meaning its sub-items badge (`_myWorkBadges()`,
already shared by every service row) opens the exact same
`openServiceSubitemsModal()` an owned service already uses to check off
steps. No new interaction was built: the existing badge/modal already let
anyone toggle any sub-item, so extending it to a step-only row is reusing
established capability, not inventing one. Never affects
`projCount`/stats (unchanged from before this restructure) — a step-only
assignment still doesn't make someone own the whole service.

**Flagged, not touched:** `client.html` has its own separate "My Work" tab
(admin-facing, used by at least one restricted role with no other personal
view) with an IDENTICAL "Project Tasks"/"Your Assigned Steps (from other
services)" pairing, independently authored per the zero-shared-code rule —
already flagged out of scope in the 2026-08-24 "retire legacy Project Tasks
grouping" entry above, and still out of scope here since this task named
"user.html only."

Verified: `node --check`-equivalent syntax check (`new Function()` per
extracted `<script>` block) on `user.html` — clean. Div-balance delta
unchanged vs. `main` (both −1). Grepped clean for zero remaining
user-visible "My Work"/"Daily tasks"/"older grouping"/"Your Assigned
Steps" text (the nav-group umbrella label and historical code comments
are the only survivors, both deliberately left as accurate/harmless). A
new Playwright suite against the real `user.html` UI (12/12): nav items
read "My Services"/"My Tasks"; the My Services page header, stat-tile
label, and preferences-panel copy all updated; no "older grouping" or
"Your Assigned Steps" text remains anywhere on the page; an owned service
and a step-only assignment both render as rows in the same table, the
step-only row shows the real step text and a "Your Step" tag; and the
step-only row's real, visible sub-items badge opens the actual subitems
modal showing the real step (not a stubbed check). Pre-existing suites
re-run: `verify_mywork_redesign.js` had one assertion updated (the literal
old "My work" header text, superseded by design) and passes 39/39 after;
`verify_mywork_compact.js` (20/20), `verify_user_html_reports_nav_removed.js`
(5/5), `verify_submit_for_review.js` (11/11), and
`verify_user_html_per_request.js` (3/3) all re-run clean, unaffected.
`verify_help_panel.js`'s one pre-existing failure and
`verify_badges_and_labels.js`'s one pre-existing failure (both predating
this task, from the earlier "retire legacy Project Tasks grouping" PR —
confirmed via `git stash` comparison against unmodified `main`, identical
result either way) are unrelated to this change.

**Help tips + guided tour extended to cover every recently-added feature,
both portals (2026-08-24).** `index.html` + `user.html`. New
`HELP_CONTENT` entries — `taskAssignments` and `goals` (index.html);
`dailyTasks` (user.html) — added to each portal's `HELP_CONTENT`,
tour-steps array, and permanent "?" help-panel section-keys list, plus
existing entries updated where they'd gone stale: `livefeed` (index.html)
still described "saves, assignments, and updates" — the exact
client/service activity the 2026-08-21 "user activity only" change
explicitly excluded — corrected to describe the real current scope
(logins, navigation, admin actions, time-off); `mywork` (user.html, "My
Services") still said "Your daily to-do... services and individual
steps," conflating it with the newly-separate My Tasks section — split
into a services-only tip that explicitly points to My Tasks for
daily/weekly to-dos. `overview` (index.html) already covered Team
Production Analytics from the 2026-08-24 Overview-redesign PR, so it
needed no further change here.

This is new copy, not sourced from an approved content doc — flagged
explicitly, since every existing `HELP_CONTENT` entry in both files
carries a "verbatim from help-content-DRAFT.md v2 (owner-approved copy;
never paraphrased here)" header comment, and the established convention
in this codebase (see the `ptoLedger` note in both files) is to leave a
screen's help entry out entirely rather than invent copy for it when no
approved text exists. This task's own instruction ("Every new feature
gets a clear tip... No new API functions") is a direct, explicit request
to write this copy, which is why it was written rather than left out —
but since it's genuinely new wording, not doc-sourced, it's called out
here for Sarah to review/adjust rather than presented as if it were
already-approved text.

**Real, previously-undiscovered bug found and fixed as part of this
sweep, not the task's own ask:** `user.html`'s `EMPLOYEE_TOUR_STEPS_BASE`
still referenced `HELP_CONTENT.reports` — a key that was deleted from
`HELP_CONTENT` when the standalone Progress Reports tab was removed
(2026-08-21), but this one reference into the tour's own step array
survived that cleanup (the entry above only mentions removing it from
`EMPLOYEE_HELP_SECTION_KEYS`, not from the tour array). Since
`_renderTourStep()` does `const step = _tourSteps[_tourIndex]; ...
document.querySelector(step.sel)` with no null-check, this `undefined`
array slot meant **every employee's first-login guided tour has thrown a
TypeError and stopped dead on step 3 (right after My Services/Tracker)
since 2026-08-21** — nobody would have seen the rest of the tour (Service
Catalog onward) in that window. Fixed by removing the dead reference and
replacing its slot with `HELP_CONTENT.dailyTasks` (My Tasks), which had no
tour coverage at all before this PR anyway.

Verified: syntax-checked all extracted `<script>` blocks in both files
(`new Function()` per block) — clean. Div-balance unchanged in both
(`index.html` −2, `user.html` −1, matching `main`). Grepped clean for zero
remaining `HELP_CONTENT.reports` references (only the explanatory comment
survives). A new Playwright suite (16/16) against both real UIs: the
guided tour runs to completion with zero JS errors in BOTH portals — the
employee-side check is the actual regression test for the dead-reference
crash above, not just a sanity check; the "?" help panel shows every new
entry (checked via the real DOM content, not `innerText()`, since the
accordion CSS-collapses every section except whichever page is currently
active — a real click-through on Task Assignments confirms its tip
becomes visible, not just present in markup); the corrected Live
Feed/My Services copy no longer contains the stale wording and does
contain the corrected wording. The pre-existing `verify_help_panel.js`
suite re-runs at the same 25/27 (its one failure is the same
pre-2026-08-21-Progress-Reports-removal stale expectation already
confirmed unrelated in an earlier entry above) — confirming no new
regression from either the added entries or the tour-array fix.

**Fix Recent Activity + clickable Overview + retire Goals (2026-08-25).**
Three-part task, `api/ops-state.js` + `index.html` + `user.html`.

**Part 1 — Recent Activity was empty despite 429 real client events.** Root
cause: `api/ops-state.js`'s single `ops_feed` query fetches only the 300
most-recent-by-`created_at` rows across EVERY event type, with no type
filter at the SQL level — the same feed data Live Feed consumes (which
needs login/nav/admin/timeoff, the opposite of what Recent Activity needs).
Since `logActivity('nav', ...)` fires on every single page/section
navigation in both portals, real usage volume can entirely consume that
top-300 window with non-client noise, leaving zero `type:'client'` rows in
it even though hundreds exist further back in the table's real history —
exactly the reported symptom. Fixed with a genuinely dedicated,
SQL-scoped query (`recentClientFeedQ`, `.eq('data->>type','client')`, capped
at 50, newest-first — the first use of PostgREST's `column->>key` JSONB
filter idiom anywhere in this codebase, since every other filter here runs
in plain JS after fetching), wired into the existing `namedQueries`
graceful-degradation array and a new `record.recentClientFeed` field —
never needs `stripSensitiveFeed()`, since `SENSITIVE_FEED_TYPES` only ever
covers `'admin'`/`'timeoff'`, never `'client'`. Client-side: new
`DB_KEYS.recentClientFeed`, a matching `_applyServerArray()` pull-
application line, and `refreshAdminOverview()`'s `actEvents` now reads
`DB_KEYS.recentClientFeed` instead of the general feed (no client-side type
filter needed any more — the server query already scopes it; the existing
`user!=='System'`-and-done-first sort/filter is unchanged). Also added
`refreshAdminOverviewFromCloud()` (byte-for-byte the same
`cloudPullAll(true)`-with-fallback pattern `refreshLiveFeedFromCloud()`
already established) and wired it to the Overview page's manual Refresh
button, so a long-open tab's stale local cache is never what a manual
refresh serves — the literal "pull fresh from the cloud before rendering"
ask.

**Part 2 — Team Production Analytics person rows are now clickable.**
`openPersonDailyView(personId)` only manipulates state WITHIN the
already-active `#admin-taskAssignments` page (sub-tab, banner, filter
visibility) — it never switches which top-level admin tab is active, so
calling it directly from an Overview row click would update internal
state with nothing visible changing, since `#admin-overview` would stay
the active page-section. Added a new `_ovOpenPersonDailyView(personId)`
wrapper that finds the real Task Assignments nav DOM element and calls
`switchAdminTab` on it first (mirroring the existing Creative-Manager
auto-navigate-on-login precedent — find the nav element, call
`switchAdminTab`, rather than duplicating its logic), then calls the
existing `openPersonDailyView()` unchanged. Wired as the `onclick` on each
person `<tr>` in `renderTeamProductionAnalytics()`. Metric cells were not
made separately actionable — the task named the per-person click as the
priority and made cell-level actionability optional; the whole row already
being clickable covers the ask without adding a second, narrower click
target that could shadow it.

**Part 3 — retired the Goals feature (ops_tasks/Daily Tasks supersedes
it), both portals, no data deleted.** Removed, `index.html`: the real admin
Goals tab added in the 2026-08-24 View Consolidation batch's PR3 — nav
item (`switchAdminTab(this,'goals')`), `#admin-goals` page-section,
`renderAdminGoals()`/`adminMarkGoalAchieved()`/`adminDeleteGoal()`,
`ADMIN_TAB_TITLES.goals`, its `switchAdminTab` render hook, its
`HELP_CONTENT.goals` entry, its slot in `ADMIN_TOUR_STEPS`, its key in
`ADMIN_HELP_SECTION_KEYS`. Removed, `user.html`: the real, original
employee Goals page — nav item, `#sec-goals` page-section, the Goal Modal,
`loadGoals()`/`addGoal()`/`markGoalAchieved()`/`deleteGoal()`/
`openGoalModal()`, the now-unused `myGoals` state variable and its
page-load call site, its `showSection()` titles-map entry and `id==='goals'`
render hook, its `HELP_CONTENT.goals` entry, its slot in
`EMPLOYEE_TOUR_STEPS_BASE`, its key in `EMPLOYEE_HELP_SECTION_KEYS`, and
the now-dead `.goal-item`/`.goal-header`/`.goal-title`/`.goal-bar-wrap`/
`.goal-bar`/`.goal-vals` CSS (confirmed via grep these had no other
consumer in this file). Removing `HELP_CONTENT.goals` from both files'
maps required also removing every reference TO it in each file's own
tour-steps array in the same edit — leaving a dangling
`HELP_CONTENT.goals` reference would have reintroduced the exact
undefined-array-slot crash already found and fixed once for
`HELP_CONTENT.reports` (2026-08-24): `_renderTourStep()` has no null-check
and throws partway through the tour on the first undefined step.

**Explicitly NOT removed, flagged per the task's own scope:**
`index.html` has a SEPARATE, pre-existing, unrelated, non-functional dead
mockup also called "Goals" (`showSection('goals')`, `#sec-goals`, hardcoded
fake numbers, a "Create Goal" button that only closes its modal and shows
a toast) — discovered and flagged out-of-scope back when the real admin
Goals feature was first built (PR3, 2026-08-24: "left alone, not fixed,
since this task was scoped to adding real visibility, not auditing every
pre-existing dead screen in the file"). This task's own wording named "the
admin Goals tab (index.html, the one from #277)" specifically, so the dead
mockup is untouched again here — same reasoning, still out of scope.

**Data preserved, not deleted, per the task's explicit instruction.** The
server-side `ops_goals` table, `api/ops-state.js`'s `goalsQ`/`goals` field,
and `api/ops-sync.js`'s unrestricted `applied.goals = upsertRows(...)`
write path are all untouched — none of them render or surface anything on
their own, they're pure data plumbing. Deliberately also left untouched in
both `index.html` and `user.html`: the `DB_KEYS.goals` mapping, the
`_applyServerArray('goals', r.goals, ...)` pull-application line, and the
`goalsDirty`/`_opsDirty('goals', ...)` push-dirty-check line — with every
UI read/write function that used to touch `DB_KEYS.goals` now gone, these
three lines just keep a local mirror of `ops_goals` silently in sync with
zero surfacing, exactly "stop surfacing the feature" without touching the
data path at all. Confirmed via grep this is the ONLY remaining reference
to `goals`/`Goals` in either file beyond the untouched dead mockup.

Verified: `node --check` on `api/ops-state.js`; syntax-checked (`new
Function()` per extracted `<script>` block) both HTML files — clean;
div-balance delta unchanged vs. `main` in both (`index.html` −2, `user.html`
−1); `ls api/*.js | wc -l` still 12. A `node:test`
`--experimental-test-module-mocks` run against the real, byte-identical
`api/ops-state.js` with an in-memory fake Supabase client (9/9) — confirms
the general feed query and the new client-scoped query are genuinely two
separate SQL calls, the client-scoped one actually carries
`.eq('data->>type','client')` plus `order(created_at desc)`/`limit(50)`,
and `record.recentClientFeed` reflects only that scoped query's rows,
correctly mapped through `rows()`. A new Playwright suite against the real
`index.html` UI (11/11) — Recent Activity renders real client-completion
text and excludes nav noise even when the general feed is 100% nav events,
`DB_KEYS.recentClientFeed` is genuinely populated from the pull (not
coincidentally rendered from something else), the Refresh button issues a
real `/api/ops-state` request, and clicking a Team Production Analytics
person row switches the active tab to Task Assignments, opens the exact
clicked person's By Person view (banner name matches), and highlights the
right nav item. A second new Playwright suite (17/17) covering both
portals for Goals retirement — nav items/page-sections/functions all gone,
the separate dead mockup and the data-plumbing lines both confirmed still
present, and the guided tour in both portals still runs to completion with
zero JS errors (the regression check for the dead-HELP_CONTENT-reference
crash class of bug).

Four pre-existing Playwright suites needed their mock data updated to seed
the new `recentClientFeed` field alongside the general `feed` they already
seeded — not a regression, just this change's own new server contract:
`verify_help_tips_new_features.js` (one assertion inverted — it explicitly
checked for the now-retired Goals help copy), `verify_overview_stacked_
layout.js`, `verify_pr1_overview_analytics_landing.js`, and
`verify_recent_activity_service_feed.js` (this last one also needed its
mocked `recentClientFeed` pre-filtered to `type:'client'` rows only, since
that type filtering moved server-side and the client no longer re-filters
by type; and its "empty state" check rewritten against a genuinely fresh
session rather than a same-session populated-to-empty transition — that
transition triggers `_applyServerArray`'s existing empty-guard, by design,
the same protection every other synced array table already has, and one
that's provably unreachable in real production since `ops_feed` is
append-only and this query's rows can only grow). All four re-run clean
after the fix (16/16, 11/13 matching main's own pre-existing baseline
exactly, 16/16, 18/18). `verify_overview_revamp.js`'s pre-existing crash
and `verify_badges_and_labels.js`'s one pre-existing failure were both
confirmed to fail identically against unmodified `main` — unrelated,
out of scope for this PR.

**Task parser: format-agnostic owner detection, multi-name co-assign,
group/attendee assignment, never-blank ownership (2026-08-25).**
`api/process-transcript.js` only. This task was given twice in the same
session, the second time materially more detailed (it resolves the first
draft's own open "Sarah" ambiguity question and adds attendee-list
co-assignment, which the first draft didn't have) — treated the second,
fuller version as authoritative, per this codebase's existing convention
for exactly this situation (see the 2026-08-20 due-date-rules entry).

1. **Format-agnostic `ownerName` detection.** The existing prompt already
   covered prose ("X will…") and the team's own structured markers
   ("[Name] Task:", "Name — task", a bulleted list under a line naming
   someone) — none of that needed touching. Added explicit coverage for a
   dedicated assignee FIELD, which none of those patterns actually cover:
   markdown/table rows with an "Assignee"/"Owner"/"Name" column, and a
   labeled "Assignee: Name" line. Two worked examples added to the prompt
   (a 2-row `| Assignee | Task | Due |` table, and a "Task: … / Assignee:
   David / Due: …" field block) per the task's own explicit ask for
   table examples.
2. **Multi-name rows co-assign.** "Michael, Sarah" (or "David, Sarah, and
   Rana") in one cell/field now assigns ALL of them, not just the first —
   the model is told to output every name together as one comma-separated
   `ownerName` string (kept as a string, not changed to an array, so the
   model's output shape stays uniform with every other multi-value field
   it already produces). Server-side, `splitNames()` splits on comma/
   semicolon/`&`/the standalone word "and" (word-boundary regex, so it
   never fires inside "Andrea"/"Andrew"), each name resolved independently
   against the roster.
   **Design decision, flagged:** `ops_tasks` has no multi-assignee field —
   the entire Task Assignments/Daily Tasks feature (reassign dropdown,
   "your task" ownership checks, notifications, By Person view) is built
   entirely around one `assigneeId` per task, and widening that model is a
   much bigger change than a "process-transcript.js only" PR. "Co-assign"
   here means the parser response returns ONE FULL TASK CLONE PER RESOLVED
   PERSON (each carrying the complete co-assignee id set in a new
   `assigneeIds` array, purely informational — nothing server-side reads
   it back today) rather than one task object with several owners. This
   needed zero client-side changes: the existing staging UI already
   renders one row per array entry, so a 2-name row simply becomes 2
   staged rows, each independently editable/discardable exactly like any
   other staged task. `isSameTask()`'s existing dedupe/merge logic already
   keys off `assigneeId`, so the two clones are correctly never merged
   into each other, and each independently merges against an existing task
   for ITS OWN assignee if one exists.
3. **Primary admin added to the roster; "Sarah"/"Sarah Samy" is a fixed
   alias to Sarah Ibrahim.** Sarah Samy (the primary admin) has no row in
   `ops_users`/`ops_admins` at all (she's a login-time sentinel issued
   directly by `api/ops-auth.js`'s `PRIMARY_ADMIN_EMAIL` branch, per
   CLAUDE.md's own architecture notes) — `activeRoster()` now synthesizes
   her onto the roster with the exact same `{id:'primary-admin', name:
   'Sarah Samy', ...}` shape her real session carries, so a task
   genuinely naming her can actually resolve. Separately, per the task's
   own explicit decision, "Sarah" and "Sarah Samy" ALWAYS resolve to Sarah
   Ibrahim, never to the now-roster-listed primary admin who'd otherwise be
   an exact-name match for "Sarah Samy" — `resolveOwnerAlias()` checks this
   fixed pair of spellings BEFORE the normal `matchOwner()` logic runs, so
   it always wins. **Deliberately NOT the literal `sarah_ibrahim` id the
   task text suggested**: with no live DB access (rule #11) there's no way
   to confirm that's actually her real `ops_users` id, and every other
   person on this roster (including this same alias's target) is already
   resolved by a live NAME lookup, never a hardcoded id — hardcoding an
   unverified id risks silently resolving to nobody (or, far worse, a
   different real person) if it's ever wrong. `resolveOwnerAlias()` looks
   up whoever the LIVE roster's "Sarah Ibrahim" entry actually is, by name,
   at request time — self-correcting if her account is ever recreated
   under a different id, exactly like every other match in this file.
4. **"The group"/team-wide rows co-assign to that meeting's attendees.**
   A new top-level `attendees` field (comma-separated string, same shape
   as `ownerName`) extracted ONCE per parse from a meeting/email's own
   roster line ("Attendees: …", "In attendance: …", "Present: …", a "To:"/
   "Cc:" header, or a name list under the meeting title) — resolved
   against the roster (alias-first) into `attendeeIds`. A new per-task
   `groupOwner` boolean is true only for explicit whole-team language
   ("the group will…", "everyone needs to…", "the team agreed to…"),
   false whenever `ownerName` already names a specific person (a task
   never has both — named individuals always take precedence if the model
   ever produces both, an explicit tie-break rather than leaving that
   undefined). A `groupOwner` task with a resolved attendee list expands
   into one clone per attendee (same co-assign mechanism as #2, sharing
   `assigneeIds`); with NO resolvable attendee list, it becomes a single
   task with `assigneeId:null` and `ownerRaw:'group — no attendee list,
   assign manually'` — the exact phrase the task asked for, and it reuses
   the EXISTING "detected: {ownerRaw} — pick assignee" staging hint
   (built 2026-08-21) verbatim, needing no client-side change at all.
5. **Never silently unassign a named task.** This was already true for the
   single-unmatched-name case (the 2026-08-21 `ownerRaw` hint), and now
   extends for free to every new path: a multi-name row where NONE of the
   names resolve collapses to ONE task (not one blank per name) with
   `ownerRaw` carrying the full raw comma-joined list; a `groupOwner` task
   with no attendee list gets the explicit "no attendee list" flag above
   instead of silently landing with nothing. A genuinely name-less,
   non-group row (`ownerName` empty AND `groupOwner` false) is unchanged —
   still the pre-existing behavior (self-assigned for a member caller,
   left null for an admin), since that's a separate, pre-existing
   scope-filter mechanic this task didn't ask to change.

No new `api/*.js` file — still exactly 12. Verified with a `node:test`
`--experimental-test-module-mocks` run against the real, byte-identical
`api/process-transcript.js`, with `@anthropic-ai/sdk` itself mocked to a
scripted response (since a real transcript-parsing accuracy check needs
an actual model call, not available here) plus `lib/supabaseAdmin.js`/
`lib/opsSession.js`/`lib/errorLog.js` mocked (28/28): the live prompt
text actually carries the new table/field examples, the multi-name
co-assign instruction, the attendees/groupOwner schema fields, and Sarah
Samy in the roster sent to the model; a single-name table-style row
resolves to one task with the right assignee; a multi-name row expands
into one task per resolved person, each carrying the full co-assignee set
in `assigneeIds` and the raw joined names in `ownerRaw`; "Sarah" and
"Sarah Samy" both resolve to Sarah Ibrahim, never the primary admin; a
`groupOwner` task with a resolved attendee list co-assigns to exactly
those attendees; a `groupOwner` task with no attendee list is never
dropped and carries the exact "no attendee list" flag text; an unmatched
single name and an unmatched multi-name row both collapse to one flagged
task each rather than a blank or a duplicate; and a genuinely name-less,
non-group task is left exactly as before (unchanged regression check).
Two pre-existing suites re-run clean and unaffected
(`verify_owner_structured_markers.mjs` 13/13, `verify_process_transcript_
phonetic.mjs` 23/23); two older suites
(`verify_ownerraw_server_response.mjs`, `test_process_transcript_
taskEmail.mjs`) fail in this environment on a bare `@anthropic-ai/sdk`
module-mock specifier that can't resolve when the test file itself lives
outside the project tree — confirmed identical against unmodified `main`,
a pre-existing test-infrastructure issue unrelated to this change, not
fixed here.
**Tour reachability + popover positioning fix — same PR #281, follow-up on
its own re-issued Goals-retirement spec (2026-08-25).** The re-issued spec
also re-described Goals retirement (nav items, help/tour entries, data
preserved) — already fully covered by the entry directly above; no
additional work was needed there, confirmed rather than re-done. Two
genuinely new asks, both portals:

**Tour reachability.** The only way to see the tour again used to be a
fresh login/pull with no `tourSeen` flag set — the existing "↺ Replay tips
& tour" button (Help panel footer, and a second copy in Business
setup/employee Settings) only reset that flag and waited for the NEXT
pull to naturally re-trigger `_maybeStartTourFromPull()`; clicking it had
no visible effect in the same session. `replayTourAndTips()` (its own
copy per file, zero-shared-code rule) now closes the Help panel and calls
`startTour()` immediately after resetting the flag, in both files; the
Help panel's own button is relabeled "▶ Take the tour" to match. Also
added a content-version check — `ADMIN_TOUR_CONTENT_VERSION`/
`EMPLOYEE_TOUR_CONTENT_VERSION`, the same mechanism `ORG_LAYOUT_VERSION`
already established — stored as `tourSeen.adminVer`/`tourSeen.employeeVer`
alongside the existing boolean, stamped by `_markTourSeen()` and checked
by `_maybeStartTourFromPull()`: a user whose stored version doesn't match
the current one sees the tour once more automatically on their next
login/pull, same as someone who's never seen it at all. Bumped now (both
files, `v2_20260825`) so the #280 batch's tip/tour-step content updates
actually reach everyone who'd already dismissed an older tour, not just
new users.

**Tour popover positioning (`index.html` only — see below for why
`user.html` didn't need this).** `_showTourStep`'s old positioning always
anchored `popLeft` to `rect.left` and only clamped `popTop` to a fixed
ceiling (`window.innerHeight-200`) with no idea how tall the popover
actually was. For a left-sidebar target near the bottom of a long nav list
(Library, Messages, Business Setup — `#admin-sidebar` has its own
`overflow-y:auto`, fixed `height:100vh` column), that vertical clamp
pushed the popover UP and directly OVER the nav item it was describing,
and horizontally it never left the sidebar column at all. Root-caused via
a real Playwright walk of every `ADMIN_TOUR_STEPS` entry at a deliberately
short viewport (1400×720) before touching any code, confirmed rects
actually overlapping.

Fixed with a new `_tourPopoverPosition(el, rect, popEl)`: for any target
inside `#admin-sidebar` (`el.closest('#admin-sidebar')`), the popover is
always placed to the right (`rect.right + 14`, clamped to the viewport) —
in the content area, never over the nav column, per the task's own
explicit directive. For a non-sidebar target it picks below/above/right
based on which direction actually has room (`roomBelow`/`roomAbove`
computed against the popover's REAL measured size, not below/above at all
if neither fits). `el.scrollIntoView({block:'nearest'})` runs before
measuring — the sidebar's independent scroll container meant a target
further down the list could have `offsetParent!==null` (so
`_isVisibleForTour()` didn't skip it) while still being scrolled outside
the visible viewport, which would have measured the wrong rect entirely.

**A real bug was caught and fixed while building this, not shipped
blind:** the first version used a fixed `POP_H_EST=260` guess for the
above/below room checks and a plain `window.innerHeight-40` ceiling on the
final clamp — clamping `top` alone without knowing the popover's REAL
height meant the popover's own bottom edge (where the Next/Skip buttons
live) could still render off-screen on a short viewport, making the tour
un-advanceable — reproduced directly via Playwright (a real click on
"Next" timed out because the button was genuinely outside the viewport,
not a test-harness quirk). Fixed by mirroring `user.html`'s own, already-
correct, unrelated implementation of this exact problem: append the
popover hidden (`visibility:hidden`, no position yet), measure its real
`offsetWidth`/`offsetHeight` once it's actually in the DOM, compute the
position from that, then reveal it. `user.html`'s own tour
(`_positionTourPopover()`) already used this measure-after-render
technique — independently authored, zero-shared-code rule — and already
flips above/below based on real available room with an arrow indicator;
it doesn't have an explicit "always right for sidebar" case, but its
above/below logic already guarantees no overlap with the target's own
rect (unlike index.html's old fixed-ceiling clamp), confirmed by the same
Playwright walk finding zero overlaps there — so it needed no change for
this specific fix.

Verified: syntax-checked (`new Function()` per extracted `<script>`
block) both HTML files — clean; div-balance delta unchanged vs. `main` in
both (`index.html` −2, `user.html` −1). A new Playwright suite (17/17)
against both real UIs, at a 1400×720 viewport chosen specifically to
reproduce the old bug: a stale-version `tourFlags` auto-starts the tour
once on login in both portals (version-bump reshow); the stored version
updates to the current one after dismissing (verified against a STATEFUL
`/api/ops-sync`+`/api/ops-state` mock — `cloudPushAll()` pulls fresh right
after a successful push, so a static mock would have made a genuinely-
working save look broken, a test-mock pitfall caught and fixed before
trusting the result); the Help panel button reads "Take the tour" and
immediately shows the tour overlay with no reload, closing the Help panel
first, in both portals; walking every real `ADMIN_TOUR_STEPS` entry
(including at least 2 sidebar-target steps actually exercised) confirms
zero overlap between the popover and the spotlighted element on any step;
and Goals' nav items/functions/help copy are all still confirmed absent in
both portals (the re-issued spec's own acceptance criterion). Re-ran three
pre-existing suites that exercise the tour end-to-end
(`verify_help_tips_new_features.js` 16/16,
`verify_recent_activity_and_clickable_overview.js` 11/11,
`verify_retire_goals.js` 17/17, all at their normal taller viewports) —
clean, confirming the rewritten `_renderTourStep` doesn't change the
ordinary (non-version-mismatch, non-cramped-viewport) tour flow.

**Fixed task parsing for a linked/dual-identity account (Sherine)
(2026-08-25).** `api/process-transcript.js` + `api/ops-sync.js`
(comment-only) + `user.html` (comment-only). Reported: Sherine — who now
has BOTH an `ops_users` row AND a linked `ops_admins` row
(`adm_1784122163153`, `level:'creative_manager'`, granted via index.html's
"Grant Manager Role" — see that feature's own 2026-08-24-or-earlier
comment block, "dual-mode account model, Step 3") — couldn't parse/add
Daily Tasks: nothing persisted correctly to her own list. Root-caused by
actually reading the login resolution (`api/ops-auth.js`'s dual-role
branch: `session.id`/`session.employeeId` are always her `ops_users` row's
id — her CANONICAL identity — regardless of her admin tier) rather than
guessing, then tracing every place that identity gets used or re-derived.

**Two real, distinct bugs found in `api/process-transcript.js`, both from
the same root cause: she's the first real account this dual-role
mechanism has ever been exercised against, and this feature predates
(never accounted for) it.**

1. `activeRoster()` added her `ops_users` row AND her linked `ops_admins`
   row as TWO SEPARATE roster candidates for the same real person, under
   two different ids. A full-name match (`matchOwner()`'s exact-match
   step) happened to still resolve correctly by incidental array order
   (`users` concatenated before `admins`) — fragile, not by design — but a
   bare FIRST-NAME reference to her (an entirely ordinary thing to write
   in one's own daily-task list, e.g. "Sherine — call the vendor") broke
   outright: `matchOwner()`'s unambiguous-first-name rule requires exactly
   one roster member sharing that first name, and now saw two ("Sherine"
   matching both her rows), so it refused to resolve at all. Fixed with a
   new `dedupeLinkedIdentities(users, admins)`: any `ops_admins` row whose
   `linkedUserId` points at a user actually present in the roster is
   folded into that SAME entry (its title/level kept as useful display
   context, e.g. "Sherine Amin — Creative Manager") rather than added as a
   second candidate — every consumer (`matchOwner`, `resolveAttendeeIds`,
   the prompt's own roster list) needed no further change, since they
   already just operate on whatever the roster array contains. Guards a
   real edge case beyond Sherine's own (not reproducible with today's
   data, still worth getting right): if the linked employee row were ever
   inactive while the admin row stayed active, the admin only gets folded
   away when its linked user row is actually present in the roster being
   built — never silently disappears from it entirely.
2. `callerTaskScope()`'s self-assign fallback ("no owner named — default
   to the caller") only ever applied to `tier==='member'` callers.
   Sherine's tier is `'manager'` (she has a real admin row now), so she
   hit the `isAdmin` branch, which — before this fix — never self-assigned
   anything, ever, leaving every genuinely name-less row (the ordinary
   case for a personal daily-task dump, which usually doesn't bother
   naming its own owner) permanently unassigned. Confirmed this wasn't
   just a hypothetical: the existing comment on this function still said
   "Sherine, who has no special admin/super tier of her own — she's a
   plain member" — describing a REAL PAST STATE that Grant Manager Role
   has since made false; the code was never updated for her account
   actually changing tier. Fixed by computing `selfId =
   session.employeeId || session.id` in `callerTaskScope()` (identical to
   `session.id` for a plain member, since `session.id` is already their
   employee id by construction) and using it in the `isAdmin` branch: a
   caller who HAS a real employee identity — a plain member, or a
   dual-role admin/manager like Sherine — self-assigns a name-less row to
   that canonical id; a caller with NO employee identity (a true
   admin-only account, or the primary admin) keeps the original
   behavior — left unassigned for manual triage, since there's no
   personal list to attribute it to. This also fixed a subtler,
   independent correctness bug the same gap caused: the merge-detection
   pass (`isSameTask`, which compares `assigneeId`) runs server-side,
   BEFORE any client-side patching could help — so Sherine's own recurring
   daily tasks could never be detected as "already exists, merge into it"
   on a second parse (candidate `assigneeId:null` vs. the stored task's
   real id), silently duplicating on every re-parse instead.

**`api/ops-sync.js` and `user.html` needed NO functional change** —
investigated both files named in the task (not skipped, actually traced):
`session.id` in `api/ops-sync.js`'s task-write path (the "not your task"
check, `creatableAssigneeIds`) is already her canonical employee id by
construction (same `api/ops-auth.js` fact as above), and she's `isAdmin`
there too (`tier!=='member'`) so she never even reaches the member-only
branch that would matter — a comment was added explaining this
(non-functional) so a future reader doesn't have to re-derive it.
`user.html`'s `_dtMyTasks()` (`assigneeId===currentUser?.id`) and
`runDtEmailParse()`'s own already-existing `et.assigneeId||currentUser?.
id||null` staging fallback both already use her canonical id
(`currentUser.id` comes from `api/ops-auth.js`'s response, the same
canonical id) — the block comment above `_dtMyTasks()` was corrected
(non-functional) since it incorrectly claimed `api/ops-state.js` scopes
`tasks` to "this member's own tasks" unconditionally, when that scoping
is actually member-tier-only; a manager/admin tier (including a dual-role
account) gets every task and relies on this exact client-side filter to
narrow it down — a materially different, now-accurate description of the
real security boundary.

Verified two ways, no live DB access (rule #11): (1) a `node:test
--experimental-test-module-mocks` run against the real, byte-identical
`api/process-transcript.js`, with a roster shaped exactly like Sherine's
real dual-role account (an `ops_users` row + a linked `ops_admins` row)
plus a plain single-identity member and a true admin-only account as
regression controls (9/9) — confirms the roster carries her exactly once
with her title folded in, a bare first-name self-reference resolves to
her canonical id (never her admin id), a name-less row in her own parse
self-assigns to her canonical id, re-parsing the same recurring task now
correctly finds the existing one to merge into, and both regression
controls are unaffected (a plain member still self-assigns as before; a
true admin-only caller's name-less task still stays unassigned). (2) An
explicit BEFORE/AFTER comparison, per this task's own acceptance
criterion — re-ran the identical test file against the unmodified
pre-fix code (`git stash`): 4 of the 9 checks genuinely FAILED (the exact
ones this fix targets — roster duplication, first-name-ambiguity
resolution failure, name-less self-assign failure, and merge-detection
failure), confirming this reproduces her real reported bug rather than
testing something already-working. Three pre-existing suites re-run
clean and unaffected (`verify_owner_structured_markers.mjs` 13/13,
`verify_process_transcript_phonetic.mjs` 23/23,
`verify_parser_any_layout_assignee.mjs` 28/28), plus `api/ops-sync.js`'s
own task-write suites (`test_ops_tasks.mjs` 26/26,
`verify_ops_sync_date_rules.mjs`, `verify_task_delete_permission_scope.mjs`)
— confirming the comment-only changes there caused no regression.
`node --check` on all three touched server/HTML files; div-balance on
`user.html` unchanged vs. `main` (−1); `ls api/*.js | wc -l` still 12.

**Editable subject/notes in review-before-assign staging, both portals
(2026-08-25).** `index.html` (`_renderTaStaging()`) + `user.html`
(`_renderDtStaging()`) only — no server change. A staged (non-merge) task
row's subject was static bold text; notes weren't shown in staging at
all. Both are now real `<input type="text">` fields, wired to the exact
same `_taUpdateStaged(row.id,'subject'|'notes',this.value)` /
`_dtUpdateStaged(...)` handlers every other staging field (client, due
date, priority, category) already uses — no new function, per the
task's own explicit constraint. A merge-candidate row (`row.mergeIntoId`
set) is untouched: still fully read-only with just a Discard button,
same as before this change — editable fields there would never actually
apply, since a merge only ever additively appends notes/tags/etc. onto
the pre-existing target task, not this staged row's own data.

Added one small guard neither portal had before, in the SAME two
functions being touched anyway: `_taUpdateStaged()`/`_dtUpdateStaged()`
now refuse to blank the subject to empty — the exact "Subject is
required" toast `saveTaskEdit()`'s manual-entry modal already uses,
re-render the row to visually reset the input back to its last valid
value. Without this, the new editable input would have made it trivial
to accidentally commit a nameless task, which nothing downstream (the
commit function, `api/ops-sync.js`) actually validates against.

Verified: syntax-checked (`new Function()` per extracted `<script>`
block) both HTML files — clean; div-balance unchanged vs. `main` in both
(`index.html` −2, `user.html` −1); `ls api/*.js | wc -l` still 12
(no server file touched at all). A new Playwright suite (15/15) against
both real UIs: the staged subject/notes render as real inputs carrying
the parser's (deliberately mis-transcribed, "Vet Spa") output; editing
either takes effect; blanking the subject is refused and the input
visually reverts; committing pushes the EDITED values, not the original
parsed ones, confirmed against the real `ops-sync` request body in both
portals (employee-side committing needed a longer wait — `user.html`'s
`commitDtStagedTasks()` pushes via the existing 2s-debounced
`_scheduleCloudPush()`, unlike `index.html`'s immediate `cloudAutoSync()`
call, an existing difference between the two files' sync timing,
unrelated to this change). Three pre-existing Playwright suites needed a
one-line selector update each (not a regression — they asserted the
subject text via `innerText()`, which no longer includes an `<input>`'s
value; switched to reading the input's `value` directly):
`verify_dt_staging.js` (now 17/17), `verify_ta_19task_completeness.js`
(now 12/12), `verify_ta_staging.js` (now 26/26, including the row-lookup
helper that located a specific staged row by its subject text, similarly
updated). Four more pre-existing suites needed no changes and re-run
clean (`verify_ownerraw_staging_hint.js` 6/6,
`verify_ta_staging_merge_commit.js` 9/9,
`verify_task_undo_new_datelock_admin.js` 21/21,
`verify_task_undo_new_user.js` 14/14).

**Task parser: strip "— Title" suffix before owner matching (2026-08-25).**
`api/process-transcript.js` only. Reported: real, in-roster people (Abby,
David, etc.) were coming back detected-but-unassigned. Root cause: the
model was echoing the roster's own display format —
`activeRoster()`/the prompt's roster list shows each person as "Name —
Title" for context — straight into `ownerName` instead of a bare name
(e.g. `"Abby Conklin — Production Manager"`), and neither
`resolveOwnerAlias()` nor `matchOwner()` has ever compared against
anything but a bare roster name, so the title suffix broke both the exact
match and the unambiguous-first-name fallback.

Fixed with a new `stripTitleSuffix(name)`, applied once inside
`matchOwnerWithAlias()` (the single choke point both `resolveAttendeeIds()`
and `resolveTaskOwners()` already call per split name, so every caller
gets the fix for free with no other change needed): strips a trailing
`" — Title"` / `" - Title"` suffix — the dash must have a space on BOTH
sides, so a real hyphenated name like "Mary-Jane" (no surrounding spaces
around that hyphen) is left untouched — and a trailing parenthetical
title (`"Sarah Samy (Owner)"`). This also repairs the Sarah alias: `"Sarah
Samy — owner"` now strips to `"sarah samy"` before `resolveOwnerAlias()`
runs, so it still resolves to Sarah Ibrahim rather than falling through
unmatched (the alias check already ran before the title suffix fix
existed, but only ever saw the un-stripped string, so it never fired on
this exact input shape before now). `ownerRaw` (the raw string shown in
the staging "detected: X" hint, and carried through for a multi-name
row's comma-join) is left untouched — only the matching input is
normalized, never what's displayed back.

Verified with a `node:test --experimental-test-module-mocks` run against
the real, byte-identical `api/process-transcript.js` handler, with
`@anthropic-ai/sdk` mocked to a scripted response (8/8): an em-dash
title suffix and a plain-hyphen title suffix (both with surrounding
spaces) each resolve to the real roster person; a parenthetical title is
stripped the same way; `"Sarah Samy — owner"` resolves to Sarah Ibrahim,
not the primary admin; a multi-name row where each name carries its own
title suffix co-assigns both real people; a genuine hyphenated name with
no surrounding spaces (`"Mary-Jane Watson"`) is left untouched, not
truncated; and a bare name with no title suffix at all resolves exactly
as before (regression check). Four pre-existing suites re-run clean and
unaffected: `verify_parser_any_layout_assignee.mjs` (28/28),
`verify_linked_identity_task_parsing.mjs` (9/9),
`verify_process_transcript_phonetic.mjs` (23/23),
`verify_owner_structured_markers.mjs` (13/13). `node --check` passed;
`ls api/*.js | wc -l` still 12 (no new file).

## Deferred / known gaps — not built, flagged rather than silently skipped

- **Pending Supabase migrations reaching prod before they're applied** —
  **RESOLVED 2026-08-05**, see the "Current state" entry below for the full
  writeup. Three outages (`ops_notifications`, `ops_org_links.deleted_at`,
  `ops_error_log.archived_at`) came from this before a CI pipeline existed
  to close it. Left here as a pointer rather than deleted so the history of
  why this got built isn't lost.
- **`lib/legacyDataTransform.js` is fully orphaned** — found while removing
  `api/import-legacy-data.js` (2026-08-18, see above): nothing imports it,
  not even `import-legacy-data.js` itself despite that file's own header
  comment referencing it. Left in place — it costs no serverless-function
  slot, so it wasn't part of the Hobby-plan fix that prompted this — but
  it's dead code from an earlier, abandoned schema-transform attempt and a
  candidate for deletion whenever someone's actually looking at it.
- **`client.html`'s `calcNextDue()` has no `quarterly` case**: found while
  fixing the no-weekend recurring-rollover gap (2026-08-06, see above) — a
  quarterly-freq service marked done via the admin Tracker wouldn't advance
  its due date at all (falls through every `if`/`else if`, `d` stays equal
  to `base`). `user.html`'s own separate `calcNextDue()` already handles
  `quarterly` correctly. Out of scope for that fix, flagged here instead.
- **Time-off balance year-bucketing has the same UTC-parse bug as the
  day-count fix (2026-08-08)**: `getTimeOffBalance()`/`getMyTimeOffBalance()`
  bucket ledger entries by year via `new Date(e.startDate).getFullYear()`
  — confirmed under `TZ=America/New_York` that a Jan 1 entry misbuckets
  into the prior year. Different computation from the day-count bug fixed
  the same day; not touched, flagged here instead.
- **Franchise permission-matching**: `index.html`'s member-permission logic
  and `user.html` don't yet look inside `client.locations[]` — a team member
  assigned only to a franchise service may not be recognized as "assigned to
  that client" there. `client.html` and `api/ops-sync.js`'s
  `checkMemberClientWrite` do handle it correctly.
- **CRN's two LinkedIn service instances** display identically (both just
  "LinkedIn") with no way to visually distinguish Tim's personal profile from
  the CRN company page — flagged, not fixed, pending a decision on whether to
  add a distinguishing label.
- Client cards showing bundle next to service ("Jobs 2/3" from the original
  catalog request) — still not started. The related Service Schedule
  Bundle/Service/Due-date filters (reading live from the Service Catalog)
  shipped in PR #90, replacing the old hardcoded "Agents" dropdown.
- The pre-existing local-only notification system in `client.html` (service-
  due alerts, etc.) was left as-is, not migrated onto the new synced
  `ops_notifications` table — the two are merged only at render time.
- **3 clients have a services/projects count mismatch** — AMPM (2/3), CRN
  (12/13), HSCM (20/21) — orphan project mirrors left over from the
  original client migration (PR #74). Sarah confirmed this is intentional;
  leave alone.
- **5 services reference malformed bundle names** ("SEO Project", "Monthly
  Content", "Website Development") missing the "Bundle" suffix the Service
  Catalog otherwise uses. Cosmetic drift, low priority, not fixed.
- **Assignment fields are inconsistent** (`assignee`/`assigneeId`/
  `assigneeIds`) on ~40 services — same person referenced via different
  legacy field names, not conflicting data. Sarah explicitly decided to
  **hold** on a bulk normalization pass — works fine as-is, self-corrects
  whenever a service is next edited, not worth the bulk-write risk.
- **HSCM has two "Facebook" services** (`_7`, `_15`) and **two "Blogging"
  services** (a `svc...` one and a `svms...` one) — possibly genuine
  duplicates. Flagged, not touched, pending a decision.

## Open items — parked, pending someone else's action

- **Migration pipeline bootstrap (Sarah):** add the `SUPABASE_DB_URL`
  GitHub secret and run the one-time `migration repair` + bootstrap
  `db push` per `supabase/MIGRATIONS.md` (see rule #12 and the
  Migration-apply pipeline entry above). Until this runs, the pipeline is
  merged-but-inert and every PR's `check-prod-current` shows red by design
  — that is expected, not a bug, and should not be re-investigated. This
  same one bootstrap step also fully resolves the 4 migrations
  (`ops_session_activity`, `ops_backups`, `ops_payroll`, `ops_tasks`) that
  got hand-applied to production after this pipeline was built — verified
  locally (see `supabase/MIGRATIONS.md`'s step 7): no separate action
  needed for those, the existing bootstrap `db push` safely no-ops over
  them and correctly records each as applied.
- **Run the Error Log cleanup once (Sarah):** ~602 stale entries exist
  (mostly one fixed 2026-07-13 bug, plus a 2026-07-24 Supabase SSL outage).
  The archive/clear control (PR #202) now works correctly; a cutoff around
  2026-07-25 keeps the ~10 genuinely recent entries visible.
- **Retire the standalone "Training Time" service on WebLight Media** once
  Assmaa moves its content into sub-items instead — waiting on her.
