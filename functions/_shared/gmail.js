/**
 * Paperhaus mail: send email from each person's own Gmail (Gmail API, gmail.send scope).
 *
 * Someone signed in to Paperhaus connects their Gmail once (Google sign-in in a popup).
 * Google gives back a refresh token, which is kept in the ESIGN KV namespace encrypted
 * with a key derived from GOOGLE_CLIENT_SECRET, so the KV data alone cannot be used.
 * Paperhaus can then send signing invites, "your turn" notes and notifications as that
 * person, from their own address, without them pressing Send in Gmail.
 *
 * Needs two Pages variables: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (DEPLOY.md, step
 * 3c). Without them, mailConfigured() is false and Paperhaus falls back to opening a
 * Gmail draft, as before. The gmail.send scope can only send; it cannot read mail.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

// Google's endpoints. MAIL_TEST_BASE (local testing only) points them at a stand-in.
export function googleUrls(env) {
  const t = env && env.MAIL_TEST_BASE;
  return {
    auth: t ? `${t}/auth` : 'https://accounts.google.com/o/oauth2/v2/auth',
    token: t ? `${t}/token` : 'https://oauth2.googleapis.com/token',
    revoke: t ? `${t}/revoke` : 'https://oauth2.googleapis.com/revoke',
    send: t ? `${t}/send` : 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
  };
}

export function mailConfigured(env) {
  return !!(env && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.ESIGN);
}

// ---------------------------------------------------------------- small helpers

export function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const b64url = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function sha256hex(s) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function randomHex(n) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/.test(s);
const oneLine = (s, max = 300) => String(s || '').replace(/[\r\n]+/g, ' ').slice(0, max);

// ---------------------------------------------------------------- encryption at rest

let keyCache = null;
async function mailKey(env) {
  if (keyCache && keyCache.secret === env.GOOGLE_CLIENT_SECRET) return keyCache.key;
  const base = await crypto.subtle.importKey('raw', enc.encode(env.GOOGLE_CLIENT_SECRET), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('paperhaus-mail-v1'), info: enc.encode('kv') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  keyCache = { secret: env.GOOGLE_CLIENT_SECRET, key };
  return key;
}

export async function lock(env, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await mailKey(env), enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}

export async function unlock(env, s) {
  if (!s) return null;
  try {
    const u = unb64(s);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, await mailKey(env), u.subarray(12));
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- connected accounts

const accountKey = async (email) => `g:${await sha256hex(String(email).toLowerCase())}`;

/** The Gmail account a Paperhaus user connected: { refresh, gmail, name, at } or null. */
export async function getAccount(env, email) {
  if (!email) return null;
  return unlock(env, await env.ESIGN.get(await accountKey(email)));
}

export async function saveAccount(env, email, acct) {
  await env.ESIGN.put(await accountKey(email), await lock(env, acct));
}

export async function deleteAccount(env, email) {
  const key = await accountKey(email);
  await env.ESIGN.delete(key);
  await env.ESIGN.delete(`gt:${key.slice(2)}`);
}

/** A short-lived Gmail access token for this user, refreshed when needed. */
async function accessToken(env, email) {
  const key = await accountKey(email);
  const cached = await unlock(env, await env.ESIGN.get(`gt:${key.slice(2)}`));
  if (cached && cached.exp > Date.now() + 60000) return cached;
  const acct = await getAccount(env, email);
  if (!acct || !acct.refresh) throw mailError('gmail_not_connected');
  const r = await fetch(googleUrls(env).token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: acct.refresh,
      grant_type: 'refresh_token',
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    // Revoked or expired at Google's end: forget it, so Paperhaus asks to connect again.
    if (data.error === 'invalid_grant') await deleteAccount(env, email);
    throw mailError(data.error === 'invalid_grant' ? 'gmail_not_connected' : 'gmail_token_failed');
  }
  const tok = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000, gmail: acct.gmail, name: acct.name };
  await env.ESIGN.put(`gt:${key.slice(2)}`, await lock(env, tok), { expirationTtl: Math.max(120, (Number(data.expires_in) || 3600) - 120) });
  return tok;
}

function mailError(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

// ---------------------------------------------------------------- sending

function encodeHeader(s) {
  s = oneLine(s, 500);
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(enc.encode(s))}?=`;
}
function address(name, email) {
  const n = oneLine(name, 100).replace(/"/g, "'");
  return n ? `${encodeHeader(`"${n}"`)} <${email}>` : `<${email}>`;
}

/**
 * Send a plain-text email from this Paperhaus user's connected Gmail.
 * to: an address or a list. Returns { id, threadId, messageId }.
 */
export async function sendMail(env, userEmail, { to, subject, text, threadId, inReplyTo, fromName }) {
  const list = (Array.isArray(to) ? to : [to]).map((x) => String(x).trim()).filter(Boolean);
  if (!list.length || list.length > 20 || !list.every(isEmail)) throw mailError('bad_recipient');
  const tok = await accessToken(env, userEmail);
  const messageId = `<${randomHex(16)}@paperhaus.pages.dev>`;
  const body = b64(enc.encode(String(text || '').slice(0, 20000))).replace(/.{1,76}/g, '$&\r\n');
  const headers = [
    `From: ${address(fromName || tok.name, tok.gmail)}`,
    `To: ${list.join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: ${messageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${oneLine(inReplyTo, 200)}`, `References: ${oneLine(inReplyTo, 200)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  const raw = b64url(enc.encode(`${headers.join('\r\n')}\r\n\r\n${body}`));
  const r = await fetch(googleUrls(env).send, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = mailError(r.status === 401 || r.status === 403 ? 'gmail_not_allowed' : 'gmail_send_failed');
    e.detail = data.error && data.error.message;
    throw e;
  }
  return { id: data.id, threadId: data.threadId, messageId };
}

// ---------------------------------------------------------------- per-request mail record

/**
 * What Paperhaus needs to email people about one signing request later, when its sender
 * is not around: the title, names and emails, and each invite's thread. Encrypted.
 */
export async function getRequestMail(env, id) {
  return unlock(env, await env.ESIGN.get(`ml:${id}`));
}

export async function saveRequestMail(env, id, rec, expiration) {
  await env.ESIGN.put(`ml:${id}`, await lock(env, rec), expiration ? { expiration } : undefined);
}
