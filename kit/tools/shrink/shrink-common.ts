/**
 * Paperhaus: the image and Office tools (Compress Images, Resize Images, Convert Images,
 * Remove photo info, Compress Word, PowerPoint or Excel). Everything runs in this browser:
 * pictures are decoded and re-encoded with the canvas, Office files are opened as the ZIP
 * files they are. Nothing is uploaded.
 *
 * This file holds the shared parts: decoding any picture the browser (or heic2any) can
 * read, encoding JPG, PNG and WebP (PNG through UPNG's colour reduction, which is what
 * makes PNGs much smaller), fitting a size, hitting a target size, and the list of files
 * on each page with before and after sizes.
 */
import '../kit-esign/esign.css';
import '../kit-more/more.css';
import './shrink.css';
import UPNG from 'upng-js';
import JSZip from 'jszip';

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export type Fmt = 'image/jpeg' | 'image/png' | 'image/webp';
export const EXT: Record<Fmt, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// ---------------------------------------------------------------- small UI helpers

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
  toastTimer = window.setTimeout(() => t.classList.add('hidden'), 3200);
}

export function alertBox(title: string, text: string): void {
  const wrap = document.createElement('div');
  wrap.className = 'es-modal-wrap';
  wrap.innerHTML = `<div class="es-modal" role="alertdialog" aria-modal="true"><h3 class="es-modal-title"></h3><p class="es-sub" style="margin-bottom:1rem;white-space:pre-line"></p><div class="es-row" style="justify-content:flex-end"><button class="es-btn es-primary" type="button">OK</button></div></div>`;
  wrap.querySelector('h3')!.textContent = title;
  wrap.querySelector('p')!.textContent = text;
  const close = () => wrap.remove();
  wrap.querySelector('button')!.addEventListener('click', close);
  wrap.addEventListener('click', (e) => e.target === wrap && close());
  document.body.appendChild(wrap);
}

export function onReady(fn: () => void): void {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
  else fn();
}

export function backToTools(): void {
  $('back-to-tools')?.addEventListener('click', () => (location.href = import.meta.env.BASE_URL));
}

export const size = (n: number): string =>
  n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export const baseName = (name: string): string => name.replace(/\.[^.]+$/, '') || 'file';
export const extOf = (name: string): string => ((name.match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();

/** Save a file (Paperhaus keeps it in My documents too). */
export function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function zipAll(files: { name: string; blob: Blob }[], zipName: string): Promise<void> {
  const zip = new JSZip();
  const used = new Set<string>();
  for (const f of files) {
    let name = f.name;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${baseName(f.name)} (${i}).${extOf(f.name)}`;
    used.add(name.toLowerCase());
    zip.file(name, f.blob);
  }
  save(await zip.generateAsync({ type: 'blob', compression: 'STORE' }), zipName);
}

// ---------------------------------------------------------------- pictures in

export const IMAGE_ACCEPT = 'image/*,.heic,.heif,.avif,.jpg,.jpeg,.png,.webp,.gif,.bmp,.svg';

export function isImage(f: File): boolean {
  return /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif|svg)$/i.test(f.name);
}
const isHeic = (f: File): boolean => /heic|heif/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);

/** A picture ready to draw, its size, its type, and whether it has see-through parts. */
export interface Pic {
  src: CanvasImageSource;
  w: number;
  h: number;
  type: string;
  close: () => void;
}

export async function loadPic(file: Blob & { name?: string }): Promise<Pic> {
  let blob: Blob = file;
  let type = file.type || '';
  if (isHeic(file as File)) {
    const heic2any = (await import('heic2any')).default;
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 });
    blob = Array.isArray(out) ? out[0] : out;
    type = 'image/heic';
  }
  if (/svg/i.test(type) || /\.svg$/i.test(file.name || '')) return loadSvg(blob);
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    return { src: bmp, w: bmp.width, h: bmp.height, type, close: () => bmp.close() };
  } catch {
    // Older Safari: through an <img>, which also follows the photo's rotation.
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((ok, bad) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.onerror = () => bad(new Error('unreadable'));
        i.src = url;
      });
      return { src: img, w: img.naturalWidth, h: img.naturalHeight, type, close: () => URL.revokeObjectURL(url) };
    } catch {
      URL.revokeObjectURL(url);
      throw new Error('This picture could not be opened in this browser.');
    }
  }
}

async function loadSvg(blob: Blob): Promise<Pic> {
  const url = URL.createObjectURL(blob);
  const img = await new Promise<HTMLImageElement>((ok, bad) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => bad(new Error('unreadable'));
    i.src = url;
  });
  // SVGs have no pixel size of their own; draw them crisp, at least 2000 px wide.
  const w0 = img.naturalWidth || 1000;
  const h0 = img.naturalHeight || 1000;
  const k = Math.max(1, 2000 / Math.max(w0, h0));
  return { src: img, w: Math.round(w0 * k), h: Math.round(h0 * k), type: 'image/svg+xml', close: () => URL.revokeObjectURL(url) };
}

// ---------------------------------------------------------------- pictures out

/** Draw a picture at w x h. A white background goes under it for JPG (no see-through). */
export function draw(pic: Pic, w: number, h: number, fmt: Fmt): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d')!;
  if (fmt === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Big step-downs look sharper done in halves.
  let src: CanvasImageSource = pic.src;
  let sw = pic.w;
  let sh = pic.h;
  while (sw / 2 > c.width && sh / 2 > c.height) {
    const t = document.createElement('canvas');
    t.width = Math.round(sw / 2);
    t.height = Math.round(sh / 2);
    const tx = t.getContext('2d')!;
    tx.imageSmoothingQuality = 'high';
    tx.drawImage(src, 0, 0, t.width, t.height);
    src = t;
    sw = t.width;
    sh = t.height;
  }
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export function hasAlpha(c: HTMLCanvasElement): boolean {
  const ctx = c.getContext('2d')!;
  const step = Math.max(1, Math.floor(Math.sqrt((c.width * c.height) / 40000)));
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  for (let y = 0; y < c.height; y += step) {
    for (let x = 0; x < c.width; x += step) if (d[(y * c.width + x) * 4 + 3] < 250) return true;
  }
  return false;
}

/** Encode. quality 0-1 for JPG and WebP; for PNG it picks how many colours to keep. */
export async function encode(c: HTMLCanvasElement, fmt: Fmt, quality: number): Promise<Blob> {
  if (fmt === 'image/png') {
    const colors = quality >= 0.99 ? 0 /* lossless, packed tighter than the browser does */ : quality >= 0.9 ? 256 : quality >= 0.75 ? 192 : quality >= 0.6 ? 128 : quality >= 0.45 ? 64 : 32;
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const png = UPNG.encode([data.buffer.slice(0)], c.width, c.height, colors);
    return new Blob([png], { type: 'image/png' });
  }
  const b = await canvasBlob(c, fmt, quality);
  // Browsers that can't write WebP hand back a PNG; use JPG then.
  if (fmt === 'image/webp' && b.type !== 'image/webp') return canvasBlob(c, 'image/jpeg', quality);
  return b;
}

function canvasBlob(c: HTMLCanvasElement, type: string, q: number): Promise<Blob> {
  return new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('Could not save the picture.'))), type, q));
}

export function canWebp(): boolean {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  return c.toDataURL('image/webp').startsWith('data:image/webp');
}

/** The size that fits inside maxSide on its longest side (never larger than it is). */
export function fit(w: number, h: number, maxSide: number): [number, number] {
  const k = maxSide > 0 ? Math.min(1, maxSide / Math.max(w, h)) : 1;
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

/**
 * The best-looking file under `target` bytes: first the highest quality that fits, then, if
 * even low quality is too big, a smaller picture. Returns the smallest it got if nothing fits.
 */
export async function toTarget(pic: Pic, fmt: Fmt, target: number, maxSide = 0): Promise<{ blob: Blob; w: number; h: number; fits: boolean }> {
  let [w, h] = fit(pic.w, pic.h, maxSide);
  let best: { blob: Blob; w: number; h: number } | null = null;
  for (let round = 0; round < 12; round++) {
    const c = draw(pic, w, h, fmt);
    if (fmt === 'image/png') {
      for (const q of [0.95, 0.8, 0.65, 0.5, 0.4]) {
        const b = await encode(c, fmt, q);
        if (!best || b.size < best.blob.size) best = { blob: b, w, h };
        if (b.size <= target) return { blob: b, w, h, fits: true };
      }
    } else {
      // Binary search on quality between 0.35 and 0.92.
      let lo = 0.35;
      let hi = 0.92;
      let found: Blob | null = null;
      const top = await encode(c, fmt, hi);
      if (top.size <= target) return { blob: top, w, h, fits: true };
      const low = await encode(c, fmt, lo);
      if (!best || low.size < best.blob.size) best = { blob: low, w, h };
      if (low.size <= target) {
        found = low;
        for (let i = 0; i < 6; i++) {
          const mid = (lo + hi) / 2;
          const b = await encode(c, fmt, mid);
          if (b.size <= target) {
            found = b;
            lo = mid;
          } else hi = mid;
        }
        return { blob: found, w, h, fits: true };
      }
    }
    // Still too big: make the picture smaller and try again.
    const k = Math.max(0.5, Math.min(0.85, Math.sqrt(target / (best ? best.blob.size : target * 2)) * 0.95));
    w = Math.round(w * k);
    h = Math.round(h * k);
    if (Math.max(w, h) < 160) break;
  }
  return { ...(best as { blob: Blob; w: number; h: number }), fits: false };
}

/** The output format for "keep the same": JPG stays JPG, PNG stays PNG, WebP stays WebP, others become JPG (PNG if see-through). */
export function sameFormat(type: string, alpha: boolean): Fmt {
  if (/png/.test(type)) return 'image/png';
  if (/webp/.test(type)) return canWebp() ? 'image/webp' : alpha ? 'image/png' : 'image/jpeg';
  if (/jpe?g/.test(type)) return 'image/jpeg';
  return alpha ? 'image/png' : 'image/jpeg';
}

export function typeOf(f: File): string {
  if (f.type) return f.type;
  const e = extOf(f.name);
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', svg: 'image/svg+xml' }[e] || '';
}

// ---------------------------------------------------------------- the file list on each page

export interface Item {
  file: File;
  row: HTMLElement;
  out: { blob: Blob; name: string } | null;
}

/**
 * Wires the drop zone and file list. Rows show name, size and (after running) the new size
 * with a Download button. `accept` filters what is kept.
 */
export function fileList(opts: { accept: (f: File) => boolean; wrong: string; multiple?: boolean; onChange?: () => void; onAdd?: (it: Item) => void }) {
  const items: Item[] = [];
  const drop = $('mt-drop');
  const input = $<HTMLInputElement>('mt-file');
  const list = $('sh-list');
  const add = (files: File[]) => {
    const good = files.filter(opts.accept);
    if (files.length && !good.length) alertBox('That file does not fit here', opts.wrong);
    if (opts.multiple === false) items.splice(0).forEach((it) => it.row.remove());
    for (const f of good.slice(0, opts.multiple === false ? 1 : 200)) {
      const row = document.createElement('div');
      row.className = 'sh-row';
      row.innerHTML = `<span class="sh-thumb"><i class="ph ph-file"></i></span><div class="sh-info"><strong></strong><span class="sh-meta"></span></div><div class="sh-acts"><button type="button" class="es-btn es-small sh-remove" aria-label="Remove"><i class="ph ph-x"></i></button></div>`;
      row.querySelector('strong')!.textContent = f.name;
      row.querySelector('.sh-meta')!.textContent = size(f.size);
      const item: Item = { file: f, row, out: null };
      row.querySelector<HTMLButtonElement>('.sh-remove')!.onclick = () => {
        items.splice(items.indexOf(item), 1);
        row.remove();
        refresh();
      };
      if (isImage(f) && !/heic|heif/i.test(f.type + f.name)) {
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        const url = URL.createObjectURL(f);
        img.onload = () => setTimeout(() => URL.revokeObjectURL(url), 1000);
        img.src = url;
        row.querySelector('.sh-thumb')!.replaceChildren(img);
      } else if (/heic|heif/i.test(f.type + f.name)) row.querySelector('.sh-thumb')!.innerHTML = '<i class="ph ph-image"></i>';
      list.appendChild(row);
      items.push(item);
      opts.onAdd?.(item);
    }
    refresh();
  };
  const refresh = () => {
    $('sh-files').classList.toggle('hidden', !items.length);
    drop.classList.toggle('sh-drop-small', items.length > 0);
    opts.onChange?.();
  };
  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    input.value = '';
    add(files);
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    add(Array.from(e.dataTransfer?.files || []));
  });
  $('sh-clear')?.addEventListener('click', () => {
    items.splice(0).forEach((it) => it.row.remove());
    refresh();
  });
  return { items, add };
}

/** After running: show the new size and a Download button on a row. */
export function showResult(it: Item, out: { blob: Blob; name: string }, note = ''): void {
  it.out = out;
  const meta = it.row.querySelector('.sh-meta')!;
  const saved = it.file.size - out.blob.size;
  const pct = it.file.size ? Math.round((saved / it.file.size) * 100) : 0;
  meta.innerHTML = '';
  const before = document.createElement('s');
  before.textContent = size(it.file.size);
  const after = document.createElement('b');
  after.textContent = size(out.blob.size);
  meta.append(before, ' → ', after);
  if (pct > 0) {
    const tag = document.createElement('span');
    tag.className = 'sh-pct';
    tag.textContent = `${pct}% smaller`;
    meta.append(' ', tag);
  }
  if (note) meta.append(` · ${note}`);
  const acts = it.row.querySelector('.sh-acts')!;
  acts.querySelector('.sh-dl')?.remove();
  const dl = document.createElement('button');
  dl.type = 'button';
  dl.className = 'es-btn es-small sh-dl';
  dl.innerHTML = '<i class="ph ph-download-simple"></i> Download';
  dl.onclick = () => save(out.blob, out.name);
  acts.prepend(dl);
}

export function showError(it: Item, text: string): void {
  it.out = null;
  const meta = it.row.querySelector('.sh-meta')!;
  meta.textContent = `${size(it.file.size)} · ${text}`;
  it.row.classList.add('sh-bad');
}

/** Show the totals and the Download all button once a run is done. */
export function finish(items: Item[], zipName: string): void {
  const done = items.filter((i) => i.out);
  const box = $('sh-done');
  box.classList.toggle('hidden', !done.length);
  if (!done.length) return;
  const before = done.reduce((n, i) => n + i.file.size, 0);
  const after = done.reduce((n, i) => n + (i.out as { blob: Blob }).blob.size, 0);
  const pct = before ? Math.round(((before - after) / before) * 100) : 0;
  $('sh-total').textContent = done.length === 1 ? `${size(before)} → ${size(after)}${pct > 0 ? ` (${pct}% smaller)` : ''}` : `${done.length} files · ${size(before)} → ${size(after)}${pct > 0 ? ` (${pct}% smaller)` : ''}`;
  const all = $<HTMLButtonElement>('sh-all');
  all.innerHTML = done.length > 1 ? '<i class="ph ph-file-zip"></i> Download all (ZIP)' : '<i class="ph ph-download-simple"></i> Download';
  all.onclick = () => {
    if (done.length === 1) save(done[0].out!.blob, done[0].out!.name);
    else void zipAll(done.map((i) => i.out!), zipName);
  };
}

/** Read the "Target size" box: bytes, or 0 when empty. */
export function targetBytes(numId: string, unitId: string): number {
  const v = parseFloat(($<HTMLInputElement>(numId).value || '').replace(',', '.'));
  if (!(v > 0)) return 0;
  return Math.round(v * ($<HTMLSelectElement>(unitId).value === 'mb' ? 1048576 : 1024));
}

/** Let the browser breathe between big pictures (keeps the page responsive). */
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
