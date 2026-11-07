/**
 * Paperhaus seal: the certificate signature on finished signed PDFs.
 *
 * When everyone has signed, the browser that finishes the document adds an empty
 * signature slot to the PDF, hashes the file around it and sends only that hash here.
 * This code signs the hash with the Paperhaus seal key, asks an independent time server
 * to timestamp the signature (RFC 3161), and returns the finished CMS signature, which
 * the browser drops into the slot. The PDF itself never comes here.
 *
 * The seal key is made on first use with the Workers crypto API (ECDSA P-256), kept in
 * the ESIGN KV namespace under k:seal, and never leaves it. Its certificate is
 * self-issued ("Paperhaus Seal"), so PDF readers show the seal as intact and unchanged,
 * with the signer's identity marked as not from a public authority.
 *
 * No dependencies: the few ASN.1 structures needed are written out by hand below.
 */

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  timeStampToken: '1.2.840.113549.1.9.16.2.14',
  sha256: '2.16.840.1.101.3.4.2.1',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  cn: '2.5.4.3',
  o: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  subjectKeyId: '2.5.29.14',
};

// Free RFC 3161 time servers, tried in order. TSA_URLS (comma separated) overrides them.
const TIME_SERVERS = [
  ['DigiCert', 'http://timestamp.digicert.com'],
  ['Sectigo', 'http://timestamp.sectigo.com'],
  ['SSL.com', 'http://ts.ssl.com'],
];

// ---------------------------------------------------------------- DER writing

const enc = new TextEncoder();

function cat(parts) {
  const list = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(list.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of list) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function lenBytes(n) {
  if (n < 0x80) return [n];
  const b = [];
  while (n > 0) {
    b.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return [0x80 | b.length, ...b];
}

const tlv = (tag, ...parts) => {
  const body = cat(parts);
  return cat([[tag], lenBytes(body.length), body]);
};
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const ctx = (n, ...p) => tlv(0xa0 + n, ...p);
const octet = (b) => tlv(0x04, b);
const utf8 = (s) => tlv(0x0c, enc.encode(s));
const bool = (v) => tlv(0x01, [v ? 0xff : 0]);
const nul = () => Uint8Array.of(0x05, 0x00);

function oid(s) {
  const arcs = s.split('.').map(Number);
  const out = [40 * arcs[0] + arcs[1]];
  for (const a of arcs.slice(2)) {
    const b = [a & 0x7f];
    let v = Math.floor(a / 128);
    while (v > 0) {
      b.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...b);
  }
  return tlv(0x06, out);
}

function int(bytes) {
  let b = Uint8Array.from(bytes);
  let i = 0;
  while (i < b.length - 1 && b[i] === 0 && !(b[i + 1] & 0x80)) i++;
  b = b.subarray(i);
  if (b[0] & 0x80) b = cat([[0], b]);
  return tlv(0x02, b);
}
const intNum = (n) => int(n < 256 ? [n] : [n >> 8, n & 0xff]);

function utcTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, enc.encode(s));
}

/** DER SET OF: members sorted by their encodings. */
function sortedSetMembers(members) {
  return [...members].sort((a, b) => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  });
}

/** WebCrypto gives ECDSA signatures as r||s; CMS and X.509 want SEQUENCE { r, s }. */
function ecdsaDer(raw) {
  const r = new Uint8Array(raw);
  return seq(int(r.subarray(0, 32)), int(r.subarray(32)));
}

// ---------------------------------------------------------------- DER reading

function readTlv(buf, off) {
  const tag = buf[off];
  let len = buf[off + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i];
    hdr = 2 + n;
  }
  return { tag, start: off, body: off + hdr, end: off + hdr + len };
}

function children(buf, node) {
  const out = [];
  for (let o = node.body; o < node.end; ) {
    const c = readTlv(buf, o);
    out.push(c);
    o = c.end;
  }
  return out;
}

// ---------------------------------------------------------------- helpers

export function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
export function hex(u8) {
  return [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- the seal key

const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

async function makeSealKey() {
  const kp = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  const name = seq(set(seq(oid(OID.o), utf8('Paperhaus'))), set(seq(oid(OID.cn), utf8('Paperhaus Seal'))));
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] &= 0x7f;
  serial[0] |= 0x01;
  const now = Date.now();
  const notAfter = new Date(Math.min(now + 20 * 365.25 * 86400000, Date.UTC(2049, 11, 31)));
  const algo = seq(oid(OID.ecdsaSha256));
  const ski = (await sha256(spki)).subarray(0, 20);
  const tbs = seq(
    ctx(0, intNum(2)),
    int(serial),
    algo,
    name,
    seq(utcTime(new Date(now - 86400000)), utcTime(notAfter)),
    name,
    spki,
    ctx(
      3,
      seq(
        seq(oid(OID.basicConstraints), bool(true), octet(seq())),
        // digitalSignature + nonRepudiation
        seq(oid(OID.keyUsage), bool(true), octet(tlv(0x03, [6, 0xc0]))),
        seq(oid(OID.subjectKeyId), octet(octet(ski)))
      )
    )
  );
  const sig = ecdsaDer(await crypto.subtle.sign(SIGN, kp.privateKey, tbs));
  const cert = seq(tbs, algo, tlv(0x03, cat([[0], sig])));
  return {
    v: 1,
    created: now,
    jwk: await crypto.subtle.exportKey('jwk', kp.privateKey),
    cert: b64(cert),
    name: b64(name),
    serial: b64(serial),
  };
}

async function sealKey(kv) {
  let k = await kv.get('k:seal', 'json');
  if (!k) {
    k = await makeSealKey();
    await kv.put('k:seal', JSON.stringify(k));
  }
  return {
    key: await crypto.subtle.importKey('jwk', k.jwk, ALG, false, ['sign']),
    cert: fromB64(k.cert),
    name: fromB64(k.name),
    serial: fromB64(k.serial),
  };
}

/** SHA-256 of the seal certificate, so a record can name the exact certificate used. */
export async function sealCertFingerprint(kv) {
  const k = await sealKey(kv);
  return hex(await sha256(k.cert));
}

// ---------------------------------------------------------------- time stamp (RFC 3161)

async function timestamp(signature, env) {
  const servers = (env.TSA_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((u) => [new URL(u).hostname, u]);
  const imprint = await sha256(signature);
  const req = seq(intNum(1), seq(seq(oid(OID.sha256), nul()), octet(imprint)), int(crypto.getRandomValues(new Uint8Array(8))), bool(true));
  for (const [by, url] of servers.length ? servers : TIME_SERVERS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/timestamp-query', accept: 'application/timestamp-reply' },
        body: req,
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const res = new Uint8Array(await r.arrayBuffer());
      const top = readTlv(res, 0);
      const [status, token] = children(res, top);
      if (!token) continue;
      const code = res[children(res, status)[0].body];
      if (code !== 0 && code !== 1) continue;
      return { token: res.subarray(token.start, token.end), by, time: genTime(res, token) };
    } catch {
      /* try the next server */
    }
  }
  return null;
}

/** The time inside a timestamp token: ContentInfo > SignedData > eContent > TSTInfo.genTime. */
function genTime(buf, token) {
  try {
    const [, wrap] = children(buf, token);
    const signedData = children(buf, wrap)[0];
    const encap = children(buf, signedData)[2];
    const explicit = children(buf, encap)[1];
    const os = children(buf, explicit)[0];
    const tst = readTlv(buf, os.body);
    const gen = children(buf, tst)[4];
    const s = new TextDecoder().decode(buf.subarray(gen.body, gen.end));
    const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the CMS signature

/**
 * Sign a PDF byte-range digest (32 bytes) and return a detached CMS SignedData with a
 * timestamp token, ready for the PDF's /Contents.
 */
export async function sealDigest(digest, env) {
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new Error('bad_digest');
  const k = await sealKey(env.ESIGN);
  const signedAt = new Date();
  const attr = (type, value) => seq(oid(type), set(value));
  const attrs = sortedSetMembers([
    attr(OID.contentType, oid(OID.data)),
    attr(OID.signingTime, utcTime(signedAt)),
    attr(OID.messageDigest, octet(digest)),
  ]);
  const signature = ecdsaDer(await crypto.subtle.sign(SIGN, k.key, set(...attrs)));
  const ts = await timestamp(signature, env);
  const signerInfo = seq(
    intNum(1),
    seq(k.name, int(k.serial)),
    seq(oid(OID.sha256)),
    ctx(0, ...attrs),
    seq(oid(OID.ecdsaSha256)),
    octet(signature),
    ...(ts ? [tlv(0xa1, seq(oid(OID.timeStampToken), set(ts.token)))] : [])
  );
  const signedData = seq(intNum(1), set(seq(oid(OID.sha256))), seq(oid(OID.data)), ctx(0, k.cert), set(signerInfo));
  const cms = seq(oid(OID.signedData), ctx(0, signedData));
  return {
    cms,
    signedAt: signedAt.getTime(),
    timestamp: ts ? { by: ts.by, at: ts.time } : null,
    cert: hex(await sha256(k.cert)),
  };
}
