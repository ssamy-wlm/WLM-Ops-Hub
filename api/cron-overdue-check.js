// Vercel Cron: the ONLY place "overdue" is detected server-side — never on
// login/page-load or any other timer-driven scan of live browser state
// (CLAUDE.md rule #2 forbids that pattern; this is a genuine scheduled job,
// not a disguised load-time diff, and it never touches anything a browser
// sent in the same request the way ops-sync.js's other event collectors do).
//
// Auth: Vercel invokes cron endpoints with `Authorization: Bearer
// $CRON_SECRET` when a `crons` entry is configured in vercel.json (see
// https://vercel.com/docs/cron-jobs) — verified here so nothing else can
// trigger this endpoint. Fails closed if CRON_SECRET isn't configured.
//
// Idempotency: each currently-overdue service gets a stamped
// `overdueNotifiedFor` field set to the exact `due` value that was active
// when the notification fired. A repeat run against the SAME due date sees
// `overdueNotifiedFor === due` and skips it — never a second notification
// for the same missed cycle. If the due date later rolls over (a new cycle
// came and went without ever being marked done), `due` no longer matches the
// stamp, so it correctly re-fires exactly once for the new cycle.
//
// Writes are per-record only: only the specific clients whose service
// objects were actually stamped in this run get upserted, each with its full
// existing `data` (mutated in place, in memory, before the write) — never a
// whole-table rewrite, same rule as every write in api/ops-sync.js.
//
// Recipients are manager/higher-admin escalation ONLY — the assignee's own
// row is filtered out of every notification this endpoint creates, so the
// member's own (pre-existing, local-only) overdue awareness is left exactly
// as it was before this feature; this cron never notifies the assignee.
//
// Also runs the daily ops_backups snapshot (see lib/opsBackup.js) at the end
// of every invocation, regardless of the overdue-notifications toggle below.
// This used to be its own endpoint (api/cron-backup.js, its own Vercel Cron
// entry) but that endpoint has been deleted outright: the Vercel Hobby plan
// this app runs on caps both the number of scheduled crons AND the total
// number of serverless functions per project (12), and this app was over
// that function limit too — so rather than leaving cron-backup.js in place
// as an unscheduled-but-still-deployed function (which would have kept
// costing one of those 12 slots for nothing), its logic was folded in here
// and the file removed. A manual/on-demand snapshot is still available via
// api/ops-backups.js's `action:'manual'` (Admin Controls → Data Backups →
// Create Manual Snapshot), so no capability was actually lost.
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { logError } from '../lib/errorLog.js';
import { resolveNotifyRecipients, insertNotifications, personOf, DEFAULT_TEAM_NOTIF_PREFS } from './ops-sync.js';
import { buildBackupSnapshot, insertBackupRow, pruneOldDailyBackups } from '../lib/opsBackup.js';

function isInactiveService(s) { return s.status === 'cancelled' || s.status === 'archived'; }
// Same rule as client.html's _svcIsDoneThisCycle/_svcDueStatus — kept in sync
// deliberately (not imported; this endpoint has no access to that browser-side
// file), single source of truth documented in both places.
function isDoneThisCycle(svc, t) { return !!(svc.lastDone && !(svc.due && svc.due < t)); }
function isOverdue(svc, t) { return !isInactiveService(svc) && !isDoneThisCycle(svc, t) && !!svc.due && svc.due < t; }

// Same predicates as index.html's _taIsOverdue()/_taIsDueToday() — kept in
// sync deliberately (task-scope "Needs Attention" digest/reminders below,
// 2026-08-20), never imported since this is a completely separate runtime
// from the browser-side file.
function taskIsOverdue(t, today) { return !!t.dueDate && t.dueDate < today && t.status !== 'Done'; }
function taskIsDueToday(t, today) { return t.dueDate === today && t.status !== 'Done'; }

async function loadDirectory(supabase) {
  const [{ data: usersData }, { data: adminsData }, { data: teamPrefRows }] = await Promise.all([
    supabase.from('ops_users').select('id, data'),
    supabase.from('ops_admins').select('id, data'),
    supabase.from('ops_settings').select('key, data').like('key', 'teamNotifPrefs_%'),
  ]);
  const prefsByAdminId = new Map((teamPrefRows || []).map(r => [r.key.slice('teamNotifPrefs_'.length), r.data]));
  return {
    users: (usersData || []).map(r => ({ id: r.id, ...r.data })),
    admins: (adminsData || []).map(r => ({
      id: r.id, ...r.data,
      teamNotifPrefs: { ...DEFAULT_TEAM_NOTIF_PREFS, ...(prefsByAdminId.get(r.id) || {}) },
    })),
  };
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.authorization || '';
  if (!secret || header !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'cron-overdue-check', error: err }); return res.status(500).json({ error: err.message }); }

  const warnings = [];
  const summary = { scanned: 0, overdueFound: 0, newlyStamped: 0, clientsUpdated: 0, notificationsSent: 0 };

  try {
    // Org-wide on/off toggle (Super Admin-visible in Settings, same as the
    // other notification types) — a direct read, not the memoized
    // getNotificationSettings() in ops-sync.js, since that cache is scoped to
    // ops-sync.js's own handler lifecycle and isn't reset here.
    const { data: settingsRow } = await supabase.from('ops_settings').select('data').eq('key', 'notificationSettings').maybeSingle();
    const overdueEnabled = settingsRow?.data?.overdue !== false; // default ON, matching every other event type
    if (!overdueEnabled) {
      summary.skipped = 'overdue notifications disabled';
    } else {
      const { data: clientRows, error: clientErr } = await supabase.from('ops_clients').select('id, status, data').eq('status', 'active');
      if (clientErr) {
        warnings.push(`clients: ${clientErr.message}`);
      } else {
        const t = new Date().toISOString().slice(0, 10);
        const events = [];
        const clientsToUpdate = [];

        for (const row of clientRows || []) {
          const client = row.data;
          if (!client) continue;
          summary.scanned++;
          let changed = false;
          const scan = (list, locationName) => {
            (list || []).forEach(s => {
              if (!s?.id || !isOverdue(s, t)) return;
              summary.overdueFound++;
              if (s.overdueNotifiedFor === s.due) return; // already notified for this exact cycle
              s.overdueNotifiedFor = s.due;
              changed = true;
              events.push({
                serviceId: s.id, serviceName: s.name, locationName,
                assigneeId: s.assigneeId, clientId: client.id, clientName: client.name, due: s.due,
              });
            });
          };
          scan(client.services, null);
          (client.locations || []).forEach(loc => scan(loc.services, loc.name));
          if (changed) clientsToUpdate.push({ id: row.id, status: row.status, data: client });
        }

        summary.newlyStamped = events.length;

        if (clientsToUpdate.length) {
          const payload = clientsToUpdate.map(c => ({ id: c.id, data: c.data, status: c.status }));
          const { error } = await supabase.from('ops_clients').upsert(payload, { onConflict: 'id' });
          if (error) warnings.push(`clients update: ${error.message}`);
          else summary.clientsUpdated = payload.length;
        }

        if (events.length) {
          const { users, admins } = await loadDirectory(supabase);
          const rows = [];
          events.forEach(ev => {
            if (!ev.assigneeId) return;
            resolveNotifyRecipients(ev.assigneeId, users, admins, 'overdue')
              .filter(r => r.id !== ev.assigneeId)
              .forEach(r => {
                const person = personOf(r.id, r.kind, { users, admins });
                rows.push({
                  type: 'overdue', recipientId: r.id, recipientKind: r.kind,
                  recipientName: person?.name || '', recipientEmail: person?.email || '',
                  title: `Overdue: ${ev.serviceName}`,
                  body: `${ev.clientName}${ev.locationName ? ' — ' + ev.locationName : ''} — was due ${ev.due}`,
                  link: '',
                  context: { clientId: ev.clientId, serviceId: ev.serviceId },
                });
              });
          });
          await insertNotifications(supabase, rows, warnings);
          summary.notificationsSent = rows.length;
        }
      }
    }

    // ── Task "Needs Attention" digest + self-reminders (2026-08-20) —
    // entirely separate from the service-overdue escalation block above
    // (different table, different notification types, different
    // recipients) and deliberately NOT gated behind the `overdueEnabled`
    // toggle above, which only ever governed service-overdue escalation —
    // runs every invocation, same as the backup snapshot below. No
    // per-item idempotency stamp (unlike the service block above): a
    // digest/reminder is SUPPOSED to repeat every single day the
    // underlying task is still overdue/due-today, so "today's real state"
    // computed fresh each run is exactly correct, not a bug to guard
    // against.
    //
    // Owner digest -> every super/owner admin, one row each, with the
    // team-wide counts + who's affected. Employee self-reminders -> one
    // row per person who has at least one of their OWN overdue/due-today
    // tasks, framed as a nudge to them, not a report about them (worded in
    // second person, no mention of what admins/managers see).
    try {
      const { data: taskRows, error: taskErr } = await supabase.from('ops_tasks').select('id, data');
      if (taskErr) {
        warnings.push(`tasks: ${taskErr.message}`);
      } else {
        const today = new Date().toISOString().slice(0, 10);
        const tasks = (taskRows || []).map(r => ({ id: r.id, ...r.data }));
        const overdueTasks = tasks.filter(t => taskIsOverdue(t, today));
        const dueTodayTasks = tasks.filter(t => taskIsDueToday(t, today));
        const blockedTasks = tasks.filter(t => t.status === 'Blocked');
        const unassignedTasks = tasks.filter(t => !t.assigneeId);
        summary.tasksOverdue = overdueTasks.length;
        summary.tasksDueToday = dueTodayTasks.length;
        summary.tasksBlocked = blockedTasks.length;
        summary.tasksUnassigned = unassignedTasks.length;

        const { users, admins } = await loadDirectory(supabase);
        const notifRows = [];

        // Owner digest.
        const affectedIds = new Set([...overdueTasks, ...dueTodayTasks, ...blockedTasks].map(t => t.assigneeId).filter(Boolean));
        const affectedNames = [...affectedIds].map(id => personOf(id, users.find(u => u.id === id) ? 'user' : 'admin', { users, admins })?.name).filter(Boolean);
        const digestBody = `Overdue: ${overdueTasks.length} · Due today: ${dueTodayTasks.length} · Blocked: ${blockedTasks.length} · Unassigned: ${unassignedTasks.length}`
          + (affectedNames.length ? ` — affecting ${affectedNames.join(', ')}` : '');
        admins.filter(a => a.level === 'super' || a.level === 'owner').forEach(a => {
          notifRows.push({
            type: 'attentionDigest', recipientId: a.id, recipientKind: 'admin',
            recipientName: a.name || '', recipientEmail: a.email || '',
            title: 'Daily task summary', body: digestBody, link: '', context: {},
          });
        });
        summary.digestSent = admins.filter(a => a.level === 'super' || a.level === 'owner').length;

        // Employee self-reminders — one row per affected person, counting
        // only THEIR own overdue/due-today tasks (never Blocked/Unassigned,
        // which aren't "your own work" concepts).
        const ownCounts = new Map();
        [...overdueTasks, ...dueTodayTasks].forEach(t => {
          if (!t.assigneeId) return;
          const bucket = ownCounts.get(t.assigneeId) || { overdue: 0, dueToday: 0 };
          if (taskIsOverdue(t, today)) bucket.overdue++;
          if (taskIsDueToday(t, today)) bucket.dueToday++;
          ownCounts.set(t.assigneeId, bucket);
        });
        let remindersSent = 0;
        ownCounts.forEach((counts, personId) => {
          const kind = users.find(u => u.id === personId) ? 'user' : 'admin';
          const person = personOf(personId, kind, { users, admins });
          if (!person) return;
          const parts = [];
          if (counts.overdue) parts.push(`${counts.overdue} overdue`);
          if (counts.dueToday) parts.push(`${counts.dueToday} due today`);
          notifRows.push({
            type: 'taskReminder', recipientId: personId, recipientKind: kind,
            recipientName: person.name || '', recipientEmail: person.email || '',
            title: 'You have tasks that need attention',
            body: `You have ${parts.join(' and ')}. Take a look when you get a chance!`,
            link: '', context: {},
          });
          remindersSent++;
        });
        summary.remindersSent = remindersSent;

        await insertNotifications(supabase, notifRows, warnings);
      }
    } catch (err) {
      await logError({ endpoint: 'cron-overdue-check:taskAttention', error: err });
      warnings.push(`taskAttention: ${err.message}`);
    }

    // ── Daily "your focus today" digest (2026-09-02) — one email per
    // active team member, summarizing their OWN overdue / due-soon (today
    // through the next 7 days) / in-progress work, across BOTH ops_tasks
    // AND ops_clients services. Entirely separate from every notification
    // type above (different shape: one full picture per person, not a
    // single-signal escalation or reminder) — runs every invocation,
    // unconditional on any toggle, same as the task-attention block above,
    // and independently re-queries ops_clients (never reuses
    // clientRows/events from the overdue-escalation block above, which
    // only runs when overdueEnabled is true) so this digest is never
    // silently skipped by an unrelated toggle.
    //
    // Deliberately excludes any TASK with assignedDate===today — a
    // same-day assignment already fired its own immediate email via the
    // assignment-notification path (api/ops-sync.js's
    // fireOpsTaskAssignmentNotifications()/fireAssignmentNotifications()),
    // so repeating it in today's digest would be a real duplicate. Services
    // have no equivalent "when was this assigned" field to apply the same
    // check to — flagged in CLAUDE.md rather than guessed at with a proxy.
    try {
      const { data: clientRowsForDigest, error: clientDigestErr } = await supabase.from('ops_clients').select('id, status, data').eq('status', 'active');
      if (clientDigestErr) {
        warnings.push(`clients (focus digest): ${clientDigestErr.message}`);
      } else {
        const today = new Date().toISOString().slice(0, 10);
        const weekOutDate = new Date(); weekOutDate.setDate(weekOutDate.getDate() + 7);
        const weekOut = weekOutDate.toISOString().slice(0, 10);
        const isDueSoon = (due) => !!due && due >= today && due <= weekOut;

        const { users: directoryUsers, admins: directoryAdmins } = await loadDirectory(supabase);
        const isActivePerson = (p) => p && p.status !== 'inactive';

        const focus = new Map(); // personId -> { kind, overdue: [], dueSoon: [], inProgress: [] }
        const bucketFor = (id, kind) => {
          if (!focus.has(id)) focus.set(id, { kind, overdue: [], dueSoon: [], inProgress: [] });
          return focus.get(id);
        };

        // Tasks — independently re-queries ops_tasks (never reuses the
        // `tasks` array from the task-attention block above, which is
        // scoped to that block's own try/catch and unavailable here — same
        // "each block loads its own data" convention as the client query
        // above).
        const { data: taskRowsForDigest, error: taskDigestErr } = await supabase.from('ops_tasks').select('id, data');
        if (taskDigestErr) warnings.push(`tasks (focus digest): ${taskDigestErr.message}`);
        const tasksForDigest = (taskRowsForDigest || []).map(r => ({ id: r.id, ...r.data }));
        tasksForDigest.forEach(t => {
          if (!t.assigneeId || t.status === 'Done' || t.mergedIntoId) return;
          if (t.assignedDate === today) return; // just assigned today -> already emailed
          const kind = directoryUsers.find(u => u.id === t.assigneeId) ? 'user' : 'admin';
          const person = personOf(t.assigneeId, kind, { users: directoryUsers, admins: directoryAdmins });
          if (!isActivePerson(person)) return;
          const b = bucketFor(t.assigneeId, kind);
          const label = t.subject || 'Untitled task';
          if (taskIsOverdue(t, today)) b.overdue.push(`${label} — due ${t.dueDate}`);
          else if (isDueSoon(t.dueDate)) b.dueSoon.push(`${label} — due ${t.dueDate}`);
          if (t.status === 'In progress') b.inProgress.push(label);
        });

        // Services — active clients + franchise locations, same scan shape
        // the service-overdue-escalation block above uses, reusing its
        // isOverdue()/isInactiveService() predicates directly so this can
        // never disagree with that block on what counts as overdue.
        (clientRowsForDigest || []).forEach(row => {
          const client = row.data;
          if (!client) return;
          const scanServices = (list, locationName) => {
            (list || []).forEach(s => {
              if (!s?.id || !s.assigneeId || isInactiveService(s)) return;
              const kind = directoryUsers.find(u => u.id === s.assigneeId) ? 'user' : 'admin';
              const person = personOf(s.assigneeId, kind, { users: directoryUsers, admins: directoryAdmins });
              if (!isActivePerson(person)) return;
              const b = bucketFor(s.assigneeId, kind);
              const label = `${s.name}${locationName ? ' (' + locationName + ')' : ''} — ${client.name}`;
              if (isOverdue(s, today)) b.overdue.push(`${label} — due ${s.due}`);
              else if (!isDoneThisCycle(s, today) && isDueSoon(s.due)) b.dueSoon.push(`${label} — due ${s.due}`);
              if (s.workStatus === 'in_progress') b.inProgress.push(label);
            });
          };
          scanServices(client.services, null);
          (client.locations || []).forEach(loc => scanServices(loc.services, loc.name));
        });

        const focusRows = [];
        focus.forEach((b, personId) => {
          if (!b.overdue.length && !b.dueSoon.length && !b.inProgress.length) return; // empty list -> skip entirely, no email
          const person = personOf(personId, b.kind, { users: directoryUsers, admins: directoryAdmins });
          if (!person || !person.email) return;
          const sections = [];
          if (b.overdue.length) sections.push(`Overdue (${b.overdue.length}):\n${b.overdue.map(x => `• ${x}`).join('\n')}`);
          if (b.dueSoon.length) sections.push(`Due soon (${b.dueSoon.length}):\n${b.dueSoon.map(x => `• ${x}`).join('\n')}`);
          if (b.inProgress.length) sections.push(`In progress (${b.inProgress.length}):\n${b.inProgress.map(x => `• ${x}`).join('\n')}`);
          focusRows.push({
            type: 'focusDigest', recipientId: personId, recipientKind: b.kind,
            recipientName: person.name || '', recipientEmail: person.email,
            title: 'Your focus today',
            body: sections.join('\n\n'),
            link: '', context: {},
          });
        });
        summary.focusDigestSent = focusRows.length;
        // insertNotifications() batches its own outgoing email per
        // recipient (see its own header comment) — one row per person here
        // means exactly one email per person, never per-item.
        await insertNotifications(supabase, focusRows, warnings);
      }
    } catch (err) {
      await logError({ endpoint: 'cron-overdue-check:focusDigest', error: err });
      warnings.push(`focusDigest: ${err.message}`);
    }

    // Daily backup snapshot — see the header comment above. Runs every
    // invocation, independent of the overdue-notifications branch above, so
    // a disabled overdue toggle (or an overdue-side warning) never silently
    // stops the daily backup from happening. Failures here are logged and
    // reported in the response but never turn this endpoint's own overdue
    // work into a failure — the two jobs are independent, just sharing a
    // schedule slot.
    let backup;
    try {
      const { warnings: backupWarnings, snapshot } = await buildBackupSnapshot(supabase);
      const id = await insertBackupRow(supabase, 'daily-auto', snapshot);
      const prune = await pruneOldDailyBackups(supabase, 30);
      if (backupWarnings.length) {
        await logError({ endpoint: 'cron-overdue-check:backup', error: `snapshot completed with ${backupWarnings.length} table warning(s)`, extra: { warnings: backupWarnings } });
      }
      backup = { ok: true, id, tableCounts: snapshot.meta.tableCounts, warnings: backupWarnings, trimmed: prune.trimmed, pruneError: prune.error || null };
    } catch (err) {
      await logError({ endpoint: 'cron-overdue-check:backup', error: err });
      backup = { ok: false, error: err.message };
    }

    return res.status(200).json({ ok: true, summary, warnings, backup });
  } catch (err) {
    await logError({ endpoint: 'cron-overdue-check', error: err });
    return res.status(500).json({ error: err.message });
  }
}
