/**
 * Paperhaus mail API: connect a Gmail account and send from it. Behind the Paperhaus
 * sign-in (Cloudflare Access), so every request carries the signed-in person's email.
 *
 *   GET  /api/mail/status          { configured, connected, gmail, name }
 *   GET  /api/mail/connect         starts Google sign-in (opened in a popup)
 *   GET  /api/mail/callback        Google sends the person back here
 *   POST /api/mail/disconnect      forget the connection and revoke it at Google
 *   POST /api/mail/send            { to, subject, text, esign?: { id, t, index } }
 *   POST /api/mail/esign           { id, t, title, senderName, notify, signers: [{ name, email }] }
 *
 * /api/mail/esign records what Paperhaus needs to email people about a signing request
 * later (functions/api/esign/ sends "signed", "your turn" and "everyone signed" notes).
 * See functions/_shared/gmail.js for how tokens are kept.
 */
import {
  GMAIL_SCOPE,
  deleteAccount,
  googleUrls,
  getAccount,
  getRequestMail,
  isEmail,
  mailConfigured,
  randomHex,
  saveAccount,
  saveRequestMail,
  sendMail,
  sha256hex,
} from '../../_shared/gmail.js';

export async function onRequest(context) {
  const { request, env, params } = context;
  const parts = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const action = parts[0] || '';
  const user = request.headers.get('cf-access-authenticated-user-email');
  if (!user) return json({ error: 'sign_in_required' }, 401);
  if (!mailConfigured(env)) {
    return action === 'status' ? json({ configured: false, connected: false }) : json({ error: 'mail_not_configured' }, 503);
  }
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/mail/callback`;
  try {
    if (request.method === 'GET' && action === 'status') {
      const acct = await getAccount(env, user);
      return json({ configured: true, connected: !!acct, gmail: acct ? acct.gmail : null, name: acct ? acct.name : null });
    }
    if (request.method === 'GET' && action === 'connect') {
      const state = randomHex(16);
      await env.ESIGN.put(`gs:${state}`, JSON.stringify({ user }), { expirationTtl: 600 });
      const hint = url.searchParams.get('hint');
      const q = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: `openid email profile ${GMAIL_SCOPE}`,
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
      });
      if (hint && isEmail(hint)) q.set('login_hint', hint);
      return Response.redirect(`${googleUrls(env).auth}?${q}`, 302);
    }
    if (request.method === 'GET' && action === 'callback') return await callback(env, url, user, redirectUri);
    if (request.method === 'POST' && action === 'disconnect') {
      const acct = await getAccount(env, user);
      if (acct && acct.refresh) {
        await fetch(`${googleUrls(env).revoke}?token=${encodeURIComponent(acct.refresh)}`, { method: 'POST' }).catch(() => undefined);
      }
      await deleteAccount(env, user);
      return json({ ok: true });
    }
    if (request.method === 'POST' && action === 'send') return await send(request, env, user);
    if (request.method === 'POST' && action === 'esign') return await esignSetup(request, env, user);
    return json({ error: 'not_found' }, 404);
  } catch (err) {
    return json({ error: err.code || 'server_error', detail: err.detail || String(err.message || err) }, err.code === 'gmail_not_connected' ? 409 : 500);
  }
}

async function callback(env, url, user, redirectUri) {
  const state = url.searchParams.get('state') || '';
  const saved = state && (await env.ESIGN.get(`gs:${state}`, 'json'));
  if (state) await env.ESIGN.delete(`gs:${state}`);
  if (!saved || saved.user !== user) return page('This sign-in link expired. Close this window and press Connect Gmail again.', false);
  if (url.searchParams.get('error')) return page('Gmail was not connected. You can close this window.', false);
  const r = await fetch(googleUrls(env).token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code') || '',
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.refresh_token) return page('Google did not allow sending. Close this window and try again.', false);
  if (!String(data.scope || '').split(' ').includes(GMAIL_SCOPE)) {
    return page('Paperhaus needs permission to send email. Try again and tick "Send email on your behalf".', false);
  }
  // The id_token came straight from Google over TLS, so its claims can be read as is.
  let claims = {};
  try {
    claims = JSON.parse(atob(String(data.id_token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    claims = {};
  }
  if (!isEmail(claims.email)) return page('Could not read which Gmail account this is. Try again.', false);
  await saveAccount(env, user, { refresh: data.refresh_token, gmail: claims.email, name: claims.name || '', at: Date.now() });
  return page(`Connected ${claims.email}. You can close this window.`, true, claims.email);
}

function page(message, ok, gmail) {
  const payload = JSON.stringify({ paperhausGmail: ok ? 'connected' : 'failed', gmail: gmail || null });
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Paperhaus</title>
<body style="font-family:system-ui,sans-serif;padding:2rem;background:#fbf1e4;color:#3a2a1f"><p>${message.replace(/</g, '&lt;')}</p>
<script>try{window.opener&&window.opener.postMessage(${payload},location.origin)}catch(e){}${ok ? 'setTimeout(function(){window.close()},800)' : ''}</script>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

async function send(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const subject = String(body.subject || '').slice(0, 300);
  const text = String(body.text || '');
  if (!subject || !text) return json({ error: 'bad_message' }, 400);
  let rec = null;
  let id = '';
  let index = -1;
  if (body.esign) {
    ({ id, index } = body.esign);
    rec = await ownedRequest(env, user, id, body.esign.t);
    if (!rec) return json({ error: 'forbidden' }, 403);
    if (!(Number.isInteger(index) && index >= 0 && index < rec.mail.signers.length)) return json({ error: 'bad_index' }, 400);
  }
  const out = await sendMail(env, user, { to: body.to, subject, text, fromName: body.fromName });
  if (rec) {
    rec.mail.signers[index] = { ...rec.mail.signers[index], threadId: out.threadId, messageId: out.messageId, sentAt: Date.now() };
    await saveRequestMail(env, id, rec.mail, Math.floor((rec.meta.retainUntil || rec.meta.expires) / 1000));
  }
  return json({ ok: true, threadId: out.threadId, sentAt: Date.now() });
}

async function esignSetup(request, env, user) {
  const b = await request.json().catch(() => ({}));
  const meta = b.id && (await env.ESIGN.get(`m:${b.id}`, 'json'));
  if (!meta || meta.sender !== user || meta.senderToken !== (await sha256hex(String(b.t || '')))) return json({ error: 'forbidden' }, 403);
  const signers = Array.isArray(b.signers) ? b.signers.slice(0, meta.n) : [];
  if (signers.length !== meta.n || !signers.every((s) => isEmail(s.email))) return json({ error: 'bad_signers' }, 400);
  const acct = await getAccount(env, user);
  const rec = {
    title: String(b.title || 'your document').slice(0, 200),
    senderName: String(b.senderName || '').slice(0, 100),
    notify: b.notify !== false,
    notifyTo: user,
    gmail: acct ? acct.gmail : null,
    ordered: !!meta.ordered,
    signers: signers.map((s) => ({ name: String(s.name || '').slice(0, 100), email: s.email, me: !!s.me })),
  };
  await saveRequestMail(env, b.id, rec, Math.floor((meta.retainUntil || meta.expires) / 1000));
  return json({ ok: true });
}

/** The signing request, if this signed-in person sent it and holds its sender token. */
async function ownedRequest(env, user, id, t) {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(id || ''))) return null;
  const meta = await env.ESIGN.get(`m:${id}`, 'json');
  if (!meta || meta.sender !== user || meta.senderToken !== (await sha256hex(String(t || '')))) return null;
  const mail = await getRequestMail(env, id);
  return mail ? { meta, mail } : null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
