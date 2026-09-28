// Shared Resend email sending + HTML template, used by both the on-demand
// assignment-email endpoint and the task-edit notification flusher.

// David email overhaul (2026-09-25) — David was getting every routine
// notification/reminder email this codebase sends (assignment, overdue/
// escalation, nags, daily digest, team-summaries, review routing,
// workAnniversary, etc.). He only actually needs three things by email
// going forward: a time-off SUBMISSION notification (he's an approver —
// type 'timeOffSubmitted', never the decision-side 'timeOff' type), the
// weekly team-completion report, and the bi-monthly PTO report (see
// api/cron-weekly-team-completion.js and api/cron-pto-report.js).
// Email-only — never touches an in-app ops_notifications row.
//
// Centralized HERE (2026-09-28, moved from api/ops-sync.js), inside
// sendResendEmail() itself — the ONE low-level function every single
// Resend-sending code path in this codebase already goes through — after
// a real gap was found: api/cron-backup.js's off-site backup email sent
// directly via sendResendEmail() to every super/owner admin, David
// included, completely bypassing the check that only lived in
// insertNotifications()/api/send-assignment-email.js at the time. Living
// here instead means a FUTURE direct-send call site can't leak to David
// either, by construction — passing no `type` (and no
// `bypassDavidSuppression`) is the safe DEFAULT, not an opt-in a new
// caller could forget. api/ops-sync.js re-exports both names unchanged so
// its own existing importers (api/send-assignment-email.js,
// api/cron-weekly-team-completion.js, api/cron-pto-report.js) needed no
// import-path change.
export const DAVID_EMAIL = 'david@weblightmedia.com';
const DAVID_EMAIL_ALLOWED_TYPES = new Set(['timeOffSubmitted', 'weeklyTeamCompletion', 'biMonthlyPtoReport']);
export function isEmailSuppressedForDavid(toEmail, type) {
  return String(toEmail || '').toLowerCase() === DAVID_EMAIL && !DAVID_EMAIL_ALLOWED_TYPES.has(type);
}

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
    ${safeBody ? `<div style="margin:0 0 20px;font-size:14px;color:#555;line-height:1.6;white-space:pre-wrap;">${safeBody}</div>` : ''}
    <a href="${safeLink}" style="display:inline-block;padding:11px 22px;background:#2D6BB6;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;">Open Ops Hub</a>
    <p style="margin-top:28px;font-size:11px;color:#aaa;">You're receiving this because you have work assigned in the WebLight Media Ops Hub.</p>
  </div>`;
}

// attachments (2026-09-13, off-site backup email) — optional, additive only.
// Resend's real API field is `attachments: [{filename, content, type}]`,
// content a base64 string, type a MIME type — passed straight through
// unchanged when the caller provides it; omitted from the outgoing body
// entirely when it isn't, so every pre-existing caller (task/service/
// time-off/message notifications via insertNotifications(), the daily
// digests, inbound-email confirmation replies, send-assignment-email.js)
// sends the exact same request body as before this was added.

// Bounded retry-with-backoff on a 429 (2026-09-20) — added HERE, at the one
// shared low-level function every Resend-sending code path in this codebase
// already goes through, rather than in any single caller, so a burst
// hitting Resend's per-second rate limit is retried the same way regardless
// of which feature triggered it (assignment emails, the batched
// notification pipeline, daily digests, inbound-email confirmations, the
// off-site backup copy). A burst of assignment emails firing near-
// simultaneously (api/send-assignment-email.js, one request per recipient,
// with no cross-request coordination between concurrent serverless
// invocations) is the trigger that actually hit this in production — see
// that endpoint's own comment for the real, identified source
// (index.html's _checkServiceAlerts() looping over every assigned user +
// their manager for every newly-due service in one pass, each firing its
// own independent fetch()).
//
// Only ever retries a 429 specifically — any other failure (a genuinely
// invalid request, an auth error, a 5xx) still fails on the first attempt,
// exactly as before this change, since retrying those would just waste
// time without ever succeeding. Honors Resend's own `Retry-After` response
// header when present (the authoritative signal for how long to actually
// wait); falls back to a fixed exponential schedule (500ms, 1.5s, 3s) when
// it's absent — this codebase has no live access to Resend's dashboard to
// confirm the exact documented per-second limit (CLAUDE.md rule #11), so
// this deliberately doesn't hardcode a specific rate to pace against;
// honoring the server's own Retry-After is the more robust signal
// regardless of what that limit actually is. Capped at 3 attempts total
// (1 initial + 2 retries) and a combined worst-case wait well under a
// typical serverless function's execution timeout.
const RESEND_MAX_ATTEMPTS = 3;
const RESEND_RETRY_BACKOFF_MS = [500, 1500, 3000];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function retryDelayMs(response, attemptIndex) {
  const retryAfterHeader = response?.headers?.get?.('retry-after');
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) return retryAfterSeconds * 1000;
  return RESEND_RETRY_BACKOFF_MS[attemptIndex] ?? RESEND_RETRY_BACKOFF_MS[RESEND_RETRY_BACKOFF_MS.length - 1];
}

// `type` — the notification/email "kind" (e.g. 'timeOffSubmitted',
// 'backup', 'assignment') — is what isEmailSuppressedForDavid() above
// checks against his 3-item allowlist; a caller with no real "type"
// concept (nothing here previously had one) should still pass a short,
// descriptive string for exactly this reason, not omit it, since omitting
// it is indistinguishable from "an unnamed/unknown type" and gets suppressed
// for David the same as any other non-allowlisted type — the safe
// default. `bypassDavidSuppression` is the explicit, reviewed escape
// hatch for the two classes of call that must NOT be suppressed even
// though they don't carry one of the 3 allowlisted types: (1) a caller
// that already ran this exact check itself upstream (insertNotifications()'s
// own per-row filter before ever batching into a single send;
// api/send-assignment-email.js's own recipientId-scoped pre-check) — this
// avoids a mismatched second check seeing a combined-batch email with no
// single `type` of its own and wrongly re-suppressing something the
// caller already vetted; (2) a genuinely deliberate exception —
// api/inbound-email.js's confirmation reply, a direct reply to whatever
// David HIMSELF just emailed in, not a passive notification reaching him.
export async function sendResendEmail({ to, subject, html, attachments, type, bypassDavidSuppression }) {
  if (!bypassDavidSuppression && isEmailSuppressedForDavid(to, type)) return { suppressed: true };
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured on the server.');
  const from = process.env.RESEND_FROM_EMAIL || 'WebLight Ops Hub <onboarding@resend.dev>';
  const replyTo = process.env.RESEND_REPLY_TO || 'ssamy@weblightmedia.com';
  const body = { from, to: [to], reply_to: replyTo, subject, html };
  if (attachments && attachments.length) body.attachments = attachments;

  let lastData, lastStatus;
  for (let attempt = 0; attempt < RESEND_MAX_ATTEMPTS; attempt++) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) return await r.json().catch(() => ({}));

    lastStatus = r.status;
    lastData = await r.json().catch(() => ({}));
    // Only a 429 (rate limit) is ever worth retrying — anything else is a
    // real failure that retrying can't fix, so it fails immediately on the
    // first attempt, same as before this change.
    if (r.status !== 429 || attempt === RESEND_MAX_ATTEMPTS - 1) break;
    await sleep(retryDelayMs(r, attempt));
  }
  throw new Error(lastData?.message || `Resend API error (${lastStatus})`);
}
