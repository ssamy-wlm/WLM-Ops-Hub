import re

with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

errors = []

# ── FIX 1: User resolve button — call DB function instead of just DOM remove ──
old1 = "this.closest('.blocker-item').remove();showToast('Blocker resolved')\">Resolve</button>"
new1 = "resolveBlockerById(this)\">Resolve</button>"
if old1 in content:
    content = content.replace(old1, new1)
    print("FIX 1 OK: user resolve button wired to DB")
else:
    errors.append("FIX 1 MISSING: user resolve button")

# ── FIX 2: Tag new blocker DOM element with its DB id after _origAddBlocker() ──
old2 = "  dbPush(DB_KEYS.blockers, blocker);\n  logActivity('blocker', userName, 'Logged blocker: ' + title, sev);\n  // call original\n  _origAddBlocker();\n};"
new2 = "  dbPush(DB_KEYS.blockers, blocker);\n  logActivity('blocker', userName, 'Logged blocker: ' + title, sev);\n  // call original, then tag the DOM element with the DB id so resolve can find it\n  _origAddBlocker();\n  const _items = document.querySelectorAll('#blockerList .blocker-item');\n  if(_items.length) _items[_items.length-1].dataset.blockerId = blocker.id;\n};"
if old2 in content:
    content = content.replace(old2, new2)
    print("FIX 2 OK: blocker DOM tagged with DB id")
else:
    errors.append("FIX 2 MISSING: addBlocker tag")

# ── FIX 3: Inject helper functions after the addBlocker override block ──
marker = "  const _items = document.querySelectorAll('#blockerList .blocker-item');\n  if(_items.length) _items[_items.length-1].dataset.blockerId = blocker.id;\n};"

new_fns = r"""

// ── Resolve a blocker: marks status='resolved' in DB then removes the DOM row ──
function resolveBlockerById(btn){
  var item = btn.closest('.blocker-item');
  var bid  = item ? parseInt(item.dataset.blockerId) : null;
  if(bid){
    var all = dbGet(DB_KEYS.blockers)||[];
    var idx = all.findIndex(function(b){ return b.id===bid; });
    if(idx!==-1){
      all[idx].status     = 'resolved';
      all[idx].resolvedAt = new Date().toISOString();
      all[idx].resolvedBy = _getCurrentUserName();
      dbSet(DB_KEYS.blockers, all);
      logActivity('blocker', _getCurrentUserName(), 'Resolved blocker: '+(all[idx].title||''), '');
    }
  }
  if(item) item.remove();
  showToast('Blocker resolved');
}

// ── Admin resolve: marks resolved in DB and refreshes the overview panel ──
function adminResolveBlocker(bid, btn){
  var all = dbGet(DB_KEYS.blockers)||[];
  var idx = all.findIndex(function(b){ return b.id===bid; });
  if(idx!==-1){
    all[idx].status     = 'resolved';
    all[idx].resolvedAt = new Date().toISOString();
    all[idx].resolvedBy = 'Admin';
    dbSet(DB_KEYS.blockers, all);
    logActivity('blocker','Admin','Admin resolved blocker: '+(all[idx].title||''), '');
  }
  var row = btn ? btn.closest('.ov-blocker-row') : null;
  if(row) row.remove();
  showToast('Blocker marked resolved');
  if(typeof refreshAdminOverview==='function') setTimeout(refreshAdminOverview, 100);
}

// ── Load the logged-in user's open blockers from DB on login ──
function loadUserBlockersFromDB(){
  var userName = _getCurrentUserName();
  if(!userName) return;
  var all  = dbGet(DB_KEYS.blockers)||[];
  var mine = all.filter(function(b){ return b.status==='open' && b.user===userName; });
  var list = document.getElementById('blockerList');
  if(!list) return;
  list.innerHTML = '';
  mine.forEach(function(b){
    var sev      = b.sev||'medium';
    var sevLabel = (sev==='escalated') ? 'Escalated' : 'Warning';
    var dateStr  = b.date ? new Date(b.date).toLocaleDateString() : '';
    var el       = document.createElement('div');
    el.className = 'blocker-item';
    el.dataset.blockerId = b.id;
    el.innerHTML =
      '<div class="blocker-header">'
      +'<span class="status-badge badge-pending">&#9888; '+sevLabel+'</span>'
      +'<div class="blocker-title">'+(b.title||'')+'</div>'
      +'<button class="btn btn-sm btn-outline" onclick="resolveBlockerById(this)">Resolve</button>'
      +'</div>'
      +'<div class="blocker-desc">'+(b.desc||'')+'</div>'
      +'<div class="blocker-meta">'
      +'<span>&#128197; '+dateStr+'</span>'
      +'<span>&#127970; '+(b.proj||'General')+'</span>'
      +'</div>';
    list.appendChild(el);
  });
}
"""
if marker in content:
    content = content.replace(marker, marker + new_fns)
    print("FIX 3 OK: helper functions injected")
else:
    errors.append("FIX 3 MISSING: injection marker")

# ── FIX 4: Call loadUserBlockersFromDB() on user login ──
old4 = "    showUserApp();\n    return;\n  }\n  errEl.innerHTML = 'Invalid email or password."
new4 = "    showUserApp();\n    setTimeout(loadUserBlockersFromDB, 200);\n    return;\n  }\n  errEl.innerHTML = 'Invalid email or password."
if old4 in content:
    content = content.replace(old4, new4)
    print("FIX 4 OK: loadUserBlockersFromDB called on login")
else:
    errors.append("FIX 4 MISSING: login hook")

# ── FIX 5: Admin overview blocker rows — add class + Resolve button ──
old5 = ('        const sev=b.sev||\'medium\';\n'
        '        const sevColor = sev===\'critical\'?\'var(--red)\':sev===\'high\'?\'var(--orange)\":\'var(--accent)\';\n'
        '        return `<div style="padding:10px 0;border-bottom:1px solid var(--border);">\n'
        '          <div style="display:flex;align-items:center;justify-content:space-between;">\n'
        '            <div style="font-size:13px;font-weight:700;color:var(--text-dark);">${b.title||\'Untitled\'}</div>\n'
        '            <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:${sevColor}22;color:${sevColor};">${sev.toUpperCase()}</span>\n'
        '          </div>\n'
        '          <div style="font-size:11px;color:var(--text-light);margin-top:2px;">${b.user||\'Unknown\'} \u00b7 ${b.date?new Date(b.date).toLocaleDateString():\'\\u2014\'}</div>\n'
        '        </div>`;')

# Use a simpler targeted search
search5 = "justify-content:space-between;\">\n            <div style=\"font-size:13px;font-weight:700;color:var(--text-dark);\">${b.title||'Untitled'}</div>"
replace5_old = (
    'justify-content:space-between;">\n'
    '            <div style="font-size:13px;font-weight:700;color:var(--text-dark);">${b.title||\'Untitled\'}</div>\n'
    '            <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:${sevColor}22;color:${sevColor};">${sev.toUpperCase()}</span>\n'
    '          </div>'
)
replace5_new = (
    'justify-content:space-between;gap:8px;">\n'
    '            <div style="font-size:13px;font-weight:700;color:var(--text-dark);flex:1;">${b.title||\'Untitled\'}</div>\n'
    '            <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;background:${sevColor}22;color:${sevColor};">${sev.toUpperCase()}</span>\n'
    '            <button class="btn btn-sm btn-outline" style="font-size:11px;padding:3px 10px;flex-shrink:0;" onclick="adminResolveBlocker(${b.id},this)">Resolve</button>\n'
    '          </div>'
)

# Also wrap the row div with the class so adminResolveBlocker can find it
old5_wrap  = 'return `<div style="padding:10px 0;border-bottom:1px solid var(--border);">'
new5_wrap  = 'return `<div class="ov-blocker-row" style="padding:10px 0;border-bottom:1px solid var(--border);">'

if replace5_old in content:
    content = content.replace(replace5_old, replace5_new)
    print("FIX 5a OK: admin resolve button added")
else:
    errors.append("FIX 5a MISSING: admin blocker row layout")

if old5_wrap in content:
    content = content.replace(old5_wrap, new5_wrap)
    print("FIX 5b OK: ov-blocker-row class added")
else:
    errors.append("FIX 5b MISSING: row wrap class")

print()
if errors:
    print("ERRORS — file NOT written:")
    for e in errors: print(" -", e)
else:
    with open('index.html', 'w', encoding='utf-8') as f:
        f.write(content)
    print("All fixes written to index.html successfully")
