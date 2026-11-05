/**
 * Paperhaus e-sign API (Cloudflare Pages Function).
 *
 * Holds signing requests ("envelopes") for up to 14 days, then Cloudflare deletes them on
 * its own. Everything it keeps about the document is encrypted in the sender's browser
 * first: the PDF, the field layout, names and email addresses. The key travels only in
 * the signing links, after the # in the address, which browsers never send to a server.
 * So this code stores and hands back encrypted bytes it cannot read, plus the times, IP
 * addresses and browsers of each view and signature for the audit certificate.
 *
 * Storage: one KV namespace bound as ESIGN (Pages project, Settings, Bindings).
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
 *
 * The /p/ routes are public (Access bypass) and need a token from a signing link: each
 * signer has their own, the sender has one, and a read-only one opens the finished copy.
 * Only SHA-256 hashes of the tokens are stored.
 */

const DAYS = 14;
const MAX_SIGNERS = 10;
const MAX_DOC = 20 * 1024 * 1024; // KV values max out at 25 MiB
const MAX_SMALL = 2 * 1024 * 1024; // envelope, each signature submission

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
      if (method === 'POST' && action === 'sign') return await sign(request, env, id, meta, who);
      if (method === 'POST' && action === 'decline') return await decline(request, env, id, meta, who);
      if (method === 'POST' && action === 'cancel') return await cancel(env, id, meta, who);
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
  const expiration = Math.floor(created / 1000) + DAYS * 86400;
  const meta = {
    v: 1,
    n,
    ordered: !!info.ordered,
    tokens: info.tokens,
    senderToken: info.senderToken,
    readToken: info.readToken,
    sender,
    created,
    expires: expiration * 1000,
    status: 'out',
  };
  await env.ESIGN.put(`d:${id}`, await doc.arrayBuffer(), { expiration });
  await env.ESIGN.put(`e:${id}`, await envelope.arrayBuffer(), { expiration });
  await env.ESIGN.put(`m:${id}`, JSON.stringify(meta), { expiration });
  return json({ id, expires: meta.expires });
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
  const out = {
    id,
    role: who.role,
    index: who.index,
    n: meta.n,
    ordered: meta.ordered,
    sender: meta.sender,
    created: meta.created,
    expires: meta.expires,
    status: meta.status === 'out' && done ? 'complete' : meta.status,
    declined: meta.declined || null,
    signers,
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
    await env.ESIGN.put(key, '1', { expiration: Math.floor(meta.expires / 1000), metadata: stamp(request) });
  }
  return new Response(null, { status: 204 });
}

async function sign(request, env, id, meta, who) {
  if (who.role !== 'signer') return json({ error: 'not_a_signer' }, 403);
  if (meta.status !== 'out') return json({ error: meta.status }, 409);
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
  await env.ESIGN.put(key, body, { expiration: Math.floor(meta.expires / 1000), metadata: stamp(request) });
  // Count it as viewed too, in case the view call never arrived.
  const vkey = `v:${id}:${who.index}`;
  if ((await env.ESIGN.get(vkey, 'text')) === null) {
    await env.ESIGN.put(vkey, '1', { expiration: Math.floor(meta.expires / 1000), metadata: stamp(request) });
  }
  return json(await state(env, id, meta, who, false));
}

async function decline(request, env, id, meta, who) {
  if (who.role !== 'signer') return json({ error: 'not_a_signer' }, 403);
  if (meta.status !== 'out') return json({ error: meta.status }, 409);
  const body = await request.arrayBuffer();
  meta.status = 'declined';
  meta.declined = { index: who.index, ...stamp(request), reason: body.byteLength && body.byteLength < 20000 ? b64(body) : null };
  await env.ESIGN.put(`m:${id}`, JSON.stringify(meta), { expiration: Math.floor(meta.expires / 1000) });
  return json(await state(env, id, meta, who, false));
}

async function cancel(env, id, meta, who) {
  if (who.role !== 'sender') return json({ error: 'not_the_sender' }, 403);
  const keys = [`m:${id}`, `d:${id}`, `e:${id}`];
  for (let i = 0; i < meta.n; i++) keys.push(`s:${id}:${i}`, `v:${id}:${i}`);
  await Promise.all(keys.map((k) => env.ESIGN.delete(k)));
  return json({ ok: true });
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
