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

  // GitHub-backed storage: used when the API key is a GitHub PAT
  if (apiKey.startsWith('github_pat_') || apiKey.startsWith('ghp_')) {
    return handleGitHub(req, res, apiKey, isRead);
  }

  // JSONBin fallback
  const binId = req.query?.binId;
  if (!binId || !/^[a-f0-9]{24}$/.test(binId)) {
    return res.status(400).json({ error: 'Valid binId required' });
  }
  return handleJsonBin(req, res, binId, apiKey, isRead);
}

async function handleGitHub(req, res, token, isRead) {
  const fileUrl = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}?ref=${GH_BRANCH}`;
  const ghHeaders = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'wlm-ops-hub',
  };

  try {
    if (isRead) {
      const r = await fetch(fileUrl, { headers: ghHeaders });
      if (!r.ok) {
        if (r.status === 404) return res.status(200).json({ record: {} });
        return res.status(r.status).json({ error: `GitHub read failed: ${r.status}` });
      }
      const data = await r.json();
      const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
      const record = JSON.parse(decoded);
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json({ record });
    }

    // Write: read current SHA first, then update
    const getR = await fetch(fileUrl, { headers: ghHeaders });
    let sha = null;
    if (getR.ok) {
      const existing = await getR.json();
      sha = existing.sha;
    }

    const encoded = Buffer.from(JSON.stringify(req.body || {})).toString('base64');
    const putBody = { message: 'sync', content: encoded, branch: GH_BRANCH };
    if (sha) putBody.sha = sha;

    const putR = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`,
      { method: 'PUT', headers: { ...ghHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(putBody) }
    );
    if (!putR.ok) {
      const err = await putR.text();
      return res.status(putR.status).json({ error: `GitHub write failed: ${err}` });
    }
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ record: req.body });
  } catch (e) {
    return res.status(502).json({ error: 'GitHub storage error: ' + e.message });
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
