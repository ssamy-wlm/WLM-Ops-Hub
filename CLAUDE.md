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
   merge.

5. **Document-model Supabase schema convention.** Every `ops_*` table is
   `id text primary key, data jsonb not null` (+ `updated_at`/`created_at`,
   sometimes `deleted_at`). RLS is enabled with **zero policies** on every
   table — only the server-side service-role key (used inside `api/*.js`,
   via `lib/supabaseAdmin.js`) can read or write. The browser never talks to
   Supabase directly.

6. **Destructive or high-blast-radius operations need a typed confirmation
   and a thorough dry run.** No auto-anything. See `api/migrate-client-data.js`
   for the pattern: dry-run computes and reports full before/after diffs and
   writes nothing; the actual write requires a token bound to the exact
   reviewed data plus the user typing an exact confirmation phrase.

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

10. **Branch + PR per feature, with a Vercel preview. Never merge without the
    user's explicit test/confirmation** on that preview, unless told
    otherwise for that specific change.

11. **No live Supabase/database access from this environment.** The Supabase
    MCP server requires an interactive OAuth approval step that a
    non-interactive session cannot complete. When live data is needed for
    verification, ask the user to use an existing in-app export (e.g. the
    "Export Backup (JSON)" button, which hits `/api/ops-state` fresh) or a
    SQL query pasted back — don't assume MCP DB access will work.

## Current state (as of 2026-07-07)

**Client data:** 85 active clients live in production, generated from the
authoritative CSV mapping and verified 100% match (client count, per-client
service counts, every service name/bundle/frequency, the Servpro→Yonkers
franchise nesting, and all known intentional duplicates/standalones) against
a live export. See PR #74 for the migration tool and franchise feature.

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
  `_seedAssmaaWorkload()`

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
- Client cards showing bundle next to service, and bundle/service/frequency
  filters reading from the catalog structure ("Jobs 2/3" from the original
  catalog request) — explicitly ordered to come after the data restructure,
  not yet started.
- The pre-existing local-only notification system in `client.html` (service-
  due alerts, etc.) was left as-is, not migrated onto the new synced
  `ops_notifications` table — the two are merged only at render time.
