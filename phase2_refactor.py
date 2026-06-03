#!/usr/bin/env python3
"""
Phase 2 Refactor Script for WLM-Ops-Hub
========================================
1. Replace user nav Reports + Blockers with "My Projects" nav item
2. Replace sec-reports section with Log Project Activity form
3. Remove sec-blockers section entirely
4. Update topbar button (EOD -> Log Update)
5. Update operations section (remove EOD refs)
6. Remove admin nav "All Reports" dropdown
7. Remove admin-reports page section (and admin-summaries)
8. Redesign admin-overview with project activity feed
9. Update cloudPushAll + cloudPullAll for projectActivities
10. Neutralize EOD submit override + addBlocker override
11. Remove loadUserBlockersFromDB call on login
12. Update live feed stats (remove EOD/blocker stats)
"""

import re

with open('/home/user/webapp/index.html', 'r', encoding='utf-8') as f:
    html = f.read()

print(f"File loaded: {len(html)} chars")

# ============================================================
# 1. User Nav: Replace Reports + Blockers with My Projects
# ============================================================
OLD_NAV = '''      <div class="nav-item active" onclick="showSection('operations',this)"><span class="ni">🏠</span>Operations</div>
      <div class="nav-item" onclick="showSection('reports',this)"><span class="ni">📊</span>Reports</div>
      <div class="nav-item" onclick="showSection('blockers',this)"><span class="ni">🚧</span>Blockers</div>
      <div class="nav-item" onclick="showSection('downtimeTasks',this)"><span class="ni">📋</span>Downtime Tasks</div>'''

NEW_NAV = '''      <div class="nav-item active" onclick="showSection('operations',this)"><span class="ni">🏠</span>Operations</div>
      <div class="nav-item" onclick="showSection('myprojects',this)"><span class="ni">📝</span>My Projects</div>
      <div class="nav-item" onclick="showSection('downtimeTasks',this)"><span class="ni">📋</span>Downtime Tasks</div>'''

if OLD_NAV in html:
    html = html.replace(OLD_NAV, NEW_NAV, 1)
    print("✅ 1. User nav updated: Reports/Blockers -> My Projects")
else:
    print("❌ 1. User nav NOT found — check spacing")

# ============================================================
# 2. Topbar: Replace "Submit EOD" button with "Log Update"
# ============================================================
OLD_TOPBAR = '''        <button class="btn btn-primary btn-sm" onclick="openEODModal()">+ Submit EOD</button>'''
NEW_TOPBAR = '''        <button class="btn btn-primary btn-sm" onclick="showSection('myprojects',document.querySelector('.nav-item:nth-child(2)'))">+ Log Update</button>'''

if OLD_TOPBAR in html:
    html = html.replace(OLD_TOPBAR, NEW_TOPBAR, 1)
    print("✅ 2. Topbar button updated")
else:
    print("❌ 2. Topbar button NOT found")

# ============================================================
# 3. Operations section: remove EOD pulse msg + EOD button
# ============================================================
OLD_PULSE_MSG = '''              <div class="pulse-msg">Currently working — EOD due at end of shift</div>'''
NEW_PULSE_MSG = '''              <div class="pulse-msg">Log your progress and project updates in My Projects</div>'''
if OLD_PULSE_MSG in html:
    html = html.replace(OLD_PULSE_MSG, NEW_PULSE_MSG, 1)
    print("✅ 3a. Pulse message updated")
else:
    print("❌ 3a. Pulse message NOT found")

OLD_EOD_SECTION = '''            <div class="eod-section">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                <div style="font-family:'Playfair Display',serif;font-size:15px;color:var(--text-dark);">Today's Activity</div>
                <span class="status-badge badge-pending">EOD Pending</span>
              </div>
              <div class="eod-empty">No EOD report submitted yet today</div>
              <div style="text-align:center;margin-top:12px;"><button class="btn btn-primary" onclick="openEODModal()">+ Submit EOD Report</button></div>
            </div>'''
NEW_EOD_SECTION = '''            <div class="eod-section">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                <div style="font-family:'Playfair Display',serif;font-size:15px;color:var(--text-dark);">Today's Activity</div>
                <span class="status-badge badge-working" id="ops-activity-count">0 updates</span>
              </div>
              <div id="ops-recent-activity" style="font-size:13px;color:var(--text-light);padding:8px 0;">No updates logged today</div>
              <div style="text-align:center;margin-top:12px;"><button class="btn btn-primary" onclick="showSection('myprojects',document.querySelector('.nav-item:nth-child(2)'))">+ Log Project Update</button></div>
            </div>'''
if OLD_EOD_SECTION in html:
    html = html.replace(OLD_EOD_SECTION, NEW_EOD_SECTION, 1)
    print("✅ 3b. Operations EOD section replaced with activity preview")
else:
    print("❌ 3b. Operations EOD section NOT found")

OLD_STAT_REPORTS = '''          <div class="stat-card">
            <div class="stat-label">This Week</div>
            <div class="stat-value">3</div>
            <div class="stat-sub">Reports submitted</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Open Blockers</div>
            <div class="stat-value" style="color:var(--orange)">1</div>
            <div class="stat-sub">1 needs escalation</div>
          </div>'''
NEW_STAT_REPORTS = '''          <div class="stat-card">
            <div class="stat-label">This Week</div>
            <div class="stat-value" id="ops-week-updates">—</div>
            <div class="stat-sub">Project updates logged</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Projects Active</div>
            <div class="stat-value" id="ops-active-projects">—</div>
            <div class="stat-sub">Assigned to you</div>
          </div>'''
if OLD_STAT_REPORTS in html:
    html = html.replace(OLD_STAT_REPORTS, NEW_STAT_REPORTS, 1)
    print("✅ 3c. Operations stat cards updated")
else:
    print("❌ 3c. Operations stat cards NOT found")

# ============================================================
# 4. Replace sec-reports section with My Projects activity form
# ============================================================
# Find the section between <!-- ── REPORTS ── --> and <!-- ── BLOCKERS ── -->
OLD_REPORTS_SECTION = '''      <!-- ── REPORTS ── -->
      <div id="sec-reports" class="page-section">'''

# Find start and end
reports_start = html.find('      <!-- ── REPORTS ── -->')
blockers_start = html.find('      <!-- ── BLOCKERS ── -->')

if reports_start != -1 and blockers_start != -1:
    reports_section_old = html[reports_start:blockers_start]
    
    NEW_MYPROJECTS_SECTION = '''      <!-- ── MY PROJECTS ── -->
      <div id="sec-myprojects" class="page-section">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-size:20px;font-weight:800;color:var(--text-dark);">📝 My Projects</div>
            <div style="font-size:12px;color:var(--text-light);margin-top:2px;">Log your progress, updates, and changes on assigned projects</div>
          </div>
        </div>

        <!-- Log Project Activity Form -->
        <div class="card" style="margin-bottom:22px;">
          <div class="card-header">
            <div class="card-title">Log Project Activity</div>
            <div class="card-sub">All updates are visible to your admin in real-time</div>
          </div>
          <div class="card-body">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
              <div class="form-group" style="margin:0;">
                <label class="form-label">Project Name <span style="color:var(--red)">*</span></label>
                <input class="form-input" id="projActProjectName" placeholder="e.g. Client A Website Redesign">
              </div>
              <div class="form-group" style="margin:0;">
                <label class="form-label">Activity Type <span style="color:var(--red)">*</span></label>
                <select class="form-select" id="projActType">
                  <option value="">— Select type —</option>
                  <option value="progress">📈 Progress Update</option>
                  <option value="update">💬 General Update</option>
                  <option value="addition">➕ Addition</option>
                  <option value="edit">✏️ Edit / Revision</option>
                  <option value="deletion">🗑️ Deletion</option>
                  <option value="completion">✅ Task Completed</option>
                  <option value="issue">⚠️ Issue Encountered</option>
                </select>
              </div>
            </div>
            <div class="form-group" style="margin-bottom:14px;">
              <label class="form-label">Description <span style="color:var(--red)">*</span></label>
              <textarea class="form-input" id="projActDescription" rows="3" placeholder="Describe what you worked on, what changed, or what was completed…" style="resize:vertical;min-height:80px;"></textarea>
            </div>
            <div class="form-group" style="margin-bottom:14px;">
              <label class="form-label">Additional Details <span style="font-size:11px;color:var(--text-light);">(optional)</span></label>
              <input class="form-input" id="projActDetails" placeholder="e.g. link, file name, related task, or note for admin">
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;">
              <button class="btn btn-outline" onclick="clearProjectActivityForm()">Clear</button>
              <button class="btn btn-primary" onclick="submitProjectActivity()">Submit Update →</button>
            </div>
          </div>
        </div>

        <!-- Recent Activities -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">My Recent Activity</div>
            <div class="card-sub">Your last 20 logged updates</div>
          </div>
          <div class="card-body" id="myProjectActivityList">
            <div style="font-size:13px;color:var(--text-light);padding:12px 0;">No activity logged yet. Submit your first update above.</div>
          </div>
        </div>
      </div>

'''
    html = html[:reports_start] + NEW_MYPROJECTS_SECTION + html[blockers_start:]
    print("✅ 4. sec-reports replaced with sec-myprojects")
else:
    print(f"❌ 4. Could not find reports/blockers sections (reports={reports_start}, blockers={blockers_start})")

# ============================================================
# 5. Remove sec-blockers section entirely
# ============================================================
blockers_start2 = html.find('      <!-- ── BLOCKERS ── -->')
downtime_start = html.find('      <!-- ── DOWNTIME TASKS ── -->')

if blockers_start2 != -1 and downtime_start != -1:
    html = html[:blockers_start2] + html[downtime_start:]
    print("✅ 5. sec-blockers section removed")
else:
    print(f"❌ 5. Could not find blockers section end (blockers={blockers_start2}, downtime={downtime_start})")

# ============================================================
# 6. Remove admin nav "All Reports" dropdown
# ============================================================
OLD_ADMIN_REPORTS_NAV = '''
        <!-- All Reports dropdown -->
        <div class="admin-nav-dropdown">
          <div class="admin-nav-item admin-drop-trigger" onclick="switchAdminTab(this,'reports')" id="admin-drop-reports">All Reports</div>
          <div class="admin-nav-dropdown-menu">
            <div class="admin-nav-item" onclick="switchAdminTab(this,'summaries')">Summaries</div>
          </div>
        </div>
'''
if OLD_ADMIN_REPORTS_NAV in html:
    html = html.replace(OLD_ADMIN_REPORTS_NAV, '\n', 1)
    print("✅ 6. Admin nav 'All Reports' dropdown removed")
else:
    print("❌ 6. Admin nav 'All Reports' NOT found")

# ============================================================
# 7. Redesign admin-overview section
# ============================================================
overview_start = html.find('    <!-- Overview -->')
users_section_start = html.find('    <!-- Users -->')

if overview_start != -1 and users_section_start != -1:
    old_overview = html[overview_start:users_section_start]
    
    NEW_OVERVIEW = '''    <!-- Overview -->
    <div id="admin-overview" class="page-section active">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <div style="font-size:12px;color:var(--text-light);font-weight:600;" id="overviewDateLabel"></div>
        <button class="btn btn-outline btn-sm" onclick="refreshAdminOverview()">↺ Refresh</button>
      </div>

      <!-- Stats row -->
      <div class="admin-stats" style="margin-bottom:22px;">
        <div class="admin-stat"><div class="as-val" id="ov-total-users">0</div><div class="as-label">Total Users</div></div>
        <div class="admin-stat"><div class="as-val" id="ov-updates-today">0</div><div class="as-label">Updates Today</div></div>
        <div class="admin-stat"><div class="as-val" id="ov-updates-week">0</div><div class="as-label">Updates This Week</div></div>
        <div class="admin-stat"><div class="as-val" id="ov-active-contributors">0</div><div class="as-label">Active This Week</div></div>
      </div>

      <!-- Main two-column layout -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;">

        <!-- Left: Team Activity Feed (notifications) -->
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">📣 Team Activity Feed</div>
              <div class="card-sub">All user actions in real-time</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
              <select class="form-select" id="ov-filter-user" onchange="filterOverviewFeed()" style="font-size:11px;width:130px;padding:5px 8px;">
                <option value="">All Users</option>
              </select>
              <select class="form-select" id="ov-filter-type" onchange="filterOverviewFeed()" style="font-size:11px;width:120px;padding:5px 8px;">
                <option value="">All Types</option>
                <option value="progress">📈 Progress</option>
                <option value="update">💬 Update</option>
                <option value="addition">➕ Addition</option>
                <option value="edit">✏️ Edit</option>
                <option value="deletion">🗑️ Deletion</option>
                <option value="completion">✅ Completion</option>
                <option value="issue">⚠️ Issue</option>
              </select>
            </div>
          </div>
          <div class="card-body" id="ov-activity-feed" style="max-height:500px;overflow-y:auto;padding:0;">
            <div style="font-size:13px;color:var(--text-light);padding:24px 0;text-align:center;">No project activity yet. Updates appear here as team members log progress.</div>
          </div>
        </div>

        <!-- Right: Per-User Status -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">👥 Team Status</div>
            <div class="card-sub" id="ov-week-label">This week's activity per person</div>
          </div>
          <div class="card-body" id="ov-user-status-list">
            <div style="font-size:13px;color:var(--text-light);padding:12px 0;">Loading team…</div>
          </div>
        </div>

      </div>
    </div>

'''
    html = html[:overview_start] + NEW_OVERVIEW + html[users_section_start:]
    print("✅ 7. Admin overview redesigned with project activity feed")
else:
    print(f"❌ 7. Could not find overview/users sections (overview={overview_start}, users={users_section_start})")

# ============================================================
# 8. Remove admin-reports section (All Reports table)
# ============================================================
reports_section_admin_start = html.find('    <!-- All Reports -->')
livefeed_section_start = html.find('    <!-- ══ LIVE FEED ══ -->')

if reports_section_admin_start != -1 and livefeed_section_start != -1:
    html = html[:reports_section_admin_start] + html[livefeed_section_start:]
    print("✅ 8. Admin reports section removed")
else:
    print(f"❌ 8. Could not find admin reports section (start={reports_section_admin_start}, livefeed={livefeed_section_start})")

# ============================================================
# 9. Remove admin-summaries section
# ============================================================
summaries_start = html.find('    <!-- ══ SUMMARIES ══ -->')
clients_start = html.find('    <!-- ══ CLIENTS ══ -->')

if summaries_start != -1 and clients_start != -1:
    html = html[:summaries_start] + html[clients_start:]
    print("✅ 9. Admin summaries section removed")
else:
    print(f"❌ 9. Could not find summaries/clients sections (sum={summaries_start}, clients={clients_start})")

# ============================================================
# 10. Update Live Feed filter options (remove EOD/blocker entries)
# ============================================================
OLD_FEED_FILTER = '''          <select class="form-select" id="feed-filter-type" onchange="filterFeed()" style="font-size:13px;width:160px;">
            <option value="">All Activity</option>
            <option value="eod">EOD Submissions</option>
            <option value="blocker">Blockers</option>
            <option value="goal">Goals</option>
            <option value="login">Logins</option>
            <option value="nav">Navigation</option>
          </select>'''
NEW_FEED_FILTER = '''          <select class="form-select" id="feed-filter-type" onchange="filterFeed()" style="font-size:13px;width:160px;">
            <option value="">All Activity</option>
            <option value="project">Project Updates</option>
            <option value="goal">Goals</option>
            <option value="login">Logins</option>
            <option value="nav">Navigation</option>
          </select>'''
if OLD_FEED_FILTER in html:
    html = html.replace(OLD_FEED_FILTER, NEW_FEED_FILTER, 1)
    print("✅ 10. Live feed filter updated")
else:
    print("❌ 10. Live feed filter NOT found")

# ============================================================
# 11. Update Live Feed stats bar (EOD -> Project Updates, Blockers -> Projects)
# ============================================================
OLD_FEED_STATS = '''        <div class="card" style="padding:14px 16px;margin:0;text-align:center;">
          <div style="font-size:22px;font-weight:800;color:var(--green);" id="feed-stat-eod">0</div>
          <div style="font-size:10px;font-weight:700;color:var(--text-light);text-transform:uppercase;letter-spacing:.07em;">EODs Today</div>
        </div>
        <div class="card" style="padding:14px 16px;margin:0;text-align:center;">
          <div style="font-size:22px;font-weight:800;color:var(--orange);" id="feed-stat-blockers">0</div>
          <div style="font-size:10px;font-weight:700;color:var(--text-light);text-transform:uppercase;letter-spacing:.07em;">Blockers Logged</div>
        </div>'''
NEW_FEED_STATS = '''        <div class="card" style="padding:14px 16px;margin:0;text-align:center;">
          <div style="font-size:22px;font-weight:800;color:var(--green);" id="feed-stat-eod">0</div>
          <div style="font-size:10px;font-weight:700;color:var(--text-light);text-transform:uppercase;letter-spacing:.07em;">Updates Today</div>
        </div>
        <div class="card" style="padding:14px 16px;margin:0;text-align:center;">
          <div style="font-size:22px;font-weight:800;color:var(--orange);" id="feed-stat-blockers">0</div>
          <div style="font-size:10px;font-weight:700;color:var(--text-light);text-transform:uppercase;letter-spacing:.07em;">Projects Active</div>
        </div>'''
if OLD_FEED_STATS in html:
    html = html.replace(OLD_FEED_STATS, NEW_FEED_STATS, 1)
    print("✅ 11. Live feed stats bar updated")
else:
    print("❌ 11. Live feed stats bar NOT found")

# ============================================================
# 12. Update cloudPushAll — replace eods/blockers with projectActivities
# ============================================================
# Remove deletedEodIds logic block and eods/blockers from payload
OLD_CLOUD_PUSH_DEL_EODS = '''    // Merge deleted IDs from cloud so all devices share the tombstone list
    const localDelEods  = dbGet(DB_KEYS.deletedEodIds)||[];
    const cloudDelEods  = cloudRecord.deletedEodIds||[];
    const deletedEodIds = [...new Set([...localDelEods, ...cloudDelEods])];
    dbSet(DB_KEYS.deletedEodIds, deletedEodIds);

    const localDelUsers  = dbGet(DB_KEYS.deletedUserIds)||[];
    const cloudDelUsers  = cloudRecord.deletedUserIds||[];
    const deletedUserIds = [...new Set([...localDelUsers, ...cloudDelUsers])];
    dbSet(DB_KEYS.deletedUserIds, deletedUserIds);

    // Filter deleted reports and users from cloud before merging
    const cloudEodsFiltered  = (cloudRecord.eods||[]).filter(e=>!deletedEodIds.includes(e.id));
    const cloudUsersFiltered = (cloudRecord.users||[]).filter(u=>!deletedUserIds.includes(u.id));'''

NEW_CLOUD_PUSH_DEL_EODS = '''    // Merge deleted user IDs from cloud so all devices share the tombstone list
    const localDelUsers  = dbGet(DB_KEYS.deletedUserIds)||[];
    const cloudDelUsers  = cloudRecord.deletedUserIds||[];
    const deletedUserIds = [...new Set([...localDelUsers, ...cloudDelUsers])];
    dbSet(DB_KEYS.deletedUserIds, deletedUserIds);'''

if OLD_CLOUD_PUSH_DEL_EODS in html:
    html = html.replace(OLD_CLOUD_PUSH_DEL_EODS, NEW_CLOUD_PUSH_DEL_EODS, 1)
    print("✅ 12a. cloudPushAll: removed deletedEodIds block")
else:
    print("❌ 12a. cloudPushAll deletedEodIds block NOT found")

OLD_CLOUD_PUSH_PAYLOAD = '''    const payload = {
      users:        dbGet(DB_KEYS.users)||[],   // local is authoritative when pushing
      admins:       mergedAdmins,
      clients:      mergedClients,
      orgExcluded:  localStorage.getItem('wl_org_excluded_names') || cloudRecord.orgExcluded || '[]',
      eods:         _mergeCloudArr(cloudEodsFiltered, dbGet(DB_KEYS.eods)||[], 300),
      blockers:     _mergeBlockersArr(cloudRecord.blockers, dbGet(DB_KEYS.blockers)||[]),
      goals:        _mergeCloudArr(cloudRecord.goals,    dbGet(DB_KEYS.goals)||[]),
      feed:         _mergeCloudArr(cloudRecord.feed,     dbGet(DB_KEYS.feed)||[], 100),
      announcement: dbGet('wl_announcement') || cloudRecord.announcement || null,
      coc:          dbGet(DB_KEYS.coc) || cloudRecord.coc || null,
      settings:     dbGet(DB_KEYS.settings) || cloudRecord.settings || null,
      orgNodes:        dbGet(DB_KEYS.orgNodes) || cloudRecord.orgNodes || null,
      orgLinks:        dbGet(DB_KEYS.orgLinks) || cloudRecord.orgLinks || null,
      orgLayoutVersion: localStorage.getItem('wl_org_layout_ver') || cloudRecord.orgLayoutVersion || null,
      primaryAdminPw: localStorage.getItem('wl_primary_admin_pw') || cloudRecord.primaryAdminPw || null,
      otPolicy:     dbGet(DB_KEYS.otPolicy) || cloudRecord.otPolicy || null,
      deletedEodIds,
      deletedUserIds,
      messages:     _mergeCloudArr(cloudRecord.messages,     dbGet(DB_KEYS.messages)||[], 500),
      roadmapTasks: _mergeRoadmapArr(cloudRecord.roadmapTasks, dbGet(DB_KEYS.roadmapTasks)||[]),
    };'''

NEW_CLOUD_PUSH_PAYLOAD = '''    const payload = {
      users:        dbGet(DB_KEYS.users)||[],   // local is authoritative when pushing
      admins:       mergedAdmins,
      clients:      mergedClients,
      orgExcluded:  localStorage.getItem('wl_org_excluded_names') || cloudRecord.orgExcluded || '[]',
      projectActivities: _mergeCloudArr(cloudRecord.projectActivities, dbGet(DB_KEYS.projectActivities)||[], 500),
      goals:        _mergeCloudArr(cloudRecord.goals,    dbGet(DB_KEYS.goals)||[]),
      feed:         _mergeCloudArr(cloudRecord.feed,     dbGet(DB_KEYS.feed)||[], 100),
      announcement: dbGet('wl_announcement') || cloudRecord.announcement || null,
      coc:          dbGet(DB_KEYS.coc) || cloudRecord.coc || null,
      settings:     dbGet(DB_KEYS.settings) || cloudRecord.settings || null,
      orgNodes:        dbGet(DB_KEYS.orgNodes) || cloudRecord.orgNodes || null,
      orgLinks:        dbGet(DB_KEYS.orgLinks) || cloudRecord.orgLinks || null,
      orgLayoutVersion: localStorage.getItem('wl_org_layout_ver') || cloudRecord.orgLayoutVersion || null,
      primaryAdminPw: localStorage.getItem('wl_primary_admin_pw') || cloudRecord.primaryAdminPw || null,
      otPolicy:     dbGet(DB_KEYS.otPolicy) || cloudRecord.otPolicy || null,
      deletedUserIds,
      messages:     _mergeCloudArr(cloudRecord.messages,     dbGet(DB_KEYS.messages)||[], 500),
      roadmapTasks: _mergeRoadmapArr(cloudRecord.roadmapTasks, dbGet(DB_KEYS.roadmapTasks)||[]),
    };'''

if OLD_CLOUD_PUSH_PAYLOAD in html:
    html = html.replace(OLD_CLOUD_PUSH_PAYLOAD, NEW_CLOUD_PUSH_PAYLOAD, 1)
    print("✅ 12b. cloudPushAll payload updated: eods/blockers -> projectActivities")
else:
    print("❌ 12b. cloudPushAll payload NOT found")

# Remove the post-push dbSet for eods/blockers
OLD_CLOUD_PUSH_DBSET = '''    // Store merged data locally so admin sees merged state too
    dbSet(DB_KEYS.users, payload.users);
    dbSet(DB_KEYS.admins, payload.admins);
    dbSet(DB_KEYS.eods, payload.eods);
    dbSet(DB_KEYS.blockers, payload.blockers);
    dbSet(DB_KEYS.goals, payload.goals);
    dbSet(DB_KEYS.feed, payload.feed);'''

NEW_CLOUD_PUSH_DBSET = '''    // Store merged data locally so admin sees merged state too
    dbSet(DB_KEYS.users, payload.users);
    dbSet(DB_KEYS.admins, payload.admins);
    dbSet(DB_KEYS.projectActivities, payload.projectActivities);
    dbSet(DB_KEYS.goals, payload.goals);
    dbSet(DB_KEYS.feed, payload.feed);'''

if OLD_CLOUD_PUSH_DBSET in html:
    html = html.replace(OLD_CLOUD_PUSH_DBSET, NEW_CLOUD_PUSH_DBSET, 1)
    print("✅ 12c. cloudPushAll post-push dbSet updated")
else:
    print("❌ 12c. cloudPushAll post-push dbSet NOT found")

# ============================================================
# 13. Update cloudPullAll — replace eods/blockers with projectActivities
# ============================================================
OLD_CLOUD_PULL_DEL_EODS = '''    // Merge tombstone lists (deleted IDs) — union of cloud + local
    const pulledDelEods  = r.deletedEodIds||[];
    const pulledDelUsers = r.deletedUserIds||[];
    const mergedDelEods  = [...new Set([...(dbGet(DB_KEYS.deletedEodIds)||[]), ...pulledDelEods])];
    let   mergedDelUsers = [...new Set([...(dbGet(DB_KEYS.deletedUserIds)||[]), ...pulledDelUsers])];'''

NEW_CLOUD_PULL_DEL_EODS = '''    // Merge deleted user IDs tombstone list
    const pulledDelUsers = r.deletedUserIds||[];
    let   mergedDelUsers = [...new Set([...(dbGet(DB_KEYS.deletedUserIds)||[]), ...pulledDelUsers])];'''

if OLD_CLOUD_PULL_DEL_EODS in html:
    html = html.replace(OLD_CLOUD_PULL_DEL_EODS, NEW_CLOUD_PULL_DEL_EODS, 1)
    print("✅ 13a. cloudPullAll: removed deletedEodIds tombstone block")
else:
    print("❌ 13a. cloudPullAll deletedEodIds block NOT found")

OLD_CLOUD_PULL_DEL_EODS_SET = '''    dbSet(DB_KEYS.deletedEodIds,  mergedDelEods);
    dbSet(DB_KEYS.deletedUserIds, mergedDelUsers);'''
NEW_CLOUD_PULL_DEL_EODS_SET = '''    dbSet(DB_KEYS.deletedUserIds, mergedDelUsers);'''

if OLD_CLOUD_PULL_DEL_EODS_SET in html:
    html = html.replace(OLD_CLOUD_PULL_DEL_EODS_SET, NEW_CLOUD_PULL_DEL_EODS_SET, 1)
    print("✅ 13b. cloudPullAll: removed deletedEodIds dbSet")
else:
    print("❌ 13b. cloudPullAll deletedEodIds dbSet NOT found")

OLD_CLOUD_PULL_EODS = '''    // EODs: merge, but always filter out deleted report IDs
    if(r.eods){
      const filtered = r.eods.filter(e=>!mergedDelEods.includes(e.id));
      dbSet(DB_KEYS.eods, _mergeCloudArr(filtered, (dbGet(DB_KEYS.eods)||[]).filter(e=>!mergedDelEods.includes(e.id)), 300));
    }
    if(r.blockers)     dbSet(DB_KEYS.blockers, _mergeBlockersArr(r.blockers, dbGet(DB_KEYS.blockers)||[]));
    if(r.goals)        dbSet(DB_KEYS.goals,    _mergeCloudArr(r.goals,    dbGet(DB_KEYS.goals)||[]));'''

NEW_CLOUD_PULL_EODS = '''    // Project Activities: merge cloud + local
    if(r.projectActivities) dbSet(DB_KEYS.projectActivities, _mergeCloudArr(r.projectActivities, dbGet(DB_KEYS.projectActivities)||[], 500));
    if(r.goals)        dbSet(DB_KEYS.goals,    _mergeCloudArr(r.goals,    dbGet(DB_KEYS.goals)||[]));'''

if OLD_CLOUD_PULL_EODS in html:
    html = html.replace(OLD_CLOUD_PULL_EODS, NEW_CLOUD_PULL_EODS, 1)
    print("✅ 13c. cloudPullAll: eods/blockers replaced with projectActivities")
else:
    print("❌ 13c. cloudPullAll eods/blockers NOT found")

# ============================================================
# 14. Remove loadUserBlockersFromDB call on login
# ============================================================
OLD_LOGIN_BLOCKER = '''    showUserApp();
    setTimeout(loadUserBlockersFromDB, 200);
    return;'''
NEW_LOGIN_BLOCKER = '''    showUserApp();
    setTimeout(refreshUserProjectsTab, 200);
    return;'''
if OLD_LOGIN_BLOCKER in html:
    html = html.replace(OLD_LOGIN_BLOCKER, NEW_LOGIN_BLOCKER, 1)
    print("✅ 14. Login: loadUserBlockersFromDB -> refreshUserProjectsTab")
else:
    print("❌ 14. Login blocker load NOT found")

# ============================================================
# 15. Neutralize addBlocker DB override (replace with stub)
# ============================================================
OLD_ADD_BLOCKER_OVERRIDE = '''// Patch addBlocker to save to shared DB
const _origAddBlocker = window.addBlocker;
window.addBlocker = function(){
  const title = document.getElementById('blockerTitle')?.value;
  const desc  = document.getElementById('blockerDesc')?.value;
  const proj  = document.getElementById('blockerProject')?.value;
  const sev   = document.getElementById('blockerSeverity')?.value;
  if(!title){ showToast('Please enter a blocker title'); return; }
  const userName = _getCurrentUserName();
  const blocker = {
    id: Date.now(),
    title, desc, proj, sev,
    user: userName,
    date: new Date().toISOString(),
    status: 'open'
  };
  dbPush(DB_KEYS.blockers, blocker);
  logActivity('blocker', userName, 'Logged blocker: ' + title, sev);
  // call original, then tag the DOM element with the DB id so resolve can find it
  _origAddBlocker();
  const _items = document.querySelectorAll('#blockerList .blocker-item');
  if(_items.length) _items[_items.length-1].dataset.blockerId = blocker.id;
};'''

NEW_ADD_BLOCKER_STUB = '''// addBlocker feature removed in Phase 2
function addBlocker(){ showToast('Blocker reporting has been replaced by Project Updates'); }'''

if OLD_ADD_BLOCKER_OVERRIDE in html:
    html = html.replace(OLD_ADD_BLOCKER_OVERRIDE, NEW_ADD_BLOCKER_STUB, 1)
    print("✅ 15. addBlocker override neutralized")
else:
    print("❌ 15. addBlocker override NOT found")

# ============================================================
# 16. Neutralize EOD submit override (replace with stub)
# ============================================================
OLD_EOD_OVERRIDE_START = '''// ── EOD Submit override — save to shared DB ──
const _origEodStep = window.eodStep;
window.eodStep = function(dir){
  if(dir===1 && eodCurrentStep===3){
    // Submitting EOD — capture form data
    const userName = _getCurrentUserName();
    const userTitle = (currentAdminInfo?.title) || (currentUserData?.title) || document.getElementById('profileTitle')?.value || document.getElementById('pulseRoleDisplay')?.textContent || '';
    const tasks   = document.querySelector('#eod-step1 textarea')?.value || '';
    const projects= document.querySelector('#eod-step1 input[placeholder*="Client"]')?.value || '';
    const hours   = document.querySelector('#eod-step1 input[type="number"]')?.value || '';
    const wins    = document.querySelector('#eod-step2 textarea:first-of-type')?.value || '';
    const issues  = document.querySelector('#eod-step2 textarea:last-of-type')?.value || '';
    const tomorrow= document.querySelector('#eod-step3 textarea:first-of-type')?.value || '';
    const support = document.querySelector('#eod-step3 textarea:last-of-type')?.value || '';
    const rating  = document.querySelector('#eod-step3 select')?.value || '';
    const selDate = selectedCalDate ? new Date(calYear, calMonth, selectedCalDate).toISOString().slice(0,10) : new Date().toISOString().slice(0,10);
    const eodReport = {
      id: Date.now(),
      user: userName,
      title: userTitle,
      date: selDate,
      submittedAt: new Date().toISOString(),
      tasks, projects, hours, wins, issues, tomorrow, support, rating
    };
    dbPush(DB_KEYS.eods, eodReport);
    logActivity('eod', userName, 'Submitted EOD report for '+selDate, 'Rating: '+rating.substring(0,4));
  }
  _origEodStep(dir);
};'''

NEW_EOD_STUB = '''// EOD feature removed in Phase 2 — openEODModal redirects to My Projects
function openEODModal(){ showSection('myprojects', document.querySelector('.nav-item:nth-child(2)')); showToast('EOD reports replaced by Project Updates'); }'''

if OLD_EOD_OVERRIDE_START in html:
    html = html.replace(OLD_EOD_OVERRIDE_START, NEW_EOD_STUB, 1)
    print("✅ 16. EOD submit override neutralized")
else:
    print("❌ 16. EOD submit override NOT found")

# ============================================================
# 17. Replace refreshAdminOverview function with new one
# ============================================================
# Find the full function
rao_start = html.find('function refreshAdminOverview(){')
rao_end_marker = '\n// Auto-refresh overview when tab opens'
rao_end = html.find(rao_end_marker, rao_start)

if rao_start != -1 and rao_end != -1:
    old_rao = html[rao_start:rao_end]
    
    NEW_REFRESH_ADMIN_OVERVIEW = '''function refreshAdminOverview(){
  const now = new Date();
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const dateLabel = document.getElementById('overviewDateLabel');
  if(dateLabel) dateLabel.textContent = dayNames[now.getDay()]+', '+monthNames[now.getMonth()]+' '+now.getDate()+', '+now.getFullYear();

  const allUsers = dbGet(DB_KEYS.users)||[];
  const activities = dbGet(DB_KEYS.projectActivities)||[];

  // Week boundaries (Mon – Sun)
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay() + (now.getDay()===0?-6:1));
  startOfWeek.setHours(0,0,0,0);
  const endOfWeek = new Date(startOfWeek); endOfWeek.setDate(startOfWeek.getDate()+6); endOfWeek.setHours(23,59,59,999);
  const sowStr = startOfWeek.toISOString().slice(0,10);
  const eowStr = endOfWeek.toISOString().slice(0,10);
  const todayStr = now.toISOString().slice(0,10);

  const weekActivities = activities.filter(a=>a.date>=sowStr && a.date<=eowStr);
  const todayActivities = activities.filter(a=>a.date===todayStr);
  const activeThisWeek = new Set(weekActivities.map(a=>a.user)).size;

  // Update stat cards
  const el1=document.getElementById('ov-total-users'); if(el1) el1.textContent=allUsers.length||0;
  const el2=document.getElementById('ov-updates-today'); if(el2) el2.textContent=todayActivities.length||0;
  const el3=document.getElementById('ov-updates-week'); if(el3) el3.textContent=weekActivities.length||0;
  const el4=document.getElementById('ov-active-contributors'); if(el4) el4.textContent=activeThisWeek||0;

  const weekLabel=document.getElementById('ov-week-label');
  if(weekLabel){
    const opts={month:'short',day:'numeric'};
    weekLabel.textContent='Week of '+startOfWeek.toLocaleDateString('en-US',opts)+' – '+endOfWeek.toLocaleDateString('en-US',opts);
  }

  // Activity feed (sorted newest first, max 50)
  const feedEl = document.getElementById('ov-activity-feed');
  if(feedEl){
    const userF = document.getElementById('ov-filter-user')?.value||'';
    const typeF = document.getElementById('ov-filter-type')?.value||'';
    // Populate user dropdown
    const allActUsers = [...new Set(activities.map(a=>a.user))].sort();
    const ufSel = document.getElementById('ov-filter-user');
    if(ufSel){
      const cur = ufSel.value;
      ufSel.innerHTML = '<option value="">All Users</option>' + allActUsers.map(u=>`<option value="${u}" ${u===cur?'selected':''}>${u}</option>`).join('');
    }

    const filtered = activities
      .filter(a=>(!userF||a.user===userF)&&(!typeF||a.type===typeF))
      .sort((a,b)=>new Date(b.timestamp||b.date)-new Date(a.timestamp||a.date))
      .slice(0,50);

    if(!filtered.length){
      feedEl.innerHTML='<div style="font-size:13px;color:var(--text-light);padding:24px;text-align:center;">No project activity yet. Updates appear here as team members log progress.</div>';
    } else {
      const typeConfig = {
        progress:   {icon:'📈', color:'var(--green)',   bg:'rgba(46,158,110,.1)',  label:'Progress'},
        update:     {icon:'💬', color:'var(--accent)',  bg:'rgba(45,107,182,.1)', label:'Update'},
        addition:   {icon:'➕', color:'#7c3aed',        bg:'rgba(124,58,237,.1)', label:'Addition'},
        edit:       {icon:'✏️', color:'var(--orange)',  bg:'rgba(217,119,6,.1)',  label:'Edit'},
        deletion:   {icon:'🗑️', color:'var(--red)',     bg:'rgba(220,53,69,.1)',  label:'Deletion'},
        completion: {icon:'✅', color:'var(--green)',   bg:'rgba(46,158,110,.1)', label:'Completed'},
        issue:      {icon:'⚠️', color:'var(--orange)',  bg:'rgba(217,119,6,.1)',  label:'Issue'},
      };
      feedEl.innerHTML = filtered.map(a=>{
        const cfg = typeConfig[a.type] || {icon:'📌', color:'var(--text-mid)', bg:'var(--bg2)', label:a.type};
        const ts = a.timestamp ? new Date(a.timestamp) : new Date(a.date);
        const timeStr = ts.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) + ' · ' + a.date;
        const initials = (a.user||'?').split(' ').map(w=>w[0]||'').join('').substring(0,2).toUpperCase();
        return `<div style="display:flex;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border);align-items:flex-start;">
          <div class="avatar" style="width:28px;height:28px;font-size:10px;flex-shrink:0;">${initials}</div>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:3px;">
              <span style="font-size:12px;font-weight:700;color:var(--text-dark);">${a.user||'Unknown'}</span>
              <span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;background:${cfg.bg};color:${cfg.color};">${cfg.icon} ${cfg.label.toUpperCase()}</span>
              <span style="font-size:10px;color:var(--text-light);background:var(--bg2);padding:2px 7px;border-radius:10px;">📁 ${a.project||'General'}</span>
            </div>
            <div style="font-size:13px;color:var(--text-dark);margin-bottom:2px;">${a.description||''}</div>
            ${a.details?`<div style="font-size:11px;color:var(--text-light);">${a.details}</div>`:''}
            <div style="font-size:10px;color:var(--text-light);margin-top:3px;">${timeStr}</div>
          </div>
        </div>`;
      }).join('');
    }
  }

  // Per-user status list
  const statusList = document.getElementById('ov-user-status-list');
  if(statusList){
    if(!allUsers.length){
      statusList.innerHTML='<div style="font-size:13px;color:var(--text-light);padding:12px 0;">No team members found.</div>';
    } else {
      const byUser = {};
      weekActivities.forEach(a=>{ if(!byUser[a.user]) byUser[a.user]=[]; byUser[a.user].push(a); });
      const rows = allUsers.map(u=>{
        const userActs = byUser[u.name]||[];
        const count = userActs.length;
        const lastAct = userActs.sort((a,b)=>new Date(b.timestamp||b.date)-new Date(a.timestamp||a.date))[0];
        const statusBadge = count>0
          ? `<span class="cred-status cred-set">${count} update${count!==1?'s':''}</span>`
          : `<span class="cred-status cred-notset">No updates</span>`;
        const subLine = lastAct
          ? `Last: ${lastAct.type} on ${lastAct.project||'General'} · ${lastAct.date}`
          : 'No updates this week';
        const initials = (u.name||'?').split(' ').map(w=>w[0]||'').join('').substring(0,2).toUpperCase();
        const latestProjects = [...new Set(userActs.map(a=>a.project).filter(Boolean))].slice(0,2).join(', ');
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">
          <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;">
            <div class="avatar" style="width:28px;height:28px;font-size:10px;flex-shrink:0;">${initials}</div>
            <div style="min-width:0;">
              <div style="font-size:12px;font-weight:700;color:var(--text-dark);">${u.name}</div>
              <div style="font-size:11px;color:var(--text-light);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${latestProjects||subLine}</div>
            </div>
          </div>
          ${statusBadge}
        </div>`;
      });
      statusList.innerHTML = rows.join('');
    }
  }
}

function filterOverviewFeed(){ refreshAdminOverview(); }'''

    html = html[:rao_start] + NEW_REFRESH_ADMIN_OVERVIEW + html[rao_end:]
    print("✅ 17. refreshAdminOverview fully replaced with project activity version")
else:
    print(f"❌ 17. Could not find refreshAdminOverview function (start={rao_start}, end={rao_end})")

# ============================================================
# 18. Add submitProjectActivity and related JS functions
#     (inject before the LIVE FEED FUNCTIONS block)
# ============================================================
INJECT_AFTER = '''// ── LIVE FEED FUNCTIONS ──'''

NEW_PROJECT_ACTIVITY_FUNCS = '''// ══════════════════════════════════════════════
// PROJECT ACTIVITY — User-facing log functions
// ══════════════════════════════════════════════

function submitProjectActivity(){
  const projectName   = document.getElementById('projActProjectName')?.value?.trim();
  const actType       = document.getElementById('projActType')?.value;
  const description   = document.getElementById('projActDescription')?.value?.trim();
  const details       = document.getElementById('projActDetails')?.value?.trim();

  if(!projectName){ showToast('Please enter a project name'); return; }
  if(!actType){ showToast('Please select an activity type'); return; }
  if(!description){ showToast('Please enter a description'); return; }

  const activity = logProjectActivity(actType, description, projectName, details);

  showToast('✅ Update logged — admin notified');
  clearProjectActivityForm();
  refreshUserProjectsTab();
  cloudAutoSync();
}

function clearProjectActivityForm(){
  ['projActProjectName','projActDescription','projActDetails'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.value = '';
  });
  const sel = document.getElementById('projActType');
  if(sel) sel.value = '';
}

function refreshUserProjectsTab(){
  const userName = _getCurrentUserName ? _getCurrentUserName() : '';
  if(!userName) return;

  // Update operations section quick stats
  const allActs = dbGet(DB_KEYS.projectActivities)||[];
  const today = new Date().toISOString().slice(0,10);
  const startOfWeek = new Date(); startOfWeek.setDate(new Date().getDate()-new Date().getDay()+(new Date().getDay()===0?-6:1)); startOfWeek.setHours(0,0,0,0);
  const sowStr = startOfWeek.toISOString().slice(0,10);
  const myActs = allActs.filter(a=>a.user===userName);
  const myWeekActs = myActs.filter(a=>a.date>=sowStr);
  const myProjects = [...new Set(myActs.map(a=>a.project).filter(Boolean))];

  const weekEl = document.getElementById('ops-week-updates');
  if(weekEl) weekEl.textContent = myWeekActs.length;
  const projEl = document.getElementById('ops-active-projects');
  if(projEl) projEl.textContent = myProjects.length||'—';

  const myTodayActs = myActs.filter(a=>a.date===today);
  const countEl = document.getElementById('ops-activity-count');
  if(countEl) countEl.textContent = myTodayActs.length+' update'+(myTodayActs.length!==1?'s':'');
  const recentEl = document.getElementById('ops-recent-activity');
  if(recentEl){
    if(!myTodayActs.length){
      recentEl.innerHTML='<span style="color:var(--text-light);">No updates logged today</span>';
    } else {
      const typeIcons = {progress:'📈',update:'💬',addition:'➕',edit:'✏️',deletion:'🗑️',completion:'✅',issue:'⚠️'};
      recentEl.innerHTML = myTodayActs.slice(-3).reverse().map(a=>
        `<div style="padding:4px 0;font-size:12px;color:var(--text-dark);">${typeIcons[a.type]||'📌'} <strong>${a.project}</strong> — ${a.description.substring(0,60)}${a.description.length>60?'…':''}</div>`
      ).join('');
    }
  }

  // Refresh my recent activity list in My Projects tab
  const listEl = document.getElementById('myProjectActivityList');
  if(listEl){
    const mine = myActs.sort((a,b)=>new Date(b.timestamp||b.date)-new Date(a.timestamp||a.date)).slice(0,20);
    if(!mine.length){
      listEl.innerHTML='<div style="font-size:13px;color:var(--text-light);padding:12px 0;">No activity logged yet. Submit your first update above.</div>';
    } else {
      const typeConfig = {
        progress:   {icon:'📈', color:'var(--green)',  label:'Progress'},
        update:     {icon:'💬', color:'var(--accent)', label:'Update'},
        addition:   {icon:'➕', color:'#7c3aed',       label:'Addition'},
        edit:       {icon:'✏️', color:'var(--orange)', label:'Edit'},
        deletion:   {icon:'🗑️', color:'var(--red)',    label:'Deletion'},
        completion: {icon:'✅', color:'var(--green)',  label:'Completed'},
        issue:      {icon:'⚠️', color:'var(--orange)', label:'Issue'},
      };
      listEl.innerHTML = mine.map(a=>{
        const cfg = typeConfig[a.type]||{icon:'📌',color:'var(--text-mid)',label:a.type};
        const ts = a.timestamp ? new Date(a.timestamp) : new Date(a.date);
        const timeStr = ts.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' at ' + ts.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
        return `<div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);align-items:flex-start;">
          <div style="font-size:18px;flex-shrink:0;margin-top:1px;">${cfg.icon}</div>
          <div style="flex:1;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:3px;">
              <span style="font-size:12px;font-weight:700;color:${cfg.color};">${cfg.label.toUpperCase()}</span>
              <span style="font-size:11px;color:var(--text-light);background:var(--bg2);padding:2px 7px;border-radius:10px;">📁 ${a.project||'General'}</span>
            </div>
            <div style="font-size:13px;color:var(--text-dark);">${a.description}</div>
            ${a.details?`<div style="font-size:11px;color:var(--text-light);margin-top:2px;">${a.details}</div>`:''}
            <div style="font-size:11px;color:var(--text-light);margin-top:3px;">${timeStr}</div>
          </div>
        </div>`;
      }).join('');
    }
  }
}

// ── LIVE FEED FUNCTIONS ──'''

if INJECT_AFTER in html:
    html = html.replace(INJECT_AFTER, NEW_PROJECT_ACTIVITY_FUNCS, 1)
    print("✅ 18. submitProjectActivity and related functions injected")
else:
    print("❌ 18. LIVE FEED FUNCTIONS marker NOT found")

# ============================================================
# 19. Update updateFeedStats to use projectActivities not eods/blockers
# ============================================================
OLD_FEED_STATS_FN = '''function updateFeedStats(events){
  const todayStr = new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  document.getElementById('feed-stat-total').textContent = events.length;
  document.getElementById('feed-stat-eod').textContent = events.filter(e=>e.type==='eod' && e.date===todayStr).length;
  document.getElementById('feed-stat-blockers').textContent = events.filter(e=>e.type==='blocker').length;
  document.getElementById('feed-stat-logins').textContent = events.filter(e=>e.type==='login' && e.date===todayStr).length;
  const activeUsers = [...new Set(events.filter(e=>e.date===todayStr).map(e=>e.user))].length;
  document.getElementById('feed-stat-active').textContent = activeUsers;
}'''
NEW_FEED_STATS_FN = '''function updateFeedStats(events){
  const todayStr = new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  const todayIso = new Date().toISOString().slice(0,10);
  document.getElementById('feed-stat-total').textContent = events.length;
  // "Updates Today" = project activity events today
  const projActs = dbGet(DB_KEYS.projectActivities)||[];
  document.getElementById('feed-stat-eod').textContent = projActs.filter(a=>a.date===todayIso).length;
  // "Projects Active" = distinct projects with activity
  const activeProjects = new Set(projActs.map(a=>a.project).filter(Boolean)).size;
  document.getElementById('feed-stat-blockers').textContent = activeProjects;
  document.getElementById('feed-stat-logins').textContent = events.filter(e=>e.type==='login' && e.date===todayStr).length;
  const activeUsers = [...new Set(events.filter(e=>e.date===todayStr).map(e=>e.user))].length;
  document.getElementById('feed-stat-active').textContent = activeUsers;
}'''
if OLD_FEED_STATS_FN in html:
    html = html.replace(OLD_FEED_STATS_FN, NEW_FEED_STATS_FN, 1)
    print("✅ 19. updateFeedStats updated")
else:
    print("❌ 19. updateFeedStats NOT found")

# ============================================================
# 20. Remove the old EOD/blocker icon/style entries from renderFeedList
# ============================================================
OLD_FEED_ICONS = '''  const icons = {eod:'📋',blocker:'🚧',login:'🔑',nav:'🧭',goal:'🎯',report:'📊',client:'🏢'};
  const iconClass = {eod:'feed-icon-eod',blocker:'feed-icon-blocker',login:'feed-icon-login',nav:'feed-icon-nav',goal:'feed-icon-goal',report:'feed-icon-eod',client:'feed-icon-eod'};
  const badgeStyle = {eod:'background:#e8f8f0;color:var(--green)',blocker:'background:#fff8e8;color:var(--orange)',login:'background:rgba(45,107,182,.1);color:var(--text)',nav:'background:var(--bg2);color:var(--text-mid)',goal:'background:#fdf4ff;color:#9333ea',report:'background:rgba(45,107,182,.1);color:var(--text)',client:'background:rgba(45,107,182,.1);color:var(--text)'};'''
NEW_FEED_ICONS = '''  const icons = {project:'📝',login:'🔑',nav:'🧭',goal:'🎯',client:'🏢',eod:'📝',blocker:'📝'};
  const iconClass = {project:'feed-icon-eod',login:'feed-icon-login',nav:'feed-icon-nav',goal:'feed-icon-goal',eod:'feed-icon-eod',blocker:'feed-icon-eod'};
  const badgeStyle = {project:'background:#e8f8f0;color:var(--green)',login:'background:rgba(45,107,182,.1);color:var(--text)',nav:'background:var(--bg2);color:var(--text-mid)',goal:'background:#fdf4ff;color:#9333ea',eod:'background:#e8f8f0;color:var(--green)',blocker:'background:#fff8e8;color:var(--orange)'};'''
if OLD_FEED_ICONS in html:
    html = html.replace(OLD_FEED_ICONS, NEW_FEED_ICONS, 1)
    print("✅ 20. renderFeedList icons/styles updated")
else:
    print("❌ 20. renderFeedList icons NOT found")

# ============================================================
# 21. Remove loadAdminReportsTab + filterAdminReports etc from switchAdminTab
# ============================================================
OLD_SWITCH_ADMIN_REPORTS = '''  if(tab==='reports'){
    // Pull latest from cloud first so we see reports from all team members
    if(cloudIsConfigured()){
      cloudPullAll(true).then(()=>loadAdminReportsTab());
    } else {
      setTimeout(loadAdminReportsTab, 100);
    }
  }
  if(tab==='users') setTimeout(updateCloudStatusUI, 100);'''
NEW_SWITCH_ADMIN_REPORTS = '''  if(tab==='users') setTimeout(updateCloudStatusUI, 100);'''
if OLD_SWITCH_ADMIN_REPORTS in html:
    html = html.replace(OLD_SWITCH_ADMIN_REPORTS, NEW_SWITCH_ADMIN_REPORTS, 1)
    print("✅ 21. switchAdminTab: removed reports tab handling")
else:
    print("❌ 21. switchAdminTab reports block NOT found")

# Also remove the cloudPullAll reports refresh from cloudPullAll
OLD_REPORTS_TAB_REFRESH = '''    // Reload reports tab if currently visible
    const reportsTab = document.getElementById('tab-allreports');
    if(reportsTab && reportsTab.classList.contains('active') && typeof loadAdminReportsTab === 'function') loadAdminReportsTab();'''
NEW_REPORTS_TAB_REFRESH = '''    // Refresh overview if visible
    if(typeof refreshAdminOverview === 'function') refreshAdminOverview();'''
if OLD_REPORTS_TAB_REFRESH in html:
    html = html.replace(OLD_REPORTS_TAB_REFRESH, NEW_REPORTS_TAB_REFRESH, 1)
    print("✅ 21b. cloudPullAll: removed reports tab refresh")
else:
    print("❌ 21b. cloudPullAll reports tab refresh NOT found")

# Remove duplicate refreshAdminOverview call if present
OLD_DOUBLE_REFRESH = '''    if(typeof refreshAdminOverview === 'function') refreshAdminOverview();
    if(typeof refreshLiveFeed === 'function') refreshLiveFeed();'''
NEW_DOUBLE_REFRESH = '''    if(typeof refreshLiveFeed === 'function') refreshLiveFeed();'''
if OLD_DOUBLE_REFRESH in html:
    # Only keep first occurrence cleanup if it's the duplicate
    pass  # Will be handled by the next step

# ============================================================
# 22. Also update the cloudPullAll duplicate refreshAdminOverview call
# ============================================================
# The cloudPullAll already has one in the refactored reports section; 
# keep the existing one at line 6685 but remove the one added by step 21b if it creates a dup
# Let's check the current state
rao_count = html.count("if(typeof refreshAdminOverview === 'function') refreshAdminOverview();")
print(f"ℹ️  refreshAdminOverview call count: {rao_count}")

# ============================================================
# 23. Update deletedEodIds reference that might remain in cloudPullAll CRITICAL comment
# ============================================================
OLD_CRITICAL_COMMENT = '''    // ── CRITICAL: if the cloud explicitly lists a user as ACTIVE (present in r.users,
    // not archived), the admin has intentionally restored them on another device.
    // Remove their ID from the local tombstone so the restore is honoured here too.
    if(Array.isArray(r.users) && r.users.length > 0){
      const cloudActiveIds = new Set(
        r.users.filter(u=>u.id && !u.archived && (u.status==='active'||!u.status)).map(u=>u.id)
      );
      mergedDelUsers = mergedDelUsers.filter(id => !cloudActiveIds.has(id));
    }

    dbSet(DB_KEYS.deletedEodIds,  mergedDelEods);
    dbSet(DB_KEYS.deletedUserIds, mergedDelUsers);'''
# Note: deletedEodIds dbSet was already handled in step 13b, so this may already be clean
# Check if the old critical comment with mergedDelEods still exists
if 'mergedDelEods' in html:
    # Remove the dbSet(DB_KEYS.deletedEodIds line if it still appears
    html = re.sub(r'    dbSet\(DB_KEYS\.deletedEodIds,\s*mergedDelEods\);\n', '', html)
    print("✅ 22. Cleaned up remaining deletedEodIds dbSet line")
else:
    print("ℹ️  22. No remaining mergedDelEods references found (already clean)")

# ============================================================
# 24. Clean up any remaining deletedEodIds variable references
# ============================================================
if 'mergedDelEods' in html:
    print(f"⚠️  Still has mergedDelEods refs - count: {html.count('mergedDelEods')}")
if 'pulledDelEods' in html:
    print(f"⚠️  Still has pulledDelEods refs - count: {html.count('pulledDelEods')}")

# Save file
with open('/home/user/webapp/index.html', 'w', encoding='utf-8') as f:
    f.write(html)

print(f"\n✅ File saved: {len(html)} chars")
print("Phase 2 refactor script complete.")
