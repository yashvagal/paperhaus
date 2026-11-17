/**
 * Paperhaus invite list: who can sign in. Only the owner (ADMIN_EMAILS) can use it.
 *
 *   GET  /api/admin/me       { admin, name }      (anyone signed in; menu item, and the name
 *                                                 the Sign page fills in for them)
 *   GET  /api/admin/people   { emails: [...], names: { email: name } }
 *   POST /api/admin/add      { email, name }
 *   POST /api/admin/name     { email, name }      set or change someone's name
 *   POST /api/admin/remove   { email }
 *
 * Names live in the ESIGN KV namespace under `people-names` (email -> name).
 *
 * The list is the Cloudflare Access policy "Paperhaus friends". This edits it through the
 * Cloudflare API with a token that can only edit Access apps and policies. Pages variables
 * (DEPLOY.md, step 3d):
 *   CF_API_TOKEN          secret, "Access: Apps and Policies: Edit" on this account
 *   CF_ACCOUNT_ID         d622bb8a5c22083722c920754d2eef2c
 *   CF_ACCESS_POLICY_ID   10aba6d1-5d80-4d2b-9217-1e16ac9523cd
 *   ADMIN_EMAILS          optional, comma-separated; default yashvagal@gmail.com
 *
 * Behind the Paperhaus sign-in, so Cloudflare Access sets the signed-in email header.
 */
import { adminEmails } from '../../_shared/admins.js';

const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/.test(s);

export async function onRequest(context) {
  const { request, env, params } = context;
  const action = (Array.isArray(params.path) ? params.path : [params.path])[0] || '';
  const user = (request.headers.get('cf-access-authenticated-user-email') || '').toLowerCase();
  if (!user) return json({ error: 'sign_in_required' }, 401);
  const admins = adminEmails(env);
  const admin = admins.includes(user);
  const configured = !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_ACCESS_POLICY_ID);

  if (request.method === 'GET' && action === 'me') return json({ admin, name: (await getNames(env))[user] || '' });
  if (!admin) return json({ error: 'not_allowed' }, 403);
  if (request.method === 'POST' && action === 'name') {
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    if (!isEmail(email)) return json({ error: 'bad_email' }, 400);
    const names = await setName(env, email, body.name);
    return json({ ok: true, names });
  }
  if (!configured) return json({ error: 'not_configured' }, 503);

  try {
    if (request.method === 'GET' && action === 'people') {
      const policy = await getPolicy(env);
      return json({ emails: emailsOf(policy), names: await getNames(env) });
    }
    if (request.method === 'POST' && (action === 'add' || action === 'remove')) {
      const body = await request.json().catch(() => ({}));
      const email = String(body.email || '').trim().toLowerCase();
      if (!isEmail(email)) return json({ error: 'bad_email' }, 400);
      if (action === 'remove' && admins.includes(email)) return json({ error: 'cannot_remove_owner' }, 400);
      const policy = await getPolicy(env);
      const current = emailsOf(policy);
      const has = current.includes(email);
      if (action === 'add' && body.name !== undefined) await setName(env, email, body.name);
      if ((action === 'add' && has) || (action === 'remove' && !has)) return json({ emails: current, names: await getNames(env), changed: false });
      const include = policy.include.filter((r) => !(r.email && String(r.email.email).toLowerCase() === email));
      if (action === 'add') include.push({ email: { email } });
      const saved = await putPolicy(env, policy, include);
      if (action === 'remove') await setName(env, email, '');
      return json({ emails: emailsOf(saved), names: await getNames(env), changed: true });
    }
    return json({ error: 'not_found' }, 404);
  } catch (err) {
    return json({ error: 'cloudflare_error', detail: String(err.message || err).slice(0, 300) }, 502);
  }
}

async function getNames(env) {
  if (!env.ESIGN) return {};
  const n = await env.ESIGN.get('people-names', 'json');
  return n && typeof n === 'object' ? n : {};
}

async function setName(env, email, name) {
  const names = await getNames(env);
  const clean = String(name || '').replace(/[\r\n<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if ((names[email] || '') === clean) return names;
  if (clean) names[email] = clean;
  else delete names[email];
  if (env.ESIGN) await env.ESIGN.put('people-names', JSON.stringify(names));
  return names;
}

function emailsOf(policy) {
  return (policy.include || []).filter((r) => r.email && r.email.email).map((r) => String(r.email.email).toLowerCase());
}

const api = (env) => `${env.CF_API_BASE || 'https://api.cloudflare.com/client/v4'}/accounts/${env.CF_ACCOUNT_ID}/access/policies/${env.CF_ACCESS_POLICY_ID}`;

async function cf(env, init) {
  const r = await fetch(api(env), {
    ...init,
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.success) throw new Error((data.errors && data.errors.map((e) => e.message).join('; ')) || `HTTP ${r.status}`);
  return data.result;
}

const getPolicy = (env) => cf(env, { method: 'GET' });

function putPolicy(env, policy, include) {
  // Send the policy back as it is, with only the include list changed.
  const keep = ['name', 'decision', 'exclude', 'require', 'session_duration', 'approval_required', 'approval_groups', 'isolation_required', 'purpose_justification_required', 'purpose_justification_prompt', 'mfa_config'];
  const body = { include };
  for (const k of keep) if (policy[k] !== undefined && policy[k] !== null) body[k] = policy[k];
  return cf(env, { method: 'PUT', body: JSON.stringify(body) });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
