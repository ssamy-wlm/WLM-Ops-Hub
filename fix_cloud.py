with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

errors = []

# ── FIX 1: Migration — unconditionally clear ANY config that has the old hardcoded key
# OR has an empty API key (broken state). Preserve binId so user only re-enters key.
old_migration = """  // One-time migration: clear the old hardcoded API key from localStorage so it
  // doesn't silently block cloud access after a JSONBin renewal. The admin will
  // re-enter their new key once via the ⚙ Configure panel.
  (function(){
    try {
      const cached = dbGet(CLOUD_CFG_KEY) || {};
      const OLD_KEY = '$2a$10$7P9ajJXH1z6z8nT6lFT06uXzWya5VoVbzw17MWn0ldpgc6l0fFDY6';
      if(cached.apiKey === OLD_KEY){
        // Preserve the binId so the user only needs to re-enter the API key
        dbSet(CLOUD_CFG_KEY, { apiKey: '', binId: cached.binId || '' });
      }
    } catch(e){}
  })();
  // Update cloud sync status badge (config is never force-overwritten — admin saves it via UI)
  updateCloudStatusUI();
  // Auto-pull on load if cloud is configured (get latest from cloud)
  if(cloudIsConfigured()){
    cloudPullUsers(true);
  }"""

new_migration = """  // Migration: wipe any config containing the old expired hardcoded API key.
  // If the saved key matches the old key, clear it so admin is prompted to enter the new one.
  // binId is preserved so the user only needs to re-enter the API key.
  (function(){
    try {
      const cached = dbGet(CLOUD_CFG_KEY) || {};
      const OLD_KEY = '$2a$10$7P9ajJXH1z6z8nT6lFT06uXzWya5VoVbzw17MWn0ldpgc6l0fFDY6';
      if(cached.apiKey === OLD_KEY || cached.apiKey === undefined || cached.apiKey === null || cached.apiKey === ''){
        dbSet(CLOUD_CFG_KEY, { apiKey: '', binId: cached.binId || '69f267fa36566621a8086c5d' });
      }
    } catch(e){}
  })();
  // Update cloud sync status badge (config is never force-overwritten — admin saves it via UI)
  updateCloudStatusUI();
  // Auto-open Configure panel if not yet configured so admin sees it immediately
  if(!cloudIsConfigured()){
    const panel = document.getElementById('cloudConfigPanel');
    const btn   = document.getElementById('cloudConfigToggleBtn');
    const cfg   = getCloudConfig();
    if(panel && panel.style.display === 'none'){
      panel.style.display = 'block';
      if(btn) btn.textContent = '\u2715 Close';
      // Pre-fill binId if we have it
      const binInput = document.getElementById('cloudBinId');
      if(binInput && cfg.binId) binInput.value = cfg.binId;
    }
  } else {
    cloudPullUsers(true);
  }"""

if old_migration in content:
    content = content.replace(old_migration, new_migration)
    print("FIX 1 OK: migration updated + auto-open Configure panel")
else:
    errors.append("FIX 1 MISSING: migration block")

# ── FIX 2: Guard Pull All Data and Push All Data buttons — prompt Configure if not set ──
old_pull_btn = 'onclick="cloudPullAll()">↓ Pull All Data</button>'
new_pull_btn = 'onclick="guardedCloudPull()">↓ Pull All Data</button>'

old_push_btn = 'onclick="cloudPushAll()">↑ Push All Data</button>'
new_push_btn = 'onclick="guardedCloudPush()">↑ Push All Data</button>'

if old_pull_btn in content:
    content = content.replace(old_pull_btn, new_pull_btn)
    print("FIX 2a OK: Pull button guarded")
else:
    errors.append("FIX 2a MISSING: pull button")

if old_push_btn in content:
    content = content.replace(old_push_btn, new_push_btn)
    print("FIX 2b OK: Push button guarded")
else:
    errors.append("FIX 2b MISSING: push button")

# ── FIX 3: Add guardedCloudPull / guardedCloudPush helpers after saveCloudConfig ──
old_save = """function toggleCloudConfig(){"""
new_save = """function guardedCloudPull(){
  if(!cloudIsConfigured()){
    showToast('\u26a0\ufe0f Please configure your API Key first \u2014 click \u2699 Configure');
    const panel = document.getElementById('cloudConfigPanel');
    const btn   = document.getElementById('cloudConfigToggleBtn');
    const cfg   = getCloudConfig();
    if(panel){ panel.style.display='block'; if(btn) btn.textContent='\u2715 Close'; }
    const binInput = document.getElementById('cloudBinId');
    if(binInput && cfg.binId) binInput.value = cfg.binId;
    return;
  }
  cloudPullAll();
}
function guardedCloudPush(){
  if(!cloudIsConfigured()){
    showToast('\u26a0\ufe0f Please configure your API Key first \u2014 click \u2699 Configure');
    const panel = document.getElementById('cloudConfigPanel');
    const btn   = document.getElementById('cloudConfigToggleBtn');
    const cfg   = getCloudConfig();
    if(panel){ panel.style.display='block'; if(btn) btn.textContent='\u2715 Close'; }
    const binInput = document.getElementById('cloudBinId');
    if(binInput && cfg.binId) binInput.value = cfg.binId;
    return;
  }
  cloudPushAll();
}

function toggleCloudConfig(){"""

if old_save in content:
    content = content.replace(old_save, new_save)
    print("FIX 3 OK: guardedCloudPull/Push added")
else:
    errors.append("FIX 3 MISSING: toggleCloudConfig insertion point")

print()
if errors:
    print("ERRORS — file NOT written:")
    for e in errors: print(" -", e)
else:
    with open('index.html', 'w', encoding='utf-8') as f:
        f.write(content)
    print("All cloud fixes written successfully")
