with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

errors = []

# ── FIX 1: Add _mergeBlockersArr after _mergeCloudArr ──
# Uses resolvedAt/date timestamp so most-recently-updated copy always wins.
# Cloud can NEVER overwrite a locally-resolved blocker.
old_merge = """function _mergeCloudArr(cloudArr, localArr, limit=200){
  const combined = [...(Array.isArray(cloudArr)?cloudArr:[]), ...(Array.isArray(localArr)?localArr:[])];
  const seen = new Set();
  return combined.filter(x=>{ const k=x.id!=null?String(x.id):JSON.stringify(x); if(seen.has(k))return false; seen.add(k); return true; })
                 .sort((a,b)=>(b.id||0)-(a.id||0)).slice(0,limit);
}"""

new_merge = """function _mergeCloudArr(cloudArr, localArr, limit=200){
  const combined = [...(Array.isArray(cloudArr)?cloudArr:[]), ...(Array.isArray(localArr)?localArr:[])];
  const seen = new Set();
  return combined.filter(x=>{ const k=x.id!=null?String(x.id):JSON.stringify(x); if(seen.has(k))return false; seen.add(k); return true; })
                 .sort((a,b)=>(b.id||0)-(a.id||0)).slice(0,limit);
}

// Merge blockers: most-recently-updated copy wins so resolved status is never overwritten by cloud
function _mergeBlockersArr(cloudArr, localArr, limit=500){
  const map = new Map();
  // Load cloud copies first
  (Array.isArray(cloudArr)?cloudArr:[]).forEach(function(b){
    if(b && b.id!=null) map.set(String(b.id), b);
  });
  // Local copy wins if it is newer (resolvedAt > cloud copy's resolvedAt, or status changed to resolved)
  (Array.isArray(localArr)?localArr:[]).forEach(function(b){
    if(b == null || b.id == null) return;
    var key = String(b.id);
    var existing = map.get(key);
    if(!existing){ map.set(key, b); return; }
    // If local has resolved and cloud does not — local wins unconditionally
    if(b.status === 'resolved' && existing.status !== 'resolved'){ map.set(key, b); return; }
    // Otherwise compare timestamps: most recent update wins
    var lt = new Date(b.resolvedAt || b.date || 0).getTime();
    var ct = new Date(existing.resolvedAt || existing.date || 0).getTime();
    if(lt >= ct) map.set(key, b);
  });
  return [...map.values()]
    .sort(function(a,b){ return (b.id||0)-(a.id||0); })
    .slice(0, limit);
}"""

if old_merge in content:
    content = content.replace(old_merge, new_merge)
    print("FIX 1 OK: _mergeBlockersArr added")
else:
    errors.append("FIX 1 MISSING: _mergeCloudArr not found")

# ── FIX 2: cloudPushAll — use _mergeBlockersArr for blockers ──
old_push = "      blockers:     _mergeCloudArr(cloudRecord.blockers, dbGet(DB_KEYS.blockers)||[]),"
new_push = "      blockers:     _mergeBlockersArr(cloudRecord.blockers, dbGet(DB_KEYS.blockers)||[]),"
if old_push in content:
    content = content.replace(old_push, new_push)
    print("FIX 2 OK: cloudPushAll uses _mergeBlockersArr")
else:
    errors.append("FIX 2 MISSING: cloudPushAll blockers line")

# ── FIX 3: cloudPullAll — use _mergeBlockersArr for blockers ──
old_pull = "    if(r.blockers)     dbSet(DB_KEYS.blockers, _mergeCloudArr(r.blockers, dbGet(DB_KEYS.blockers)||[]));"
new_pull = "    if(r.blockers)     dbSet(DB_KEYS.blockers, _mergeBlockersArr(r.blockers, dbGet(DB_KEYS.blockers)||[]));"
if old_pull in content:
    content = content.replace(old_pull, new_pull)
    print("FIX 3 OK: cloudPullAll uses _mergeBlockersArr")
else:
    errors.append("FIX 3 MISSING: cloudPullAll blockers line")

# ── FIX 4: Admin overview — show ALL blockers split into open + recently resolved ──
# Show open ones with Resolve button, and resolved ones (last 5) with who resolved + when
old_overview = """  const blockerList = document.getElementById('ov-blocker-list');
  if(blockerList){
    if(!activeBlockers.length){
      blockerList.innerHTML='<div style="font-size:13px;color:var(--text-light);padding:12px 0;">No active blockers.</div>';
    } else {
      blockerList.innerHTML = activeBlockers.slice(0,5).map(b=>{
        const sev=b.sev||'medium';
        const sevColor = sev==='critical'?'var(--red)':sev==='high'?'var(--orange)':'var(--accent)';
        return `<div class="ov-blocker-row" style="padding:10px 0;border-bottom:1px solid var(--border);">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <div style="font-size:13px;font-weight:700;color:var(--text-dark);flex:1;">${b.title||'Untitled'}</div>
            <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:${sevColor}22;color:${sevColor};">${sev.toUpperCase()}</span>
            <button class="btn btn-sm btn-outline" style="font-size:11px;padding:3px 10px;flex-shrink:0;" onclick="adminResolveBlocker(${b.id},this)">Resolve</button>
          </div>
          <div style="font-size:11px;color:var(--text-light);margin-top:2px;">${b.user||'Unknown'} · ${b.date?new Date(b.date).toLocaleDateString():'—'}</div>
        </div>`;
      }).join('');
    }
  }"""

new_overview = """  const blockerList = document.getElementById('ov-blocker-list');
  if(blockerList){
    const resolvedBlockers = blockers.filter(b=>b.status==='resolved')
      .sort((a,b)=>new Date(b.resolvedAt||b.date||0)-new Date(a.resolvedAt||a.date||0))
      .slice(0,5);

    let html = '';
    if(!activeBlockers.length){
      html += '<div style="font-size:13px;color:var(--text-light);padding:8px 0;">No active blockers.</div>';
    } else {
      html += activeBlockers.slice(0,10).map(b=>{
        const sev=b.sev||'medium';
        const sevColor = sev==='critical'?'var(--red)':sev==='high'?'var(--orange)':'var(--accent)';
        return `<div class="ov-blocker-row" style="padding:10px 0;border-bottom:1px solid var(--border);">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <div style="font-size:13px;font-weight:700;color:var(--text-dark);flex:1;">${b.title||'Untitled'}</div>
            <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:${sevColor}22;color:${sevColor};">${sev.toUpperCase()}</span>
            <button class="btn btn-sm btn-outline" style="font-size:11px;padding:3px 10px;flex-shrink:0;" onclick="adminResolveBlocker(${b.id},this)">Resolve</button>
          </div>
          <div style="font-size:11px;color:var(--text-light);margin-top:2px;">${b.user||'Unknown'} &middot; Opened: ${b.date?new Date(b.date).toLocaleDateString():'—'}</div>
        </div>`;
      }).join('');
    }

    if(resolvedBlockers.length){
      html += '<div style="font-size:11px;font-weight:700;color:var(--text-light);text-transform:uppercase;letter-spacing:.06em;padding:12px 0 6px;">Recently Resolved</div>';
      html += resolvedBlockers.map(b=>{
        const resolvedDate = b.resolvedAt ? new Date(b.resolvedAt).toLocaleDateString() : '—';
        const resolvedBy   = b.resolvedBy || 'User';
        return `<div style="padding:8px 0;border-bottom:1px solid var(--border);opacity:.75;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <div style="font-size:12px;font-weight:600;color:var(--text-dark);flex:1;text-decoration:line-through;">${b.title||'Untitled'}</div>
            <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:var(--green,#2e9e6e)22;color:var(--green,#2e9e6e);">RESOLVED</span>
          </div>
          <div style="font-size:11px;color:var(--text-light);margin-top:2px;">${b.user||'Unknown'} &middot; Resolved by ${resolvedBy} on ${resolvedDate}</div>
        </div>`;
      }).join('');
    }
    blockerList.innerHTML = html;
  }"""

if old_overview in content:
    content = content.replace(old_overview, new_overview)
    print("FIX 4 OK: admin overview shows open + recently resolved with dates")
else:
    errors.append("FIX 4 MISSING: admin overview blocker block")

print()
if errors:
    print("ERRORS — file NOT written:")
    for e in errors: print(" -", e)
else:
    with open('index.html', 'w', encoding='utf-8') as f:
        f.write(content)
    print("All fixes written successfully")
