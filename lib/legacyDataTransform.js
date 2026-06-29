// Pure transform: Blob cloud-data.json shape -> ops_* row shapes, keyed by
// legacy id. No DB calls, no hashing, no network — this is what makes it
// unit-testable offline against wlm_clients_seed.json without touching
// Supabase. FK columns are emitted as "<entity>_legacy_id" here; the caller
// (api/import-legacy-data.js) resolves those to real uuids once each parent
// batch has been inserted and its legacy_id -> id map is known.
//
// Defensive against field-name drift: several nested collections (goals,
// feed, messages, roadmapTasks, orgLinks) were documented from code review
// rather than a live data dump, so field access uses fallback chains where
// the exact key wasn't certain. Run this against the real blob and check
// `warnings` before trusting it as final.

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

export function transformUsers(record) {
  return asArray(record.users).map(u => ({
    legacy_id: u.id,
    name: u.name || '',
    email: u.email || '',
    password: u.password || '',
    status: u.archived ? 'archived' : (u.status === 'archived' ? 'archived' : 'active'),
    title: u.title ?? null,
    role: u.role || 'Employee',
    resp: u.resp ?? null,
    hours: u.hours ?? null,
    pay_rate: u.payRate ?? null,
    manager_legacy_id: u.managerId ?? null,
    probation_start: u.probationStart ?? null,
    probation_end: u.probationEnd ?? null,
    must_change_password: !!u.mustChangePassword,
    first_login: u.firstLogin !== false,
    seeded: !!u.seeded,
    archived_at: u.archivedAt ?? null,
  }));
}

export function transformAdmins(record) {
  return asArray(record.admins).map(a => ({
    legacy_id: a.id,
    name: a.name || '',
    email: a.email || '',
    password: a.password || '',
    title: a.title ?? null,
    initials: a.initials ?? null,
    level: a.level || 'admin',
    status: a.status || 'active',
  }));
}

export function transformAdminAssignedUsers(record) {
  const rows = [];
  for (const a of asArray(record.admins)) {
    for (const userId of asArray(a.assignedUsers)) {
      rows.push({ admin_legacy_id: a.id, user_legacy_id: userId });
    }
  }
  return rows;
}

export function transformDeletedUserIds(record) {
  return asArray(record.deletedUserIds).map(id => ({ legacy_user_id: id }));
}

export function transformClients(record) {
  return asArray(record.clients).map(c => ({
    legacy_id: c.id,
    name: c.name || '',
    pinned: !!c.pinned,
    status: c.status === 'archived' ? 'archived' : 'active',
    color: c.color ?? null,
    code: c.code ?? null,
    industry: c.industry ?? null,
    account_manager: c.accountManager ?? null,
    manager_legacy_id: c.managerId ?? null,
    client_name: c.clientName ?? null,
    client_email: c.clientEmail ?? null,
    client_phone: c.clientPhone ?? null,
    referred_by: c.referredBy ?? null,
    notes: c.notes ?? null,
    internal_notes: c.internalNotes ?? null,
    website: c.website ?? null,
    logo: c.logo ?? null,
    brand_colors: asArray(c.brandColors),
    brand_details: c.brandDetails ?? null,
    start_date: c.start ?? null,
  }));
}

export function transformServices(record) {
  const rows = [];
  for (const c of asArray(record.clients)) {
    for (const s of asArray(c.services)) {
      rows.push({
        legacy_id: s.id,
        client_legacy_id: c.id,
        catalog_id: s.catalogId ?? null,
        name: s.name || '',
        freq: s.freq ?? null,
        freq_label: s.freqLabel ?? null,
        assignee_legacy_id: s.assigneeId ?? null,
        assignee_name: s.assigneeName ?? s.assignee ?? null,
        status: s.status || 'active',
        last_done: s.lastDone ?? null,
        due: s.due ?? null,
        platforms: s.platforms ?? null,
        notes: s.notes ?? null,
      });
    }
  }
  return rows;
}

export function transformProjects(record) {
  const rows = [];
  for (const c of asArray(record.clients)) {
    for (const p of asArray(c.projects)) {
      rows.push({
        legacy_id: p.id,
        client_legacy_id: c.id,
        service_legacy_id: p.serviceId ?? null,
        name: p.name || '',
        type: p.type ?? null,
        billing: p.billing ?? null,
        status: p.status || 'not-started',
        priority: p.priority ?? null,
        start_date: p.start ?? null,
        due_date: p.due ?? null,
        color: p.color ?? null,
        description: p.desc ?? null,
        progress: p.progress ?? null,
        progress_log: asArray(p.progressLog),
        milestones: asArray(p.milestones),
        is_recurring_service: !!p.isRecurringService,
        freq: p.freq ?? null,
        freq_label: p.freqLabel ?? null,
        last_done: p.lastDone ?? null,
      });
    }
  }
  return rows;
}

export function transformProjectUsers(record) {
  const rows = [];
  for (const c of asArray(record.clients)) {
    for (const p of asArray(c.projects)) {
      for (const userId of asArray(p.users)) {
        rows.push({ project_legacy_id: p.id, user_legacy_id: userId });
      }
    }
  }
  return rows;
}

export function transformSubprojects(record) {
  const rows = [];
  for (const c of asArray(record.clients)) {
    for (const p of asArray(c.projects)) {
      for (const sp of asArray(p.subprojects)) {
        rows.push({
          legacy_id: sp.id,
          project_legacy_id: p.id,
          name: sp.name || '',
          billing: sp.billing ?? null,
          status: sp.status ?? null,
        });
      }
    }
  }
  return rows;
}

export function transformSubprojectUsers(record) {
  const rows = [];
  for (const c of asArray(record.clients)) {
    for (const p of asArray(c.projects)) {
      for (const sp of asArray(p.subprojects)) {
        for (const userId of asArray(sp.users)) {
          rows.push({ subproject_legacy_id: sp.id, user_legacy_id: userId });
        }
      }
    }
  }
  return rows;
}

function transformTask(t, parent) {
  return {
    legacy_id: t.id,
    ...parent,
    name: t.name || '',
    assignee_legacy_id: t.assigneeId ?? null,
    assignee_name: t.assigneeName ?? null,
    due: t.due ?? null,
    done: !!t.done,
    last_edited_by_legacy_id: t.lastEditedBy?.id ?? null,
    last_edited_by_name: t.lastEditedBy?.name ?? null,
  };
}

export function transformTasks(record) {
  const rows = [];
  for (const c of asArray(record.clients)) {
    for (const p of asArray(c.projects)) {
      for (const t of asArray(p.tasks)) {
        rows.push(transformTask(t, { project_legacy_id: p.id, subproject_legacy_id: null }));
      }
      for (const sp of asArray(p.subprojects)) {
        for (const t of asArray(sp.tasks)) {
          rows.push(transformTask(t, { project_legacy_id: null, subproject_legacy_id: sp.id }));
        }
      }
    }
  }
  return rows;
}

export function transformOrgNodes(record) {
  return asArray(record.orgNodes).map(n => ({
    legacy_id: n.id,
    name: n.name || '',
    title: n.title ?? null,
    level: n.level ?? null,
    x: n.x ?? null,
    y: n.y ?? null,
    fixed: !!n.fixed,
    photo: n.photo ?? null, // base64 data URL or null; extracted to Storage by the caller, never written to a column
  }));
}

export function transformOrgLinks(record) {
  return asArray(record.orgLinks).map(l => ({
    manager_legacy_id: l.managerId ?? l.manager ?? l.from ?? null,
    report_legacy_id: l.reportId ?? l.report ?? l.to ?? null,
  })).filter(l => l.manager_legacy_id && l.report_legacy_id);
}

export function transformGoals(record) {
  return asArray(record.goals).map(g => ({
    legacy_id: g.id,
    title: g.title ?? g.name ?? '',
    description: g.description ?? null,
    progress: g.progress ?? null,
    due_date: g.dueDate ?? g.due ?? null,
  }));
}

export function transformFeed(record) {
  return asArray(record.feed).map(f => ({
    legacy_id: f.id ?? null,
    type: f.type ?? null,
    user_name: f.user ?? null,
    description: f.desc ?? null,
    detail: f.detail ?? null,
    occurred_at: f.time ?? f.date ?? null,
  }));
}

export function transformMessages(record) {
  return asArray(record.messages).map(m => ({
    legacy_id: m.id ?? null,
    title: m.title ?? null,
    body: m.body ?? null,
    user_name: m.user ?? null,
    created_at: m.timestamp ?? null,
  }));
}

export function transformRoadmapTasks(record) {
  return asArray(record.roadmapTasks).map(r => ({
    legacy_id: r.id ?? null,
    data: r,
  }));
}

export function transformTimeOffRequests(record) {
  return asArray(record.timeOffRequests).map(r => ({
    legacy_id: r.id,
    user_legacy_id: r.userId,
    start_date: r.startDate,
    end_date: r.endDate,
    status: r.status || 'pending',
    approved_by_legacy_id: r.approvedBy ?? null,
  }));
}

export function transformTimeOffLedger(record) {
  return asArray(record.timeOffLedger).map(r => ({
    legacy_id: r.id,
    user_legacy_id: r.userId,
    hours: r.hours,
    logged_at: r.loggedAt,
  }));
}

function parseJsonArrayString(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function transformSettingsSingleton(record) {
  return {
    announcement: record.announcement ?? null,
    coc: record.coc ?? null,
    app_settings: record.settings ?? null,
    ot_policy: record.otPolicy ?? null,
    org_layout_version: record.orgLayoutVersion ?? null,
    org_excluded_names: parseJsonArrayString(record.orgExcluded),
    primary_admin_password: record.primaryAdminPw ?? null, // plaintext in, hashed by the caller
  };
}

export function transformRecurringServicesDropped(record) {
  let count = 0;
  const byClient = [];
  for (const c of asArray(record.clients)) {
    const n = asArray(c.recurringServices).length;
    if (n) {
      count += n;
      byClient.push({ clientId: c.id, clientName: c.name, count: n });
    }
  }
  return { count, byClient };
}
