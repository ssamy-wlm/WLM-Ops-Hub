const GH_OWNER  = 'ssamy-wlm';
const GH_REPO   = 'WLM-Ops-Hub';
const GH_BRANCH = '_data';
const GH_FILE   = 'cloud-data.json';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bin-key, x-bin-meta');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = req.headers['x-bin-key'] || '';
  const isRead = req.method === 'GET';

  // GitHub-backed storage — triggered by 'wlm-sync' passphrase or a direct GitHub PAT.
  const isGitHubKey = apiKey === 'wlm-sync' || apiKey.startsWith('github_pat_') || apiKey.startsWith('ghp_');
  if (isGitHubKey) {
    // Reads use raw.githubusercontent.com — no auth needed for public repo.
    if (isRead) return handleGitHubRead(res);
    // Writes need a real token: env var first, then direct PAT from client.
    const ghToken = process.env.GITHUB_STORAGE_TOKEN || (apiKey !== 'wlm-sync' ? apiKey : '');
    if (!ghToken) return res.status(500).json({ error: 'GITHUB_STORAGE_TOKEN env var not set on server' });
    return handleGitHubWrite(req, res, ghToken);
  }

  // JSONBin fallback
  const binId = req.query?.binId;
  if (!binId || !/^[a-f0-9]{24}$/.test(binId)) {
    return res.status(400).json({ error: 'Valid binId required' });
  }
  return handleJsonBin(req, res, binId, apiKey, isRead);
}

async function handleGitHubRead(res) {
  // Public repo — raw URL needs no authentication and has no CORS restriction.
  const rawUrl = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/refs/heads/${GH_BRANCH}/${GH_FILE}`;
  try {
    const r = await fetch(rawUrl);
    if (!r.ok) {
      if (r.status === 404) return res.status(200).json({ record: {} });
      return res.status(r.status).json({ error: `Read failed: ${r.status}` });
    }
    const record = JSON.parse(await r.text());
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ record });
  } catch (e) {
    return res.status(502).json({ error: 'Read error: ' + e.message });
  }
}

async function handleGitHubWrite(req, res, token) {
  const fileUrl = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`;
  const ghHeaders = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'wlm-ops-hub',
    'Content-Type': 'application/json',
  };
  try {
    // Get current SHA to avoid conflicts
    const getR = await fetch(`${fileUrl}?ref=${GH_BRANCH}`, { headers: ghHeaders });
    let sha = null;
    if (getR.ok) sha = (await getR.json()).sha;

    const encoded = Buffer.from(JSON.stringify(req.body || {})).toString('base64');
    const putBody = { message: 'sync', content: encoded, branch: GH_BRANCH };
    if (sha) putBody.sha = sha;

    const putR = await fetch(fileUrl, { method: 'PUT', headers: ghHeaders, body: JSON.stringify(putBody) });
    if (!putR.ok) return res.status(putR.status).json({ error: `Write failed: ${await putR.text()}` });
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ record: req.body });
  } catch (e) {
    return res.status(502).json({ error: 'Write error: ' + e.message });
  }
}

async function handleJsonBin(req, res, binId, apiKey, isRead) {
  const url = isRead
    ? `https://api.jsonbin.io/v3/b/${binId}/latest`
    : `https://api.jsonbin.io/v3/b/${binId}`;

  const upstreamHeaders = {};
  if (apiKey) upstreamHeaders['X-Master-Key'] = apiKey;
  if (isRead) {
    const binMeta = req.headers['x-bin-meta'];
    if (binMeta) upstreamHeaders['X-Bin-Meta'] = binMeta;
  } else {
    upstreamHeaders['Content-Type'] = 'application/json';
    upstreamHeaders['X-Bin-Versioning'] = 'false';
  }

  try {
    const fetchOpts = { method: req.method, headers: upstreamHeaders };
    if (!isRead && req.body) fetchOpts.body = JSON.stringify(req.body);
    const upstream = await fetch(url, fetchOpts);
    const text = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    return res.status(upstream.status).end(text);
  } catch (e) {
    return res.status(502).json({ error: 'Upstream fetch failed: ' + e.message });
  }
}
