#!/usr/bin/env python3
"""
Integrate main branch's proxy-based cloud sync into our Phase 2 index.html.
The main branch switched from direct JSONBin API calls to a server-side proxy
at /api/jsonbin-proxy with passphrase auth (x-bin-key header).

We keep all our Phase 2 changes (projectActivities, new overview, etc.)
but adopt main's cloud sync transport layer.
"""

with open('/home/user/webapp/index.html', 'r', encoding='utf-8') as f:
    html = f.read()

print(f"File loaded: {len(html)} chars")

# ============================================================
# 1. Replace CLOUD SYNC ENGINE section entirely
#    Our current version still has direct JSONBin calls.
#    Replace with main's proxy approach + our projectActivities additions.
# ============================================================

OLD_CLOUD_SECTION_START = '''// ═══════════════════════════════════════════════════════════
// ☁️  CLOUD SYNC ENGINE  —  JSONBin.io
// ═══════════════════════════════════════════════════════════
const CLOUD_CFG_KEY = 'wl_cloud_config';
// No hardcoded defaults — config must always be entered and saved via the UI.

function getCloudConfig(){
  const saved = dbGet(CLOUD_CFG_KEY) || {};
  return { apiKey: saved.apiKey || '', binId: saved.binId || '' };
}
function cloudIsConfigured(){
  const c = getCloudConfig();
  return !!(c.apiKey && c.binId);
}'''

# Find where this starts and where the cloud section ends (just before backward-compat aliases)
cloud_start = html.find('// ═══════════════════════════════════════════════════════════\n// ☁️  CLOUD SYNC ENGINE')
# Find end: after "cloudAutoSync" and "startLiveSync" functions
# Find "// Auto-refresh overview when tab opens"
cloud_end_marker = '\n// Auto-refresh overview when tab opens'
cloud_end = html.find(cloud_end_marker, cloud_start)

if cloud_start == -1:
    print("❌ Cloud section start not found")
    exit(1)
if cloud_end == -1:
    print("❌ Cloud section end not found")
    exit(1)

print(f"Cloud section: lines ~{html[:cloud_start].count(chr(10))+1} to ~{html[:cloud_end].count(chr(10))+1}")

NEW_CLOUD_SECTION = '''// ═══════════════════════════════════════════════════════════
// ☁️  CLOUD SYNC ENGINE  —  Server-side proxy → JSONBin.io
// ═══════════════════════════════════════════════════════════
const CLOUD_CFG_KEY = 'wl_cloud_config';
const _DEFAULT_BIN    = '_data';
const _DEFAULT_API_KEY = 'wlm-sync';

function getCloudConfig(){
  const saved = dbGet(CLOUD_CFG_KEY) || {};
  return { apiKey: saved.apiKey || _DEFAULT_API_KEY, binId: saved.binId || _DEFAULT_BIN };
}
function cloudIsConfigured(){
  const c = getCloudConfig();
  return !!(c.apiKey && c.binId);
}

function saveCloudConfig(){
  const apiKey = document.getElementById('cloudApiKey')?.value.trim();
  const binId  = document.getElementById('cloudBinId')?.value.trim();
  if(!apiKey || !binId){ showToast('Please enter both the API Key and Bin ID'); return; }
  dbSet(CLOUD_CFG_KEY, {apiKey, binId});
  document.getElementById('cloudConfigPanel').style.display='none';
  document.getElementById('cloudConfigToggleBtn').textContent='⚙ Configure';
  updateCloudStatusUI();
  showToast('Cloud config saved — pulling latest users…');
  cloudPullUsers();
}

function toggleCloudConfig(){
  const panel = document.getElementById('cloudConfigPanel');
  const btn   = document.getElementById('cloudConfigToggleBtn');
  const cfg   = getCloudConfig();
  const open  = panel.style.display === 'none';
  panel.style.display = open ? 'block' : 'none';
  btn.textContent = open ? '✕ Close' : '⚙ Configure';
  if(open){
    if(cfg.apiKey) document.getElementById('cloudApiKey').value = cfg.apiKey;
    if(cfg.binId)  document.getElementById('cloudBinId').value  = cfg.binId;
  }
}

function setCloudStatus(msg, type='idle'){
  const el = document.getElementById('cloudSyncStatus');
  if(!el) return;
  const icons = {idle:'☁️', syncing:'🔄', ok:'✅', error:'❌'};
  el.innerHTML = (icons[type]||'') + ' ' + msg;
  el.style.color = type==='error' ? 'var(--red)' : type==='ok' ? 'var(--green,#2e9e6e)' : 'var(--text-light)';
}

function updateCloudStatusUI(){
  const cfg = getCloudConfig();
  const lastSync = localStorage.getItem('wl_cloud_last_sync');
  const wcdEl = document.getElementById('workspaceCodeDisplay');
  const wcvEl = document.getElementById('workspaceCodeVal');
  if(!cfg.apiKey || !cfg.binId){
    setCloudStatus('Not configured — click ⚙ Configure to set up cross-device login.','idle');
    if(wcdEl) wcdEl.style.display='none';
  } else if(lastSync){
    const d = new Date(lastSync);
    setCloudStatus(`✅ Last synced: ${d.toLocaleString()}`, 'ok');
    if(wcdEl) wcdEl.style.display='block';
    if(wcvEl) wcvEl.textContent=cfg.binId;
  } else {
    setCloudStatus(`☁️ Configured — click "↑ Push to Cloud" to sync your users now.`, 'idle');
    if(wcdEl) wcdEl.style.display='block';
    if(wcvEl) wcvEl.textContent=cfg.binId;
  }
}

// Merge two arrays by id, deduplicating and keeping newest, limited to `limit` items
function _mergeCloudArr(cloudArr, localArr, limit=200){
  const combined = [...(Array.isArray(cloudArr)?cloudArr:[]), ...(Array.isArray(localArr)?localArr:[])];
  const seen = new Set();
  return combined.filter(x=>{ const k=x.id!=null?String(x.id):JSON.stringify(x); if(seen.has(k))return false; seen.add(k); return true; })
                 .sort((a,b)=>(b.id||0)-(a.id||0)).slice(0,limit);
}

// Merge blockers with "resolved wins" — once any side marks a blocker resolved, it stays resolved
function _mergeBlockers(primaryArr, secondaryArr){
  const merged = _mergeCloudArr(primaryArr, secondaryArr);
  const all = [...(Array.isArray(primaryArr)?primaryArr:[]), ...(Array.isArray(secondaryArr)?secondaryArr:[])];
  const resolvedMap = {};
  all.forEach(b=>{ if(b.status==='resolved') resolvedMap[String(b.id)]=b; });
  merged.forEach(b=>{
    const rv = resolvedMap[String(b.id)];
    if(rv){ b.status='resolved'; b.resolvedAt=b.resolvedAt||rv.resolvedAt; b.resolvedNote=b.resolvedNote||rv.resolvedNote; }
  });
  return merged;
}

// Append-only resolved-blocker IDs — once in this list the blocker stays resolved across all devices
const _RES_IDS_KEY = 'wl_resolved_blocker_ids';
function _getResolvedIds(){ try{ return JSON.parse(localStorage.getItem(_RES_IDS_KEY)||'[]'); }catch{ return []; } }
function _unionResolvedIds(cloudIds){
  const merged = [...new Set([..._getResolvedIds(), ...(Array.isArray(cloudIds)?cloudIds:[])])];
  localStorage.setItem(_RES_IDS_KEY, JSON.stringify(merged));
  return merged;
}

// Merge roadmap tasks by updated_at so the most recently changed version wins
function _mergeRoadmapArr(cloudArr, localArr, limit=1000){
  const map = new Map();
  (Array.isArray(cloudArr)?cloudArr:[]).forEach(t=>{ if(t?.id!=null) map.set(String(t.id), t); });
  (Array.isArray(localArr)?localArr:[]).forEach(t=>{
    if(t?.id==null){ return; }
    const key = String(t.id);
    const existing = map.get(key);
    if(!existing){ map.set(key,t); return; }
    const lt = new Date(t.updated_at||t.created_at||0).getTime();
    const ct = new Date(existing.updated_at||existing.created_at||0).getTime();
    if(lt >= ct) map.set(key, t);
  });
  return [...map.values()].slice(0, limit);
}

// Push ALL data to cloud (read-modify-write via server-side proxy)
async function cloudPushAll(silent=false){
  const cfg = getCloudConfig();
  if(!cfg.apiKey || !cfg.binId){
    if(!silent) showToast('Cloud not configured — click ⚙ Configure first');
    return false;
  }
  setCloudStatus('Syncing to cloud…','syncing');
  try {
    // Pull latest first so we don't overwrite data from other team members
    let cloudRecord = {};
    try {
      const r0 = await fetch(`/api/jsonbin-proxy?binId=${cfg.binId}`, {headers:{'x-bin-key':cfg.apiKey}});
      if(r0.ok){ const d=await r0.json(); cloudRecord=d?.record||{}; }
    } catch(e){}

    // Merge deleted user IDs from cloud so all devices share the tombstone list
    const localDelUsers  = dbGet(DB_KEYS.deletedUserIds)||[];
    const cloudDelUsers  = cloudRecord.deletedUserIds||[];
    const deletedUserIds = [...new Set([...localDelUsers, ...cloudDelUsers])];
    dbSet(DB_KEYS.deletedUserIds, deletedUserIds);

    // Merge admins: union of cloud + local by email so neither side can wipe the other
    const localAdmins = dbGet(DB_KEYS.admins)||[];
    const cloudAdmins = cloudRecord.admins||[];
    const mergedAdmins = [...cloudAdmins];
    localAdmins.forEach(la=>{
      const idx = mergedAdmins.findIndex(ca=>ca.email===la.email);
      if(idx>-1) mergedAdmins[idx]=la; // local wins for updates
      else mergedAdmins.push(la);       // new local admin added to cloud
    });

    // Merge client DBs: local wins by id, cloud fills in any clients only it has
    const localClients = _getClientDB();
    const cloudClients = Array.isArray(cloudRecord.clients) ? cloudRecord.clients : [];
    const clientById = {};
    cloudClients.forEach(c=>{ if(c.id) clientById[c.id]=c; });
    localClients.forEach(c=>{ if(c.id) clientById[c.id]=c; }); // local overwrites cloud
    const mergedClients = Object.values(clientById);

    const payload = {
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
    };

    const res = await fetch(`/api/jsonbin-proxy?binId=${cfg.binId}`, {
      method: 'PUT',
      headers: {'Content-Type':'application/json','x-bin-key':cfg.apiKey},
      body: JSON.stringify(payload)
    });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);

    // Store merged data locally so admin sees merged state too
    dbSet(DB_KEYS.users, payload.users);
    dbSet(DB_KEYS.admins, payload.admins);
    dbSet(DB_KEYS.projectActivities, payload.projectActivities);
    dbSet(DB_KEYS.goals, payload.goals);
    dbSet(DB_KEYS.feed, payload.feed);

    const now = new Date().toISOString();
    localStorage.setItem('wl_cloud_last_sync', now);
    updateCloudStatusUI();
    if(!silent) showToast('✅ All data synced to cloud');
    return true;
  } catch(e){
    setCloudStatus('Sync failed: '+e.message,'error');
    if(!silent) showToast('❌ Cloud sync failed — check connection');
    return false;
  }
}

// Pull ALL data from cloud and merge into localStorage
async function cloudPullAll(silent=false, fromLiveSync=false){
  const cfg = getCloudConfig();
  if(!cfg.apiKey || !cfg.binId){
    if(!silent) showToast('Cloud not configured — click ⚙ Configure first');
    return;
  }
  setCloudStatus('Pulling from cloud…','syncing');
  try {
    const res = await fetch(`/api/jsonbin-proxy?binId=${cfg.binId}`, {headers:{'x-bin-key':cfg.apiKey}});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const r = data?.record || {};

    // Merge deleted user IDs tombstone list
    const pulledDelUsers = r.deletedUserIds||[];
    let   mergedDelUsers = [...new Set([...(dbGet(DB_KEYS.deletedUserIds)||[]), ...pulledDelUsers])];

    // ── CRITICAL: if the cloud explicitly lists a user as ACTIVE, honour that restore.
    if(Array.isArray(r.users) && r.users.length > 0){
      const cloudActiveIds = new Set(
        r.users.filter(u=>u.id && !u.archived && (u.status==='active'||!u.status)).map(u=>u.id)
      );
      mergedDelUsers = mergedDelUsers.filter(id => !cloudActiveIds.has(id));
    }

    dbSet(DB_KEYS.deletedUserIds, mergedDelUsers);

    // Users: merge cloud + local — cloud wins on conflicts but NEVER wipes local if empty.
    if(Array.isArray(r.users) && r.users.length > 0){
      const localUsers = dbGet(DB_KEYS.users) || [];
      const cloudById  = {};
      r.users.forEach(u=>{ if(u.id) cloudById[u.id]=u; });
      const mergedUsers = r.users
        .filter(u=>!mergedDelUsers.includes(u.id))
        .map(u=>{
          const cloudActive = !u.archived && (u.status === 'active' || !u.status);
          if(cloudActive){
            return Object.assign({}, u, { archived: false, archivedAt: null });
          }
          return u;
        });
      localUsers.forEach(lu=>{
        if(!mergedDelUsers.includes(lu.id) && !cloudById[lu.id]) mergedUsers.push(lu);
      });
      dbSet(DB_KEYS.users, mergedUsers);
    }
    // Admins: safe-merge — never overwrite local admins with empty cloud array.
    if(Array.isArray(r.admins) && r.admins.length > 0){
      const localAdmins   = dbGet(DB_KEYS.admins) || [];
      const cloudAByEmail = {};
      r.admins.forEach(a=>{ if(a.email) cloudAByEmail[a.email.toLowerCase()]=a; });
      const mergedAdmins = [...r.admins];
      localAdmins.forEach(la=>{
        if(la.email && !cloudAByEmail[la.email.toLowerCase()]) mergedAdmins.push(la);
      });
      dbSet(DB_KEYS.admins, mergedAdmins);
    }
    // Restore client data from cloud
    if(r.clients && Array.isArray(r.clients) && r.clients.length) _saveClientDB(r.clients);
    if(r.orgExcluded)  localStorage.setItem('wl_org_excluded_names', r.orgExcluded);
    // Project Activities: merge cloud + local
    if(r.projectActivities) dbSet(DB_KEYS.projectActivities, _mergeCloudArr(r.projectActivities, dbGet(DB_KEYS.projectActivities)||[], 500));
    if(r.goals)        dbSet(DB_KEYS.goals,    _mergeCloudArr(r.goals,    dbGet(DB_KEYS.goals)||[]));
    if(r.feed)         dbSet(DB_KEYS.feed,     _mergeCloudArr(r.feed,     dbGet(DB_KEYS.feed)||[], 100));
    if(r.announcement) dbSet('wl_announcement', r.announcement);
    if(r.coc)          dbSet(DB_KEYS.coc,      r.coc);
    if(r.settings)     dbSet(DB_KEYS.settings,  r.settings);
    if(r.orgNodes)       dbSet(DB_KEYS.orgNodes,  r.orgNodes);
    if(r.orgLinks)       dbSet(DB_KEYS.orgLinks,  r.orgLinks);
    if(r.orgLayoutVersion) localStorage.setItem('wl_org_layout_ver', r.orgLayoutVersion);
    if(!fromLiveSync && (r.orgNodes || r.orgLinks)){
      if(typeof orgLoad === 'function') orgLoad();
      if(typeof _syncUsersToOrgChart === 'function' && _syncUsersToOrgChart()){
        if(typeof orgSave === 'function') orgSave();
      }
      if(document.getElementById('org-canvas') && typeof renderOrgChart === 'function') renderOrgChart();
    }
    if(r.primaryAdminPw) localStorage.setItem('wl_primary_admin_pw', r.primaryAdminPw);
    if(r.otPolicy)       dbSet(DB_KEYS.otPolicy,  r.otPolicy);
    if(r.messages)       dbSet(DB_KEYS.messages,      _mergeCloudArr(r.messages,     dbGet(DB_KEYS.messages)||[], 500));
    if(r.roadmapTasks)   dbSet(DB_KEYS.roadmapTasks, _mergeRoadmapArr(r.roadmapTasks, dbGet(DB_KEYS.roadmapTasks)||[]));

    // Safety net: if users DB is still empty after merge, re-seed core team
    if(!(dbGet(DB_KEYS.users)||[]).length && typeof _seedCoreTeam === 'function'){
      _seedCoreTeam();
    }

    const now = new Date().toISOString();
    localStorage.setItem('wl_cloud_last_sync', now);
    updateCloudStatusUI();
    renderUserTable();
    if(typeof window._renderAdminTableImpl === 'function') window._renderAdminTableImpl();
    if(typeof refreshAdminOverview === 'function') refreshAdminOverview();
    if(typeof refreshLiveFeed === 'function') refreshLiveFeed();
    if(typeof renderAdminTimeOff === 'function') renderAdminTimeOff();
    if(typeof renderSavedPayrolls === 'function') renderSavedPayrolls();
    if(typeof refreshArchive === 'function') refreshArchive();
    if(typeof updateAdminMsgBadge === 'function') updateAdminMsgBadge();
    if(typeof _refreshAdminMessagesIfOpen === 'function') _refreshAdminMessagesIfOpen();
    if(!silent) showToast('✅ All data pulled from cloud');
  } catch(e){
    setCloudStatus('Pull failed: '+e.message,'error');
    if(!silent) showToast('❌ Cloud pull failed — check connection');
  }
}

// Backward-compat aliases
async function cloudPushUsers(silent=false){ return cloudPushAll(silent); }
async function cloudPullUsers(silent=false){ return cloudPullAll(silent); }

// Auto-sync after every data write
async function cloudAutoSync(){
  if(!cloudIsConfigured()) return;
  await cloudPushAll(true);
}

// Live sync — polls cloud every 30s for admin roles so all devices stay in sync
let _liveSyncInterval = null;
function startLiveSync(level){
  if(_liveSyncInterval) clearInterval(_liveSyncInterval);
  const syncRoles = ['admin','super','owner','account_manager','production_manager','creative_manager'];
  if(!syncRoles.includes(level)) return;
  _liveSyncInterval = setInterval(async ()=>{
    if(!cloudIsConfigured()) return;
    await cloudPullAll(true, true); // silent background sync — does NOT reset org chart canvas
  }, 30000); // every 30 seconds
}
'''

html = html[:cloud_start] + NEW_CLOUD_SECTION + html[cloud_end:]
print("✅ Cloud sync section replaced with proxy-based version")

# ============================================================
# 2. Remove the old guarded cloud functions that reference direct JSONBin URLs
#    These were from a previous iteration and are now superseded
# ============================================================
OLD_GUARDED = '''// Guarded wrappers — prompt to configure if no key is set
function guardedCloudPull(){
  if(!cloudIsConfigured()){
    if(confirm('Cloud sync is not configured.\\nClick OK to open the Configure panel and enter your API key and Bin ID.'))
      toggleCloudConfig();
    return;
  }
  cloudPullAll();
}
function guardedCloudPush(){
  if(!cloudIsConfigured()){
    if(confirm('Cloud sync is not configured.\\nClick OK to open the Configure panel.'))
      toggleCloudConfig();
    return;
  }
  cloudPushAll();
}'''
if OLD_GUARDED in html:
    html = html.replace(OLD_GUARDED, '', 1)
    print("✅ Removed old guardedCloud wrappers")
else:
    print("ℹ️  guardedCloud wrappers not found (may already be gone)")

# ============================================================
# 3. Remove old testCloudConnection that uses direct JSONBin URL
# ============================================================
test_conn_start = html.find('\nasync function testCloudConnection(){')
test_conn_end_marker = '\n// ── Auto-refresh overview'
test_conn_end = html.find(test_conn_end_marker, test_conn_start) if test_conn_start != -1 else -1

if test_conn_start != -1 and test_conn_end != -1:
    # Check if it has direct JSONBin URL
    test_fn = html[test_conn_start:test_conn_end]
    if 'api.jsonbin.io' in test_fn or 'jsonbin.io' in test_fn:
        NEW_TEST_CONN = '''
async function testCloudConnection(){
  const apiKey = document.getElementById('cloudApiKey')?.value.trim();
  const binId  = document.getElementById('cloudBinId')?.value.trim();
  const out    = document.getElementById('cloudTestResult');
  if(!out) return;
  out.style.display = 'block';
  if(!apiKey || !binId){
    out.innerHTML = '<span style="color:var(--red)">&#10060; Please fill in both API Key and Bin ID first.</span>';
    return;
  }
  out.innerHTML = '<span style="color:var(--text-light)">&#128260; Testing connection\u2026</span>';
  try {
    const res  = await fetch(`/api/jsonbin-proxy?binId=${binId}`, {
      headers: { 'x-bin-key': apiKey }
    });
    const body = await res.json().catch(()=>({}));
    if(res.ok){
      const keys = Object.keys(body.record || {});
      out.innerHTML = `<span style="color:var(--green,#2e9e6e)">&#9989; Connected! Bin contains: ${keys.length ? keys.join(', ') : '(empty)'}</span>`;
    } else if(res.status === 401){
      out.innerHTML = `<span style="color:var(--red)">&#10060; 401 Unauthorized \u2014 passphrase is wrong.</span>`;
    } else if(res.status === 403){
      out.innerHTML = `<span style="color:var(--red)">&#10060; 403 Forbidden \u2014 check your API key and bin access.</span>`;
    } else if(res.status === 404){
      out.innerHTML = `<span style="color:var(--red)">&#10060; 404 Not Found \u2014 Bin ID "${binId}" does not exist.</span>`;
    } else {
      out.innerHTML = `<span style="color:var(--red)">&#10060; HTTP ${res.status} \u2014 ${JSON.stringify(body).substring(0,100)}</span>`;
    }
  } catch(e){
    out.innerHTML = `<span style="color:var(--red)">&#10060; Network error: ${e.message}</span>`;
  }
}
'''
        html = html[:test_conn_start] + NEW_TEST_CONN + html[test_conn_end:]
        print("✅ testCloudConnection updated to use proxy")
    else:
        print("ℹ️  testCloudConnection already uses proxy or different pattern")
else:
    print(f"ℹ️  testCloudConnection not found ({test_conn_start}, {test_conn_end})")

# ============================================================
# 4. Remove any remaining one-time migration code for old API key
#    (was added to clear the old JSONBin master key from localStorage)
# ============================================================
OLD_MIGRATION = '''// One-time migration: clear the old expired key so it doesn't auto-fill
(function _clearOldApiKey(){
  try {
    const cfg = dbGet('wl_cloud_config') || {};
    if(cfg.apiKey && cfg.apiKey.startsWith('$2a$')) {
      dbSet('wl_cloud_config', { ...cfg, apiKey: '' });
      console.log('[WLM] Cleared old expired API key from cloud config.');
    }
  } catch(e) {}
})();'''
if OLD_MIGRATION in html:
    html = html.replace(OLD_MIGRATION, '// Cloud config migration: no longer needed (using proxy)', 1)
    print("✅ Old migration code removed")
else:
    print("ℹ️  Old migration code not found")

# ============================================================
# 5. Verify brace balance in all script blocks
# ============================================================
import re
scripts = re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL)
print(f"\nScript blocks: {len(scripts)}")
all_ok = True
for i, s in enumerate(scripts):
    opens = s.count('{')
    closes = s.count('}')
    diff = opens - closes
    status = "✅" if diff == 0 else "❌"
    print(f"  Script {i+1}: {{ = {opens}, }} = {closes}, diff = {diff} {status}")
    if diff != 0:
        all_ok = False

if not all_ok:
    print("⚠️  Brace imbalance detected — check script blocks")
else:
    print("✅ All script blocks balanced")

# Save
with open('/home/user/webapp/index.html', 'w', encoding='utf-8') as f:
    f.write(html)

print(f"\n✅ File saved: {len(html)} chars")
