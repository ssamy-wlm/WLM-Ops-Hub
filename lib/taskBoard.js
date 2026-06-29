// Vanilla-JS equivalent of a React "useRealtimeTasks" hook + Kanban
// component, since this app has no React/build step. mountTaskBoard() does
// what the hook would: fetch the current data, render it, then subscribe to
// Postgres changes so every other team member's screen updates instantly
// when someone moves a task — no polling, no page refresh.

import { getSupabaseClient } from './supabaseClient.js';

const STATUSES = ['Todo', 'In Progress', 'Done'];

export async function mountTaskBoard(container) {
  const supabase = await getSupabaseClient();

  let tasks = [];
  let clients = [];
  let profiles = [];

  async function loadAll() {
    const [{ data: t, error: tErr }, { data: c, error: cErr }, { data: p, error: pErr }] = await Promise.all([
      supabase.from('tasks').select('*').order('created_at'),
      supabase.from('clients').select('*'),
      supabase.from('profiles').select('*'),
    ]);
    const err = tErr || cErr || pErr;
    if (err) {
      container.textContent = `Failed to load: ${err.message}`;
      return;
    }
    tasks = t || [];
    clients = c || [];
    profiles = p || [];
    render();
  }

  function clientName(id) {
    return clients.find(c => c.id === id)?.name || '—';
  }
  function assigneeName(id) {
    return profiles.find(p => p.id === id)?.full_name || 'Unassigned';
  }

  function render() {
    container.innerHTML = STATUSES.map(status => `
      <div class="task-column" data-status="${status}">
        <h3>${status}</h3>
        ${tasks.filter(t => t.status === status).map(t => `
          <div class="task-card" data-task-id="${t.id}">
            <strong>${escapeHtml(t.title)}</strong>
            <div class="task-client">${escapeHtml(clientName(t.client_id))}</div>
            <div class="task-assignee">${escapeHtml(assigneeName(t.assigned_to))}</div>
          </div>
        `).join('')}
      </div>
    `).join('');
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  await loadAll();

  // Realtime subscription: any INSERT/UPDATE/DELETE on tasks, from any team
  // member's session, patches the in-memory array and re-renders instantly.
  supabase
    .channel('tasks-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, payload => {
      if (payload.eventType === 'INSERT') {
        tasks.push(payload.new);
      } else if (payload.eventType === 'UPDATE') {
        const i = tasks.findIndex(t => t.id === payload.new.id);
        if (i !== -1) tasks[i] = payload.new;
      } else if (payload.eventType === 'DELETE') {
        tasks = tasks.filter(t => t.id !== payload.old.id);
      }
      render();
    })
    .subscribe();

  // Example of writing a change — call this from a real UI control (e.g. a
  // drag-and-drop drop handler) to move a task between columns. Every other
  // open tab/team-member receives the resulting UPDATE event above.
  async function setTaskStatus(taskId, status) {
    const { error } = await supabase.from('tasks').update({ status }).eq('id', taskId);
    if (error) console.error('[taskBoard] failed to update task status:', error.message);
  }

  return { setTaskStatus };
}
