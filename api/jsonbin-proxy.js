export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bin-key, x-bin-meta');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const binId = req.query?.binId;
  if (!binId || !/^[a-f0-9]{24}$/.test(binId)) {
    return res.status(400).json({ error: 'Valid binId required' });
  }

  const apiKey = req.headers['x-bin-key'] || '';
  const isRead = req.method === 'GET';

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
