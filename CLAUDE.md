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

## Deferred / known gaps — not built, flagged rather than silently skipped

- **Pending Supabase migrations reaching prod before they're applied** —
  **RESOLVED 2026-08-05**, see the "Current state" entry below for the full
  writeup. Three outages (`ops_notifications`, `ops_org_links.deleted_at`,
  `ops_error_log.archived_at`) came from this before a CI pipeline existed
  to close it. Left here as a pointer rather than deleted so the history of
  why this got built isn't lost.
- **`client.html`'s `calcNextDue()` has no `quarterly` case**: found while
  fixing the no-weekend recurring-rollover gap (2026-08-06, see above) — a
  quarterly-freq service marked done via the admin Tracker wouldn't advance
  its due date at all (falls through every `if`/`else if`, `d` stays equal
  to `base`). `user.html`'s own separate `calcNextDue()` already handles
  `quarterly` correctly. Out of scope for that fix, flagged here instead.
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
  — that is expected, not a bug, and should not be re-investigated.
- **Run the Error Log cleanup once (Sarah):** ~602 stale entries exist
  (mostly one fixed 2026-07-13 bug, plus a 2026-07-24 Supabase SSL outage).
  The archive/clear control (PR #202) now works correctly; a cutoff around
  2026-07-25 keeps the ~10 genuinely recent entries visible.
- **Retire the standalone "Training Time" service on WebLight Media** once
  Assmaa moves its content into sub-items instead — waiting on her.
