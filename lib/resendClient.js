// Shared Resend email sending + HTML template, used by both the on-demand
// assignment-email endpoint and the task-edit notification flusher.

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function buildEmailHtml({ name, title, body, link }) {
  const greeting = name ? `Hi ${escHtml(name)},` : 'Hi,';
  const safeBody = body ? escHtml(body) : '';
  const safeTitle = escHtml(title);
  // escHtml here (not URL-encoding) because this value lands inside an HTML
  // attribute (href="..."), so the injection risk is breaking out of the
  // quoted attribute with a literal " or < — not a URL-syntax concern.
  const safeLink = escHtml(link || process.env.APP_URL || 'https://opshub.weblightmedia.com/user');
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:0 auto;padding:28px 24px;color:#1a1a1a;border:1px solid #eee;border-radius:12px;">
    <div style="font-size:13px;font-weight:800;letter-spacing:.08em;color:#2D6BB6;text-transform:uppercase;margin-bottom:18px;">WebLight Ops Hub</div>
    <p style="margin:0 0 6px;font-size:14px;color:#444;">${greeting}</p>
    <p style="margin:0 0 14px;font-size:17px;font-weight:800;color:#1a1a1a;">${safeTitle}</p>
    ${safeBody ? `<div style="margin:0 0 20px;font-size:14px;color:#555;line-height:1.6;">${safeBody}</div>` : ''}
    <a href="${safeLink}" style="display:inline-block;padding:11px 22px;background:#2D6BB6;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;">Open Ops Hub</a>
    <p style="margin-top:28px;font-size:11px;color:#aaa;">You're receiving this because you have work assigned in the WebLight Media Ops Hub.</p>
  </div>`;
}

export async function sendResendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured on the server.');
  const from = process.env.RESEND_FROM_EMAIL || 'WebLight Ops Hub <onboarding@resend.dev>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.message || `Resend API error (${r.status})`);
  return data;
}
