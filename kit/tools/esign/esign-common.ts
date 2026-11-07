/**
 * Paperhaus e-sign: pieces shared by the sender page (request-signatures) and the
 * signer page (sign-request). Encryption, the small API client, page rendering with
 * pdf.js, and building the finished, signed PDF with its signing certificate.
 *
 * Everything sensitive is encrypted here, in the browser, with AES-256-GCM. The key
 * only ever sits after the # of a signing link, which is never sent to a server.
 */
import '../../utils/map-upsert-polyfill.js';
import * as pdfjsLib from 'pdfjs-dist';
import '../../utils/setup-pdf-worker.js';
import { PDFDocument, degrees } from 'pdf-lib';
import { type SealResult, sealPdf } from './esign-seal.js';

export { type SealResult, sealPdf };

export type FieldType = 'signature' | 'initials' | 'date' | 'name' | 'text' | 'checkbox';

export interface Field {
  id: string;
  page: number; // 0-based
  // Position on the page as it is shown (rotation applied), as fractions of its size.
  x: number;
  y: number;
  w: number;
  h: number;
  type: FieldType;
  signer: number;
  required: boolean;
  label?: string;
}

export interface Signer {
  name: string;
  email: string;
  /** What this signature means (21 CFR 11.50): Author, Approved, Reviewed... */
  reason?: string;
}

export const REASONS = ['Author', 'Approved', 'Reviewed', 'Agreed', 'Witness', 'Received'];

export interface Envelope {
  v: 1;
  title: string;
  message: string;
  docName: string;
  docSha256: string;
  sender: { name: string; email: string };
  ordered: boolean;
  createdAt: number;
  signers: Signer[];
  fields: Field[];
  readToken: string;
}

/** What one signer submits: a picture for each filled field, plus the plain values. */
export interface Submission {
  values: Record<string, { png: string; text?: string; checked?: boolean }>;
  signedName: string;
  consent: string;
  timezone: string;
}

export interface Stamp {
  at: number;
  ip: string;
  ua: string;
}

/** One audit trail entry, chained to the one before it by its hash. */
export interface AuditEvent {
  n: number;
  t: number;
  ev: 'created' | 'viewed' | 'signed' | 'declined' | 'completed' | 'sealed' | string;
  by: number | 'sender' | 'reader' | 'paperhaus';
  ip: string;
  ua: string;
  geo: string;
  prev: string;
  h: string;
  fingerprint?: string;
  timestamp?: string;
  docSha256?: string;
  consent?: boolean;
}

export interface Sealed {
  fingerprint: string;
  at: number;
  timestamp: { by: string; at: number | null } | null;
  cert: string | null;
}

export interface State {
  id: string;
  role: 'signer' | 'sender' | 'reader';
  index: number | null;
  n: number;
  ordered: boolean;
  sender: string;
  created: number;
  expires: number;
  status: 'out' | 'complete' | 'declined' | 'cancelled' | 'expired';
  declined: (Stamp & { index: number; reason: string | null }) | null;
  signers: { viewed: Stamp | null; signed: Stamp | null }[];
  envelope?: string;
  keep?: number;
  retainUntil?: number;
  sealed?: Sealed | null;
  events?: AuditEvent[];
}



export const CONSENT =
  'I agree to sign this document electronically and that my electronic signature counts as my handwritten signature.';

export const SIGNER_COLORS = ['#e07a3f', '#3b7dd8', '#2f9e6a', '#9b5bd1', '#d14f7a', '#b38a12', '#2a9bb0', '#7a6a58', '#c4452f', '#4d6bd1'];

export const FIELD_LABELS: Record<FieldType, string> = {
  signature: 'Signature',
  initials: 'Initials',
  date: 'Date signed',
  name: 'Full name',
  text: 'Text',
  checkbox: 'Checkbox',
};

// ---------------------------------------------------------------- bytes and crypto

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64(s: string): Uint8Array {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '==='.slice((t.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 24): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256hex(data: string | Uint8Array | ArrayBuffer): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest('SHA-256', buf as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(keyRaw: Uint8Array, data: Uint8Array | string): Promise<Uint8Array> {
  const key = await importKey(keyRaw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain as BufferSource));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export async function decrypt(keyRaw: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await importKey(keyRaw);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12) as BufferSource }, key, data.subarray(12) as BufferSource);
  return new Uint8Array(pt);
}

export async function decryptJson<T>(keyRaw: Uint8Array, data: Uint8Array): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await decrypt(keyRaw, data))) as T;
}

// ---------------------------------------------------------------- links

/** A signing link: /sign-request#<id>.<key>.<token>. Everything after # stays in the browser. */
export function signLink(id: string, key: Uint8Array, token: string): string {
  return `${location.origin}/sign-request#${id}.${b64url(key)}.${token}`;
}

export function parseLink(hash: string): { id: string; key: Uint8Array; token: string } | null {
  const m = /^#?([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{20,64})$/.exec(hash.trim());
  if (!m) return null;
  return { id: m[1], key: fromB64(m[2]), token: m[3] };
}

// ---------------------------------------------------------------- API

export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: Record<string, unknown> = {}) {
    super(code);
  }
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  if (!r.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = await r.json();
    } catch {
      /* not json */
    }
    throw new ApiError(r.status, String(body.error || r.status), body);
  }
  return r;
}

export const api = {
  async create(form: FormData): Promise<{ id: string; expires: number }> {
    return (await call('/api/esign/new', { method: 'POST', body: form })).json();
  },
  async state(id: string, t: string): Promise<State> {
    return (await call(`/api/esign/p/${id}?t=${encodeURIComponent(t)}`)).json();
  },
  async doc(id: string, t: string): Promise<Uint8Array> {
    return new Uint8Array(await (await call(`/api/esign/p/${id}/doc?t=${encodeURIComponent(t)}`)).arrayBuffer());
  },
  async subs(id: string, t: string): Promise<{ index: number; data: string }[]> {
    return (await call(`/api/esign/p/${id}/subs?t=${encodeURIComponent(t)}`)).json();
  },
  async view(id: string, t: string): Promise<void> {
    await call(`/api/esign/p/${id}/view?t=${encodeURIComponent(t)}`, { method: 'POST' });
  },
  async sign(id: string, t: string, body: Uint8Array): Promise<State> {
    return (await call(`/api/esign/p/${id}/sign?t=${encodeURIComponent(t)}`, { method: 'POST', body: body as BodyInit })).json();
  },
  async decline(id: string, t: string, body: Uint8Array | null): Promise<State> {
    return (await call(`/api/esign/p/${id}/decline?t=${encodeURIComponent(t)}`, { method: 'POST', body: (body || new Uint8Array()) as BodyInit })).json();
  },
  async cancel(id: string, t: string): Promise<void> {
    await call(`/api/esign/p/${id}/cancel?t=${encodeURIComponent(t)}`, { method: 'POST' });
  },
  async seal(id: string, t: string, digest: string): Promise<SealResult> {
    return (
      await call(`/api/esign/p/${id}/seal?t=${encodeURIComponent(t)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ digest }),
      })
    ).json();
  },
  async putFinal(id: string, t: string, body: Uint8Array, fingerprint: string, info: Pick<SealResult, 'cert' | 'timestamp'>): Promise<State> {
    return (
      await call(`/api/esign/p/${id}/final?t=${encodeURIComponent(t)}`, {
        method: 'POST',
        headers: { 'x-fingerprint': fingerprint, 'x-seal': JSON.stringify(info) },
        body: body as BodyInit,
      })
    ).json();
  },
  async getFinal(id: string, t: string): Promise<Uint8Array> {
    return new Uint8Array(await (await call(`/api/esign/p/${id}/final?t=${encodeURIComponent(t)}`)).arrayBuffer());
  },
};

// ---------------------------------------------------------------- rendering

export type PdfDoc = pdfjsLib.PDFDocumentProxy;

export async function openPdf(bytes: Uint8Array): Promise<PdfDoc> {
  return pdfjsLib.getDocument({ data: bytes.slice() }).promise;
}

/** Render every page into `host`, each inside a .es-page box that fields are placed on. */
export async function renderPages(pdf: PdfDoc, host: HTMLElement): Promise<HTMLElement[]> {
  host.textContent = '';
  const boxes: HTMLElement[] = [];
  const width = Math.min(host.clientWidth || 800, 900);
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const box = document.createElement('div');
    box.className = 'es-page';
    box.dataset.page = String(i - 1);
    box.style.aspectRatio = `${base.width} / ${base.height}`;
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    const num = document.createElement('span');
    num.className = 'es-page-num';
    num.textContent = `Page ${i} of ${pdf.numPages}`;
    box.appendChild(num);
    host.appendChild(box);
    boxes.push(box);
    const scale = (width / base.width) * Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale });
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp, canvas }).promise;
  }
  return boxes;
}

// ---------------------------------------------------------------- field pictures

const SCRIPT_FONTS = ['Dancing Script', 'Great Vibes', 'Cedarville Cursive'];
export { SCRIPT_FONTS };

/** Typed signature or initials as a transparent PNG. */
export async function typedPng(text: string, font: string, color = '#14213d'): Promise<string> {
  await document.fonts.load(`64px "${font}"`, text).catch((): undefined => undefined);
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const size = 96;
  ctx.font = `${size}px "${font}", cursive`;
  const w = Math.ceil(ctx.measureText(text).width) + 40;
  c.width = Math.max(w, 120);
  c.height = Math.round(size * 1.6);
  ctx.font = `${size}px "${font}", cursive`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 20, c.height / 2);
  return trimPng(c);
}

/** Plain text (name, date, text fields) as a PNG, so any language and script works. */
export function textPng(text: string, boxW: number, boxH: number): string {
  const scale = 4;
  const c = document.createElement('canvas');
  c.width = Math.max(8, Math.round(boxW * scale));
  c.height = Math.max(8, Math.round(boxH * scale));
  const ctx = c.getContext('2d')!;
  let size = c.height * 0.62;
  const family = '"Poppins", "Noto Sans", system-ui, sans-serif';
  ctx.font = `${size}px ${family}`;
  while (size > 6 && ctx.measureText(text).width > c.width * 0.96) {
    size -= 1;
    ctx.font = `${size}px ${family}`;
  }
  ctx.fillStyle = '#111111';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width * 0.02, c.height / 2);
  return c.toDataURL('image/png');
}

export function checkPng(): string {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const ctx = c.getContext('2d')!;
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 12;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(18, 52);
  ctx.lineTo(40, 74);
  ctx.lineTo(80, 24);
  ctx.stroke();
  return c.toDataURL('image/png');
}

/** Crop a canvas to its drawn pixels, with a small margin. */
export function trimPng(c: HTMLCanvasElement): string {
  const ctx = c.getContext('2d')!;
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return c.toDataURL('image/png');
  const m = 6;
  x0 = Math.max(0, x0 - m);
  y0 = Math.max(0, y0 - m);
  x1 = Math.min(width - 1, x1 + m);
  y1 = Math.min(height - 1, y1 + m);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d')!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

export function formatDate(ms: number, withTime = false): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  if (!withTime) return date;
  return `${date}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`;
}

// ---------------------------------------------------------------- the finished PDF

function dataUrlBytes(url: string): Uint8Array {
  return fromB64(url.split(',')[1].replace(/\+/g, '-').replace(/\//g, '_'));
}

/**
 * The signed PDF: the original with every signer's fields drawn in, plus a signing
 * certificate page at the end. Built the same way by everyone who opens it, from the
 * original, the submitted values and the times the server recorded.
 */
export async function buildSignedPdf(
  original: Uint8Array,
  env: Envelope,
  state: State,
  subs: (Submission | null)[]
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(original, { ignoreEncryption: true });
  const view = await openPdf(original);
  const pages = pdf.getPages();

  for (const f of env.fields) {
    const sub = subs[f.signer];
    const v = sub?.values[f.id];
    if (!v || !v.png) continue;
    const page = pages[f.page];
    if (!page) continue;
    const vp = (await view.getPage(f.page + 1)).getViewport({ scale: 1 });
    const W = vp.width;
    const H = vp.height;
    const rot = ((vp.rotation % 360) + 360) % 360;
    const img = await pdf.embedPng(dataUrlBytes(v.png));
    // Fit the picture inside the box, keeping its shape; signatures sit on the left.
    const boxW = f.w * W;
    const boxH = f.h * H;
    const s = Math.min(boxW / img.width, boxH / img.height);
    const w = img.width * s;
    const h = img.height * s;
    const left = f.x * W + (f.type === 'checkbox' ? (boxW - w) / 2 : 0);
    const bottom = (f.y + f.h) * H - (boxH - h) / 2;
    const [px, py] = vp.convertToPdfPoint(left, bottom);
    page.drawImage(img, { x: px, y: py, width: w, height: h, rotate: degrees(rot) });
  }

  await addCertificate(pdf, env, state, subs, original);
  if (state.events?.length) await addAuditPage(pdf, env, state);
  pdf.setTitle(env.title);
  pdf.setSubject(`Signed with Paperhaus. Envelope ${state.id}.`);
  pdf.setProducer('Paperhaus');
  pdf.setModificationDate(new Date());
  view.destroy();
  return pdf.save();
}

/** A letter-size page drawn on a canvas (any script prints right), added as a picture. */
async function canvasPage(pdf: PDFDocument, draw: (ctx: CanvasRenderingContext2D, W: number, H: number) => Promise<void> | void): Promise<void> {
  const W = 612;
  const H = 792;
  const scale = 2.5;
  const c = document.createElement('canvas');
  c.width = W * scale;
  c.height = H * scale;
  const ctx = c.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';
  await draw(ctx, W, H);
  const img = await pdf.embedPng(dataUrlBytes(c.toDataURL('image/png')));
  const page = pdf.addPage([W, H]);
  page.drawImage(img, { x: 0, y: 0, width: W, height: H });
}

const font = (size: number, weight = 400) => `${weight} ${size}px "Poppins", "Noto Sans", system-ui, sans-serif`;

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

async function addCertificate(
  pdf: PDFDocument,
  env: Envelope,
  state: State,
  subs: (Submission | null)[],
  original: Uint8Array
): Promise<void> {
  const hash = await sha256hex(original);
  await canvasPage(pdf, async (ctx, W, H) => {
    let y = 56;
    const left = 48;
    const line = (text: string, size = 9, weight = 400, color = '#333333', x = left, max = W - x - left) => {
      ctx.font = font(size, weight);
      ctx.fillStyle = color;
      ctx.fillText(fit(ctx, text, max), x, y);
    };
    line('Signing record', 20, 600, '#3a2a1f');
    y += 18;
    line('Paperhaus electronic signatures', 9, 400, '#8f7965');
    y += 26;
    const rows: [string, string][] = [
      ['Document', env.title || env.docName],
      ['Envelope ID', state.id],
      ['Sent by', `${env.sender.name} <${env.sender.email}>`],
      ['Sent on', formatDate(env.createdAt, true)],
      ['Signing order', env.ordered ? 'In order' : 'Any order'],
      ['Original SHA-256', hash],
    ];
    if (state.retainUntil) rows.push(['Record kept until', formatDate(state.retainUntil)]);
    for (const [k, v] of rows) {
      line(k, 8.5, 600, '#6b5646');
      line(v, 8.5, 400, '#222222', 150);
      y += 15;
    }
    y += 12;
    ctx.fillStyle = '#e6d1b6';
    ctx.fillRect(left, y, W - left * 2, 1);
    y += 22;
    for (let i = 0; i < env.signers.length; i++) {
      const s = env.signers[i];
      const st = state.signers[i];
      const sub = subs[i];
      if (y > H - 130) break;
      line(`${i + 1}. ${s.name}`, 11, 600, '#3a2a1f', left, 300);
      y += 15;
      line(`${s.email} · Signed as: ${s.reason || 'Signer'}`, 8.5, 400, '#6b5646', left, 330);
      y += 15;
      const sigField = env.fields.find((f) => f.signer === i && f.type === 'signature' && sub?.values[f.id]?.png);
      if (sigField && sub) {
        const img = new Image();
        img.src = sub.values[sigField.id].png;
        await img.decode().catch((): undefined => undefined);
        const h = 30;
        const w = Math.min(160, (img.width / Math.max(1, img.height)) * h);
        ctx.drawImage(img, W - left - w, y - 44, w, h);
      }
      const facts: [string, string][] = [
        ['Viewed', st?.viewed ? formatDate(st.viewed.at, true) : 'Not recorded'],
        ['Signed', st?.signed ? formatDate(st.signed.at, true) : 'Not signed'],
        ['IP address', st?.signed?.ip || st?.viewed?.ip || ''],
        ['Device', shortUa(st?.signed?.ua || st?.viewed?.ua || '')],
      ];
      for (const [k, v] of facts) {
        line(k, 8, 600, '#8f7965', left + 12);
        line(v, 8, 400, '#333333', left + 90);
        y += 13;
      }
      if (sub) {
        line(`Agreed: "${sub.consent}"`, 7.5, 400, '#6b5646', left + 12);
        y += 13;
      }
      y += 12;
    }
    y = H - 52;
    line('Every signer opened their own private link and agreed to sign electronically. Times are as recorded by Paperhaus.', 7, 400, '#8f7965');
    y += 11;
    line('This PDF is sealed with the Paperhaus certificate and an independent timestamp. Any change after sealing breaks the seal.', 7, 400, '#8f7965');
  });
}

/** Who did something in the audit trail, by name where the envelope has it. */
export function whoName(e: AuditEvent, env: Envelope): string {
  if (e.by === 'sender') return env.sender.name || env.sender.email;
  if (e.by === 'paperhaus') return 'Paperhaus';
  if (e.by === 'reader') return 'Read-only link';
  return env.signers[e.by as number]?.name || `Signer ${Number(e.by) + 1}`;
}

export function whoEmail(e: AuditEvent, env: Envelope): string {
  if (e.by === 'sender') return env.sender.email;
  if (typeof e.by === 'number') return env.signers[e.by]?.email || '';
  return '';
}

export function eventText(e: AuditEvent, env: Envelope): string {
  switch (e.ev) {
    case 'created':
      return 'Request created, document encrypted';
    case 'viewed':
      return 'Opened the signing link';
    case 'signed': {
      const r = typeof e.by === 'number' ? env.signers[e.by]?.reason : '';
      return `Agreed to e-sign and signed${r ? ` as ${r}` : ''}`;
    }
    case 'declined':
      return 'Declined to sign';
    case 'completed':
      return 'Everyone has signed';
    case 'sealed':
      return e.timestamp && e.timestamp !== 'none' ? `Sealed and timestamped (${e.timestamp})` : 'Sealed (no timestamp server answered)';
    default:
      return e.ev;
  }
}

export function eventFrom(e: AuditEvent): string {
  return [shortUa(e.ua), e.geo, e.ip].filter(Boolean).join(' · ');
}

/** Recompute every entry's hash and link. Returns how many check out, and the first bad one. */
export async function verifyChain(events: AuditEvent[]): Promise<{ ok: boolean; good: number; bad: number | null }> {
  let prev = '0'.repeat(64);
  for (let i = 0; i < events.length; i++) {
    const { h, ...rest } = events[i];
    if (rest.prev !== prev || (await sha256hex(JSON.stringify(rest))) !== h) return { ok: false, good: i, bad: i };
    prev = h;
  }
  return { ok: true, good: events.length, bad: null };
}

export function auditCsv(events: AuditEvent[], env: Envelope, state: State): string {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['#', 'Time (UTC)', 'Local time', 'Event', 'Who', 'Email', 'IP address', 'Location', 'Device', 'Previous entry hash', 'Entry hash'];
  const rows = events.map((e) => [e.n, new Date(e.t).toISOString(), formatDate(e.t, true), eventText(e, env), whoName(e, env), whoEmail(e, env), e.ip, e.geo, shortUa(e.ua), e.prev, e.h]);
  const meta = [
    ['Document', env.title || env.docName],
    ['Envelope ID', state.id],
    ['Signed PDF SHA-256', state.sealed?.fingerprint || ''],
  ];
  return [...meta.map((r) => r.map(q).join(',')), '', head.map(q).join(','), ...rows.map((r) => r.map(q).join(','))].join('\r\n') + '\r\n';
}

async function addAuditPage(pdf: PDFDocument, env: Envelope, state: State): Promise<void> {
  const events = state.events || [];
  const chain = await verifyChain(events);
  const perPage = 26;
  for (let start = 0; start < events.length; start += perPage) {
    const chunk = events.slice(start, start + perPage);
    await canvasPage(pdf, (ctx, W, H) => {
      const left = 48;
      let y = 56;
      const text = (t: string, x: number, max: number, size = 8, weight = 400, color = '#333333') => {
        ctx.font = font(size, weight);
        ctx.fillStyle = color;
        ctx.fillText(fit(ctx, t, max), x, y);
      };
      text(start ? 'Audit trail (continued)' : 'Audit trail', left, 400, 20, 600, '#3a2a1f');
      y += 18;
      text(`${env.title || env.docName} · Envelope ${state.id}`, left, W - 2 * left, 9, 400, '#8f7965');
      y += 26;
      const cols = [left, left + 104, left + 304, left + 388];
      ['Time', 'What happened', 'Who', 'From'].forEach((h, i) => text(h, cols[i], (cols[i + 1] || W - left) - cols[i] - 8, 8, 600, '#6b5646'));
      y += 8;
      ctx.fillStyle = '#e6d1b6';
      ctx.fillRect(left, y, W - 2 * left, 1);
      y += 14;
      for (const e of chunk) {
        text(formatDate(e.t, true), cols[0], 108, 7.5);
        text(eventText(e, env), cols[1], 194, 7.5);
        text(whoName(e, env), cols[2], 78, 7.5);
        text(eventFrom(e), cols[3], W - left - cols[3], 7.5, 400, '#6b5646');
        y += 11;
        text(`#${e.n}  ${e.h.slice(0, 32)}…`, cols[1], 260, 6, 400, '#a8917c');
        y += 12;
      }
      if (start + perPage >= events.length) {
        y = H - 64;
        const last = events[events.length - 1];
        text(
          chain.ok
            ? `Chain intact: ${chain.good} of ${events.length} entries check out. Each entry holds the SHA-256 of the one before it.`
            : `Chain check failed at entry ${(chain.bad ?? 0) + 1}.`,
          left, W - 2 * left, 7.5, 600, chain.ok ? '#2f7a52' : '#b0392b'
        );
        y += 12;
        text(`Last entry hash: ${last.h}`, left, W - 2 * left, 7, 400, '#8f7965');
        y += 12;
        text('The seal, its timestamp and the signed PDF fingerprint are recorded in the trail once sealing is done.', left, W - 2 * left, 7, 400, '#8f7965');
      }
    });
  }
}

/**
 * The finished copy everyone gets: the sealed PDF stored once, when signing completed.
 * If nobody has sealed it yet, this browser builds it, seals it and stores it (encrypted).
 */
export async function finalCopy(
  link: { id: string; key: Uint8Array; token: string },
  env: Envelope,
  state: State,
  doc: Uint8Array,
  subs: (Submission | null)[]
): Promise<{ pdf: Uint8Array; state: State; sealed: boolean }> {
  const stored = async (st: State) => {
    const pdf = await decrypt(link.key, await api.getFinal(link.id, link.token));
    if (st.sealed && (await sha256hex(pdf)) !== st.sealed.fingerprint) throw new Error('The stored signed copy does not match its fingerprint.');
    return { pdf, state: st, sealed: true };
  };
  if (state.sealed) return stored(state);
  const built = await buildSignedPdf(doc, env, state, subs);
  let result: { pdf: Uint8Array; seal: SealResult };
  try {
    result = await sealPdf(built, (digest) => api.seal(link.id, link.token, digest));
  } catch (err) {
    const e = err as ApiError;
    if (e.code === 'sealed') return stored(await api.state(link.id, link.token));
    console.warn('Paperhaus seal unavailable', err);
    return { pdf: built, state, sealed: false };
  }
  const fp = await sha256hex(result.pdf);
  try {
    const st = await api.putFinal(link.id, link.token, await encrypt(link.key, result.pdf), fp, { cert: result.seal.cert, timestamp: result.seal.timestamp });
    return { pdf: result.pdf, state: st, sealed: true };
  } catch (err) {
    if ((err as ApiError).code === 'sealed') return stored(await api.state(link.id, link.token));
    console.warn('Could not store the sealed copy', err);
    return { pdf: result.pdf, state, sealed: true };
  }
}

function shortUa(ua: string): string {
  if (!ua) return '';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone or iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
}

export function downloadBytes(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function signedName(env: Envelope): string {
  const base = (env.docName || env.title || 'document').replace(/\.pdf$/i, '');
  return `${base} (signed).pdf`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ---------------------------------------------------------------- the signing record (on screen)

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * The signing record as a sheet over the page: fingerprint, seal, timestamp, the chained
 * audit trail, and a check for any copy of the signed PDF.
 */
export async function openRecord(env: Envelope, state: State, onDownload: (() => void) | null): Promise<void> {
  const events = state.events || [];
  const chain = await verifyChain(events);
  const signed = state.signers.filter((s) => s.signed).length;
  const wrap = document.createElement('div');
  wrap.className = 'es-modal-wrap es-record-wrap';
  wrap.innerHTML = `
    <div class="es-modal es-record" role="dialog" aria-modal="true" aria-label="Signing record">
      <div class="es-record-head">
        <div style="min-width:0;flex:1 1 16rem">
          <div class="es-sub">Signing record</div>
          <h3 class="es-h1 es-record-title" data-title></h3>
        </div>
        <div class="es-row" data-chips></div>
        <button type="button" class="es-btn es-small" data-close aria-label="Close"><i class="ph ph-x"></i></button>
      </div>
      <div class="es-record-facts" data-facts></div>
      <div class="es-record-trail">
        <div class="es-env-head">
          <h4 class="es-h2" style="margin:0">Audit trail</h4>
          <span class="es-record-chain" data-chain></span>
        </div>
        <div class="es-record-table"><table><thead><tr><th>Time</th><th>What happened</th><th>Who</th><th>From</th></tr></thead><tbody data-rows></tbody></table></div>
      </div>
      <div class="es-row" style="margin-top:1rem" data-actions></div>
      <div class="es-note hidden" data-check style="margin-top:0.8rem"></div>
      <p class="es-sub es-record-keep" data-keep></p>
    </div>`;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => wrap.querySelector(sel) as T;
  q('[data-title]').textContent = env.title || env.docName;
  const chip = (text: string, kind = '') => {
    const c = document.createElement('span');
    c.className = `es-chip${kind ? ` ${kind}` : ''}`;
    c.textContent = text;
    q('[data-chips]').appendChild(c);
  };
  chip(state.status === 'complete' ? `Completed · ${signed} of ${state.n} signed` : state.status === 'declined' ? 'Declined' : `${signed} of ${state.n} signed`, state.status === 'complete' ? 'es-good' : state.status === 'declined' ? 'es-bad' : '');
  if (state.sealed) chip('Sealed', 'es-good');
  const facts: [string, string, boolean?][] = [
    ['Signed PDF fingerprint (SHA-256)', state.sealed?.fingerprint || 'Recorded when the signed copy is first opened', !!state.sealed],
    ['Sealed', state.sealed ? `${formatDate(state.sealed.at, true)}, Paperhaus certificate` : 'Not yet'],
    ['Timestamp', state.sealed?.timestamp ? `${state.sealed.timestamp.by} time server (RFC 3161)${state.sealed.timestamp.at ? `, ${formatDate(state.sealed.timestamp.at, true)}` : ''}` : state.sealed ? 'No time server answered' : 'Added with the seal'],
  ];
  for (const [k, v, mono] of facts) {
    const d = document.createElement('div');
    d.className = 'es-record-fact';
    d.innerHTML = '<div class="es-record-k"></div><div class="es-record-v"></div>';
    d.querySelector('.es-record-k')!.textContent = k;
    const val = d.querySelector<HTMLElement>('.es-record-v')!;
    val.textContent = v;
    if (mono) val.classList.add('es-mono');
    q('[data-facts]').appendChild(d);
  }
  const chainEl = q('[data-chain]');
  if (!events.length) chainEl.textContent = 'This request was made before the audit trail existed.';
  else {
    chainEl.innerHTML = `<i class="ph ${chain.ok ? 'ph-link' : 'ph-link-break'}"></i> <span></span>`;
    chainEl.classList.add(chain.ok ? 'es-ok' : 'es-broken');
    chainEl.querySelector('span')!.textContent = chain.ok ? `Chain intact: ${chain.good} of ${events.length} entries check out` : `Chain broken at entry ${(chain.bad ?? 0) + 1}`;
  }
  for (const e of events) {
    const tr = document.createElement('tr');
    for (const v of [formatDate(e.t, true), eventText(e, env), whoName(e, env), eventFrom(e)]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    q('[data-rows]').appendChild(tr);
  }
  const btn = (html: string, fn: () => void, primary = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `es-btn es-small${primary ? ' es-primary' : ''}`;
    b.innerHTML = html;
    b.addEventListener('click', fn);
    q('[data-actions]').appendChild(b);
  };
  if (onDownload && state.status === 'complete') btn('<i class="ph ph-download-simple"></i> Download signed PDF', onDownload, true);
  if (events.length) {
    btn('<i class="ph ph-table"></i> Export audit trail (CSV)', () => {
      const name = `${(env.docName || env.title || 'document').replace(/\.pdf$/i, '')} audit trail.csv`;
      saveBlob(new Blob([auditCsv(events, env, state)], { type: 'text/csv' }), name);
    });
  }
  if (state.sealed) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.hidden = true;
    q('[data-actions]').appendChild(input);
    btn('<i class="ph ph-magnifying-glass"></i> Check a copy of this PDF', () => input.click());
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.value = '';
      if (!f) return;
      const same = (await sha256hex(new Uint8Array(await f.arrayBuffer()))) === state.sealed!.fingerprint;
      const n = q('[data-check]');
      n.className = `es-note ${same ? 'es-good' : 'es-bad'}`;
      n.textContent = same
        ? `"${f.name}" is the signed original, exactly as sealed.`
        : `"${f.name}" is not the signed original. It was changed, or it is a different file.`;
    });
  }
  const until = state.retainUntil || state.expires;
  q('[data-keep]').textContent = `Kept by Paperhaus until ${formatDate(until)}, encrypted, so only people with a signing link can open it.`;
  const close = () => {
    wrap.remove();
    document.body.classList.remove('es-noscroll');
  };
  q('[data-close]').addEventListener('click', close);
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close();
  });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', esc);
    }
  });
  document.body.appendChild(wrap);
  document.body.classList.add('es-noscroll');
}
