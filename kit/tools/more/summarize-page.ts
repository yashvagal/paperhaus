/**
 * Paperhaus: Summarize PDF, with the Summarizer built into Chrome (Gemini Nano on the
 * device). The PDF's text never leaves the computer. Long documents are summarized in
 * parts, then the parts are summarized together.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { $, type PdfDoc, alertBox, backToTools, baseName, busy, copyText, download, escapeHtml, onReady, pdfText, pickFile, readPdf } from './more-common.js';

interface SummarizerLike {
  summarize(text: string, o?: { context?: string }): Promise<string>;
  measureInputUsage?(text: string): Promise<number>;
  inputQuota?: number;
  destroy?(): void;
}
interface SummarizerStatic {
  availability(o?: Record<string, unknown>): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>;
  create(o: Record<string, unknown>): Promise<SummarizerLike>;
}
const API = (globalThis as unknown as { Summarizer?: SummarizerStatic }).Summarizer;

let file: File | null = null;
let pdf: PdfDoc | null = null;
let pagesText: string[] = [];
let lastMarkdown = '';

function note(kind: '' | 'warn' | 'bad' | 'good', html: string): void {
  const n = $('mt-ai-note');
  n.className = `es-note${kind ? ` es-${kind}` : ''}`;
  n.innerHTML = html;
  n.classList.remove('hidden');
}

async function checkSupport(): Promise<boolean> {
  if (!API) {
    note(
      'warn',
      'This browser has no built-in AI summarizer. It needs <strong>Google Chrome 138 or newer on a computer</strong> (Windows, Mac or Linux, not a phone), with about 22 GB free. You can still copy the text and ask Claude: open a PDF, then press <strong>Copy text for Claude</strong>.'
    );
    return false;
  }
  try {
    const a = await API.availability({ type: 'key-points', format: 'markdown', length: 'medium', expectedInputLanguages: ['en'], outputLanguage: 'en' });
    if (a === 'unavailable') {
      note('warn', 'Chrome\'s AI summarizer is not available on this computer (it needs about 22 GB free and a capable graphics card or 16 GB of memory). You can still copy the text and ask Claude.');
      return false;
    }
    if (a === 'downloadable' || a === 'downloading') {
      note('', 'The first summary downloads Chrome\'s on-device AI model once (about 2 GB). After that it works offline.');
    }
    return true;
  } catch {
    return false;
  }
}

async function load(f: File): Promise<void> {
  busy('Reading the PDF...');
  try {
    const r = await readPdf(f);
    if (!r) return;
    pdf?.destroy();
    file = f;
    pdf = r.pdf;
    pagesText = await pdfText(pdf, (i) => busy(`Reading page ${i} of ${pdf!.numPages}...`));
    const words = pagesText.join(' ').split(/\s+/).filter(Boolean).length;
    $('mt-drop').classList.add('hidden');
    $('mt-doc').classList.remove('hidden');
    $('mt-name').textContent = f.name;
    $('mt-info').textContent = `${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'} · about ${words.toLocaleString()} words`;
    $<HTMLButtonElement>('mt-go').disabled = !words;
    if (!words) alertBox('No text in this PDF', 'It looks like a scan. Run OCR PDF on it first, then summarize the result.');
    addCopyForClaude();
  } finally {
    busy(null);
  }
}

function addCopyForClaude(): void {
  if (document.getElementById('mt-claude')) return;
  const b = document.createElement('button');
  b.id = 'mt-claude';
  b.type = 'button';
  b.className = 'es-btn';
  b.innerHTML = '<i class="ph ph-clipboard-text"></i> Copy text for Claude';
  b.onclick = () => {
    const body = pagesText.map((t, i) => `[Page ${i + 1}]\n${t}`).join('\n\n');
    void copyText(`Summarize this document ("${file?.name || 'document'}"). Give the key points, then anything I need to act on.\n\n${body}`);
  };
  $('mt-go').parentElement!.appendChild(b);
}

const radio = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value || '';

/** Split the pages into parts that fit the model's input, keeping pages whole when possible. */
async function parts(s: SummarizerLike): Promise<{ from: number; to: number; text: string }[]> {
  const quota = s.inputQuota && Number.isFinite(s.inputQuota) ? s.inputQuota : 4000;
  const fits = async (t: string) => (s.measureInputUsage ? (await s.measureInputUsage(t)) <= quota * 0.9 : t.length < quota * 3);
  const out: { from: number; to: number; text: string }[] = [];
  let cur = { from: 1, to: 0, text: '' };
  for (let i = 0; i < pagesText.length; i++) {
    const t = pagesText[i].trim();
    if (!t) continue;
    const next = cur.text ? `${cur.text}\n\n${t}` : t;
    if (await fits(next)) cur = { from: cur.text ? cur.from : i + 1, to: i + 1, text: next };
    else {
      if (cur.text) out.push(cur);
      // One page too long on its own: cut it by characters.
      if (!(await fits(t))) {
        const step = Math.floor(quota * 2.4);
        for (let k = 0; k < t.length; k += step) out.push({ from: i + 1, to: i + 1, text: t.slice(k, k + step) });
        cur = { from: i + 2, to: i + 1, text: '' };
      } else cur = { from: i + 1, to: i + 1, text: t };
    }
  }
  if (cur.text) out.push(cur);
  return out;
}

async function summarize(): Promise<void> {
  if (!pdf || !file) return;
  if (!API || !(await checkSupport())) {
    alertBox('Summaries need Chrome on a computer', 'Use Google Chrome 138 or newer on Windows, Mac or Linux. Or press Copy text for Claude and paste it into Claude.');
    return;
  }
  const type = radio('type');
  const length = radio('length');
  const perPart = $<HTMLInputElement>('mt-sections').checked;
  let s: SummarizerLike | null = null;
  try {
    busy('Starting the on-device AI...');
    s = await API.create({
      type,
      format: 'markdown',
      length,
      sharedContext: `A PDF document named "${file.name}".`,
      expectedInputLanguages: ['en'],
      outputLanguage: 'en',
      monitor(m: EventTarget) {
        m.addEventListener('downloadprogress', (e) => {
          const loaded = (e as unknown as { loaded: number }).loaded;
          busy(`Downloading the AI model, once... ${Math.round(loaded * 100)}%`, loaded);
        });
      },
    });
    const list = await parts(s);
    let final = '';
    const partSummaries: { label: string; text: string }[] = [];
    if (list.length === 1) {
      busy('Summarizing...');
      final = await s.summarize(list[0].text);
    } else {
      // Summarize each part as key points, then the key points together.
      const kp = await API.create({ type: 'key-points', format: 'markdown', length: 'medium', expectedInputLanguages: ['en'], outputLanguage: 'en' });
      for (const [k, p] of list.entries()) {
        busy(`Summarizing part ${k + 1} of ${list.length}...`, k / list.length);
        const label = p.from === p.to ? `Page ${p.from}` : `Pages ${p.from}-${p.to}`;
        partSummaries.push({ label, text: await kp.summarize(p.text, { context: `${label} of ${pdf.numPages}.` }) });
      }
      kp.destroy?.();
      busy('Putting it together...', 1);
      let joined = partSummaries.map((p) => p.text).join('\n');
      // If the parts are still too long together, trim from the end.
      while (s.measureInputUsage && s.inputQuota && (await s.measureInputUsage(joined)) > s.inputQuota * 0.9) joined = joined.slice(0, Math.floor(joined.length * 0.85));
      final = await s.summarize(joined, { context: 'These are key points from each part of one document, in order.' });
    }
    lastMarkdown = `# Summary of ${baseName(file.name)}\n\n${final.trim()}\n`;
    if (perPart && partSummaries.length) {
      lastMarkdown += `\n## By part\n\n${partSummaries.map((p) => `### ${p.label}\n\n${p.text.trim()}`).join('\n\n')}\n`;
    }
    $('mt-out').innerHTML = markdownToHtml(lastMarkdown.replace(/^# .*\n+/, ''));
    $('mt-result').classList.remove('hidden');
    $('mt-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    const msg = String((err as Error).message || err);
    alertBox('Could not summarize', /user activation|gesture/i.test(msg) ? 'Press Summarize again to let Chrome download its AI model.' : msg);
  } finally {
    s?.destroy?.();
    busy(null);
  }
}

/** Just enough Markdown for summaries: headings, bullets, bold. */
function markdownToHtml(md: string): string {
  const out: string[] = [];
  let list = false;
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const inline = (s: string) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
    const b = line.match(/^\s*[-*+]\s+(.*)/);
    if (b) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(b[1])}</li>`);
      continue;
    }
    if (list) {
      out.push('</ul>');
      list = false;
    }
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (h) out.push(`<h3>${inline(h[1])}</h3>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

async function asPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612;
  const H = 792;
  const M = 64;
  let page = doc.addPage([W, H]);
  let y = H - M;
  const safe = (f: PDFFont, s: string) => [...s].map((ch) => { try { f.encodeText(ch); return ch; } catch { return '?'; } }).join('');
  const write = (text: string, f: PDFFont, size: number, indent = 0, gap = 4) => {
    const words = safe(f, text).split(/\s+/);
    let line = '';
    const lines: string[] = [];
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > W - M * 2 - indent && line) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    if (line) lines.push(line);
    for (const l of lines) {
      if (y < M + size) {
        page = doc.addPage([W, H]);
        y = H - M;
      }
      page.drawText(l, { x: M + indent, y: y - size, size, font: f, color: rgb(0.1, 0.1, 0.12) });
      y -= size * 1.4;
    }
    y -= gap;
  };
  for (const raw of lastMarkdown.split('\n')) {
    const line = raw.trim().replace(/\*\*(.+?)\*\*/g, '$1');
    if (!line) continue;
    const h = line.match(/^(#{1,6})\s+(.*)/);
    const b = line.match(/^[-*+]\s+(.*)/);
    if (h) write(h[2], bold, h[1].length === 1 ? 18 : 13, 0, 6);
    else if (b) write(`•  ${b[1]}`, font, 11, 8, 2);
    else write(line, font, 11);
  }
  return doc.save();
}

onReady(() => {
  backToTools();
  void checkSupport();
  pickFile('mt-drop', 'mt-file', (f) => void load(f));
  $('mt-change').addEventListener('click', () => $<HTMLInputElement>('mt-file').click());
  $('mt-go').addEventListener('click', () => void summarize());
  $('mt-copy').addEventListener('click', () => void copyText(lastMarkdown));
  $('mt-md').addEventListener('click', () => download(lastMarkdown, `${baseName(file?.name || 'document')} (summary).md`, 'text/markdown'));
  $('mt-pdf').addEventListener('click', async () => download(await asPdf(), `${baseName(file?.name || 'document')} (summary).pdf`));
});
