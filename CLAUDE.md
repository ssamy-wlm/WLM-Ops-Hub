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
   **For any `api/*.js` file: also run `node --input-type=module --check <
   path` (or exercise the file via a real dynamic `import()` in a Node test),
   not just a bare `node --check path`.** These files run as ES modules in
   production; a bare `node --check` on a `.js` file parses it as CommonJS,
   which does NOT catch an ES-module-only error like a duplicate top-level
   `const` declaration in the same scope — see the 2026-10-14 hotfix
   (PR #467) below, where exactly this gap let a parse error reach `main`
   undetected and take down the entire overdue/alert cron.

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
- Inactive-client services now hidden from employee views + workload
  (2026-09-24 — held for preview approval): `user.html`'s
  `loadMyAssignments()` (My Services), `updateAssignmentsBadge()` (nav
  badge/overdue count), and `_collectMyWorkItems()` (feeds My Roadmap)
  all collected a client's services from an UNFILTERED client list —
  the parent client's `status` was never checked, only reachable via
  `index.html`/`client.html` and never cascaded here. `index.html`
  needed no fix — every admin-facing workload/metrics path there
  (`_activeServicesForAssessment()`, Workload dashboard, My Team's
  Work, Client Health, My Roadmap admin) already filters
  `c.status==='active'` before collecting services; that's the existing,
  battle-tested idiom the `user.html` fix now matches too (filter, not
  cascade — reactivating a client restores its services for free, no
  service-level field ever touched). See DECISIONS.md.
- Admin Tracker no longer pushes stale client data over server changes
  (2026-09-25 — held for preview approval): root-caused to an out-of-order
  `/api/ops-state` response race between `index.html`'s own independent
  poll cycle and its embedded `client.html` iframe's (adminTrackerFrame)
  own, separate poll cycle — both read/write the same shared
  `wl_clients_db`/`wl_srv_snap_clients` keys, and the existing dirty-check
  had no notion of whether an incoming response was even the freshest one
  either context had seen. Reproduced live (no admin edit required at
  all) via a Node script extracting the real functions from both files.
  Fixed with a per-table "applied as-of" monotonicity guard
  (`_opsIsStaleResponse()`/`_opsRecordApplied()`) in BOTH `_applyServerArray()`
  copies — an out-of-order response older than the most recently applied
  one for that table is now skipped outright, regardless of arrival
  order. Opt-in per call site (only `clients` passes `asOf`) — every other
  table's behavior is byte-for-byte unchanged. `user.html`'s own embed of
  the same iframe (`trackerFrame`) carries the identical latent risk but
  was NOT touched here (out of scope for this admin-only ticket) — see
  DECISIONS.md.
- Notification bell: red unread-count badge + always-on sound
  (2026-09-25 — low-risk, display-only): both portals' bells now show a
  numeric unread-count badge ("99+" cap, hidden at 0) instead of a plain
  dot, and play a synthesized "bing" (Web Audio, no embedded audio file)
  when the unread count increases, gated behind a one-time user gesture
  for the autoplay policy. `index.html`'s `#admin-notif-dot` was
  converted in place (single, unambiguous call site,
  `refreshAdminNotifBadge()`). `user.html`'s `#notifDot` was NOT
  repurposed — it was already overloaded across three unrelated signals
  (announcement banner, assignment-due total, notif-unread), so a new
  dedicated `#notifCountBadge` element carries the unread count and the
  old dot was narrowed to only its other two, non-notification signals
  (no longer double-counts with the new badge). See DECISIONS.md for the
  full investigation and the rationale for not folding the three signals
  together.
- David email overhaul (2026-09-25, corrected same day — held for preview
  approval, `api/` path): David now only receives three email types — a
  time-off SUBMISSION notification (`timeOffSubmitted`, he's an
  approver), the new weekly team-completion report, and the new
  bi-monthly PTO report; every other email type (assignment, overdue/
  escalation, nags, daily digest, team-summaries, review routing,
  workAnniversary, etc.) is suppressed for him specifically —
  **email-only**, his in-app notification bell/`ops_notifications` rows
  are completely unaffected (the in-app insert in `insertNotifications()`
  always runs unconditionally; suppression only ever touches the email
  half that runs after it). Implemented as a single allowlist predicate,
  `isEmailSuppressedForDavid(toEmail, type)` (exported from
  `api/ops-sync.js`), checked inside `insertNotifications()` — the one
  choke point nearly every notification email in this codebase already
  passes through — plus the same check added to
  `api/send-assignment-email.js`'s own separate direct-send path (the
  "assignment" type never goes through `insertNotifications()`), scoped
  to automated sends only (`recipientId` present) so the Admin Controls
  "Send Test Email" diagnostic is never affected, matching that
  endpoint's own pre-existing quiet-hours carve-out for the same case.
  Deliberately NOT touched: `api/cron-backup.js`'s off-site backup email
  (every super/owner admin, David included) — flagged rather than
  silently suppressed, since it's a disaster-recovery safety net, not a
  routine notification, and wasn't named in the ticket's own examples;
  `api/inbound-email.js`'s confirmation replies (a direct reply to
  David's own action, not a notification reaching him passively). New:
  `api/cron-weekly-team-completion.js` (Friday 12:00 PM, and
  `api/cron-pto-report.js` (the 1st and 16th at 7:00 AM) — both true
  **America/New_York local time, DST-aware, year-round** (corrected same
  day from an initial fixed-UTC-offset version that drifted an hour
  during EDT — see below). Both crons now run HOURLY
  (`vercel.json`: `"0 * * * *"` for the weekly report, `"0 * 1,16 * *"`
  for the PTO report, the latter restricted to UTC days 1/16 since New
  York is always behind UTC so the target local morning always falls on
  the matching UTC calendar day too) and gate the actual send inside the
  handler via `lib/quietHours.js`'s newly-exported `localPartsInTz()`
  (the same real-IANA-timezone-database technique quiet hours already
  uses) — every other hourly invocation is a fast no-op. The weekly
  report is **services only** (corrected same day — tasks were dropped
  entirely, `ops_tasks` isn't even queried anymore); "completed" reuses
  the exact same signal `api/cron-overdue-check.js`'s own
  hierarchy-escalation block already established (a service's `lastDone`
  date). The PTO report **always sends**, every run, even when all three
  of Jacob/Abby/Michael took zero PTO that period — a person with
  nothing to report gets an explicit `"<Name>: No PTO taken during
  <start> – <end>."` line (corrected same day from a vaguer "no PTO taken
  in this period" with no dates) rather than being omitted or the whole
  email being skipped; there is no "skip if empty" branch anywhere in
  that file. Jacob/Abby/Michael are resolved by first name against the
  live roster since the three span both `ops_users` and `ops_admins`; a
  name matching 0 or 2+ people is flagged, never guessed. Both crons stay
  read-based idempotent (a duplicate/retried invocation for the same
  period never double-sends) and bypass quiet hours (precisely-scheduled
  reports, same reasoning as `cron-overdue-check.js`'s own digest/nag
  sends). See DECISIONS.md for the full data-model investigation
  (`recurringServices[]` has no completion concept at all and was
  correctly excluded from the weekly report; the "16th covers 1st–15th,
  1st covers 16th–end of prior month" window math; the partial-overlap
  judgment call; the DST-drift bug the correction fixed, demonstrated
  live in the test suite) and the 76-check Node verification suite (a
  fake in-memory PostgREST-over-fetch layer, calibrated against real
  `@supabase/supabase-js` request shapes, exercising the actual exported
  handlers end-to-end — no live Supabase access per rule #11 — including
  explicit EDT-vs-EST instants proving the old fixed-offset schedule
  would have fired an hour late/early for roughly 8 months of the year).
- Parser crash on Gemini retries fixed (2026-09-25 — held for preview
  approval, `api/`+`vercel.json`): a real production failure showed the
  transcript parser returning Vercel's own raw platform-crash page
  ("Unexpected token 'A'… An error occurred", not anything this app
  returns) with nothing in `ops_error_log` — root cause: `api/process-
  transcript.js`'s Gemini 503/retry backoff schedule
  (`[2000,5000,12000,25000]`, 19s of guaranteed sleep) plus pacing plus
  real network calls could exceed the platform's 30s default
  `maxDuration`, and Vercel killed the function mid-retry, before this
  file's own try/catch/logError/JSON-response code ever got to run.
  Fixed by raising `maxDuration` to 90s for this one function in
  `vercel.json` AND trimming `GEMINI_RETRY_BACKOFF_MS` to
  `[1000,2000,3000,6000]` (6s of guaranteed sleep, down from 19s) so the
  same 4-attempt retry budget fits with wide margin under the new
  ceiling — not just "raise the ceiling and hope," a deliberate,
  documented worst-case budget (~72s, see the constant's own comment for
  the full math and its stated assumptions). Also closed a real
  "guarantee" gap found during investigation: a `Retry-After` header
  from Gemini itself used to be honored completely unbounded — now
  hard-capped at `GEMINI_MAX_RETRY_DELAY_MS` (8000ms) so an
  upstream-controlled value can never itself blow the budget. A per-call
  fetch timeout (`AbortController`) was considered and deliberately NOT
  added — flagged, not fixed, in DECISIONS.md, since this endpoint's own
  16000-token `maxTokens` means a genuinely large, healthy generation
  could legitimately take a nontrivial number of seconds, and there's no
  live telemetry (rule #11) to calibrate a safe per-call cutoff without
  risking false-positive aborts on slow-but-successful responses.
  Verified with a new 9-check suite (the trimmed schedule's real requested
  delays, position/value-classified against the pacer's own wait;
  `Retry-After` clamping both when it needs to engage and when it
  shouldn't) plus the two pre-existing Gemini-retry suites re-run clean
  (16/16, 5/5) — 30/30 total, `node --check` clean.
- David email-suppression audit closed a real gap (2026-09-28 — held for
  preview approval, `api/`+`lib/`): `api/cron-backup.js`'s off-site
  backup email sent directly via `sendResendEmail()` to every super/
  owner admin, David included — completely bypassing the 2026-09-25
  suppression, which at the time only lived inside
  `insertNotifications()`/`api/send-assignment-email.js`. Fixed AND
  centralized: `DAVID_EMAIL`/`isEmailSuppressedForDavid()` moved from
  `api/ops-sync.js` into `lib/resendClient.js` (re-exported from
  `ops-sync.js` unchanged, so no existing importer needed a path
  change), and `sendResendEmail()` itself — the ONE low-level function
  every Resend-sending path in this codebase already goes through — now
  enforces the check directly: a new optional `type` param is checked
  against David's 3-item allowlist, and omitting both `type` AND the new
  explicit `bypassDavidSuppression` escape hatch is the SAFE DEFAULT
  (suppressed), not an opt-in a future new call site could forget. Every
  direct `sendResendEmail()` call site audited and fixed: `cron-backup.js`
  (`type:'backup'`, the reported bug — Sarah/other admins unaffected,
  the DB backup itself untouched either way), `cron-overdue-check.js`'s
  daily task reminder (`type:'dailyTaskReminder'` — David was never
  actually in that hardcoded 3-person list, fixed defensively so it
  can't silently start reaching him if that list is ever edited),
  `api/inbound-email.js`'s confirmation reply (`bypassDavidSuppression:
  true` — a direct reply to David's own action when he emails
  task@/service@, deliberately exempt, not a passive notification), and
  `insertNotifications()`'s own two internal calls (`bypassDavidSuppression:
  true` — already vetted by its own per-row filter one level up; a
  combined multi-notification batch has no single `type` of its own to
  check a second time). Verified with a new 20-check suite (the
  centralized predicate's 5 on/off combinations directly; the re-export
  identity; `cron-backup.js`'s real reported bug reproduced and fixed —
  David excluded, Sarah/Jacob still receive it, response counts correct,
  DB backup unaffected; the daily-reminder regression; the confirmation-
  reply bypass proven end-to-end against the REAL, unmocked
  `sendResendEmail()`) plus every pre-existing suite in this area
  re-run clean with no changes needed (David-suppression 15/15,
  send-assignment-email 4/4, inbound-email plumbing 70/70+42/42+52/52,
  weekly-completion 25/25, PTO-report 32/32) — 260 checks total,
  `node --check` clean on every touched file.
- Overview "Email the Team" composer replaces the old one-click "Email
  team summaries" (2026-09-28 — **merged**, PR #441): the Overview button (still `#emailTeamSummariesBtn`, super/
  owner-only + the existing 3h cooldown unchanged) now reads "📤 Email
  the Team" and opens a composer modal instead of firing immediately.
  Recipients: a checklist of every active user + admin (`_taAllAssignablePeople()`,
  which — unlike `_timeOffRoster()` — doesn't silently drop admin-only
  accounts) plus the primary-admin sentinel (Sarah), with a "Select all"
  toggle and a live selected-count label. Message: a template dropdown
  (`ETT_TEMPLATES`) pre-fills an editable subject+body for "Overdue work
  reminder," "Update your statuses," "Check your overdue items," or
  "Your work summary" (per-recipient breakdown — subject editable, body
  intentionally DISABLED with an explanatory note since there's no single
  shared body to edit for content that's generated per person), or starts
  fully blank on "Custom" — every template's text can be hand-edited
  before send. New generic `[X]` mail-merge token: any template's body
  can include the literal string `[X]` and each recipient gets it
  substituted with their own real "% incomplete" (`100 - pctDone`, with
  an explicit `0` special-case for a zero-assigned-item recipient — my
  own test caught this defaulting to a wrong "100% incomplete" before the
  fix). Server: the entire old `email-team-summaries` action in
  `api/ops-sync.js` was replaced (not duplicated) by `email-team-broadcast` —
  fresh Supabase-backed recipient resolution (client-supplied `{id,kind}`
  pairs only pick WHICH ids were checked; name/email/stats are always
  re-resolved server-side, never trusted from the request), the extracted
  `personStats()` helper reused for both the workSummary body and the
  `[X]` substitution, and a renamed cooldown key
  (`lastTeamBroadcastEmailAt`, replacing `lastTeamSummaryEmailAt` — a
  harmless one-time cooldown reset on deploy). Sent via a new
  `lib/resendClient.js` `buildPlainEmailHtml()` template (deliberately
  minimal — no colored header/button/border-radius card like the branded
  `buildEmailHtml()` every other notification uses) to favor Gmail's
  Primary tab over Promotions, from a dedicated
  `notifications@opshub.wlmsend.com` sender with reply-to Sarah — both
  now plumbed as new optional `from`/`replyTo` override params on
  `sendResendEmail()` itself, additive and backward-compatible (every
  existing caller keeps the env-driven defaults). This broadcast's new
  `type:'teamBroadcast'` is deliberately NOT on David's 3-item
  allowlist from the 2026-09-25/2026-09-28 suppression work, so he's
  automatically excluded from any team broadcast (reported to the admin
  via `suppressedForDavidCount` in the response, not a silent lower send
  count) — consistent with "David only gets 3 specific things by email."
  Verified with a new 28-check Node suite against the real exported
  handler (fake in-memory PostgREST layer, no live Supabase per rule
  #11 — tier gate, all 4 validation cases, cooldown, the happy path's
  exact from/reply-to/minimal-HTML/unresolved-id handling, the `[X]`
  token's real per-recipient values including the zero-assigned fix,
  workSummary's empty-plate skip, David's exclusion) plus a 26-check
  Playwright UI suite (modal open, recipient rendering/select-all, all
  5 templates' pre-fill/editable/disabled behavior, a full mocked send
  asserting the exact outgoing request shape and recipient list, the
  button's exact new label, zero JS errors) — 54 checks total, all
  passing; `node --check` clean on `api/ops-sync.js`/`lib/resendClient.js`/
  `api/inbound-email.js` (one stale comment fixed there); index.html's
  extracted-script syntax check and div-balance both clean (new modal's
  divs open=close, matching origin/main's own baseline delta).
- Gemini parser: stronger extraction prompt + solid free model
  (2026-09-28 — **merged**, PR #443, `api/`): root-caused a
  reported failure (a task-rich real meeting transcript returning 0
  extracted tasks) to the Roadmap mode's `SYSTEM_PROMPT` in
  `api/process-transcript.js` — a short, generic "extract every task,
  action item, goal, or idea" instruction with no few-shot examples,
  much thinner than the sibling taskEmail-mode prompt
  (`buildTaskEmailSystemPrompt()`, untouched) which already has rich
  prose-pattern/structured-marker owner-matching guidance. Real meeting
  transcripts are ordinary conversation, not a bulleted action-item
  list — a commitment stated casually ("I'll get to that this week") or
  addressed to someone else mid-conversation ("David, can you check on
  that?") was very plausibly the exact shape the old prompt's terse
  instruction, with nothing to anchor it, under-extracted on a
  free-tier Flash model. Rewrote `SYSTEM_PROMPT` to explicitly enumerate
  first-person commitments, requests addressed to someone else, shared/
  team commitments, and implied follow-ups buried in longer sentences,
  with an explicit "err toward including, not omitting" instruction, and
  added 2 few-shot examples (a first-person SSL-cert-renewal commitment;
  a mid-conversation request about a late invoice) — the bucket/
  category/name-spelling/JSON-schema instructions are otherwise
  byte-identical to before. Also bumped the shared `LLM_MODEL` fallback
  default from `gemini-3.6-flash` to `gemini-3.8-flash` (confirmed via
  web search both free-tier and generally-available as of 2026-09-28 —
  Google's newest stable Flash release, effectively the new default
  across Google's own products since its Sept 2 2026 release) —
  env-overridable via `LLM_MODEL`/`GEMINI_MODEL` as before, so this is a
  default-only change. This model constant and `callGemini()` are shared
  by BOTH the Roadmap mode and the taskEmail mode, so the model bump
  applies to both; the taskEmail mode's own prompt/logic was otherwise
  completely untouched. The already-shipped #427/#439 retry+timeout+
  JSON-error-handling logic (`GEMINI_RETRY_BACKOFF_MS`,
  `isTransientGeminiStatus()`, `.friendlyMessage`, the 90s
  `vercel.json` `maxDuration`) is unchanged — verified by a regression
  check that a 503 still retries and recovers exactly as before. Could
  NOT verify directly against the real "Sep 25 David/Sarah transcript"
  named in the ticket's own acceptance criterion — no live Gemini API
  key or Supabase access in this environment (rule #11) to fetch that
  real transcript or make a real model call; the ticket's own "needs
  preview + approval" instruction makes the user's own live check on
  the Vercel preview (pasting that real transcript in) the actual gate
  for this specific acceptance criterion, not something this session
  could self-certify. Verified everything within reach with a new
  27-check Node suite against the real, unmodified default-exported
  `handler()` (global.fetch mocked to capture the exact outgoing
  request and script scenario responses, no live access per rule #11):
  the new prompt's key phrases and both few-shot examples are actually
  present in the system message sent; the model field defaults to
  `gemini-3.8-flash`; a synthetic but realistic David/Sarah-style
  conversational transcript (first-person commitments, a mid-
  conversation request, a shared task, an aside) end-to-end produces
  the correct filtered/mapped tasks while the pre-existing validation
  (blank text, invalid bucket, `personal` category, a multi-word owner
  failing the `/^[a-z]{2,30}$/` schema) still correctly drops what it
  always dropped; the 503-retry-then-succeed path still works
  unchanged. `node --check` clean.
- PTO report missed ledger-only entries (2026-10-02 — **merged**, PR
  #448, `api/`): `api/cron-pto-report.js` read only
  `ops_time_off_requests`, so any PTO Sarah/David log directly through
  `index.html`'s "Log Time Off" ledger tool (`ops_time_off_ledger`, a
  separate admin-only entry path with no corresponding request row) never
  appeared — reported live: Abby's Sept 23–25 was ledger-only and showed
  as "No PTO taken." Now reads both tables and merges per person via a
  new `collectApprovedPtoItems()`. Ledger-side exclusions: an
  `isReversal:true` correction entry, and any entry that's itself been
  reversed (`reversalOf` points at it from another row), are both
  excluded — mirrors `index.html`'s own admin ledger view exactly, so a
  superseded/cancelled entry can never show as "taken." Dedupe is
  EXACT-date-range only (the reported case: Jacob's Sept 21 existed in
  both tables for the identical range) — a request always wins that tie
  and the ledger counterpart is dropped; a merely-overlapping-but-not-
  identical range is deliberately left as two separate lines (flagged,
  not guessed — rule #7). Verified with a Node suite against the real,
  byte-identical handler (fake in-memory Supabase client, no live access
  per rule #11): the pure merge/dedupe helper directly (ledger-only PTO
  appears; exact-date duplicates collapse to one line with the request's
  reason winning; overlapping-not-identical dates stay separate; a
  reversed entry and its own reversal are both excluded; a real
  correction entry still counts) plus the full handler end-to-end
  (Abby's ledger-only PTO appears with dates+reason, Jacob's cross-table
  duplicate collapses to one line, Michael's genuine zero-PTO case still
  reads "No PTO taken"). `node --check` clean.
- Inactive clients' services still surfaced server-side (2026-10-05 —
  **merged**, PR #451, `api/`+`client.html`): #430 only fixed the UI-side
  views (user.html) — reported live, Leese & Shapiro (both deactivated)
  still had active services (a) included in reminder/escalation emails and
  (b) kept getting their recurring due dates rolled forward
  ("reactivated"). Investigated before guessing (rule #7): every one of
  `api/cron-overdue-check.js`'s 4 `ops_clients` reads already had a SQL
  `.eq('status','active')` pre-filter — so a literal `status:'inactive'`
  client was already excluded there. The REAL, previously-undiscovered bug
  was in `api/ops-sync.js`'s `upsertRows()`: the denormalized
  `ops_clients.status` DB COLUMN that SQL filter reads was computed as
  `r.status==='inactive'?'inactive':'active'` — silently collapsing a real
  `'paused'` client into `'active'` at the column level, even though every
  JS-side check in this codebase already correctly treats `'paused'` as
  not-active via the literal `status==='active'` equality. Fixed the
  ternary to match that same literal equality
  (`r.status==='active'?'active':'inactive'`). Also added a shared,
  defensive `isActiveClient(c)` (reads the real `data.status` directly,
  never the possibly-stale column) applied as a second, authoritative
  filter right after all 4 `ops_clients` reads in `cron-overdue-check.js`
  — this is what makes the fix effective immediately for any row written
  BEFORE the column fix above, with no backfill needed. Deliberately NOT
  applied to the Tier-3 inactivity-detection "completedSince" scan (same
  file) — that scan only asks "did this person do real work recently,"
  and excluding a just-deactivated client's completed work there would
  risk wrongly flagging someone inactive for genuine work, out of this
  ticket's scope. `client.html`'s `refreshRecurringDueDates()` (runs
  unconditionally on every Tracker load, confirmed NOT one of the
  disabled load-time gremlins — a real, intentional "advance an overdue
  recurring service's due date automatically" feature) gained the same
  `isActiveClient()` check (hand-duplicated, rule #3) and now skips an
  inactive/paused client's services entirely — frozen exactly as they
  were at deactivation, never silently advanced. `cron-weekly-team-
  completion.js` was investigated and deliberately left untouched — its
  own header comment already documents, by design, that it includes every
  client regardless of active status (a retrospective "what got done this
  week" record, not a live reminder). Verified with 2 new Node suites (no
  live DB access, rule #11 — a fake in-memory Supabase client exercising
  the real `cron-overdue-check.js`/`ops-sync.js` handlers end-to-end,
  including a deliberate stale-column test case: a client whose DB column
  says 'active' but whose real `data.status` is 'paused', proving the
  fix catches it even without a backfill) plus a new Playwright suite
  against the real, live-rendered `client.html` (an inactive and a paused
  client's overdue recurring service both provably untouched after
  `init()`, while an active client's correctly rolls forward). `node
  --check` clean; `client.html`'s div-balance delta unchanged vs. `main`
  (0 — pure JS change, no HTML touched).
- Due-date-change approval silently failed + misreported as declined on a
  locked task (2026-10-06 — **merged**, PR #453, `api/`): reported
  live on task `task_1788791312066_8xjn3q5` (approved 2026-10-30, stayed
  2026-09-25, employee got "declined"). Root cause in `api/ops-sync.js`'s
  admin task-write branch: `dueDate` may be changed by an admin exactly
  ONCE, then `dueDateLocked` permanently freezes it — a rule meant for
  ordinary task edits, not for approving a due-date-change request, which
  by definition only ever fires on a task that's already locked (a member
  can't request moving a date that was never set). The old
  `approved: dueDateJustLocked` signal is false whenever the task was
  already locked, so an approval both silently kept the old date AND
  reported itself to the employee as a decline. index.html's own
  `_taResolveDueDateRequest()` was already correct (sends the clamped
  approved date, or the unchanged date on decline) — audited and left
  untouched; the inverted/lock-gated path was entirely server-side. Fixed
  by detecting "this write is resolving a pending request" the same
  not-trusted-from-a-flag way every other resolution in this file already
  is (`cur.dueDateChangeRequest` existed and the incoming write explicitly
  clears it), and — only in that case — letting an incoming `dueDate` that
  actually differs from `cur.dueDate` override the lock
  (`dueDateApprovedOverride`); the resolve-notification's `approved` field
  now reads `dueDateApprovedOverride || dueDateJustLocked`, covering both
  the already-locked case (the real bug) and a request resolved before the
  task was ever admin-locked (the pre-existing, already-correct path). A
  genuine decline sends an unchanged `dueDate`, so none of this fires and
  both the date and the lock stay exactly as they were, same as before.
  Verified with a new 4-check Node suite against the real, byte-identical
  handler (fake in-memory Supabase client, no live access per rule #11):
  approving on an already-locked task now applies the new date, re-locks
  at it, and notifies "approved" (confirmed this test fails against the
  pre-fix code, reproducing the exact reported bug: date stuck at
  2026-09-25 instead of 2026-10-30); declining on a locked task leaves
  date+lock untouched and notifies "declined"; approving on a
  never-before-locked task still works (regression, the one path that was
  already correct); an unrelated resave that doesn't touch
  `dueDateChangeRequest` fires no resolve notification at all. `node
  --check` clean. Held per rule #10 — touches `api/ops-sync.js`'s
  real task-write/notification logic.
- Employee "My Tasks" under-counting root-caused to the asOf sync guard,
  NOT a client-status filter (2026-10-07 — **merged**, PR #455,
  `api/`+`index.html`+`user.html`+`client.html`): reported as "Rana's admin
  plate shows 40 active tasks, assigned to her ID, on active-or-no
  clients, but her employee portal shows fewer" with the ticket's own
  stated hypothesis blaming a #430-style client-status filter. Investigated
  before guessing (rule #7) — exhaustively: NEITHER `_dtMyTasks()`/
  `renderDailyTasks()` (the real "My Tasks" page — confirmed via its own
  nav label) NOR `_collectMyWorkItems()` (a different page, "My Roadmap")
  apply any client filter to `ops_tasks` items at all, client- or
  server-side (`api/ops-state.js`'s member-tier task scoping is pure
  `assigneeId`/`assignedById` equality, no client involved anywhere). A
  live Playwright reproduction against the real `user.html` confirmed this
  directly: 40 seeded tasks (mixed active-client/no-client/client-id-not-
  in-the-loaded-set) all rendered correctly. Flagged this back and asked
  the user how to proceed rather than force-fitting the ticket's named
  mechanism; user chose to harden the one concrete alternative mechanism
  found instead. REAL root cause: PR #450 (merged the day before this
  ticket, undocumented in CLAUDE.md/DECISIONS.md at the time) added an
  `asOf` monotonicity guard to all three frontends' `_applyServerArray()`
  that rejects an out-of-order response using each BROWSER's own
  locally-captured pre-send timestamp as the "freshness" anchor — which
  measures "when did this browser decide to ask," not "how fresh is this
  data." Two of a page's own overlapping polls (its 20s/15s intervals, a
  visibilitychange pull) can have their REQUESTS issued in one order but
  their RESPONSES arrive in the opposite order under ordinary Vercel
  cold-start/network latency variance — the guard would then silently
  discard the genuinely newer, more-complete response (e.g. reflecting an
  admin's just-added task assignments) as "stale," purely because it was
  asked for first, freezing the employee's local task count below reality
  until a later poll happened to win the race correctly. Fixed at the
  root: `api/ops-state.js` now stamps a `serverReadAt` timestamp
  server-side, right before its DB fan-out, and returns it on every
  response; all three frontends' pull functions (`cloudFetchUsers()` in
  user.html, `cloudPullAll()` in index.html, `_pullClientsFromCloud()` in
  client.html) now anchor the `asOf` guard on `r.serverReadAt` (with a
  `?? Date.now()` defensive fallback for an old cached record predating
  this field) instead of their own pre-send timestamp — this correlates
  with true data freshness regardless of either leg's network transit
  time, since the shared Supabase DB is the single, consistent source of
  truth a later server-side read is guaranteed to see at least as
  current. The guard's actual protection (reject a genuinely OLDER
  response) is completely unchanged — only the timestamp's SOURCE moved
  server-side. Verified: a new 2-check Node suite against the real,
  byte-identical `api/ops-state.js` handler (fake in-memory Supabase
  client, no live access per rule #11) confirms `serverReadAt` is a real
  number captured within the request's own wall-clock window, and stays
  non-decreasing across sequential requests; a new 4-check Playwright
  suite against the real `user.html` reproduces the exact race directly
  against `_applyServerArray()` — a genuinely fresher 40-task response
  (serverReadAt=3000) arriving AFTER an already-applied 20-task one
  (serverReadAt=2000) is now correctly ACCEPTED (this is the fix; the old
  client-timestamp scheme would have rejected it), while a genuinely
  OLDER response arriving later is still correctly REJECTED (the guard's
  real protection is intact). `node --check` clean on `api/ops-state.js`;
  inline-JS syntax clean on all three frontends; div-balance unchanged vs
  `main` on all three (pure JS changes, no HTML touched).
- Leave-aware alerts: suppress nags/inactive-flags during approved time off
  (2026-10-14 — **merged**, PR #459, `api/`): reported live — Jacob
  Joslin, on approved PTO Oct 12–16, was still listed in the Oct 14
  "big-issue" alert under both "Manager/admin overdue (5+)" (13 overdue)
  and "Inactive since 2026-10-13 (no login, no completed work)." Owner
  decisions: approved leave hides the person ENTIRELY (no separate "on
  leave" line); only `status==='approved'` suppresses — a pending request
  (the ticket's own counter-example: Sarah Ibrahim's pending Oct 16
  request) never does. New shared helper
  `getApprovedLeaveIdSet(supabase, win, warnings)` in `api/ops-sync.js` —
  reuses the exact same approved/non-reversed/non-cancelled/overlap
  predicates `api/cron-pto-report.js`'s `collectApprovedPtoItems()`
  already established for both `ops_time_off_requests` and
  `ops_time_off_ledger` (kept in sync deliberately); `overlapsWindow()`
  itself was moved (not duplicated) from `cron-pto-report.js` into
  `ops-sync.js` so both files import the one shared copy —
  `collectApprovedPtoItems()`'s own behavior is byte-identical, re-run
  clean. Fail-OPEN by design: any read error degrades to an EMPTY set
  (never a throw), so a broken time-off read can never silently hide a
  real overdue/inactive person — only ever ADD false suppression risk
  toward "alert fires when it maybe shouldn't," never the reverse.
  Hardened one documented gap beyond the ticket's own given code: the
  ledger half originally keyed its reversed-entry exclusion
  (`reversedIds.has(e.id)`) off a BARE `r.data` object with no `id`
  merged in — harmless for a normally-written row (ops-sync.js's own
  `insertNewOnly()` already stores the full record, `id` included, inside
  `data`), but fragile for an edge-case row missing it; now merges
  `{id: r.id, ...r.data}` the same defensive way
  `collectApprovedPtoItems()`'s own ledger caller already does. Applied at
  4 suppression points in `api/cron-overdue-check.js`, each canonicalizing
  both sides with that block's own existing `canonMap`/`canonicalId` (so
  a dual-role person's leave suppresses them regardless of which identity
  the time-off row is filed under — same convention `activeSince`/
  `overdueCounts` already use): (a) the twice-daily overdue self-nag
  (`considerForNag`, window `{today, today}`); (b) "Manager/admin overdue
  (5+)" (`escalatingAdmins`, window `{today, today}`); (c) "Inactive
  since …" (`inactivePeople`, window `{cutoffDateStr, today}` — the
  WIDER look-back range, since leave anywhere across it legitimately
  explains no login/no completed work); (d) the weekday-morning "add your
  tasks" reminder (`DAILY_TASK_REMINDER_RECIPIENTS`) — these 3 recipients
  are hardcoded `{name,email}` pairs with no id of their own, so each is
  resolved against the live directory by email first (same lookup the
  block's own quiet-hours check already does) before canonicalizing and
  checking, window `{cairo.dateStr, cairo.dateStr}` (this block's own
  already-computed run-day date). Due dates are completely untouched;
  once leave ends, the person reappears automatically on the next run —
  no manual reset, no backfill. Scope note (flagged, not guessed — rule
  #7): `getApprovedLeaveIdSet` is ID-only (`userId`/`employeeId`), per
  the ticket's own given code — it does NOT fall back to matching by
  name the way `collectApprovedPtoItems()`'s own PER-PERSON predicate
  does (that fallback only makes sense with a specific person to match
  against; this helper computes a global id set, not a per-person
  check), so a real time-off row with no id at all would not suppress
  anyone — verified as the row's actual documented behavior, not an
  oversight. Verified with a new 10-check Node suite against the real,
  byte-identical `getApprovedLeaveIdSet`/`overlapsWindow` (fake in-memory
  Supabase client, no live access per rule #11): id-match + both tables;
  pending never suppresses; a reversal entry and an entry reversed by
  another both never suppress; leave-window edge (in vs. out of range);
  fail-open on a forced read error — confirmed this exact ledger-defense
  gap by first writing a realistic (no embedded `data.id`) fixture, which
  failed against the ticket's own literal given code, then fixing it as
  described above. A new 5-check Playwright-free end-to-end suite against
  the real, unmodified `api/cron-overdue-check.js` handler reproduces the
  exact live scenario (Jacob 13-overdue + on-leave, Sarah 5-overdue +
  pending-only, Lenny 5-overdue + a reversed ledger "leave," David
  genuinely inactive with no leave at all) across both the 11:00 UTC
  hierarchy run and the 13:00 UTC nag run, a later run after Jacob's leave
  ends (he reappears, unprompted), the daily-reminder skip (point d), and
  a forced leave-read failure (still alerts, fail-open) — confirmed all 4
  behavior-asserting tests in this suite fail against the pre-fix code
  (via `git stash`) and pass clean after. `node --check` clean on all 3
  touched files (`api/ops-sync.js`, `api/cron-pto-report.js`,
  `api/cron-overdue-check.js`); no HTML touched, so no div-balance check
  applies. Held per rule #10 — touches live cron/notification logic;
  no data writes, no schema change, no sync/permission change.
- Employee task status edit silently reverting on background sync fixed
  (2026-10-14 — **merged**, PR #460, `user.html`): reported as "editing a
  task appears to save, then reverts on the next sync, as if not saved."
  Traced end-to-end before guessing (rule #7): `_dtChangeStatus()` (the
  inline status dropdown on the My Tasks list — the single most commonly
  used task edit, not the detail panel's Save button) was the one
  task-field write path in this file that never awaited or checked its
  own push result — `dbSet()` + the 2-second-debounced
  `_scheduleCloudPush()`, with `"Status updated ✓"` shown immediately and
  unconditionally, before the push even started. `saveDtTaskUpdate()`
  (detail panel) and `submitReportTask()` already correctly
  `await cloudPushData()` and roll back on failure. `_opsDirty()`'s
  dirty-tracking and `_applyServerArray()`'s whole-record preservation
  (user.html's merge strategy — confirmed *more* protective than
  index.html's field-level merge, not less) were both ruled out directly:
  a concurrent-pull-before-debounce and a reload-before-debounce both
  correctly preserved a pending edit. `finalizeRecurring()` was also ruled
  out (scoped only to a recurring task's own Done-transition). Real
  mechanism: the 2-second debounce is a materially larger race window
  than index.html's own immediate, non-debounced admin-side push for the
  same control — long enough for a concurrent admin edit to the same task
  (reassignment, category change) to trigger a genuine server-side
  rejection via `api/ops-sync.js`'s `TASK_KEYS_MEMBER_MAY_NOT_TOUCH`
  disallowed-key check, which the old fire-and-forget path never
  surfaced — the edit never reached the server at all, and the next real
  sync showing the untouched value read as "it reverted." Fixed to match
  `saveDtTaskUpdate()`'s discipline: push immediately (no debounce),
  await the result, and on anything but a clean accept roll the field
  back to its prior value (re-reading the array fresh, not the closed-
  over copy, since a legitimate background pull may have changed other
  fields on the same task while the push was in flight) and surface the
  real failure — the actual rejection reason or a generic "could not
  save" for a network-level failure — instead of claiming success ahead
  of the server's answer. Verified with a 4-scenario Playwright suite
  against the real, unmodified `user.html` (successful edit persists
  through a concurrent pull and pushes promptly with no debounce window;
  a genuine rejection rolls back and surfaces the real reason; a 500
  rolls back with a generic error; zero-JS-error load check across all
  three portals) — confirmed via `git stash` that the suite fails against
  the pre-fix code, proving it's a genuine regression test. `node --check`
  clean; div-balance unchanged vs. baseline (delta -1).
- `getApprovedLeaveIdSet` name fallback — a reliability net (2026-10-14 —
  **merged**, PR #464, `api/`): `getApprovedLeaveIdSet` (added the
  same day, see the leave-aware-alerts entry above) only ever matched a
  time-off row to a person by raw id (`userId`/`employeeId`), unlike
  `api/cron-pto-report.js`'s own `collectApprovedPtoItems()`, which
  already matches by id OR name — a leave row filed under a name with a
  missing/stale id would be counted by the PTO report yet missed by
  suppression. Gave the function an optional 4th `directory` param
  (`{users, admins}`, same shape `loadDirectory()` already returns);
  omitting it keeps the function byte-identical to before (back-compat).
  When passed, a new `buildNameIdMap()` helper builds a lower-cased/
  trimmed full-name → id map from the roster, excluding any name shared
  by 2+ people (never guess which one — rule #7) and pushing one warning
  per ambiguous name (not per row). Each approved+overlapping request/
  ledger row still adds its raw id exactly as before, AND — additively —
  resolves its `userName`/`employeeName` through the map and adds that id
  too if found uniquely. Still returns a `Set` of raw ids; every caller
  canonicalizes exactly as before. Updated all 4 call sites in
  `api/cron-overdue-check.js` to pass their already-loaded directory
  (`{dtrUsers,dtrAdmins}`/`{nUsers,nAdmins}`/`{hUsers,hAdmins}` ×2) — each
  block already had the directory in scope, so this is a pure additive
  argument, not a new read. Verified with a new 8-check Node suite against
  the real, unmodified export (fake in-memory Supabase client, no live
  access per rule #11): a request row with a matching name but a blank
  userId is suppressed by name; a ledger row with a matching employeeName
  but no employeeId likewise; an id-based match still works unchanged
  with a directory passed (regression); an ambiguous duplicate name is
  never resolved by name (a warning fires exactly once, not once per
  row), while a DIFFERENT row's own real id for one of the duplicates
  still suppresses normally; omitting `directory` entirely reproduces
  today's id-only behavior exactly, including zero warnings; a pending
  request and a reversed/self-reversal ledger entry still never suppress,
  even when a name would otherwise resolve — confirmed via `git stash`
  that 4 of these 8 (the ones directly exercising the new name-match
  behavior) fail against the pre-fix code. Re-ran the leave-aware-alerts
  e2e suite (5/5, unchanged — this branch doesn't touch the daily-
  reminder recipient loop itself, only adds the 4th arg to its
  `getApprovedLeaveIdSet` call), the leave-aware-alerts unit suite
  (10/10), and the PTO-report ledger-merge suite (2/2) — 25/25 total.
  `node --check` clean on both touched files. Intentionally a SEPARATE PR
  from the daily-task-reminder dynamic-recipient-list change above — same
  ticket, explicitly split so each is independently testable/revertable;
  no shared code path beyond both already reading from the same
  `loadDirectory(supabase)` call each block already had in scope.
- Daily task reminder now reaches every active employee, not a hardcoded 3
  (2026-10-14 — **merged**, PR #463, `api/`): reported live — the
  weekday-morning "add your tasks" email in `api/cron-overdue-check.js`
  only ever went to a hardcoded `DAILY_TASK_REMINDER_RECIPIENTS` 3-person
  list (Rana/Sherine/Assmaa), silently skipping every other active member
  and still emailing Assmaa, who'd left the company (`status:'inactive'`).
  Replaced the hardcoded loop with a dynamic recipient list —
  `dtrUsers.filter(u => u.status !== 'inactive' && u.email)` — looping
  over each `u.name`/`u.email`/`u.id`/`u.team` directly (no email→row
  lookup needed anymore, so the old `teamForEmail()`/`idForEmail()`
  helpers were removed along with the constant itself). Scope: active
  *members* (`ops_users`) only — admins unchanged, they get escalation
  emails instead; the ticket itself flagged this rather than assuming
  admins should be added too. The two existing per-recipient suppressions
  (quiet-hours via `isWithinQuietHours(u.team, ...)`, leave-aware via
  `onLeaveTodayDtr.has(canonicalId(u.id, dtrCanonMap))`) are unchanged —
  only their input (a real roster row vs. a hardcoded pair) changed.
  `summary.dailyTaskReminder` now reports a dynamic `sent/suppressed`
  count against the real eligible-recipient total instead of a hardcoded
  `/3`. Verified with a new 7-check Node suite against the real,
  unmodified handler (fake in-memory Supabase client, no live access per
  rule #11): every active-with-email member is attempted; an inactive
  member (Assmaa) never is; a member with no email is skipped with no
  warning at all; a member on approved leave today is still suppressed; a
  'US'-team member inside their own quiet window is still suppressed
  while an 'Egypt'-team member at the same instant is not; a brand-new
  active-member fixture is picked up with zero code changes; the summary
  string reflects the dynamic count — confirmed via `git stash` that 2 of
  these (the Assmaa-exclusion and new-hire-inclusion checks, the two
  behaviors the old hardcoded list literally could not have) fail against
  the pre-fix code. The pre-existing leave-aware-alerts e2e suite's
  recipient fixtures were updated to real `ops_users` rows (the hardcoded
  list it exercised no longer exists) with no change to what it actually
  asserts; re-run clean (5/5), together with the leave-aware-alerts unit
  suite (10/10) and the PTO-report ledger-merge suite (2/2) — 24/24 total
  across all 4 files combined. `node --check` clean. Intentionally a
  SEPARATE PR from the `getApprovedLeaveIdSet` name-fallback change below
  — different risk surface, independently revertable.
- Overview urgency donuts replaced with compact horizontal segmented bars
  (2026-10-14 — **merged**, PR #462, `index.html`, Option A from the
  mockup): the "Tasks by Urgency"/"Services by Urgency" cards now render a
  header ("N open"), a single rounded segmented bar (Overdue/Due this
  week/Due this month/Upcoming, same colors as before), and a 2-column
  legend — replacing the two SVG donut rings. Render-only change, per
  scope: ALL existing data/computation and the Services frequency filter
  (#433) untouched — `_renderOverviewUrgencyDonut(group, bucketTotals)`
  kept its name and exact input contract from
  `renderTeamProductionAnalytics()`. Segment widths are plain percentages
  of bucketTotals/total, always summing to 100% by construction — no
  floating-point remainder special-case needed the way the old donut's
  SVG arc-length math required. A 0-count bucket contributes no bar
  segment element but still renders its own legend row (0). Removed the
  now-dead `_ovUrgencyHover()`/`_ovUrgencyUnhover()` donut-highlight JS
  and the SVG center-overlay elements (nothing left to highlight);
  hover-for-count kept via a native `title` attribute on each segment/
  legend row instead. IDs renamed `...-urgency-donut-wrap` →
  `...-urgency-bar-wrap`. Verified with a new Playwright suite: segment-
  width proportionality + legend correctness (including the 0-count
  case) against the render function directly; an end-to-end test via the
  real `renderTeamProductionAnalytics()`/`setOvSvcFreqFilter()` proving
  switching the Services frequency filter updates the Services card's
  bar+legend while the Tasks card's stays byte-identical; zero-JS-error
  load check across all three portals. `node --check` clean; div-balance
  unchanged vs. baseline (delta -2).
- Production hotfix: duplicate `const onLeaveTodayDtr` broke the overdue/
  alert cron (2026-10-14 — **merged**, PR #467, `api/`): `api/cron-
  overdue-check.js` on `main` failed to load as an ES module
  (`SyntaxError: Identifier 'onLeaveTodayDtr' has already been
  declared`) after PR #464's branch was updated by merging `main`
  (carrying PR #463's rewrite of the same reminder block) instead of
  being rebased — the merge kept both sides' versions of the leave-set
  line plus an orphaned `idForEmail()` helper. Every overdue/alert
  feature (self-nags, the daily big-issue alert, "Inactive since…", and
  leave-aware suppression) stopped firing; no data was affected (read-
  only feature). A bare `node --check` on the file passed clean the
  whole time (parses as CommonJS, where the redeclaration isn't an
  error) — only module-mode checking or an actual ESM `import()` catches
  it. Fixed surgically: removed the duplicate 3-arg
  `getApprovedLeaveIdSet()` call and the dead `idForEmail()` helper,
  kept the single 4-arg call (with the name-fallback directory). Verified
  via `node --input-type=module --check`, grep counts, and the full
  32-check PR-A/PR-B/leave-aware-alerts/PTO-report suite set (all of
  which dynamically `import()` the real file, so they failed 7/7 against
  the broken pre-fix code via `git stash` and passed clean after — the
  same load failure a live invocation would hit). Rule #9 and the "Key
  lessons" section updated with the module-mode `node --check`
  requirement and the merge-vs-rebase lesson so this class of error
  can't silently reach `main` again.
- Don't send emails to inactive users (2026-10-15 — **merged**, PR #470,
  `lib/`): deactivated employees kept receiving Ops Hub emails
  (overdue nags, digests, assignment emails), wasting the monthly Resend
  quota. Fixed with one guard at the single choke point every Resend-
  sending path in this codebase already goes through —
  `sendResendEmail()` in `lib/resendClient.js`, right alongside the
  existing David suppression. A new `isEmailSuppressedForInactiveUser
  (toEmail, rosterStatusMap)` pure predicate (same testable shape as
  `isEmailSuppressedForDavid()`) checks the `to` address, lowercased,
  against a `Map<emailLower, status>` built from `ops_users`+
  `ops_admins`; only a roster member whose own status is literally
  `'inactive'` is suppressed — an address matching no roster member at
  all (inbound replies, backup recipients, client/external addresses)
  or an active member is sent as normal. The roster read itself
  (`getRosterStatusMap()`) uses a 30s TTL cache rather than the explicit
  per-request reset `api/ops-sync.js`'s own `_directoryCache`/
  `_notifSettingsCache` need (that file's own comment documents the real
  bug a forgotten reset caused) — `sendResendEmail()` has no single
  handler entry point of its own to reset from, so a short TTL instead
  amortizes the read across every send in one cron loop while still
  naturally expiring between invocations (every cron here runs minutes
  to hours apart). Fails OPEN on a roster-read error (logged via
  `logError()`, never thrown) — this is the single choke point every
  outbound email in the app goes through, so a broken roster read must
  never silently stop ALL sending, only ever risk under-suppressing.
  Flagged, not silently decided (rule #7): the Admin Controls "Send Test
  Email" diagnostic (`api/send-assignment-email.js`, no `recipientId`)
  was deliberately NOT given a bypass the way it has one for David/
  quiet-hours — the ticket asked for one uniform guard covering "any
  future" email path too, with no exceptions named, so an admin
  test-sending to an inactive person's own address will see it silently
  suppressed (`{ok:true}` with no `id`) same as any other path; not
  fixed since it's outside this ticket's stated scope. Verified with a
  new 8-check Node suite against the real, unmodified `sendResendEmail`/
  `isEmailSuppressedForInactiveUser` exports (fake in-memory Supabase
  client + a mocked `global.fetch` standing in for the real Resend API,
  no live access per rule #11): the pure predicate itself (case-
  insensitive match, active/external never suppressed); an inactive
  `ops_users` member suppressed with zero Resend API calls made; an
  inactive `ops_admins` member suppressed too; an active member and an
  external/unmatched address both still sent normally; a forced roster-
  read error still sends (fail-open); the TTL cache is proven to avoid a
  second DB read across 4 sequential sends in one test (the 4th read
  would hit a deliberately forced error if the cache weren't working);
  David-suppression and inactive-user-suppression compose correctly
  (both independently still fire, neither masks the other) — confirmed
  via `git stash` that 4 of these 8 fail against the pre-fix code. Also
  re-ran the full related regression surface clean (40/40 combined): the
  daily-reminder suite (7/7), the leave-aware-alerts e2e suite (5/5,
  using the current post-merge dynamic-recipient fixture set) and unit
  suite (10/10), the name-fallback suite (8/8), and the PTO-report
  ledger-merge suite (2/2) — confirming the new guard doesn't change
  behavior for any already-active recipient these suites exercise.
  `node --input-type=module --check` clean (per rule #9's module-mode
  addendum). No data writes (read-only roster lookup), no schema
  change, no migration.
- Urgent fix: #460 regression — unowned-service rejection blocked/alarmed
  on legitimate task saves (2026-10-14 — **merged**, PR #469,
  `api/ops-sync.js`+`user.html`): reported live — a member marking a task
  Done still saw `"❌ Not saved: not assigned to services item svc_X"`
  (even though the task itself persisted fine) whenever their local
  `wl_clients_db` held a stale copy of a service belonging to someone
  else on the SAME shared client record. #460's rollback scoping
  (`rejectedThis`, `table==='tasks' && id===this task`) was already
  correct; the actual bug was `cloudPushData()`'s own generic
  `"❌ Not saved: <reason>"` toast firing for ANY rejection in the batch,
  unscoped to what the caller cared about — plus the underlying client-
  write rejection was itself a false positive: `checkMemberClientWrite()`
  rejected the WHOLE client write the moment any item the member wasn't
  assigned to merely differed from the server's current value, whether
  or not the member ever touched it (routine staleness — another
  admin's edit, a cron due-date rollover — not an actual conflict with
  this member's own edit). Two-part fix: (a) `cloudPushData()` gains an
  optional `opts.onlyToastFor {table, id}` — wired into
  `_dtChangeStatus()`/`saveDtTaskUpdate()` — so the generic toast only
  fires for a rejection matching THIS write; every other existing caller
  keeps the original behavior. (b) Both layers: `user.html`'s
  `cloudPushData()` now trims each dirty client's services/
  recurringServices/locations[].services down to only the member's own
  items before it's ever sent (`_pushSafeClient()`); `api/ops-sync.js`
  gained `restrictClientWriteToOwnItems()`, run on every member client
  write BEFORE `checkMemberClientWrite()` and storage — every list item
  the member isn't assigned to (including one their payload omitted
  entirely) is pinned to the server's own CURRENT value, verbatim,
  regardless of what the incoming payload said, so the check only ever
  judges the member's own items and storage can never drift or silently
  delete an unowned one. A genuine attempt to edit/delete someone else's
  item is still completely ineffective — it just no longer collaterally
  blocks the member's own legitimate edit bundled in the same write. The
  server-side layer is what actually makes the write safe; the client
  trim is belt-and-suspenders. Verified with a 7-check Node suite against
  the real, exported `checkMemberClientWrite()`/
  `restrictClientWriteToOwnItems()`/`isAssignedToMember()` (pure
  functions, no Supabase needed per rule #11) — reproduces the exact
  reported rejection pre-fix, confirms the fix allows the write, an
  unowned item omitted entirely is restored not deleted, a genuine
  attempted edit to an unowned item is still ineffective but no longer
  blocks the member's own edit, a real scalar-key violation still
  rejects, franchise/location services get identical treatment — plus a
  3-scenario Playwright suite against the real `user.html`: no
  misleading toast even transiently (verified by recording every
  `showToast()` call, not just final DOM state), a genuine rejection of
  the edited task itself still rolls back + shows its reason, and the
  push body is confirmed to never include the unowned service.
  Confirmed via `git stash` both suites fail against the pre-fix code.
  `node --check` AND the newer module-mode `node --input-type=module
  --check` (rule #9) both clean on `api/ops-sync.js`; inline-JS syntax
  clean on `user.html`; div-balance unchanged vs. baseline (delta -1).
- Deleted tasks must stay deleted — whole-team task resurrection fixed
  (2026-10-20 — **merged**, PR #476, `api/`+`index.html`+`user.html`+
  migration): reported live — 2 whole-team/
  imported tasks (`assigneeIds` = all 8 members, `importBatchId`-tagged)
  kept reappearing after every delete, each time under a brand-new
  `ops_tasks.id` sharing the SAME base timestamp as the original "Everyone"
  commit (a tight synchronous `.map()` loop producing one `_taGenId()` call
  per roster member can share the same `Date.now()` millisecond — the
  "fresh random suffix, fixed base" signature in the evidence). Traced
  before guessing (rule #7) — NOT `commitStagedTasks()`/
  `_taBuildEveryoneClones()` (fires once, only on an explicit admin
  commit) and NOT `api/inbound-email.js`'s `createTasksFromParsed()`
  (already fully idempotent against webhook re-delivery via its own
  `alreadyProcessed(emailId)`/`markProcessed()` guard — investigated,
  confirmed not the mechanism, deliberately left untouched). REAL root
  cause: `_applyServerArray()`'s own "a dirty record the server doesn't
  have yet must not be dropped" branch (in BOTH `index.html` and
  `user.html` — hand-duplicated per rule #3) — present since this
  function's original design, built to protect a genuinely brand-new,
  not-yet-pushed local record, but with no way to distinguish that from a
  record that WAS confirmed by the server before and has since been
  deleted (by this tab, a sibling tab/device, or a cron) — this function
  runs on every poll (20s interval), the textbook rule-#2 violation
  ("compare local vs incoming on a timer, resurrect what you think is
  missing"), just never caught before because most tables don't have a
  realistic way for a deleted-but-still-locally-dirty record to exist on
  a DIFFERENT open tab. Fixed at the root, NOT tasks-specific (this
  function serves every table it's called for): the existing per-table
  snapshot (`_opsReadSnapshot()`/`snapById`) already distinguishes
  "never confirmed by the server" (no snapshot entry — genuinely new,
  still resurrected, unchanged) from "was confirmed, now absent" (WAS in
  a snapshot — correctly a deletion, never resurrected) — one added
  `!snapById.has(l.id)` condition on the resurrection branch in both
  files; `user.html` additionally gained its own `_opsReadSnapshot()`
  helper (it didn't track `snap` at all before, only `_opsDirty()` read
  it inline). `client.html` has the IDENTICAL latent bug (same resurrect-
  on-dirty-and-missing pattern, in its own hand-duplicated
  `_applyServerArray()`) but was NOT touched — it never syncs the `tasks`
  table at all, so it's out of this ticket's scope, confirmed not
  silently; flagged as a real, separate future risk (a deleted client,
  notification, or feed item could resurrect the same way).
  **Part 2 — durable, content-keyed tombstones** (defense-in-depth,
  survives ANY future re-creation vector, not just the one found above):
  new `ops_deleted_task_ids` table (migration
  `20261020120000_ops_deleted_task_ids.sql`, additive, idempotent, named
  columns like `ops_session_activity` — flagged deviation from the
  document-model convention — append-only via the existing
  `ops_block_mutations()` trigger). New exported
  `computeTaskDeleteKey(row)` in `api/ops-sync.js`:
  `importBatchId|subject|assigneeId`, returning `null` for a task with no
  `importBatchId` — deliberately scoped to imported/whole-team tasks only
  (the actual at-risk class); a plain one-off manually-created task has no
  importBatchId and nothing ever re-derives it from a template, so
  extending key-matching to free-form subjects would risk two unrelated
  future tasks colliding on common wording alone (flagged, not an
  oversight — rule #7). `assigneeId` included so deleting ONE team
  member's copy of a whole-team import tombstones only that copy, never a
  sibling still legitimately assigned to someone else from the same
  batch. Wired into `api/ops-sync.js`'s existing `c.tasks` write block:
  the hard-delete path (`tombstones.taskIds`) now fetches each row's
  content UNCONDITIONALLY before deleting (previously only fetched for a
  non-admin's own authorization check) and writes a tombstone for every
  deleted row that has a computable key, via `upsert` +
  `ignoreDuplicates` (safe to re-delete the same stable content); the
  fetch failing degrades to "tombstoning skipped this round," never to
  blocking the actual delete (fail-open, same discipline as every other
  best-effort secondary check in this codebase). The create path
  (`!cur`) now checks a NEW row's key (when it has an importBatchId)
  against both the tombstone table AND already-live `ops_tasks` content
  (closing requirement #4, "re-processing the same importBatchId must
  not create duplicates" — covers a double-click or a retried push, not
  just the original resurrection bug) — skips with a warning, never an
  error, on either match; the newly-created key is also added to the
  in-memory duplicate set immediately after a successful insert, closing
  the narrower intra-request gap (two duplicate rows staged in the SAME
  batch). `api/inbound-email.js`'s `createTasksFromParsed()` deliberately
  NOT given this same check — it has no importBatchId concept at all
  (computeTaskDeleteKey would always return null there), and its own
  emailId-based idempotency already covers its actual risk (webhook
  re-delivery) more precisely than a content-signature would. Verified
  with a new 11-check Node suite against the real, unmodified
  `handler`/`computeTaskDeleteKey` exports (fake in-memory Supabase
  client, no live access per rule #11): the pure key formula (null for
  no-importBatchId, stable+deterministic, assignee-scoped); deleting an
  imported task writes a correctly-keyed tombstone, a plain task writes
  none; the REAL incident reproduced directly (a resurrected clone under
  a brand-new id matching a tombstoned key is skipped) and a sibling
  clone for a different, never-deleted assignee from the same batch is
  NOT blocked; a double-commit of the same batch (different ids, two
  separate requests) only creates one copy, and so does a client-bug
  duplicate within a SINGLE request; an ordinary update to an existing
  task is completely unaffected; re-deleting the same stable content
  twice is a harmless no-op (no unique-constraint error, original
  tombstone preserved); a forced pre-delete fetch failure still lets the
  actual delete proceed (fail-open) — confirmed via `git stash` that 6 of
  these 11 fail against the pre-fix code. Separately, an 8-check Node
  suite (via a brace-matching extractor + a `localStorage` polyfill, no
  Playwright needed — pure sync logic, nothing visual) exercises the
  REAL, unmodified `_applyServerArray()` from both `index.html` and
  `user.html` directly: a task deleted server-side does not resurrect
  even when this tab's own copy is still "dirty"; a genuinely brand-new,
  never-synced local task is still preserved (the regression this logic
  exists for in the first place); a pending edit to a task the server
  still has (just stale) is completely unaffected; a table with no prior
  snapshot at all still trusts local fully — confirmed via `git stash`
  that the index.html resurrection check fails pre-fix, and that all 4
  user.html checks fail pre-fix for the correct underlying reason
  (`_opsReadSnapshot()` didn't exist there before this fix at all). 63
  checks total across both suites plus the full pre-existing regression
  surface (daily-reminder, leave-aware-alerts ×2, name-fallback,
  PTO-report, inactive-user-suppression, due-date-approval-lock) re-run
  clean. `node --input-type=module --check` clean on `api/ops-sync.js`
  (per rule #9's module-mode addendum); inline-JS syntax clean on both
  HTML files; div-balance delta 0 on both (pure `<script>` content
  changes, confirmed via diff — no HTML markup touched).
  **Merged by the repo owner directly on GitHub (2026-10-20 10:05 UTC)
  ahead of rule #12's own gate being confirmed** — this agent never
  confirmed the `ops_deleted_task_ids` migration as applied to
  production (still no live DB access, rule #11) before the merge
  happened; the owner opened PR #476 to "ready for review" and merged
  it themselves. Flagging this explicitly rather than silently treating
  it as fully closed: **the migration-applied + schema-drift-panel-
  shows-0-pending confirmation from rule #12 is still outstanding** and
  is a DB-operator action, not something this agent can do or verify
  itself. Practical exposure while it's outstanding is low, not zero —
  every new `ops_deleted_task_ids` read/write in `api/ops-sync.js` is
  wrapped to degrade to a warning on error (fails open), so a missing
  table does not block any task create/delete; it only means Part 2's
  tombstone defense-in-depth is inert until the table exists, while
  Part 1 (the actual root-cause `_applyServerArray()` snapshot-guard
  fix, which needs no new table at all) is fully live and effective as
  of this merge. **Still needed from the DB operator:** run the
  dry-run → apply → verify cycle for
  `20261020120000_ops_deleted_task_ids.sql` and confirm the Business
  Setup schema-drift panel shows 0 pending for `ops_deleted_task_ids` —
  only then is Part 2 actually active, and only then should the
  post-merge data cleanup below be done.
  Also re-verified post-merge, since the merge commit onto this branch
  (`main` → `fix/deleted-tasks-stay-deleted`) was itself a **merge**, not
  a rebase, pulling in PR #474's large same-day removal of the
  transcript-parse-import feature (258-line diff in `api/ops-sync.js`
  alone) — the exact action that caused PR #467's duplicate-declaration
  outage 6 days earlier. Confirmed clean this time: `computeTaskDeleteKey`/
  `ops_deleted_task_ids`/the `snapById` guard in both HTML files/the
  migration file/the schema-drift entry all survived with no duplication;
  `node --input-type=module --check` clean on all 4 touched `api/*.js`
  files; the full 63-check regression suite re-run clean on the merged
  head (`--experimental-test-module-mocks` is required for the suites
  using `mock.module` — a local invocation quirk, not a code issue);
  inline-JS syntax clean on all three HTML files; div-balance delta on
  `index.html`/`user.html` unchanged vs. `main`'s own baseline (-2/-1).
  **Data cleanup is a separate, POST-migration-apply DB-operator step**
  (per the ticket's own instruction): once the migration above is
  confirmed applied, delete the 3 currently-resurrecting rows
  (`task_1787933180295_wqc9hza`/`_rxoxisx`/`_m47ifdt`) and confirm they
  stay gone across a load/sync — doing this before the migration is
  applied risks the tombstone write itself failing (table doesn't exist
  yet), though Part 1's fix means they likely won't resurrect either way
  at this point. Also flagged, not fixed (out of this ticket's stated
  scope, noted in the ticket itself): a whole-team assignee list can
  include deactivated/on-leave users (Assmaa, Jacob) — worth a separate
  look at whether `_taBuildEveryoneClones()`'s roster
  source should filter to active-only.
- Urgent fix: members could not edit ANY self-assigned task
  (2026-10-15 — **merged**, PR #472, `api/ops-sync.js`): reported live —
  the server rejected every status edit on a self-assigned task with
  `"members cannot edit tasks.selfAssignedAt"`, blocking all 9 team
  members (659 tasks across them carry `selfAssignedAt`). Root cause:
  the member task-write branch rejected the WHOLE write the instant ANY
  `TASK_KEYS_MEMBER_MAY_NOT_TOUCH` field merely differed from the
  server's current row — including when the mismatch was pure
  staleness (the member's local cache hadn't seen a field like
  `selfAssignedAt` yet) rather than an actual attempted edit. Same
  false-positive class #469 fixed for client/service writes
  (`restrictClientWriteToOwnItems()`), now recurring on tasks. Fix:
  pin-not-reject, extended to task fields — new
  `pinMemberForbiddenTaskFields(cur, inc)`, run before the write is
  evaluated at all, forces every `TASK_KEYS_MEMBER_MAY_NOT_TOUCH` field
  to the server's own CURRENT value regardless of what the payload
  said; `dueDate` keeps its pre-existing fill-only rule (pinned to
  `cur.dueDate` only when already set, not a flat pin). A member still
  can NEVER actually change a protected field — always forced back to
  `cur`'s value — but staleness on one can no longer block or roll back
  a legitimate edit to an allowed field (status, notes) on a task
  that's theirs. Every `inc.*` reference downstream in the member
  branch now reads the pinned `safeInc` instead of the raw payload.
  `TASK_KEYS_MEMBER_MAY_NOT_TOUCH`/`pinMemberForbiddenTaskFields()` are
  now exported, matching #469's precedent. Verified with a 7-check Node
  suite: 3 direct unit tests on the exported pin function (own edit
  survives, every protected field pins to cur; a genuine attempted edit
  to a protected field is silently pinned, never applied; dueDate
  fill-only semantics preserved) plus 4 full end-to-end runs of the
  real, unmodified `handler()` against a real signed session token and
  an in-memory fake Supabase client (no live DB access, rule #11):
  reproduces + fixes the exact reported bug, a tamper attempt is pinned
  not rejected, the "not your task" ownership check is unchanged
  (regression guard), dueDate fill-only holds end-to-end. Confirmed via
  `git stash` the suite fails pre-fix. Per rule #9: both a bare `node
  --check` and the module-mode `node --input-type=module --check`
  clean.
- Notification sound turned off by default, with a persisted on/off
  toggle (2026-10-15 — **merged**, PR #473, `index.html`+`user.html`,
  display-only): reported as playing "constantly," even after reading
  all notifications. Traced before guessing (rule #7): the bell sound's
  trigger (`refreshAdminNotifBadge()`/`updateAssignmentsBadge()`) is a
  bare unread-COUNT comparison destabilized by a real, separate
  instability source — `api/ops-state.js`'s notifications query caps at
  the 200 most recent rows SYSTEM-WIDE, so a heavy recipient's own
  local notification window can churn between polls independent of
  anything they've actually read. Rather than chasing that triggering
  logic (a bigger, separate fix — real notification pagination, out of
  this ticket's scope), turned the sound OFF by default in both
  portals, with a persisted per-browser toggle. `index.html`: a new
  "Sound" checkbox next to "Mark all read" in the notif panel header
  (`wl_admin_notif_sound_enabled`, localStorage-only, never synced);
  `_playNotifBing()` gated on it alongside the existing gesture-unlock
  check. `user.html`: added to the existing local-only "🔔
  Notifications" settings panel — `getNotifSettings()`/
  `setNotifSettings()` gained a `sound` field (default `false`, same
  explicit-opt-in shape `dueSoon` already uses for its own opposite
  default). Bell icon/unread-count badge completely unaffected either
  way — only the sound itself is gated. Verified with a 9-check
  Playwright suite against the real files: sound defaults OFF (proven
  via a real `window.AudioContext` construction counter — a faithful
  proxy for "did a sound play," since `_playNotifBing()` only
  constructs one on an actual gate-passing attempt) while badges still
  update; toggling ON (both directly and via the real `user.html` form
  save path) lets exactly one sound play; both checkboxes start
  unchecked and persist via their real save paths; zero-JS-error load
  check across all three portals. Confirmed via `git stash` the suite
  fails pre-fix (sound played by default). No `api/*.js` touched (rule
  #9's module-mode check doesn't apply); div-balance unchanged on both
  files vs. baseline.
- Transcript paste/upload parsing-import feature removed, meeting-parse
  auto-update removed, inbound email kept fully working (2026-10-15 —
  held for preview approval, `index.html`+`user.html`+`api/`): mapped
  first (report-only, no code changes), then removed on explicit go-ahead.
  Removed: `index.html`'s "📝 Add / Import" Task Assignments sub-tab (the
  paste/upload UI, staging-review card, recent-imports list) and its JS
  (`_onTaParseFilesChosen`, `runTaskEmailParse`, `_taUpdateStaged`,
  `discardStagedTask`, `undoStagedImportBatch`, `commitStagedTasks`,
  `_taRecentImportBatches`/`renderTaRecentImports`, `_taStagedTasks`,
  `_taParseFileTexts`, plus the now-orphaned `undoCommittedImportBatch` —
  not explicitly named in the ticket but unreachable without the removed
  UI and sharing no other caller); new default Task Assignments sub-tab is
  "My Tasks" (`taSubtabMyTasksBtn` now carries the default
  `btn-toggle-active` class in the HTML itself, same mechanism "parse" used
  before — no JS reset-on-every-load added, so a sticky mid-session tab
  choice behaves exactly as before). `user.html`'s parallel "Add / import
  tasks" tab and its hand-duplicated JS
  (`_onDtParseFilesChosen`/`runDtEmailParse`/`_dtUpdateStaged`/
  `discardDtStagedTask`/`undoDtStagedImportBatch`/`commitDtStagedTasks`/
  `undoDtCommittedImportBatch`/`_dtStagedTasks`/`_dtParseFileTexts`) also
  removed — no replacement delete button added, per explicit instruction;
  this was already the member portal's only reachable path to the
  tombstones.taskIds member-delete permission (the general delete UI was
  already removed 2026-08-26), so member task deletion stays gone, as
  before this feature ever existed. `api/ops-sync.js`'s meeting-parse
  write/notify functions (`applyMeetingParseTaskStatusUpdate`,
  `fireMeetingParseNotifyEvents`, `resolveMeetingParseRecipients`) deleted
  outright. In `api/process-transcript.js`: deleted the
  existingItemMentions matching/gating logic (`matchExistingTask`,
  `activeServiceCandidates`, `matchExistingService`,
  `evaluateMeetingParseGate`, and the whole existingItemMentions block
  inside `parseTaskEmailForSession` that called them) and the
  existingItemMentions instructions/schema from the taskEmail system
  prompt. Deliberate, flagged deviation from the ticket's literal function
  list (rule #7): `isSameTask`/`subjectSimilarity`/`subjectTokens` were
  also named for removal, but investigation found they're shared with (a)
  `dedupeWithinBatch()` (collapsing duplicate mentions WITHIN one parse
  batch — core extraction, not matching-against-existing) and (b) the
  `mergeIntoId` computation in `parseTaskEmailForSession` that flags a
  newly-extracted task as a likely duplicate of an EXISTING open task —
  confirmed via direct reading of `api/inbound-email.js`'s
  `createTasksFromParsed()` that inbound email actively depends on
  `mergeIntoId` (skips re-adding a task flagged as a duplicate, reports it
  in the confirmation reply) — a completely different feature from the
  meeting-parse status-auto-update being removed. Kept all three
  functions; only the existing-item status-matching/auto-update consumers
  were deleted. `api/inbound-email.js` itself: confirmed **zero diff**
  (verified via `git diff --stat`) — still imports and calls
  `parseTaskEmailForSession` exactly as before; it keeps creating tasks
  from email exactly as before, it simply never again receives an
  existingItemMentions-driven auto-update (that capability no longer
  exists anywhere, not something inbound email opted out of). The separate
  "My Roadmap" transcript-paste feature (`rmExtractTranscript()`,
  `extractRoadmapTasks()`) was out of scope and is untouched — confirmed
  via grep it shares no removed symbol. `client.html` has zero dependency
  on any of this (confirmed clean via grep in the mapping step) — fully
  unaffected. Verified with a new 6-check Node suite against the real,
  unmodified `parseTaskEmailForSession()` (fake in-memory Supabase client
  + mocked Gemini fetch, no live access per rule #11): a brand-new task is
  still extracted with no existing tasks to match; the `mergeIntoId` dedup
  against an existing open task still works (the exact mechanism
  `inbound-email.js` depends on); a model response that still emits
  `existingItemMentions` (proving the code path is gone, not just the
  prompt instruction) triggers zero `ops_tasks` updates and zero
  notification inserts; `ops-sync.js` no longer exports the three removed
  functions; the removed function names no longer appear anywhere in
  `process-transcript.js`'s source while `isSameTask`/`dedupeWithinBatch`
  still do. Plus a 13-check Playwright suite against the real, live-served
  files (no import UI/buttons/inputs in either portal's DOM, the new
  default tab's active class, "+ New Task" still present in both) and a
  baseline-vs-branch console-error comparison on all three portals (same
  2 pre-existing network-only console lines on both `main` and this
  branch — confirms zero NEW JS errors introduced). `node --check` AND
  `node --input-type=module --check` (rule #9) both clean on all 4 touched
  `api/*.js` files (including `api/cron-overdue-check.js`, where only a
  stale comment referencing a removed function name was fixed — no
  behavior change); div-balance delta unchanged vs. baseline on both
  touched HTML files (index.html -2, user.html -1, matching `main`).
  `api/ops-sync.js`'s `insertNotifications()` `opts.directory` override
  mechanism (still used by `api/cron-overdue-check.js`) and its
  `meetingParseNotify` notification-type icon/label entries in
  `index.html` (still needed to render any already-existing historical
  notification rows of that type) were deliberately left in place — not
  dead code, just no longer fed by any new write. Held per rule #10 —
  touches `api/ops-sync.js`'s notification/write logic and
  `api/process-transcript.js`'s task-extraction logic, even though no
  schema/migration/auth change is involved.
- Overview top stat-card row: Overdue/Due Today now lead with SERVICES, not
  combined tasks+services (2026-10-20 — held for preview approval,
  `index.html`, display-only, additive): in
  `renderTeamProductionAnalytics()`, the Overdue/Due Today cards now show a
  SERVICES headline with a "+ N tasks" sub-line, instead of one number
  blending both. Headline numbers (`svcOverdueAllCount`/
  `svcDueTodayAllCount`) are computed directly over `allServices` — NOT
  `filteredServices` — reusing the exact two predicates Services-by-
  Urgency's own `svcUrgOverdue`/per-person due-today check already use
  (`_chSvcDueStatus(s)==='overdue'`; not done/not stuck + `s.due===
  todayStr`), deliberately independent of the `_ovSvcFreqFilter` frequency
  chips: the top cards are a global summary that sits ABOVE those chips, so
  switching the chip filter must never change them (verified live — see
  below). When the filter is 'all', `filteredServices===allServices`, so
  these equal Services-by-Urgency's own legend numbers by construction —
  the consistency the ticket required. Sub-line task counts reuse
  `totals.tasksOverdue` (already existed, feeds Tasks-by-Urgency's own
  overdue slice) and a new `totals.tasksDueToday` (added the same way
  `tasksOverdue`/`servicesOverdue` were already split out — each person's
  `tasksDueTodayItems.length` returned/summed alongside the existing
  `dueToday` combined field, which is otherwise untouched). Cards
  relabeled "Overdue · services"/"Due today · services"; new
  `urgencyStatCard()` helper reuses the exact same card markup/footprint/
  `onclick="openOvStatDrill(...)"` as the plain `statCard()` it replaces
  for these two cards — same drill-down modal, same combined tasks+
  services item list, unchanged. Tasks/Services/Blocked-Stuck/Team % Done
  cards, the 6-column grid, card order, and the calendar below are all
  byte-for-byte untouched. Verified with a new 20-check Playwright suite
  against the real, unmodified `renderTeamProductionAnalytics()` (fixture
  clients/tasks seeded straight into localStorage, no live Supabase per
  rule #11): the headline numbers match a deliberately UNASSIGNED overdue/
  due-today service (proving roster-independence, the same class of bug
  the 2026-09-25 Services-summary fix closed for the Services card);
  "+N tasks" matches Tasks-by-Urgency's own overdue legend row; both
  headline cards stay unchanged after switching the frequency filter to
  'yearly' (the fixture's services are 'monthly') while Services-by-
  Urgency's own legend correctly drops to 0 — proving the top cards are
  genuinely filter-independent and the existing donut is unaffected; the
  row stays exactly 6 cards at one uniform height; all 4 unchanged cards'
  labels still present; zero-JS-error load across all three portals.
  `node --check` on extracted inline JS clean; div-balance unchanged vs.
  baseline (delta -2). No `api/*.js` touched, so rule #9's module-mode
  check doesn't apply.
- Stop phantom assigned/submitted/done notifications (2026-10-23 —
  **merged**, PR #478, `api/ops-sync.js`+`index.html`, no migration): reported
  live — deactivated employee Assmaa (no session since Oct 5) was shown by
  email as having "submitted Training Time / New service page for review,"
  in bursts where the same item fired `assignment` + `submittedForReview` +
  `serviceDone` in the same second to multiple recipients. **The ticket's
  own attributed root cause did not hold up under direct code reading, and
  is flagged here rather than silently force-fit (rule #7):** it named
  `_taBuildEveryoneClones()` (index.html, `ops_tasks` "Everyone" whole-team
  task expansion) regenerating ids as feeding `collectServiceDoneEvents()`/
  `collectSubmittedForReviewEvents()` — but those two functions, confirmed
  by reading every call site, ONLY ever scan a CLIENT's `services[]`/
  `locations[].services[]` (`ops_clients`), a completely separate data
  model from `ops_tasks`; `ops_tasks` has no "done"/"submittedForReview"
  notification type at all (only `assignment`/`taskAssignment`), confirmed
  via a full grep of every `type: '…'` literal in the file. **Real,
  independently-verified mechanism:** any time the id-keyed current-vs-
  incoming diff these collectors run sees a service id it has never stored
  before (a genuinely brand-new service — e.g. an admin adding a new
  service entry to an EXISTING client while also logging its `lastDone`/
  assignees for already-completed historical work, the one live UI path
  that lets both be set in the same create — or any other future vector
  that could someday hand the server a never-before-seen id with
  pre-populated state), `prev` is `undefined`, so the old
  `prev?.lastDone`/`prev?.reviewSubmittedAt` reads as `undefined` and
  "transitioned" relative to any truthy incoming value — firing a done/
  review notification for something that never just happened, and (via
  `newlyAssignedServiceIds` treating every one of that brand-new service's
  `assigneeIds` as "newly assigned" since `prevIds` is empty) an assignment
  notification per assignee too — reproducing the exact reported
  multi-type, multi-recipient, same-second burst regardless of what put the
  stale/historical state on the new id. **Fix A** (`api/ops-sync.js`):
  `collectServiceDoneEvents()` (service-level AND its sub-item-level scan)
  and `collectSubmittedForReviewEvents()` now both require `prev` to exist
  before firing anything — a service/sub-item the server has never stored
  before is a (re)appearance, never a live transition, exactly matching the
  ticket's own prescribed requirement #2, applied to the subsystem that
  actually produces these two notification types. Assignment detectors
  (`collectServiceAssignmentEvents`/`collectSubitemAssignmentEvents`/
  `collectTaskAssignmentEvents`) are deliberately NOT guarded with `prev`
  — per the ticket's own explicit instruction, a genuinely new service+
  assignment should still notify its assignee. **Fix B**
  (`api/ops-sync.js`): `fireAssignmentNotifications()`/
  `fireOpsTaskAssignmentNotifications()` now skip generating a notification
  row entirely for a recipient whose own roster status is `'inactive'` —
  closes a gap PR #470 (2026-10-15) left open: that fix suppressed only the
  EMAIL half for an inactive recipient (`sendResendEmail()`'s own guard);
  the in-app bell/`ops_notifications` row for an assignment event still
  reached (named) a deactivated person. `fireServiceDoneNotifications()`/
  `fireSubmittedForReviewNotifications()` were deliberately left
  untouched — Fix A already eliminates every phantom firing of those two
  types outright, so there's no remaining live path where an inactive
  person's name would ride along as a false "just happened" actor. **Fix
  C — separate, independently-confirmed real bug, exactly matching the
  ticket's requirement #1's own given line number/code snippet**
  (`index.html`'s `_taBuildEveryoneClones()`): every clone past the first
  got a fresh `_taGenId()` on EVERY call — and this function re-runs on
  EVERY resave of an already-"Everyone" task (any edit — notes, status,
  priority — not just the initial conversion), not only once at creation.
  A fresh random id each time meant the server had never seen that id
  before, so `assigneeChanged(undefined, row)` read as a brand-new
  assignment and fired a spurious whole-team "assignment" notification on
  every unchanged resave. Investigating the caller
  (`saveTaskEdit()`'s Everyone branch) surfaced a second, more severe bug
  in the SAME code block, not named in the ticket: the non-first clones
  were unconditionally `tasks.push()`-ed on every resave with NO id-match
  check at all — so even before this fix, a resave didn't just regenerate
  ids, it silently DUPLICATED the entire whole-team clone set in local
  storage (and therefore `ops_tasks`) every single time, accumulating
  without bound. Fixed both together: `_taBuildEveryoneClones()` now
  builds a stable, deterministic id per clone (`${baseId}__${p.id}`,
  `baseId` computed once) so the SAME roster member always gets the SAME
  id across repeated expansions of the SAME task, and the caller now
  upserts each clone by id (find-and-`Object.assign`, push only if
  genuinely absent) instead of push-only — a resave of an unchanged
  Everyone task now correctly produces zero events and zero new rows,
  while a genuinely new roster member (a new hire) still gets a real,
  never-before-seen id and correctly fires one real notification.
  `_timeOffRoster()` (the roster `_taBuildEveryoneClones()` is always
  called with — confirmed its only call site, index.html ~12955) already
  filters both `ops_users`/`ops_admins` to `status==='active'` — verified,
  not fixed: this ticket's requirement #3 ("exclude inactive users from
  the everyone-clone roster") was already true before this ticket, no
  code change needed there. Requirement #4 ("no re-expansion on load/
  sync") also verified already true and unchanged:
  `_taBuildEveryoneClones()` has exactly one call site, inside
  `saveTaskEdit()`, triggered only by an explicit admin Save click —
  never from a load/poll/sync path. `client.html`/`user.html` confirmed
  (grep) to have neither this "Everyone" task-clone feature nor the
  service-event collectors at all — nothing to duplicate-fix per rule #3.
  Verified with a new 14-check Node suite: `collectServiceDoneEvents`/
  `collectSubmittedForReviewEvents` as pure unit tests (a first-seen
  service/sub-item with pre-set lastDone/reviewSubmittedAt/done fires
  nothing; a genuine transition on an already-known id still fires;
  resaving an unchanged already-done service still fires nothing) against
  the real, unmodified exports; the REAL reported incident reproduced
  end-to-end against the real handler (fake in-memory Supabase client, no
  live access per rule #11) — a brand-new service on an EXISTING client
  with lastDone/reviewSubmittedAt/assigneeIds=[active,inactive] already
  set fires zero serviceDone/submittedForReview rows and exactly one
  assignment row, to the active assignee only; a brand-new service
  assigned solely to an inactive person fires nothing at all; a brand-new
  service assigned to an active person still correctly fires (assignment
  is NOT guarded by prev, matching the ticket's own instruction); and,
  via a brace-matching extractor exercising the real, unmodified
  `_taBuildEveryoneClones()`/upsert logic from index.html directly (no
  Playwright needed — pure sync array logic, nothing visual): identical
  ids across repeated expansions of the same task, a new roster member
  still getting a fresh id, and — reproducing the actual duplicate-rows
  bug found during investigation — 3 resaves of an already-Everyone task
  converging to exactly 3 rows instead of accumulating to 12. Confirmed
  via `git stash` that 9 of these 14 checks correctly fail against the
  pre-fix code. Full pre-existing regression surface (task-resurrection,
  task-delete-tombstones, due-date-approval-lock, daily-reminder,
  leave-aware-alerts ×2, name-fallback, PTO-report,
  inactive-user-suppression) re-run clean — 77 checks total, 0 failures.
  `node --input-type=module --check` clean on `api/ops-sync.js`;
  inline-JS syntax clean on `index.html`; div-balance unchanged vs.
  `main` (delta -2, pure `<script>` content change — no HTML markup
  touched). Held per rule #10 — touches `api/ops-sync.js`'s real
  notification-firing logic.
- PWA installability added — "Option 1," no Capacitor/App Store
  (2026-10-25 — held for preview approval, all 3 HTML files +
  `manifest.webmanifest`+`sw.js`+`offline.html`+`assets/`, same Vercel
  static hosting, zero data/feature/auth-logic change): `start_url`/
  `scope` is `/` (resolves to `index.html`) — the only one of the three
  pages that routes every real account type with no dead end
  (`doLogin()`'s existing role branch already sends an admin to
  `_enterAdminApp()` and a plain member to `showUserApp()` from the same
  form); `user.html` explicitly rejects an admin login, and `client.html`
  has no login at all (always an iframe embed, per the "what this app
  is" section above) — existing role routing is unchanged, this just
  picks which door a installed-icon tap opens first. `theme_color`/
  `background_color` = `#256DB5` per the user's explicit final
  instruction (the authoritative, logo-sampled value — supersedes an
  earlier CSS-derived candidate considered mid-task). Icons
  (192/512/512-maskable/180 apple-touch) generated by plain RESIZE ONLY
  (Pillow/LANCZOS, no re-crop/re-pad/redesign) from two user-supplied
  1024×1024 source files committed to `assets/`
  (`icon-source.png` full-bleed → 192/512/apple-touch;
  `icon-maskable-source.png`, already safe-zone-padded → the one 512
  `purpose:"maskable"` icon) — flagged and asked rather than guessed
  when no clean, unedited crop boundary existed in the prior wordmark
  logo files (rule #7); user chose to supply a dedicated square source
  instead. `sw.js`: root scope (covers all 3 portals from one
  registration), versioned named caches, static-assets-only
  (`/api/*`, auth/sign-in routes, and every data payload are NEVER
  intercepted — the fetch handler explicitly skips any `/api/` path and
  all non-GET requests before doing anything else); `activate` deletes
  every stale-version cache; update flow is deliberately NOT
  auto-apply — `install` never calls `skipWaiting()`, so a new deploy
  sits WAITING until the page's own "🔄 Update available — tap to
  refresh" banner posts `'SKIP_WAITING'` and reloads once on
  `controllerchange`. Sign-out cache clearing wired into both portals'
  REAL, already-existing `logout()` by wrapping it
  (`window.logout = function(){ _pwaClearCachesOnSignOut(); return
  _pwaOrigLogout.apply(this, arguments); }`) — posts `'CLEAR_CACHES'` to
  the active SW and also deletes every cache directly from the page, so
  nothing cached survives a sign-out; the wrapped function still calls
  straight through to the original, unmodified sign-out logic
  (regression-verified). `offline.html` (branded, inline brand-palette
  CSS) is served by the SW only for a failed navigation — no offline
  data save/sync of any kind, per the task's own explicit scope limit.
  Install UI: `beforeinstallprompt` captured once and fired from a new
  "📲 Install" button (admin header, `user.html`'s own sidebar AND its
  real Profile page, `index.html`'s userApp sidebar) — hidden by default
  until the browser actually fires the event, never shown on a browser
  that won't install at all; a one-time dismissible iOS tip ("Tap
  Share, then Add to Home Screen," `wl_pwa_ios_tip_dismissed` in
  localStorage) shown only on a real iPhone/iPad/iPod `navigator.
  userAgent` match. `client.html` gets the manifest/meta/icon `<head>`
  tags only (no SW registration, no install UI, by design — it's never
  the installed entry point, and the two top-level pages' own
  root-scope SW registration already covers every request this file's
  iframe makes). Phone polish: `viewport-fit=cover` added to all 3
  pages' existing viewport meta; `env(safe-area-inset-*)` added to
  `body` (left/right) and `.sidebar`/`.admin-sidebar` (top/bottom) in
  all 3 files (resolves to 0px on a non-notched device — purely
  additive); a scoped `@media (max-width:480px)` rule forces `input,
  select, textarea, .form-input, .form-select` to 16px+ so Safari/
  Chrome on a phone never auto-zooms on focus, with desktop sizing (14px/
  12px) completely untouched. A real bug found and fixed during
  Playwright verification: the iOS-tip trigger was originally wired to
  `document.addEventListener('DOMContentLoaded', _pwaMaybeShowIosTip)`
  from a `<script>` placed near the end of `<body>` — which loses the
  race against an already-fired `DOMContentLoaded` and silently never
  ran; fixed in both files by calling `_pwaMaybeShowIosTip()` directly
  instead of listening for an event that's already past. Rule #3 applied
  throughout — every PWA script/CSS block is hand-duplicated per file
  (`index.html`/`user.html`/`client.html`), no shared module. Installability
  verified directly against Chrome's own engine (`Page.
  getInstallabilityErrors` via CDP) returning zero errors for both
  `index.html` and `user.html` — Lighthouse's CLI (v13.5.0) was tried
  first and found to have fully removed the `pwa` category (confirmed
  via both an explicit `--only-categories=pwa` rejection and a default
  run's category list), so CDP was used as the direct substitute, not a
  weaker one. No existing feature, data path, or auth/sign-in logic was
  touched anywhere in this change — verified via `node --check` on
  extracted inline JS (all 3 files) + `sw.js` directly (all clean);
  div-balance unchanged vs. baseline on all 3 HTML files (`index.html`
  -2, `user.html` -1, `client.html` 0 — identical before/after); a new
  42-check Playwright suite (manifest fields/icon reachability,
  `offline.html`/`sw.js`/apple-touch-icon reachability, per-page `<head>`
  wiring, real SW registration at root scope with zero pageerror
  exceptions, install-button hidden-by-default, iOS-tip show/dismiss/
  persist across reload under a real iPhone UA vs. never under a default
  UA, `logout()` still shows the login screen and hides adminApp exactly
  as before, 375px login-screen overflow, zero NEW JS errors across all
  3 portals vs. the same known pre-existing network-only lines every
  prior PR's own check this session already established) — all passing,
  confirmed stable across repeated runs once two real test-isolation
  issues were fixed (Chromium persists Service Worker registrations in
  a disk cache tied to the Playwright browser install itself, not
  scoped per `browser.newContext()` — fixed with explicit
  `getRegistrations()`→`unregister()`+`caches.keys()`→`delete()` cleanup
  at suite start and right after the one test that registers a real SW;
  `<head>` wiring checks were moved from DOM `$eval` queries to raw
  HTTP-response-text regex matching after occasional unrelated
  flakiness). This repo has no single pre-existing formal test-suite
  command to re-run as a baseline (every prior PR in this session built
  its own ad-hoc verification scripts the same way) — flagged rather
  than silently claimed, since the task asked to "run the existing test
  suite (confirm green)." Phone-width overflow scan (fixture-seeded,
  forced past login) found 2 overflowing screens, BOTH confirmed
  pre-existing on baseline `main` via `git stash`/`git stash pop`
  A/B-testing against the identical unmodified server (not a regression,
  not fixed, per the task's own "do NOT redesign, just LIST" instruction):
  `index.html` userApp/Operations @375px (≈335px overflow) and
  `user.html` Operations @375px (≈115px overflow). Held per rule #10 —
  touches `logout()` in both portals and ships a new root-scope
  service-worker network layer, even though no data write, schema
  change, or permission logic is involved.
- PWA Install button fixed on Android Chrome — listener registered too late
  (2026-10-26 — held for preview approval, `index.html`+`user.html`,
  display-only): reported live — tapping "Install" did nothing on mobile.
  Traced before guessing: the single `beforeinstallprompt` listener (added
  in the PWA PR, #480) lived in a `<script>` block near the very end of
  `<body>` — after ~17,000 lines of markup/CSS/JS had to parse and
  execute first. Chrome can fire `beforeinstallprompt` as soon as it
  decides a page is installable, which can happen before that point
  (especially on a repeat visit where engagement heuristics are already
  satisfied) — an event fired before any listener exists is gone for
  good for that page load, leaving `_pwaDeferredPrompt` permanently
  `null` and the tap a silent no-op. Fixed by moving the capture itself
  to a new, tiny script that is the literal first thing in `<head>`
  (before any CSS/other script) in both files: it only sets
  `window._pwaDeferredPrompt` and calls two optional callback hooks
  (`window._pwaOnPromptCaptured`/`window._pwaOnInstalled`) — it can't
  touch the DOM yet since the body hasn't parsed. The pre-existing
  bottom-of-body script (unchanged in spirit, still where the actual
  button elements get wired) now just registers those two hooks and
  checks `window._pwaDeferredPrompt` for an already-captured event on
  its own first run — covering the real race this bug was about: the
  event arriving in the gap between the two scripts, not only after
  both have run. `_pwaInstall()` now reads `window._pwaDeferredPrompt`
  fresh at tap time instead of a closed-over local, so it works
  regardless of which script captured it. iOS's own "Add to Home
  Screen" tip path (no `beforeinstallprompt` exists on iOS Safari) and
  the per-portal button markup/CSS are completely untouched — this is a
  pure JS-timing fix, no data/API/auth/sign-in path touched. Verified
  with two suites (no live Supabase access, rule #11 — not that this
  needed any): a 10-check pure-logic Node suite extracting the real,
  unmodified head-capture and bottom-wiring script bodies and running
  them through a minimal `EventTarget`-style stub in the exact order
  that matters (head script runs, event fires in the gap, THEN the
  bottom script finally runs) — confirms the event survives that gap,
  the button becomes visible once the bottom script catches up, and
  tapping Install actually calls `prompt()`; confirmed via `git stash`
  that this suite can't even run against the pre-fix code (the head
  script it extracts doesn't exist yet) — direct proof the fix is new,
  not a no-op. A 13-check Playwright suite against the real, live-served
  files confirms the end-to-end behavior (button shows after a
  dispatched event and tapping calls `prompt()`; `appinstalled` hides
  it again; the button stays hidden with no event at all; the iOS tip
  still shows on an iPhone UA, unaffected; zero new JS errors on load
  across all three portals). A real, pre-existing quirk of the
  already-merged PWA feature surfaced during this verification (not
  introduced by this fix, and not something this ticket's scope
  covers): a brand-new browser profile's first-ever page load registers
  `sw.js`, and once it activates and calls `self.clients.claim()`, the
  resulting `controllerchange` fires on that very page, triggering the
  existing one-time `location.reload()` — the test suite accounts for
  this by waiting for it to settle before asserting anything, but it is
  a real characteristic of real first-time visits too (one extra,
  automatic reload a few seconds after the very first visit, never
  again after that). `node --check` clean; div-balance unchanged vs.
  baseline on both files (`index.html` -2, `user.html` -1).
  **Follow-up, same PR (2026-10-26):** asked to confirm the employee
  portal specifically (`user.html` — the version most of the team uses)
  gets the same working Install button/iOS tip as the admin portal.
  Found a second, independent, real bug while confirming: 3 of the 4
  Install buttons across both files (the admin header button, the
  employee topbar button, the employee Profile-page button — every one
  EXCEPT `index.html`'s userApp sidebar button, class `su-btn`) also
  carry the generic `.btn` class (`display:inline-flex`), defined LATER
  in each stylesheet than `.pwa-install-btn{display:none}` — so by plain
  CSS cascade rules (equal specificity, later source wins), `.btn`'s
  rule silently won, making those 3 buttons **permanently visible**
  regardless of whether a real install prompt was ever captured, since
  before this fix existed at all (a second instance of the exact cascade
  class documented above for the `.sidebar` bug in the mobile-audit
  entry — same root mechanism, different rule pair). This is the inverse
  of what was asked to check for ("hidden because the prompt wasn't
  captured") but just as real a bug: the button looked tappable at all
  times, and tapping before a real prompt was captured was a silent
  no-op (`_pwaInstall()`'s own early-return already prevented a crash,
  but the UI falsely implied install was always available). Fixed with
  `!important` on both `.pwa-install-btn` rules in both files — makes
  this visibility gate immune to any future class combination, not
  dependent on getting stylesheet ordering right forever (a more durable
  fix than reordering again, since a new button variant could easily
  reintroduce the same class of conflict). Reverified clean: before any
  `beforeinstallprompt`, `getComputedStyle().display` is `none` for
  every one of the 4 buttons in both files (previously `flex`/
  `inline-flex` for 3 of them); after a real event, the employee
  portal's buttons correctly become visible and tapping correctly calls
  `prompt()`; the iOS tip still shows correctly with Install correctly
  absent. All 10 + 13 pre-existing checks re-run clean (23/23) — this
  CSS-only change doesn't touch any JS logic the earlier suites
  exercise. Screenshots captured for the employee portal specifically
  (Android Chrome: hidden-before/visible-after/Profile-page card; iOS
  Safari: tip shown, Install absent) and sent to the user directly (not
  embeddable in this file). `node --check` clean; div-balance unchanged
  vs. baseline on both files (same deltas as above — pure CSS change).
- Mobile-width layout audit (2026-10-26 — **merged**, PR #482,
  `index.html`+`user.html`, CSS/layout only, max-width media queries so
  desktop stays unchanged, no data/API/sign-in logic touched): audited
  every main screen at 360-430px (Playwright, fixture-seeded, forced past
  login) and fixed every overflow found.
  (1) **Per-Person Breakdown table** (`index.html` Overview) — its 7
  numeric columns spilled outside the card frame on phone. Turned into
  one stacked card per person at ≤480px via the classic CSS-only
  responsive-table-to-card technique (`thead{display:none}`, each `tr`
  becomes a bordered card, each `td` becomes a label/value flex row via
  `::before{content:attr(data-label)}`) — added `data-label` attributes
  to the existing row-template in `renderTeamProductionAnalytics()`
  (markup only, no logic change) and a `tpa-person-tbl` class on the
  `<table>` to scope the rule. Desktop table (>480px) is byte-identical.
  (2) **~335px overflow on Operations** (`index.html`'s embedded userApp
  AND `user.html`'s own Operations, both previously flagged) —
  root-caused to the embedded userApp's `.sidebar` (`index.html` only;
  `user.html`'s own `.sidebar` already had a working hamburger/off-canvas
  pattern at 768px, confirmed, not touched) being unconditionally
  `position:fixed;width:240px` with NO collapse at any width, while
  `.main`'s `margin-left:240px` left almost no room for content on a
  375px phone. Fixed by giving the embedded userApp's `.sidebar` the
  SAME hamburger-collapse pattern `.admin-sidebar` already uses
  elsewhere in this same file (same 900px breakpoint, same transform/
  transition/off-canvas behavior) — a real bug found and fixed during
  this work: the new media query was first placed BEFORE the plain
  `.sidebar`/`.main` base rules in the stylesheet, so by CSS cascade
  rules (equal specificity, later source order wins) the later plain
  rules silently won even when the media query's condition matched —
  moved it to directly after those base rules (mirroring exactly where
  `.admin-sidebar`'s own working media query already sits relative to
  its base rule) to fix it for real. A second, independent cause on
  BOTH files' Operations screen: `.ops-grid`/`.ops-grid-3` (Today's
  Pulse + Chain of Command, 2-3 columns) never collapsed to one column
  at phone widths, squeezing Chain of Command's fixed-width icon+text
  rows into a track too narrow to fit — fixed with one column at
  ≤600px + `min-width:0` on grid children, hand-duplicated in both
  files (rule #3). `.profile-grid` (Profile page, both files) had the
  identical 2-column-never-collapses issue, fixed the same way,
  hand-duplicated. A remaining ~17px overflow surfaced only at 360px on
  `user.html`'s topbar (help/notif/avatar/Sign Out already compacted at
  768px, still too wide as one row at the narrowest tested width) —
  fixed by letting it wrap onto a second line at ≤400px
  (`flex-wrap:wrap`) rather than hiding any control or redesigning.
  Verified at 360/375/414/430px via a new Playwright audit script
  against the real, live-served files (every listed screen force-shown
  past login, `document.documentElement.scrollWidth` vs `window.
  innerWidth`, plus an offending-element dump when non-zero): zero
  horizontal overflow on every screen at every tested width after the
  fix, confirmed via `git stash`/`git stash pop` A/B testing that each
  fix's own screen genuinely overflowed before and doesn't after (the
  Per-Person table's `before` screenshot shows the real pre-fix
  cut-off "OVERD..." column; the userApp Operations `before` screenshot
  shows the real pre-fix sidebar eating ~2/3 of a 375px viewport with
  content cut off on the right) — before/after screenshots at 375px
  captured for both. Desktop (1440px) computed styles confirmed
  byte-identical before/after (`.sidebar{transform:none}`,
  `.main{margin-left:240px}`, hamburger `display:none`). Zero JS errors
  on load across all three portals at 375px. `node --check` clean on
  extracted inline JS (both files); div-balance unchanged vs. baseline
  (`index.html` -2, `user.html` -1). `client.html` audited too (no
  login, iframe-embedded) — zero overflow found at any tested width,
  nothing to fix there. Held per rule #10 — broad-reaching CSS, several
  screens touched across two portals, even though no data/logic path is
  involved.
- Admin Time Off list sort fixed — pending-first, newest-first within
  group (2026-10-26 — held for preview approval, `index.html`, display-
  only, no data mutation): reported live — a request submitted today
  appeared in the middle of the list instead of with the newest.
  `renderAdminTimeOff()` rendered `requests.filter(...)` directly with
  no sort at all — list order was just whatever order
  `wl_timeoff_requests` happened to be stored/synced in (effectively
  insertion order), confirmed via a live reproduction. Fixed with a
  pure display-time sort: pending requests always first (they need
  action), then within each status group newest `submittedAt` first
  (falling back to `createdAt` for a row somehow missing it, though
  every current write path — `submitAdminMyTimeOffRequest()` and the
  employee-side equivalent in `user.html` — only ever sets
  `submittedAt`). Mirrors the exact sort shape `renderAdminMyTimeOff()`
  already uses correctly for the admin's own request history
  (`.sort((a,b)=>new Date(b.submittedAt||0)-new Date(a.submittedAt||0))`)
  — same recency direction, just with the pending-first grouping added
  on top since this list (unlike that one) shows every status mixed
  together with no separate pending/history sections to sort
  individually. The underlying `requests[]` array and `wl_timeoff_
  requests` storage are completely untouched — only the rendered
  `filtered` array is a new, sorted copy (`[...filteredUnsorted].sort
  (...)`), so the existing status-filter dropdown, approve/deny
  buttons (which still operate on `r.id` from the original unsorted
  `requests[]`), and every other reader of `wl_timeoff_requests` are
  unaffected. Originally flagged, not fixed (out of this ticket's
  initial explicit scope — "admin portal" only): `user.html`'s own
  `renderMyTimeOff()` (an employee's "My Requests History" card) had
  the identical no-sort bug — **since fixed in a same-PR follow-up, see
  below.** Verified with a new 9-check Playwright suite against
  the real, unmodified `renderAdminTimeOff()` (fixture-seeded via
  `localStorage`, no live Supabase per rule #11): a 7-row fixture with
  deliberately scrambled submittedAt/status order renders in the exact
  expected pending-first/newest-first order, including the `createdAt`
  fallback for a row with no `submittedAt`; the existing status filter
  (`to-filter-status`) still works and its filtered subset is still
  correctly sorted; the underlying `wl_timeoff_requests` storage order
  is proven byte-identical before/after (display-only); zero JS errors
  on load across all three portals — confirmed via `git stash` that 2
  of these 9 checks (the two directly asserting the fixed order) fail
  against the pre-fix code, reproducing the exact reported bug (raw
  insertion order). `node --check` clean; div-balance unchanged vs.
  baseline (delta -2). Held per rule #10 out of caution even though
  this is purely sort/display with no data write — touches the same
  render function the approve/deny buttons live inside.
  **Follow-up, same PR (2026-10-26):** asked to apply the identical
  sort to `user.html`'s own `renderMyTimeOff()` ("My Requests History")
  for consistency across both portals — hand-duplicated per rule #3,
  same pending-first/newest-first/`createdAt`-fallback shape, same
  display-only guarantee (`[...myRequestsUnsorted].sort(...)`, original
  `all`/storage array untouched). Verified with a new 8-check
  Playwright suite against the real, unmodified `renderMyTimeOff()`: an
  8-row fixture (7 for the signed-in employee, scrambled submittedAt/
  status order, 1 for a different person) renders exactly 7 rows in the
  correct pending-first/newest-first order including the `createdAt`
  fallback, the other person's row correctly excluded (the existing
  `userName` filter is unaffected by the sort), storage order proven
  untouched, zero JS errors across all three portals — confirmed via
  `git stash` that 2 of these 8 checks fail against the pre-fix code,
  reproducing the same raw-insertion-order bug on this portal too. Both
  suites (index.html's 9 + user.html's 8, 17 total) re-run together
  clean with both fixes in place. `node --check` clean on `user.html`;
  div-balance unchanged vs. baseline on both files.
- Member's own Time Off status stuck on "Pending" after admin approval —
  a missing re-render, not a merge-protection bug (2026-11-02 — held for
  preview approval, `user.html` only, no data-model/server change, no data
  writes): reported live — admin approved Michael's PTO (`to_1790261075219`,
  single correct DB record, `status:'approved'`, no duplicate), but his own
  "My Requests History" kept showing PENDING. Investigated the given
  hypothesis directly rather than assuming it (rule #7): traced
  `_applyServerArray('timeOffRequests', ...)` (called from
  `cloudFetchUsers()`) and its `_opsDirty()` dirty-protection guard end to
  end — a time-off request is only ever written once, at creation
  (`submitTimeOffRequest()`); nothing in this file ever mutates it again
  after that, so its local copy and its last-pulled snapshot are identical
  by the time an admin acts on it, meaning `_opsDirty()` correctly reports
  it as NOT dirty and `_applyServerArray()` takes the server's current
  status normally — confirmed directly with a fixture (a pending request
  whose snapshot already matches local, fed a server response with
  `status:'approved'`) that the merge lands `'approved'` into
  `DB_KEYS.timeOffRequests` with no change needed to the dirty-protection
  logic at all. **Real root cause:** the two places that actually fetch
  fresh server data while the member has the Time Off tab open — the
  section-open handler (`showSection('timeoff')`) and the 20s background-
  stats tick's own `sec-timeoff`-active branch — both call
  `cloudFetchUsers()...then(renderMyTimeOffLedger)`, re-rendering only the
  balance/ledger card. Neither one also calls `renderMyTimeOff()` (the "My
  Requests History" list that actually shows the status pill), unlike
  every other section's own pull-reaction (`renderDailyTasks()` for
  dailyTasks, `_cdReloadData()` for clientDirectory, etc., all gated the
  same `if(...'active')` way). The data was correct in storage the whole
  time; the visible list simply never got told to redraw — explaining
  exactly why nothing short of a full reload (which calls `renderMyTimeOff()`
  fresh on login) ever showed the real status. Fixed by adding the missing
  call at both sites: `cloudFetchUsers(...).then(()=>{ renderMyTimeOff();
  renderMyTimeOffLedger(); })`. Members still cannot write
  `status`/`reviewedBy`/`reviewedAt`/a denial reason themselves (no UI path
  ever existed for that) — this is purely "show what the server already
  sent," no permission/write-path change. Verified with two Node+Playwright
  suites against the real, unmodified `user.html` (served statically, no
  live Supabase per rule #11): a direct-call suite proving the merge itself
  is NOT the problem (a fixture pending request's local copy already
  matches its own snapshot, so it's correctly treated as non-dirty and the
  server's `'approved'` lands in storage, yet the DOM right after that pull
  stays PENDING until an explicit `renderMyTimeOff()` call) and a full
  end-to-end suite exercising the REAL `showSection('timeoff')` path and
  the REAL 20s background-tick closure (captured via a `setTimeout` wrapper
  installed before page load, identified by its own source rather than
  hand-duplicated, then invoked directly) against a mocked, deliberately
  delayed (250ms) `/api/ops-state` response standing in for real network
  latency — both call sites now show APPROVED without any re-login;
  confirmed via `git stash`/`git stash pop` that both fail against the
  pre-fix code (while the underlying stored status is `'approved'` even
  pre-fix, proving the merge was never at fault) and pass clean after.
  `new Function()` parse check on every extracted inline `<script>` block
  clean; div-balance unchanged vs. baseline (778/779 — pure JS edit, no
  HTML touched). No `api/*.js` file touched, so rule #9's module-mode
  check doesn't apply. Held per rule #10 out of caution even though this
  is a pure read/render fix with zero data writes — touches the member's
  own live sync-and-render path.
- Member-created tasks saving with a blank `assigneeName` for `u_<timestamp>`-
  id members (2026-11-02 — held for preview approval, `user.html` only, no
  data-model/server change): reported as 234 production rows with a correct
  `assigneeId` but a blank `assigneeName`, specifically for auto-generated
  `u_<timestamp>` member ids (Rana `u_1783926410583`, Michael
  `u_1783268590854`) and not for human-readable ids (sherine, abby),
  allegedly making those tasks invisible on the member's own My Tasks page.
  Investigated rather than force-fitting the given hypothesis (rule #7):
  `user.html`'s `saveNewDtTask()` ("+ New Task," the only member-create
  path, no assignee picker — always self) never stamped `assigneeName` at
  all, for ANY member, id shape irrelevant — it only ever sent `assigneeId`/
  `assignedById`, relying entirely on `api/ops-sync.js`'s
  `resolveAssigneeName()` (already present since 2026-09-04) to fill it in
  server-side from a fresh roster lookup by id. That resolver was already
  correct for both id shapes (a plain `users.find(u=>u.id===assigneeId)`
  against `ops_users` rows keyed by that exact id — no name-shape-dependent
  logic anywhere in it) and is a fallback-fill only, never a retroactive
  backfill of already-stored rows — which is why any of the 234 rows
  created before 2026-09-04 stay blank forever by design. Also confirmed
  `_dtMyTasks()` (My Tasks' own data source, since 2026-09-25) already
  matches by `assigneeId` only, never by name, and the list's row markup
  (`_renderDtListTable()`) renders the assignee pill from `currentUser`
  directly, never from the stored `t.assigneeName` — so a blank stored name
  was never actually capable of hiding a task from this page for EITHER id
  shape, confirmed with a fixture task carrying `assigneeId:
  'u_1783926410583', assigneeName: ''` that rendered correctly with no code
  change. The one real, narrow gap against the two-part ask: STEP 2a
  ("on create, ALWAYS stamp assigneeName from the member's own session/
  profile") wasn't actually happening client-side — fixed by adding
  `assigneeName: currentUser?.name||''` to the pushed task object in
  `saveNewDtTask()`, so the local/optimistic row (and therefore the synced
  row) always carries the correct name immediately, independent of the
  server fallback. STEP 2b ("match/show by assigneeId, not only
  assigneeName") needed no change — already true. Verified with a new
  Playwright suite against the real, unmodified `user.html`: a fixture
  pre-existing task (blank `assigneeName`, `assigneeId: 'u_1783926410583'`,
  signed in as that same id) renders in My Tasks with zero code change;
  calling the real `saveNewDtTask()` as that same u_-id member produces a
  new task with `assigneeName` correctly set to the session's own name and
  the task visible in the list immediately, with zero page errors —
  confirmed via `git stash`/`git stash pop` that the new-task assertion
  (only) fails against the pre-fix code (`assigneeName` key entirely
  absent), while the pre-existing-task-renders assertion already passed
  pre-fix, isolating exactly what changed. `node --check`-equivalent
  (extracted inline JS, `new Function()` parse) clean; div-balance
  unchanged vs. baseline (778/779, no HTML touched — JS-only edit).
  `api/ops-sync.js` read but not modified (already correct; no live
  Supabase access available per rule #11, so its behavior was verified by
  code reading plus the client-side fixture above, not a live write). Held
  per rule #10 — touches the member task-creation write path even though
  the change is additive (one new field, no existing field altered).
- Automatic pruning added for the four disposable log tables
  (2026-11-04 — held for preview approval + the user's own dry-run,
  `supabase/migrations/`+`index.html`+`user.html`, no new table/column —
  see rule #12, this agent cannot confirm a migration applied without live
  DB access per rule #11): `ops_session_activity`, `ops_feed`,
  `ops_error_log`, `ops_notifications` all accumulated rows indefinitely —
  a one-time manual purge had already cleared the backlog by hand; this is
  what stops it recurring. New migration
  `20261104120000_ops_prune_logs.sql`: `ops_block_mutations()` (guards
  `ops_feed`/`ops_session_activity`) and `ops_error_log_archive_guard()`
  both get a single sanctioned bypass — they only skip their usual
  raise-exception/archived-at-only enforcement when the current
  transaction has `current_setting('ops.allow_prune', true) = 'on'`; every
  other UPDATE/DELETE is blocked exactly as before, unchanged. The ONLY
  place that ever sets this flag is a new `SECURITY DEFINER` function,
  `ops_prune_logs()`, via `set_config('ops.allow_prune','on', true)` — the
  `true` third argument gives it `SET LOCAL` semantics, so the bypass
  reverts automatically at the end of that function's own transaction and
  can never leak into a later, unrelated statement on a reused connection.
  `ops_prune_logs()` does nothing else — no seeding, no updates, no
  load-time call site anywhere. Retention: `ops_session_activity` >7
  days; `ops_feed` >45 days OR a `'nav'`/`'login'` event of any age
  (`coalesce(data->>'type', data->>'kind', '')`); `ops_error_log` >30
  days; `ops_notifications` read (`data->>'read'` in `'true'`/`'1'`/`'t'`
  — the exact string forms this app's own JSON serialization produces)
  AND older than 3 days — an unread notification is never deleted
  regardless of age. Scheduled weekly via `pg_cron`
  (`cron.schedule('ops-prune-logs', '0 9 * * 0', ...)`, Sundays). Flagged,
  not silently decided (rule #7): pg_cron has no per-job timezone
  parameter on Supabase's hosted setup — `09:00 UTC` is exact for "4am ET"
  only during EST (roughly Nov–Mar) and one hour late during EDT, the same
  DST-drift class CLAUDE.md's own "Cron / utcHour lockstep" lesson already
  documents for Vercel's crons; not worth real timezone-aware gating logic
  for a low-stakes weekly maintenance job. Also flagged at the time: this
  migration's 3-day/read window for `ops_notifications` is strictly
  tighter than `api/cron-prune-notifications.js`'s separate, older
  30-day/read Vercel cron, making that older job a harmless, always-empty
  no-op rather than broken — deliberately NOT removed in this same PR (one
  feature per PR); **removed in a follow-up PR the same day, see
  below.** Source-side fix, so the noise never re-accumulates: removed
  every `logActivity('nav', ...)`/`logActivity('login', ...)` call site in
  both `index.html` (member/admin sign-in, the `window.showSection`
  nav-logging patch — deleted outright, it had no other purpose) and
  `user.html` (first-login password-set, `logout()`, `showSection()`'s own
  inline nav log) — `client.html` has neither call (confirmed via grep,
  nothing to touch there). Session/"time in app" tracking is unaffected —
  that's `api/session-ping.js` writing `ops_session_activity` directly,
  never routed through `logActivity()`/`ops_feed` at all. Flagged, not
  fixed (out of this ticket's scope): the admin Live Feed's "Logins"
  stat/filter dropdown option (`index.html`, `LIVE_FEED_USER_ACTIVITY_
  TYPES`, `feed-stat-logins`) will now only ever show historical rows
  until those age out under the 45-day/pruned-immediately rule above, then
  permanently read zero for anything going forward — the UI itself was
  left untouched since removing it is a separate, more visible product
  decision this ticket didn't ask for.
  Verified locally against a real, throwaway PostgreSQL 16 instance (this
  agent has no live Supabase access, rule #11, so this is the strongest
  verification available short of the user's own dry-run) — extracted the
  real, unmodified trigger/table definitions from this repo's own already-
  applied migration files, applied this migration's guard/function SQL on
  top (everything except the `create extension pg_cron`/`cron.schedule`
  lines themselves, since the `pg_cron` extension isn't installed in this
  sandboxed environment — flagged, not silently skipped): confirmed an
  ordinary DELETE on `ops_feed` is still blocked with no bypass active
  (negative control); running the real `ops_prune_logs()` against a mixed
  fixture (old/new rows, `nav`/`login`/other feed events, all three `read`
  string forms, an old-but-unread notification) deletes exactly the rows
  each retention rule says and nothing else; the bypass is confirmed to
  revert immediately after — the very next statement's ordinary DELETE on
  `ops_feed` is blocked again; `ops_error_log`'s existing archived-at-only
  update path and its DELETE-is-never-allowed rule are both confirmed
  completely unaffected; a low-privilege role granted ONLY `EXECUTE` on
  `ops_prune_logs()` (no direct table grants at all) successfully runs the
  full prune via that one function call, while a direct `DELETE` from that
  same role on any of the four tables is still denied — proving
  `SECURITY DEFINER` is actually doing real work here, not redundant.
  `node --check`-equivalent (extracted inline JS, `new Function()` parse)
  clean on both touched HTML files; div-balance unchanged vs. baseline on
  both (2199/2201 `index.html`, 778/779 `user.html` — no HTML markup
  touched, pure JS removals). **Still needed before this can merge** (per
  rule #12 and this task's own explicit instruction): the user's own
  dry-run of the prune counts against the real Vercel preview/production
  data (a read-only `select count(*) ... where <same condition>` per table,
  no `ops_prune_logs()` call, is the safe way to preview this without
  actually deleting anything), confirming the migration is applied to
  production, and the Business Setup schema-drift panel showing 0 pending
  (though this migration adds no new table/column, so drift exposure here
  is low) — none of which this agent can do itself without live DB access.
- `api/cron-prune-notifications.js` removed, its own PR
  (2026-11-04 — held for preview approval, `api/`+`vercel.json`, no data
  write of its own — a deletion): explicit follow-up to the entry directly
  above, which deliberately left this older cron in place as a harmless,
  always-empty no-op rather than remove it in the same change. Deleted the
  file outright and its `vercel.json` cron entry (`"0 10 * * *"`); grepped
  for any remaining reference afterward — none, other than this file's own
  historical write-up above (left as-is, it's the record of why this
  existed and why it's gone now, not a live reference). `ops_prune_logs()`
  (the pg_cron job from the entry above) now fully covers
  `ops_notifications` retention — strictly tighter (3 days vs. 30), same
  `read`-required condition. `vercel.json` confirmed still valid JSON
  after the edit. No other file referenced this endpoint. Held per rule
  #10 out of caution even though this is a pure deletion with no new
  logic — removes a scheduled job that was itself a new-automated-write-
  path per rule #13 when it was added.
- Misleading "❌ Not saved" toast on clearing notifications fixed —
  pin-not-reject extended to client scalar fields (2026-11-05 — held for
  preview approval, `api/ops-sync.js`+`user.html`): reported live —
  clearing/reading notifications (`markAssignNotifRead()`) pushed via the
  generic debounced `_scheduleCloudPush()`, which flushes the member's
  WHOLE local cache in one request; a client record whose admin-only
  scalar field (e.g. `logo`) had merely drifted vs. the server (another
  admin's unrelated edit, not anything this member touched) got
  `checkMemberClientWrite()`'s old flat reject-the-whole-write rule,
  surfaced via a scary "❌ Not saved: members cannot edit client.logo"
  toast completely unrelated to what the member actually did. Same
  false-positive class #469 (`restrictClientWriteToOwnItems()`, list
  items) and #472 (`pinMemberForbiddenTaskFields()`, tasks) already fixed
  — extended here to client scalar fields, the one remaining instance of
  "a merely-stale field blocks/alarms on an unrelated write." New exported
  `pinMemberForbiddenClientFields(cur, inc)` forces every
  `CLIENT_SCALAR_KEYS_MEMBER_MAY_NOT_TOUCH` field to the server's own
  CURRENT value, applied at the one real call site right alongside
  `restrictClientWriteToOwnItems()`, BEFORE `checkMemberClientWrite()`
  ever sees the payload. `checkMemberClientWrite()`'s own scalar-field
  reject loop was removed outright (not kept as now-dead code) — same
  precedent as `pinMemberForbiddenTaskFields()`, which fully replaced
  (not duplicated) the equivalent task-field reject loop in 2026-10-15.
  A member still can NEVER actually change one of these fields (always
  pinned back to `cur`), but a merely-stale copy of one can no longer
  block or alarm on an unrelated write. The genuinely-unowned-list-item
  protection (`restrictClientWriteToOwnItems()`, franchise/location
  structural checks) is completely untouched — a real attempt to edit
  someone else's service, or rename/add/remove a franchise, is still
  exactly as ineffective/rejected as before. Second part:
  `cloudPushData()`'s `opts.onlyToastFor` (#469, 2026-10-14) gained an
  optional-`id` mode — `{table}` alone now scopes the toast to that whole
  table (any other table's rejection stays silent), not just one `{table,
  id}` record — and `markAssignNotifRead()` now pushes via
  `cloudPushData({onlyToastFor:{table:'notifications'}})` instead of the
  generic debounced `_scheduleCloudPush()`, so a client-write rejection
  bundled into the same flush never surfaces here regardless of which
  client/field it was about. Verified with a 6-check Node suite against
  the real, unmodified `pinMemberForbiddenClientFields()`/
  `checkMemberClientWrite()`/`restrictClientWriteToOwnItems()` exports
  (pure functions, no live Supabase needed per rule #11 — a stub
  `@supabase/supabase-js` package was added to `node_modules` ONLY for
  this local run, since importing `api/ops-sync.js` at all pulls in
  `lib/supabaseAdmin.js`'s top-level import; removed immediately after,
  never committed, `node_modules/` is gitignored): a drifted `logo` pins
  to `cur` and a genuine attempted edit to it is still ineffective; a
  field NOT in the forbidden list passes through completely untouched;
  the exact reported drifted-field scenario now passes
  `checkMemberClientWrite()` end-to-end; unowned-service and franchise-
  rename structural rejections are both confirmed still intact,
  unaffected by this change. Plus a Playwright suite against the real,
  unmodified `user.html` reproducing the exact reported bug end-to-end
  (a stale, dirty `logo` client record + an unread notification, a mocked
  `/api/ops-sync` returning the real rejection shape): zero toast fires
  and the notification still correctly clears — confirmed via `git stash`
  that this exact scenario DOES show the misleading toast against the
  pre-fix code (while the notification still clears either way, same as
  today — this was never a "did it save" bug, only a false-alarm one).
  `node --check` AND `node --input-type=module --check` (rule #9) both
  clean on `api/ops-sync.js`; inline-JS syntax clean on `user.html`;
  div-balance unchanged vs. baseline (778/779 — pure JS edit, no HTML
  touched). Held per rule #10 — touches `api/ops-sync.js`'s real
  member-write validation logic, even though the change only widens
  what's tolerated, never what's permitted.
- Documented email-task format ("Name: task, due <date>") now a hard,
  deterministic contract — `Name:`/`Name —` lines guaranteed to assign
  (2026-11-06 — held for preview approval, `api/process-transcript.js`
  only): reported live — a real email to `task@opshub.wlmsend.com`
  assigning a task to Jacob Joslin via the exact documented format parsed
  but came through with no assignee. **Root cause, investigated per rule
  #7 rather than guessed**: `matchOwner()`/`matchOwnerWithAlias()`/
  `activeRoster()`/`resolveTaskOwners()` are all correct on their own
  terms — read every one end-to-end, nothing wrong with the matching
  logic itself. The real gap: EVERY one of them only ever operates on
  whatever string the MODEL put in a task's `ownerName` field; nothing in
  this file ever independently inspects the raw input text's own
  structured markers. `buildTaskEmailSystemPrompt()`'s own instructions
  already tell the model to treat a `Name:`/`Name —` line as at least as
  strong a signal as prose, but that's a prompt instruction, not an
  enforced guarantee — a single real LLM miss (confirmed: Jacob's line
  came back with an empty `ownerName` despite following the format
  exactly) silently breaks the "always works" promise given to the team,
  since there was no deterministic fallback checking the text itself.
  **Fix**: new `extractLeadingNameLines(text, roster)` scans the raw input
  directly (independent of anything the model returned) for a line
  matching a leading `Name:` or `Name —` marker (deliberately NOT a bare
  hyphen, to avoid a false match on a hyphenated word starting a sentence)
  whose name resolves via the SAME `matchOwnerWithAlias()` exact-or-
  unambiguous-first-name rule (plus the Sarah alias) every other owner-
  match in this file already uses — no second, looser matching standard.
  New `deterministicOwnerOverride()` correlates each model-extracted task
  back to a qualifying line via word-set containment
  (`subjectMatchesLeadingLine()` — every significant word in the model's
  own concise `subject` must appear in that line's fuller task text, the
  natural relationship between a summary and what it was compressed
  from), and only overrides when exactly one person is named across every
  qualifying line (two different qualifying lines naming two different
  people is genuinely ambiguous and left to the model's own ownerName,
  same "never guess" conviction `matchOwner()` itself already has for a
  duplicate first name). Wired in right before `resolveTaskOwners()`,
  **REGARDLESS of what the model itself returned for ownerName** — not a
  fallback for only the empty case, per the explicit ask — but skipped
  entirely for an explicit `groupOwner:true` task, so "the group"/"the
  team" co-assignment is completely untouched. `api/inbound-email.js`
  (the real `task@`/`service@` webhook handler) calls this exact function
  directly — confirmed via grep — so this closes the gap on the actual
  production path that failed, not just the UI's own parse endpoint.
  Verified with a 6-check Node test-runner suite against the real,
  unmodified `parseTaskEmailForSession()` export (a fake in-memory
  Supabase client + `node:test`'s `mock.module` for `lib/supabaseAdmin.js`/
  `lib/errorLog.js`, a mocked Gemini fetch — no live DB or model access
  per rule #11): the three literal documented example lines (Jacob/Rana/
  Michael) each extract, assign to the correct roster person, and resolve
  the right due date when the model ALSO returns the correct ownerName
  (confirms no regression to the already-working case, including a
  Sunday due date correctly weekend-clamped by the pre-existing,
  untouched `clampToWeekday()`); the exact reported scenario (Jacob's
  line, model returns an empty ownerName) still assigns to Jacob; the
  model returning the WRONG owner for Jacob's line is overridden by the
  deterministic match (proving this truly runs "regardless of what the
  model returned," not just as an empty-string fallback); a vague prose
  line with no leading-name marker is completely unaffected (still left
  unassigned for an admin-tier caller, exactly as before); an explicit
  `groupOwner:true` task still correctly co-assigns to every attendee
  even when its subject happens to textually overlap a leading-name line
  (proving the groupOwner skip works); two different qualifying lines
  naming two different people for the same subject are correctly left
  ambiguous, never guessed. Confirmed via `git stash` that exactly the
  two tests exercising the new override (the real reported bug, and the
  "wrong owner overridden" case) fail against the pre-fix code, while
  every other test — including the already-working happy path — passes
  unchanged on both sides, isolating exactly what this fix changes.
  `node --check` AND `node --input-type=module --check` (rule #9) both
  clean. No HTML touched, so no div-balance check applies. Held per rule
  #10 — touches live parse logic, even though the change only widens
  when an owner is deterministically assigned, never removes an existing
  assignment path.
- "Send Invitation Email" now actually sends, for both users and admins
  (2026-11-10 — held for preview approval, new `api/send-welcome-email.js`
  + `index.html`): both invitation flows (`sendWelcomeEmail()` for
  members, `_sendAdminWelcomeEmail()` for admins) previously only built
  forward-to-Sarah text for her to copy/paste or open in her own mail
  client — nothing was ever actually sent; the admin had to manually
  relay credentials to every new hire/admin by hand. New endpoint
  `api/send-welcome-email.js` (admin-only, via `requireSession()`/
  `tierOf()` — same gate as `api/send-assignment-email.js`) sends the
  real welcome email directly to the new person's own address via the
  existing `sendResendEmail()`/`buildEmailHtml()`, from the standard Ops
  Hub sender (`notifications@opshub.wlmsend.com` via
  `RESEND_FROM_EMAIL`/the resendClient default) — **no admin signature**:
  the old "Have a great day, Sarah Samy / Director of Systems &
  Operations" sign-off is dropped from the email body, since this no
  longer comes from Sarah personally. Member vs. admin wording is
  otherwise unchanged (same credentials/access-level copy as before,
  just minus that sign-off and the "Hi Sarah, forward this" wrapper,
  which has no purpose once the send is real). On success, a short
  best-effort confirmation ("The team/admin invitation for `<name>` was
  sent directly to `<email>`") is also emailed to
  `ssamy@weblightmedia.com` — its own failure is logged via `logError()`
  but does NOT turn the overall response into a failure, since the
  actual job (the new person getting their credentials) already
  succeeded; a failure on the PRIMARY send, by contrast, does fail the
  whole request with a real error message, logged the same way — never
  a silent success either way. Read-only with respect to app data: this
  endpoint never writes to `ops_users`/`ops_admins`/anything else — a
  `welcomeEmailSentAt` stamp, if ever wanted, is flagged as a separate,
  explicitly-approved follow-up (would go through normal per-record
  sync, not a side write bolted onto a send endpoint). Server-side,
  triggered only by an explicit button click in the invitation preview
  modal — never on page load, never auto-fired from `addUser()`/the
  admin-add handler on account creation (CLAUDE.md rule #2's load-time/
  background-write discipline applied to "when this fires," even though
  this endpoint itself does no writes). The temp password stays
  plaintext in the email, unchanged — the admin's existing choice,
  already covered by forcing a password change on first login.
  `index.html`'s invitation preview modal (`emailPreviewModal`) gained a
  real `📧 Send Invitation Email` button (`_sendInvitationEmailNow()`,
  calling the new endpoint) plus an inline status line, replacing the
  old `📨 Open Mail Client` button — `_openMailClient()` itself was
  removed outright as genuinely dead code once nothing called it
  anymore, not left as an unreferenced gremlin. The preview's "To" field
  now shows the real recipient (the new user/admin's own address, since
  that's who the direct send actually reaches) instead of Sarah's —
  `_showEmailPreview()` gained an optional `sendPayload` parameter
  (`{kind, name, email, title, password, hubUrl, levelLabel?, levelDesc?}`)
  that both `sendWelcomeEmail()` and `_sendAdminWelcomeEmail()` now
  populate, and resets the Send button/status every time the modal
  (re)opens so a previous invite's "✅ Sent" state can never silently
  carry over and block sending a different one. `addUser()`'s and the
  admin-add handler's own call sites are otherwise completely
  unchanged — the admin still creates the account first (pay,
  assignments, level, etc.), exactly as before; only what happens when
  they click the modal's send step changed. Verified with a new 6-check
  `node:test` suite against the real, unmodified exported `handler()`
  (fake in-memory Supabase client for `requireSession()`'s revocation
  check + `sendResendEmail()`'s roster-status read, a swappable
  `global.fetch` standing in for the real Resend API — no live DB/Resend
  access per rule #11): a member-tier caller is rejected (admin only); a
  request missing a required field is rejected with nothing sent; a
  member invite sends exactly two emails (the new user's own welcome
  email — containing their real credentials and no "Sarah Samy"
  signature — and the admin's confirmation); an admin invite does the
  same with the access-level wording included; a Resend failure on the
  primary send surfaces a real error, is logged, and never even attempts
  the admin confirmation; a primary send that succeeds but whose
  confirmation send fails still reports `ok:true` overall while logging
  the confirmation failure under its own `endpoint` tag, never silently
  dropping it. `node --check` AND `node --input-type=module --check`
  (rule #9) both clean on `api/send-welcome-email.js`; inline-JS syntax
  clean on `index.html`; div-balance delta unchanged vs. baseline (+2
  open/+2 close — the new status-line `<div>` in the static modal plus
  its counterpart in the dynamic fallback overlay's template string,
  both self-closing on the same line, net zero imbalance). Held per rule
  #10 — new `api/` send path, even though it performs no data writes.
- Mobile tables audit — every data table now usable on a phone, app-wide
  (2026-11-10 — held for preview approval, `index.html`+`client.html`+
  `user.html`, display-only, max-width media queries only): only
  `.tpa-person-tbl` (the Overview "Per-Person Breakdown" table) had the
  responsive stacked-card treatment before this; every other data table —
  Users, Admins, Client Health, Workload, My Team's Work, Commissions
  (Saved + Year), Backups, Reported (`index.html`); the Sales Funnel table
  and the Services/My Work tables (`client.html`); My Services
  (`user.html`) — either overflowed the page outright or sat inside an
  `overflow-x:auto` wrapper that kept the PAGE from overflowing but still
  made the table itself unusable without an internal horizontal scroll.
  **Fix**: generalized the existing per-person-breakdown technique
  (`thead{display:none}` + each `<tr>` becomes a bordered card + each
  `<td>` becomes a label/value row via a `data-label` attribute and
  `::before`) into a reusable class, `.mobile-stack-tbl`. In `index.html`
  this is folded into `.tpa-person-tbl`'s own existing `@media
  (max-width:480px)` block (one shared implementation, not a second copy
  — `.tpa-person-tbl`'s own behavior is byte-identical); `client.html`/
  `user.html` each got their OWN hand-duplicated copy of the same rules
  (CLAUDE.md rule #3 — zero shared code across the three frontends), not
  an import from `index.html`'s. Every identified table gained the class
  plus `data-label` on each `<td>` (the leading name/title column uses
  `data-label=""`, the existing convention for a card's "title" row; a
  bare status-dot column and an Actions column full of buttons
  deliberately carry NO `data-label` at all, falling back to the base
  rule's right-aligned raw content with no broken-looking blank label —
  confirmed this fallback already existed and needed no new CSS).
  Workload/My Team's Work's colspan-based "▸ Details" sub-rows (whose
  text is already self-descriptive — "↳ client — service", "🏷
  category") got their own explicitly-classed `tr.wl-detail-row`
  override instead of being excluded by any guess-the-main-row
  heuristic, so this can never accidentally mis-style a different
  table's rows. Also added one shared override, `max-width:none;
  white-space:normal;text-overflow:clip` (all `!important`, since the
  base rule already is), to the `.mobile-stack-tbl td`/`.tpa-person-tbl
  td` rule itself — several tables (Sales Funnel's Next Step/Notes
  columns especially) set an inline `max-width:240px;text-overflow:
  ellipsis;white-space:nowrap` for the DESKTOP table's fixed-width
  columns, which would otherwise have kept truncating a stacked card's
  value to a tiny sliver of its own full-width row for no reason once
  there's no column width to truncate for anymore. **A second, real,
  independently-found bug surfaced auditing `client.html`'s Services tab
  with the table's own overflow now fixed** (previously large enough to
  mask it): the "All Clients" page's top stat-row
  (`Total Clients`/`Active`/`Inactive`/`Services Due Soon`) is `display:
  flex` with no `flex-wrap`, unlike every other stat-row in this same
  file (e.g. My Work's own, which already has `flex-wrap:wrap`) — fixed
  by adding the same `flex-wrap:wrap`. Scope note (flagged, not silently
  skipped — rule #7): the three Super-Admin-only DIAGNOSTIC tables
  (Error Log ungrouped/grouped, Schema Drift, the Restore dry-run
  comparison table) were deliberately left as-is — each already sits in
  its own `overflow-x:auto` wrapper (genuinely never breaks the PAGE's
  width, confirmed via the audit script below), and their content is
  free-text error messages/migration paths, not short labeled values —
  the stacked-card label/value layout actively reads worse for a long
  sentence than an internal horizontal scroll does, so converting them
  was judged a regression in usability, not an improvement, and out of
  this ticket's own "every table" framing once weighed against that.
  Verified with a new Playwright suite against the real, live-served
  files at all 4 required widths (360/375/414/430px, fixture-seeded via
  each file's own real localStorage keys/session-bypass globals, forced
  past login — no live Supabase per rule #11): zero horizontal page
  overflow (`document.documentElement.scrollWidth` vs. `window.
  innerWidth`) on every audited table/page; `thead` confirmed hidden
  (stacking genuinely active, not just "didn't overflow by luck") on
  every one; the last row's own action button confirmed horizontally
  reachable (actually inside the viewport's own bounds, not just present
  in the DOM) on the Users/Admins/Services tables specifically — the
  exact control class the ticket named; zero JS errors across all three
  files at every width. A real test-harness gotcha found and fixed along
  the way, not a product bug: `user.html`'s `currentUser` is a top-level
  `let`, not a window property — `window.currentUser=...` silently
  creates an unrelated property while every real function keeps reading
  the actual (still-null) lexical binding; fixed by assigning the bare
  identifier instead, which does correctly reach the same binding a real
  login's own code path sets. Confirmed via `git stash` that the exact
  same suite fails against the pre-fix code — concretely, not just
  "overflow": the Users/Admins tables' own last-row action buttons sit
  far outside the viewport (e.g. `x:578` on a 360px-wide screen),
  `client.html`'s Services tab has real page-level overflow
  (scrollWidth=394 on a 360px viewport) before the stat-row fix, and
  every table's `thead` is still a visible `table-header-group` — then
  passes clean after. Before/after screenshots captured at 375px for the
  three representative screens most exercised day-to-day (`index.html`
  Users tab, `client.html`'s Services tab, `user.html`'s My Services) and
  sent directly to the user. `node --check` on extracted inline JS clean
  on all three files; div-balance unchanged vs. baseline on all three
  (pure CSS/attribute changes — no HTML markup structure touched). No
  `api/*.js` touched, so rule #9's module-mode check doesn't apply. Held
  per rule #10 — broad-reaching across all three frontends, even though
  every change is additive CSS/markup-attribute only with no data write
  and no behavior change above the 480px breakpoint.
- Row "Actions ▾" menu no longer clips under the next section for a
  bottom-of-table row (2026-11-10 — held for preview approval,
  `index.html` only, display-only): reported live — `.row-actions-menu`
  (currently only the Users table's Grant/Revoke-Manager-Role +
  Deactivate menu, but written to be reusable by any future row-actions
  menu, per its own existing header comment) was `position:absolute`
  inside `.user-table-wrap`, which is `overflow:hidden` for its own
  rounded-corner styling — a bottom row's opened menu rendered past that
  ancestor's clipped edge and was invisible/unclickable, with no way to
  scroll it into view since it wasn't really "below the table," just cut
  off by the ancestor's own overflow box. Fixed by switching the menu to
  `position:fixed` and computing its `top`/`left` in JS
  (`_positionRowActionsMenu()`, called from the existing
  `_toggleRowActionsMenu()`) from the toggle button's own
  `getBoundingClientRect()` at open time — this is what actually escapes
  the clipping ancestor, since `position:fixed` is relative to the
  viewport, not any scrollable/overflow:hidden parent. Right-aligned
  under the button by default (matching the old `right:0` look), clamped
  horizontally to stay fully onscreen, and — the actual fix for the
  reported bug — flips to render ABOVE the button instead of below when
  there isn't enough room beneath it in the viewport. Close behavior:
  outside-click/Escape were already wired and untouched; added closing
  on scroll or resize too, since those invalidate the fixed coordinates
  computed at open time (the button may have moved under the menu, or
  off-screen entirely) — simpler and more robust than continuously
  repositioning on every scroll tick. A real, independently-found bug
  surfaced while verifying this against an actual click (not just a
  direct function call): clicking the toggle button also FOCUSES it —
  the browser's own default action, not something this code does — and
  a focused element inside an `overflow:hidden` ancestor like
  `.user-table-wrap` is still a real, programmatically-scrollable
  container even with no visible scrollbar, so Chromium's native
  focus-into-view behavior fired a `scroll` event on that ancestor
  *synchronously as part of the very click that opens the menu* — which
  the new scroll-closes-the-menu listener then used to immediately close
  the menu it had just opened, before the admin could ever see it. Fixed
  with a short (150ms) grace window after open
  (`_rowActionsMenuOpenedAt`/`ROW_ACTIONS_MENU_SCROLL_GRACE_MS`) that the
  scroll/resize-close listener checks before acting — a real user scroll
  never happens inside that same tick, so this reliably tells the two
  apart without weakening the actual "scroll away → close" behavior in
  any way a user would notice. Verified with a Playwright suite against
  the real, live-served `index.html` (fixture-seeded via `dbSet`, forced
  past login the same way this session's other table-audit PRs already
  do — no live Supabase access per rule #11): the last row's menu (30
  fixture users) is fully onscreen AND actually hit-test-clickable (not
  just visually present — `document.elementFromPoint` resolves to an
  element inside the menu, not something covering/clipping it) at both a
  1440×900 desktop viewport and a 375×700 phone viewport; a dedicated
  third case with the viewport height cropped to just past the last row's
  naturally-measured button position (no scrolling at all, so nothing to
  confound it) directly exercises the upward-flip branch and confirms the
  flipped menu is still fully onscreen; scrolling (past the grace window)
  correctly closes the menu in both of the first two cases; zero page
  errors. Confirmed via `git stash` that the exact same suite fails
  against the pre-fix code — specifically the hit-test-clickable
  assertion at the desktop viewport (`hitTestsInsideMenu: false`,
  `document.elementFromPoint` at the menu's own reported coordinates
  resolves to something else — direct proof of the clipping, not just an
  inference from style) — then passes clean after. `node --check` on
  extracted inline JS clean; div-balance unchanged vs. baseline (pure
  CSS/JS change, no HTML markup touched). No `api/*.js` touched, so rule
  #9's module-mode check doesn't apply. Held per rule #10 out of caution
  even though this is a pure display/interaction fix with no data write
  — broad-reaching (every row-actions menu in the app, present and
  future).
- Overview stat drill-down rows now explicitly labeled Task vs. Service
  (2026-11-13 — held for preview approval, `index.html`, display-only):
  `_openDrillModal()`'s rows only distinguished a task from a service by a
  small leading emoji (✅ vs 🧩) with no text — not legible at a glance,
  especially in a mixed list like "Due Today" (`_ovDrillData.dueToday`,
  populated from both `_ovTaskRow()`/`_ovServiceRow()`, confirmed each
  already stamps `type:'task'`/`type:'service'` on its own row). Fixed by
  turning that leading emoji into a small colored pill with the type
  spelled out ("✅ Task"/"🧩 Service"), driven directly by `it.type` —
  same alpha-background/solid-text/alpha-border pill convention every
  other per-row badge in this file already uses (e.g. the Admins table's
  access-level badge), so it reads as the app's one pill style, not a new
  one. Task = blue (`#5B84C4`, matches `--accent`), Service = green
  (`#22A06B`, matches `--green`) — colors spelled out as literal hex
  (same as every other pill here) since a CSS var can't take the
  `${color}18`-style alpha-suffix this codebase's pill convention already
  relies on. Contrast comes from the pill's own background/border, not
  the page's background color, so it reads the same regardless of theme
  — moot in practice since this app has no dark-mode toggle at all
  (confirmed via grep: no `prefers-color-scheme`/`data-theme` anywhere),
  but the pill was still built the theme-independent way on principle.
  Click behavior (`openOvDrillItem(...)`), the row's own layout/other
  cells (title, client · assignee · due, status label), and every other
  stat-card/drill call site are completely untouched — only the leading
  icon span's content and styling changed. Verified with a new Playwright
  suite against the real, unmodified `_openDrillModal()`/
  `openOvStatDrill()` (seeded directly into `_ovDrillData.dueToday` with
  one task row + one service row, no live Supabase per rule #11): both
  rows render an explicit "Task"/"Service" pill with visually distinct
  colors, zero JS errors. Confirmed via `git stash` that this exact
  suite fails against the pre-fix code — the pill text is just the bare
  emoji with no word at all, and both rows resolve to the IDENTICAL
  color (`_ovDrillData`'s own `blue` wasn't even used by the icon) rather
  than two distinct ones — then passes clean after. `node --check` on
  extracted inline JS clean; div-balance unchanged vs. baseline (pure JS
  template change, no HTML markup touched). No `api/*.js` touched, so
  rule #9's module-mode check doesn't apply. Held per rule #10 out of
  caution even though this is a pure display-only change with no data
  write and no behavior change.
- Monthly (resettable) Tasks Assigned/Done view added to the Overview
  (2026-11-13 — **merged**, PR #494, `index.html`, display-only, no
  data writes, no load-time data mutation): `renderTeamProductionAnalytics()`'s
  Tasks Assigned/Done counts were all-time only (`tasksForPerson.length`/
  a `status==='Done'` count); added a per-viewer scope control, UI state
  only (localStorage). New row above the stat cards (`#ov-task-scope-
  control`, `_ovTaskScopeControlHtml()`): a "This month"/"All time" toggle
  (`setOvTaskScopeMode()`, defaults to `'month'`) and, in month mode, a
  12-month dropdown (`setOvTaskScopeMonth()`, current month first). Scoped
  strictly to TASKS, per the task's own instruction — Services Assigned/
  Done (`servicesForPerson`/`servicesDoneItems`) are completely untouched
  anywhere in this change. Definitions, exactly as specified: "Assigned"
  in month M = `createdAt` falls in M; "Done" in M = `completedAt` falls
  in M (both are full ISO timestamps everywhere they're written in this
  file, so a plain `slice(0,7)` prefix compare is exact — confirmed via
  grep, no timezone-aware parsing needed); a task missing the relevant
  date simply doesn't count toward any specific month — never silently
  falls back to all-time for that one task (verified directly in the test
  suite: a legacy task with no `createdAt` at all correctly never counts
  as "Assigned" in ANY month, in either direction). "(Resettable)" (the
  task's own title): no month is ever persisted to localStorage while the
  dropdown's current-month option is selected — re-selecting the current
  month (including just by switching back to "This month") clears any
  earlier explicit pin, so the view keeps auto-advancing on its own as
  real months pass rather than freezing on whatever month a user once
  picked; a genuinely pinned past month stays pinned across reloads until
  explicitly changed back. **Consistency** (the task's own "keep
  everything consistent" requirement): the Tasks card, its two drill-down
  modals (`_ovDrillData.tasksAssigned`/`tasksDone`, now populated from the
  SAME scoped item sets the card sums — never a separately-filtered
  query), and the Per-Person Breakdown table's own Tasks/Done columns all
  read from one scoped computation per person
  (`scopedTasksAssignedItems`/`scopedTasksDoneItems`, re-filtering the
  already-existing all-time `sum.tasksForPerson`/`tasksDoneItems` rather
  than querying separately) — all three can never disagree with each
  other by construction. The drill modal's own title additionally appends
  the active month (e.g. "Tasks Assigned — November 2026") so the popup
  itself states its scope, not just the card it was opened from. The
  Per-Person table's two column headers (`#tpa-th-tasks`/`#tpa-th-tasks-
  done`) are relabeled the same way ("Tasks (November 2026)"/"Done (all
  time)") rather than staying bare "Tasks"/"Done" while their own values
  silently changed meaning. **Flag 1 — data coverage** (only ~46% of
  all-time tasks have `createdAt` vs. ~95% with `completedAt`, given as
  fact by the user): surfaced, not silently under-counted — an "ⓘ about
  this count" tooltip (native `title` attribute, shown only in month mode)
  spells out the gap and that current/future months are accurate while a
  past month's Assigned count is a partial/floor count. **Flag 2 — Team %
  Done mixes tasks+services**: decided to keep it genuinely all-time
  regardless of the toggle (new `tasksAssignedAllTime`/`tasksDoneAllTime`
  carried on each person's row, from `sum.tasksAssigned`/`tasksDone`
  BEFORE those two field names get overridden by the scoped counts;
  summed into their own `totals.tasksAssignedAllTime`/`tasksDoneAllTime`
  accumulators) and relabeled the card itself "Team % Done (all-time)" so
  the choice is stated on the page, not just made silently; the Tasks
  ratio card's own % (`tasksPct`, "N% done") is the one number that DOES
  track the toggle, by design — it's the Tasks-specific figure, not the
  team-wide blended one. The Per-Person table's "Total %" column
  (`r.pctDone`) is likewise left all-time, unchanged — consistent with
  Team % Done, and outside the task's own "task columns" instruction
  (which named only the Tasks/Done columns, not Total %). Verified with a
  new Playwright suite against the real, unmodified `renderTeamProduction
  Analytics()`/`openOvStatDrill()` (fixture-seeded via `dbSet`, no live
  Supabase per rule #11): a 4-task fixture exercising every date-coverage
  case (created-and-done this month; created prev month but done this
  month; no `createdAt` at all but done this month; fully in the prev
  month) confirms the exact expected Assigned/Done counts in both month
  and all-time mode, that drill-down counts match the card, that pinning
  a past month persists it to localStorage and re-selecting the current
  month clears that pin, that Team % Done is byte-identical whether the
  Tasks toggle is "month" or "all time," and that the coverage tooltip is
  present. Confirmed via `git stash` that this suite fails against the
  pre-fix code (the new control/headers/functions don't exist yet) and
  passes clean after. `node --check`-equivalent (extracted inline JS,
  `new Function()` parse) clean; div-balance unchanged vs. baseline
  (2203/2205, delta -2 — pure net-balanced additions, no HTML markup
  structure altered). No `api/*.js` touched, so rule #9's module-mode
  check doesn't apply. Held per rule #10 out of caution even though this
  is a pure display-only change with no data write and no load-time
  mutation.
- Monthly "backlinks renewal" urgent reminder to David, with escalation to
  Sarah (2026-11-16 — held for preview approval; NEW automated write path
  + cron, flagged per rule #13 BEFORE merge; needs a post-merge integrity
  check too): new `api/cron-backlinks-reminder.js` +
  `api/backlinks-confirm.js` + `lib/backlinksToken.js`, plus two small
  additive changes to `lib/resendClient.js`. No new table/migration — state
  lives in `ops_settings`, key `backlinksReminder:<YYYY-MM>`.
  **Schedule**: fires on the 15th of the month, weekend-adjusted
  (`scheduledReminderDay()`: Saturday → the 14th, Sunday → the 16th, else
  the 15th — pure calendar math, confirmed via `Date.UTC(...).getUTCDay()`,
  no timezone dependency since a calendar date's weekday doesn't vary by
  zone), ~9:00 AM America/New_York, DST-aware. Reuses
  `api/cron-pto-report.js`'s own hourly-Vercel-cron +
  `localPartsInTz()`-gate pattern (`vercel.json`: `"0 * * * *"`, every
  hour, every day — gated in-handler on `ny.hour===9`), but unlike that
  cron's fixed two-UTC-day schedule, this one genuinely needs to run EVERY
  day of the month: the weekend-adjusted target day moves between
  14th/15th/16th per month, and the 3-day repeat/escalation checks need a
  daily tick regardless of which day the month's initial send landed on.
  **State machine** (`ops_settings` value shape: `{status: 'pending'|
  'renewed'|'not_yet', firstSentAt, lastSentAt, nextReminderDate,
  escalationDueDate ('YYYY-MM-DD' NY calendar dates), escalatedAt,
  respondedAt, via}`): no existing row + today is the scheduled day →
  send the initial urgent reminder, create the row `pending`, both
  `nextReminderDate`/`escalationDueDate` set to `today+3`. Row exists,
  `status!=='pending'` → no-op, month fully resolved (a response of EITHER
  kind stops everything — the goal is forcing a check-in, not a specific
  answer). Row exists, still `pending` → independently checks (a)
  `!escalatedAt && today>=escalationDueDate` → one-time email to Sarah
  (`ssamy@weblightmedia.com`), `escalatedAt` stamped so it can never fire
  twice even though the repeat keeps recurring every 3 days after it; (b)
  `today>=nextReminderDate` → another urgent reminder to David,
  `nextReminderDate` advanced to `today+3`. Both conditions can fire in
  the same run (e.g. exactly at the 3-day mark) — verified directly.
  **Idempotency** (flagged, not silently assumed — rule #7): the date
  fields are always advanced past `today` in the SAME request that sends,
  immediately after sending — so any later invocation the same NY calendar
  day (a platform retry, or another hourly tick) finds "not due yet" and
  sends nothing further; verified by calling the real handler twice at an
  identical fixed `now` and confirming only the first call sends anything.
  This is the same race-tolerance level already accepted by every other
  cron in this codebase (one invocation per scheduled tick, not truly
  concurrent) — not a new, weaker guarantee introduced here. A missed
  scheduled day (e.g. a deploy outage) does NOT get a later catch-up send,
  matching `cron-pto-report.js`'s own same-day-only precedent.
  **The email**: urgent, To David only
  (`lib/resendClient.js`'s `DAVID_EMAIL`), from
  `notifications@opshub.wlmsend.com` via `sendResendEmail()`, using
  `buildPlainEmailHtml()` (PR #441's minimal, non-branded template, for
  Primary-tab/inbox placement — not the colored-card `buildEmailHtml()`
  every routine notification uses) with subject "URGENT: Monthly
  backlinks renewal — action needed" and new `X-Priority: 1`/
  `Importance: high` headers. `sendResendEmail()` gained an additive,
  optional `headers` param (passed straight through to Resend's own
  `headers` request field, omitted entirely when not given — every
  existing caller's request body is byte-identical to before). **Real gap
  caught and closed before it could silently break this feature**: David
  is suppressed from every email type not on `resendClient.js`'s own
  3-item `DAVID_EMAIL_ALLOWED_TYPES` allowlist (the 2026-09-25/09-28
  "David email overhaul") — without adding this feature's own
  `'backlinksReminder'` type to that allowlist, `sendResendEmail()` would
  have silently no-op'd (`{suppressed:true}`) on every single send to the
  one person this whole feature exists to reach; added it, and a test
  confirms the allowlist still correctly suppresses an unrelated type
  (not just "always true" now). **One-click safety** (flagged, not
  guessed — rule #7): a bare record-on-GET link can be auto-triggered by
  an email client's own link-prescanning/security-scanning bot before a
  human ever opens the email, which would falsely mark the month done
  with no real response from David at all. Fixed with a genuine two-step
  flow in `api/backlinks-confirm.js`: `GET ?token=...` only RENDERS a tiny
  confirmation page ("Confirm you renewed/have not renewed the backlinks
  for `<month>`?") — no database write at all, verified directly (the
  in-memory store is asserted untouched after a GET); the page's own
  `<form method="POST">` is what actually records the answer, since a
  prescanning bot does not submit forms. A second click on the OTHER
  button after a month is already resolved is a no-op (status already
  `!=='pending'`), confirmed not to overwrite the first real answer.
  **Token**: a new, deliberately SEPARATE small HMAC signer,
  `lib/backlinksToken.js` (`signBacklinksToken`/`verifyBacklinksToken`),
  rather than reusing `lib/opsSession.js`'s `signSession`/`verifySession`
  — same `SESSION_SECRET` env var (no new secret to configure), but kept
  as its own code path on purpose: this token has nothing to do with
  being signed into the app at all (David clicks it with zero session),
  and a future change to the real session signer's expiry/shape for
  login-session reasons must never be able to silently change how long a
  backlinks-confirm link stays valid, or the reverse. Verified: a signed
  token round-trips; a tampered token and arbitrary garbage both fail
  verification without throwing. **No quiet-hours gate applies** — this
  calls `sendResendEmail()` directly, never
  `insertNotifications()` (the only place quiet-hours logic lives in this
  codebase), so there's nothing to bypass, consistent with every other
  precisely-scheduled report/reminder cron's own "bypass quiet hours"
  reasoning. Verified with a new 21-check `node:test` suite (fake
  in-memory Supabase client + `node:test`'s `mock.module` for
  `lib/supabaseAdmin.js`, a captured `global.fetch` standing in for the
  real Resend API, a `withFixedNow()` helper overriding the global `Date`
  constructor so the hour/day/3-day-math gates are exercised at exact,
  deterministic instants rather than whatever the real clock happens to
  be — no live Supabase/Resend access per rule #11): the weekend-
  adjustment formula for a plain weekday/Saturday/Sunday 15th; token
  round-trip/tamper/garbage handling; the David-allowlist gap described
  above, both fixed and still correctly selective; the full reminder
  email's exact subject/from/urgent-headers/both-tokenized-links shape;
  the confirm endpoint's GET-never-writes and POST-writes-once/
  already-resolved-is-a-no-op/invalid-token-400 behavior; and the full
  state-machine lifecycle end-to-end against the real, unmodified
  handler — initial send on the scheduled day, a no-op the day before,
  no-op while still inside the 3-day window, repeat+escalation both
  firing together exactly at the 3-day mark, the same-day idempotency
  guarantee (two calls at an identical fixed `now`, only the first
  sends), escalation never firing a second time while repeats keep
  recurring, and a responded month staying a total no-op at its next
  scheduled-hour tick. Confirmed via `git stash -u` that the ENTIRE suite
  fails against the pre-fix code (the new files don't exist yet) and
  passes clean after. `node --input-type=module --check` (rule #9) clean
  on all 4 touched/new `api/*.js`/`lib/*.js` files; `vercel.json`
  confirmed still valid JSON after adding the new hourly cron entry. No
  HTML touched, so no div-balance check applies. Held per rule #10 and
  flagged per rule #13 BEFORE merge — a brand-new automated write path
  (a cron that mutates `ops_settings` and sends email with no human
  clicking save) is exactly the highest-risk category that rule calls
  out; still needs a post-merge read-only Supabase integrity check (the
  `backlinksReminder:*` rows' shape/status transitions, and that no
  duplicate sends actually reached Resend) before being considered fully
  closed, not just "app loads."
- Approving a time off request now actually deducts from the balance
  (2026-11-14 — held for preview approval, `index.html` only, data-path PR
  → needs a post-merge integrity check per rule #13): root cause confirmed
  exactly as reported — `reviewTimeOff(id,'approved')` only ever flipped
  the request's own `status`; it never wrote to `ops_time_off_ledger`, and
  `getTimeOffBalance()` computes used/remaining ONLY from that ledger —
  so an approval never deducted anything, regardless of how many got
  approved. Fixed by posting a matching ledger entry on approval, reusing
  `logTimeOffEntry()`'s own entry shape and `undoTimeOffEntry()`'s own
  reversal shape verbatim (4 new helpers:
  `_toPostApprovalLedgerEntry()`/`_toReverseApprovalLedgerEntry()`/
  `_toActiveLedgerEntryForRequest()`/`_toResolveEmployeeId()`, plus
  `_toLedgerTypeForRequest()`/`_toUnrecognizedTypeNote()`), wired into
  `reviewTimeOff()` itself. **Idempotent**: every posted entry carries a
  new `requestId` field; `_toActiveLedgerEntryForRequest()` (an entry for
  this requestId exists AND nothing else's `reversalOf` points at it) is
  checked first — approving/re-saving an already-active request is a
  silent no-op, never a duplicate. **Reversible**: a request that goes
  approved→denied posts a reversal (negated days, `reversalOf` pointing at
  the original) exactly like a manual Undo — the original ledger entry is
  never mutated/deleted (DB-guarded append-only); re-approving after a
  reversal correctly posts a fresh, new, active entry (full audit trail
  across multiple approve/deny cycles, not permanently blocked after one
  reversal). An ordinary pending→denied decision (the overwhelmingly
  common case) never even looks for an entry to reverse — only a PRIOR
  status of `'approved'` triggers the reversal path. **Type mapping**
  (flagged, not guessed — rule #7): a request's own `type` is free-form
  text defaulting to "PTO"; the ledger only ever tracks sick/vacation. An
  exact, case-insensitive "sick" → sick; "vacation"/"PTO"/blank/anything
  else → vacation (the ledger's one general-purpose bucket — documented
  explicitly, not inferred). An unrecognized literal (e.g. "Bereavement")
  is still logged as vacation — the whole point of this fix is that the
  balance actually moves — but is surfaced in the posted entry's own
  `note` (`_toUnrecognizedTypeNote()`) rather than silently indistinguish­
  able from a real vacation request. **Employee identity resolution**
  (also flagged, not guessed): a request only ever carries a free-text
  `userName`, never an id on the client's own object, but
  `api/ops-sync.js` has server-stamped a `userId` on every request since
  2026-09-17 (confirmed by reading that write path directly) for both an
  employee's self-submission and a manager-tier admin's own "My Time Off"
  submission — `_toResolveEmployeeId()` uses that `userId` first (only
  when it actually matches a live `_timeOffRoster()` entry), falling back
  to an EXACT, UNIQUE name match for legacy pre-2026-09-17 requests. Two
  cases correctly resolve to null rather than guessing: an unmatched
  name/id (e.g. the Super Admin/Owner's own "primary-admin" sentinel,
  confirmed via grep to never be a real `ops_admins` row and to have no
  tracked balance anywhere in this file by the same existing design), and
  an AMBIGUOUS duplicate name (2+ roster members sharing it) — in both
  cases the approval itself still goes through (the request's own status
  write is independent), but the ledger write is skipped with a reason
  surfaced via toast + a logged activity entry, so it's never silently
  lost. **No double-count / no auto-backfill** (explicit instruction, also
  rule #7): existing already-approved requests that predate this fix have
  no ledger entries and this deliberately does NOT backfill them — some
  (e.g. Michael's/Rana's) were already logged manually via Log Time Off,
  and a blind backfill would double-count those; any real backfill is a
  separate, explicit dry-run → approve → write step, never automatic or
  silent. **Server-side write, no load-time mutation**: this only ever
  runs from the explicit Approve/Deny button click
  (`reviewTimeOff()` has no other call site); the new ledger entry is
  `dbSet()` locally exactly like every other ledger writer in this file
  already does, and travels to the server in the SAME `cloudAutoSync()`
  request as the request's own status change (confirmed by reading
  `cloudPushAll()`'s dirty-diff collection — both `timeOffRequests` and
  `timeOffLedger` are read into the same `changes` object, one POST).
  `ops_time_off_ledger` writes are already restricted server-side to
  `tier==='super'` (confirmed in `api/ops-sync.js`), and `#admin-timeoff`
  (where `reviewTimeOff()` lives) is already Super Admin/Owner-only client
  side — the caller who can trigger this write is always the tier allowed
  to make it. Failure handling extended to match: `reviewTimeOff()`
  already rolled back the request's own status fields on a failed
  `cloudAutoSync()`; now also snapshots and restores the WHOLE ledger
  array on that same failure, so a half-landed ledger entry can never
  survive a rolled-back status. Verified with a new Playwright suite
  against the real, unmodified helpers and `reviewTimeOff()` (fixture-
  seeded via `dbSet`, no live Supabase per rule #11): posting by `userId`;
  idempotent re-post (still exactly 1 entry); sick-type mapping; an
  unrecognized type mapping to vacation with the surfaced note; legacy
  name-fallback resolution; an unresolvable identity correctly flagged
  (no entry posted); an ambiguous duplicate name correctly flagged;
  reversal nets to zero days and leaves no active entry; re-reversing an
  already-reversed request is a no-op; re-approving after a reversal
  posts a genuinely new active entry; a full end-to-end approve (mocked
  `/api/ops-sync` success) producing exactly the right ledger entry; a
  full end-to-end un-approval (deny after approved) posting the reversal
  and clearing the active entry; and a full end-to-end rollback on a
  mocked server failure, confirming BOTH the request status and the
  ledger array revert together. Confirmed via `git stash` that this exact
  suite fails against the pre-fix code (the new functions don't exist
  yet) and passes clean after. `node --check`-equivalent (extracted
  inline JS, `new Function()` parse) clean; div-balance unchanged vs.
  baseline (2201/2203, delta -2 — pure JS change, no HTML markup
  touched). No `api/*.js` touched, so rule #9's module-mode check doesn't
  apply. Held per rule #10 — touches live data-write/notification-
  adjacent logic (the time off ledger); per rule #13, needs a post-merge
  read-only Supabase integrity check (counts, orphans, and the specific
  fields this writes — `requestId`/`employeeId`/`type`/`days` — on a real
  approval) before being considered fully closed, not just "app loads."
- Meaningless "% done" on the monthly Tasks card fixed (2026-11-17 —
  held for preview approval, `index.html` only, display-only, no data
  writes): follow-up to #494 (the monthly Tasks Assigned/Done scope
  toggle) — reported live, This-month mode showed e.g. "116/27 · 430%
  done." Root cause exactly as reported: `tasksDone` (tasks whose
  `completedAt` falls in the selected month) and `tasksAssigned` (tasks
  whose `createdAt` falls in the selected month) are two DIFFERENT task
  sets — a task created in October and completed in November counts
  toward November's Done but not its Created, so `tasksDone/
  tasksAssigned` (`tasksPct`) can run well past 100% and is meaningless
  as a ratio; worsened by only ~46% of tasks even having `createdAt`
  (the #494 tooltip's own documented gap), undercounting "Created"
  further. Fixed by dropping the ratio entirely in month mode — the
  Tasks card now shows only the two counts, clearly labeled ("Created N
  · Completed M"), no percentage anywhere on the card
  (`tasksStatCard`, a new conditional branch right where `ratioStatCard`
  used to be called unconditionally for the Tasks card). All-time mode
  is completely untouched: there, Done IS a genuine subset of Assigned
  (every task ever marked Done was assigned at some point), so
  done/total · pct% stays valid and still uses the exact same
  `ratioStatCard()` every other ratio card on this page already uses —
  same markup, same click target, byte-identical to before this fix.
  Click-to-drill behavior is unchanged in both modes (still opens the
  'tasksAssigned' drill list). **Per-Person table and drill-downs kept
  consistent, per the task's own instruction** — confirmed, not just
  assumed: neither ever showed a tasks-only percentage in the first
  place (the Per-Person table's Tasks/Done columns are plain counts; its
  only percentage column, "Total %," blends tasks+services all-time and
  was deliberately left untouched by #494 already), and both drill-down
  modals are plain item lists with no ratio — so no further change was
  needed there, verified directly rather than guessed. Verified with a
  new Playwright suite against the real, unmodified
  `renderTeamProductionAnalytics()` (fixture-seeded via `dbSet`, no live
  Supabase per rule #11): a 4-task fixture reproducing the EXACT
  reported bug shape (1 task created this month, 3 tasks created in the
  prior month but completed this month — Done=3 genuinely exceeding
  Assigned=1) confirms the month-mode card shows "Created 1 · Completed
  3" with zero `%` characters anywhere on the card, the month label line
  still present, and clicking the card still opens the "Tasks Assigned"
  drill with the correct count; switching to all-time mode shows the
  valid "3/4 · 75% done" (4 tasks total, 3 done) with the all-time
  label; the Per-Person row and `_ovDrillData` counts match the card
  exactly in month mode. Confirmed via `git stash` that this suite
  reproduces the real pre-fix bug LIVE — the unfixed code renders
  exactly "3/1" and "300% done" on the identical fixture — before
  passing clean after the fix. `node --check`-equivalent (extracted
  inline JS, `new Function()` parse) clean; div-balance unchanged vs.
  baseline (2206/2208, delta -2 — pure net-balanced additions, no HTML
  markup structure altered). No `api/*.js` touched, so rule #9's
  module-mode check doesn't apply. Held per rule #10 out of caution even
  though this is a pure display-only change with no data write.
- Monthly backlinks reminder fixed per David's feedback — broken confirm
  link, unbranded email, wrong schedule/month (2026-11-17 — held for
  preview approval, `api/cron-backlinks-reminder.js`+`lib/resendClient.js`,
  no new table/migration, no `vercel.json` change needed): four issues
  reported live against the 2026-11-16 feature.
  **(1) Broken confirm link (404)**: `confirmUrl()` joined
  `process.env.APP_URL` directly onto `/api/backlinks-confirm`, but APP_URL
  in production is set to the USER portal's own URL — every other call
  site's own fallback default already documents this convention (e.g.
  `lib/resendClient.js`'s own `.../user` default, `api/cron-overdue-
  check.js`'s `.../user` default) — so the link came out as `.../user/api/
  backlinks-confirm` and 404'd. Fixed with a new `siteRoot()` helper that
  parses whatever APP_URL resolves to and keeps only `protocol+host`,
  discarding any path — correct regardless of which portal path APP_URL
  happens to be configured to, not a guess at its exact current value.
  **(2) Unbranded + bare-URL "buttons"**: switched `sendDavidReminder()`
  from `buildPlainEmailHtml()` to the branded `buildEmailHtml()` template.
  Since that template only ever rendered one default "Open Ops Hub" CTA
  driven by a single `link`, gave it a new, additive, backward-compatible
  `buttons` param (`lib/resendClient.js`) — an array of `{label, href,
  background?}`; every existing caller (6 call sites, confirmed via grep)
  omits it and renders byte-identical output to before (verified directly:
  a no-`buttons` call still produces the exact old single-anchor markup).
  When provided, it replaces that single anchor with one real styled
  button-link per entry — used here for the "✅ I renewed it" (green,
  `#1F9D55`) / "❌ Not done yet" (red, `#C0392B`) pair, so David sees two
  actual branded buttons, not raw URL text pasted into a plain-text body.
  The GET→confirmation-page→POST-records one-click flow itself (the
  anti-prescanning-bot design) is completely unchanged — only the email's
  own template/markup changed, not `api/backlinks-confirm.js`. Sarah's
  escalation email is unchanged (still `buildPlainEmailHtml()`, out of this
  ticket's named scope — David's feedback was about the reminder he
  receives, not Sarah's escalation).
  **(3) Rescheduled to the start of the month**: `scheduledReminderDay()`
  now targets the 1st, weekend-adjusted FORWARD to the next business day
  (Saturday the 1st → Monday the 3rd; Sunday the 1st → Monday the 2nd;
  else the 1st itself) — unlike the old mid-month (15th) schedule, which
  could move either direction, there's no earlier business day to move the
  1st to within the same month, so this one only ever moves forward.
  `vercel.json`'s existing cron entry (`"0 * * * *"`, hourly, every day)
  needed NO change — it already ran every day of the month (required
  before for the old 14th/15th/16th spread, still required now for the new
  1st/2nd/3rd spread), confirmed directly rather than assumed. The
  DST-aware `localPartsInTz(..., 'America/New_York')` 9 AM gate is
  unchanged.
  **(4) Tracked month fixed to the PRIOR month**: a run firing in December
  (even though triggered by December's own 1st-of-month schedule) was
  wording/keying everything off "December" instead of the November
  backlinks it's actually asking about. New `priorMonthKeyOf(year, month)`
  derives the tracked `YYYY-MM` from the firing date (handles the January →
  December-of-the-prior-year rollover) and is used consistently for
  EVERYTHING keyed off "month" — the `ops_settings` row
  (`backlinksReminder:<trackedMonth>`), the confirm token's own `month`
  payload field, and the email wording (a new `monthLabel()` renders it as
  "November 2026") — so the 3-day repeat and the escalation-to-Sarah,
  which both key off that same settings row, are automatically correct
  with no separate change needed, exactly as the ticket asked. Subject
  line now reads e.g. "URGENT: November 2026 backlinks renewal — action
  needed" instead of the old generic, month-less subject.
  Verified with a new 11-check `node:test` suite against the real,
  unmodified exports (a fake in-memory Supabase client + `node:test`'s
  `mock.module` for `lib/supabaseAdmin.js`, a captured `global.fetch`
  standing in for the real Resend API, `withFixedNow()`-style `Date`
  overrides for deterministic day/schedule checks — no live Supabase/
  Resend access per rule #11): `scheduledReminderDay()`'s three cases
  (plain weekday, Saturday, Sunday 1st); `priorMonthKeyOf()`'s normal case
  and the January rollover; `buildEmailHtml()`'s new `buttons` rendering
  AND its unchanged no-`buttons` regression case; a full end-to-end run of
  the real, unmodified handler (APP_URL deliberately set to the real
  reported-bug value, `.../user`) confirming the actual sent email never
  contains `/user/api/backlinks-confirm`, DOES resolve to the site root,
  carries two distinct styled-button confirm links, and that one of those
  tokens verifies end-to-end through the real, unmodified
  `verifyBacklinksToken()`/`api/backlinks-confirm.js` with the correct
  tracked month; a full end-to-end "weekend 1st" run (August 2026, 1st is
  a Saturday) proving no send on the 1st or 2nd and the real send landing
  on the 3rd; a regression run of `api/backlinks-confirm.js`'s own GET-
  never-writes/POST-records-once behavior against the new token shape.
  Confirmed via `git stash` that 9 of these 11 checks fail against the
  pre-fix code (the 2 pure-`buildEmailHtml`-regression checks pass on
  both sides, as expected — that behavior was never broken). `node
  --input-type=module --check` (rule #9) clean on both touched files. No
  HTML touched, so no div-balance check applies. Held per rule #10 — this
  still touches the same brand-new automated write path flagged under
  rule #13 when the feature was first added (2026-11-16); still needs the
  same post-merge read-only Supabase integrity check once a real month's
  cycle runs in production (confirming `ops_settings` rows key off the
  correct prior month, and that the live confirm links actually resolve
  — not just "app loads").
- US paid-holiday calendar added — suppresses alerts, shown on the
  calendar and in the ledger, US team only (2026-11-17 — held for preview
  approval, `api/cron-overdue-check.js`+`index.html`+`user.html`, no new
  table/migration, no load-time data mutation): the US Time Off SOP's 7
  paid holidays weren't modeled anywhere. Added a shared, COMPUTED
  calendar — hand-duplicated per rule #3 (no shared module exists) as
  `usHolidaysForYear(year)`/`isUsHolidayDate(dateStr)` (+
  `anyUsHolidayInRange()` in the cron only) in all three files — nothing
  is ever written to a ledger/table; every date is derived fresh on every
  call. Floating-date math (`_nthWeekdayOfMonth`/`_lastWeekdayOfMonth`) is
  plain calendar arithmetic, confirmed for 2026: New Year's Day Jan 1,
  Memorial Day May 25, Independence Day Jul 4, Labor Day Sep 7,
  Thanksgiving Nov 26, Day After Thanksgiving Nov 27, Christmas Dec 25 —
  the Nov 26/27 pair matches the ticket's own stated Thanksgiving dates
  exactly, confirming the calculator. **Observed-date handling flagged,
  not guessed (rule #7):** when a fixed holiday lands on a weekend (Jul 4,
  2026 IS a Saturday, confirmed via `Date.UTC(...).getUTCDay()===6`), the
  US Time Off SOP doesn't specify an observed-Friday/Monday rule — this
  uses the literal calendar date, no invented observed day; surfaced here
  rather than assumed, revisit if the SOP is ever updated to say
  otherwise.
  **(1) Alert suppression** (`api/cron-overdue-check.js`): extended at
  exactly the 3 points the ticket named, each scoped strictly to
  `team==='US'` (Egypt never touched) and fail-open (every holiday check
  is wrapped so a bad date computation reads as "not a holiday" rather
  than throwing — it can never silently suppress a REAL alert for
  everyone): the twice-daily overdue self-nag (`considerForNag`, checked
  against `nToday`, this block's own already-computed run date); the
  Tier-3 "Inactive since…" flag (checked against the WHOLE look-back
  window `{cutoffDateStr, today2}` via `anyUsHolidayInRange()` — same
  reasoning the existing leave-window check already uses: a holiday
  anywhere in that window legitimately explains no login/no completed
  work for the whole stretch, not just a single day); the weekday-morning
  daily-task reminder (checked against `cairo.dateStr`, this block's own
  already-computed run date — confirmed by direct reading that 07:00 UTC
  is already past the US-Eastern midnight boundary, so the UTC/Cairo
  calendar date and the real US calendar date always agree at this send
  time, no second "US local date" needed). Deliberately NOT extended to
  Tier-2 "Manager/admin overdue (5+)" escalation or the owner/focus
  digests — the ticket named exactly 3 behaviors, and scope-creeping into
  the others wasn't asked for; flagged here, not silently done.
  **(2) Overview calendar**: both portals' "My Roadmap" month-grid
  calendar (`_myRoadmapCalendarHtml()`, embedded in index.html's Overview
  page and user.html's own My Roadmap) now marks a US-holiday date with a
  highlighted cell + an explicit "🇺🇸 `<Holiday Name>` (US holiday)" label
  — labeled "(US holiday)" specifically (not just colored) since this
  calendar has no per-viewer team scoping of its own, so an Egypt-team
  admin/employee viewing the same calendar is never left to infer it's a
  day off for everyone. Read-only, computed on the fly from
  `isUsHolidayDate()` — nothing stored.
  **(3) Time Off Ledger**: one shared, read-only "🇺🇸 `<year>` US Paid
  Holidays" card (not one row per employee — the SOP's 7 holidays apply
  identically to the whole US team, not as a per-person allowance),
  explicitly captioned "not stored in the ledger and not deducted from
  the 9 vacation / 5 sick days" — computed fresh every render from
  `usHolidaysForYear()`, never reading or writing `ops_time_off_ledger`.
  `index.html`'s Admin Time Off Ledger page gets this unconditionally
  (`#usHolidaysCard`, filled by `_renderUsHolidaysCard()`, since that page
  manages the whole mixed-team roster); `user.html`'s own "My Requests
  History" list shows it only when `currentUser.team==='US'` (US team
  only, per the ticket) — an Egypt-team employee sees nothing new there.
  **(4) Team-aware caption**: the Admin Ledger's header caption (was a
  hardcoded "6 sick days + 15 vacation days per year," never reflecting a
  US-team viewer's real 9/5 entitlement) and a new caption line under
  user.html's own balance box are both now computed by a shared
  `_timeOffCaptionFor(person)` helper (hand-duplicated per rule #3),
  pulling from `TIME_OFF_ENTITLEMENT`/`TIME_OFF_ENTITLEMENT_US` directly —
  never hardcoded. A US viewer reads "9 vacation + 5 sick + 7 paid
  holidays days per year"; Egypt reads "15 vacation + 6 sick days per
  year" with no holiday mention at all. In `index.html` "the viewer" is
  the currently signed-in admin (`_myAdminTeam()`, a fresh lookup by
  email every render, never cached) — the ADMIN'S own team, since that
  page's header addresses whoever's looking at it, not any one employee
  in the roster below it.
  Verified with a new 5-check `node:test` suite against the real,
  unmodified cron exports (no live Supabase/Resend access per rule #11 —
  a fake in-memory Supabase client + `node:test`'s `mock.module` for
  `lib/supabaseAdmin.js`, `RESEND_API_KEY` deliberately left unset so
  `insertNotifications()`'s own email-send branch never engages, no mock
  needed there): the full 2026 holiday list including the exact Nov 26/27
  Thanksgiving pair and the literal unobserved Jul 4 Saturday; the
  calculator also produces 7 valid dates for 2027 (year-independence);
  `isUsHolidayDate()`/`anyUsHolidayInRange()` fail open on blank/garbage
  input; a full end-to-end run of the real, unmodified handler at a fixed
  `Date` of Nov 26 2026 19:00 UTC (one of the two self-nag hours) with a
  US-team and an Egypt-team person both carrying 5 overdue tasks each —
  confirms exactly ONE nag notification is inserted, to the Egypt person
  only; a second end-to-end run one day earlier (Nov 25, a non-holiday
  weekday) confirms the SAME US-team person IS nagged then — proving the
  suppression is genuinely date-specific, not a blanket "US team never
  nagged" bug. Confirmed via `git stash` that 4 of these 5 checks fail
  against the pre-fix code (the calculator/predicate exports don't exist
  yet, and the real Nov-26 nag-suppression case fails exactly as
  reported) — the 5th (the non-holiday regression case) necessarily
  already passed either way, since nothing about that date path changed.
  Plus a new Playwright suite against the real, live-served `index.html`/
  `user.html`: the Admin Ledger caption reads the full "9 vacation + 5
  sick + 7 paid holidays" for a US-team viewer and correctly reverts to
  "15 vacation + 6 sick" (no holiday mention) for an Egypt-team viewer on
  the SAME page with no reload; the `#usHolidaysCard` lists all 7 2026
  holidays including Thanksgiving; the My Roadmap calendar, paged to the
  real Nov-26/27-Thanksgiving year, shows the "(US holiday)" label on
  both cells; user.html's own balance box shows the matching US caption
  and its ledger list shows the virtual holiday card for a US-team
  employee, while an Egypt-team employee sees neither the holiday
  mention in the caption nor the card at all; zero JS errors. Confirmed
  via `git stash` that this exact suite fails against the pre-fix code
  (`#ptoLedgerCaption`/`#usHolidaysCard` don't exist yet — a `null`
  `textContent` read throws) and passes clean after. `node --input-type=
  module --check` (rule #9) clean on `api/cron-overdue-check.js`; inline-
  JS syntax clean on both HTML files; div-balance unchanged vs. baseline
  on both (`index.html` delta -2, `user.html` delta -1 — the one new
  static `<div id="usHolidaysCard"></div>` is self-closing on one line,
  net zero imbalance; every other change is pure JS). Held per rule #10
  — touches `api/cron-overdue-check.js`'s live suppression logic, even
  though every change is additive (narrower suppression scoped to
  `team==='US'` only) and no data write/schema change is involved.
- PR #499's reported "ledger shows empty/full balances" root-caused to a
  pre-existing `sw.js` defect, NOT PR #499 itself — PR #499 was wrongly
  suspected and rolled back in production (2026-11-17 — held for preview
  approval, `sw.js` only, no HTML/JS app-logic touched): reported live —
  after #499 deployed, the admin Time Off Ledger showed full balances
  (0 used) and an empty history list; a normal browser refresh stayed
  broken, only a hard refresh fixed it; production was rolled back to
  #498. Investigated both of the ticket's own named hypotheses rather
  than picking one on the ticket's own framing alone (rule #7):
  **Hypothesis A (a runtime throw in `renderAdminTimeOffLedger`/
  `renderMyTimeOffLedger`/`_renderUsHolidaysCard`/`usHolidaysForYear`)
  — ruled out.** Re-ran both of #499's own verification suites
  unmodified against the real functions on `main` (post-#499) with no
  changes needed: the 5-check `node:test` suite (holiday calculator +
  the real end-to-end cron handler) and the Playwright UI suite (the
  real `renderAdminTimeOffLedger()`/`renderMyTimeOffLedger()` against
  fixture ledger data) both re-ran clean — the caption, the holidays
  card, and the real balance/history rendering all work correctly
  against realistic data, with no throw anywhere in that call chain.
  Also confirmed directly: `_myAdminTeam()`/`_timeOffCaptionFor()`/
  `_renderUsHolidaysCard()`/`usHolidaysForYear()` are all pure,
  defensively-guarded reads (`||[]`/`?.`/early-return-if-element-
  missing) with no code path that throws on a missing/malformed admin
  or ledger record, and every new identifier (`usHolidaysForYear`,
  `isUsHolidayDate`, `_nthWeekdayOfMonth`, `_lastWeekdayOfMonth`,
  `_usHolidayDs`, `_myAdminTeam`, `_renderUsHolidaysCard`,
  `_timeOffCaptionFor`) is declared exactly once in `index.html` — no
  duplicate-declaration class of bug (the PR #467 precedent) either.
  **Hypothesis B (a stale-asset issue from the PWA service worker) —
  CONFIRMED, and it's a real, independently-reproducible, pre-existing
  defect `sw.js` has carried since the original PWA PR (#480) — `git log
  --follow -- sw.js` confirms PR #499 never touched this file at all, so
  this bug was always there, #499 just happened to be the deploy that
  exposed it live.** `sw.js`'s navigation handler was already correctly
  network-first (`fetch(req).then(res => {cache.put...}); return res`)
  — but a bare `fetch(req)` uses the request's own DEFAULT cache mode,
  which asks neither the browser's own HTTP cache NOR any cache sitting
  between the browser and origin (a CDN edge, which is exactly what sits
  in front of a Vercel deployment) to bypass itself. A plain reload can
  then keep getting an edge's last-cached copy of the app shell
  indefinitely after a deploy, with this "network-first" branch never
  actually reaching genuinely fresh content — only a hard refresh (whose
  browser-generated request carries its own `Cache-Control: no-cache`)
  breaks through, exactly matching the reported asymmetry. Ruled out one
  candidate mechanism directly before landing on this one (rule #7, not
  guessed): a plain Chromium browser-disk-HTTP-cache model (a bare Node
  server, `Cache-Control: max-age=3600`, no CDN layer) did NOT reproduce
  staleness on a plain reload — Chromium's own navigation-reload fetch
  already revalidates against a bare origin regardless of the SW's own
  cache option, so the browser's OWN disk cache isn't the mechanism on
  its own; a CDN-edge-shaped model (a request without a no-cache
  directive gets the edge's last-cached snapshot; one with it gets the
  true current content and refreshes the edge) DID reproduce it exactly,
  which is the realistic shape of what sits between a browser and a
  Vercel deployment. **Fix**: `fetch(req, { cache: 'no-store' })` on the
  navigation branch only (the opportunistic re-cache-for-offline-fallback
  logic right after it, and every other branch — fonts, same-origin
  static assets — are completely untouched, still cache-first by
  design). Also bumped `CACHE_VERSION` (`v1`→`v2`) — required for the fix
  to ever reach an already-visiting browser at all: this file's own
  update-detection is a byte-comparison of `sw.js` itself, and since
  `sw.js` was never touched by #499, no already-installed SW was ever
  offered an update through the existing banner/`skipWaiting()` flow in
  the first place; bumping it here is what makes THIS fix (and any
  future `sw.js` fix) actually deployable to existing visitors via that
  same, unchanged mechanism — not a new mechanism of its own. Verified
  with a new reproduction+fix test against the real, unmodified files: a
  real Service Worker registration (not a mock) driving a CDN-edge-
  shaped local test server — the pre-fix `sw.js` (fetched via `git show
  HEAD:sw.js`, written to a scratch file) serves the OLD content on a
  plain `page.reload()` after the origin's content changes (reproducing
  the exact reported bug); the fixed, current working-tree `sw.js`
  serves the NEW content on that SAME plain reload, no hard refresh
  needed, zero page errors. `node --check` clean on `sw.js`. No HTML/JS
  app file touched — index.html/user.html are byte-identical to #499 as
  merged; this PR does not re-introduce or re-litigate anything from
  #499 itself, since #499's own logic was never at fault. **Do NOT
  re-promote this to production until confirmed working on the Vercel
  preview** — the user's own instruction, since the whole premise of
  this fix is specifically about the gap between what works in a quick
  local check and what a real deploy-behind-a-CDN does; re-enable the
  holiday feature (currently rolled back to #498 in production) only
  once this is confirmed on the real preview URL, not merely on `node
  --check`/this session's own synthetic CDN model.
- CRITICAL: `api/ops-state.js` silently truncated `ops_tasks` at PostgREST's
  1,000-row cap — ~409 newest tasks invisible app-wide, no hard refresh
  could fix it (2026-11-18 — **merged**, PR #501, `api/ops-state.js`
  only, read-only, no data writes): reported live — `ops_tasks` had grown
  to 1,409 rows; `supabase.from('ops_tasks').select('id, data')` had no
  `.range()` at all, and PostgREST (Supabase's REST layer) caps a single
  response at 1,000 rows regardless of how many rows actually match, with
  no error, no `Content-Range` surfaced to this code — nothing. Confirmed
  exactly as reported: the ~409 newest tasks (whatever ordering the
  underlying table happened to return with no explicit `.order()`, in
  practice close to insertion order) were silently dropped from every
  single client's snapshot, which is why recently-created tasks never
  appeared for anyone and why a hard refresh couldn't help — the server
  itself never had them to begin with. Fixed generically, not by raising a
  hardcoded limit (which just moves the same cliff further out and
  reintroduces this exact bug the next time row count crosses it): a new,
  reusable `fetchAllRows(makeQuery, applyOrder)` helper pages through
  `.range(offset, offset+999)` in 1,000-row chunks, concatenating, until a
  page comes back shorter than 1,000 rows — the one terminal condition
  that's correct both when the final page is genuinely partial and when
  the table's true row count happens to be an exact multiple of 1,000 (the
  last page is then legitimately empty). `applyOrder` is a required
  parameter, not optional — pagination with no deterministic ordering can
  skip or duplicate rows if the table is written to between page
  fetches — every call site orders by that table's own stable primary key
  (`id`, per the document-model convention, rule #5), except
  `ops_summaries`, which has no single `id` column at all (it's keyed by
  `client_id, kind, period_key`) and orders by all three composite-key
  columns together instead, never guessed as a single column. Applied to
  `ops_tasks` (the urgent, actually-reported case) and, per the explicit
  instruction to paginate rather than patch the one symptom, to every
  other unbounded `.select()` in this file that could realistically cross
  1,000 rows later: `ops_clients`, `ops_messages`, `ops_time_off_ledger`,
  `ops_commissions`, `ops_roadmap_tasks`, `ops_payroll`, `ops_summaries`,
  `ops_sales_funnel`. Deliberately NOT touched: every query that's already
  intentionally bounded on purpose, not just unbounded-and-lucky —
  `ops_feed` (two queries, `.limit(300)`/`.limit(50)`, both already
  ordered), `ops_notifications` (`.limit(200)`, already ordered) — and
  every table not named in the report that has no realistic path to 1,000+
  rows yet (`ops_users`, `ops_admins`, `ops_goals`, `ops_settings`,
  `ops_deleted_user_ids`, `ops_org_nodes`, `ops_org_links`,
  `ops_catalog_suggestions`, `ops_time_off_requests`) — flagged, not
  silently assumed safe forever: any of these could need the same
  treatment once it grows past 1,000 rows, same as `ops_tasks` just did.
  The existing per-table error-isolation pattern (a failed query degrades
  to `null`/`[]` for just that one section rather than 500ing the whole
  endpoint — see the `ops_org_links.deleted_at` outage write-up) is
  unaffected — `fetchAllRows()` returns the identical `{data, error}`
  shape a plain query result has, so the downstream `namedQueries`
  error-check loop needs no change and still works the same for a
  paginated table as an unpaginated one. Verified with a new 4-check
  `node:test` suite against the real, unmodified exported `handler()`
  (fake in-memory Supabase client that itself enforces PostgREST's real
  1,000-row-per-request cap — including on a `.range()` request wider
  than 1,000, so the test can't accidentally pass by requesting one giant
  range instead of genuinely paginating — no live Supabase access per rule
  #11): a 1,409-row `ops_tasks` fixture returns all 1,409 rows through the
  real handler, not 1,000; the single open task assigned to Michael at the
  very end of that set (the real newest row, past the old 1,000-row
  cliff) is present and resolves correctly; a direct control proves the
  fake client's 1,000-row cap is real (an unpaginated select on the same
  dataset is capped at exactly 1,000, same mechanism as live PostgREST);
  the composite-key `ops_summaries` table pages correctly too (1,250-row
  fixture, all returned, ordered by `client_id`/`kind`/`period_key`
  together). Confirmed via `git stash` that 3 of these 4 checks fail
  against the pre-fix code, reproducing the exact reported bug (the
  summaries check reads exactly 1000, not 1250 — the real PostgREST cap).
  `node --input-type=module --check` (rule #9) clean. No HTML touched, so
  no div-balance check applies. Held per rule #10 — touches
  `api/ops-state.js`, the single server-side read-snapshot assembler every
  tier/portal depends on — even though this is a pure read-path fix with
  no data write, no schema change, and no change to what any tier is
  allowed to see, only to how completely it's fetched.
- "Due" tiles made honest — true windows, done vs. not-done, both portals
  (2026-11-19 — held for preview approval, `user.html`+`index.html`,
  display-only, no data writes, no load-time mutation): reported live —
  `user.html`'s My Services "Due This Week"/"Due This Month" tiles
  (`as-due-week-count`/`as-due-month-count`) actually counted a rolling
  7/30-day window (`isMonth = due<=today+30d`), not the calendar week/
  month, and blended Done and not-Done services into one number.
  **user.html fix**: relabeled to the true windows — "Due in 7 Days"/
  "Due in 30 Days" — and added a sub-line under each tile
  (`as-due-week-sub`/`as-due-month-sub`) breaking the same total into
  "✅ N done · ⏳ M to do," never dropping the Done ones. The underlying
  rolling-window MATH itself (`in7s`/`in30s`, unchanged) was NOT touched —
  only the label now matches what it's always counted, and the done/to-do
  split is additive. New `dueWeekDone`/`dueMonthDone` counters, incremented
  alongside the existing `dueWeekCount`/`dueMonthCount` wherever a Tracker-
  sourced service (`hasStatus:true`) is already Done
  (`_svcStatus(s)==='done'`) — the SAME signal the service row's own
  status dropdown already shows as "Done" (`_myWorkStatusCell()`). An
  index.html-sourced recurring service or a bundle/project assignment
  (`hasStatus:false`) has no Done concept in this view at all — the row
  itself already renders a plain "—" for those (`_myWorkStatusCell()`'s own
  comment) — so those are honestly counted as not-done here too, never
  silently dropped from either bucket.
  **index.html investigation (rule #7 — flagged rather than guessed)**:
  searched exhaustively for an equivalent admin-side tile with the same
  bug and found none — every "Due This Week"/"Due This Month"-labeled
  thing already in `index.html` was already correct: Client Health's
  "Due This Month" card is genuine calendar-month and already its own
  separate status bucket (not blended with Done); the Overview "Tasks by
  Urgency"/"Services by Urgency" segmented bars' "Due this week"/"Due this
  month" legend rows (`OV_URGENCY_BUCKETS`/`_ovDueWindowBucket()`) already
  use real Monday-anchored calendar weeks/real end-of-month boundaries
  (`_ovWeekMonthBoundaries()`), not a rolling window. Flagged back to the
  user rather than force-fitting the fix onto the wrong tile; the user
  confirmed the intended admin-side target was actually those same
  Urgency bars — not because they mislabel the window (they don't), but
  because they silently EXCLUDE every Done item from the bar entirely
  (by design, per their own "Open (not done)" header), which is exactly
  the "don't drop the Done ones" problem from a different angle. Since
  these bars are explicitly open-only BY DESIGN (their total is
  guaranteed to equal the open-item count by construction, per the
  function's own pre-existing comment), splitting each existing segment
  into done/not-done was not an option without breaking that invariant —
  asked again, and the user chose to add Done as its own 5th bar segment
  rather than a sub-caption or a scope-cut to Client Health instead.
  **index.html fix**: `OV_URGENCY_BUCKETS` gained a 5th bucket,
  `{key:'done', label:'Done', color:'#22A06B'}` (matches `--green`, the
  same color this app's Done status already uses everywhere else, e.g.
  `user.html`'s `SERVICE_STATUSES`). Services bar: the existing
  `filteredServices.forEach` loop's `if(_svcStatus(s)==='done') return;`
  early-exit (which silently dropped Done services from the bar) was
  changed to count into a new `svcUrgDone` instead of skipping — every
  service in `filteredServices` now lands in exactly one of the 5
  buckets, so the bar's total now equals `svcTotal` (ALL filtered
  services) rather than just the open subset. Tasks bar: reused
  `totals.tasksDoneAllTime` directly — the SAME roster-scoped, all-time
  per-person sum (`tasksDoneItems`, already computed in the existing
  per-person loop) every other segment on this bar already draws its own
  numbers from (`tasksOverdue`/`tasksDueThisWeek`/etc. all come from that
  same `sum.tasksForPerson` corpus), so the new Done segment is the exact
  same population as the bar's other 4 segments, not a differently-scoped
  number bolted on — no new per-item loop needed for tasks. Deliberately
  did NOT reuse `totals.servicesDone` for the services bar's Done segment
  — that total sums over `allServices` (unfiltered), while every other
  segment on this specific bar reads `filteredServices` (frequency-
  filtered); mixing the two would put a differently-scoped number into
  the same bar, so `svcUrgDone` is computed fresh, in the same loop, over
  the same `filteredServices` corpus the other 4 segments use. Both
  cards' header text updated from "Open (not done) tasks/services" to
  "All tasks/services, including Done," and `_renderOverviewUrgencyDonut`'s
  total label changed from "`${total} open`" to "`${total} total`" — both
  now honest about what the bar actually contains. No drill-down/onclick
  wiring exists on these bar segments/legend rows at all (hover-only,
  via a `title` attribute) — the new Done segment needed none either.
  Verified with a new Playwright suite against the real, unmodified
  `loadMyAssignments()` (`user.html`) and `renderTeamProductionAnalytics()`
  (`index.html`), both served statically with no live Supabase per rule
  #11: `user.html` — a 3-service fixture (one due-in-3-days not-done, one
  due-in-20-days Done, one overdue not-done) confirms the tiles now read
  "Due in 7 Days"/"Due in 30 Days" (not the old "Due This Week"/"Due This
  Month"), the week count is 2 with sub-line "✅ 0 done · ⏳ 2 to do," and
  the month count is 3 with sub-line "✅ 1 done · ⏳ 2 to do"; `index.html`
  — a fixture with one not-done service, one Done service, one open task,
  and one Done task confirms both bars now render a "Done" legend row
  (count 1 each) and bar segment, and both totals read "2 total" (not the
  old "1 open"). Confirmed via `git stash` that both suites fail against
  the pre-fix code exactly as expected (user.html: the new sub-line
  elements don't exist yet; index.html: no "done" legend row/segment at
  all, totals still read "1 open") and pass clean after. `node --check`
  on extracted inline JS clean on both files; div-balance unchanged vs.
  baseline on both (`index.html` delta -2, `user.html` delta -1 — pure JS/
  text-content changes, no HTML markup structure altered). No `api/*.js`
  touched, so rule #9's module-mode check doesn't apply. Held per rule
  #10 out of caution even though this is a pure display-only change with
  no data write and no load-time mutation.
- Open — Phase 2: deferred `salesFunnelLevel`/`earnsCommission` edit-payload
  exclusion (now unblocked by #400); transcript-truncation intake loss;
  assignment-email rate-limiting; error-log pruning (broken `archived_at`
  column) + capture-size cap; W1 fire-and-forget (67/70 admin writes don't
  confirm the server before showing success). Phase 3: report-flag data
  repair (4 tasks + the blog-posts task). Hygiene — feed/session retention
  windows: addressed 2026-11-04, see that entry above (pending the user's
  own dry-run + migration-applied confirmation before merge).

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
- **Merge `main` into an open PR branch only via rebase, never a merge
  commit, when two open PRs touch the same lines.** A plain merge lets
  git silently keep BOTH sides of a conflicting edit to the same
  statement (e.g. two different rewrites of the same `const` line) with
  no conflict marker to catch, producing a duplicate declaration that's
  a hard ES-module `SyntaxError` — this exact mechanism broke `main` on
  2026-10-14 (PR #467) when PR #464's branch was updated by merging
  `main` (which already carried PR #463's rewrite of the same block)
  instead of rebasing. See rule #9's module-mode `node --check` addendum
  above — the fix for both the symptom and the detection gap.

---

**Historical decision log: see `DECISIONS.md`.**
