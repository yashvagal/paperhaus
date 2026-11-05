/**
 * Paperhaus: PDF to PowerPoint. Each page becomes one slide, either as a picture of the
 * page or as editable text boxes laid over the page with its words taken out.
 */
import PptxGenJS from 'pptxgenjs';
import {
  $,
  type Line,
  type PdfDoc,
  alertBox,
  backToTools,
  baseName,
  busy,
  canvasBlob,
  fontStyle,
  joinLines,
  onReady,
  pageLines,
  pickFile,
  readPdf,
  renderPage,
  thumb,
  toast,
} from './more-common.js';

const MAX_PAGES = 300;
const PX_TARGET = 2000; // longest side of each slide picture, in pixels

let file: File | null = null;
let pdf: PdfDoc | null = null;

async function load(f: File): Promise<void> {
  busy('Opening the PDF...');
  try {
    const r = await readPdf(f);
    if (!r) return;
    if (r.pdf.numPages > MAX_PAGES) {
      alertBox('Too many pages', `This PDF has ${r.pdf.numPages} pages. Split it into parts of up to ${MAX_PAGES} pages first.`);
      return;
    }
    pdf?.destroy();
    file = f;
    pdf = r.pdf;
    $('mt-drop').classList.add('hidden');
    $('mt-doc').classList.remove('hidden');
    $('mt-name').textContent = f.name;
    $('mt-info').textContent = `${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}, ${pdf.numPages} slide${pdf.numPages === 1 ? '' : 's'}`;
    $<HTMLButtonElement>('mt-go').disabled = false;
    const host = $('mt-thumbs');
    host.textContent = '';
    const show = Math.min(pdf.numPages, 8);
    for (let i = 1; i <= show; i++) {
      const box = document.createElement('div');
      box.className = 'mt-thumb';
      box.appendChild(await thumb(pdf, i, 180));
      const n = document.createElement('span');
      n.textContent = String(i);
      box.appendChild(n);
      host.appendChild(box);
    }
    if (pdf.numPages > show) {
      const more = document.createElement('div');
      more.className = 'es-sub';
      more.style.alignSelf = 'center';
      more.textContent = `and ${pdf.numPages - show} more`;
      host.appendChild(more);
    }
  } finally {
    busy(null);
  }
}

const radio = (name: string) => (document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value || '');

function blobToData(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });
}

const FACES: Record<string, string> = { serif: 'Times New Roman', monospace: 'Courier New' };

/** The text's color, taken from where the page with words differs from the page without. */
function lineColor(full: ImageData, bare: ImageData, l: Line, s: number): string {
  const W = full.width;
  const x0 = Math.max(0, Math.floor(l.x * s));
  const y0 = Math.max(0, Math.floor(l.y * s));
  const x1 = Math.min(W - 1, Math.ceil((l.x + l.w) * s));
  const y1 = Math.min(full.height - 1, Math.ceil((l.y + l.h) * s));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const step = Math.max(1, Math.floor((x1 - x0) / 120));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x += step) {
      const i = (y * W + x) * 4;
      const d = Math.abs(full.data[i] - bare.data[i]) + Math.abs(full.data[i + 1] - bare.data[i + 1]) + Math.abs(full.data[i + 2] - bare.data[i + 2]);
      if (d > 120) {
        r += full.data[i];
        g += full.data[i + 1];
        b += full.data[i + 2];
        n++;
      }
    }
  }
  if (!n) return '000000';
  const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
  return `${hex(r)}${hex(g)}${hex(b)}`;
}

async function convert(): Promise<void> {
  if (!pdf || !file) return;
  const mode = radio('mode');
  const size = radio('size');
  const notes = $<HTMLInputElement>('mt-notes').checked;
  const pptx = new PptxGenJS();
  pptx.title = baseName(file.name);
  pptx.company = 'Paperhaus';

  const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
  let SW = 13.333;
  let SH = 7.5;
  if (size === 'standard') SW = 10;
  if (size === 'match') {
    // PowerPoint allows 1-56 inches per side; scale big pages down to fit.
    const k = Math.min(1, 56 / (first.width / 72), 56 / (first.height / 72));
    SW = Math.max(1, (first.width / 72) * k);
    SH = Math.max(1, (first.height / 72) * k);
  }
  pptx.defineLayout({ name: 'PH', width: SW, height: SH });
  pptx.layout = 'PH';

  let editableText = 0;
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      busy(`Making slide ${i} of ${pdf.numPages}...`, (i - 1) / pdf.numPages);
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      // Fit the page inside the slide, centred.
      const fit = Math.min(SW / (vp.width / 72), SH / (vp.height / 72));
      const w = (vp.width / 72) * fit;
      const h = (vp.height / 72) * fit;
      const ox = (SW - w) / 2;
      const oy = (SH - h) / 2;
      const scale = Math.min(4, PX_TARGET / Math.max(vp.width, vp.height));
      const lines = await pageLines(page);
      const slide = pptx.addSlide();
      slide.background = { color: 'FFFFFF' };

      // Turned text can't be placed as plain text boxes, so such pages stay pictures.
      const turned = lines.some((l) => l.angle);
      if (mode === 'editable' && lines.length && !turned) {
        const bare = await renderPage(page, scale, { noText: true });
        const full = await renderPage(page, scale);
        const fd = full.getContext('2d')!.getImageData(0, 0, full.width, full.height);
        const bd = bare.getContext('2d')!.getImageData(0, 0, bare.width, bare.height);
        slide.addImage({ data: await blobToData(await canvasBlob(bare)), x: ox, y: oy, w, h });
        const inch = fit / 72; // PDF points to slide inches
        for (const l of lines) {
          slide.addText(l.text, {
            x: ox + l.x * inch,
            y: oy + l.y * inch,
            w: Math.max(l.w * inch * 1.04, 0.2),
            h: Math.max(l.h * inch, 0.12),
            fontSize: Math.max(1, Math.round(l.size * fit * 10) / 10),
            fontFace: FACES[l.family] || 'Arial',
            bold: fontStyle(page, l.items[0].fontName).bold,
            italic: fontStyle(page, l.items[0].fontName).italic,
            color: lineColor(fd, bd, l, scale),
            margin: 0,
            valign: 'top',
            wrap: false,
            fit: 'none',
          });
          editableText++;
        }
      } else {
        const c = await renderPage(page, scale);
        slide.addImage({ data: await blobToData(await canvasBlob(c)), x: ox, y: oy, w, h });
      }
      if (notes && lines.length) slide.addNotes(joinLines(lines));
      page.cleanup();
    }
    busy('Saving the PowerPoint file...', 1);
    const out = (await pptx.write({ outputType: 'blob' })) as Blob;
    const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${baseName(file.name)}.pptx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    if (mode === 'editable' && !editableText) {
      alertBox('Saved as pictures', 'This PDF has no text to edit (it may be a scan). The slides are pictures. Run OCR PDF first for editable text.');
    } else toast('PowerPoint file saved');
  } catch (err) {
    console.error(err);
    alertBox('Could not convert', String((err as Error).message || err));
  } finally {
    busy(null);
  }
}

onReady(() => {
  backToTools();
  pickFile('mt-drop', 'mt-file', (f) => void load(f));
  $('mt-change').addEventListener('click', () => $<HTMLInputElement>('mt-file').click());
  $('mt-go').addEventListener('click', () => void convert());
});
