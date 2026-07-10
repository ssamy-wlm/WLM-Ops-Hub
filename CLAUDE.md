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

11. **No live Supabase/database access from this environment.** The Supabase
    MCP server requires an interactive OAuth approval step that a
    non-interactive session cannot complete. When live data is needed for
    verification, ask the user to use an existing in-app export (e.g. the
    "Export Backup (JSON)" button, which hits `/api/ops-state` fresh) or a
    SQL query pasted back — don't assume MCP DB access will work.

## Current state (as of 2026-07-10)

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

## Deferred / known gaps — not built, flagged rather than silently skipped

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
