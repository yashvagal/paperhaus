/**
 * Paperhaus file sync (opt-in): a signed-in person's recent files, on all their devices.
 *
 *   GET    /api/files/key   { key }  this account's file key (base64, AES-256-GCM)
 *   GET    /api/files       { on, files: [{ id, at, size, meta }] }  newest first
 *   PUT    /api/files/settings  { on }  turn sync on or off for the account (off forgets the files)
 *   PUT    /api/files/:id   body: encrypted file; header x-ph-meta: encrypted name/type/tool
 *   GET    /api/files/:id   the encrypted file
 *   DELETE /api/files/:id   forget one file
 *   DELETE /api/files       forget all of this account's synced files
 *
 * Files and their names are encrypted in the browser with the account's key before they
 * are uploaded, and decrypted there after download. The key is derived on the server from a
 * random master key kept in KV (k:files-master), so it follows the account to any device;
 * that also means whoever runs Paperhaus could unlock the files ("account-linked" sync).
 *
 * Storage is the ESIGN KV namespace (free tier: 25 MB per value, 1 GB total, 1,000 writes a
 * day), so each account keeps its newest MAX_FILES files under MAX_BYTES.
 * Behind the Paperhaus sign-in: Cloudflare Access sets the signed-in email header.
 */
const MAX_FILES = 12;
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_BYTES = 150 * 1024 * 1024;
const enc = new TextEncoder();

export async function onRequest(context) {
  const { request, env, params } = context;
  const parts = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const user = (request.headers.get('cf-access-authenticated-user-email') || '').toLowerCase();
  if (!user) return json({ error: 'sign_in_required' }, 401);
  if (!env.ESIGN) return json({ error: 'not_configured' }, 503);
  const uh = (await sha256hex(user)).slice(0, 32);
  const id = parts[0] || '';
  const m = request.method;

  try {
    if (m === 'GET' && id === 'key') return json({ key: await accountKey(env, user) });
    if (id === 'settings') {
      if (m !== 'PUT') return json({ error: 'not_found' }, 404);
      const body = await request.json().catch(() => ({}));
      if (body.on) await env.ESIGN.put(onKey(uh), '1');
      else {
        await forgetAll(env, uh);
        await env.ESIGN.delete(onKey(uh));
      }
      return json({ on: !!body.on });
    }
    if (!id) {
      if (m === 'GET') {
        const [on, files] = await Promise.all([env.ESIGN.get(onKey(uh)), getIndex(env, uh)]);
        return json({ on: !!on, files });
      }
      if (m === 'DELETE') return json({ ok: true, removed: await forgetAll(env, uh) });
      return json({ error: 'not_found' }, 404);
    }
    if (!/^[a-z0-9]{6,40}$/.test(id)) return json({ error: 'bad_id' }, 400);

    if (m === 'GET') {
      const data = await env.ESIGN.get(blobKey(uh, id), 'arrayBuffer');
      if (!data) return json({ error: 'not_found' }, 404);
      return new Response(data, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' } });
    }
    if (m === 'PUT') {
      if (!(await env.ESIGN.get(onKey(uh)))) return json({ error: 'sync_off' }, 409);
      const meta = String(request.headers.get('x-ph-meta') || '');
      const at = Number(request.headers.get('x-ph-at')) || Date.now();
      if (!meta || meta.length > 4000) return json({ error: 'bad_meta' }, 400);
      const body = await request.arrayBuffer();
      if (!body.byteLength) return json({ error: 'empty' }, 400);
      if (body.byteLength > MAX_FILE_BYTES) return json({ error: 'too_big', limit: MAX_FILE_BYTES }, 413);
      await env.ESIGN.put(blobKey(uh, id), body);
      let files = (await getIndex(env, uh)).filter((f) => f.id !== id);
      files.unshift({ id, at, size: body.byteLength, meta });
      files.sort((a, b) => b.at - a.at);
      // Keep the newest files within the budget; forget the rest.
      const keep = [];
      let total = 0;
      for (const f of files) {
        if (keep.length < MAX_FILES && total + f.size <= MAX_BYTES) {
          keep.push(f);
          total += f.size;
        } else await env.ESIGN.delete(blobKey(uh, f.id));
      }
      await env.ESIGN.put(indexKey(uh), JSON.stringify(keep));
      return json({ ok: true, kept: keep.some((f) => f.id === id) });
    }
    if (m === 'DELETE') {
      await env.ESIGN.delete(blobKey(uh, id));
      const files = (await getIndex(env, uh)).filter((f) => f.id !== id);
      await env.ESIGN.put(indexKey(uh), JSON.stringify(files));
      return json({ ok: true });
    }
    return json({ error: 'not_found' }, 404);
  } catch (err) {
    return json({ error: 'server_error', detail: String(err.message || err).slice(0, 200) }, 500);
  }
}

const onKey = (uh) => `fo:${uh}`;
const indexKey = (uh) => `fi:${uh}`;
const blobKey = (uh, id) => `fb:${uh}:${id}`;

async function getIndex(env, uh) {
  const list = await env.ESIGN.get(indexKey(uh), 'json');
  return Array.isArray(list) ? list : [];
}

async function forgetAll(env, uh) {
  const files = await getIndex(env, uh);
  await Promise.all(files.map((f) => env.ESIGN.delete(blobKey(uh, f.id))));
  if (files.length) await env.ESIGN.delete(indexKey(uh));
  return files.length;
}

/** The account's file key: HKDF from the master key, salted with the account's email. */
async function accountKey(env, user) {
  let master = await env.ESIGN.get('k:files-master');
  if (!master) {
    master = b64(crypto.getRandomValues(new Uint8Array(32)));
    await env.ESIGN.put('k:files-master', master);
    // Two first requests at once could each write one; keep whichever won.
    master = (await env.ESIGN.get('k:files-master')) || master;
  }
  const base = await crypto.subtle.importKey('raw', unb64(master), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('paperhaus-files-v1'), info: enc.encode(user) },
    base,
    256
  );
  return b64(new Uint8Array(bits));
}

async function sha256hex(s) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return [...h].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function b64(u8) {
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
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
