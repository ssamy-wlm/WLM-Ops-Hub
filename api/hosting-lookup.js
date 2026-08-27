// Hosting-details auto-detect (registrar / platform / hosting provider) for
// a single client website URL — David's Aug 26 meeting request: feed a
// client's site URL in, get back suggested values for a "Website Hosting"
// service's registrar/sitePlatform/hostingProvider fields.
//
// Deliberately fully deterministic — no LLM call. Per the explicit decision
// on this feature: RDAP (registrar) + HTML/response-header pattern-matching
// (platform) + DNS CNAME/response-header pattern-matching (hosting
// provider). Anything the deterministic checks can't resolve confidently
// comes back BLANK with a `note` explaining why, never a guess — the
// client-side review UI is what decides whether/what to write, and this
// endpoint never touches ops_clients itself. One URL per call (not a
// batch) — Vercel's default serverless function timeout can't safely fit
// several sequential network lookups per client in one request; the batch
// tool in client.html calls this endpoint once per hosting service instead,
// so a slow/failed lookup for one client never blocks the others.
import { requireSession, tierOf } from '../lib/opsSession.js';
import { logError } from '../lib/errorLog.js';
import dns from 'dns/promises';

const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractHostname(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let candidate = rawUrl.trim();
  if (!candidate) return null;
  if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate;
  try {
    return new URL(candidate).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

// ── Registrar, via RDAP (the IANA-standardized, JSON, no-API-key successor
// to legacy WHOIS) — rdap.org is a public bootstrap proxy that resolves the
// right registry RDAP server for any TLD, so this doesn't need to fetch and
// cache IANA's own bootstrap file itself. ──
async function lookupRegistrar(hostname) {
  try {
    const res = await fetchWithTimeout(`https://rdap.org/domain/${encodeURIComponent(hostname)}`, {
      headers: { Accept: 'application/rdap+json' },
    });
    if (!res.ok) {
      return { value: '', confident: false, note: `RDAP lookup returned HTTP ${res.status}` };
    }
    const json = await res.json();
    const registrarEntity = Array.isArray(json.entities)
      ? json.entities.find(e => Array.isArray(e.roles) && e.roles.includes('registrar'))
      : null;
    if (!registrarEntity) {
      return { value: '', confident: false, note: 'RDAP response has no registrar entity' };
    }
    let name = '';
    const vcard = registrarEntity.vcardArray;
    if (Array.isArray(vcard) && Array.isArray(vcard[1])) {
      const fnEntry = vcard[1].find(entry => Array.isArray(entry) && entry[0] === 'fn');
      if (fnEntry && typeof fnEntry[3] === 'string') name = fnEntry[3];
    }
    if (!name && Array.isArray(registrarEntity.publicIds)) {
      const ianaId = registrarEntity.publicIds.find(p => p.type === 'IANA Registrar ID');
      if (ianaId) name = `IANA Registrar #${ianaId.identifier}`;
    }
    if (!name && registrarEntity.handle) name = String(registrarEntity.handle);
    return name
      ? { value: name, confident: true, note: '' }
      : { value: '', confident: false, note: 'RDAP registrar entity present but carries no name field' };
  } catch (e) {
    return {
      value: '',
      confident: false,
      note: e.name === 'AbortError' ? 'RDAP lookup timed out' : `RDAP lookup failed: ${e.message}`,
    };
  }
}

// ── Platform, via HTML signature matching. Small, explicit, extendable list
// — same "plain reviewable code, never a guess" convention already
// established for matchClient()/matchOwner() in api/process-transcript.js.
const PLATFORM_SIGNATURES = [
  { name: 'WordPress', test: html => /wp-content|wp-includes|wp-json|wordpress/i.test(html) },
  { name: 'Squarespace', test: html => /squarespace\.com|static1\.squarespace|data-sqs-/i.test(html) },
  { name: 'Wix', test: html => /wix\.com|wixstatic\.com|_wixCssRoutes/i.test(html) },
  { name: 'Shopify', test: html => /cdn\.shopify\.com|shopify\.theme/i.test(html) },
  { name: 'Webflow', test: html => /webflow\.com|data-wf-site/i.test(html) },
  { name: 'GoDaddy Website Builder', test: html => /godaddysites\.com|godaddy website builder/i.test(html) },
];

function detectPlatform(html) {
  const match = PLATFORM_SIGNATURES.find(sig => sig.test(html));
  return match
    ? { value: match.name, confident: true, note: '' }
    : { value: '', confident: false, note: 'No known platform signature matched the page' };
}

// ── Hosting provider, via DNS CNAME (checked first — most reliable when
// present) then HTTP response headers. A site fronted by Cloudflare (or any
// other reverse proxy) masks its real origin host — that's reported as a
// blank value with an explanatory note, never guessed at, matching the
// explicit "leave blank and flag for manual review" decision for this
// feature. ──
const HOST_CNAME_SIGNATURES = [
  { pattern: /\.wpengine\.com$/i, name: 'WP Engine' },
  { pattern: /\.squarespace\.com$/i, name: 'Squarespace' },
  { pattern: /\.wixdns\.net$/i, name: 'Wix' },
  { pattern: /\.myshopify\.com$/i, name: 'Shopify' },
  { pattern: /\.herokuapp\.com$/i, name: 'Heroku' },
  { pattern: /\.netlify\.app$/i, name: 'Netlify' },
  { pattern: /\.vercel-dns\.com$/i, name: 'Vercel' },
  { pattern: /\.pantheonsite\.io$/i, name: 'Pantheon' },
  { pattern: /\.godaddysites\.com$/i, name: 'GoDaddy' },
  { pattern: /\.siteground\.\w+$/i, name: 'SiteGround' },
];
const HOST_HEADER_SIGNATURES = [
  { name: 'WP Engine', test: headers => Object.keys(headers).some(k => k.toLowerCase().startsWith('x-wpe-')) },
  { name: 'Netlify', test: headers => (headers.server || '').toLowerCase().includes('netlify') || !!headers['x-nf-request-id'] },
  { name: 'Vercel', test: headers => (headers.server || '').toLowerCase().includes('vercel') || !!headers['x-vercel-id'] },
  { name: 'GitHub Pages', test: headers => (headers.server || '').toLowerCase().includes('github.com') },
  { name: 'Amazon S3 / CloudFront', test: headers => (headers.server || '').toLowerCase().includes('amazons3') || !!headers['x-amz-cf-id'] },
  { name: 'Squarespace', test: headers => (headers.server || '').toLowerCase().includes('squarespace') },
];

async function detectHostProvider(hostname, responseHeaders) {
  try {
    const cnames = await dns.resolveCname(hostname);
    for (const cname of cnames) {
      const match = HOST_CNAME_SIGNATURES.find(sig => sig.pattern.test(cname));
      if (match) return { value: match.name, confident: true, note: `CNAME → ${cname}` };
    }
  } catch {
    // No CNAME (apex/A-record site) — fall through to header matching below.
  }

  const isCloudflareProxied = !!responseHeaders['cf-ray'] || (responseHeaders.server || '').toLowerCase() === 'cloudflare';
  const headerMatch = HOST_HEADER_SIGNATURES.find(sig => sig.test(responseHeaders));
  if (headerMatch) return { value: headerMatch.name, confident: true, note: 'HTTP response headers' };
  if (isCloudflareProxied) {
    return { value: '', confident: false, note: 'Site is proxied through Cloudflare — the real origin host is masked and can\'t be determined from outside' };
  }
  return { value: '', confident: false, note: 'No known hosting-provider signature matched (CNAME or response headers)' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = await requireSession(req);
  if (!session) return res.status(401).json({ error: 'Not signed in' });
  // Read-only lookup tool (writes nothing itself — see the header comment),
  // but still an admin-facing feature per this task's own scope, so members
  // don't get a nav path to it in the first place; the server check here is
  // the actual boundary, same "server decides, not the client" rule as
  // everything else in this file's sibling endpoints.
  if (tierOf(session) === 'member') return res.status(403).json({ error: 'Admin access required' });

  const { url } = req.body || {};
  const hostname = extractHostname(url);
  if (!hostname) {
    return res.status(400).json({ error: 'A valid website URL is required' });
  }

  try {
    const [registrar, pageResult] = await Promise.all([
      lookupRegistrar(hostname),
      fetchWithTimeout(`https://${hostname}/`, {
        redirect: 'follow',
        headers: { 'User-Agent': 'WLM-Ops-Hub-HostingLookup/1.0 (+https://weblightmedia.com)' },
      })
        .then(async r => ({ ok: true, headers: Object.fromEntries(r.headers.entries()), html: await r.text() }))
        .catch(e => ({ ok: false, error: e.name === 'AbortError' ? 'Site request timed out' : e.message })),
    ]);

    let platform, hostingProvider;
    if (pageResult.ok) {
      platform = detectPlatform(pageResult.html);
      hostingProvider = await detectHostProvider(hostname, pageResult.headers);
    } else {
      const note = `Could not reach the site: ${pageResult.error}`;
      platform = { value: '', confident: false, note };
      // A dead/unreachable site can still resolve a CNAME-based host
      // signature (DNS doesn't require the site to actually respond), so
      // still attempt that half rather than giving up entirely.
      hostingProvider = await detectHostProvider(hostname, {});
      if (!hostingProvider.value) hostingProvider = { value: '', confident: false, note };
    }

    return res.status(200).json({ hostname, registrar, platform, hostingProvider });
  } catch (err) {
    await logError({ endpoint: 'hosting-lookup', error: err, session, extra: { url } });
    return res.status(500).json({ error: err.message || 'Hosting lookup failed' });
  }
}
