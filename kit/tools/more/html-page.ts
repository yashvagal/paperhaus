/**
 * Paperhaus: HTML to PDF. A web address (fetched through /api/fetch, signed-in only) or an
 * HTML file becomes a PDF, either as selectable text (MuPDF's HTML layout, already in
 * Paperhaus) or as an exact picture of the page (drawn by the browser, then split into pages).
 */
import html2canvas from 'html2canvas';
import { PDFDocument } from 'pdf-lib';
import { loadPyMuPDF } from '../../utils/pymupdf-loader.js';
import { $, alertBox, backToTools, baseName, busy, canvasBlob, download, onReady, openPdf, thumb } from './more-common.js';

const BUDGET = 12 * 1024 * 1024; // everything inlined into one page
const SIZES: Record<string, [number, number]> = { letter: [612, 792], a4: [595.28, 841.89], legal: [612, 1008] };

let htmlFile: File | null = null;
let result: { bytes: Uint8Array; name: string } | null = null;

// ------------------------------------------------------------------ fetching

async function proxied(url: string, accept?: string): Promise<{ res: Response; finalUrl: string }> {
  const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`, {
    credentials: 'same-origin',
    headers: accept ? { accept } : {},
  });
  if (res.status === 401 || res.redirected) throw new Error('Your Paperhaus sign-in has ended. Reload the page and sign in.');
  if (!res.ok) throw new Error((await res.text()).slice(0, 200) || `The site answered ${res.status}.`);
  return { res, finalUrl: res.headers.get('x-paperhaus-final-url') || url };
}

function toDataUrl(buf: ArrayBuffer, type: string): string {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return `data:${type || 'application/octet-stream'};base64,${btoa(s)}`;
}

class Inliner {
  used = 0;
  cache = new Map<string, Promise<string | null>>();
  constructor(private local: boolean) {}

  /** A resource as a data: URL, or null if it can't be had (or the budget ran out). */
  get(url: string): Promise<string | null> {
    if (this.local || !/^https?:/i.test(url)) return Promise.resolve(null);
    if (!this.cache.has(url)) {
      this.cache.set(
        url,
        (async () => {
          if (this.used > BUDGET) return null;
          try {
            const { res } = await proxied(url, 'image/avif,image/webp,image/*,text/css,*/*;q=0.8');
            const type = (res.headers.get('content-type') || '').split(';')[0];
            const buf = await res.arrayBuffer();
            this.used += buf.byteLength;
            if (this.used > BUDGET) return null;
            return toDataUrl(buf, type);
          } catch {
            return null;
          }
        })()
      );
    }
    return this.cache.get(url)!;
  }

  async css(url: string): Promise<string> {
    if (this.local) return '';
    try {
      const { res, finalUrl } = await proxied(url, 'text/css,*/*;q=0.1');
      const text = await res.text();
      this.used += text.length;
      return this.cssUrls(text, finalUrl);
    } catch {
      return '';
    }
  }

  /** Point every url(...) and @import in a stylesheet at inlined copies. */
  async cssUrls(css: string, base: string): Promise<string> {
    // @import: pull the imported sheet in place (one level deep is enough for most sites).
    const imports = [...css.matchAll(/@import\s+(?:url\()?['"]?([^'")\s;]+)['"]?\)?[^;]*;/g)];
    for (const m of imports) {
      const abs = resolve(m[1], base);
      css = css.replace(m[0], abs ? await this.css(abs) : '');
    }
    const urls = [...new Set([...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]))];
    for (const u of urls) {
      if (u.startsWith('data:') || u.startsWith('#')) continue;
      const abs = resolve(u, base);
      const data = abs ? await this.get(abs) : null;
      css = css.split(u).join(data || 'about:blank');
    }
    return css;
  }
}

function resolve(u: string, base: string): string | null {
  try {
    return new URL(u.trim(), base).toString();
  } catch {
    return null;
  }
}

/** Load the page, take out scripts, and inline its stylesheets and pictures. */
async function preparePage(mode: 'text' | 'picture'): Promise<{ html: string; title: string; base: string }> {
  const urlInput = $<HTMLInputElement>('mt-url').value.trim();
  let raw: string;
  let base: string;
  let local = false;
  if (htmlFile && !urlInput) {
    raw = await htmlFile.text();
    base = location.href;
    local = true;
  } else {
    if (!urlInput) throw new Error('Paste a web address or choose an HTML file.');
    const withScheme = /^[a-z]+:\/\//i.test(urlInput) ? urlInput : `https://${urlInput}`;
    busy('Getting the page...');
    const { res, finalUrl } = await proxied(withScheme);
    const type = res.headers.get('content-type') || '';
    if (!/html|xml|text\/plain/i.test(type)) throw new Error('That address is not a web page. For a PDF or a picture, download it and use the matching Paperhaus tool.');
    raw = await res.text();
    base = finalUrl;
  }
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const inl = new Inliner(local);
  const title = doc.title.trim() || (htmlFile && !urlInput ? baseName(htmlFile.name) : new URL(base).hostname);

  // Nothing here runs scripts, so take them out, and show what pages put in <noscript>.
  doc.querySelectorAll('script, iframe, frame, object, embed, template, link[rel="preload"], link[rel="modulepreload"], meta[http-equiv]').forEach((el) => el.remove());
  doc.querySelectorAll('noscript').forEach((n) => n.replaceWith(...Array.from(new DOMParser().parseFromString(n.textContent || '', 'text/html').body.childNodes)));
  doc.querySelectorAll('[onload],[onclick],[onerror]').forEach((el) => {
    el.removeAttribute('onload');
    el.removeAttribute('onclick');
    el.removeAttribute('onerror');
  });
  // Cookie banners and sticky bars cover the content in a static copy.
  doc.querySelectorAll('[id*="cookie" i],[class*="cookie-banner" i],[class*="consent" i],[id*="consent" i]').forEach((el) => el.remove());

  if (mode === 'text') readerView(doc, title, base);
  busy(mode === 'text' ? 'Getting pictures...' : 'Getting styles and pictures...');
  const sheets = mode === 'text' ? [] : Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]'));
  for (const link of sheets) {
    const href = resolve(link.getAttribute('href') || '', base);
    const media = link.getAttribute('media') || '';
    const style = doc.createElement('style');
    if (media && !/all|screen|print/.test(media)) {
      link.remove();
      continue;
    }
    style.textContent = href ? await inl.css(href) : '';
    link.replaceWith(style);
  }
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    if (mode === 'text') style.remove();
    else if (!local) style.textContent = await inl.cssUrls(style.textContent || '', base);
  }
  doc.querySelectorAll('link').forEach((l) => l.remove());

  const all = Array.from(doc.querySelectorAll<HTMLImageElement>('img'));
  // Tiny icons and tracking pixels add nothing; past 80 pictures, drop the rest.
  all.slice(80).forEach((im) => im.remove());
  const imgs = all.slice(0, 80);
  doc.querySelectorAll('picture source').forEach((s) => s.remove());
  let done = 0;
  await Promise.all(
    imgs.map(async (img) => {
      const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
      let src = lazy || img.getAttribute('src') || '';
      const set = img.getAttribute('data-srcset') || img.getAttribute('srcset');
      if (set) {
        // The largest candidate up to about 1600 px wide.
        const cands = set
          .split(',')
          .map((c) => c.trim().split(/\s+/))
          .map(([u, d]) => ({ u, w: d?.endsWith('w') ? parseInt(d) : d?.endsWith('x') ? parseFloat(d) * 800 : 800 }))
          .filter((c) => c.u)
          .sort((a, b) => a.w - b.w);
        const pick = cands.filter((c) => c.w <= 1600).pop() || cands[0];
        if (pick) src = pick.u;
      }
      img.removeAttribute('srcset');
      img.removeAttribute('loading');
      img.removeAttribute('sizes');
      const abs = resolve(src, base);
      if (abs && abs.startsWith('data:')) img.setAttribute('src', abs);
      else if (abs && !local) {
        const data = await inl.get(abs);
        if (data) img.setAttribute('src', data);
        else img.remove();
      }
      // MuPDF reads PNG and JPEG; anything else (SVG, WebP, AVIF) is turned into a PNG here.
      const cur = img.getAttribute('src') || '';
      if (mode === 'text' && cur.startsWith('data:') && !/^data:image\/(png|jpe?g)/i.test(cur)) {
        const png = await toPng(cur);
        if (png) img.setAttribute('src', png);
        else img.remove();
      }
      busy(`Getting pictures... ${++done} of ${imgs.length}`);
    })
  );
  // Whatever couldn't be inlined would only be blocked by the page's security rules.
  doc.querySelectorAll('img').forEach((im) => {
    if (!/^data:/.test(im.getAttribute('src') || '')) im.remove();
  });
  // Links keep working in the PDF.
  doc.querySelectorAll('a[href]').forEach((a) => {
    const abs = resolve(a.getAttribute('href') || '', base);
    if (abs) a.setAttribute('href', abs);
  });
  // Inline style="background:url(...)"
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('[style*="url("]'))) {
    if (mode === 'text') el.removeAttribute('style');
    else if (!local) el.setAttribute('style', await inl.cssUrls(el.getAttribute('style') || '', base));
  }
  doc.querySelector('base')?.remove();
  const meta = doc.createElement('meta');
  meta.setAttribute('charset', 'utf-8');
  doc.head.prepend(meta);
  return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, title, base };
}


/** Keep the readable part of a page for the text layout: the article, without menus or footers. */
function readerView(doc: Document, title: string, base: string): void {
  const pick =
    doc.querySelector('article') ||
    doc.querySelector('main') ||
    doc.querySelector('[role="main"]') ||
    doc.querySelector('#content, .content, #main, .post, .entry-content') ||
    doc.body;
  const keep = pick.cloneNode(true) as HTMLElement;
  keep
    .querySelectorAll('nav, footer, aside, form, button, input, select, textarea, svg, canvas, video, audio, [hidden], [aria-hidden="true"], [role="navigation"], [role="banner"], [role="contentinfo"], [style*="display:none"], [style*="display: none"]')
    .forEach((el) => el.remove());
  keep.querySelectorAll<HTMLElement>('[style]').forEach((el) => el.removeAttribute('style'));
  keep.querySelectorAll<HTMLElement>('[class]').forEach((el) => el.removeAttribute('class'));
  doc.body.textContent = '';
  const h = doc.createElement('h1');
  h.textContent = title;
  const src = doc.createElement('p');
  src.className = 'ph-src';
  src.textContent = /^https?:/.test(base) && !base.startsWith(location.origin) ? base : '';
  if (!keep.querySelector('h1') || keep.querySelector('h1')?.textContent?.trim() !== title) doc.body.append(h);
  if (src.textContent) doc.body.append(src);
  doc.body.append(...Array.from(keep.childNodes));
}

function toPng(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const w = Math.min(im.naturalWidth || 300, 1600);
      const h = Math.round(((im.naturalHeight || 150) * w) / (im.naturalWidth || 300));
      if (w < 2 || h < 2) return resolve(null);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d')!.drawImage(im, 0, 0, w, h);
      try {
        resolve(c.toDataURL('image/png'));
      } catch {
        resolve(null);
      }
    };
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

/** True when rows y0..y1 are all one plain color. */
function blank(ctx: CanvasRenderingContext2D, width: number, y0: number, y1: number): boolean {
  const h = Math.max(1, Math.floor(y1 - y0));
  const data = ctx.getImageData(0, Math.floor(y0), width, h).data;
  const r = data[0];
  const g = data[1];
  const b = data[2];
  for (let i = 0; i < data.length; i += 4 * 7) {
    if (Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b) > 24) return false;
  }
  return true;
}

// ------------------------------------------------------------------ making the PDF

function pageBox(): { w: number; h: number; m: number; size: string; landscape: boolean } {
  const size = $<HTMLSelectElement>('mt-size').value;
  const landscape = $<HTMLSelectElement>('mt-orient').value === 'landscape';
  const m = Number($<HTMLSelectElement>('mt-margin').value);
  const [a, b] = SIZES[size];
  return landscape ? { w: b, h: a, m, size, landscape } : { w: a, h: b, m, size, landscape };
}

async function asText(html: string): Promise<Uint8Array> {
  busy('Loading the layout engine...');
  const box = pageBox();
  const mupdf = (await loadPyMuPDF()) as unknown as {
    htmlToPdf: (html: string, o: unknown) => Promise<Blob>;
  };
  busy('Laying out the pages...');
  // MuPDF's paper names take "-l" for landscape.
  const css = `body{font-family:serif;font-size:11pt;line-height:1.45;color:#111} h1{font-size:20pt;margin:0 0 6pt} h2{font-size:15pt} h3{font-size:12.5pt}
img{max-width:100%;height:auto} pre,code{font-family:monospace;font-size:9pt;white-space:pre-wrap} table{max-width:100%;border-collapse:collapse}
td,th{border:0.5pt solid #999;padding:3pt} blockquote{margin-left:12pt;color:#444} a{color:#1a4fb5} .ph-src{font-size:8.5pt;color:#666;margin-bottom:12pt}`;
  const blob = await mupdf.htmlToPdf(html, { pageSize: box.landscape ? `${box.size}-l` : box.size, margins: box.m, css });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Find a row near `y` that is one plain color, so a page break doesn't cut a line of text. */
function quietRow(ctx: CanvasRenderingContext2D, width: number, y: number, look: number): number {
  const from = Math.max(1, Math.floor(y - look));
  const data = ctx.getImageData(0, from, width, Math.floor(y) - from + 1).data;
  for (let row = Math.floor(y) - from; row >= 0; row--) {
    const o = row * width * 4;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    let plain = true;
    for (let x = 0; x < width; x += 3) {
      const i = o + x * 4;
      if (Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b) > 24) {
        plain = false;
        break;
      }
    }
    if (plain) return from + row;
  }
  return Math.floor(y);
}

async function asPicture(html: string): Promise<Uint8Array> {
  const box = pageBox();
  const cssW = Math.round(((box.w - box.m * 2) / 72) * 96); // content width in CSS pixels
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${Math.max(cssW, 320)}px;height:1200px;border:0;background:#fff`;
  document.body.appendChild(frame);
  try {
    busy('Drawing the page...');
    await new Promise<void>((res) => {
      frame.onload = () => res();
      frame.srcdoc = html;
    });
    const d = frame.contentDocument!;
    await d.fonts?.ready.catch((): undefined => undefined);
    await Promise.all(
      Array.from(d.images).map((im) => (im.complete ? Promise.resolve() : new Promise((r) => ((im.onload = r), (im.onerror = r)))))
    );
    // Sticky and fixed bars would repeat or float over the content.
    d.querySelectorAll<HTMLElement>('*').forEach((el) => {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') el.style.position = 'static';
    });
    const fullH = Math.min(Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight || 0), 60000);
    frame.style.height = `${fullH}px`;
    // Browsers can't hold a canvas more than about 32,000 px tall, so a long page is
    // drawn a few pages at a time, each window starting where the last page break fell.
    const scale = fullH > 20000 ? 1.5 : 2;
    const out = await PDFDocument.create();
    const pageCssH = ((box.h - box.m * 2) / 72) * 96;
    const pagePx = pageCssH * scale;
    const chunkCss = Math.max(pageCssH * 5, 2000);
    let y0 = 0;
    let chunkNo = 0;
    while (y0 < fullH - 2) {
      const hCss = Math.min(chunkCss, fullH - y0);
      const last = y0 + hCss >= fullH - 1;
      busy(`Drawing the page... ${Math.min(99, Math.round((y0 / fullH) * 100))}%`, y0 / fullH);
      const canvas = await html2canvas(d.documentElement, {
        backgroundColor: '#ffffff',
        scale,
        x: 0,
        y: y0,
        width: cssW,
        height: Math.ceil(hCss),
        windowWidth: cssW,
        windowHeight: fullH,
        scrollX: 0,
        scrollY: 0,
        useCORS: false,
        logging: false,
      });
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      let y = 0;
      while (y < canvas.height - 2) {
        let end = y + pagePx;
        if (end >= canvas.height) {
          if (!last) break; // the rest goes into the next window
          end = canvas.height;
        } else end = Math.max(y + pagePx * 0.7, quietRow(ctx, canvas.width, end, pagePx * 0.25));
        // A last stretch with nothing on it (trailing space) makes no page.
        if (last && (y > 0 || chunkNo > 0) && blank(ctx, canvas.width, y, canvas.height)) break;
        const slice = document.createElement('canvas');
        slice.width = canvas.width;
        slice.height = Math.ceil(end - y);
        const sctx = slice.getContext('2d')!;
        sctx.fillStyle = '#fff';
        sctx.fillRect(0, 0, slice.width, slice.height);
        sctx.drawImage(canvas, 0, y, canvas.width, slice.height, 0, 0, slice.width, slice.height);
        const jpg = await out.embedJpg(new Uint8Array(await (await canvasBlob(slice, 'image/jpeg', 0.9)).arrayBuffer()));
        const page = out.addPage([box.w, box.h]);
        const drawW = box.w - box.m * 2;
        const drawH = (slice.height / slice.width) * drawW;
        page.drawImage(jpg, { x: box.m, y: box.h - box.m - drawH, width: drawW, height: drawH });
        y = end;
      }
      if (last) break;
      y0 += Math.max(y / scale, pageCssH * 0.5);
      chunkNo++;
    }
    return await out.save();
  } finally {
    frame.remove();
  }
}

async function make(): Promise<void> {
  result = null;
  $('mt-preview-card').classList.add('hidden');
  try {
    const mode = document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value === 'picture' ? 'picture' : 'text';
    const { html, title } = await preparePage(mode);
    let bytes: Uint8Array;
    try {
      bytes = mode === 'picture' ? await asPicture(html) : await asText(html);
    } catch (err) {
      if (mode !== 'picture') {
        console.warn('Text layout failed, using the picture mode', err);
        bytes = await asPicture((await preparePage('picture')).html);
      } else throw err;
    }
    const name = `${title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'page'}.pdf`;
    result = { bytes, name };
    busy('Making the preview...');
    const pdf = await openPdf(bytes);
    const host = $('mt-preview');
    host.textContent = '';
    for (let i = 1; i <= Math.min(pdf.numPages, 6); i++) {
      const b = document.createElement('div');
      b.className = 'mt-thumb';
      b.appendChild(await thumb(pdf, i, 200));
      const n = document.createElement('span');
      n.textContent = String(i);
      b.appendChild(n);
      host.appendChild(b);
    }
    $('mt-hint').textContent = `${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}`;
    pdf.destroy();
    $('mt-preview-card').classList.remove('hidden');
    $('mt-preview-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    alertBox('Could not make the PDF', String((err as Error).message || err));
  } finally {
    busy(null);
  }
}

onReady(() => {
  backToTools();
  const input = $<HTMLInputElement>('mt-file');
  const choose = (f: File) => {
    if (!/\.(html?|xhtml)$/i.test(f.name) && !/html/.test(f.type)) return alertBox('Not an HTML file', 'Choose a .html or .htm file.');
    htmlFile = f;
    $('mt-file-label').textContent = f.name;
    $<HTMLInputElement>('mt-url').value = '';
  };
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    input.value = '';
    if (f) choose(f);
  });
  const drop = $('mt-drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    const f = e.dataTransfer?.files?.[0];
    if (f) choose(f);
  });
  $('mt-url').addEventListener('input', () => {
    if ($<HTMLInputElement>('mt-url').value) {
      htmlFile = null;
      $('mt-file-label').textContent = 'Choose an HTML file or drop it here';
    }
  });
  $('mt-url').addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && void make());
  $('mt-go').addEventListener('click', () => void make());
  $('mt-save').addEventListener('click', () => result && download(result.bytes, result.name));
  // Shared from another app or a bookmark: /html-to-pdf?url=...
  const shared = new URLSearchParams(location.search).get('url');
  if (shared) $<HTMLInputElement>('mt-url').value = shared;
});
