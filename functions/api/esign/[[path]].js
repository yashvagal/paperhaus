/**
 * Paperhaus e-sign API (Cloudflare Pages Function).
 *
 * Holds signing requests ("envelopes"). Signers have 14 days to sign; the signed record
 * is then kept as long as the sender chose (14 days, 1 year or 7 years), and Cloudflare
 * deletes it on its own after that. Everything it keeps about the document is encrypted in the sender's browser
 * first: the PDF, the field layout, names and email addresses. The key travels only in
 * the signing links, after the # in the address, which browsers never send to a server.
 * So this code stores and hands back encrypted bytes it cannot read, plus the times, IP
 * addresses and browsers of each view and signature for the audit certificate.
 *
 * Storage: one KV namespace bound as ESIGN (Pages project, Settings, Bindings).
 *
 * Every step (created, opened, signed, declined, completed, sealed) is written to an audit
 * trail where each entry carries the SHA-256 of the one before it, so an entry cannot be
 * changed or removed without breaking the chain. When everyone has signed, the finished
 * PDF is sealed with the Paperhaus certificate and an independent timestamp (see
 * functions/_shared/seal.js); only a hash of the PDF is sent for that. The sealed copy is
 * stored encrypted, with its SHA-256 fingerprint in the clear so any copy can be checked.
 *
 * Routes
 *   POST /api/esign/new                 create (Paperhaus sign-in required, by Cloudflare Access)
 *   GET  /api/esign/p/:id?t=            state + encrypted envelope (any party)
 *   GET  /api/esign/p/:id/doc?t=        encrypted PDF
 *   GET  /api/esign/p/:id/subs?t=       encrypted signatures submitted so far
 *   POST /api/esign/p/:id/view?t=       record that a signer opened it
 *   POST /api/esign/p/:id/sign?t=       a signer submits (body: encrypted values)
 *   POST /api/esign/p/:id/decline?t=    a signer declines (body: encrypted reason, optional)
 *   POST /api/esign/p/:id/cancel?t=     the sender cancels and deletes it
 *   POST /api/esign/p/:id/seal?t=       seal a finished PDF (body: JSON { digest: hex })
 *   POST /api/esign/p/:id/final?t=      store the sealed copy (body: encrypted PDF, x-fingerprint header)
 *   GET  /api/esign/p/:id/final?t=      the sealed copy (encrypted)
 *
 * The /p/ routes are public (Access bypass) and need a token from a signing link: each
 * signer has their own, the sender has one, and a read-only one opens the finished copy.
 * Only SHA-256 hashes of the tokens are stored.
 */

import { sealDigest, b64 as b64u8 } from '../../_shared/seal.js';
import { getRequestMail, mailConfigured, sendMail } from '../../_shared/gmail.js';

const DAYS = 14; // time to sign
const KEEP = [14, 365, 2555]; // how long the signed record is kept: 14 days, 1 year, 7 years
const MAX_SIGNERS = 10;
const MAX_DOC = 20 * 1024 * 1024; // KV values max out at 25 MiB
const MAX_FINAL = 24 * 1024 * 1024;
const MAX_SMALL = 2 * 1024 * 1024; // envelope, each signature submission
const MAX_SEALS = 3; // seal calls per request (one is normal; retries after a failed upload)

export async function onRequest(context) {
  const { request, env, params } = context;
  try {
    if (!env.ESIGN) return json({ error: 'E-sign storage is not set up yet (KV binding ESIGN).' }, 503);
    const parts = [].concat(params.path || []);
    const method = request.method;

    if (parts[0] === 'new' && parts.length === 1 && method === 'POST') return await create(request, env);
    if (parts[0] === 'p' && parts[1] && isId(parts[1])) {
      const id = parts[1];
      const action = parts[2] || '';
      const url = new URL(request.url);
      const token = url.searchParams.get('t') || '';
      const meta = await env.ESIGN.get(`m:${id}`, 'json');
      if (!meta) return json({ error: 'not_found' }, 404);
      const who = await role(meta, token);
      if (!who) return json({ error: 'forbidden' }, 403);

      if (method === 'GET' && action === '') return json(await state(env, id, meta, who, true));
      if (method === 'GET' && action === 'doc') return bytes(await env.ESIGN.get(`d:${id}`, 'arrayBuffer'));
      if (method === 'GET' && action === 'subs') return json(await subs(env, id, meta));
      if (method === 'POST' && action === 'view') return await view(request, env, id, meta, who);
      if (method === 'POST' && (action === 'sign' || action === 'decline')) {
        const res = action === 'sign' ? await sign(request, env, id, meta, who) : await decline(request, env, id, meta, who);
        // Emails about it (from the sender's Gmail, when connected) go out after the reply.
        if (res.ok && mailConfigured(env)) context.waitUntil(notify(env, id, action, who.index, res.clone(), url.origin));
        return res;
      }
      if (method === 'POST' && action === 'cancel') return await cancel(env, id, meta, who);
      if (method === 'POST' && action === 'seal') return await seal(request, env, id, meta);
      if (method === 'POST' && action === 'final') return await storeFinal(request, env, id, meta, who);
      if (method === 'GET' && action === 'final') return bytes(await env.ESIGN.get(`f:${id}`, 'arrayBuffer'));
    }
    return json({ error: 'not_found' }, 404);
  } catch (err) {
    return json({ error: 'server_error', detail: String((err && err.message) || err) }, 500);
  }
}

// ---------------------------------------------------------------- routes

async function create(request, env) {
  // Cloudflare Access adds this header only for signed-in Paperhaus users.
  const sender = request.headers.get('cf-access-authenticated-user-email');
  if (!sender) return json({ error: 'sign_in_required' }, 401);

  const form = await request.formData();
  const info = JSON.parse(String(form.get('meta') || '{}'));
  const doc = form.get('doc');
  const envelope = form.get('env');
  const n = Number(info.signers);
  if (!(n >= 1 && n <= MAX_SIGNERS)) return json({ error: 'bad_signers' }, 400);
  if (!Array.isArray(info.tokens) || info.tokens.length !== n || !info.tokens.every(isHash)) return json({ error: 'bad_tokens' }, 400);
  if (!isHash(info.senderToken) || !isHash(info.readToken)) return json({ error: 'bad_tokens' }, 400);
  if (!doc || typeof doc === 'string' || doc.size > MAX_DOC) return json({ error: 'bad_doc', limit: MAX_DOC }, 400);
  if (!envelope || typeof envelope === 'string' || envelope.size > MAX_SMALL) return json({ error: 'bad_envelope' }, 400);

  const id = randomId();
  const created = Date.now();
  const keep = KEEP.includes(Number(info.keepDays)) ? Number(info.keepDays) : KEEP[0];
  const expiration = Math.floor(created / 1000) + Math.max(DAYS, keep) * 86400;
  const meta = {
    v: 2,
    n,
    ordered: !!info.ordered,
    tokens: info.tokens,
    senderToken: info.senderToken,
    readToken: info.readToken,
    sender,
    created,
    expires: created + DAYS * 86400000,
    keep,
    retainUntil: expiration * 1000,
    status: 'out',
  };
  await env.ESIGN.put(`d:${id}`, await doc.arrayBuffer(), { expiration });
  await env.ESIGN.put(`e:${id}`, await envelope.arrayBuffer(), { expiration });
  await env.ESIGN.put(`m:${id}`, JSON.stringify(meta), { expiration });
  await logEvent(env, id, meta, request, 'created', 'sender', { docSha256: /^[0-9a-f]{64}$/.test(info.docSha256 || '') ? info.docSha256 : undefined });
  return json({ id, expires: meta.expires, retainUntil: meta.retainUntil });
}

async function state(env, id, meta, who, withEnvelope) {
  const signers = [];
  for (let i = 0; i < meta.n; i++) {
    const [s, v] = await Promise.all([
      env.ESIGN.getWithMetadata(`s:${id}:${i}`, 'stream'),
      env.ESIGN.getWithMetadata(`v:${id}:${i}`, 'text'),
    ]);
    if (s.value) s.value.cancel();
    signers.push({
      viewed: v.metadata || null,
      signed: s.value !== null ? s.metadata || {} : null,
    });
  }
  const done = signers.every((s) => s.signed);
  const expired = meta.status === 'out' && !done && Date.now() > meta.expires;
  const out = {
    id,
    role: who.role,
    index: who.index,
    n: meta.n,
    ordered: meta.ordered,
    sender: meta.sender,
    created: meta.created,
    expires: meta.expires,
    status: meta.status === 'out' && done ? 'complete' : expired ? 'expired' : meta.status,
    declined: meta.declined || null,
    signers,
    keep: meta.keep || DAYS,
    retainUntil: retainUntil(meta),
    sealed: meta.fp ? { fingerprint: meta.fp, at: meta.sealedAt, timestamp: meta.timestamp || null, cert: meta.sealCert || null } : null,
    events: (await env.ESIGN.get(`a:${id}`, 'json')) || [],
  };
  if (withEnvelope) out.envelope = b64(await env.ESIGN.get(`e:${id}`, 'arrayBuffer'));
  return out;
}

async function subs(env, id, meta) {
  const list = [];
  for (let i = 0; i < meta.n; i++) {
    const s = await env.ESIGN.get(`s:${id}:${i}`, 'arrayBuffer');
    if (s) list.push({ index: i, data: b64(s) });
  }
  return list;
}

async function view(request, env, id, meta, who) {
  if (who.role !== 'signer') return new Response(null, { status: 204 });
  const key = `v:${id}:${who.index}`;
  const seen = await env.ESIGN.getWithMetadata(key, 'text');
  if (seen.value === null) {
    await env.ESIGN.put(key, '1', { expiration: exp(meta), metadata: stamp(request) });
    await logEvent(env, id, meta, request, 'viewed', who.index);
  }
  return new Response(null, { status: 204 });
}

async function sign(request, env, id, meta, who) {
  if (who.role !== 'signer') return json({ error: 'not_a_signer' }, 403);
  if (meta.status !== 'out') return json({ error: meta.status }, 409);
  if (Date.now() > meta.expires) return json({ error: 'expired' }, 409);
  const key = `s:${id}:${who.index}`;
  if ((await env.ESIGN.get(key, 'stream')) !== null) return json({ error: 'already_signed' }, 409);
  if (meta.ordered) {
    for (let j = 0; j < who.index; j++) {
      const s = await env.ESIGN.get(`s:${id}:${j}`, 'stream');
      if (s === null) return json({ error: 'not_your_turn', waitingFor: j }, 409);
      s.cancel();
    }
  }
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_SMALL) return json({ error: 'bad_body' }, 400);
  await env.ESIGN.put(key, body, { expiration: exp(meta), metadata: stamp(request) });
  // Count it as viewed too, in case the view call never arrived.
  const vkey = `v:${id}:${who.index}`;
  if ((await env.ESIGN.get(vkey, 'text')) === null) {
    await env.ESIGN.put(vkey, '1', { expiration: exp(meta), metadata: stamp(request) });
    await logEvent(env, id, meta, request, 'viewed', who.index);
  }
  await logEvent(env, id, meta, request, 'signed', who.index, { consent: true });
  const out = await state(env, id, meta, who, false);
  if (out.status === 'complete') {
    await logEvent(env, id, meta, request, 'completed', 'paperhaus');
    out.events = (await env.ESIGN.get(`a:${id}`, 'json')) || out.events;
  }
  return json(out);
}

async function decline(request, env, id, meta, who) {
  if (who.role !== 'signer') return json({ error: 'not_a_signer' }, 403);
  if (meta.status !== 'out') return json({ error: meta.status }, 409);
  const body = await request.arrayBuffer();
  meta.status = 'declined';
  meta.declined = { index: who.index, ...stamp(request), reason: body.byteLength && body.byteLength < 20000 ? b64(body) : null };
  await env.ESIGN.put(`m:${id}`, JSON.stringify(meta), { expiration: exp(meta) });
  await logEvent(env, id, meta, request, 'declined', who.index);
  return json(await state(env, id, meta, who, false));
}

async function cancel(env, id, meta, who) {
  if (who.role !== 'sender') return json({ error: 'not_the_sender' }, 403);
  const keys = [`m:${id}`, `d:${id}`, `e:${id}`, `a:${id}`, `f:${id}`, `ml:${id}`];
  for (let i = 0; i < meta.n; i++) keys.push(`s:${id}:${i}`, `v:${id}:${i}`);
  await Promise.all(keys.map((k) => env.ESIGN.delete(k)));
  return json({ ok: true });
}

async function seal(request, env, id, meta) {
  const done = await allSigned(env, id, meta);
  if (meta.status !== 'out' || !done) return json({ error: 'not_complete' }, 409);
  if (meta.fp) return json({ error: 'sealed' }, 409);
  if ((meta.seals || 0) >= MAX_SEALS) return json({ error: 'too_many_seals' }, 429);
  let digest;
  try {
    const body = await request.json();
    if (!/^[0-9a-f]{64}$/.test(body.digest || '')) throw new Error('bad');
    digest = new Uint8Array(body.digest.match(/../g).map((h) => parseInt(h, 16)));
  } catch {
    return json({ error: 'bad_digest' }, 400);
  }
  meta.seals = (meta.seals || 0) + 1;
  await env.ESIGN.put(`m:${id}`, JSON.stringify(meta), { expiration: exp(meta) });
  const out = await sealDigest(digest, env);
  return json({ cms: b64u8(out.cms), signedAt: out.signedAt, timestamp: out.timestamp, cert: out.cert });
}

async function storeFinal(request, env, id, meta, who) {
  if (!(await allSigned(env, id, meta)) || meta.status !== 'out') return json({ error: 'not_complete' }, 409);
  if (meta.fp) return json({ error: 'sealed', fingerprint: meta.fp }, 409);
  const fp = (request.headers.get('x-fingerprint') || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fp)) return json({ error: 'bad_fingerprint' }, 400);
  let info = {};
  try {
    info = JSON.parse(request.headers.get('x-seal') || '{}');
  } catch {
    info = {};
  }
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_FINAL) return json({ error: 'bad_body', limit: MAX_FINAL }, 400);
  await env.ESIGN.put(`f:${id}`, body, { expiration: exp(meta) });
  meta.fp = fp;
  meta.sealedAt = Date.now();
  meta.sealCert = /^[0-9a-f]{64}$/.test(info.cert || '') ? info.cert : null;
  meta.timestamp = info.timestamp && typeof info.timestamp.by === 'string'
    ? { by: info.timestamp.by.slice(0, 40), at: Number(info.timestamp.at) || null }
    : null;
  await env.ESIGN.put(`m:${id}`, JSON.stringify(meta), { expiration: exp(meta) });
  await logEvent(env, id, meta, request, 'sealed', who.role === 'signer' ? who.index : who.role, {
    fingerprint: fp,
    timestamp: meta.timestamp ? meta.timestamp.by : 'none',
  });
  return json(await state(env, id, meta, who, false));
}

async function allSigned(env, id, meta) {
  for (let i = 0; i < meta.n; i++) {
    const s = await env.ESIGN.get(`s:${id}:${i}`, 'stream');
    if (s === null) return false;
    s.cancel();
  }
  return true;
}

/**
 * Append to the audit trail. Each entry holds the hash of the previous one (prev) and its
 * own hash (h) over everything else in it, so the chain can be checked by anyone holding
 * it. Names stay out: signers are numbered, their names live in the encrypted envelope.
 */
async function logEvent(env, id, meta, request, ev, by, extra = {}) {
  const list = (await env.ESIGN.get(`a:${id}`, 'json')) || [];
  const cf = request.cf || {};
  const entry = {
    n: list.length + 1,
    t: Date.now(),
    ev,
    by,
    ip: request.headers.get('cf-connecting-ip') || '',
    ua: (request.headers.get('user-agent') || '').slice(0, 300),
    geo: [cf.city, cf.regionCode || cf.region, cf.country].filter(Boolean).join(', '),
    ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)),
    prev: list.length ? list[list.length - 1].h : '0'.repeat(64),
  };
  entry.h = await sha256hex(JSON.stringify(entry));
  list.push(entry);
  await env.ESIGN.put(`a:${id}`, JSON.stringify(list), { expiration: exp(meta) });
}

/** When Cloudflare deletes the stored request (seconds, for KV). */
function exp(meta) {
  return Math.floor(retainUntil(meta) / 1000);
}
function retainUntil(meta) {
  return meta.retainUntil || meta.expires;
}

// ---------------------------------------------------------------- emails about a request

/**
 * After someone signs or declines: tell the sender, tell the next signer it is their turn
 * (in order), and tell everyone when all have signed. Sent from the sender's own Gmail,
 * only when they connected it and sent the invites through Paperhaus. Never blocks or
 * breaks signing: any failure is only logged.
 */
async function notify(env, id, action, index, res, origin) {
  try {
    const rec = await getRequestMail(env, id);
    if (!rec) return;
    const meta = await env.ESIGN.get(`m:${id}`, 'json');
    if (!meta) return;
    const st = await res.json();
    const signers = rec.signers;
    const who = signers[index] || { name: `Signer ${index + 1}` };
    const name = who.name || `Signer ${index + 1}`;
    const first = (n) => String(n || '').split(/\s+/)[0] || 'there';
    const title = rec.title;
    const from = rec.senderName;
    const manage = `${origin}/request-signatures.html`;
    const signedCount = (st.signers || []).filter((x) => x.signed).length;
    const jobs = [];
    const toOwner = (subject, text) => {
      if (rec.notify && rec.notifyTo) jobs.push(sendMail(env, meta.sender, { to: rec.notifyTo, subject, text: `${text}\n\nSee every request: ${manage}\n\nPaperhaus`, fromName: 'Paperhaus', from: rec.gmail }));
    };
    const toSigner = (s, text) => {
      if (!s || s.me || !s.email) return;
      jobs.push(
        sendMail(env, meta.sender, {
          to: s.email,
          subject: `Re: Please sign: ${title}`,
          text: `Hi ${first(s.name)},\n\n${text}\n\n${from}`,
          threadId: s.threadId,
          inReplyTo: s.messageId,
          fromName: from,
          from: rec.gmail,
        })
      );
    };
    if (action === 'decline') {
      const reason = meta.declined && meta.declined.reason ? `\n\nTheir reason: ${meta.declined.reason}` : '';
      toOwner(`${name} declined: ${title}`, `${name} declined to sign "${title}". The request is closed.${reason}`);
    } else if (st.status === 'complete') {
      toOwner(`Everyone signed: ${title}`, `All ${meta.n} ${meta.n === 1 ? 'person has' : 'people have'} signed "${title}". The signed PDF is sealed and timestamped. Download it from Sent for signature on the Sign page.`);
      for (const s of signers) if (s.threadId) toSigner(s, `Everyone has signed "${title}". Open the signing link in my earlier email to download the signed, sealed copy.`);
    } else {
      let next = null;
      if (meta.ordered) {
        const i = index + 1;
        if (i < signers.length && !(st.signers[i] && st.signers[i].signed)) next = { ...signers[i], i };
      }
      const left = meta.n - signedCount;
      toOwner(
        `${name} signed: ${title}`,
        `${name} signed "${title}" (${signedCount} of ${meta.n}). ${left} still to sign${next ? `, ${next.me ? 'you are' : `${next.name} is`} next` : ''}.`
      );
      if (next && next.me) toOwner(`Your turn to sign: ${title}`, `${name} has signed "${title}" and it is your turn. Open it from Sent for signature on the Sign page.`);
      else if (next && next.threadId) toSigner(next, `It's your turn to sign "${title}". ${name} has signed. Use the signing link in my earlier email.`);
    }
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === 'rejected') console.warn('Paperhaus mail:', r.reason && (r.reason.code || r.reason.message));
  } catch (err) {
    console.warn('Paperhaus mail:', err && err.message);
  }
}

// ---------------------------------------------------------------- helpers

async function role(meta, token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const h = await sha256hex(token);
  if (h === meta.senderToken) return { role: 'sender', index: null };
  if (h === meta.readToken) return { role: 'reader', index: null };
  const i = meta.tokens.indexOf(h);
  return i >= 0 ? { role: 'signer', index: i } : null;
}

function stamp(request) {
  return {
    at: Date.now(),
    ip: request.headers.get('cf-connecting-ip') || '',
    ua: (request.headers.get('user-agent') || '').slice(0, 300),
  };
}

async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomId() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const isId = (s) => /^[A-Za-z0-9_-]{16}$/.test(s);
const isHash = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

function b64(buf) {
  if (!buf) return null;
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function bytes(buf) {
  if (!buf) return json({ error: 'not_found' }, 404);
  return new Response(buf, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
}
