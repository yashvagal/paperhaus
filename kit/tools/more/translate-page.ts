/**
 * Paperhaus: Translate PDF, with the translator built into Chrome (on-device models).
 * "Same layout" redraws each page without its words, then paints the translation into
 * each text block at a size that fits. Drawing it as a picture means every script
 * (Devanagari, Arabic, CJK...) shows correctly without embedding fonts.
 */
import { PDFDocument } from 'pdf-lib';
import {
  $,
  type Line,
  type PdfDoc,
  alertBox,
  backToTools,
  baseName,
  busy,
  canvasBlob,
  download,
  fitText,
  joinLines,
  onReady,
  openPdf,
  pageLines,
  pickFile,
  readPdf,
  renderPage,
  thumb,
  toast,
} from './more-common.js';

interface TranslatorLike {
  translate(text: string): Promise<string>;
  destroy?(): void;
}
interface TranslatorStatic {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(o: Record<string, unknown>): Promise<TranslatorLike>;
}
interface DetectorStatic {
  availability(): Promise<string>;
  create(o?: Record<string, unknown>): Promise<{ detect(t: string): Promise<{ detectedLanguage: string; confidence: number }[]> }>;
}
const T = (globalThis as unknown as { Translator?: TranslatorStatic }).Translator;
const D = (globalThis as unknown as { LanguageDetector?: DetectorStatic }).LanguageDetector;

// Languages Chrome's translator offers (it says per pair whether a model exists).
const LANGS: [string, string][] = [
  ['ar', 'Arabic'], ['bg', 'Bulgarian'], ['bn', 'Bengali'], ['cs', 'Czech'], ['da', 'Danish'], ['de', 'German'],
  ['el', 'Greek'], ['en', 'English'], ['es', 'Spanish'], ['fi', 'Finnish'], ['fr', 'French'], ['hi', 'Hindi'],
  ['hr', 'Croatian'], ['hu', 'Hungarian'], ['id', 'Indonesian'], ['it', 'Italian'], ['he', 'Hebrew'], ['ja', 'Japanese'],
  ['kn', 'Kannada'], ['ko', 'Korean'], ['lt', 'Lithuanian'], ['mr', 'Marathi'], ['nl', 'Dutch'], ['no', 'Norwegian'],
  ['pl', 'Polish'], ['pt', 'Portuguese'], ['ro', 'Romanian'], ['ru', 'Russian'], ['sk', 'Slovak'], ['sl', 'Slovenian'],
  ['sv', 'Swedish'], ['ta', 'Tamil'], ['te', 'Telugu'], ['th', 'Thai'], ['tr', 'Turkish'], ['uk', 'Ukrainian'],
  ['vi', 'Vietnamese'], ['zh', 'Chinese (Simplified)'], ['zh-Hant', 'Chinese (Traditional)'],
];
const nameOf = (code: string) => LANGS.find(([c]) => c === code)?.[1] || code;

let file: File | null = null;
let pdf: PdfDoc | null = null;
let result: { data: Uint8Array | string; name: string; type: string } | null = null;

function note(kind: '' | 'warn' | 'good', html: string): void {
  const n = $('mt-ai-note');
  n.className = `es-note${kind ? ` es-${kind}` : ''}`;
  n.innerHTML = html;
  n.classList.remove('hidden');
}

function checkSupport(): boolean {
  if (!T) {
    note('warn', 'This browser has no built-in translator. It needs <strong>Google Chrome 138 or newer on a computer</strong> (Windows, Mac or Linux, not a phone).');
    return false;
  }
  return true;
}

async function load(f: File): Promise<void> {
  busy('Opening the PDF...');
  try {
    const r = await readPdf(f);
    if (!r) return;
    pdf?.destroy();
    file = f;
    pdf = r.pdf;
    $('mt-drop').classList.add('hidden');
    $('mt-doc').classList.remove('hidden');
    $('mt-name').textContent = f.name;
    $('mt-result').classList.add('hidden');
    let sample = '';
    for (let i = 1; i <= Math.min(pdf.numPages, 3) && sample.length < 2000; i++) {
      const page = await pdf.getPage(i);
      sample += joinLines(await pageLines(page)) + '\n';
    }
    const words = sample.split(/\s+/).filter(Boolean).length;
    $('mt-info').textContent = `${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}`;
    $<HTMLButtonElement>('mt-go').disabled = !words;
    if (!words) {
      alertBox('No text in this PDF', 'It looks like a scan. Run OCR PDF on it first, then translate the result.');
      return;
    }
    if (D) {
      try {
        const det = await (await D.create()).detect(sample.slice(0, 2000));
        const top = det[0];
        if (top && top.confidence > 0.5) {
          const code = top.detectedLanguage.split('-')[0];
          $('mt-info').textContent += ` · looks like ${nameOf(code)}`;
          $<HTMLSelectElement>('mt-from').dataset.detected = code;
        }
      } catch {
        /* detection is optional */
      }
    }
  } finally {
    busy(null);
  }
}

/** Group a page's lines into blocks (paragraphs, table cells, headings). */
function blocks(lines: Line[]): Line[] {
  const out: Line[] = [];
  for (const l of lines) {
    const b = out[out.length - 1];
    const similar = b && Math.abs(l.size - b.size) <= Math.max(b.size, l.size) * 0.2;
    const gap = b ? l.y - (b.y + b.h) : 0;
    const aligned = b && (Math.abs(l.x - b.x) < b.size * 2.5 || (l.x >= b.x - 2 && l.x <= b.x + b.w));
    const overlapX = b && l.x < b.x + b.w && l.x + l.w > b.x;
    if (b && !b.angle && !l.angle && similar && gap > -b.h * 0.5 && gap < b.size * 0.9 && aligned && overlapX) {
      const right = Math.max(b.x + b.w, l.x + l.w);
      const bottom = Math.max(b.y + b.h, l.y + l.h);
      b.x = Math.min(b.x, l.x);
      b.y = Math.min(b.y, l.y);
      b.w = right - b.x;
      b.h = bottom - b.y;
      b.text = /-$/.test(b.text) ? b.text.slice(0, -1) + l.text : `${b.text} ${l.text}`;
      b.items.push(...l.items);
    } else out.push({ ...l, items: [...l.items] });
  }
  return out;
}

function colorAt(full: ImageData, bare: ImageData, l: Line, s: number): string {
  const W = full.width;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const x0 = Math.max(0, Math.floor(l.x * s));
  const x1 = Math.min(W - 1, Math.ceil((l.x + l.w) * s));
  const y0 = Math.max(0, Math.floor(l.y * s));
  const y1 = Math.min(full.height - 1, Math.ceil((l.y + Math.min(l.h, l.size * 1.3)) * s));
  const step = Math.max(1, Math.floor((x1 - x0) / 150));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x += step) {
      const i = (y * W + x) * 4;
      if (Math.abs(full.data[i] - bare.data[i]) + Math.abs(full.data[i + 1] - bare.data[i + 1]) + Math.abs(full.data[i + 2] - bare.data[i + 2]) > 120) {
        r += full.data[i];
        g += full.data[i + 1];
        b += full.data[i + 2];
        n++;
      }
    }
  }
  if (!n) return '#111';
  return `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
}

const FONT_FOR: Record<string, string> = {
  serif: '"Times New Roman", "Noto Serif", Georgia, serif',
  monospace: '"Courier New", ui-monospace, monospace',
};

async function translate(): Promise<void> {
  if (!pdf || !file) return;
  if (!checkSupport()) return;
  const fromSel = $<HTMLSelectElement>('mt-from').value;
  const from = fromSel === 'auto' ? $<HTMLSelectElement>('mt-from').dataset.detected || '' : fromSel;
  const to = $<HTMLSelectElement>('mt-to').value;
  if (!from) return alertBox('Choose the language', 'Paperhaus could not tell which language this PDF is in. Choose it under From.');
  if (from === to) return alertBox('Same language', `The PDF already looks like ${nameOf(to)}. Choose another language under To.`);
  const out = document.querySelector<HTMLInputElement>('input[name="out"]:checked')?.value || 'layout';
  let tr: TranslatorLike | null = null;
  try {
    busy('Starting the translator...');
    const avail = await T!.availability({ sourceLanguage: from, targetLanguage: to });
    if (avail === 'unavailable') {
      alertBox('Not available', `Chrome can't translate ${nameOf(from)} to ${nameOf(to)} on this computer yet. Try another language, or English as a step in between.`);
      return;
    }
    tr = await T!.create({
      sourceLanguage: from,
      targetLanguage: to,
      monitor(m: EventTarget) {
        m.addEventListener('downloadprogress', (e) => {
          const loaded = (e as unknown as { loaded: number }).loaded;
          busy(`Downloading the ${nameOf(from)} to ${nameOf(to)} model, once... ${Math.round(loaded * 100)}%`, loaded);
        });
      },
    });
    const cache = new Map<string, Promise<string>>();
    const say = (s: string) => {
      const key = s.trim();
      if (!key || !/\p{L}/u.test(key)) return Promise.resolve(s);
      if (!cache.has(key)) cache.set(key, tr!.translate(key).catch((): string => key));
      return cache.get(key)!;
    };

    if (out === 'text') {
      const parts: string[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        busy(`Translating page ${i} of ${pdf.numPages}...`, (i - 1) / pdf.numPages);
        const page = await pdf.getPage(i);
        const paras = joinLines(await pageLines(page)).split(/\n\n+/);
        const done: string[] = [];
        for (const p of paras) done.push(await say(p));
        parts.push(`--- Page ${i} ---\n\n${done.join('\n\n')}`);
        page.cleanup();
      }
      result = { data: parts.join('\n\n'), name: `${baseName(file.name)} (${nameOf(to)}).txt`, type: 'text/plain;charset=utf-8' };
      $('mt-preview').innerHTML = '';
      const pre = document.createElement('div');
      pre.className = 'mt-out';
      pre.style.gridColumn = '1 / -1';
      pre.textContent = String(result.data).slice(0, 4000) + (String(result.data).length > 4000 ? '\n...' : '');
      $('mt-preview').appendChild(pre);
    } else {
      const doc = await PDFDocument.create();
      const scale = 2.5; // about 180 dpi
      const rtl = ['ar', 'he'].includes(to);
      for (let i = 1; i <= pdf.numPages; i++) {
        busy(`Translating page ${i} of ${pdf.numPages}...`, (i - 1) / pdf.numPages);
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        const bks = blocks(await pageLines(page));
        const bare = await renderPage(page, scale, { noText: true });
        const full = await renderPage(page, scale);
        const ctx = bare.getContext('2d')!;
        const fd = full.getContext('2d')!.getImageData(0, 0, full.width, full.height);
        const bd = ctx.getImageData(0, 0, bare.width, bare.height);
        const colors = bks.map((b) => colorAt(fd, bd, b, scale));
        const texts = await Promise.all(bks.map((b) => say(b.text)));
        ctx.direction = rtl ? 'rtl' : 'ltr';
        bks.forEach((b, k) => {
          if (b.angle) {
            // Turned text: draw along its own baseline.
            const it = b.items[0];
            ctx.save();
            ctx.translate(it.ox * scale, it.oy * scale);
            ctx.rotate(b.angle);
            fitText(ctx, texts[k], 0, -it.fh * scale, it.len * scale * 1.2, it.fh * scale * 1.3, it.fh * scale, FONT_FOR[b.family] || undefined, colors[k]);
            ctx.restore();
            return;
          }
          // Translations run longer than the original, so let a box grow into the space to its right and below.
          const w = Math.max(b.w, Math.min(vp.width - b.x - 18, b.w * 1.15)) * scale;
          const h = b.h * scale * 1.1;
          const x = (rtl ? b.x + b.w : b.x) * scale;
          fitText(ctx, texts[k], x, b.y * scale, w, h, b.size * scale, FONT_FOR[b.family] || undefined, colors[k]);
        });
        const img = await doc.embedJpg(new Uint8Array(await (await canvasBlob(bare, 'image/jpeg', 0.9)).arrayBuffer()));
        const np = doc.addPage([vp.width, vp.height]);
        np.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
        page.cleanup();
      }
      doc.setTitle(`${baseName(file.name)} (${nameOf(to)})`);
      doc.setProducer('Paperhaus');
      const bytes = await doc.save();
      result = { data: bytes, name: `${baseName(file.name)} (${nameOf(to)}).pdf`, type: 'application/pdf' };
      const prev = await openPdf(bytes);
      const host = $('mt-preview');
      host.textContent = '';
      for (let i = 1; i <= Math.min(prev.numPages, 4); i++) {
        const b = document.createElement('div');
        b.className = 'mt-thumb';
        b.appendChild(await thumb(prev, i, 240));
        host.appendChild(b);
      }
      prev.destroy();
    }
    $('mt-result').classList.remove('hidden');
    $('mt-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('Translated');
  } catch (err) {
    console.error(err);
    const msg = String((err as Error).message || err);
    alertBox('Could not translate', /user activation|gesture/i.test(msg) ? 'Press Translate again to let Chrome download the language model.' : msg);
  } finally {
    tr?.destroy?.();
    busy(null);
  }
}

onReady(() => {
  backToTools();
  checkSupport();
  const from = $<HTMLSelectElement>('mt-from');
  const to = $<HTMLSelectElement>('mt-to');
  for (const [c, n] of LANGS) {
    from.add(new Option(n, c));
    to.add(new Option(n, c));
  }
  let saved = '';
  try {
    saved = localStorage.getItem('paperhaus-translate-to') || '';
  } catch {
    /* ignore */
  }
  const ui = (navigator.language || 'en').split('-')[0];
  to.value = saved || (ui !== 'en' && LANGS.some(([c]) => c === ui) ? ui : 'es');
  to.addEventListener('change', () => {
    try {
      localStorage.setItem('paperhaus-translate-to', to.value);
    } catch {
      /* ignore */
    }
  });
  pickFile('mt-drop', 'mt-file', (f) => void load(f));
  $('mt-change').addEventListener('click', () => $<HTMLInputElement>('mt-file').click());
  $('mt-go').addEventListener('click', () => void translate());
  $('mt-save').addEventListener('click', () => result && download(typeof result.data === 'string' ? new Blob([result.data], { type: result.type }) : result.data, result.name, result.type));
});
