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
- Don't send emails to inactive users (2026-10-15 — held for preview
  approval, `lib/`): deactivated employees kept receiving Ops Hub emails
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
