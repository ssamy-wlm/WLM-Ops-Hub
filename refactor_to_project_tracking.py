#!/usr/bin/env python3
"""
Major refactoring: Remove EOD reports and blockers, replace with project activity tracking.
"""
import re

with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

print("Starting major refactoring...")
print(f"Original file size: {len(content)} chars")

# ═══════════════════════════════════════════════════════════════
# STEP 1: Update DB_KEYS — remove eods, blockers, add projectActivities
# ═══════════════════════════════════════════════════════════════
old_db_keys = """const DB_KEYS = {
  feed:     'wl_live_feed',
  eods:     'wl_eod_reports',
  blockers: 'wl_blockers_db',
  weeklySummaries: 'wl_weekly_summaries',
  monthlySummaries: 'wl_monthly_summaries',
  users:    'wl_users_db',
  coc:      'wl_coc_data',
  settings: 'wl_settings',
  goals:    'wl_goals_db',
  orgNodes: 'wl_org_nodes',
  orgLinks: 'wl_org_links',
  admins:        'wl_admins_db',
  otPolicy:      'wl_ot_policy',
  deletedEodIds: 'wl_deleted_eod_ids',
  deletedUserIds:'wl_deleted_user_ids',
  messages:      'wl_messages_db',
  roadmapTasks:  'wl_roadmap_tasks',
};"""

new_db_keys = """const DB_KEYS = {
  feed:     'wl_live_feed',
  projectActivities: 'wl_project_activities',
  users:    'wl_users_db',
  coc:      'wl_coc_data',
  settings: 'wl_settings',
  goals:    'wl_goals_db',
  orgNodes: 'wl_org_nodes',
  orgLinks: 'wl_org_links',
  admins:        'wl_admins_db',
  otPolicy:      'wl_ot_policy',
  deletedUserIds:'wl_deleted_user_ids',
  messages:      'wl_messages_db',
  roadmapTasks:  'wl_roadmap_tasks',
};"""

if old_db_keys in content:
    content = content.replace(old_db_keys, new_db_keys)
    print("✓ DB_KEYS updated")
else:
    print("✗ DB_KEYS not found (pattern mismatch)")

# ═══════════════════════════════════════════════════════════════
# STEP 2: Remove all EOD and blocker UI sections from user app
# ═══════════════════════════════════════════════════════════════
# This is complex — we'll use targeted removals for major sections

# Track removal stats
eod_removed = 0
blocker_removed = 0

# We'll need to manually handle the major UI blocks in separate edits
# For now, mark this as TODO and continue with backend cleanup

print("✓ Step 2: UI removal marked for manual cleanup (too complex for automated regex)")

# ═══════════════════════════════════════════════════════════════
# STEP 3: Add new project activity logging system
# ═══════════════════════════════════════════════════════════════

# Find insertion point after dbPush function
insertion_marker = """function dbPush(key, item){ const arr = dbGet(key)||[]; arr.unshift(item); dbSet(key, arr.slice(0,500)); }"""

new_activity_system = """function dbPush(key, item){ const arr = dbGet(key)||[]; arr.unshift(item); dbSet(key, arr.slice(0,500)); }

// ═══════════════════════════════════════════════════════════════
// PROJECT ACTIVITY TRACKING SYSTEM
// ═══════════════════════════════════════════════════════════════
function logProjectActivity(type, description, projectName, details){
  const userName = _getCurrentUserName ? _getCurrentUserName() : 'Unknown User';
  const activity = {
    id: Date.now(),
    user: userName,
    type: type, // 'progress', 'update', 'edit', 'addition', 'deletion', 'comment'
    description: description,
    project: projectName || 'General',
    details: details || '',
    timestamp: new Date().toISOString(),
    date: new Date().toISOString().slice(0,10)
  };
  dbPush(DB_KEYS.projectActivities, activity);
  logActivity('project', userName, description, projectName);
  return activity;
}

function getRecentProjectActivities(limit=50){
  return (dbGet(DB_KEYS.projectActivities)||[]).slice(0, limit);
}

function getUserProjectActivities(userName, limit=20){
  const all = dbGet(DB_KEYS.projectActivities)||[];
  return all.filter(a => a.user === userName).slice(0, limit);
}

function getProjectActivitiesForProject(projectName, limit=20){
  const all = dbGet(DB_KEYS.projectActivities)||[];
  return all.filter(a => a.project === projectName).slice(0, limit);
}"""

if insertion_marker in content:
    content = content.replace(insertion_marker, new_activity_system)
    print("✓ Project activity tracking system added")
else:
    print("✗ Could not find insertion point for activity system")

print(f"\nRefactored file size: {len(content)} chars")
print("\nWriting refactored content...")

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(content)

print("✓ Phase 1 complete: DB layer and activity system added")
print("\nNOTE: This is a multi-phase refactor. Next steps:")
print("  - Remove EOD/blocker UI elements manually")
print("  - Update admin overview to show project activities")
print("  - Update cloud sync to use projectActivities instead of eods/blockers")
