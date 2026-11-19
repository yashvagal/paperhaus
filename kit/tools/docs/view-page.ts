/* Paperhaus: open one document (from My documents, Recent files or search) and use any
 * tool on it. PDFs are shown page by page with pdf.js; pictures as they are. The quick
 * tools hand the file to the tool page with ?ph-file=<id> (kit/tools/pin/flow.js). */
import * as pdfjsLib from 'pdfjs-dist';
import '../../utils/setup-pdf-worker.js';
import './documents.css';

interface Rec {
  id: string;
  name: string;
  type: string;
  size: number;
  at: number;
  tool?: string;
  blob?: Blob;
}
interface Flow {
  getAny(id: string): Promise<Rec | null>;
  setCurrent?: (recs: Rec[]) => void;
  kindOf(name: string, type: string): string;
  openSearch?: () => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const TO_PDF: Record<string, string> = {
  doc: 'word-to-pdf', docx: 'word-to-pdf', odt: 'odt-to-pdf', rtf: 'rtf-to-pdf',
  xls: 'excel-to-pdf', xlsx: 'excel-to-pdf', ods: 'ods-to-pdf', csv: 'csv-to-pdf',
  ppt: 'powerpoint-to-pdf', pptx: 'powerpoint-to-pdf', odp: 'odp-to-pdf',
  txt: 'txt-to-pdf', md: 'markdown-to-pdf', html: 'html-to-pdf', htm: 'html-to-pdf',
  epub: 'epub-to-pdf', svg: 'svg-to-pdf', eml: 'email-to-pdf', msg: 'email-to-pdf',
};

// [page (with optional query), label, icon, main?]
const PDF_TOOLS: [string, string, string, boolean?][] = [
  ['request-signatures?mode=me', 'Sign', 'ph-signature', true],
  ['request-signatures?mode=meothers', 'Sign with others', 'ph-users-three'],
  ['request-signatures?mode=others', 'Send for signature', 'ph-paper-plane-tilt'],
  ['edit-pdf', 'Edit, add text or notes', 'ph-pencil-simple-line'],
  ['form-filler', 'Fill in a form', 'ph-textbox'],
  ['pdf-multi-tool', 'Pages: reorder, delete, add', 'ph-squares-four'],
  ['rotate-pdf', 'Rotate', 'ph-arrow-clockwise'],
  ['merge-pdf', 'Combine with another PDF', 'ph-stack'],
  ['split-pdf', 'Split', 'ph-scissors'],
  ['compress-pdf', 'Make smaller', 'ph-arrows-in'],
  ['pdf-to-word', 'Turn into Word', 'ph-file-doc'],
  ['protect-pdf', 'Add a password', 'ph-lock-simple'],
  ['redact-pdf', 'Black out details', 'ph-eraser'],
  ['add-watermark', 'Add a watermark', 'ph-drop-half'],
  ['summarize-pdf', 'Summarize', 'ph-sparkle'],
  ['translate-pdf', 'Translate', 'ph-translate'],
];

function flowReady(): Promise<Flow | null> {
  return new Promise((resolve) => {
    let n = 0;
    const wait = (): void => {
      const f = (window as unknown as { paperhausFlow?: Flow }).paperhausFlow;
      if (f && f.getAny) return resolve(f);
      if (++n > 60) return resolve(null);
      setTimeout(wait, 100);
    };
    wait();
  });
}

const size = (b: number): string => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

function toolLink(page: string, label: string, icon: string, id: string, main = false): HTMLAnchorElement {
  const [path, query] = page.split('?');
  const a = document.createElement('a');
  a.className = 'dv-tool' + (main ? ' is-main' : '');
  a.href = `/${path}.html?${query ? query + '&' : ''}ph-file=${encodeURIComponent(id)}`;
  a.innerHTML = `<i class="ph ${icon}" aria-hidden="true"></i><span></span>`;
  a.querySelector('span')!.textContent = label;
  return a;
}

function fail(title: string, text: string): void {
  $('dv-name').textContent = title;
  $('dv-meta').textContent = text;
  $('dv-tools').closest('section')!.hidden = true;
}

async function showPdf(blob: Blob, host: HTMLElement): Promise<number> {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const pages: HTMLElement[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const box = document.createElement('div');
    box.className = 'dv-page';
    box.dataset.page = String(i);
    box.innerHTML = `<span class="dv-page-no">Page ${i} of ${pdf.numPages}</span>`;
    host.appendChild(box);
    pages.push(box);
  }
  // Draw pages as they come into view, so long documents open fast.
  const draw = async (box: HTMLElement): Promise<void> => {
    if (box.dataset.drawn) return;
    box.dataset.drawn = '1';
    const page = await pdf.getPage(Number(box.dataset.page));
    const base = page.getViewport({ scale: 1 });
    const width = Math.min(host.clientWidth, 900);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: (width / base.width) * ratio });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width;
    canvas.height = vp.height;
    canvas.style.width = '100%';
    canvas.style.aspectRatio = `${base.width} / ${base.height}`;
    box.prepend(canvas);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
  };
  const seen = new IntersectionObserver(
    (entries): void => entries.forEach((e) => { if (e.isIntersecting) void draw(e.target as HTMLElement); }),
    { rootMargin: '600px 0px' }
  );
  pages.forEach((p) => seen.observe(p));
  return pdf.numPages;
}

async function main(): Promise<void> {
  const id = new URLSearchParams(location.search).get('id') || '';
  const flow = await flowReady();
  if (!id || !flow) return fail('Nothing to open', 'Pick a document from My documents.');
  const rec = await flow.getAny(id).catch((): null => null);
  if (!rec || !rec.blob) return fail('This document is not available', 'It may have been removed, or it is still on another device that has not synced yet.');
  const blob = rec.blob;
  // Opening it makes it the document you're working on: every tool starts with it.
  if (flow.setCurrent) flow.setCurrent([rec]);
  document.title = `${rec.name} | Paperhaus`;
  $('dv-name').textContent = rec.name;
  const when = new Date(rec.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  $('dv-meta').textContent = [rec.tool ? `Made with ${rec.tool}` : '', when, size(rec.size || blob.size)].filter(Boolean).join(' · ');

  const dl = $<HTMLButtonElement>('dv-download');
  dl.disabled = false;
  dl.onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = rec.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 2000);
  };

  const kind = flow.kindOf(rec.name, rec.type);
  const tools = $('dv-tools');
  const view = $('dv-view');
  if (kind === 'pdf') {
    PDF_TOOLS.forEach(([page, label, icon, mainTool]) => tools.appendChild(toolLink(page, label, icon, rec.id, mainTool)));
  } else if (kind === 'image') {
    tools.appendChild(toolLink('image-to-pdf', 'Make a PDF', 'ph-file-pdf', rec.id, true));
    tools.appendChild(toolLink('scan-document', 'Clean up as a scan', 'ph-scan', rec.id));
  } else {
    const page = TO_PDF[(rec.name.split('.').pop() || '').toLowerCase()];
    if (page) tools.appendChild(toolLink(page, 'Turn into a PDF', 'ph-file-pdf', rec.id, true));
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'dv-tool';
  more.innerHTML = '<i class="ph ph-magnifying-glass" aria-hidden="true"></i><span>Find another tool</span>';
  more.onclick = () => flow.openSearch && flow.openSearch();
  tools.appendChild(more);

  try {
    if (kind === 'pdf') {
      const n = await showPdf(blob, view);
      $('dv-meta').textContent += ` · ${n} ${n === 1 ? 'page' : 'pages'}`;
    } else if (kind === 'image') {
      const img = document.createElement('img');
      img.className = 'dv-img';
      img.alt = rec.name;
      img.src = URL.createObjectURL(blob);
      view.appendChild(img);
    } else {
      const p = document.createElement('p');
      p.className = 'dc-muted dv-nopreview';
      p.textContent = 'There is no preview for this kind of file. Download it, or turn it into a PDF.';
      view.appendChild(p);
    }
  } catch {
    const p = document.createElement('p');
    p.className = 'dc-muted dv-nopreview';
    p.textContent = 'This file could not be shown. You can still download it or use a tool on it.';
    view.appendChild(p);
  }
}

void main();
