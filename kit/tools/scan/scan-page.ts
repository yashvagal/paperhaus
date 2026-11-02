/* Paperhaus Scan: a CamScanner-style scanner that runs entirely in the browser.
 *
 * Camera (live edge detection, auto-capture, tap to focus and a focus slider,
 * flashlight, one page or many pages per session), photo import,
 * crop with draggable corners and a magnifier, enhance filters, page reordering,
 * ID card and book modes, QR codes, and export to PDF (optionally searchable and
 * password protected), images, the share sheet, or plain text.
 *
 * Image work happens in scan-worker.js (OpenCV.js in a web worker). Unfinished
 * scans are kept in this browser's IndexedDB, on this device only.
 */
import './scan.css';
import Sortable from 'sortablejs';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { showAlert, showLoader, hideLoader } from '../../ui.js';
import { downloadFile, formatBytes, initializeQpdf } from '../../utils/helpers.js';
import { performOcr } from '../../utils/ocr.js';
import { createConfiguredTesseractWorker } from '../../utils/tesseract-runtime.js';
import { getAvailableTesseractLanguageEntries } from '../../utils/tesseract-language-availability.js';

// ------------------------------------------------------------------ types

type Pt = [number, number];
type Corners = [Pt, Pt, Pt, Pt];
type Filter = 'original' | 'magic' | 'lighten' | 'gray' | 'bw' | 'whiteboard';
type Kind = 'doc' | 'id' | 'book';
type Mode = Kind | 'qr';

interface Shot {
  blob: Blob;
  w: number;
  h: number;
  corners: Corners;
  /** The edges found when the photo was added, so "Auto" can return to them. */
  auto?: Corners | null;
}

interface Page {
  id: string;
  kind: Kind;
  shots: Shot[];
  rotation: number;
  filter: Filter;
  brightness: number;
  contrast: number;
  split: number;
}

interface Rendered {
  blob: Blob;
  w: number;
  h: number;
}

interface OutputPage {
  layout: 'image' | 'id';
  images: Rendered[];
}

const FILTERS: Array<[Filter, string]> = [
  ['magic', 'Magic'],
  ['original', 'Original'],
  ['lighten', 'Lighten'],
  ['gray', 'Grayscale'],
  ['bw', 'Black & white'],
  ['whiteboard', 'Whiteboard'],
];

const QUALITY = {
  high: { maxSide: 3000, quality: 0.9 },
  balanced: { maxSide: 2000, quality: 0.82 },
  small: { maxSide: 1400, quality: 0.68 },
} as const;

const ID_ASPECT = 85.6 / 54;
const MM = 72 / 25.4;
const SIZES: Record<string, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

const FULL: Corners = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

const MODE_HINTS: Record<Mode, string> = {
  doc: 'Scan one or many pages. Each page is cropped and cleaned up automatically.',
  id: 'Scan the front, then the back. Both sides go on one page at real card size, ready to print.',
  book: 'Scan an open book. Each photo of two facing pages becomes two PDF pages.',
  qr: 'Point the camera at a QR code to read it. Links are shown before anything opens.',
};
const MODE_NAMES: Record<Mode, string> = { doc: 'Document', id: 'ID card', book: 'Book', qr: 'QR code' };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------ state

const state = {
  mode: 'doc' as Mode,
  pages: [] as Page[],
  qr: [] as string[],
};

const settings = {
  name: '',
  size: 'fit',
  quality: 'balanced' as keyof typeof QUALITY,
  filter: 'magic' as Filter,
  ocr: false,
  lang: 'eng',
};

const thumbs = new Map<string, string>();
let pendingIdPage: Page | null = null;

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function defaultName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `Scan ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

function cleanName(): string {
  const n = (settings.name || defaultName()).replace(/[\\/:*?"<>|]+/g, ' ').trim();
  return n || 'Scan';
}

// ------------------------------------------------------------------ engine

class Engine {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ready: Promise<unknown>;

  constructor() {
    const url = `${import.meta.env.VITE_SCAN_WORKER_URL}?cv=${encodeURIComponent(import.meta.env.VITE_OPENCV_URL)}`;
    this.worker = new Worker(url);
    this.worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error));
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Scanner engine failed to load'));
      this.pending.clear();
    };
    this.ready = this.call('init', {});
  }

  call<T = any>(type: string, args: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...args }, transfer);
    });
  }
}

let engine: Engine | null = null;
let engineLoaded = false;

async function getEngine(): Promise<Engine> {
  if (!engine) engine = new Engine();
  if (!engineLoaded) {
    const slow = setTimeout(() => showLoader('Loading the scanner (first time only)...'), 300);
    try {
      await engine.ready;
      engineLoaded = true;
    } catch (err) {
      engine = null;
      throw err;
    } finally {
      clearTimeout(slow);
      hideLoader();
    }
  }
  return engine;
}

// ------------------------------------------------------------------ storage

const DB_NAME = 'paperhaus-scan';
let dbPromise: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

async function dbSet(key: string, value: unknown): Promise<void> {
  const d = await db();
  if (!d) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = d.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function dbGet<T>(key: string): Promise<T | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    try {
      const req = d.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

let saveTimer = 0;
function persist(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void dbSet('pages', state.pages);
    void dbSet('qr', state.qr);
    void dbSet('settings', { ...settings, name: settings.name });
  }, 300);
}

async function restore(): Promise<void> {
  const pages = await dbGet<Page[]>('pages');
  const qr = await dbGet<string[]>('qr');
  const saved = await dbGet<typeof settings>('settings');
  if (saved) Object.assign(settings, saved);
  if (Array.isArray(pages)) state.pages = pages.filter((p) => p && Array.isArray(p.shots) && p.shots.length);
  if (Array.isArray(qr)) state.qr = qr;
}

// ------------------------------------------------------------------ rendering

async function renderShot(page: Page, shot: Shot, maxSide: number, format: 'jpeg' | 'png', quality: number, opts: { aspect?: number; rotate?: boolean } = {}): Promise<Rendered> {
  const e = await getEngine();
  return e.call<Rendered>('render', {
    blob: shot.blob,
    corners: shot.corners,
    rotation: opts.rotate === false ? 0 : page.rotation,
    filter: page.filter,
    brightness: page.brightness,
    contrast: page.contrast,
    maxSide,
    aspect: opts.aspect || 0,
    format,
    quality,
  });
}

async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function canvasBlob(c: HTMLCanvasElement, format: 'jpeg' | 'png', quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), `image/${format}`, quality)
  );
}

async function splitSpread(r: Rendered, split: number, format: 'jpeg' | 'png', quality: number): Promise<Rendered[]> {
  const img = await loadImage(r.blob);
  const cut = Math.round(r.w * split);
  const out: Rendered[] = [];
  for (const [x, w] of [
    [0, cut],
    [cut, r.w - cut],
  ]) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = r.h;
    c.getContext('2d')!.drawImage(img, x, 0, w, r.h, 0, 0, w, r.h);
    out.push({ blob: await canvasBlob(c, format, quality), w, h: r.h });
    c.width = c.height = 0;
  }
  return out;
}

/** Render a page into the image(s) that go into the PDF. */
async function outputFor(page: Page, maxSide: number, format: 'jpeg' | 'png', quality: number): Promise<OutputPage[]> {
  if (page.kind === 'id') {
    const cardSide = Math.min(maxSide, 1400);
    const images: Rendered[] = [];
    for (const shot of page.shots) images.push(await renderShot(page, shot, cardSide, format, quality, { aspect: ID_ASPECT }));
    return [{ layout: 'id', images }];
  }
  const r = await renderShot(page, page.shots[0], maxSide, format, quality);
  if (page.kind === 'book') {
    const halves = await splitSpread(r, page.split / 100, format, quality);
    return halves.map((h) => ({ layout: 'image', images: [h] }));
  }
  return [{ layout: 'image', images: [r] }];
}

/** ID card pages as a flat picture (for thumbnails and image export). */
async function composeId(images: Rendered[], longSide: number, format: 'jpeg' | 'png', quality: number): Promise<Rendered> {
  const [pw, ph] = SIZES.a4;
  const scale = longSide / ph;
  const c = document.createElement('canvas');
  c.width = Math.round(pw * scale);
  c.height = Math.round(ph * scale);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  const boxes = idBoxes(images, pw, ph);
  for (let i = 0; i < images.length; i++) {
    const img = await loadImage(images[i].blob);
    const b = boxes[i];
    ctx.drawImage(img, b.x * scale, (ph - b.y - b.h) * scale, b.w * scale, b.h * scale);
  }
  const blob = await canvasBlob(c, format, quality);
  const out = { blob, w: c.width, h: c.height };
  c.width = c.height = 0;
  return out;
}

/** Card boxes in PDF points (origin bottom-left), at real ID-1 size, stacked and centred. */
function idBoxes(images: Rendered[], pw: number, ph: number) {
  const gap = 14 * MM;
  const sizes = images.map((r) => (r.w >= r.h ? [85.6 * MM, 54 * MM] : [54 * MM, 85.6 * MM]));
  const total = sizes.reduce((a, s) => a + s[1], 0) + gap * (sizes.length - 1);
  let top = ph - Math.max(40 * MM, (ph - total) / 2.6);
  return sizes.map(([w, h]) => {
    const box = { x: (pw - w) / 2, y: top - h, w, h };
    top -= h + gap;
    return box;
  });
}

async function thumbFor(page: Page): Promise<string> {
  const cached = thumbs.get(page.id);
  if (cached) return cached;
  let r: Rendered;
  if (page.kind === 'id') {
    const out = await outputFor(page, 700, 'jpeg', 0.8);
    r = await composeId(out[0].images, 640, 'jpeg', 0.8);
  } else {
    r = await renderShot(page, page.shots[0], 640, 'jpeg', 0.8);
  }
  const url = URL.createObjectURL(r.blob);
  thumbs.set(page.id, url);
  return url;
}

function dropThumb(id: string): void {
  const url = thumbs.get(id);
  if (url) URL.revokeObjectURL(url);
  thumbs.delete(id);
}

// ------------------------------------------------------------------ pages UI

function pageCount(): number {
  return state.pages.reduce((n, p) => n + (p.kind === 'book' ? 2 : 1), 0);
}

let sortable: Sortable | null = null;

function renderGrid(): void {
  const grid = $('sc-grid');
  const has = state.pages.length > 0;
  $('sc-pages').classList.toggle('hidden', !has || state.mode === 'qr');
  $('sc-export').classList.toggle('hidden', !has || state.mode === 'qr');
  $('sc-count').textContent = String(pageCount());

  const existing = new Map<string, HTMLElement>();
  grid.querySelectorAll<HTMLElement>('.sc-card').forEach((el) => existing.set(el.dataset.id!, el));
  grid.textContent = '';

  let n = 1;
  for (const page of state.pages) {
    let card = existing.get(page.id);
    if (!card || card.dataset.stamp !== stamp(page)) card = buildCard(page);
    const label = page.kind === 'book' ? `${n}-${n + 1}` : `${n}`;
    card.querySelector('.sc-num')!.textContent = label;
    n += page.kind === 'book' ? 2 : 1;
    grid.appendChild(card);
  }

  if (!sortable) {
    sortable = Sortable.create(grid, {
      animation: 160,
      delay: 180,
      delayOnTouchOnly: true,
      filter: 'button',
      preventOnFilter: false,
      ghostClass: 'sc-ghost-card',
      onEnd: () => {
        const order = Array.from(grid.querySelectorAll<HTMLElement>('.sc-card')).map((el) => el.dataset.id);
        state.pages.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        persist();
        renderGrid();
      },
    });
  }
}

function stamp(p: Page): string {
  return [p.rotation, p.filter, p.brightness, p.contrast, p.split, p.shots.length, ...p.shots.map((s) => s.corners.flat().join(','))].join('|');
}

function buildCard(page: Page): HTMLElement {
  const card = document.createElement('div');
  card.className = 'sc-card';
  card.dataset.id = page.id;
  card.dataset.stamp = stamp(page);

  const open = document.createElement('button');
  open.className = 'sc-card-img';
  open.type = 'button';
  open.setAttribute('aria-label', 'Edit page');
  const img = document.createElement('img');
  img.alt = '';
  open.appendChild(img);
  if (page.kind === 'book') {
    const line = document.createElement('i');
    line.className = 'sc-split-line';
    line.style.left = `${page.split}%`;
    open.appendChild(line);
  }
  const spin = document.createElement('div');
  spin.className = 'sc-card-spin';
  open.appendChild(spin);
  open.addEventListener('click', () => openEditor(page.id));

  const foot = document.createElement('div');
  foot.className = 'sc-card-foot';
  const num = document.createElement('span');
  num.className = 'sc-num';
  foot.appendChild(num);
  if (page.kind !== 'doc') {
    const tag = document.createElement('span');
    tag.className = 'sc-tag';
    tag.textContent = page.kind === 'id' ? (page.shots.length > 1 ? 'ID card' : 'ID, front') : 'Book';
    foot.appendChild(tag);
  }
  const tools = document.createElement('span');
  tools.className = 'sc-card-tools';
  tools.append(
    iconButton('ph-arrow-clockwise', 'Rotate', () => {
      page.rotation = (page.rotation + 90) % 360;
      changed(page);
    }),
    iconButton('ph-trash', 'Delete', () => {
      state.pages = state.pages.filter((p) => p !== page);
      dropThumb(page.id);
      persist();
      renderGrid();
    })
  );
  foot.appendChild(tools);
  card.append(open, foot);

  thumbFor(page)
    .then((url) => {
      img.src = url;
      spin.remove();
    })
    .catch((err) => {
      console.error(err);
      spin.remove();
    });
  return card;
}

function iconButton(icon: string, label: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sc-icon-btn';
  b.setAttribute('aria-label', label);
  b.title = label;
  b.innerHTML = `<i class="ph ${icon}"></i>`;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    fn();
  });
  return b;
}

function changed(page: Page): void {
  dropThumb(page.id);
  persist();
  renderGrid();
}

// ------------------------------------------------------------------ adding pages

async function ingest(blob: Blob): Promise<Shot & { found: boolean }> {
  const e = await getEngine();
  return e.call('ingest', { blob, maxSide: 3600 });
}

function newPage(kind: Kind, shot: Shot): Page {
  return {
    id: uid(),
    kind,
    shots: [shot],
    rotation: 0,
    filter: settings.filter,
    brightness: 0,
    contrast: 0,
    split: 50,
  };
}

/** Add one captured or imported photo as a page of the given kind. The kind is fixed
 *  when the import or camera starts, so switching modes meanwhile changes nothing. */
function addShot(shot: Shot, kind: Kind): Page {
  if (kind === 'id') {
    if (pendingIdPage && pendingIdPage.shots.length === 1 && state.pages.includes(pendingIdPage)) {
      pendingIdPage.shots.push(shot);
      const done = pendingIdPage;
      pendingIdPage = null;
      dropThumb(done.id);
      persist();
      renderGrid();
      return done;
    }
    const page = newPage('id', shot);
    pendingIdPage = page;
    state.pages.push(page);
  } else {
    state.pages.push(newPage(kind, shot));
  }
  persist();
  renderGrid();
  return state.pages[state.pages.length - 1];
}

// Imports run one after another, in the order they were started.
let importQueue: Promise<void> = Promise.resolve();

function importFiles(files: File[]): Promise<void> {
  const mode = state.mode;
  importQueue = importQueue.then(() => runImport(files, mode)).catch((err) => console.error(err));
  return importQueue;
}

async function runImport(files: File[], mode: Mode): Promise<void> {
  const images = files.filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(f.name));
  if (!images.length) {
    showAlert('No photos found', 'Choose JPG, PNG or WebP photos of your pages.');
    return;
  }
  if (mode === 'qr') {
    await readQrFromFiles(images);
    return;
  }
  const kind: Kind = mode;
  try {
    await getEngine();
    for (let i = 0; i < images.length; i++) {
      showLoader(`Preparing page ${i + 1} of ${images.length}...`);
      try {
        const shot = await ingest(images[i]);
        addShot({ blob: shot.blob, w: shot.w, h: shot.h, corners: shot.corners, auto: shot.found ? shot.corners : null }, kind);
      } catch (err) {
        console.error(err);
        showAlert('Could not read a photo', `${images[i].name} could not be opened. HEIC photos may need to be saved as JPG first.`);
      }
    }
  } catch (err) {
    showAlert('Scanner did not load', String((err as Error).message || err));
  } finally {
    hideLoader();
    if (kind === 'id' && pendingIdPage && state.mode === 'id') setHint('Front side added. Add the back side next.');
  }
}

// ------------------------------------------------------------------ camera

const cam = {
  stream: null as MediaStream | null,
  track: null as MediaStreamTrack | null,
  purpose: 'scan' as 'scan' | 'qr',
  kind: 'doc' as Kind,
  running: false,
  busy: false,
  corners: null as Corners | null,
  shown: null as Corners | null,
  lastSeen: 0,
  stableSince: 0,
  cooldownUntil: 0,
  // After an auto-capture, wait until a different page is in view (or the page leaves
  // the frame) so the same page is not captured twice.
  armed: true,
  lastShot: null as Corners | null,
  auto: true,
  // Many pages: keep capturing until Done. One page: close after the first capture.
  multi: true,
  torch: false,
  // Focus support of this camera, read when it opens.
  focusModes: [] as string[],
  focusRange: null as { min: number; max: number; step: number } | null,
  manualFocus: false,
  focusQueued: null as number | null,
  captured: 0,
  timer: 0,
  small: document.createElement('canvas'),
};

async function openCamera(purpose: 'scan' | 'qr'): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    showAlert('Camera not available', 'This browser cannot use the camera here. Use "Phone camera app" or "Import photos" instead.');
    return;
  }
  try {
    await getEngine();
  } catch (err) {
    showAlert('Scanner did not load', String((err as Error).message || err));
    return;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
    });
  } catch (err) {
    const name = (err as DOMException).name;
    showAlert(
      'Camera blocked',
      name === 'NotAllowedError'
        ? 'Allow camera access for this site in your browser settings, then try again.'
        : 'No camera was found. Use "Import photos" instead.'
    );
    return;
  }

  cam.stream = stream;
  cam.track = stream.getVideoTracks()[0];
  cam.purpose = purpose;
  cam.kind = state.mode === 'qr' ? 'doc' : state.mode;
  cam.running = true;
  cam.corners = cam.shown = null;
  cam.stableSince = 0;
  cam.captured = 0;
  cam.torch = false;
  cam.armed = true;
  cam.lastShot = null;
  cam.cooldownUntil = performance.now() + 800;
  hintHoldUntil = 0;

  const video = $<HTMLVideoElement>('sc-video');
  video.srcObject = stream;
  await video.play().catch(() => {});

  const caps = (cam.track.getCapabilities?.() || {}) as MediaTrackCapabilities & {
    torch?: boolean;
    focusMode?: string[];
    focusDistance?: { min: number; max: number; step?: number };
  };
  $('sc-torch').classList.toggle('hidden', !caps.torch);
  setupFocus(caps, purpose);
  $('sc-torch').setAttribute('aria-pressed', 'false');
  $('sc-torch').classList.remove('is-on');
  $('sc-auto').classList.toggle('hidden', purpose === 'qr');
  $('sc-shutter').classList.toggle('hidden', purpose === 'qr');
  $('sc-cam-thumb').classList.toggle('hidden', purpose === 'qr');
  $('sc-cam-mode').textContent = MODE_NAMES[state.mode];
  // ID cards always take two sides, and QR codes need no pages.
  $('sc-cam-pages').classList.toggle('hidden', purpose === 'qr' || cam.kind === 'id');
  syncPagesToggle();
  updateCamThumb();
  setCamHint(purpose === 'qr' ? 'Point at a QR code' : idHint() || 'Looking for a page...');

  $('sc-cam').classList.remove('hidden');
  document.body.classList.add('sc-noscroll');
  resizeOverlay();
  tick();
}

function idHint(): string {
  if (cam.kind !== 'id') return '';
  return pendingIdPage ? 'Now the back side of the card' : 'Front side of the card';
}

function closeCamera(): void {
  cam.running = false;
  cam.manualFocus = false;
  $('sc-focus-panel').classList.add('hidden');
  clearTimeout(cam.timer);
  cam.stream?.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  cam.track = null;
  $<HTMLVideoElement>('sc-video').srcObject = null;
  $('sc-cam').classList.add('hidden');
  document.body.classList.remove('sc-noscroll');
  setRing(0);
  if (state.mode === 'id' && pendingIdPage) setHint('Front side added. Scan or import the back side to finish this card, or leave it one-sided.');
}

let hintHoldUntil = 0;
function setCamHint(t: string): void {
  // A message from a tap (focus) stays up briefly before live hints take over again.
  if (performance.now() < hintHoldUntil) return;
  const el = $('sc-cam-hint');
  if (el.textContent !== t) el.textContent = t;
}

function holdCamHint(t: string, ms = 1800): void {
  hintHoldUntil = 0;
  setCamHint(t);
  hintHoldUntil = performance.now() + ms;
}

function setRing(p: number): void {
  const ring = $('sc-ring') as unknown as SVGCircleElement;
  const len = 2 * Math.PI * 46;
  ring.style.strokeDasharray = `${len}`;
  ring.style.strokeDashoffset = `${len * (1 - Math.max(0, Math.min(1, p)))}`;
}

function resizeOverlay(): void {
  const c = $<HTMLCanvasElement>('sc-overlay');
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(c.clientWidth * dpr);
  c.height = Math.round(c.clientHeight * dpr);
}

/** Map normalised video coordinates onto the overlay (the video is drawn with object-fit: cover). */
function toScreen(p: Pt): Pt {
  const v = $<HTMLVideoElement>('sc-video');
  const c = $<HTMLCanvasElement>('sc-overlay');
  const vw = v.videoWidth || 1;
  const vh = v.videoHeight || 1;
  const s = Math.max(c.width / vw, c.height / vh);
  const dx = (c.width - vw * s) / 2;
  const dy = (c.height - vh * s) / 2;
  return [p[0] * vw * s + dx, p[1] * vh * s + dy];
}

function drawOverlay(): void {
  const c = $<HTMLCanvasElement>('sc-overlay');
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, c.width, c.height);
  const q = cam.shown;
  if (!q || cam.purpose === 'qr') return;
  const pts = q.map(toScreen);
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(247, 168, 110, 0.22)';
  ctx.fill();
  ctx.lineWidth = 3 * (window.devicePixelRatio || 1);
  ctx.strokeStyle = '#f7a86e'; // brand orange, readable on any camera image
  ctx.lineJoin = 'round';
  ctx.stroke();
  for (const [x, y] of pts) {
    ctx.beginPath();
    ctx.arc(x, y, 6 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
    ctx.fillStyle = '#fffaf3';
    ctx.fill();
  }
}

function grabSmall(maxSide: number): { buffer: ArrayBuffer; w: number; h: number } | null {
  const v = $<HTMLVideoElement>('sc-video');
  if (!v.videoWidth) return null;
  const s = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.round(v.videoWidth * s);
  const h = Math.round(v.videoHeight * s);
  const c = cam.small;
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(v, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  return { buffer: data.data.buffer, w, h };
}

const maxDelta = (a: Corners, b: Corners) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));

async function tick(): Promise<void> {
  if (!cam.running) return;
  const started = performance.now();
  if (!cam.busy && engine) {
    const frame = grabSmall(cam.purpose === 'qr' ? 720 : 480);
    if (frame) {
      cam.busy = true;
      try {
        if (cam.purpose === 'qr') {
          const r = await engine.call<{ text: string }>('qr', frame, [frame.buffer]);
          if (r.text && cam.running) {
            foundQr(r.text);
            closeCamera();
            return;
          }
        } else {
          const r = await engine.call<{ corners: Corners | null; found: boolean }>('detect', frame, [frame.buffer]);
          onDetect(r.corners);
        }
      } catch (err) {
        console.error(err);
      } finally {
        cam.busy = false;
      }
    }
  }
  drawOverlay();
  const wait = Math.max(30, 140 - (performance.now() - started));
  cam.timer = window.setTimeout(() => {
    void tick();
  }, wait);
}

function onDetect(found: Corners | null): void {
  const now = performance.now();
  if (found) {
    const prev = cam.corners;
    cam.corners = found;
    cam.lastSeen = now;
    // Smooth the outline so it does not jitter.
    cam.shown = cam.shown
      ? (cam.shown.map((p, i) => [p[0] * 0.55 + found[i][0] * 0.45, p[1] * 0.55 + found[i][1] * 0.45]) as Corners)
      : found;
    const steady = prev && maxDelta(prev, found) < 0.018;
    if (!steady) cam.stableSince = now;
  } else if (now - cam.lastSeen > 500) {
    cam.corners = cam.shown = null;
    cam.stableSince = now;
    cam.armed = true;
  }
  if (!cam.armed && cam.corners && cam.lastShot && maxDelta(cam.corners, cam.lastShot) > 0.08) cam.armed = true;

  if (!cam.corners) {
    setRing(0);
    setCamHint(idHint() || 'Looking for a page...');
    return;
  }
  if (!cam.auto || now < cam.cooldownUntil || !cam.armed) {
    setRing(0);
    setCamHint(!cam.auto ? 'Tap the button to capture' : nextPageHint());
    return;
  }
  const progress = (now - cam.stableSince) / 1100;
  setRing(progress);
  setCamHint(progress > 0.15 ? 'Hold still...' : idHint() || 'Page found');
  if (progress >= 1) void capture();
}

let capturing = false;
async function capture(): Promise<void> {
  if (capturing || !cam.running) return;
  capturing = true;
  const liveCorners = cam.corners;
  try {
    const v = $<HTMLVideoElement>('sc-video');
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    flash();
    navigator.vibrate?.(30);
    const blob = await canvasBlob(c, 'jpeg', 0.93);
    c.width = c.height = 0;
    cam.cooldownUntil = performance.now() + 1600;
    cam.armed = false;
    cam.lastShot = liveCorners;
    cam.stableSince = performance.now();
    setRing(0);
    const shot = await ingest(blob);
    const corners = shot.found ? shot.corners : liveCorners || FULL;
    addShot({ blob: shot.blob, w: shot.w, h: shot.h, corners, auto: shot.found ? shot.corners : liveCorners }, cam.kind);
    cam.captured++;
    updateCamThumb();
    if (cam.kind === 'id' && !pendingIdPage) {
      holdCamHint('Both sides done', 600);
      setTimeout(closeCamera, 500);
    } else if (!cam.multi && cam.kind !== 'id') {
      holdCamHint('Page added', 600);
      setTimeout(closeCamera, 450);
    } else if (cam.kind !== 'id') {
      setCamHint(nextPageHint());
    }
  } catch (err) {
    console.error(err);
    setCamHint('Could not capture. Try again.');
  } finally {
    capturing = false;
  }
}

function flash(): void {
  const f = $('sc-flash');
  f.classList.remove('go');
  void f.offsetWidth;
  f.classList.add('go');
}

function updateCamThumb(): void {
  const last = state.pages[state.pages.length - 1];
  $('sc-cam-count').textContent = String(cam.captured);
  $('sc-cam-thumb').classList.toggle('is-empty', cam.captured === 0);
  const img = $<HTMLImageElement>('sc-cam-thumb-img');
  if (last && cam.captured) {
    thumbFor(last)
      .then((u) => (img.src = u))
      .catch(() => {});
  } else img.removeAttribute('src');
}

async function toggleTorch(): Promise<void> {
  if (!cam.track) return;
  cam.torch = !cam.torch;
  try {
    await cam.track.applyConstraints({ advanced: [{ torch: cam.torch } as MediaTrackConstraintSet] });
  } catch {
    cam.torch = false;
  }
  $('sc-torch').classList.toggle('is-on', cam.torch);
  $('sc-torch').setAttribute('aria-pressed', String(cam.torch));
}

function nextPageHint(): string {
  return cam.captured ? `Page ${cam.captured} added. Show page ${cam.captured + 1}.` : 'Show the next page.';
}

function syncPagesToggle(): void {
  document.querySelectorAll<HTMLElement>('#sc-cam-pages button').forEach((b) => {
    const on = (b.dataset.multi === '1') === cam.multi;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

// ------------------------------------------------------------------ focus
// Tap the preview to focus on that spot, or open the focus slider to set it by hand.
// Chrome and Edge on Android expose these controls. Safari and many laptop webcams do
// not, so there the camera keeps focusing on its own and a tap says so.

function setupFocus(
  caps: { focusMode?: string[]; focusDistance?: { min: number; max: number; step?: number } },
  purpose: 'scan' | 'qr'
): void {
  cam.focusModes = Array.isArray(caps.focusMode) ? caps.focusMode : [];
  const d = caps.focusDistance;
  cam.focusRange =
    d && typeof d.min === 'number' && typeof d.max === 'number' && d.max > d.min && cam.focusModes.includes('manual')
      ? { min: d.min, max: d.max, step: d.step && d.step > 0 ? d.step : (d.max - d.min) / 100 }
      : null;
  cam.manualFocus = false;
  const btn = $('sc-focus');
  btn.classList.toggle('hidden', !cam.focusRange || purpose === 'qr');
  btn.classList.remove('is-on');
  btn.setAttribute('aria-pressed', 'false');
  $('sc-focus-panel').classList.add('hidden');
  $('sc-focus-auto').classList.add('is-on');
  if (cam.focusRange) {
    const r = $<HTMLInputElement>('sc-focus-range');
    r.min = String(cam.focusRange.min);
    r.max = String(cam.focusRange.max);
    r.step = String(cam.focusRange.step);
    const now = (cam.track?.getSettings?.() as { focusDistance?: number } | undefined)?.focusDistance;
    r.value = String(typeof now === 'number' ? now : (cam.focusRange.min + cam.focusRange.max) / 2);
  }
}

function canTapFocus(): boolean {
  return cam.focusModes.includes('single-shot') || cam.focusModes.includes('continuous') || cam.focusModes.includes('manual');
}

function focusUnsupportedHint(): string {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return ios
    ? 'This browser focuses on its own. For tap to focus, use Phone camera app.'
    : 'This camera focuses on its own.';
}

function showFocusRing(x: number, y: number): void {
  const ring = $('sc-focus-ring');
  ring.style.left = `${x}px`;
  ring.style.top = `${y}px`;
  ring.classList.remove('go');
  void ring.offsetWidth;
  ring.classList.add('go');
}

/** Screen point (CSS pixels inside the camera view) to a normalised point in the video frame. */
function toVideo(x: number, y: number): Pt | null {
  const v = $<HTMLVideoElement>('sc-video');
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  if (!vw || !vh) return null;
  const s = Math.max(v.clientWidth / vw, v.clientHeight / vh);
  const dx = (v.clientWidth - vw * s) / 2;
  const dy = (v.clientHeight - vh * s) / 2;
  const nx = (x - dx) / (vw * s);
  const ny = (y - dy) / (vh * s);
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
  return [nx, ny];
}

async function applyFocus(set: Record<string, unknown>): Promise<boolean> {
  if (!cam.track) return false;
  try {
    await cam.track.applyConstraints({ advanced: [set as MediaTrackConstraintSet] });
    return true;
  } catch {
    return false;
  }
}

async function tapToFocus(ev: PointerEvent): Promise<void> {
  if (!cam.running || cam.purpose === 'qr') return;
  const box = $('sc-cam').getBoundingClientRect();
  const x = ev.clientX - box.left;
  const y = ev.clientY - box.top;
  const p = toVideo(x, y);
  if (!p) return;
  showFocusRing(x, y);
  if (!canTapFocus()) {
    holdCamHint(focusUnsupportedHint(), 3200);
    return;
  }
  // Pick the point, then focus there once (or keep refocusing there if that is all it can do).
  const mode = cam.focusModes.includes('single-shot') ? 'single-shot' : 'continuous';
  const ok =
    (await applyFocus({ pointsOfInterest: [{ x: p[0], y: p[1] }], focusMode: mode })) ||
    (await applyFocus({ focusMode: mode }));
  if (ok) {
    cam.manualFocus = false;
    $('sc-focus-auto').classList.add('is-on');
    holdCamHint('Focusing here');
  } else holdCamHint(focusUnsupportedHint(), 3200);
  // Give the lens a moment before auto-capture counts the page as steady.
  cam.stableSince = performance.now();
}

function toggleFocusPanel(): void {
  const panel = $('sc-focus-panel');
  const open = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  $('sc-focus').classList.toggle('is-on', open);
  $('sc-focus').setAttribute('aria-pressed', String(open));
}

function setFocusDistance(value: number): void {
  // Apply at most once per frame while the slider is dragged.
  const first = cam.focusQueued === null;
  cam.focusQueued = value;
  if (!first) return;
  requestAnimationFrame(async () => {
    const v = cam.focusQueued;
    cam.focusQueued = null;
    if (v === null) return;
    if (await applyFocus({ focusMode: 'manual', focusDistance: v })) {
      cam.manualFocus = true;
      $('sc-focus-auto').classList.remove('is-on');
      holdCamHint('Manual focus');
    }
    cam.stableSince = performance.now();
  });
}

async function autoFocus(): Promise<void> {
  const mode = cam.focusModes.includes('continuous') ? 'continuous' : 'single-shot';
  if (await applyFocus({ focusMode: mode })) {
    cam.manualFocus = false;
    $('sc-focus-auto').classList.add('is-on');
    holdCamHint('Auto focus');
  }
  cam.stableSince = performance.now();
}

// ------------------------------------------------------------------ QR

function foundQr(text: string): void {
  navigator.vibrate?.([20, 40, 20]);
  state.qr = [text, ...state.qr.filter((t) => t !== text)].slice(0, 30);
  persist();
  renderQr();
}

async function readQrFromFiles(files: File[]): Promise<void> {
  try {
    const e = await getEngine();
    let any = false;
    for (const f of files) {
      const r = await e.call<{ text: string }>('qrBlob', { blob: f });
      if (r.text) {
        foundQr(r.text);
        any = true;
      }
    }
    if (!any) showAlert('No QR code found', 'Try a sharper, closer picture of the code.');
  } catch (err) {
    showAlert('Scanner did not load', String((err as Error).message || err));
  }
}

function isLink(t: string): boolean {
  return /^https?:\/\/\S+$/i.test(t.trim());
}

function renderQr(): void {
  const list = $('sc-qr-list');
  list.textContent = '';
  $('sc-qr-empty').classList.toggle('hidden', state.qr.length > 0);
  for (const text of state.qr) {
    const li = document.createElement('li');
    const body = document.createElement('div');
    body.className = 'sc-qr-text';
    body.textContent = text;
    const tools = document.createElement('div');
    tools.className = 'sc-qr-tools';
    const copy = document.createElement('button');
    copy.className = 'sc-chip';
    copy.type = 'button';
    copy.innerHTML = '<i class="ph ph-copy"></i> Copy';
    copy.addEventListener('click', async () => {
      await navigator.clipboard?.writeText(text).catch(() => {});
      copy.innerHTML = '<i class="ph ph-check"></i> Copied';
    });
    tools.appendChild(copy);
    if (isLink(text)) {
      const a = document.createElement('a');
      a.className = 'sc-chip';
      a.href = text.trim();
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.innerHTML = `<i class="ph ph-arrow-square-out"></i> Open ${new URL(text.trim()).hostname}`;
      tools.appendChild(a);
    }
    li.append(body, tools);
    list.appendChild(li);
  }
}

// ------------------------------------------------------------------ editor

const ed = {
  page: null as Page | null,
  original: null as Page | null,
  side: 0,
  tab: 'crop' as 'crop' | 'look',
  img: null as HTMLImageElement | null,
  previewSeq: 0,
  previewUrl: '',
};

function clonePage(p: Page): Page {
  return { ...p, shots: p.shots.map((s) => ({ ...s, corners: s.corners.map((c) => [...c]) as Corners, auto: s.auto ?? null })) };
}

function openEditor(id: string, tab: 'crop' | 'look' = 'crop'): void {
  const page = state.pages.find((p) => p.id === id);
  if (!page) return;
  ed.original = page;
  ed.page = clonePage(page);
  ed.side = 0;
  $('sc-edit').classList.remove('hidden');
  document.body.classList.add('sc-noscroll');
  $('sc-side').classList.toggle('hidden', page.kind !== 'id' || page.shots.length < 2);
  $('sc-split-field').classList.toggle('hidden', page.kind !== 'book');
  setSide(0);
  buildFilterChips();
  syncLookControls();
  setTab(tab);
}

function closeEditor(): void {
  $('sc-edit').classList.add('hidden');
  document.body.classList.remove('sc-noscroll');
  if (ed.previewUrl) URL.revokeObjectURL(ed.previewUrl);
  ed.previewUrl = '';
  ed.page = ed.original = null;
}

function saveEditor(): void {
  if (!ed.page || !ed.original) return;
  const i = state.pages.indexOf(ed.original);
  if (i >= 0) {
    ed.page.shots.forEach((s) => (s.corners = orderCorners(s.corners)));
    state.pages[i] = ed.page;
    if (pendingIdPage === ed.original) pendingIdPage = ed.page;
    dropThumb(ed.page.id);
    persist();
    renderGrid();
  }
  closeEditor();
}

function setTab(tab: 'crop' | 'look'): void {
  ed.tab = tab;
  document.querySelectorAll<HTMLElement>('.sc-tab').forEach((b) => b.classList.toggle('is-on', b.dataset.tab === tab));
  $('sc-crop').classList.toggle('hidden', tab !== 'crop');
  $('sc-crop-tools').classList.toggle('hidden', tab !== 'crop');
  $('sc-look-tools').classList.toggle('hidden', tab !== 'look');
  $('sc-preview-wrap').classList.toggle('hidden', tab !== 'look');
  if (tab === 'crop') requestAnimationFrame(layoutCrop);
  else void refreshPreview();
}

async function setSide(side: number): Promise<void> {
  if (!ed.page) return;
  ed.side = side;
  document.querySelectorAll<HTMLElement>('#sc-side button').forEach((b) => b.classList.toggle('is-on', Number(b.dataset.side) === side));
  const shot = ed.page.shots[side];
  const img = $<HTMLImageElement>('sc-crop-img');
  const url = URL.createObjectURL(shot.blob);
  img.src = url;
  await img.decode().catch(() => {});
  ed.img = img;
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  layoutCrop();
}

/** Fit the photo inside the stage and size the handle layer to match. */
function layoutCrop(): void {
  if (!ed.page) return;
  const shot = ed.page.shots[ed.side];
  fitInStage($('sc-crop'), shot.w, shot.h);
  drawHandles();
}

function fitInStage(el: HTMLElement, w: number, h: number): void {
  const stage = $('sc-stage');
  const pad = 28;
  const s = Math.min((stage.clientWidth - pad * 2) / w, (stage.clientHeight - pad * 2) / h);
  el.style.width = `${Math.max(1, Math.round(w * s))}px`;
  el.style.height = `${Math.max(1, Math.round(h * s))}px`;
}

function drawHandles(): void {
  if (!ed.page) return;
  const svg = $('sc-crop-svg') as unknown as SVGSVGElement;
  const box = $('sc-crop');
  const W = box.clientWidth;
  const H = box.clientHeight;
  // The svg overhangs the photo by 20px on each side so handles at the edge stay grabbable.
  const q = ed.page.shots[ed.side].corners;
  const P = q.map(([x, y]) => [x * W, y * H]);
  const mids = P.map((p, i) => {
    const n = P[(i + 1) % 4];
    return [(p[0] + n[0]) / 2, (p[1] + n[1]) / 2];
  });
  const poly = P.map((p) => p.join(',')).join(' ');
  svg.innerHTML =
    `<g transform="translate(20 20)"><defs><mask id="sc-m"><rect width="${W}" height="${H}" fill="white"/><polygon points="${poly}" fill="black"/></mask></defs>` +
    `<rect width="${W}" height="${H}" class="sc-shade" mask="url(#sc-m)"/>` +
    `<polygon points="${poly}" class="sc-poly"/>` +
    mids.map(([x, y], i) => `<rect class="sc-mid" data-edge="${i}" x="${x - 14}" y="${y - 6}" width="28" height="12" rx="6" transform="rotate(${edgeAngle(P, i)} ${x} ${y})"/>`).join('') +
    P.map(([x, y], i) => `<circle class="sc-handle" data-corner="${i}" cx="${x}" cy="${y}" r="13"/><circle class="sc-handle-dot" cx="${x}" cy="${y}" r="4"/>`).join('') +
    '</g>';
}

function edgeAngle(P: number[][], i: number): number {
  const a = P[i];
  const b = P[(i + 1) % 4];
  return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
}

function setupCropDrag(): void {
  const svg = $('sc-crop-svg');
  let drag: { corner?: number; edge?: number; start: Pt; orig: Corners } | null = null;

  const toNorm = (e: PointerEvent): Pt => {
    const r = $('sc-crop').getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  svg.addEventListener('pointerdown', (e) => {
    const t = e.target as Element;
    if (!ed.page) return;
    const shot = ed.page.shots[ed.side];
    if (t.classList.contains('sc-handle')) drag = { corner: Number(t.getAttribute('data-corner')), start: toNorm(e), orig: shot.corners.map((c) => [...c]) as Corners };
    else if (t.classList.contains('sc-mid')) drag = { edge: Number(t.getAttribute('data-edge')), start: toNorm(e), orig: shot.corners.map((c) => [...c]) as Corners };
    else return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag || !ed.page) return;
    const shot = ed.page.shots[ed.side];
    const p = toNorm(e);
    const dx = p[0] - drag.start[0];
    const dy = p[1] - drag.start[1];
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const c = drag.orig.map((q) => [...q]) as Corners;
    let focus: Pt;
    if (drag.corner !== undefined) {
      c[drag.corner] = [clamp(drag.orig[drag.corner][0] + dx), clamp(drag.orig[drag.corner][1] + dy)];
      focus = c[drag.corner];
    } else {
      const i = drag.edge!;
      const j = (i + 1) % 4;
      c[i] = [clamp(drag.orig[i][0] + dx), clamp(drag.orig[i][1] + dy)];
      c[j] = [clamp(drag.orig[j][0] + dx), clamp(drag.orig[j][1] + dy)];
      focus = [(c[i][0] + c[j][0]) / 2, (c[i][1] + c[j][1]) / 2];
    }
    shot.corners = c;
    drawHandles();
    drawLoupe(focus);
  });
  const end = () => {
    drag = null;
    $('sc-loupe').classList.add('hidden');
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
}

/** A magnifier above the finger, so the corner under it can be placed precisely. */
function drawLoupe(p: Pt): void {
  const img = ed.img;
  if (!img || !ed.page) return;
  const loupe = $<HTMLCanvasElement>('sc-loupe');
  const ctx = loupe.getContext('2d')!;
  const shot = ed.page.shots[ed.side];
  const nw = img.naturalWidth || shot.w;
  const nh = img.naturalHeight || shot.h;
  const box = $('sc-crop');
  const size = loupe.width;
  // The loupe shows the area under the finger at 3x the on-screen size.
  const src = ((loupe.clientWidth || 120) / 3) * (nw / box.clientWidth);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, p[0] * nw - src / 2, p[1] * nh - src / 2, src, src, 0, 0, size, size);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(size / 2, size / 2 - 18);
  ctx.lineTo(size / 2, size / 2 + 18);
  ctx.moveTo(size / 2 - 18, size / 2);
  ctx.lineTo(size / 2 + 18, size / 2);
  ctx.stroke();
  const stage = $('sc-stage').getBoundingClientRect();
  const br = box.getBoundingClientRect();
  const fx = br.left - stage.left + p[0] * br.width;
  const fy = br.top - stage.top + p[1] * br.height;
  const half = loupe.clientWidth / 2 || 60;
  let lx = fx - half;
  let ly = fy - half * 2 - 46;
  if (ly < 8) ly = fy + 46;
  lx = Math.max(8, Math.min(stage.width - half * 2 - 8, lx));
  loupe.style.left = `${lx}px`;
  loupe.style.top = `${ly}px`;
  loupe.classList.remove('hidden');
}

function orderCorners(c: Corners): Corners {
  const pts = [...c];
  const bySum = [...pts].sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  const byDiff = [...pts].sort((a, b) => a[1] - a[0] - (b[1] - b[0]));
  const out = [bySum[0], byDiff[0], bySum[3], byDiff[3]];
  // Degenerate shapes (two corners dragged onto each other) keep the user's order.
  return new Set(out).size === 4 ? (out as Corners) : c;
}

async function autoCrop(): Promise<void> {
  if (!ed.page) return;
  const shot = ed.page.shots[ed.side];
  if (shot.auto) {
    shot.corners = shot.auto.map((c) => [...c]) as Corners;
    drawHandles();
    return;
  }
  showLoader('Finding the page edges...');
  try {
    const r = await ingest(shot.blob);
    if (r.found) shot.corners = shot.auto = r.corners;
    else showAlert('No page edges found', 'Drag the corners into place, or use the whole photo.');
  } finally {
    hideLoader();
  }
  drawHandles();
}

function buildFilterChips(): void {
  const wrap = $('sc-filters');
  wrap.textContent = '';
  for (const [f, label] of FILTERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sc-filter';
    b.dataset.filter = f;
    b.innerHTML = `<span class="sc-swatch sc-sw-${f}"></span><span>${label}</span>`;
    b.addEventListener('click', () => {
      if (!ed.page) return;
      ed.page.filter = f;
      syncLookControls();
      void refreshPreview();
    });
    wrap.appendChild(b);
  }
}

function syncLookControls(): void {
  if (!ed.page) return;
  document.querySelectorAll<HTMLElement>('.sc-filter').forEach((b) => b.classList.toggle('is-on', b.dataset.filter === ed.page!.filter));
  $<HTMLInputElement>('sc-bright').value = String(ed.page.brightness);
  $<HTMLInputElement>('sc-contrast').value = String(ed.page.contrast);
  $<HTMLInputElement>('sc-split').value = String(ed.page.split);
}

function syncSplitLine(): void {
  const line = $('sc-preview-split');
  const book = ed.page?.kind === 'book';
  line.classList.toggle('hidden', !book);
  if (book) line.style.left = `${ed.page!.split}%`;
}

let previewTimer = 0;
function schedulePreview(): void {
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    void refreshPreview();
  }, 220);
}

async function refreshPreview(): Promise<void> {
  if (!ed.page || ed.tab !== 'look') return;
  const seq = ++ed.previewSeq;
  const busy = $('sc-preview-busy');
  busy.classList.remove('hidden');
  try {
    const stage = $('sc-stage');
    const longSide = Math.min(1600, Math.round(Math.max(stage.clientWidth, stage.clientHeight) * (window.devicePixelRatio || 1)));
    let r: Rendered;
    if (ed.page.kind === 'id') {
      const out = await outputFor(ed.page, 1000, 'jpeg', 0.85);
      r = await composeId(out[0].images, longSide, 'jpeg', 0.85);
    } else r = await renderShot(ed.page, ed.page.shots[0], longSide, 'jpeg', 0.85);
    if (seq !== ed.previewSeq || !ed.page) return;
    if (ed.previewUrl) URL.revokeObjectURL(ed.previewUrl);
    ed.previewUrl = URL.createObjectURL(r.blob);
    const img = $<HTMLImageElement>('sc-preview');
    img.src = ed.previewUrl;
    await img.decode().catch(() => {});
    if (seq !== ed.previewSeq) return;
    fitInStage($('sc-preview-wrap'), r.w, r.h);
    syncSplitLine();
  } catch (err) {
    console.error(err);
  } finally {
    if (seq === ed.previewSeq) busy.classList.add('hidden');
  }
}

// ------------------------------------------------------------------ export

async function buildPdf(progress: (msg: string, pct?: number) => void): Promise<Uint8Array> {
  const q = QUALITY[settings.quality];
  const doc = await PDFDocument.create();
  const name = cleanName();
  doc.setTitle(name);
  doc.setCreator('Paperhaus Scan');
  doc.setProducer('Paperhaus');

  for (let i = 0; i < state.pages.length; i++) {
    const page = state.pages[i];
    progress(`Preparing page ${i + 1} of ${state.pages.length}...`, (i / state.pages.length) * 100);
    const format = page.filter === 'bw' ? 'png' : 'jpeg';
    const outputs = await outputFor(page, q.maxSide, format, q.quality);
    for (const out of outputs) {
      const embedded = [];
      for (const r of out.images) {
        const bytes = new Uint8Array(await r.blob.arrayBuffer());
        embedded.push(format === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes));
      }
      if (out.layout === 'id') {
        const [pw, ph] = settings.size === 'letter' ? SIZES.letter : SIZES.a4;
        const pdfPage = doc.addPage([pw, ph]);
        const boxes = idBoxes(out.images, pw, ph);
        embedded.forEach((img, k) => pdfPage.drawImage(img, boxes[k]));
        continue;
      }
      const r = out.images[0];
      const img = embedded[0];
      if (settings.size === 'fit') {
        // Long side as long as an A4 page, so text prints at a natural size.
        const s = 841.89 / Math.max(r.w, r.h);
        const w = r.w * s;
        const h = r.h * s;
        doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
      } else {
        let [pw, ph] = SIZES[settings.size];
        if (r.w > r.h) [pw, ph] = [ph, pw];
        const m = 18;
        const s = Math.min((pw - m * 2) / r.w, (ph - m * 2) / r.h);
        const w = r.w * s;
        const h = r.h * s;
        doc.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
      }
    }
  }

  let bytes = await doc.save();

  if (settings.ocr) {
    progress('Reading the text (OCR)...', 0);
    const res = await performOcr(bytes, {
      language: settings.lang,
      resolution: 3,
      binarize: false,
      whitelist: '',
      onProgress: (status, p) => progress(status.startsWith('Processing page') ? `OCR: ${status.toLowerCase()}` : 'Reading the text (OCR)...', p * 100),
    });
    bytes = res.pdfBytes;
  }

  const password = $<HTMLInputElement>('sc-password').value;
  if (password) {
    progress('Adding the password...');
    bytes = await encrypt(bytes, password);
  }
  return bytes;
}

async function encrypt(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const qpdf = await initializeQpdf();
  const inPath = '/scan-in.pdf';
  const outPath = '/scan-out.pdf';
  qpdf.FS.writeFile(inPath, bytes);
  try {
    qpdf.callMain([inPath, '--encrypt', password, password, '256', '--', outPath]);
    const out = qpdf.FS.readFile(outPath, { encoding: 'binary' }) as Uint8Array;
    if (!out?.length) throw new Error('Encryption produced an empty file');
    return new Uint8Array(out);
  } finally {
    try {
      qpdf.FS.unlink(inPath);
    } catch {
      /* ignore */
    }
    try {
      qpdf.FS.unlink(outPath);
    } catch {
      /* ignore */
    }
  }
}

async function withProgress<T>(fn: (p: (msg: string, pct?: number) => void) => Promise<T>): Promise<T | null> {
  if (!state.pages.length) return null;
  try {
    await getEngine();
    return await fn((msg, pct) => showLoader(msg, pct === undefined ? undefined : Math.max(0, Math.min(100, pct))));
  } catch (err) {
    console.error(err);
    showAlert('Something went wrong', String((err as Error).message || err));
    return null;
  } finally {
    hideLoader();
  }
}

async function savePdf(): Promise<void> {
  const bytes = await withProgress(buildPdf);
  if (!bytes) return;
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  downloadFile(blob, `${cleanName()}.pdf`);
  $('sc-result').textContent = `Saved ${cleanName()}.pdf (${pageCount()} page${pageCount() === 1 ? '' : 's'}, ${formatBytes(blob.size)}).`;
}

let readyShare: File | null = null;

async function sharePdf(): Promise<void> {
  const bytes = await withProgress(buildPdf);
  if (!bytes) return;
  readyShare = new File([bytes as BlobPart], `${cleanName()}.pdf`, { type: 'application/pdf' });
  await tryShare();
}

async function tryShare(): Promise<void> {
  if (!readyShare) return;
  try {
    await navigator.share({ files: [readyShare], title: cleanName() });
    $('sc-share-modal').classList.add('hidden');
    readyShare = null;
  } catch (err) {
    const name = (err as DOMException).name;
    if (name === 'NotAllowedError') {
      // The tap that started the work has expired; ask for a fresh one.
      $('sc-share-modal').classList.remove('hidden');
    } else if (name !== 'AbortError') {
      showAlert('Could not share', 'Your browser could not share this file. Use Download PDF instead.');
    }
  }
}

async function saveImages(): Promise<void> {
  const files = await withProgress(async (progress) => {
    const q = QUALITY[settings.quality];
    const out: Array<[string, Blob]> = [];
    let n = 1;
    for (let i = 0; i < state.pages.length; i++) {
      progress(`Preparing page ${i + 1} of ${state.pages.length}...`, (i / state.pages.length) * 100);
      const page = state.pages[i];
      const format = page.filter === 'bw' ? 'png' : 'jpeg';
      const ext = format === 'png' ? 'png' : 'jpg';
      for (const o of await outputFor(page, q.maxSide, format, q.quality)) {
        const r = o.layout === 'id' ? await composeId(o.images, q.maxSide, format, q.quality) : o.images[0];
        out.push([`${cleanName()} - ${String(n++).padStart(2, '0')}.${ext}`, r.blob]);
      }
    }
    return out;
  });
  if (!files?.length) return;
  if (files.length === 1) {
    downloadFile(files[0][1], files[0][0]);
    return;
  }
  const zip = new JSZip();
  for (const [name, blob] of files) zip.file(name, blob);
  downloadFile(await zip.generateAsync({ type: 'blob' }), `${cleanName()}.zip`);
}

async function extractText(): Promise<void> {
  const text = await withProgress(async (progress) => {
    progress('Loading text recognition...');
    const worker = await createConfiguredTesseractWorker(settings.lang, 1);
    try {
      const parts: string[] = [];
      let n = 0;
      const total = pageCount();
      for (const page of state.pages) {
        for (const o of await outputFor(page, 2400, 'jpeg', 0.9)) {
          for (const r of o.images) {
            progress(`Reading page ${Math.min(++n, total)} of ${total}...`, ((n - 1) / total) * 100);
            const res = await worker.recognize(r.blob);
            parts.push(res.data.text.trim());
          }
        }
      }
      return parts.filter(Boolean).join('\n\n');
    } finally {
      await worker.terminate();
    }
  });
  if (text === null) return;
  $<HTMLTextAreaElement>('sc-text-out').value = text || '(No text found.)';
  $('sc-text-modal').classList.remove('hidden');
}

// ------------------------------------------------------------------ setup

function setHint(t: string): void {
  $('sc-mode-hint').textContent = t;
}

function setMode(mode: Mode): void {
  state.mode = mode;
  document.querySelectorAll<HTMLElement>('.sc-mode').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  });
  setHint(MODE_HINTS[mode]);
  const qr = mode === 'qr';
  $('sc-qr-panel').classList.toggle('hidden', !qr);
  $('sc-photo-label').classList.toggle('hidden', qr || !isTouch());
  if (qr) $('sc-photo-again').classList.add('hidden');
  $('sc-camera').querySelector('strong')!.textContent = qr ? 'Scan a QR code' : 'Open camera';
  $('sc-camera').querySelector('small')!.textContent = qr ? 'Reads it instantly' : 'Live edge detection and auto-capture';
  $('sc-import-label').querySelector('strong')!.textContent = qr ? 'Read from a photo' : 'Import photos';
  $<HTMLInputElement>('sc-import').multiple = !qr;
  if (qr) renderQr();
  renderGrid();
}

function isTouch(): boolean {
  return matchMedia('(pointer: coarse)').matches;
}

function fillSelects(): void {
  const df = $<HTMLSelectElement>('sc-default-filter');
  for (const [f, label] of FILTERS) df.add(new Option(label, f));
  const langs = getAvailableTesseractLanguageEntries();
  const ls = $<HTMLSelectElement>('sc-lang');
  for (const [code, label] of langs) ls.add(new Option(label, code));
  if (!langs.some(([c]) => c === settings.lang)) settings.lang = langs[0]?.[0] || 'eng';
  $('sc-lang-field').classList.toggle('hidden', !settings.ocr || langs.length < 2);
}

function syncSettingsUi(): void {
  $<HTMLInputElement>('sc-name').value = settings.name;
  $<HTMLInputElement>('sc-name').placeholder = defaultName();
  $<HTMLSelectElement>('sc-size').value = settings.size;
  $<HTMLSelectElement>('sc-quality').value = settings.quality;
  $<HTMLSelectElement>('sc-default-filter').value = settings.filter;
  $<HTMLInputElement>('sc-ocr').checked = settings.ocr;
  $<HTMLSelectElement>('sc-lang').value = settings.lang;
}

function bind(): void {
  document.querySelectorAll<HTMLElement>('.sc-mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as Mode)));
  $('sc-camera').addEventListener('click', () => void openCamera(state.mode === 'qr' ? 'qr' : 'scan'));
  for (const id of ['sc-import', 'sc-photo']) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.value = '';
      if (!files.length) return;
      void importFiles(files);
      // One photo per trip to the camera app, so offer the next page straight away.
      if (id === 'sc-photo') {
        $('sc-photo-again').classList.remove('hidden');
        setHint('Page added. Tap "Take the next page" for each page, then save below.');
      }
    });
  }

  // Camera controls
  $('sc-cam-close').addEventListener('click', closeCamera);
  $('sc-cam-done').addEventListener('click', closeCamera);
  $('sc-cam-thumb').addEventListener('click', closeCamera);
  $('sc-shutter').addEventListener('click', () => void capture());
  $('sc-torch').addEventListener('click', () => void toggleTorch());
  $('sc-overlay').addEventListener('pointerup', (e) => void tapToFocus(e as PointerEvent));
  $('sc-focus').addEventListener('click', toggleFocusPanel);
  $('sc-focus-auto').addEventListener('click', () => void autoFocus());
  $<HTMLInputElement>('sc-focus-range').addEventListener('input', (e) =>
    setFocusDistance(Number((e.target as HTMLInputElement).value))
  );
  document.querySelectorAll<HTMLElement>('#sc-cam-pages button').forEach((b) =>
    b.addEventListener('click', () => {
      cam.multi = b.dataset.multi === '1';
      syncPagesToggle();
      try {
        localStorage.setItem('paperhaus-scan-multi', cam.multi ? '1' : '0');
      } catch {
        /* ignore */
      }
    })
  );
  $('sc-auto').addEventListener('click', () => {
    cam.auto = !cam.auto;
    $('sc-auto').classList.toggle('is-on', cam.auto);
    $('sc-auto').setAttribute('aria-pressed', String(cam.auto));
    cam.stableSince = performance.now();
    try {
      localStorage.setItem('paperhaus-scan-auto', cam.auto ? '1' : '0');
    } catch {
      /* ignore */
    }
  });
  window.addEventListener('resize', () => {
    if (cam.running) resizeOverlay();
    if (ed.page && ed.tab === 'crop') layoutCrop();
  });
  document.addEventListener('keydown', (e) => {
    if (cam.running && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      void capture();
    } else if (e.key === 'Escape') {
      if (cam.running) closeCamera();
      else if (ed.page) closeEditor();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && cam.running) closeCamera();
  });

  // Pages
  $('sc-clear').addEventListener('click', () => {
    if (!confirm('Remove all pages from this scan?')) return;
    state.pages.forEach((p) => dropThumb(p.id));
    state.pages = [];
    pendingIdPage = null;
    $('sc-photo-again').classList.add('hidden');
    persist();
    renderGrid();
    $('sc-result').textContent = '';
  });
  $('sc-apply-all').addEventListener('click', () => {
    const first = state.pages[0];
    if (!first) return;
    const f = settings.filter;
    state.pages.forEach((p) => {
      p.filter = f;
      p.brightness = 0;
      p.contrast = 0;
      dropThumb(p.id);
    });
    persist();
    renderGrid();
  });

  // Editor
  document.querySelectorAll<HTMLElement>('.sc-tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab as 'crop' | 'look')));
  document.querySelectorAll<HTMLElement>('#sc-side button').forEach((b) => b.addEventListener('click', () => void setSide(Number(b.dataset.side))));
  $('sc-edit-cancel').addEventListener('click', closeEditor);
  $('sc-edit-done').addEventListener('click', saveEditor);
  $('sc-auto-crop').addEventListener('click', () => void autoCrop());
  $('sc-full-crop').addEventListener('click', () => {
    if (!ed.page) return;
    ed.page.shots[ed.side].corners = FULL.map((c) => [...c]) as Corners;
    drawHandles();
  });
  $('sc-rot-left').addEventListener('click', () => {
    if (!ed.page) return;
    ed.page.rotation = (ed.page.rotation + 270) % 360;
    void refreshPreview();
  });
  $('sc-rot-right').addEventListener('click', () => {
    if (!ed.page) return;
    ed.page.rotation = (ed.page.rotation + 90) % 360;
    void refreshPreview();
  });
  $('sc-edit-delete').addEventListener('click', () => {
    const p = ed.original;
    closeEditor();
    if (!p) return;
    state.pages = state.pages.filter((x) => x !== p);
    if (pendingIdPage === p) pendingIdPage = null;
    dropThumb(p.id);
    persist();
    renderGrid();
  });
  for (const [id, key] of [
    ['sc-bright', 'brightness'],
    ['sc-contrast', 'contrast'],
    ['sc-split', 'split'],
  ] as const) {
    $<HTMLInputElement>(id).addEventListener('input', (e) => {
      if (!ed.page) return;
      ed.page[key] = Number((e.target as HTMLInputElement).value);
      if (key === 'split') {
        syncSplitLine();
        return;
      }
      schedulePreview();
    });
  }
  setupCropDrag();

  // Export settings
  $<HTMLInputElement>('sc-name').addEventListener('input', (e) => {
    settings.name = (e.target as HTMLInputElement).value;
    persist();
  });
  $<HTMLSelectElement>('sc-size').addEventListener('change', (e) => {
    settings.size = (e.target as HTMLSelectElement).value;
    persist();
  });
  $<HTMLSelectElement>('sc-quality').addEventListener('change', (e) => {
    settings.quality = (e.target as HTMLSelectElement).value as keyof typeof QUALITY;
    persist();
  });
  $<HTMLSelectElement>('sc-default-filter').addEventListener('change', (e) => {
    settings.filter = (e.target as HTMLSelectElement).value as Filter;
    persist();
  });
  $<HTMLInputElement>('sc-ocr').addEventListener('change', (e) => {
    settings.ocr = (e.target as HTMLInputElement).checked;
    $('sc-lang-field').classList.toggle('hidden', !settings.ocr || $<HTMLSelectElement>('sc-lang').options.length < 2);
    persist();
  });
  $<HTMLSelectElement>('sc-lang').addEventListener('change', (e) => {
    settings.lang = (e.target as HTMLSelectElement).value;
    persist();
  });

  $('sc-save').addEventListener('click', () => void savePdf());
  $('sc-images').addEventListener('click', () => void saveImages());
  $('sc-text').addEventListener('click', () => void extractText());
  const probe = new File([new Uint8Array([37, 80, 68, 70])], 'probe.pdf', { type: 'application/pdf' });
  if (navigator.canShare?.({ files: [probe] })) {
    $('sc-share').classList.remove('hidden');
    $('sc-share').addEventListener('click', () => void sharePdf());
  }
  $('sc-share-now').addEventListener('click', () => void tryShare());
  $('sc-share-cancel').addEventListener('click', () => {
    $('sc-share-modal').classList.add('hidden');
    readyShare = null;
  });

  // Text modal
  $('sc-text-close').addEventListener('click', () => $('sc-text-modal').classList.add('hidden'));
  $('sc-text-copy').addEventListener('click', async () => {
    const t = $<HTMLTextAreaElement>('sc-text-out');
    try {
      await navigator.clipboard.writeText(t.value);
    } catch {
      t.select();
      document.execCommand('copy');
    }
    $('sc-text-copy').innerHTML = '<i class="ph ph-check"></i> Copied';
    setTimeout(() => ($('sc-text-copy').innerHTML = '<i class="ph ph-copy"></i> Copy'), 1600);
  });
  $('sc-text-dl').addEventListener('click', () => {
    downloadFile(new Blob([$<HTMLTextAreaElement>('sc-text-out').value], { type: 'text/plain' }), `${cleanName()}.txt`);
  });

  // QR
  $('sc-qr-clear').addEventListener('click', () => {
    state.qr = [];
    persist();
    renderQr();
  });

  // Drag and drop anywhere
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    depth++;
    $('sc-drop').classList.remove('hidden');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) $('sc-drop').classList.add('hidden');
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    depth = 0;
    $('sc-drop').classList.add('hidden');
    void importFiles(Array.from(e.dataTransfer.files));
  });

  $('back-to-tools').addEventListener('click', () => {
    window.location.href = import.meta.env.BASE_URL;
  });
}

async function init(): Promise<void> {
  try {
    cam.auto = localStorage.getItem('paperhaus-scan-auto') !== '0';
    cam.multi = localStorage.getItem('paperhaus-scan-multi') !== '0';
  } catch {
    /* ignore */
  }
  $('sc-auto').classList.toggle('is-on', cam.auto);
  await restore();
  fillSelects();
  syncSettingsUi();
  bind();
  const wanted = new URLSearchParams(location.search).get('mode') as Mode | null;
  setMode(wanted && wanted in MODE_NAMES ? wanted : 'doc');
  // Start loading the engine in the background so the camera opens quickly.
  setTimeout(() => {
    if (!engine) {
      engine = new Engine();
      engine.ready
        .then(() => {
          engineLoaded = true;
        })
        .catch(() => {
          engine = null;
        });
    }
  }, 1200);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void init());
else void init();
