// Detects task field changes written through /api/cloud-data and emails the
// newly-assigned person + the relevant admin, batching rapid edits into one
// summary per task after a quiet window. Wired into /api/cloud-data.js only —
// does not read or alter the PR #41 client-snapshot merge logic.

import { dualGet, dualPut } from './_blob-dual.js';
import { buildEmailHtml, sendResendEmail } from './_resend.js';

const QUEUE_PATH = 'wlm-ops-hub/pending-task-notifications.json';
const QUIET_WINDOW_MS = 90 * 1000;
const MAX_ATTEMPTS = 5;
const APP_ORIGIN = 'https://wlm-ops-hub.vercel.app';

function allTasks(record) {
  const out = [];
  for (const c of record.clients || []) {
    for (const p of c.projects || []) {
      for (const t of p.tasks || []) out.push({ client: c, project: p, sub: null, task: t });
      for (const sp of p.subprojects || []) {
        for (const t of sp.tasks || []) out.push({ client: c, project: p, sub: sp, task: t });
      }
    }
  }
  return out;
}

function findPerson(record, id) {
  if (!id) return null;
  const users = record.users || [];
  const admins = record.admins || [];
  return users.find(u => u.id === id) || admins.find(a => a.id === id) || null;
}

function adminRecipients(record, client) {
  if (client && client.managerId) {
    const mgr = findPerson(record, client.managerId);
    if (mgr && mgr.email) return [mgr];
  }
  return (record.admins || []).filter(a => a.email);
}

function formatDate(iso) {
  if (!iso) return '(none)';
  const parts = String(iso).split('-').map(Number);
  if (!parts[0]) return iso;
  const dt = new Date(Date.UTC(parts[0], (parts[1] || 1) - 1, parts[2] || 1));
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// Compares the previously-stored record against the one about to be written
// and returns one entry per task with a real, net field change.
export function detectTaskChanges(oldRecord, newRecord) {
  const oldByTaskId = new Map();
  for (const entry of allTasks(oldRecord || {})) oldByTaskId.set(entry.task.id, entry);

  const changes = [];
  for (const entry of allTasks(newRecord || {})) {
    const { client, project, sub, task } = entry;
    const prev = oldByTaskId.get(task.id);
    const fields = {};

    if (!prev) {
      if (task.assigneeId) fields.assigneeId = { from: null, to: task.assigneeId };
    } else {
      if ((prev.task.assigneeId || '') !== (task.assigneeId || '')) {
        fields.assigneeId = { from: prev.task.assigneeId || null, to: task.assigneeId || null };
      }
      if ((prev.task.due || '') !== (task.due || '')) {
        fields.due = { from: prev.task.due || null, to: task.due || null };
      }
      if (!!prev.task.done !== !!task.done) {
        fields.done = { from: !!prev.task.done, to: !!task.done };
      }
    }

    if (Object.keys(fields).length) {
      changes.push({
        taskId: task.id, taskName: task.name, due: task.due, assigneeId: task.assigneeId,
        clientId: client.id, clientName: client.name, managerId: client.managerId,
        projectId: project.id, projectName: sub ? sub.name : project.name,
        editedBy: task.lastEditedBy || null,
        fields,
      });
    }
  }
  return changes;
}

async function readQueue() {
  try {
    const blob = await dualGet(QUEUE_PATH, { access: 'private', useCache: false });
    if (!blob) return {};
    const text = await new Response(blob.stream).text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    console.error('[task-notifications] failed to read pending queue:', err.message || err);
    return {};
  }
}

async function writeQueue(queue) {
  await dualPut(QUEUE_PATH, JSON.stringify(queue), {
    access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 0,
  });
}

// Merges newly-detected changes into the pending batch for each task. If a
// field's net change across the whole open batch cancels out (e.g. toggled
// done then undone again before the batch flushed), that field — or the
// whole batch, if nothing is left — is dropped rather than emailed.
export async function enqueueTaskChanges(changes) {
  if (!changes.length) return;
  const queue = await readQueue();
  const now = Date.now();

  for (const change of changes) {
    const existing = queue[change.taskId];
    if (existing) {
      for (const [key, val] of Object.entries(change.fields)) {
        const prevFrom = (key in existing.fields) ? existing.fields[key].from : val.from;
        if (JSON.stringify(prevFrom) === JSON.stringify(val.to)) {
          delete existing.fields[key];
        } else {
          existing.fields[key] = { from: prevFrom, to: val.to };
        }
      }
      existing.lastChangedAt = now;
      existing.editedBy = change.editedBy || existing.editedBy;
      existing.taskName = change.taskName;
      existing.assigneeId = change.assigneeId;
      existing.due = change.due;
      existing.clientName = change.clientName;
      existing.managerId = change.managerId;
      existing.projectName = change.projectName;
      if (!Object.keys(existing.fields).length) delete queue[change.taskId];
    } else {
      queue[change.taskId] = {
        taskId: change.taskId, taskName: change.taskName, due: change.due, assigneeId: change.assigneeId,
        clientId: change.clientId, clientName: change.clientName, managerId: change.managerId,
        projectId: change.projectId, projectName: change.projectName,
        editedBy: change.editedBy, fields: change.fields,
        firstChangedAt: now, lastChangedAt: now, attempts: 0,
      };
    }
  }

  await writeQueue(queue);
}

function describeFields(batch, record) {
  const lines = [];
  if (batch.fields.assigneeId) {
    const from = findPerson(record, batch.fields.assigneeId.from)?.name || 'Unassigned';
    const to = findPerson(record, batch.fields.assigneeId.to)?.name || 'Unassigned';
    lines.push(`Assignee changed from <strong>${from}</strong> to <strong>${to}</strong>`);
  }
  if (batch.fields.due) {
    lines.push(`Due date changed from <strong>${formatDate(batch.fields.due.from)}</strong> to <strong>${formatDate(batch.fields.due.to)}</strong>`);
  }
  if (batch.fields.done) {
    lines.push(batch.fields.done.to ? 'Marked as <strong>done</strong>' : 'Reopened (<strong>marked not done</strong>)');
  }
  return lines;
}

async function sendBatchEmails(record, batch) {
  const lines = describeFields(batch, record);
  if (!lines.length) return;

  const client = (record.clients || []).find(c => c.id === batch.clientId);
  const link = `${APP_ORIGIN}/client?openClient=${encodeURIComponent(batch.clientId)}&openProject=${encodeURIComponent(batch.projectId)}&openTask=${encodeURIComponent(batch.taskId)}`;
  const editorName = batch.editedBy?.name || 'Someone';
  const changeList = lines.map(l => `&bull; ${l}`).join('<br>');
  const assignee = findPerson(record, batch.assigneeId);
  const assignedNow = !!batch.fields.assigneeId;

  const recipients = new Map(); // email -> { name, role }
  if (assignee && assignee.email && assignee.id !== batch.editedBy?.id) {
    recipients.set(assignee.email, { name: assignee.name, role: 'assignee' });
  }
  for (const admin of adminRecipients(record, client)) {
    if (!admin.email) continue;
    if (admin.id === batch.editedBy?.id) continue;
    if (recipients.has(admin.email)) continue;
    recipients.set(admin.email, { name: admin.name, role: 'admin' });
  }
  if (!recipients.size) return;

  const bodyHtml = `
    <strong>Client:</strong> ${batch.clientName}<br>
    <strong>Service/Project:</strong> ${batch.projectName || ''}<br>
    <strong>Task:</strong> ${batch.taskName}<br>
    <strong>Due:</strong> ${formatDate(batch.due)}<br>
    <strong>Edited by:</strong> ${editorName}<br><br>
    <strong>What changed:</strong><br>${changeList}`;

  for (const [email, info] of recipients) {
    const subject = info.role === 'assignee'
      ? (assignedNow ? `You've been assigned: ${batch.clientName} — ${batch.taskName}` : `Task updated: ${batch.clientName} — ${batch.taskName}`)
      : (assignedNow ? `${assignee?.name || 'Someone'} was just assigned ${batch.taskName}` : `Task updated: ${batch.clientName} — ${batch.taskName}`);
    const html = buildEmailHtml({ name: (info.name || '').split(' ')[0], title: subject, body: bodyHtml, link });
    await sendResendEmail({ to: email, subject, html });
  }
}

// Called opportunistically from both the GET and PUT handlers of
// /api/cloud-data — the app already polls that endpoint every ~20-30s from
// open tabs, so this acts as a self-driven flush without needing Vercel Cron.
export async function flushDueTaskNotifications(record) {
  let queue;
  try {
    const blob = await dualGet(QUEUE_PATH, { access: 'private', useCache: false });
    if (!blob) return;
    const text = await new Response(blob.stream).text();
    queue = text ? JSON.parse(text) : {};
  } catch (err) {
    console.error('[task-notifications] failed to read pending queue for flush:', err.message || err);
    return;
  }
  if (!queue || !Object.keys(queue).length) return;

  const now = Date.now();
  const due = Object.values(queue).filter(b => now - b.lastChangedAt >= QUIET_WINDOW_MS);
  if (!due.length) return;

  let changed = false;
  for (const batch of due) {
    try {
      await sendBatchEmails(record, batch);
      delete queue[batch.taskId];
      changed = true;
    } catch (err) {
      batch.attempts = (batch.attempts || 0) + 1;
      console.error(`[task-notifications] failed to send notification for task ${batch.taskId} (attempt ${batch.attempts}):`, err.message || err);
      changed = true;
      if (batch.attempts >= MAX_ATTEMPTS) {
        console.error(`[task-notifications] giving up on task ${batch.taskId} after ${MAX_ATTEMPTS} attempts`);
        delete queue[batch.taskId];
      }
    }
  }

  if (changed) await writeQueue(queue);
}
