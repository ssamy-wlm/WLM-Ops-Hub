import Anthropic from '@anthropic-ai/sdk';
import { logError } from '../lib/errorLog.js';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession, tierOf } from '../lib/opsSession.js';
import { clampToWeekday } from '../lib/dateUtils.js';
// Meeting-parse task/service auto-update+notify (2026-09-16) — only these
// two exports are imported, deliberately never getDirectory()/
// insertNotifications() directly (see their own call sites below):
// getDirectory()'s module-level _directoryCache is a PER-REQUEST cache
// that api/ops-sync.js's own handler resets at the top of every request
// (line ~1454) — but that handler never runs inside this file's own
// serverless function (api/process-transcript.js is a completely
// separate Vercel function; the two never share a warm container), so
// nothing would ever reset that cache here, risking a stale roster
// persisting across many /api/process-transcript invocations on a warm
// container. applyMeetingParseTaskStatusUpdate() and
// fireMeetingParseNotifyEvents() both take an explicit {users, admins}
// (this file's own already-fresh activeRoster(), split by kind — see the
// call sites below) instead of fetching internally, so no cross-module
// caching risk is introduced. insertNotifications() itself still calls
// getDirectory() internally for its own quiet-hours team lookup — an
// opts.directory override was added there (2026-09-16) specifically so
// fireMeetingParseNotifyEvents() can pass this file's own fresh roster
// through instead, sidestepping that one remaining internal call too.
import { applyMeetingParseTaskStatusUpdate, fireMeetingParseNotifyEvents } from './ops-sync.js';

const VALID_CATEGORIES = ['hr','finance','security','systems','production','clients','personal','operations','marketing','sales'];

// ── Task Assignments / Daily Tasks email-parsing mode (mode:'taskEmail' in
// the request body) — a completely separate feature from the Roadmap
// meeting-transcript extractor above/below, sharing this file only because
// this app is capped at 12 serverless functions (Vercel Hobby plan) and
// this was the closest existing "paste text, get structured JSON back from
// Claude" endpoint. Unlike the Roadmap mode (an optional, loosely-checked
// static API key), this mode requires a REAL signed ops session — every
// caller (admin or employee) must be logged in, since the extracted tasks
// get written into ops_tasks via api/ops-sync.js under that same identity.
// The Roadmap mode's own request handling below is completely untouched. ──
const TASK_CATEGORIES = ['Production', 'Updates', 'Sales', 'Admin', 'Other', 'Invoices/Payments'];
const TASK_PRIORITIES = ['Urgent', 'High', 'Normal', 'Low'];

// Built fresh per request from the LIVE active roster (see activeRoster()
// below) — deliberately NOT a static list of example names baked into the
// prompt. A stale hardcoded roster is exactly the failure mode the Roadmap
// mode's own SYSTEM_PROMPT below has (a fixed "sarah/david/emily/jacob/
// rania" example list) — someone hired or renamed after this file was last
// edited would never be extractable as an owner. Every call rebuilds this
// list from ops_users/ops_admins, so it can never drift from who's actually
// on the team right now.
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// A reference date is required for relative-language resolution ("by
// Friday", "next week", "end of month") — the model has no other way to
// know what day "today" is. Computed fresh per request from the real
// clock, never hardcoded — this is plain server-side Date usage (not a
// Workflow script, where Date.now()/new Date() are restricted). Passed in
// by the caller (rather than computed here) so handleTaskEmailMode can
// reuse the exact same todayIso as the assignedDate fallback below —
// one clock read per request, not two that could disagree across a
// millisecond boundary.
function buildTaskEmailSystemPrompt(rosterDisplayList, todayIso, clientNames) {
  // todayIso is itself a UTC calendar date (see handleTaskEmailMode), so
  // forcing UTC here keeps the reported weekday consistent with it —
  // never `new Date(todayIso)` alone, which parses as UTC midnight but
  // would report a LOCAL weekday, silently mismatching on this server.
  const weekday = WEEKDAY_NAMES[new Date(`${todayIso}T00:00:00Z`).getUTCDay()];
  return `You extract action items from an email or pasted transcript for a small marketing agency called Weblight Media, for a work-tracking tool. The text may be a raw .eml file (with visible headers like From/Subject/Date) or a plain pasted email/transcript.

Today's real date (the day this text is being parsed, NOT necessarily the date the text itself is about) is ${todayIso} (a ${weekday}).

First, determine the "assignedDate" for this text AS A WHOLE — the date the meeting, transcript, or email was itself dated, which can be well before today's real date above (e.g. an old meeting transcript pasted in days later). Look for a meeting/transcript header or title carrying a date (e.g. "Meeting — June 8", "Standup 8/18"), an email "Date:" header, or an explicit phrase like "as of 8/18" or "on 8/18". If a year isn't stated, assume whichever year makes the date most recent without landing AFTER today's real date, unless the text clearly implies otherwise. If you cannot find any such date anywhere in the text, use today's real date (${todayIso}) as the assignedDate instead — every parse must produce one, never leave it blank. Every task extracted from this text shares this SAME assignedDate.

Also determine "attendees" for this text AS A WHOLE — the names of everyone who attended the meeting or is on the email thread, if the text has a roster/attendee line (e.g. "Attendees: Sarah, David, Michael", "In attendance: ...", "Present: ...", a "To:"/"Cc:" header listing multiple people, or a list of names right under the meeting title). Return every name you find as a single comma-separated string (e.g. "Sarah, David, Michael") — empty string if the text has no such list anywhere. This is used ONLY for tasks explicitly assigned to "the group"/"the team"/"everyone" below, never applied to a task that already names a specific person.

For EACH distinct task or action item you find:
- "subject": a concise one-line summary (under 12 words).
- "notes": any additional relevant detail from the text (can be empty string).
- "tags": an array of short relevant keyword strings (can be empty array).
- "category": exactly one of ${JSON.stringify(TASK_CATEGORIES)} — "Invoices/Payments" for billing/invoice/payment items, "Other" only if truly nothing else fits.
- "priority": exactly one of ${JSON.stringify(TASK_PRIORITIES)} — infer from urgency language, default "Normal" if unclear.
- "dueDate": an ISO YYYY-MM-DD date, resolved relative to the ASSIGNEDDATE you determined above, not today's real date, since the text may have been written well before it's parsed. First look for explicit or relative due-date language: "by <weekday>" or "this <weekday>" means the very next occurrence of that weekday counting from the assignedDate (the assignedDate itself if the assignedDate IS that weekday); "next <weekday>" means that weekday in the week AFTER the assignedDate's own week (never the same week, even if that day hasn't happened yet within it); "next week" means the Monday of the week following the assignedDate; "end of month"/"end of the month" means the last calendar day of the month the assignedDate falls in; "tomorrow" means the day right after the assignedDate, "today" means the assignedDate itself; "in N days"/"in N weeks" means the assignedDate plus that many days. Example: if the assignedDate is 2026-08-18 (a Tuesday) and the text says "by end of week", that resolves to Friday 2026-08-21 — even though today's real date above may be later than that. If the text states or implies no specific timeframe at all, ESTIMATE a dueDate instead of leaving it empty, still resolved relative to the assignedDate — but pick from these four fixed urgency tiers based on the task's own nature and effort, rather than an open-ended guess, so the estimate reliably lands inside one of this app's real due-date windows (7/30/60 days, or long-term) instead of an arbitrary date:
  - "This week" — a quick, low-effort task (a short email, a phone call, a single social media post, a one-line fix): land 2-4 days after the assignedDate.
  - "Near-term" — a standard task with real but contained effort (drafting a document, a single design piece, one moderate deliverable): land 2-3 weeks after the assignedDate.
  - "Medium-term" — a bigger initiative needing multiple steps or coordination (a small campaign, a multi-page build, a project with several dependencies): land 6-8 weeks after the assignedDate.
  - "Long-term" — a large multi-phase project or open-ended initiative (a full website build, a multi-month campaign, ongoing research): land beyond 60 days after the assignedDate — no fixed maximum.
Always return a real date — only return an empty string if the "subject" itself is too vague to estimate anything from at all.
- "senderEmail": the sender's email address if the text contains one (e.g. a "From:" header), otherwise empty string.
- "senderName": the sender's display name if available, otherwise empty string.
- "recipientEmail": the primary recipient's email address if the text contains one (e.g. a "To:" header, or who a WebLight team member is writing/replying to), otherwise empty string.
- "recipientName": the primary recipient's display name if available, otherwise empty string.
- "emailReceivedDate": an ISO YYYY-MM-DD date from a "Date:" header or explicit date in the text, otherwise empty string.
- "emailThreadId": a Message-ID header value if present, otherwise empty string.
- "clientName": if this task is clearly about work for one specific client from this list: ${JSON.stringify(clientNames)}, output that client's name EXACTLY as it appears in the list. If the text has a near-miss, mis-heard, or misspelled version of a client's name (a typo, a phonetic spelling, a partial name — e.g. "surf pro" for "Servpro"), still match it to the single closest real name in this exact list — best phonetic/fuzzy match, don't require an exact spelling in the text itself. If the task is about WebLight Media's own internal work rather than a client's, and "WebLight Media (Internal)" appears in this list, use that. If genuinely no client from this list is identifiable for this task, leave this an empty string — never invent a name that isn't in the list.
- "ownerName": the specific person(s) this task belongs to. Look for an explicit assignment ("assigned to X", "X will handle this") AND per-person ownership language even without an explicit assignment verb — e.g. "X's priorities" or "X's tasks" (a list introduced this way belongs to X for every item under it), "X will …" / "X agreed to …" / "X is going to …" (a stated commitment BY X), "X shared they'll …" / "X mentioned she's going to …" (X's own intended action, even when reported by someone else). ALSO treat these STRUCTURED markers as AT LEAST as strong a signal as the prose patterns above — this is the exact format the team's own meeting-notes/Quick-Notes export uses ("Next steps: [Name] Task: …"): a task line prefixed with a person's name in brackets (e.g. "[Abby Conklin] Process payments for the Johnson account"); a "Name — task" or "Name: task" prefix (e.g. "Sherine — Follow up with the client" or "Michael: Update the sales deck"); or a bulleted/listed task appearing directly under a heading or line that names a person (e.g. a "Next steps" section where every following "[Name] ..." line belongs to that same named person). In every one of these structured-marker cases, that named person owns the task — this is never weaker evidence than the prose patterns, and should be treated as at least as decisive.
  ALSO treat any layout where a row/entry has a dedicated assignee field as equally strong evidence, not just inline prefixes — this covers markdown/table rows with an "Assignee"/"Owner"/"Name" column, and a labeled "Assignee: Name" field on its own line. Two examples:
  Example A (markdown table — the "Assignee" column value is that row's ownerName):
  | Assignee | Task | Due |
  |----------|------|-----|
  | Michael | Update the sales deck | Friday |
  | Sarah, Rana | Review the new client proposal | next week |
  → row 1 has ownerName "Michael"; row 2 has ownerName "Sarah, Rana" (both own it — see the multi-name rule below).
  Example B (labeled field on its own line):
  Task: Renew SSL certificate
  Assignee: David
  Due: Friday
  → ownerName "David".
  If MULTIPLE names appear together for one task/row (e.g. "Michael, Sarah" in a table cell, or "David, Sarah, and Rana" in prose), output ALL of them together as one comma-separated string in ownerName (e.g. "Michael, Sarah") — every one of them owns this task, not just the first.
  In every case (prose, structured marker, table/field, or multi-name), use each person's name EXACTLY as it appears (the part before " — ", their title is shown after it only to help you tell people with the same role apart) in this list: ${JSON.stringify(rosterDisplayList)}. If the text has a near-miss, mis-heard, or misspelled version of a name on this list (e.g. "Shereen" or "Shireen" for "Sherine"), still match it to the single closest real name in this exact list — best phonetic/fuzzy match, don't require an exact spelling in the text itself. Only leave this an empty string if genuinely no name on the list is a reasonable match — a task carrying one of the structured markers or a dedicated assignee field above should almost never end up with an empty ownerName, since the marker/field itself already names the person. Never invent or guess a name that isn't in this exact list, and never use a role/title in place of a name — if the text names a role but not a specific person ("someone from production"), leave this empty rather than picking a name. Leave this empty (rather than guessing) whenever "groupOwner" below is true for this task.
- "groupOwner": true ONLY when the text explicitly assigns this task to the whole group/team collectively rather than a specific person — e.g. "the group will follow up on this", "everyone needs to submit their timesheets", "the team agreed to review the proposal", "assigned to the whole team". false otherwise, including whenever "ownerName" already names one or more specific people (a task never has both).
- "alreadyDone": true if the text itself says this specific item is already finished/sent/completed (e.g. "already posted the update", "done", "sent yesterday"), false otherwise. Only true when the text says so explicitly for THIS item — never infer completion just because a task sounds simple or routine.

If the text contains no actionable task at all, return an empty tasks array — do not invent one.

Separately from "tasks" above (which is only for brand-new action items), also extract "existingItemMentions" — an array capturing any place the text reports on the STATUS of something that already exists, rather than assigning new work. For EACH such mention:
- "itemType": "task" if it sounds like a specific work item someone was tracking (a to-do, a follow-up, a piece of work someone was assigned), or "service" if it sounds like an ongoing/recurring client service or deliverable (e.g. "the SEO package", "their monthly report", "hosting").
- "mentionSubject": a short description of the item, as close as possible to how the original task/service is likely titled (e.g. "Homepage redesign", "Q3 report").
- "clientName": if the item is clearly about work for one specific client from this list: ${JSON.stringify(clientNames)}, output that name EXACTLY as it appears in the list (same matching rules as "clientName" above). Empty string if unclear or not client-specific.
- "personName": whose item this is — the person it's assigned to / responsible for it, matched against this same roster: ${JSON.stringify(rosterDisplayList)} (same matching rules as "ownerName" above, including phonetic/fuzzy tolerance and stripping any " — Title" suffix). Empty string if not stated or not identifiable.
- "attributedTo": who is SPEAKING about this item's status in the text — who said it's done or in progress. Often the same person as "personName" (someone reporting on their own work), but can be a different person (e.g. a manager reporting on someone else's status). Matched against the same roster. Empty string if the speaker genuinely cannot be identified from the text at all.
- "impliedStatus": "done" if the text says this item is finished/completed/shipped/wrapped up, "in-progress" if it says it's started/underway/in progress, empty string if the item is mentioned but no clear status is implied.
Only include a mention here when a status is actually implied AND you're reasonably confident it refers to something that already exists (not a brand-new task) — skip anything vague, ambiguous, or where you can't tell whose item it is. It's fine for this array to be empty; most transcripts won't have any of these.

Return ONLY valid JSON, no markdown, no explanation:
{"assignedDate":"YYYY-MM-DD","attendees":"","tasks":[{"subject":"...","notes":"...","tags":[],"category":"Production","priority":"Normal","dueDate":"","senderEmail":"","senderName":"","recipientEmail":"","recipientName":"","emailReceivedDate":"","emailThreadId":"","clientName":"","ownerName":"","groupOwner":false,"alreadyDone":false}],"existingItemMentions":[{"itemType":"task","mentionSubject":"...","clientName":"","personName":"","attributedTo":"","impliedStatus":"done"}]}`;
}

// A malformed or out-of-range date from the model must never reach storage
// or the sort below as if it were real — dropped to '' (same as "no due
// date mentioned") rather than crashing or silently corrupting the sort.
function validDueDate(value) {
  const m = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  // Date silently ROLLS OVER an out-of-range day/month (e.g. "2026-02-30"
  // becomes March 2) instead of producing an invalid Date — checking
  // getTime() alone would let that corrupted value through as if it were
  // real. Round-tripping the components back out and comparing catches it.
  const roundTrips = d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  return roundTrips ? value : '';
}

// Live, active-only roster (users + admins together — an admin like Abby
// does real production work too, same combined-roster convention as
// index.html's _timeOffRoster()/loadTaskAssignments() assignee dropdown).
// Fetched fresh every request; never cached across requests, unlike the
// per-request _directoryCache pattern in api/ops-sync.js (this is a single
// short-lived serverless invocation, not a warm-instance-reused module).
//
// Also includes the primary admin (Sarah Samy) — she has no row in
// ops_users/ops_admins at all (see api/ops-auth.js's PRIMARY_ADMIN_EMAIL
// branch; CLAUDE.md documents this: "a separate primary-admin login... not
// an ops_admins row at all"), so without this she could never be matched
// as a task owner. Synthesized with the exact same {id, name, ...} shape
// ops-auth.js issues her session with (id:'primary-admin'), so a task
// assigned to her resolves to the real identity her own login uses.
// A dual-role account — an ops_admins row carrying linkedUserId, pointing
// at the ops_users row for the SAME person (see index.html's "Grant
// Manager Role", api/ops-auth.js's dual-role login branch) — is ONE real
// person with ONE canonical id: their ops_users row's id, which is always
// what api/ops-auth.js puts in session.id/session.employeeId for their
// real login, regardless of their admin tier. Without folding the linked
// admin row into its user row here, that same person appeared as TWO
// separate roster candidates under two different ids — Sherine
// (adm_1784122163153, linked to her ops_users row, creative_manager) is
// the first real account built this way. That broke owner-matching two
// ways: an exact-name match could in principle land on either id (only
// "worked" for a full-name match by incidental array order, not by
// design), and a first-name-only reference to her (a very ordinary thing
// to write in one's own daily-task list) made matchOwner()'s
// unambiguous-first-name rule refuse to resolve AT ALL, since it now saw
// two roster entries sharing "Sherine". Folding to one entry (keyed by
// the canonical ops_users id) fixes both — every consumer of this roster
// (matchOwner, resolveAttendeeIds, the prompt's own roster list) needs no
// further change, since they already just operate on whatever this
// returns.
function dedupeLinkedIdentities(users, admins) {
  const adminByLinkedUserId = new Map();
  admins.forEach(a => { if (a.linkedUserId) adminByLinkedUserId.set(a.linkedUserId, a); });
  // Only marked "folded" for a user row that's ACTUALLY present in the
  // (already active-only) users array below — if the linked employee row
  // is inactive/missing while the admin row stays active (an edge case,
  // not Sherine's case today, but a real one), this must fall back to
  // showing that admin as its own normal roster entry, never disappear
  // from the roster entirely.
  const foldedAdminIds = new Set();
  const rosterUsers = users.map(u => {
    const linkedAdmin = adminByLinkedUserId.get(u.id);
    if (!linkedAdmin) return u;
    foldedAdminIds.add(linkedAdmin.id);
    // The linked admin row's title/level is real, useful context for the
    // model (e.g. "Creative Manager") — folded onto the SAME roster entry
    // as an extra display field, never as a second entry.
    return { ...u, title: u.title || linkedAdmin.title || linkedAdmin.level };
  });
  const unlinkedAdmins = admins.filter(a => !foldedAdminIds.has(a.id));
  return [...rosterUsers, ...unlinkedAdmins];
}

async function activeRoster(supabase) {
  const [{ data: userRows, error: uErr }, { data: adminRows, error: aErr }] = await Promise.all([
    supabase.from('ops_users').select('id, data'),
    supabase.from('ops_admins').select('id, data'),
  ]);
  const firstErr = uErr || aErr;
  if (firstErr) throw new Error(firstErr.message);
  const users = (userRows || []).map(r => ({ id: r.id, kind: 'user', ...r.data })).filter(u => u.status === 'active' && u.name);
  const admins = (adminRows || []).map(r => ({ id: r.id, kind: 'admin', ...r.data })).filter(a => a.status === 'active' && a.name);
  const primaryAdmin = { id: 'primary-admin', kind: 'admin', name: 'Sarah Samy', level: 'owner', status: 'active' };
  return [...dedupeLinkedIdentities(users, admins), primaryAdmin];
}

// Deterministic, same "plain code, never ask the model to guess" convention
// as matchClient() below. Exact full-name match first; otherwise a
// first-name match, but ONLY if it's unambiguous (exactly one roster member
// shares that first name) — two "Sarah"s on the roster must never resolve
// to a coin-flip.
function matchOwner(ownerName, roster) {
  const q = String(ownerName || '').trim().toLowerCase();
  if (!q) return null;
  const exact = roster.find(p => String(p.name || '').trim().toLowerCase() === q);
  if (exact) return exact;
  const byFirstName = roster.filter(p => String(p.name || '').trim().split(/\s+/)[0].toLowerCase() === q);
  return byFirstName.length === 1 ? byFirstName[0] : null;
}

// Fixed alias, by explicit decision: "Sarah" and "Sarah Samy" always mean
// Sarah Ibrahim, never the primary admin (Sarah Samy herself), even though
// she's now on the roster (see activeRoster() above) and would otherwise be
// an exact-name match for "Sarah Samy". Resolved by a live NAME lookup
// against the roster, not a hardcoded id — this file has no live DB access
// to confirm Sarah Ibrahim's real ops_users id (CLAUDE.md rule #11), and
// matching by name is already how every other person here is resolved.
// Checked BEFORE matchOwner() so it always wins for these two spellings.
const SARAH_ALIAS_NAMES = new Set(['sarah', 'sarah samy']);
function resolveOwnerAlias(ownerName, roster) {
  const q = String(ownerName || '').trim().toLowerCase();
  if (!SARAH_ALIAS_NAMES.has(q)) return null;
  return roster.find(p => String(p.name || '').trim().toLowerCase() === 'sarah ibrahim') || null;
}

// The model sometimes echoes the roster's own display format ("Name —
// Title", the exact shape activeRoster()'s title/level context uses in the
// prompt) straight into ownerName instead of a bare name — a raw
// "Abby Conklin — Production Manager" fails both resolveOwnerAlias() and
// matchOwner() (neither ever compares against anything but a bare roster
// name), so a real, in-roster person came back detected-but-unassigned.
// Strips a trailing " — Title" / " - Title" suffix — the dash must have a
// space on BOTH sides, so a real hyphenated name like "Mary-Jane" (no
// surrounding spaces around that hyphen) is left untouched — and a
// trailing parenthetical title ("Sarah Samy (Owner)"). Applied once, in
// matchOwnerWithAlias() below, so every caller (resolveAttendeeIds,
// resolveTaskOwners) gets the fix for free without touching either name
// list separately.
function stripTitleSuffix(name) {
  return String(name || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s+[—-]\s+.*$/, '')
    .trim();
}

function matchOwnerWithAlias(ownerName, roster) {
  const cleaned = stripTitleSuffix(ownerName);
  return resolveOwnerAlias(cleaned, roster) || matchOwner(cleaned, roster);
}

// Splits a name/attendee field into individual names — "Michael, Sarah",
// "David, Sarah and Rana", "Michael & Sarah" all split correctly. `\band\b`
// with word boundaries only matches the standalone word "and", never inside
// a real name like "Andrea"/"Andrew" (no word-boundary between "and" and
// the following "r"). Deterministic text splitting, not an LLM judgment
// call — same conviction as matchOwner()/matchClient() below.
function splitNames(raw) {
  return String(raw || '')
    .split(/,|;|&|\band\b/i)
    .map(s => s.trim())
    .filter(Boolean);
}

// Resolves the meeting-wide attendee list (once per parse, not per task —
// see the "attendees" prompt instruction) against the live roster, for
// "the group" tasks below to co-assign against. Deduped by id; a name that
// doesn't match anyone is simply dropped from this list (an attendee who
// isn't a real roster member can't be assigned a task anyway).
function resolveAttendeeIds(attendeesRaw, roster) {
  const ids = [];
  const seen = new Set();
  splitNames(attendeesRaw).forEach(name => {
    const p = matchOwnerWithAlias(name, roster);
    if (p && !seen.has(p.id)) { seen.add(p.id); ids.push(p.id); }
  });
  return ids;
}

// Resolves one task's owner(s) into 1+ {assigneeId, assigneeIds, ownerRaw}
// pieces — a caller then clones the task once per piece. This is where
// "co-assign" and "never silently unassign a named task" both actually
// happen:
//   - Named owner(s) present (ownerNameRaw non-empty, checked first —
//     prefers named individuals over groupOwner if a task carries both,
//     which the model shouldn't do but this makes the tie-break explicit
//     rather than undefined): each name is matched against the roster
//     (alias-first). Any names that DO resolve produce one clone per
//     resolved person, each carrying the FULL set of co-assignee ids in
//     `assigneeIds` (informational — ops_tasks itself has no multi-
//     assignee field today, so "co-assign" here means one real task per
//     named person, not one task with several owners). If NONE resolve,
//     a single clone with assigneeId:null carries the raw name(s) in
//     ownerRaw — the existing staging UI already renders "detected: X —
//     pick assignee" whenever assigneeId is null and ownerRaw is non-
//     empty (built for the single-name case, 2026-08-21), so a multi-name
//     row that fails to resolve gets the identical treatment for free.
//   - No named owner, but groupOwner is true (an explicit "the group"/
//     "the team"/"everyone" assignment — see the prompt): co-assigns to
//     every resolved meeting attendee, one clone each. If the meeting had
//     no parseable attendee list AND allowEveryone is true, a single clone
//     is returned with assigneeId:EVERYONE_ASSIGNEE_ID (2026-08-25) — the
//     staging UI pre-selects "👥 Everyone (whole team)" and clones it into
//     one real task per active member at commit time, same as picking it
//     manually. If allowEveryone is false, the pre-existing behavior is
//     kept instead: a single clone with assigneeId:null carrying the
//     literal hint text "group — no attendee list, assign manually" as
//     ownerRaw.
//   - Neither: unchanged pre-existing behavior (empty ownerRaw, assigneeId
//     null) — the caller's own scope-filter below still self-assigns this
//     to a member caller or leaves it null for an admin, exactly as before
//     this task.
//
// allowEveryone (2026-08-25): true only for a caller who'll actually see
// the Everyone option and its commit-time clone logic — index.html's real
// admin/super Task Assignments UI. Deliberately NOT the same thing as
// scope.isAdmin: a manager-tier dual-role account (e.g. Sherine) is also
// isAdmin:true in callerTaskScope (unrestricted read/write scope), but she
// only ever uses user.html's Daily Tasks, which has no Everyone dropdown
// and no clone-on-commit plumbing (by deliberate scope decision — a member/
// manager-tier employee can't assign work to the whole team) — producing
// EVERYONE_ASSIGNEE_ID for her would silently regress the self-assign
// fallback her own linked-identity fix (2026-08-25) already established
// for a name-less/no-attendee task. The caller passes
// `scope.isAdmin && !session.employeeId` — true admin-only accounts, never
// a linked employee identity, dual-role or not.
const EVERYONE_ASSIGNEE_ID = '__ALL__';
function resolveTaskOwners(ownerNameRaw, groupOwner, roster, attendeeIds, allowEveryone) {
  const rawNames = splitNames(ownerNameRaw);
  if (rawNames.length) {
    const resolved = [];
    const seen = new Set();
    rawNames.forEach(name => {
      const p = matchOwnerWithAlias(name, roster);
      if (p && !seen.has(p.id)) { seen.add(p.id); resolved.push(p); }
    });
    const ownerRaw = rawNames.join(', ');
    if (resolved.length) {
      const ids = resolved.map(p => p.id);
      return resolved.map(p => ({ assigneeId: p.id, assigneeIds: ids, ownerRaw }));
    }
    return [{ assigneeId: null, assigneeIds: [], ownerRaw }];
  }
  if (groupOwner) {
    if (attendeeIds.length) {
      return attendeeIds.map(id => ({ assigneeId: id, assigneeIds: attendeeIds, ownerRaw: 'the group' }));
    }
    if (allowEveryone) {
      return [{ assigneeId: EVERYONE_ASSIGNEE_ID, assigneeIds: [], ownerRaw: 'the whole team' }];
    }
    return [{ assigneeId: null, assigneeIds: [], ownerRaw: 'group — no attendee list, assign manually' }];
  }
  return [{ assigneeId: null, assigneeIds: [], ownerRaw: '' }];
}

// Who a non-admin caller is allowed to see/create tasks for: themselves,
// plus anyone whose configured manager (users[].managerId — the same field
// index.html's assignment-escalation notifications already read) is this
// caller. This is what makes a person other members' managerId points at
// (e.g. Rana reporting to Sherine) distinct from an individual contributor
// (e.g. Michael) with no reports: the exact same formula just yields
// {self} when nobody's managerId points at them. Admin/super tier is
// unrestricted, same as everywhere else in this app.
//
// selfId (2026-08-25): the canonical identity this caller falls back to
// when nothing else is named — session.employeeId for anyone who has a
// real employee identity (a plain member, OR a dual-role admin/manager
// like Sherine, who's ALSO a real employee via a linked ops_admins row —
// see api/ops-auth.js), otherwise this caller's own bare id (a true
// admin-only account, or the primary admin sentinel, neither of which has
// a personal "my own daily list" to fall back to). session.id is already
// this same canonical id for a member caller (ops-auth.js always sets
// session.id to the employee row's id when one exists), so selfId is
// identical to session.id there — computed once, uniformly, rather than
// duplicated per branch below.
function callerTaskScope(session, roster) {
  const tier = tierOf(session);
  const selfId = session.employeeId || session.id;
  if (tier !== 'member') return { isAdmin: true, allowedIds: null, selfId };
  const reportIds = roster.filter(p => p.managerId === session.id).map(p => p.id);
  return { isAdmin: false, allowedIds: new Set([session.id, ...reportIds]), selfId };
}

function extractDomain(email) {
  const m = /@([^\s>]+)/.exec(String(email || ''));
  return m ? m[1].toLowerCase() : '';
}

function domainOf(url) {
  const m = /^(?:https?:\/\/)?(?:www\.)?([^/\s]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : '';
}

// A client name can carry a trailing qualifier in parens (e.g. "WebLight
// Media (Internal)") that nobody actually types when writing about that
// client in plain text — stripping it gives a second, more natural string
// to check a text-mention against, without treating "(Internal)" itself as
// something a real email would ever contain verbatim.
function stripParenthetical(name) {
  return String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// Deterministic, not LLM-guessed — a wrong auto-match here would silently
// attach a task (and whatever it references) to the wrong client, so this
// stays plain code the same way every other client-matching decision in
// this app is server-side and reviewable, never "ask the model to guess."
// Checked in order, most confident first: exact email match (sender OR
// recipient — a task can equally be about something WebLight is sending
// TO a client, not just receiving from one) against the client's salvaged
// clientEmails[]/legacy clientEmail; exact name match (sender or
// recipient) against the client's own name; sender/recipient domain vs the
// client's website domain; and finally, lowest-confidence, an unambiguous
// mention of the client's name (or that name with a trailing parenthetical
// qualifier stripped) inside the task's own subject/notes text — accepted
// ONLY when it's the single client whose name appears, since a short or
// generic client name matching two different active clients at once means
// this signal isn't trustworthy for that task. No match at any step leaves
// the task unlinked — an admin assigns the client manually rather than the
// system guessing wrong.
function matchClient(task, activeClients) {
  const senderEmail = String(task.senderEmail || '').toLowerCase().trim();
  const recipientEmail = String(task.recipientEmail || '').toLowerCase().trim();
  const senderName = String(task.senderName || '').toLowerCase().trim();
  const recipientName = String(task.recipientName || '').toLowerCase().trim();
  const senderDomain = extractDomain(senderEmail);
  const recipientDomain = extractDomain(recipientEmail);

  const byEmail = (email) => email && activeClients.find(c =>
    (Array.isArray(c.clientEmails) && c.clientEmails.some(e => String(e).toLowerCase().trim() === email)) ||
    String(c.clientEmail || '').toLowerCase().trim() === email
  );
  const byName = (name) => name && activeClients.find(c => String(c.name || '').toLowerCase().trim() === name);
  const byDomain = (domain) => domain && activeClients.find(c => domainOf(c.website) && domainOf(c.website) === domain);

  return byEmail(senderEmail) || byEmail(recipientEmail)
    || byName(senderName) || byName(recipientName)
    || byDomain(senderDomain) || byDomain(recipientDomain)
    || matchClientByTextMention(task, activeClients)
    || null;
}

// Deterministic exact-match re-validation of the model's own "clientName"
// output against the SAME live active-client list handed to it in the
// prompt — the model was told to only ever output a name from that exact
// list (best-matching a near-miss spelling to the closest real one), but a
// hallucinated or slightly-off name must never silently pass through as if
// it were a real match, so this checks it against the real list rather
// than trusting the model's text at face value. This is the PRIMARY
// client-detection signal (the model sees the full pasted text, a strictly
// richer signal than matchClient()'s email/domain/text-mention heuristics
// below), checked first; matchClient() is the fallback for whatever this
// leaves empty or unmatched.
// Plain Levenshtein edit distance — deterministic, same "reviewable code,
// never an LLM guess" conviction as matchClient()/matchOwner() above.
function _levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}
function _normalizeForPhonetic(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
// Similarity ratio in [0,1], 1 = identical after stripping spaces/
// punctuation/case — e.g. "surf pro" vs "Servpro" both normalize to
// "surfpro"/"servpro" (edit distance 2 of 7 chars ≈ 0.71 similarity).
function _phoneticSimilarity(a, b) {
  const na = _normalizeForPhonetic(a), nb = _normalizeForPhonetic(b);
  if (!na || !nb) return 0;
  return 1 - _levenshtein(na, nb) / Math.max(na.length, nb.length);
}
const PHONETIC_MATCH_THRESHOLD = 0.7;

function matchClientByName(clientName, activeClients) {
  const q = String(clientName || '').trim().toLowerCase();
  if (!q) return null;
  const exact = activeClients.find(c => String(c.name || '').trim().toLowerCase() === q);
  if (exact) return exact;
  // Phonetic-tolerant fallback: the model is instructed to already
  // best-match a mis-heard/misspelled name to an exact string from the
  // live list itself (see buildTaskEmailSystemPrompt), but this
  // re-validates against the real list rather than trusting it blindly —
  // if the model still returns something close-but-not-exact, this catches
  // it deterministically instead of dropping the match. A minimum length
  // guard (same convention as matchClientByTextMention below) plus
  // requiring the best match to be unambiguous (no other client ties it)
  // keeps this from guessing on a genuinely weak signal.
  if (q.length < 4) return null;
  const scored = activeClients
    .map(c => ({ c, score: _phoneticSimilarity(q, c.name) }))
    .filter(x => x.score >= PHONETIC_MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  return (scored.length === 1 || scored[0].score > scored[1].score) ? scored[0].c : null;
}

function matchClientByTextMention(task, activeClients) {
  const text = `${task.subject || ''} ${task.notes || ''}`.toLowerCase();
  if (!text.trim()) return null;
  // A minimum length guards against a short/generic client name (e.g. an
  // acronym) matching all over unrelated text.
  const candidates = activeClients.filter(c => {
    const full = String(c.name || '').toLowerCase().trim();
    const stripped = stripParenthetical(c.name).toLowerCase();
    return (full.length >= 4 && text.includes(full)) || (stripped.length >= 4 && stripped !== full && text.includes(stripped));
  });
  return candidates.length === 1 ? candidates[0] : null;
}

const STOPWORDS = new Set(['a','an','the','to','for','of','on','in','and','or','with','is','are','be','this','that']);
function subjectTokens(subject) {
  return String(subject || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !STOPWORDS.has(w));
}
// Plain token-overlap (Jaccard) similarity, not an LLM judgment call — same
// "deterministic, reviewable" conviction as matchClient/matchOwner. Two
// subjects are "clearly the same work" only when most of their significant
// words overlap; this deliberately doesn't try to be clever about synonyms
// or paraphrasing — a near-miss stays a separate task rather than risking a
// wrong merge onto someone's real tracked work.
function subjectSimilarity(a, b) {
  const ta = new Set(subjectTokens(a)), tb = new Set(subjectTokens(b));
  if (!ta.size || !tb.size) return 0;
  let overlap = 0;
  for (const w of ta) if (tb.has(w)) overlap++;
  return overlap / new Set([...ta, ...tb]).size;
}
const SUBJECT_SIMILARITY_THRESHOLD = 0.6;
// A bad parse that leaves the client blank (or invents one the roster/
// client list doesn't actually contain, e.g. a hallucinated "Knowless/
// Nulls Company") never satisfies the normal clientId-match requirement
// below — two clearly-duplicate blank/unmatched-client tasks would
// otherwise never dedupe. This higher bar (vs. the normal 0.6) is the
// tradeoff for dropping the client signal entirely: with one less signal
// to agree on, a near-miss is more likely to be a false positive, so this
// path requires the subjects to be almost identical, not just similar.
const SUBJECT_SIMILARITY_THRESHOLD_NO_CLIENT = 0.85;
// "Same task" requires BOTH a strong subject match AND agreement on
// assignee — a similar-sounding subject about a DIFFERENT person is never
// treated as the same work, no matter how close the wording is. Client
// agreement is required too, UNLESS the client is blank/missing on
// EITHER side — in that case, fall back to assignee + a stricter subject
// match instead of refusing to dedupe at all (2026-09-03: closes the gap
// where a blank/fabricated client let real duplicates slip through).
function isSameTask(a, b) {
  if ((a.assigneeId || null) !== (b.assigneeId || null)) return false;
  const clientA = a.clientId || null, clientB = b.clientId || null;
  if (clientA === null || clientB === null) {
    return subjectSimilarity(a.subject, b.subject) >= SUBJECT_SIMILARITY_THRESHOLD_NO_CLIENT;
  }
  if (clientA !== clientB) return false;
  return subjectSimilarity(a.subject, b.subject) >= SUBJECT_SIMILARITY_THRESHOLD;
}

// Collapses duplicates WITHIN one parse response — e.g. four pasted
// meeting transcripts all mentioning the same follow-up. Merging is purely
// additive: notes are concatenated (never dropped), tags unioned, the
// earliest non-empty due date wins, and alreadyDone is true if ANY of the
// merged mentions says so. Never touches anything already in storage —
// this only ever combines candidates that don't exist yet.
function dedupeWithinBatch(tasks) {
  const kept = [];
  for (const t of tasks) {
    const existing = kept.find(k => isSameTask(k, t));
    if (!existing) { kept.push({ ...t }); continue; }
    if (t.notes && t.notes !== existing.notes) existing.notes = existing.notes ? `${existing.notes}\n${t.notes}` : t.notes;
    existing.tags = [...new Set([...(existing.tags || []), ...(t.tags || [])])];
    if (!existing.dueDate && t.dueDate) existing.dueDate = t.dueDate;
    existing.alreadyDone = existing.alreadyDone || t.alreadyDone;
  }
  return kept;
}

// ── Meeting parse -> existing-item detection (2026-09-16). Deterministic
// matching/gating for "existingItemMentions" (see the prompt above) — the
// model only supplies raw text signals (mentionSubject/clientName/
// personName/attributedTo); the actual "is this confidently the same
// item" decision is always computed here, never trusted from the model
// directly, same conviction as matchClient()/matchOwner()/isSameTask()
// above. ──

// A task mention's candidate match, reusing isSameTask()'s own dual
// subject-similarity threshold (0.6 with an agreeing client, 0.85
// without one) by constructing a synthetic comparable task shape.
// isSameTask() already enforces assigneeId equality, so this only ever
// matches a task actually belonging to the identified personId — "match
// confidently by subject + client + assignee" per this feature's own
// instruction. No candidate found is a real, expected outcome (a
// low-confidence or unrelated mention) — skip silently, never guess.
function matchExistingTask(mentionSubject, personId, clientId, existingOpenTasks) {
  const candidateShape = { subject: mentionSubject, clientId: clientId || null, assigneeId: personId };
  return existingOpenTasks.find(ex => isSameTask(ex, candidateShape)) || null;
}

// Flattens every active client's NOT cancelled/archived services (top-
// level + franchise locations[].services[]) into one matchable pool —
// same exclusion rule index.html's own _chIsInactiveService()/
// _activeServicesForAssessment() already establish, hand-duplicated here
// per this codebase's zero-shared-code-between-frontends convention
// (this is a server file, not one of the three frontends, but there is
// no shared services-flattening helper anywhere in api/*.js either, so
// the same small duplication applies).
function activeServiceCandidates(activeClients) {
  const out = [];
  activeClients.forEach(c => {
    (Array.isArray(c.services) ? c.services : []).forEach(s => {
      if (s.status === 'cancelled' || s.status === 'archived') return;
      out.push({ id: s.id, name: s.name || '', clientId: c.id, clientName: c.name || '', assigneeId: s.assigneeId || null, locationName: '' });
    });
    (Array.isArray(c.locations) ? c.locations : []).forEach(loc => {
      (Array.isArray(loc.services) ? loc.services : []).forEach(s => {
        if (s.status === 'cancelled' || s.status === 'archived') return;
        out.push({ id: s.id, name: s.name || '', clientId: c.id, clientName: c.name || '', assigneeId: s.assigneeId || null, locationName: loc.name || '' });
      });
    });
  });
  return out;
}

// Services have no existing isSameTask()-style helper of their own (there
// is no "merge into an existing service" feature to reuse) — this mirrors
// that same dual-threshold pattern by hand: filtered first to the
// identified person's own services (and the matched client, when one was
// found), then the single best subjectSimilarity() match at or above the
// applicable threshold. A near-miss that doesn't clear the bar is simply
// not a match — never guessed at.
function matchExistingService(mentionSubject, personId, clientId, serviceCandidates) {
  const pool = serviceCandidates.filter(s => s.assigneeId === personId && (!clientId || s.clientId === clientId));
  const threshold = clientId ? SUBJECT_SIMILARITY_THRESHOLD : SUBJECT_SIMILARITY_THRESHOLD_NO_CLIENT;
  let best = null, bestScore = 0;
  pool.forEach(s => {
    const score = subjectSimilarity(s.name, mentionSubject);
    if (score >= threshold && score > bestScore) { bestScore = score; best = s; }
  });
  return best;
}

// The write/notify gate, identical for both item types per this feature's
// own explicit "same responsible-person-or-super-admin gate for both"
// instruction. Three outcomes, not two: 'act' (the identified speaker is
// either the item's own responsible person — a self-report — or a
// super-admin reporting on someone else's behalf), 'skip' (a known,
// but unauthorized, speaker — never write, never notify, per "otherwise
// skip"), and 'notify' (the speaker could not be identified from the text
// at all — "fall back to notify-only... don't auto-write on an unknown
// speaker"). For a TASK, 'act' means auto-write and 'notify' means send
// the review-it-yourself message instead; for a SERVICE, 'act' and
// 'notify' both mean "send the notify message" (services are never
// auto-changed regardless of who's confirmed to be speaking, per this
// feature's own "never auto-change" instruction for services) — only
// 'skip' actually differs in effect between the two outcomes there.
// superAdminIds already includes the primary-admin sentinel by
// construction (activeRoster() synthesizes her with level:'owner'), so no
// separate special case is needed here for Sarah.
function evaluateMeetingParseGate(attributedPersonId, responsiblePersonId, superAdminIds) {
  if (!attributedPersonId) return 'notify';
  if (attributedPersonId === responsiblePersonId) return 'act';
  if (superAdminIds.has(attributedPersonId)) return 'act';
  return 'skip';
}

// Shared by every truncated-JSON salvage path below (both the taskEmail
// endpoint's own repairTruncatedTaskJson and the Roadmap meeting-transcript
// extractor's repairTruncatedRoadmapJson) — walks a raw response looking
// for a top-level `"<arrayKey>":[...]` array and returns every object
// inside it that's fully well-formed, discarding only the dangling last
// one if the response was cut off mid-object. Respects string/escape
// boundaries so a brace or bracket inside a task's own text is never
// mistaken for real JSON structure. Returns [] if the key isn't found or
// nothing survives (e.g. cut off before even one complete object).
function recoverArrayObjects(text, arrayKey) {
  const keyIdx = text.indexOf(`"${arrayKey}"`);
  if (keyIdx === -1) return [];
  const arrStart = text.indexOf('[', keyIdx);
  if (arrStart === -1) return [];

  const recovered = [];
  const n = text.length;
  let i = arrStart + 1;
  while (i < n) {
    while (i < n && /[\s,]/.test(text[i])) i++;
    if (i >= n || text[i] === ']') break;
    if (text[i] !== '{') break;
    const objStart = i;
    let depth = 0;
    let inString = false;
    let escape = false;
    let objEnd = -1;
    for (; i < n; i++) {
      const ch = text[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { objEnd = i; break; }
      }
    }
    if (objEnd === -1) break; // ran off the end mid-object — the truncated tail; stop here
    try { recovered.push(JSON.parse(text.slice(objStart, objEnd + 1))); }
    catch { break; } // shouldn't happen given the depth-tracking above, but bail safely rather than throw
    i = objEnd + 1;
  }
  return recovered;
}

// Salvages a well-formed prefix of the model's task JSON when the response
// was cut off mid-array by hitting max_tokens — only ever attempted when
// the SDK's own message.stop_reason confirms that's actually what happened
// (never guessed from a JSON.parse failure alone, which could just as
// easily mean a genuinely malformed response for some other reason).
// buildTaskEmailSystemPrompt's own schema always emits "assignedDate" and
// "attendees" before "tasks" (see the example at the end of that function),
// so those two fields are intact even when the tasks array itself got
// truncated — only the LAST element of that array is ever partial.
function repairTruncatedTaskJson(text) {
  const recoveredTasks = recoverArrayObjects(text, 'tasks');
  if (!recoveredTasks.length) return null;
  const assignedDateMatch = text.match(/"assignedDate"\s*:\s*"([^"]*)"/);
  const attendeesMatch = text.match(/"attendees"\s*:\s*"([^"]*)"/);
  return {
    assignedDate: assignedDateMatch ? assignedDateMatch[1] : '',
    attendees: attendeesMatch ? attendeesMatch[1] : '',
    tasks: recoveredTasks,
    _repaired: true,
  };
}

// Same salvage technique, applied to the Roadmap meeting-transcript
// extractor's own JSON shape (SYSTEM_PROMPT below: {"tasks":[...],
// "summary":"..."}) — a separate function because the schema differs: no
// assignedDate/attendees preamble, and "summary" comes AFTER "tasks", so
// it's normally truncated away too whenever the tasks array itself got cut
// off (recovered only on the rare response that happens to still have it).
function repairTruncatedRoadmapJson(text) {
  const recoveredTasks = recoverArrayObjects(text, 'tasks');
  if (!recoveredTasks.length) return null;
  const summaryMatch = text.match(/"summary"\s*:\s*"([^"]*)"/);
  return {
    tasks: recoveredTasks,
    summary: summaryMatch ? summaryMatch[1] : '',
    _repaired: true,
  };
}

// Splits a transcript roughly in half for the chunk-and-merge fallback in
// extractRoadmapTasks() below — prefers a paragraph break (blank line) near
// the midpoint, then a plain line break, so a chunk boundary avoids landing
// mid-sentence when possible. Returns null when the text is too short to
// usefully split, which bounds the recursion below from ever chunking down
// to a handful of characters.
const MIN_SPLITTABLE_TRANSCRIPT_LEN = 400;
function splitTranscriptInHalf(text) {
  if (text.length < MIN_SPLITTABLE_TRANSCRIPT_LEN) return null;
  const mid = Math.floor(text.length / 2);
  const window = 800; // how far to search around the midpoint for a clean break
  const searchStart = Math.max(0, mid - window);
  const searchEnd = Math.min(text.length, mid + window);
  const region = text.slice(searchStart, searchEnd);
  let splitAt = region.lastIndexOf('\n\n');
  if (splitAt === -1) splitAt = region.lastIndexOf('\n');
  const idx = splitAt === -1 ? mid : searchStart + splitAt;
  const first = text.slice(0, idx).trim();
  const second = text.slice(idx).trim();
  if (!first || !second) return null;
  return [first, second];
}

async function handleTaskEmailMode(req, res) {
  let session;
  try { session = await requireSession(req); }
  catch (err) { await logError({ endpoint: 'process-transcript:taskEmail', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });

  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  const result = await parseTaskEmailForSession(session, text);
  return res.status(result.status).json(result.body);
}

// Extracted from handleTaskEmailMode (2026-09-11) — the shared parsing core,
// given only a resolved session + raw text, with no dependency on an HTTP
// req/res pair. handleTaskEmailMode (the authenticated portal endpoint,
// above) is now a thin wrapper: resolve the session from the request, then
// delegate here. api/inbound-email.js (the new David/Sarah-can-email-a-task
// webhook) is the second, and only other, caller — it has no bearer-token
// session at all (email isn't an authenticated portal request), so it
// builds its own session-SHAPED object for whichever allowlisted sender the
// email came from (see resolveInboundSender() there) and calls this exact
// same function, so a task created by email goes through the identical
// owner-matching/client-matching/scope/dedupe logic a portal paste already
// does — genuinely reused, not re-implemented. Every original
// res.status(X).json(Y) call site below is now `return {status:X, body:Y}`
// instead — no other behavior changed.
export async function parseTaskEmailForSession(session, text) {
  if (!process.env.ANTHROPIC_API_KEY) {
    await logError({ endpoint: 'process-transcript:taskEmail', error: 'ANTHROPIC_API_KEY is not configured on the server.', session });
    return { status: 500, body: { error: 'ANTHROPIC_API_KEY is not configured on the server.' } };
  }

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'process-transcript:taskEmail', error: err, session }); return { status: 500, body: { error: err.message } }; }

  // Roster + client-matching data are fetched BEFORE calling the model, not
  // after — the roster feeds the prompt itself (see buildTaskEmailSystemPrompt),
  // and the caller's scope (below) is derived from this same live data,
  // never from anything the request body claims about the caller's role.
  let activeClients, roster, scope, existingOpenTasks;
  try {
    const [{ data: clientRows, error: clientErr }, rosterList, { data: taskRows, error: taskErr }] = await Promise.all([
      // Active clients ONLY — an inactive/archived client can never be
      // auto-matched or assigned a parsed task (CLAUDE.md-required
      // constraint for this feature).
      supabase.from('ops_clients').select('id, status, data').eq('status', 'active'),
      activeRoster(supabase),
      // Existing NOT-done tasks — dedupe/merge candidates for the pass
      // below. A task already marked Done is never a merge target: the
      // point is to stop a still-open item from getting duplicated, not to
      // reopen something already finished.
      supabase.from('ops_tasks').select('id, data'),
    ]);
    if (clientErr) throw new Error(clientErr.message);
    if (taskErr) throw new Error(taskErr.message);
    activeClients = (clientRows || []).map(r => ({ id: r.id, ...r.data }));
    roster = rosterList;
    scope = callerTaskScope(session, roster);
    existingOpenTasks = (taskRows || [])
      .map(r => ({ id: r.id, ...r.data }))
      .filter(t => t.status !== 'Done');
  } catch (err) {
    await logError({ endpoint: 'process-transcript:taskEmail', error: err, session });
    return { status: 500, body: { error: err.message } };
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  // Single clock read for this request — reused as both the prompt's
  // "today's real date" reference and the assignedDate fallback below, so
  // the two can never disagree across a millisecond boundary.
  const todayIso = new Date().toISOString().slice(0, 10);

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-7',
      // Raised from 4096 (2026-08-27) — a large real-world batch (a
      // multi-meeting paste, 20+ tasks) routinely exceeded the old ceiling
      // and got cut off mid-array, which JSON.parse then reported as
      // "invalid JSON" with no indication anything had been truncated.
      // 16000 comfortably covers a realistic worst-case batch; the repair
      // path right below this call is the backstop for whatever's left
      // once a paste is large enough to still exceed even this.
      max_tokens: 16000,
      system: buildTaskEmailSystemPrompt(roster.map(p => {
        const title = p.title || p.level;
        return title ? `${p.name} — ${title}` : p.name;
      }), todayIso, activeClients.map(c => c.name)),
      messages: [{ role: 'user', content: text.trim() }],
    });

    const raw = message.content[0]?.text || '{}';
    let parsed;
    try {
      const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      // Only ever treated as a truncation — and only ever repaired — when
      // the SDK itself confirms that's what happened (message.stop_reason
      // === 'max_tokens'), never guessed from the parse failure alone; a
      // genuinely malformed response for some other reason still falls
      // through to the original raw-JSON-dump error below, which is real
      // debugging signal for that case and shouldn't be replaced with a
      // guess. A truncation that still leaves zero complete tasks (cut off
      // before finishing even the first one) is not silently swallowed
      // either — it gets the same clear, actionable message as an
      // unrecoverable one, not a raw JSON dump.
      const truncated = message.stop_reason === 'max_tokens';
      const repaired = truncated ? repairTruncatedTaskJson(raw) : null;
      if (repaired) {
        parsed = repaired;
        await logError({ endpoint: 'process-transcript:taskEmail', error: 'Response truncated by max_tokens; repaired ' + repaired.tasks.length + ' task(s) from the well-formed prefix', session, extra: { recoveredTaskCount: repaired.tasks.length, raw: raw.slice(0, 300) } });
      } else if (truncated) {
        await logError({ endpoint: 'process-transcript:taskEmail', error: 'Response truncated by max_tokens with nothing recoverable', session, extra: { raw: raw.slice(0, 300) } });
        return { status: 422, body: { error: 'The list was too long to parse in one go — split it into two and try again.' } };
      } else {
        await logError({ endpoint: 'process-transcript:taskEmail', error: parseErr, session, extra: { raw: raw.slice(0, 300) } });
        return { status: 500, body: { error: 'Claude returned invalid JSON. Raw: ' + raw.slice(0, 300) } };
      }
    }

    const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    // Never blank, per this feature's own requirement: an invalid/missing
    // model-reported assignedDate (empty, malformed, or an impossible date
    // per validDueDate's round-trip check) falls back to today's real date
    // — the same "no actionable date reaches storage uncontested" guard
    // validDueDate already applies to dueDate itself. Every task from this
    // parse shares this one value, deliberately not asked for per-task.
    const assignedDate = validDueDate(parsed.assignedDate) || todayIso;
    // Meeting-wide attendee list, resolved once per parse (not per task) —
    // see resolveTaskOwners()'s own comment for exactly how/when this is
    // used (only for tasks explicitly assigned to "the group").
    const attendeeIds = resolveAttendeeIds(parsed.attendees, roster);

    // Owner-matching and the role-scoped filter below run over EVERY
    // extracted task before any of it is returned — a member/manager-tier
    // caller never even receives an out-of-scope task in the HTTP response,
    // let alone gets a chance to import it. This is enforcement, not just
    // UX: the client sent nothing about its own role in the request body
    // (mode/text only), so there is nothing here for a modified client to
    // spoof — the scope above came entirely from the signed session token.
    //
    // flatMap, not map: a co-assigned row ("Michael, Sarah") or a "the
    // group" row with a resolved attendee list expands into one clone per
    // person — see resolveTaskOwners() — everything else about the task
    // (subject, client, due date, etc.) is identical across its clones.
    // See resolveTaskOwners()'s own comment on allowEveryone for exactly
    // why this is scope.isAdmin && !session.employeeId, not scope.isAdmin
    // alone — excludes a manager-tier dual-role account (e.g. Sherine),
    // who is isAdmin:true in callerTaskScope but only ever uses user.html,
    // which has no Everyone dropdown or clone-on-commit plumbing.
    const allowEveryone = scope.isAdmin && !session.employeeId;
    const tasks = rawTasks
      .filter(t => t && typeof t.subject === 'string' && t.subject.trim())
      .flatMap(t => {
        // clientName (model, from the live roster of client names) is the
        // primary signal, matchClient() (email/domain/text-mention) the
        // fallback — same precedence relationship ownerName/matchOwner()
        // already has.
        const matchedClient = matchClientByName(t.clientName, activeClients) || matchClient(t, activeClients);
        const ownerVariants = resolveTaskOwners(t.ownerName, t.groupOwner === true, roster, attendeeIds, allowEveryone);
        return ownerVariants.map(ov => ({
          subject: t.subject.trim(),
          notes: typeof t.notes === 'string' ? t.notes : '',
          tags: Array.isArray(t.tags) ? t.tags.filter(x => typeof x === 'string') : [],
          category: TASK_CATEGORIES.includes(t.category) ? t.category : 'Other',
          priority: TASK_PRIORITIES.includes(t.priority) ? t.priority : 'Normal',
          // Weekend-clamped (2026-09-02) — an estimated or explicitly-
          // resolved dueDate must never land on a Sat/Sun, same rule the
          // browser-side portals already apply to recurring service due
          // dates via their own adjustOffWeekend(). Applied AFTER
          // validDueDate() so an empty/invalid value ('') is never clamped
          // into a real date — clampToWeekday('') is a no-op by design.
          dueDate: clampToWeekday(validDueDate(t.dueDate)),
          assignedDate,
          clientId: matchedClient ? matchedClient.id : null,
          clientName: matchedClient ? matchedClient.name : '',
          source: 'parsed-email',
          emailReceivedDate: typeof t.emailReceivedDate === 'string' ? t.emailReceivedDate : '',
          emailThreadId: typeof t.emailThreadId === 'string' ? t.emailThreadId : '',
          assigneeId: ov.assigneeId,
          // Every co-assignee's id for this row/task, including this
          // clone's own assigneeId (2026-08-25) — informational: ops_tasks
          // itself has no multi-assignee field, so nothing server-side
          // reads this back today. "Co-assign" here means one real task
          // per named person (see resolveTaskOwners()), not one task with
          // several owners; this array just keeps the full co-assignee set
          // visible on each resulting clone for whatever the client wants
          // to do with it.
          assigneeIds: ov.assigneeIds,
          // Debug/visibility field (2026-08-21, extended 2026-08-25 to
          // cover multi-name and group-task cases) — kept alongside the
          // resolved assigneeId even when nothing on the roster matched.
          // Purely informational: nothing server-side reads this back, it
          // only lets the staging UI show what was actually detected when
          // assigneeId is null — "detected: {ownerRaw} — pick assignee",
          // built 2026-08-21, needed no change to cover these new cases.
          ownerRaw: ov.ownerRaw,
          alreadyDone: t.alreadyDone === true,
        }));
      })
      .filter(t => {
        if (scope.isAdmin) {
          // A caller with a real employee identity — a dual-role admin/
          // manager like Sherine, who's also a real employee via a linked
          // ops_admins row — self-assigns a genuinely name-less task to
          // their OWN canonical id, same as a plain member does below: "no
          // owner mentioned" in someone's OWN daily-task list unambiguously
          // means them, regardless of their admin tier. A caller with NO
          // employee identity (a true admin-only account, or the primary
          // admin) keeps the original behavior — left unassigned for
          // manual triage, since there's no personal list to attribute it
          // to. This also fixes a subtler bug this same gap caused: the
          // merge-matching pass below (isSameTask) compares assigneeId,
          // so a dual-role caller's own recurring daily tasks previously
          // never matched an existing stored task of theirs (assigneeId
          // null vs their real id) and silently duplicated on every parse.
          if (!t.assigneeId && session.employeeId) t.assigneeId = scope.selfId;
          return true;
        }
        if (t.assigneeId) return scope.allowedIds.has(t.assigneeId);
        // No owner identified at all — default it to the caller themselves
        // rather than dropping it, matching how api/ops-sync.js already
        // treats an unassigned member-created task (forced to self).
        t.assigneeId = scope.selfId;
        return true;
      });

    // Collapse duplicates mentioned more than once across the pasted
    // text (e.g. four transcripts all referencing the same follow-up)
    // BEFORE ever comparing against what's already stored — a candidate
    // that's a duplicate of another candidate should merge with THAT one
    // first, not independently match the same existing task twice.
    const deduped = dedupeWithinBatch(tasks);

    // Match each surviving candidate against existing NOT-done tasks
    // within this caller's own scope — an admin can merge into anyone's
    // task, a member/manager-tier caller only into one already visible to
    // them (self, or a direct report), same allowedIds used above. A
    // match never overwrites the existing task's stored data here — it
    // only tells the client WHICH existing row to update instead of
    // inserting a new one; the client performs a narrow, additive merge
    // (see runTaskEmailParse/runDtEmailParse), never a full overwrite.
    const scopedExistingTasks = scope.isAdmin
      ? existingOpenTasks
      : existingOpenTasks.filter(t => scope.allowedIds.has(t.assigneeId));
    const finalTasks = deduped.map(t => {
      const match = scopedExistingTasks.find(ex => isSameTask(ex, t));
      return {
        ...t,
        status: t.alreadyDone ? 'Done' : 'Not started',
        mergeIntoId: match ? match.id : null,
        mergeIntoSubject: match ? match.subject : '',
      };
    });

    // ── Meeting parse -> existing-item detection (2026-09-16). A separate
    // concern from finalTasks above (brand-new action items): this only
    // ever touches an existing ops_tasks row's status, or fires a
    // notify-only message about an existing service — never creates
    // anything, and never affects the tasks/finalTasks response below.
    // Runs best-effort; a failure here never fails the whole parse (the
    // "tasks" extraction the caller is waiting on already succeeded). ──
    const mentions = Array.isArray(parsed.existingItemMentions) ? parsed.existingItemMentions : [];
    if (mentions.length) {
      try {
        const superAdminIds = new Set(roster.filter(p => p.kind === 'admin' && (p.level === 'super' || p.level === 'owner')).map(p => p.id));
        const serviceCandidates = activeServiceCandidates(activeClients);
        const taskUpdates = [];
        const notifyEvents = [];
        mentions.forEach(m => {
          if (!m || typeof m !== 'object') return;
          const itemType = m.itemType === 'service' ? 'service' : (m.itemType === 'task' ? 'task' : null);
          const impliedStatus = m.impliedStatus === 'done' ? 'done' : (m.impliedStatus === 'in-progress' ? 'in-progress' : null);
          const mentionSubject = typeof m.mentionSubject === 'string' ? m.mentionSubject.trim() : '';
          if (!itemType || !impliedStatus || !mentionSubject) return; // nothing confidently actionable stated
          const personMatch = matchOwnerWithAlias(m.personName, roster);
          if (!personMatch) return; // can't confidently match without knowing whose item this is
          const attributedMatch = matchOwnerWithAlias(m.attributedTo, roster);
          const attributedId = attributedMatch ? attributedMatch.id : null;
          const gate = evaluateMeetingParseGate(attributedId, personMatch.id, superAdminIds);
          if (gate === 'skip') return;
          const matchedClient = matchClientByName(m.clientName, activeClients);
          const clientId = matchedClient ? matchedClient.id : null;
          if (itemType === 'task') {
            const match = matchExistingTask(mentionSubject, personMatch.id, clientId, existingOpenTasks);
            if (!match) return; // low-confidence/unrelated mention — skip silently
            const newStatus = impliedStatus === 'done' ? 'Done' : 'In progress';
            if (gate === 'act') {
              if (match.status !== newStatus) {
                taskUpdates.push({
                  task: match, newStatus,
                  attributedPersonId: attributedId,
                  attributedPersonName: attributedId === 'primary-admin' ? 'Sarah Samy' : (attributedMatch?.name || ''),
                  // personId/clientId/impliedStatus (2026-09-19, Task 3) —
                  // carried through only so a manual-correction detection
                  // at write time (applyMeetingParseTaskStatusUpdate()
                  // returning the 'human-correction' sentinel) can build a
                  // real notifyEvent below, in the exact same shape the
                  // 'notify' gate branch right below already uses.
                  personId: personMatch.id, clientId, impliedStatus,
                });
              }
            } else { // 'notify' — unidentified speaker, fall back to notify-only for tasks too
              notifyEvents.push({ itemType: 'task', itemName: match.subject, personId: personMatch.id, clientId: match.clientId || null, taskId: match.id, impliedStatus });
            }
          } else {
            const match = matchExistingService(mentionSubject, personMatch.id, clientId, serviceCandidates);
            if (!match) return; // low-confidence/unrelated mention — skip silently
            // Services are always notify-only here — 'act' and 'notify'
            // both mean "send the message" ('skip' was already handled
            // above); never auto-changed regardless of who's speaking,
            // per this feature's own explicit instruction.
            notifyEvents.push({ itemType: 'service', itemName: match.name + (match.locationName ? ` — ${match.locationName}` : ''), personId: personMatch.id, clientId: match.clientId || null, taskId: null, impliedStatus });
          }
        });
        if (taskUpdates.length || notifyEvents.length) {
          const meetingParseWarnings = [];
          for (const u of taskUpdates) {
            const result = await applyMeetingParseTaskStatusUpdate(supabase, { task: u.task, newStatus: u.newStatus, attributedPersonId: u.attributedPersonId, attributedPersonName: u.attributedPersonName, meetingDate: assignedDate }, meetingParseWarnings);
            // 'human-correction' (2026-09-19, Task 3) — the fresh row at
            // write time no longer matches what THIS feature's own last
            // update left it at, meaning a human corrected it since. Never
            // flipped back; surfaced as a notify-only event instead, same
            // treatment the unidentified-speaker gate already gets, reusing
            // the identical notifyEvents/fireMeetingParseNotifyEvents path
            // (added to notifyEvents here, before the notifyEvents.length
            // check just below, so it's never missed even if this was the
            // ONLY thing this parse produced).
            if (result === 'human-correction') {
              notifyEvents.push({ itemType: 'task', itemName: u.task.subject, personId: u.personId, clientId: u.clientId || null, taskId: u.task.id, impliedStatus: u.impliedStatus });
            }
          }
          if (notifyEvents.length) {
            const directory = {
              users: roster.filter(p => p.kind === 'user'),
              // 'primary-admin' excluded — every consumer of {users,admins}
              // in api/ops-sync.js (resolveMeetingParseRecipients,
              // personOf, insertNotifications' quiet-hours lookup) already
              // special-cases her by literal sentinel id, the same as
              // every other notification resolver in that file; a
              // synthetic admin row here would be harmless (deduped by id
              // where it matters) but inconsistent with what those
              // functions normally receive from getDirectory().
              admins: roster.filter(p => p.kind === 'admin' && p.id !== 'primary-admin'),
            };
            await fireMeetingParseNotifyEvents(supabase, notifyEvents.map(ev => ({ ...ev, meetingDate: assignedDate })), meetingParseWarnings, directory);
          }
          if (meetingParseWarnings.length) {
            await logError({ endpoint: 'process-transcript:taskEmail:meetingParse', error: meetingParseWarnings.join('; '), session });
          }
        }
      } catch (meetingParseErr) {
        // Never fails the parse the caller is waiting on — the "tasks"
        // extraction above already succeeded and is what's being returned.
        await logError({ endpoint: 'process-transcript:taskEmail:meetingParse', error: meetingParseErr, session });
      }
    }

    // truncated is only ever present (and true) when the repair path above
    // actually ran — additive field, ignored by any caller that doesn't
    // look for it, so no client change is required for this to be useful
    // later (e.g. a "some tasks may be missing" note in the UI).
    return { status: 200, body: { tasks: finalTasks, raw_count: rawTasks.length, ...(parsed._repaired ? { truncated: true } : {}) } };
  } catch (err) {
    console.error('Anthropic API error (taskEmail):', err);
    await logError({ endpoint: 'process-transcript:taskEmail', error: err, session });
    return { status: 500, body: { error: err.message || 'Anthropic API call failed' } };
  }
}

const SYSTEM_PROMPT = `You are a planning assistant for a small business called Weblight Media. Read this meeting transcript and extract every task, action item, goal, or idea mentioned.

IMPORTANT — SKIP the following entirely (do not include them as tasks):
- Personal notes, personal reminders, or personal to-dos (e.g. "I need to buy groceries", "remind me to call my dentist")
- Off-topic side comments unrelated to Weblight Media business

Sort each item into one of these buckets based on urgency:
- "7": critical or overdue, must happen within the week
- "30": urgent, needed within the month
- "60": medium-term, 1-2 months out
- "90": longer runway, no immediate pressure
- "dream": big picture, long-term vision, someday goals

Identify who owns each task. Use the person's first name in lowercase (e.g. "sarah", "david", "emily", "jacob", "rania"). Use "both" only if Sarah AND David share responsibility. If someone else on the team owns it, use their first name in lowercase. Never leave owner blank.

Assign one category to each task from this list:
- "hr" — hiring, compensation, onboarding, team management
- "finance" — payments, payroll, invoices, budget
- "security" — passwords, access, VPN, protocols
- "systems" — tools, software, automations, integrations
- "production" — design, development, content creation, delivery
- "clients" — client work, deliverables, communication
- "operations" — internal processes, SOPs, meetings, scheduling
- "marketing" — ads, social media, outreach, branding
- "sales" — leads, pipelines, proposals, follow-ups

Always spell these names and terms correctly: Servpro, Wuzzuf, Rania, Weblight Media, Candidates, GoHighLevel.

Return ONLY valid JSON, no markdown, no explanation:
{"tasks":[{"bucket":"30","text":"Concise task description under 10 words","owner":"sarah","category":"hr"}],"summary":"One sentence about what this meeting covered."}`;

// Bounds the chunk-and-merge recursion below to at most 2^ROADMAP_MAX_CHUNK_DEPTH
// (= 4) leaf model calls for one submitted transcript, however many times a
// half still comes back truncated.
const ROADMAP_MAX_CHUNK_DEPTH = 2;

// Calls the model once for transcriptText and returns {tasks, summary,
// truncated, fallbackUsed, raw}. `fallbackUsed` is purely informational —
// true whenever chunking or salvage-repair engaged anywhere in the
// recursion, logged below for visibility even when nothing was actually
// lost. `truncated` is the real "some content may be missing" signal,
// surfaced to the submitter — it's only ever true when a leaf had to fall
// back to repairTruncatedRoadmapJson's salvage-the-prefix behavior; a clean
// two-half split-and-merge (both halves parsed in full) is NOT truncated,
// since together they cover the entire original transcript.
//
// When the response is confirmed truncated by max_tokens
// (message.stop_reason === 'max_tokens' — never guessed from the parse
// failure alone, same conviction as repairTruncatedTaskJson/
// repairTruncatedRoadmapJson above) AND splitting further is still
// possible, this recurses into the transcript's two halves and MERGES their
// results — a full, clean re-run per half correctly captures everything
// instead of settling for whatever fit before the cut. Only once splitting
// is no longer possible (depth limit reached, or the remaining text is too
// short to usefully split) does it fall back to repairTruncatedRoadmapJson's
// salvage-the-well-formed-prefix behavior. A genuinely malformed response
// for some other reason (stop_reason !== 'max_tokens') is never chunked or
// repaired — it's surfaced as-is, since guessing it's a size problem would
// hide the real debugging signal.
async function extractRoadmapTasks(client, transcriptText, meetingName, meetingDate, depth) {
  const userMessage = `Meeting: ${meetingName}
Date: ${meetingDate}

TRANSCRIPT:
${transcriptText}`;

  const message = await client.messages.create({
    model: 'claude-opus-4-7',
    // Raised from 4096 — the identical, already-shipped 2026-08-27 fix for
    // the sibling taskEmail endpoint above (same model) raised its own cap
    // from 4096 to 16000 after a large real-world batch routinely got cut
    // off mid-array; 16000 has already been proven safe there with no 400s.
    // A dense/long meeting transcript hit the exact same failure here —
    // "Unterminated string in JSON at position ~9,900" in the error log is
    // consistent with a ~4096-token output cutoff, not a genuinely
    // malformed response.
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const raw = message.content[0]?.text || '{}';
  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      truncated: false,
      fallbackUsed: false,
      raw,
    };
  } catch (parseErr) {
    const truncated = message.stop_reason === 'max_tokens';
    if (!truncated) {
      const err = new Error('Claude returned invalid JSON. Raw: ' + raw.slice(0, 300));
      err._rawSnippet = raw.slice(0, 300);
      throw err;
    }

    const halves = depth < ROADMAP_MAX_CHUNK_DEPTH ? splitTranscriptInHalf(transcriptText) : null;
    if (halves) {
      const [firstHalf, secondHalf] = halves;
      const [a, b] = await Promise.all([
        extractRoadmapTasks(client, firstHalf, meetingName, meetingDate, depth + 1),
        extractRoadmapTasks(client, secondHalf, meetingName, meetingDate, depth + 1),
      ]);
      return {
        tasks: [...a.tasks, ...b.tasks],
        summary: [a.summary, b.summary].filter(Boolean).join(' '),
        // A clean two-half split-and-merge is NOT an incompleteness signal
        // — together the halves cover the whole original transcript — so
        // `truncated` only propagates up if a DESCENDANT actually had to
        // salvage a partial result. `fallbackUsed` is always true here
        // (chunking itself is the fallback), independent of the children's
        // own success.
        truncated: a.truncated || b.truncated,
        fallbackUsed: true,
        raw: null,
      };
    }

    const repaired = repairTruncatedRoadmapJson(raw);
    if (repaired) {
      return { tasks: repaired.tasks, summary: repaired.summary, truncated: true, fallbackUsed: true, raw };
    }
    const err = new Error('The list was too long to parse in one go — split it into two and try again.');
    err._truncatedEmpty = true;
    err._rawSnippet = raw.slice(0, 300);
    throw err;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-claude-api-key, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST' && req.body?.mode === 'taskEmail') {
    return handleTaskEmailMode(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKeyHeader = req.headers['x-claude-api-key'];
  const expectedKey  = process.env.CLAUDE_ROADMAP_KEY;
  if (apiKeyHeader && expectedKey && apiKeyHeader !== expectedKey) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  const { transcript, meeting_name, meeting_date } = req.body || {};
  if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
    return res.status(400).json({ error: 'transcript is required' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    await logError({ endpoint: 'process-transcript', error: 'ANTHROPIC_API_KEY is not configured on the server.' });
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resolvedMeetingName = meeting_name || 'Untitled Meeting';
  const resolvedMeetingDate = meeting_date || new Date().toISOString().slice(0, 10);
  // Included on every logError call below so a parse/truncation failure is
  // never silent-and-unidentifiable in the error log — there's no session/
  // submitter identity on this endpoint (see the API-key check above, not a
  // signed session), so the meeting name/date plus transcript length are
  // the closest thing to a request "id" available here.
  const logContext = { transcriptLength: transcript.length, meetingName: resolvedMeetingName, meetingDate: resolvedMeetingDate };

  try {
    let result;
    try {
      result = await extractRoadmapTasks(client, transcript.trim(), resolvedMeetingName, resolvedMeetingDate, 0);
    } catch (err) {
      if (err._truncatedEmpty) {
        await logError({ endpoint: 'process-transcript', error: 'Response truncated by max_tokens with nothing recoverable, even after splitting', extra: { ...logContext, raw: err._rawSnippet } });
        return res.status(422).json({ error: err.message });
      }
      await logError({ endpoint: 'process-transcript', error: err, extra: { ...logContext, raw: err._rawSnippet } });
      return res.status(500).json({ error: err.message || 'Claude returned invalid JSON.' });
    }

    if (result.fallbackUsed) {
      // Not necessarily a failure — a clean chunk-and-merge (truncated:
      // false) means nothing was actually lost, just that the transcript
      // was large enough to need more than one model call. Logged either
      // way (never silent) so a pattern of transcripts routinely needing
      // this fallback is visible without anyone having to notice a user
      // report first; the message says explicitly whether data may be
      // incomplete or the merge was clean.
      await logError({
        endpoint: 'process-transcript',
        error: result.truncated
          ? 'Response required the chunk/salvage-repair fallback and may be missing content; recovered ' + result.tasks.length + ' raw task(s)'
          : 'Response required chunking (transcript split across multiple model calls) but the merge is complete; recovered ' + result.tasks.length + ' raw task(s)',
        extra: logContext,
      });
    }

    const tasks   = result.tasks;
    const summary = result.summary;

    const valid = tasks.filter(t =>
      t && typeof t.text === 'string' && t.text.trim() &&
      ['7', '30', '60', '90', 'dream'].includes(t.bucket) &&
      typeof t.owner === 'string' && /^[a-z]{2,30}$/.test(t.owner) &&
      t.category !== 'personal'
    ).map(t => ({
      bucket:      t.bucket,
      text:        t.text.trim(),
      owner:       t.owner,
      category:    VALID_CATEGORIES.includes(t.category) ? t.category : '',
      source:      resolvedMeetingName,
      source_date: resolvedMeetingDate,
    }));

    return res.status(200).json({ tasks: valid, summary, raw_count: tasks.length, ...(result.truncated ? { truncated: true } : {}) });
  } catch (err) {
    console.error('Anthropic API error:', err);
    await logError({ endpoint: 'process-transcript', error: err, extra: logContext });
    return res.status(500).json({ error: err.message || 'Anthropic API call failed' });
  }
}
