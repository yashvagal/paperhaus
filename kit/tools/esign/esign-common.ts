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
}

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

export interface State {
  id: string;
  role: 'signer' | 'sender' | 'reader';
  index: number | null;
  n: number;
  ordered: boolean;
  sender: string;
  created: number;
  expires: number;
  status: 'out' | 'complete' | 'declined' | 'cancelled';
  declined: (Stamp & { index: number; reason: string | null }) | null;
  signers: { viewed: Stamp | null; signed: Stamp | null }[];
  envelope?: string;
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
  pdf.setTitle(env.title);
  pdf.setSubject(`Signed with Paperhaus. Envelope ${state.id}.`);
  pdf.setProducer('Paperhaus');
  pdf.setModificationDate(new Date());
  view.destroy();
  return pdf.save();
}

async function addCertificate(
  pdf: PDFDocument,
  env: Envelope,
  state: State,
  subs: (Submission | null)[],
  original: Uint8Array
): Promise<void> {
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
  const font = (size: number, weight = 400) => `${weight} ${size}px "Poppins", "Noto Sans", system-ui, sans-serif`;
  let y = 56;
  const left = 48;
  const line = (text: string, size = 9, weight = 400, color = '#333333', x = left) => {
    ctx.font = font(size, weight);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };
  ctx.textBaseline = 'alphabetic';
  line('Signing certificate', 20, 600, '#3a2a1f');
  y += 18;
  line('Paperhaus electronic signatures', 9, 400, '#8f7965');
  y += 26;
  const hash = await sha256hex(original);
  const rows: [string, string][] = [
    ['Document', env.title || env.docName],
    ['Envelope ID', state.id],
    ['Sent by', `${env.sender.name} <${env.sender.email}>`],
    ['Sent on', formatDate(env.createdAt, true)],
    ['Signing order', env.ordered ? 'In order' : 'Any order'],
    ['Original SHA-256', hash],
  ];
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
    line(`${i + 1}. ${s.name}`, 11, 600, '#3a2a1f');
    y += 15;
    line(s.email, 8.5, 400, '#6b5646');
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
      ctx.font = font(7.5);
      ctx.fillStyle = '#6b5646';
      ctx.fillText(`Agreed: "${sub.consent}"`, left + 12, y);
      y += 13;
    }
    y += 12;
  }
  y = H - 40;
  line('Every signer opened their own private link and agreed to sign electronically. Times are as recorded by Paperhaus.', 7, 400, '#8f7965');
  const png = c.toDataURL('image/png');
  const img = await pdf.embedPng(dataUrlBytes(png));
  const page = pdf.addPage([W, H]);
  page.drawImage(img, { x: 0, y: 0, width: W, height: H });
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
