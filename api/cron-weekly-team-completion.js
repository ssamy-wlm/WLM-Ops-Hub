// Vercel Cron: weekly team-completion report — David's Friday-noon digest
// of the whole team's completed work (tasks + services marked done) in the
// trailing 7 days, grouped by person. One of only three email types David
// still receives after the "David email overhaul" ticket (2026-09-25) —
// see api/ops-sync.js's isEmailSuppressedForDavid()/DAVID_EMAIL_ALLOWED_TYPES
// for the other two and the full suppression rationale.
//
// Auth: same CRON_SECRET Bearer-token pattern every other cron endpoint in
// this app already uses (see cron-overdue-check.js's own header comment).
//
// Schedule: vercel.json "0 17 * * 5" — Friday 17:00 UTC = Friday 12:00 PM
// EST (fixed UTC-5, not DST-adjusted — matching cron-overdue-check.js's
// own established "EST means a fixed UTC-5 offset in this codebase"
// convention for its twice-daily overdue self-nag, not real wall-clock ET,
// which is UTC-4 for most of the year).
//
// Recipient: David only, resolved fresh against the live ops_admins table
// by email — never a hardcoded id, same discipline api/inbound-email.js's
// resolveInboundSender() already established for him.
//
// "Completed" reuses the exact same signal cron-overdue-check.js's own
// hierarchy-escalation "completedSince" scan already uses for this same
// underlying concept (a task's completedAt timestamp, a service's lastDone
// date, both stamped the instant something is actually marked Done/done —
// see markServiceDone() in client.html and the completedAt-on-Done
// convention shared by every task-status-change path) — reused here rather
// than inventing a second definition of "done" for the same fields.
// Multiple assignees on one item (assigneeIds[]) credit every one of them,
// same "everyone named owns it" convention already applied elsewhere in
// this app (e.g. api/process-transcript.js's multi-name task parsing).
//
// Includes every client regardless of active/inactive status — this is a
// retrospective record of what actually happened this week, not a live
// workload view, so a client deactivated mid-week must not silently drop
// the real work already completed for them (different concern from the
// "hide a deactivated client's services from live employee views" fix —
// see CLAUDE.md's 2026-09-24 entry — which is about future/pending work,
// not history).
//
// Idempotency: read-based, same shape as cron-work-anniversaries.js — a
// 'weeklyTeamCompletion' notification whose context.weekEnding already
// matches today's run (UTC date) is treated as already sent, so a
// duplicate/retried invocation on the same Friday never double-sends.
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { logError } from '../lib/errorLog.js';
import { insertNotifications, DAVID_EMAIL } from './ops-sync.js';

function todayIsoUtc() { return new Date().toISOString().slice(0, 10); }

// Exported for direct unit testing (CLAUDE.md rule #9).
export function itemAssigneeIds(item) {
  if (Array.isArray(item.assigneeIds) && item.assigneeIds.length) return item.assigneeIds;
  if (item.assigneeId) return [item.assigneeId];
  return [];
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.authorization || '';
  if (!secret || header !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'cron-weekly-team-completion', error: err }); return res.status(500).json({ error: err.message }); }

  try {
    const weekEnding = todayIsoUtc();

    const { data: existingRows, error: nErr } = await supabase.from('ops_notifications')
      .select('id, data').eq('data->>type', 'weeklyTeamCompletion');
    if (nErr) throw new Error(nErr.message);
    if ((existingRows || []).some(r => r.data?.context?.weekEnding === weekEnding)) {
      return res.status(200).json({ ok: true, sent: false, reason: 'already sent for this week' });
    }

    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 7);
    const cutoffIso = cutoff.toISOString();
    const cutoffDateStr = cutoffIso.slice(0, 10);

    const [{ data: userRows, error: uErr }, { data: adminRows, error: aErr }, { data: taskRows, error: tErr }, { data: clientRows, error: cErr }] = await Promise.all([
      supabase.from('ops_users').select('id, data'),
      supabase.from('ops_admins').select('id, data'),
      supabase.from('ops_tasks').select('id, data'),
      supabase.from('ops_clients').select('id, data'),
    ]);
    if (uErr) throw new Error(uErr.message);
    if (aErr) throw new Error(aErr.message);
    if (tErr) throw new Error(tErr.message);
    if (cErr) throw new Error(cErr.message);

    const users = (userRows || []).map(r => ({ id: r.id, ...r.data }));
    const admins = (adminRows || []).map(r => ({ id: r.id, ...r.data }));
    const nameForId = (id) => (users.find(p => p.id === id) || admins.find(p => p.id === id))?.name || '';

    // Display name -> list of one-line completed-item descriptions.
    const byPerson = new Map();
    const addItem = (item, label) => {
      const ids = itemAssigneeIds(item);
      const names = ids.length
        ? ids.map(id => nameForId(id) || id)
        : [String(item.assigneeName || item.assignee || '').trim() || 'Unassigned'];
      names.forEach(name => {
        if (!byPerson.has(name)) byPerson.set(name, []);
        byPerson.get(name).push(label);
      });
    };

    (taskRows || []).forEach(r => {
      const t = r.data; if (!t) return;
      if (t.status !== 'Done' || !t.completedAt || t.completedAt < cutoffIso) return;
      const clientPart = t.clientName ? ` — ${t.clientName}` : '';
      addItem(t, `Task: ${t.subject || '(untitled task)'}${clientPart}`);
    });

    (clientRows || []).forEach(r => {
      const c = r.data; if (!c) return;
      const scan = (list, locName) => (list || []).forEach(s => {
        if (!s || s.workStatus !== 'done' || !s.lastDone || s.lastDone < cutoffDateStr) return;
        const forName = locName ? `${c.name} — ${locName}` : c.name;
        addItem(s, `Service: ${s.name || '(unnamed service)'} — ${forName}`);
      });
      scan(c.services, null);
      (c.locations || []).forEach(loc => scan(loc.services, loc.name));
    });

    const people = [...byPerson.keys()].sort((a, b) => a.localeCompare(b));
    const bodyLines = people.length
      ? people.map(name => `${name} (${byPerson.get(name).length}):\n${byPerson.get(name).map(l => `  • ${l}`).join('\n')}`).join('\n\n')
      : 'No tasks or services were marked done this week.';

    const david = admins.find(a => String(a.email || '').toLowerCase() === DAVID_EMAIL);
    if (!david) {
      await logError({ endpoint: 'cron-weekly-team-completion', error: 'David not found in ops_admins by email — report not sent' });
      return res.status(200).json({ ok: true, sent: false, reason: 'David not resolved' });
    }

    const warnings = [];
    // bypassQuietHours: this is a precisely-scheduled report (Friday noon
    // EST, per its own acceptance criteria), same "lands exactly when
    // promised" reasoning cron-overdue-check.js's own digest/nag sends
    // already use opts.bypassQuietHours for — not the "no same-day
    // urgency" case cron-work-anniversaries.js deliberately leaves subject
    // to quiet hours.
    await insertNotifications(supabase, [{
      type: 'weeklyTeamCompletion', recipientId: david.id, recipientKind: 'admin',
      recipientName: david.name || '', recipientEmail: david.email,
      title: `Team completion report — week ending ${weekEnding}`,
      body: bodyLines, link: '', context: { weekEnding },
    }], warnings, { bypassQuietHours: true });
    if (warnings.length) await logError({ endpoint: 'cron-weekly-team-completion', error: warnings.join('; ') });

    return res.status(200).json({ ok: true, sent: true, weekEnding, peopleCount: people.length });
  } catch (err) {
    await logError({ endpoint: 'cron-weekly-team-completion', error: err });
    return res.status(500).json({ ok: false, error: err.message });
  }
}
