// Sends an "assigned work" notification email via Resend (https://resend.com).
// Requires RESEND_API_KEY (and optionally RESEND_FROM_EMAIL) set as Vercel env vars.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'RESEND_API_KEY is not configured on the server.' });
  }

  const { to, name, title, body, link } = req.body || {};
  if (!to || typeof to !== 'string' || !to.includes('@')) {
    return res.status(400).json({ error: 'A valid "to" email address is required' });
  }
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: '"title" is required' });
  }

  const from = process.env.RESEND_FROM_EMAIL || 'WebLight Ops Hub <onboarding@resend.dev>';
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const safeBody = body ? String(body) : '';
  const safeLink = link || 'https://wlm-ops-hub.vercel.app/user';

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:0 auto;padding:28px 24px;color:#1a1a1a;border:1px solid #eee;border-radius:12px;">
    <div style="font-size:13px;font-weight:800;letter-spacing:.08em;color:#2D6BB6;text-transform:uppercase;margin-bottom:18px;">WebLight Ops Hub</div>
    <p style="margin:0 0 6px;font-size:14px;color:#444;">${greeting}</p>
    <p style="margin:0 0 14px;font-size:17px;font-weight:800;color:#1a1a1a;">${title}</p>
    ${safeBody ? `<p style="margin:0 0 20px;font-size:14px;color:#555;line-height:1.5;">${safeBody}</p>` : ''}
    <a href="${safeLink}" style="display:inline-block;padding:11px 22px;background:#2D6BB6;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;">Open Ops Hub</a>
    <p style="margin-top:28px;font-size:11px;color:#aaa;">You're receiving this because you have new work assigned in the WebLight Media Ops Hub.</p>
  </div>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject: title, html }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.message || 'Resend API error' });
    }
    return res.status(200).json({ ok: true, id: data?.id });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to send email' });
  }
}
