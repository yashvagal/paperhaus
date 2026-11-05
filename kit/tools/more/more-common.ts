/**
 * Paperhaus: pieces shared by the tools added to match iLovePDF's list
 * (PDF to PowerPoint, HTML to PDF, Redact PDF, Summarize PDF, Translate PDF).
 * Written for Paperhaus from its own spec; nothing here comes from iLovePDF.
 */
import '../../utils/map-upsert-polyfill.js';
import * as pdfjsLib from 'pdfjs-dist';
import '../../utils/setup-pdf-worker.js';
import '../kit-esign/esign.css';
import './more.css';

export { pdfjsLib };
export type PdfDoc = pdfjsLib.PDFDocumentProxy;
export type PdfPage = pdfjsLib.PDFPageProxy;

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export function openPdf(bytes: Uint8Array, password?: string): Promise<PdfDoc> {
  return pdfjsLib.getDocument({ data: bytes.slice(), password }).promise;
}

// ---------------------------------------------------------------- busy, toast, alerts

export function busy(text: string | null, progress?: number): void {
  const b = $('mt-busy');
  if (!b) return;
  b.classList.toggle('hidden', text === null);
  if (text) $('mt-busy-text').textContent = text;
  const bar = $('mt-busy-bar');
  if (bar) {
    bar.classList.toggle('hidden', progress === undefined);
    if (progress !== undefined) bar.style.setProperty('--p', `${Math.round(progress * 100)}%`);
  }
}

let toastTimer = 0;
export function toast(text: string): void {
  const t = $('mt-toast');
  if (!t) return;
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.add('hidden'), 2800);
}

export function alertBox(title: string, text: string): void {
  const wrap = document.createElement('div');
  wrap.className = 'es-modal-wrap';
  wrap.innerHTML = `<div class="es-modal" role="alertdialog" aria-modal="true"><h3 class="es-h2"></h3><p class="es-sub" style="margin-bottom:1rem;white-space:pre-line"></p><div class="es-row" style="justify-content:flex-end"><button class="es-btn es-primary" type="button">OK</button></div></div>`;
  wrap.querySelector('h3')!.textContent = title;
  wrap.querySelector('p')!.textContent = text;
  const close = () => wrap.remove();
  wrap.querySelector('button')!.addEventListener('click', close);
  wrap.addEventListener('click', (e) => e.target === wrap && close());
  document.body.appendChild(wrap);
  wrap.querySelector('button')!.focus();
}

// ---------------------------------------------------------------- files

export function download(data: Uint8Array | Blob | string, name: string, type = 'application/pdf'): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export const baseName = (name: string) => name.replace(/\.[^.]+$/, '') || 'document';

/** Wire a drop zone (label) and its file input; calls back with the first file. */
export function pickFile(dropId: string, inputId: string, onFile: (f: File) => void): void {
  const drop = $(dropId);
  const input = $<HTMLInputElement>(inputId);
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    input.value = '';
    if (f) onFile(f);
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  });
}

export async function readPdf(file: File): Promise<{ bytes: Uint8Array; pdf: PdfDoc } | null> {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    alertBox('Not a PDF', 'Choose a PDF file.');
    return null;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return { bytes, pdf: await openPdf(bytes) };
  } catch (err) {
    const name = (err as Error)?.name || '';
    if (name === 'PasswordException') {
      alertBox('This PDF has a password', 'Remove it with Unlock PDF first, then try again.');
    } else {
      alertBox('Could not open this PDF', 'It may be damaged. Try Repair PDF first.');
    }
    return null;
  }
}

export function backToTools(): void {
  $('back-to-tools')?.addEventListener('click', () => (location.href = import.meta.env.BASE_URL));
}

export function onReady(fn: () => void): void {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
  else fn();
}

// ---------------------------------------------------------------- page text

export interface Line {
  text: string;
  /** Viewport box at scale 1, top-left origin, in PDF points. */
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  family: string;
  /** Radians; non-zero lines are single turned runs (see TextBit). */
  angle: number;
  items: TextBit[];
}

export interface TextBit {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 'serif', 'sans-serif' or 'monospace', as pdf.js reports the font. */
  family: string;
  /** pdf.js font id, to look up the real font name (bold, italic) after rendering. */
  fontName: string;
  /** Text direction in radians (0 = left to right); turned text has a baseline origin and length. */
  angle: number;
  ox: number;
  oy: number;
  len: number;
  /** Font height in points. */
  fh: number;
}

/**
 * The page's text as lines, in reading order, with boxes in viewport space (scale 1,
 * rotation applied, top-left origin). Bits on one baseline and close together join.
 */
export async function pageLines(page: PdfPage): Promise<Line[]> {
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const bits: TextBit[] = [];
  const styles = content.styles as Record<string, { fontFamily?: string }>;
  for (const it of content.items as Array<{ str: string; transform: number[]; width: number; height: number; fontName: string }>) {
    if (!('str' in it) || !it.str) continue;
    const family = styles[it.fontName]?.fontFamily || 'sans-serif';
    const m = pdfjsLib.Util.transform(vp.transform, it.transform);
    const fontH = Math.hypot(m[2], m[3]) || it.height || 10;
    const angle = Math.atan2(m[1], m[0]);
    const scaleX = Math.hypot(m[0], m[1]) / (Math.hypot(it.transform[0], it.transform[1]) || 1);
    const w = (it.width || 0) * scaleX;
    // Only horizontal text is grouped into lines; turned text is kept as its own line.
    const x = m[4];
    const yBase = m[5];
    const base = { str: it.str, family, fontName: it.fontName, angle: 0, ox: x, oy: yBase, len: w, fh: fontH };
    if (Math.abs(angle) > 0.05) {
      // Box around the turned text: its baseline runs along (cos, sin), its height "up" from it.
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      const upx = uy * fontH;
      const upy = -ux * fontH;
      const xs = [x, x + ux * w, x + upx, x + ux * w + upx];
      const ys = [yBase, yBase + uy * w, yBase + upy, yBase + uy * w + upy];
      const bx = Math.min(...xs);
      const by = Math.min(...ys);
      bits.push({ ...base, angle, x: bx, y: by, w: Math.max(...xs) - bx, h: Math.max(...ys) - by });
      continue;
    }
    bits.push({ ...base, x, y: yBase - fontH * 0.88, w, h: fontH * 1.12 });
  }
  bits.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Line[] = [];
  for (const b of bits) {
    const last = lines[lines.length - 1];
    const lb = last?.items[last.items.length - 1];
    const sameLine = last && !b.angle && !lb!.angle && Math.abs(last.y + last.h / 2 - (b.y + b.h / 2)) < Math.min(last.h, b.h) * 0.45;
    const near = lb && b.x - (lb.x + lb.w) < Math.max(last!.size * 1.8, 6) && b.x >= lb.x - 1;
    if (last && sameLine && near) {
      const gap = b.x - (lb!.x + lb!.w);
      last.text += (gap > last.size * 0.18 && !/\s$/.test(last.text) && !/^\s/.test(b.str) ? ' ' : '') + b.str;
      const right = Math.max(last.x + last.w, b.x + b.w);
      last.y = Math.min(last.y, b.y);
      last.h = Math.max(last.h, b.h);
      last.x = Math.min(last.x, b.x);
      last.w = right - last.x;
      last.items.push(b);
    } else {
      const size = b.angle ? b.fh : b.h / 1.12;
      lines.push({ text: b.str, x: b.x, y: b.y, w: b.w, h: b.h, size, family: b.family, angle: b.angle, items: [b] });
    }
  }
  for (const l of lines) l.text = l.text.replace(/\s+/g, ' ').trim();
  return lines.filter((l) => l.text);
}

/** Plain text of a whole PDF, page by page. */
export async function pdfText(pdf: PdfDoc, onPage?: (i: number) => void): Promise<string[]> {
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    onPage?.(i);
    const page = await pdf.getPage(i);
    const lines = await pageLines(page);
    out.push(joinLines(lines));
    page.cleanup();
  }
  return out;
}

/** Join lines into paragraphs: a bigger gap, or a short line, ends a paragraph. */
export function joinLines(lines: Line[]): string {
  let s = '';
  lines.forEach((l, i) => {
    const prev = lines[i - 1];
    if (!prev) s = l.text;
    else {
      const gap = l.y - (prev.y + prev.h);
      const para = gap > prev.h * 0.6 || l.x - prev.x > prev.size * 2;
      s += para ? `\n\n${l.text}` : /-$/.test(s) ? l.text : ` ${l.text}`;
    }
  });
  return s.replace(/(\w)- (\w)/g, '$1$2');
}

/** Render a page to a canvas at a given scale; optionally without its text. */
export async function renderPage(page: PdfPage, scale: number, opts: { noText?: boolean } = {}): Promise<HTMLCanvasElement> {
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (opts.noText) {
    // pdf.js draws font glyphs with fillText/strokeText, so turning those off leaves
    // the page's pictures, lines and fills without the words on top.
    ctx.fillText = () => undefined;
    ctx.strokeText = () => undefined;
  }
  await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
  if (opts.noText) {
    // Give the canvas its normal text drawing back for whoever draws on it next.
    delete (ctx as unknown as Record<string, unknown>).fillText;
    delete (ctx as unknown as Record<string, unknown>).strokeText;
  }
  return canvas;
}

/**
 * Left edges of each character of a text run, plus its right end (str.length + 1 values),
 * in page points. pdf.js gives only the whole run's width, so the letters are measured in
 * a similar font and scaled to fit; far closer than spacing them evenly.
 */
const edgeCache = new WeakMap<TextBit, number[]>();
let measureCtx: CanvasRenderingContext2D | null = null;
export function charEdges(b: TextBit): number[] {
  const hit = edgeCache.get(b);
  if (hit) return hit;
  measureCtx ||= document.createElement('canvas').getContext('2d')!;
  const fam = b.family === 'serif' ? '"Times New Roman", Times, serif' : b.family === 'monospace' ? '"Courier New", monospace' : 'Arial, Helvetica, sans-serif';
  measureCtx.font = `100px ${fam}`;
  const chars = [...b.str];
  const widths = chars.map((c) => measureCtx!.measureText(c).width || 50);
  const total = widths.reduce((a, w) => a + w, 0) || 1;
  const out = [b.x];
  let acc = 0;
  for (const w of widths) {
    acc += w;
    out.push(b.x + (acc / total) * b.w);
  }
  // Characters outside the BMP count as one; map back to UTF-16 indexes.
  if (chars.length !== b.str.length) {
    const byUnit: number[] = [];
    chars.forEach((c, i) => {
      byUnit.push(out[i]);
      if (c.length === 2) byUnit.push(out[i]);
    });
    byUnit.push(out[out.length - 1]);
    edgeCache.set(b, byUnit);
    return byUnit;
  }
  edgeCache.set(b, out);
  return out;
}

export function canvasBlob(c: HTMLCanvasElement, type = 'image/jpeg', q = 0.88): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the image'))), type, q));
}

export async function blobBytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

/** One small page preview, as an <img>. */
export async function thumb(pdf: PdfDoc, n: number, width = 220): Promise<HTMLImageElement> {
  const page = await pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const c = await renderPage(page, (width * Math.min(window.devicePixelRatio || 1, 2)) / base.width);
  const img = new Image();
  img.src = c.toDataURL('image/jpeg', 0.8);
  img.alt = `Page ${n}`;
  page.cleanup();
  return img;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Copied');
  }
}

/** Draw text wrapped into a box on a canvas, shrinking the size until it fits. Returns the size used. */
export function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  startSize: number,
  font = 'system-ui, -apple-system, "Segoe UI", "Noto Sans", sans-serif',
  color = '#111'
): number {
  let size = startSize;
  let lines: string[] = [];
  for (let tries = 0; tries < 24; tries++) {
    ctx.font = `${size}px ${font}`;
    lines = wrap(ctx, text, w);
    if (lines.length * size * 1.18 <= h * 1.04 || size <= 4) break;
    size *= 0.92;
  }
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * size * 1.18));
  return size;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, w: number): string[] {
  const words = text.split(/(\s+)/);
  const out: string[] = [];
  let cur = '';
  for (const word of words) {
    const next = cur + word;
    if (cur && ctx.measureText(next.trimEnd()).width > w) {
      out.push(cur.trimEnd());
      cur = word.trimStart();
    } else cur = next;
  }
  if (cur.trim()) out.push(cur.trimEnd());
  // A single word wider than the box is split by characters (CJK and long words).
  return out.flatMap((l) => {
    if (ctx.measureText(l).width <= w * 1.02) return [l];
    const parts: string[] = [];
    let p = '';
    for (const ch of l) {
      if (p && ctx.measureText(p + ch).width > w) {
        parts.push(p);
        p = ch;
      } else p += ch;
    }
    if (p) parts.push(p);
    return parts;
  });
}

/** After a page has been rendered, tell whether a text bit's font is bold or italic. */
export function fontStyle(page: PdfPage, fontName: string): { bold: boolean; italic: boolean } {
  try {
    const objs = (page as unknown as { commonObjs: { has(id: string): boolean; get(id: string): { name?: string; bold?: boolean; italic?: boolean } } }).commonObjs;
    if (!objs.has(fontName)) return { bold: false, italic: false };
    const f = objs.get(fontName);
    const n = (f.name || '').toLowerCase();
    return { bold: !!f.bold || /bold|black|heavy|semibold|demi/.test(n), italic: !!f.italic || /italic|oblique/.test(n) };
  } catch {
    return { bold: false, italic: false };
  }
}
