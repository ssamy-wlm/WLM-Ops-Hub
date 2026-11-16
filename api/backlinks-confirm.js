// Public, no-login confirmation page for the monthly backlinks-renewal
// reminder (api/cron-backlinks-reminder.js) — reached only by clicking one
// of the two buttons in that reminder's own email; never linked to from
// inside the app itself.
//
// Two-step by design (CLAUDE.md rule #7 — flagged, not guessed): a GET
// request that records the answer on load is exactly the shape an email
// client's own link-prescanning/security-scanning bot auto-fetches BEFORE
// a human ever opens the email — which would silently mark the month
// "renewed" or "not done" without David ever having clicked anything. So:
//   GET  ?token=...  -> renders a tiny confirmation page ONLY. No write.
//   POST {token}     -> the page's own <form> submit (a real user action a
//                       prescanning bot does not perform) — this is the
//                       only path that actually records the answer.
//
// Token: a signed, stateless HMAC token (lib/backlinksToken.js) carrying
// {purpose:'backlinksConfirm', month, answer}. No DB lookup is needed to
// validate it and it can't be forged or altered — same HMAC guarantee
// every signed-in session in this app already relies on, just a separate
// signer (see that file's own comment for why it's not reused here).
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { logError } from '../lib/errorLog.js';
import { verifyBacklinksToken } from '../lib/backlinksToken.js';

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(title, body) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;color:#1a1a1a;text-align:center;}
.btn{display:inline-block;margin-top:20px;padding:12px 28px;background:#2D6BB6;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;text-decoration:none;}
h1{font-size:19px;}
p{color:#555;font-size:14px;}
</style>
</head>
<body>${body}</body>
</html>`;
}

function answerLabel(answer) { return answer === 'renewed' ? 'renewed the backlinks' : 'NOT renewed the backlinks'; }

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const token = req.method === 'GET' ? req.query?.token : req.body?.token;
  let payload;
  try { payload = token ? verifyBacklinksToken(token) : null; }
  catch (err) { await logError({ endpoint: 'backlinks-confirm', error: err }); return res.status(500).send(page('Error', '<h1>Something went wrong. Please try again later.</h1>')); }

  if (!payload || payload.purpose !== 'backlinksConfirm' || !payload.month || (payload.answer !== 'renewed' && payload.answer !== 'not_yet')) {
    return res.status(400).send(page('Link expired', '<h1>This link is invalid or has expired.</h1><p>Ask for a fresh reminder email if you still need to confirm.</p>'));
  }
  const { month, answer } = payload;

  if (req.method === 'GET') {
    return res.status(200).send(page('Confirm backlinks renewal', `
      <h1>Confirm you ${escHtml(answerLabel(answer))} for ${escHtml(month)}?</h1>
      <form method="POST" action="/api/backlinks-confirm">
        <input type="hidden" name="token" value="${escHtml(token)}">
        <button type="submit" class="btn">Yes, confirm</button>
      </form>`));
  }

  if (req.method !== 'POST') return res.status(405).send(page('Method not allowed', '<h1>Method not allowed.</h1>'));

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (err) { await logError({ endpoint: 'backlinks-confirm', error: err }); return res.status(500).send(page('Error', '<h1>Something went wrong. Please try again later.</h1>')); }

  const settingsKey = `backlinksReminder:${month}`;
  try {
    const { data: row, error: readErr } = await supabase.from('ops_settings').select('data').eq('key', settingsKey).maybeSingle();
    if (readErr) throw new Error(readErr.message);
    const state = row?.data;
    if (!state || state.status !== 'pending') {
      return res.status(200).send(page('Already recorded', `<h1>${escHtml(month)} was already recorded${state ? ` as "${escHtml(state.status)}"` : ''}.</h1><p>No further action needed.</p>`));
    }
    const updated = { ...state, status: answer, respondedAt: new Date().toISOString(), via: 'email-link' };
    const { error: writeErr } = await supabase.from('ops_settings').upsert({ key: settingsKey, data: updated }, { onConflict: 'key' });
    if (writeErr) throw new Error(writeErr.message);
    return res.status(200).send(page('Recorded', `<h1>Thanks — recorded as "${escHtml(answerLabel(answer))}" for ${escHtml(month)}.</h1><p>No more reminders for this month.</p>`));
  } catch (err) {
    await logError({ endpoint: 'backlinks-confirm', error: err });
    return res.status(500).send(page('Error', '<h1>Something went wrong. Please try again later.</h1>'));
  }
}
