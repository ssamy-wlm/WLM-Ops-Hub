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
