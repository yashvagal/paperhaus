/**
 * Paperhaus page fetcher for HTML to PDF (Cloudflare Pages Function).
 *
 * GET /api/fetch?url=<http or https address>
 *
 * Browsers can't read other sites directly, so HTML to PDF asks this function for the
 * page and for each of its images and stylesheets. It sits behind the Paperhaus sign-in
 * (Cloudflare Access), so only invited people can use it. It stores nothing.
 */

const MAX_BYTES = 8 * 1024 * 1024; // per file
const TIMEOUT_MS = 15000;

export async function onRequestGet({ request }) {
  // Cloudflare Access adds this header only for signed-in Paperhaus users.
  if (!request.headers.get('cf-access-authenticated-user-email')) return text('Sign in to Paperhaus first.', 401);

  const target = new URL(request.url).searchParams.get('url') || '';
  let url;
  try {
    url = new URL(target);
  } catch {
    return text('That is not a web address.', 400);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return text('Only http and https addresses work.', 400);
  if (url.username || url.password) return text('Addresses with a login in them are not supported.', 400);
  if (isPrivateHost(url.hostname)) return text('That address is on a private network.', 400);

  let res;
  try {
    res = await fetch(url.toString(), {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; PaperhausHTMLtoPDF/1.0)',
        accept: request.headers.get('accept') || 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': request.headers.get('accept-language') || 'en',
      },
    });
  } catch (err) {
    return text(`Could not reach that site (${(err && err.name) || 'error'}).`, 502);
  }
  const finalUrl = res.url || url.toString();
  try {
    if (isPrivateHost(new URL(finalUrl).hostname)) return text('That address redirects to a private network.', 400);
  } catch {
    /* keep going */
  }
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) return text('That file is too large.', 413);

  // Read with a size cap, since content-length can be missing or wrong.
  const reader = res.body ? res.body.getReader() : null;
  const chunks = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        reader.cancel();
        return text('That file is too large.', 413);
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    body.set(c, off);
    off += c.byteLength;
  }
  return new Response(body, {
    status: res.ok ? 200 : 502,
    headers: {
      'content-type': res.headers.get('content-type') || 'application/octet-stream',
      'x-paperhaus-final-url': finalUrl,
      'x-paperhaus-status': String(res.status),
      'cache-control': 'no-store',
    },
  });
}

function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  return false;
}

function text(msg, status) {
  return new Response(msg, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}
