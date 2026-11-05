/**
 * Paperhaus: Redact PDF. Find words and patterns (or draw boxes), then rebuild each
 * redacted page as a picture with black boxes, so nothing under them survives. The words
 * outside the boxes go back in as invisible text, so the page can still be searched.
 */
import { PDFDocument, PDFName, StandardFonts, type PDFFont } from 'pdf-lib';
import {
  $,
  type PdfDoc,
  type TextBit,
  alertBox,
  backToTools,
  baseName,
  busy,
  canvasBlob,
  charEdges,
  download,
  escapeHtml,
  onReady,
  openPdf,
  pageLines,
  pickFile,
  readPdf,
  renderPage,
  toast,
} from './more-common.js';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Match extends Rect {
  id: string;
  page: number; // 0-based
  source: string; // 'term:<text>' | 'pat:<key>' | 'draw'
  on: boolean;
}
interface PageInfo {
  w: number;
  h: number;
  text: string;
  map: { bit: TextBit; i: number }[]; // text index -> bit + char index
  bits: TextBit[];
  box?: HTMLElement;
}

const PATTERNS: { key: string; label: string; re: RegExp; check?: (s: string) => boolean }[] = [
  { key: 'email', label: 'Email addresses', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },
  { key: 'phone', label: 'Phone numbers', re: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g },
  { key: 'ssn', label: 'SSNs', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { key: 'card', label: 'Card numbers', re: /\b(?:\d[ -]?){12,18}\d\b/g, check: luhn },
  {
    key: 'date',
    label: 'Dates',
    re: /\b(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})\b/gi,
  },
];

function luhn(s: string): boolean {
  const d = s.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

let file: File | null = null;
let bytes: Uint8Array | null = null;
let pdf: PdfDoc | null = null;
let pages: PageInfo[] = [];
let matches: Match[] = [];
const terms: { text: string; cased: boolean; whole: boolean }[] = [];
const patternsOn = new Set<string>();
let drawing = false;
let seq = 0;

// ------------------------------------------------------------------ loading

async function load(f: File): Promise<void> {
  busy('Opening the PDF...');
  try {
    const r = await readPdf(f);
    if (!r) return;
    pdf?.destroy();
    file = f;
    bytes = r.bytes;
    pdf = r.pdf;
    matches = [];
    terms.length = 0;
    patternsOn.clear();
    $('mt-drop').classList.add('hidden');
    $('mt-doc').classList.remove('hidden');
    $('mt-name').textContent = f.name;
    for (const id of ['mt-find-card', 'mt-pages-card', 'mt-apply-card']) $(id).classList.remove('hidden');
    pages = [];
    const host = $('mt-pages');
    host.textContent = '';
    let anyText = false;
    for (let i = 1; i <= pdf.numPages; i++) {
      busy(`Reading page ${i} of ${pdf.numPages}...`);
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const lines = await pageLines(page);
      let text = '';
      const map: PageInfo['map'] = [];
      const bits: TextBit[] = [];
      for (const l of lines) {
        l.items.forEach((b, k) => {
          if (k > 0) {
            const prev = l.items[k - 1];
            if (b.x - (prev.x + prev.w) > 1 && !/\s$/.test(prev.str) && !/^\s/.test(b.str)) {
              text += ' ';
              map.push({ bit: b, i: -1 });
            }
          }
          for (let c = 0; c < b.str.length; c++) map.push({ bit: b, i: c });
          text += b.str;
          bits.push(b);
        });
        text += '\n';
        map.push({ bit: l.items[l.items.length - 1], i: -1 });
      }
      if (text.trim()) anyText = true;
      const info: PageInfo = { w: vp.width, h: vp.height, text, map, bits };
      pages.push(info);
      // Preview
      const box = document.createElement('div');
      box.className = 'mt-rpage';
      box.dataset.page = String(i - 1);
      box.style.aspectRatio = `${vp.width} / ${vp.height}`;
      const width = Math.min(host.clientWidth || 800, 900);
      const c = await renderPage(page, (width * Math.min(window.devicePixelRatio || 1, 2)) / vp.width);
      box.appendChild(c);
      const num = document.createElement('span');
      num.className = 'es-page-num';
      num.textContent = `Page ${i} of ${pdf.numPages}`;
      box.appendChild(num);
      box.addEventListener('pointerdown', (e) => startDraw(e, box, i - 1));
      host.appendChild(box);
      info.box = box;
      page.cleanup();
    }
    $('mt-info').textContent = `${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}${anyText ? '' : ' · no text found, so draw boxes (or run OCR PDF first to find words)'}`;
    renderPatterns();
    renderTerms();
    renderBoxes();
  } finally {
    busy(null);
  }
}

// ------------------------------------------------------------------ finding

/** Boxes (in page points) covering text[start, end) on one page, one per bit run. */
function boxesFor(p: PageInfo, start: number, end: number): Rect[] {
  const out: Rect[] = [];
  let cur: { bit: TextBit; a: number; b: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const e = charEdges(cur.bit);
    // Half a letter of extra room on each side covers the small error in the estimate.
    const pad = cur.bit.h * 0.22;
    const x0 = e[cur.a] - pad;
    const x1 = e[cur.b + 1] + pad;
    const last = out[out.length - 1];
    // Turned text: cover the whole run, since its letters don't run left to right.
    const r = cur.bit.angle ? { x: cur.bit.x, y: cur.bit.y, w: cur.bit.w, h: cur.bit.h } : { x: x0, y: cur.bit.y, w: x1 - x0, h: cur.bit.h };
    if (cur.bit.angle) {
      out.push(r);
      cur = null;
      return;
    }
    // Join with the previous box on the same line.
    if (last && Math.abs(last.y - r.y) < r.h * 0.5 && r.x - (last.x + last.w) < r.h * 1.5 && r.x >= last.x) {
      const right = Math.max(last.x + last.w, r.x + r.w);
      last.y = Math.min(last.y, r.y);
      last.h = Math.max(last.h, r.h);
      last.w = right - last.x;
    } else out.push(r);
    cur = null;
  };
  for (let k = start; k < end; k++) {
    const m = p.map[k];
    if (!m || m.i < 0) continue;
    if (cur && cur.bit === m.bit && m.i === cur.b + 1) cur.b = m.i;
    else {
      flush();
      cur = { bit: m.bit, a: m.i, b: m.i };
    }
  }
  flush();
  // A little padding so the edges of letters are covered too.
  return out.map((r) => ({ x: r.x, y: r.y - 0.5, w: r.w, h: r.h + 1 }));
}

function find(re: RegExp, source: string, check?: (s: string) => boolean): number {
  let n = 0;
  pages.forEach((p, pi) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p.text))) {
      if (!m[0]) {
        re.lastIndex++;
        continue;
      }
      if (check && !check(m[0])) continue;
      for (const r of boxesFor(p, m.index, m.index + m[0].length)) {
        matches.push({ ...r, id: `m${++seq}`, page: pi, source, on: true });
      }
      n++;
    }
  });
  return n;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function termRe(t: { text: string; cased: boolean; whole: boolean }): RegExp {
  // Spaces in the term match any run of spaces or a line break.
  const body = t.text.trim().split(/\s+/).map(escapeRe).join('\\s+');
  const edge = t.whole ? '(?<![\\p{L}\\p{N}])' : '';
  const tail = t.whole ? '(?![\\p{L}\\p{N}])' : '';
  return new RegExp(`${edge}${body}${tail}`, `gu${t.cased ? '' : 'i'}`);
}

function addTerm(): void {
  const input = $<HTMLInputElement>('mt-term');
  const text = input.value.trim();
  if (!text) return;
  const t = { text, cased: $<HTMLInputElement>('mt-case').checked, whole: $<HTMLInputElement>('mt-whole').checked };
  if (terms.some((x) => x.text === t.text && x.cased === t.cased && x.whole === t.whole)) return toast('Already in the list');
  terms.push(t);
  const n = find(termRe(t), `term:${terms.length - 1}`);
  input.value = '';
  toast(n ? `Found ${n} match${n === 1 ? '' : 'es'}` : 'No matches');
  renderTerms();
  renderBoxes();
}

function renderTerms(): void {
  const host = $('mt-terms');
  host.textContent = '';
  terms.forEach((t, i) => {
    const n = matches.filter((m) => m.source === `term:${i}`).length;
    const chip = document.createElement('span');
    chip.className = 'mt-term';
    chip.innerHTML = `<span></span><b class="es-sub" style="font-weight:600"></b><button type="button" aria-label="Remove">&times;</button>`;
    chip.querySelector('span')!.textContent = t.text;
    chip.querySelector('b')!.textContent = String(n);
    chip.querySelector('button')!.onclick = () => {
      matches = matches.filter((m) => m.source !== `term:${i}`);
      terms[i] = { text: '', cased: false, whole: false };
      chip.remove();
      renderBoxes();
    };
    if (t.text) host.appendChild(chip);
  });
}

function renderPatterns(): void {
  const host = $('mt-patterns');
  host.textContent = '';
  for (const p of PATTERNS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mt-chip-btn' + (patternsOn.has(p.key) ? ' is-on' : '');
    const n = new Set(matches.filter((m) => m.source === `pat:${p.key}`).map((m) => m.id)).size;
    b.innerHTML = `${escapeHtml(p.label)}${patternsOn.has(p.key) ? ` <b>${n}</b>` : ''}`;
    b.onclick = () => {
      if (patternsOn.has(p.key)) {
        patternsOn.delete(p.key);
        matches = matches.filter((m) => m.source !== `pat:${p.key}`);
      } else {
        patternsOn.add(p.key);
        const found = find(new RegExp(p.re.source, p.re.flags), `pat:${p.key}`, p.check);
        toast(found ? `Found ${found}` : `No ${p.label.toLowerCase()} found`);
      }
      renderPatterns();
      renderBoxes();
    };
    host.appendChild(b);
  }
}

// ------------------------------------------------------------------ boxes on the pages

function renderBoxes(): void {
  document.querySelectorAll('#mt-pages .mt-box').forEach((el) => el.remove());
  for (const m of matches) {
    const p = pages[m.page];
    if (!p?.box) continue;
    const el = document.createElement('div');
    el.className = 'mt-box' + (m.on ? '' : ' is-off') + (m.source === 'draw' ? ' is-draw' : '');
    el.style.left = `${(m.x / p.w) * 100}%`;
    el.style.top = `${(m.y / p.h) * 100}%`;
    el.style.width = `${(m.w / p.w) * 100}%`;
    el.style.height = `${(m.h / p.h) * 100}%`;
    el.tabIndex = 0;
    el.title = m.source === 'draw' ? 'Drawn box' : m.on ? 'Will be redacted. Tap to skip.' : 'Skipped. Tap to redact.';
    if (m.source === 'draw') {
      const x = document.createElement('span');
      x.className = 'es-x';
      x.textContent = '×';
      x.setAttribute('role', 'button');
      x.setAttribute('aria-label', 'Remove box');
      x.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        matches = matches.filter((y) => y.id !== m.id);
        renderBoxes();
      });
      el.appendChild(x);
    }
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (m.source === 'draw') return;
      // All boxes of one match (a match across two lines) switch together.
      const same = matches.filter((y) => y.id === m.id);
      same.forEach((y) => (y.on = !m.on));
      renderBoxes();
    });
    p.box.appendChild(el);
  }
  const on = new Set(matches.filter((m) => m.on).map((m) => m.id));
  const pagesHit = new Set(matches.filter((m) => m.on).map((m) => m.page));
  $('mt-count').textContent = on.size ? `${on.size} to redact on ${pagesHit.size} page${pagesHit.size === 1 ? '' : 's'}` : 'Nothing marked yet';
  $<HTMLButtonElement>('mt-go').disabled = !on.size;
  renderPatternCounts();
}

function renderPatternCounts(): void {
  const host = $('mt-terms');
  host.querySelectorAll<HTMLElement>('.mt-term').forEach((chip, k) => {
    const live = terms.map((t, i) => ({ t, i })).filter(({ t }) => t.text)[k];
    if (live) chip.querySelector('b')!.textContent = String(new Set(matches.filter((m) => m.source === `term:${live.i}`).map((m) => m.id)).size);
  });
}

function startDraw(e: PointerEvent, box: HTMLElement, pageIndex: number): void {
  if (!drawing) return;
  e.preventDefault();
  const r = box.getBoundingClientRect();
  const p = pages[pageIndex];
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;
  const ghost = document.createElement('div');
  ghost.className = 'mt-box is-draw';
  box.appendChild(ghost);
  box.setPointerCapture(e.pointerId);
  const place = (ev: PointerEvent) => {
    const x = Math.min(Math.max(ev.clientX - r.left, 0), r.width);
    const y = Math.min(Math.max(ev.clientY - r.top, 0), r.height);
    const left = Math.min(sx, x);
    const top = Math.min(sy, y);
    ghost.style.left = `${left}px`;
    ghost.style.top = `${top}px`;
    ghost.style.width = `${Math.abs(x - sx)}px`;
    ghost.style.height = `${Math.abs(y - sy)}px`;
    return { left, top, w: Math.abs(x - sx), h: Math.abs(y - sy) };
  };
  const move = (ev: PointerEvent): void => void place(ev);
  const up = (ev: PointerEvent): void => {
    box.removeEventListener('pointermove', move);
    box.removeEventListener('pointerup', up);
    box.removeEventListener('pointercancel', up);
    const g = place(ev);
    ghost.remove();
    if (g.w < 4 || g.h < 4) return;
    const k = p.w / r.width;
    matches.push({ id: `d${++seq}`, page: pageIndex, x: g.left * k, y: g.top * k, w: g.w * k, h: g.h * k, source: 'draw', on: true });
    renderBoxes();
  };
  box.addEventListener('pointermove', move);
  box.addEventListener('pointerup', up);
  box.addEventListener('pointercancel', up);
}

// ------------------------------------------------------------------ applying

const hit = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function encodable(font: PDFFont, s: string): string {
  let out = '';
  for (const ch of s) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += ' ';
    }
  }
  return out;
}

async function apply(): Promise<void> {
  if (!pdf || !bytes || !file) return;
  const stripMeta = $<HTMLInputElement>('mt-meta').checked;
  const live = matches.filter((m) => m.on);
  const byPage = new Map<number, Rect[]>();
  for (const m of live) byPage.set(m.page, [...(byPage.get(m.page) || []), m]);

  try {
    busy('Preparing...');
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const out = await PDFDocument.create({ updateMetadata: false });
    const font = await out.embedFont(StandardFonts.Helvetica);
    const total = pdf.numPages;
    for (let i = 0; i < total; i++) {
      const rects = byPage.get(i);
      if (!rects) {
        const [copy] = await out.copyPages(src, [i]);
        if (stripMeta) copy.node.delete(PDFName.of('Annots'));
        out.addPage(copy);
        continue;
      }
      busy(`Redacting page ${i + 1} of ${total}...`, i / total);
      const page = await pdf.getPage(i + 1);
      const info = pages[i];
      const dpi = 200;
      const scale = dpi / 72;
      const canvas = await renderPage(page, scale);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#000';
      for (const r of rects) ctx.fillRect(Math.floor(r.x * scale), Math.floor(r.y * scale), Math.ceil(r.w * scale) + 1, Math.ceil(r.h * scale) + 1);
      const img = await out.embedJpg(new Uint8Array(await (await canvasBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer()));
      const np = out.addPage([info.w, info.h]);
      np.drawImage(img, { x: 0, y: 0, width: info.w, height: info.h });
      // Put back the words outside the boxes, invisibly, so search and copy still work.
      for (const b of info.bits) {
        const len = b.str.length;
        // Turned text isn't put back; a box may cover any part of it.
        if (!len || b.angle) continue;
        let run = '';
        let runStart = 0;
        const flush = (endIdx: number) => {
          const t = encodable(font, run).replace(/\s+$/, '');
          if (t.trim()) {
            const size = Math.max(1, b.h / 1.12);
            const ee = charEdges(b);
            const x = ee[runStart];
            const wanted = ee[endIdx] - ee[runStart];
            const natural = font.widthOfTextAtSize(t, size) || 1;
            np.drawText(t, { x, y: info.h - (b.y + b.h * 0.82), size: Math.max(1, Math.min(size, size * (wanted / natural) * 1.02)), font, opacity: 0 });
          }
          run = '';
        };
        const e = charEdges(b);
        for (let c = 0; c < len; c++) {
          const cr = { x: e[c], y: b.y, w: Math.max(0.01, e[c + 1] - e[c]), h: b.h };
          const hidden = rects.some((r) => hit(cr, r));
          if (hidden) {
            if (run) flush(c);
            runStart = c + 1;
          } else {
            if (!run) runStart = c;
            run += b.str[c];
          }
        }
        if (run) flush(len);
      }
      page.cleanup();
    }
    if (!stripMeta) {
      const t = src.getTitle();
      const a = src.getAuthor();
      if (t) out.setTitle(t);
      if (a) out.setAuthor(a);
    }
    out.setProducer('Paperhaus');
    out.setCreator('Paperhaus Redact PDF');
    busy('Saving...', 1);
    const result = await out.save();
    // Check our own work: none of the redacted words can be read back from rebuilt pages.
    const leaked = await verify(result, live);
    download(result, `${baseName(file.name)} (redacted).pdf`);
    if (leaked.length) {
      alertBox('Check the redacted file', `Some redacted text could still be read on page ${leaked.join(', ')}. Draw larger boxes over it and redact again.`);
    } else {
      toast(`Redacted ${new Set(live.map((m) => m.id)).size} item${live.length === 1 ? '' : 's'}. Checked: none of it can be read back.`);
    }
  } catch (err) {
    console.error(err);
    alertBox('Could not redact', String((err as Error).message || err));
  } finally {
    busy(null);
  }
}

async function verify(result: Uint8Array, live: Match[]): Promise<number[]> {
  const doc = await openPdf(result);
  const bad: number[] = [];
  const byPage = new Map<number, string[]>();
  for (const m of live) {
    if (m.source === 'draw') continue;
    const p = pages[m.page];
    const words = boxesText(p, m);
    if (words) byPage.set(m.page, [...(byPage.get(m.page) || []), words]);
  }
  for (const [pi, words] of byPage) {
    const page = await doc.getPage(pi + 1);
    const tc = await page.getTextContent();
    const text = (tc.items as Array<{ str?: string }>).map((it) => it.str || '').join(' ').replace(/\s+/g, '');
    if (words.some((w) => w.length > 2 && text.includes(w))) bad.push(pi + 1);
  }
  doc.destroy();
  return bad;
}

/** The characters (no spaces) a box covers on its page. */
function boxesText(p: PageInfo, r: Rect): string {
  let s = '';
  for (const b of p.bits) {
    const len = b.str.length;
    if (b.angle) {
      if (hit(b, r)) s += b.str;
      continue;
    }
    const e = charEdges(b);
    for (let c = 0; c < len; c++) {
      const cr = { x: (e[c] + e[c + 1]) / 2, y: b.y + b.h / 2, w: 0.01, h: 0.01 };
      if (hit(cr, r)) s += b.str[c];
    }
  }
  return s.replace(/\s+/g, '');
}

onReady(() => {
  backToTools();
  pickFile('mt-drop', 'mt-file', (f) => void load(f));
  $('mt-change').addEventListener('click', () => $<HTMLInputElement>('mt-file').click());
  $('mt-add-term').addEventListener('click', addTerm);
  $('mt-term').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') addTerm();
  });
  $('mt-draw').addEventListener('click', () => {
    drawing = !drawing;
    $('mt-draw').classList.toggle('is-on', drawing);
    document.querySelectorAll('.mt-rpage').forEach((b) => b.classList.toggle('is-drawing', drawing));
  });
  $('mt-go').addEventListener('click', () => void apply());
});
