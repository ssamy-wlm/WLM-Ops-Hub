import Anthropic from '@anthropic-ai/sdk';
import { logError } from '../lib/errorLog.js';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { requireSession, tierOf } from '../lib/opsSession.js';

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
- "dueDate": an ISO YYYY-MM-DD date, resolved relative to the ASSIGNEDDATE you determined above, not today's real date, since the text may have been written well before it's parsed. First look for explicit or relative due-date language: "by <weekday>" or "this <weekday>" means the very next occurrence of that weekday counting from the assignedDate (the assignedDate itself if the assignedDate IS that weekday); "next <weekday>" means that weekday in the week AFTER the assignedDate's own week (never the same week, even if that day hasn't happened yet within it); "next week" means the Monday of the week following the assignedDate; "end of month"/"end of the month" means the last calendar day of the month the assignedDate falls in; "tomorrow" means the day right after the assignedDate, "today" means the assignedDate itself; "in N days"/"in N weeks" means the assignedDate plus that many days. Example: if the assignedDate is 2026-08-18 (a Tuesday) and the text says "by end of week", that resolves to Friday 2026-08-21 — even though today's real date above may be later than that. If the text states or implies no specific timeframe at all, ESTIMATE a dueDate instead of leaving it empty, based on the task's own nature and effort, still resolved relative to the assignedDate: a quick, low-effort task (a short email, a phone call, a single social media post, a one-line fix) should land a few days after the assignedDate; a substantial, multi-step task (building a website, producing a video, a research project) should land proportionally further out — weeks or more, scaled to how much work it clearly represents. There is no fixed maximum for a large task. Always return a real date — only return an empty string if the "subject" itself is too vague to estimate anything from at all.
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

Return ONLY valid JSON, no markdown, no explanation:
{"assignedDate":"YYYY-MM-DD","attendees":"","tasks":[{"subject":"...","notes":"...","tags":[],"category":"Production","priority":"Normal","dueDate":"","senderEmail":"","senderName":"","recipientEmail":"","recipientName":"","emailReceivedDate":"","emailThreadId":"","clientName":"","ownerName":"","groupOwner":false,"alreadyDone":false}]}`;
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
function matchOwnerWithAlias(ownerName, roster) {
  return resolveOwnerAlias(ownerName, roster) || matchOwner(ownerName, roster);
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
// "Same task" requires BOTH a strong subject match AND agreement on client
// and assignee — a similar-sounding subject about a DIFFERENT client is
// never treated as the same work, no matter how close the wording is.
function isSameTask(a, b) {
  if ((a.clientId || null) !== (b.clientId || null)) return false;
  if ((a.assigneeId || null) !== (b.assigneeId || null)) return false;
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

async function handleTaskEmailMode(req, res) {
  let session;
  try { session = await requireSession(req); }
  catch (err) { await logError({ endpoint: 'process-transcript:taskEmail', error: err }); return res.status(500).json({ error: err.message }); }
  if (!session) return res.status(401).json({ error: 'Missing or invalid session' });

  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    await logError({ endpoint: 'process-transcript:taskEmail', error: 'ANTHROPIC_API_KEY is not configured on the server.', session });
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' });
  }

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'process-transcript:taskEmail', error: err, session }); return res.status(500).json({ error: err.message }); }

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
    return res.status(500).json({ error: err.message });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  // Single clock read for this request — reused as both the prompt's
  // "today's real date" reference and the assignedDate fallback below, so
  // the two can never disagree across a millisecond boundary.
  const todayIso = new Date().toISOString().slice(0, 10);

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
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
      await logError({ endpoint: 'process-transcript:taskEmail', error: parseErr, session, extra: { raw: raw.slice(0, 300) } });
      return res.status(500).json({ error: 'Claude returned invalid JSON. Raw: ' + raw.slice(0, 300) });
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
          dueDate: validDueDate(t.dueDate),
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

    return res.status(200).json({ tasks: finalTasks, raw_count: rawTasks.length });
  } catch (err) {
    console.error('Anthropic API error (taskEmail):', err);
    await logError({ endpoint: 'process-transcript:taskEmail', error: err, session });
    return res.status(500).json({ error: err.message || 'Anthropic API call failed' });
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

  const userMessage = `Meeting: ${meeting_name || 'Untitled Meeting'}
Date: ${meeting_date || new Date().toISOString().slice(0, 10)}

TRANSCRIPT:
${transcript.trim()}`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const raw = message.content[0]?.text || '{}';

    let parsed;
    try {
      const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      await logError({ endpoint: 'process-transcript', error: parseErr, extra: { raw: raw.slice(0, 300) } });
      return res.status(500).json({ error: 'Claude returned invalid JSON. Raw: ' + raw.slice(0, 300) });
    }

    const tasks   = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';

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
      source:      meeting_name || 'Untitled Meeting',
      source_date: meeting_date || new Date().toISOString().slice(0, 10),
    }));

    return res.status(200).json({ tasks: valid, summary, raw_count: tasks.length });
  } catch (err) {
    console.error('Anthropic API error:', err);
    await logError({ endpoint: 'process-transcript', error: err });
    return res.status(500).json({ error: err.message || 'Anthropic API call failed' });
  }
}
