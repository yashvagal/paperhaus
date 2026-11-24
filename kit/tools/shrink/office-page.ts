/**
 * Paperhaus: Compress Word, PowerPoint or Excel. DOCX, PPTX, XLSX (and the OpenDocument
 * ODT, ODP, ODS) are ZIP files; the pictures inside are what make them big. Each JPG and PNG
 * inside is scaled down to the chosen size and saved again in the same type and under the
 * same name, so every reference inside the file still works. Only smaller results are used.
 * Text, slides, formulas, charts and layout are not touched.
 */
import JSZip from 'jszip';
import { $, backToTools, onReady, fileList, loadPic, draw, encode, fit, hasAlpha, showResult, showError, finish, busy, toast, tick } from './shrink-common.js';

const LEVELS: Record<string, { side: number; q: number }> = {
  small: { side: 1280, q: 0.6 },
  balanced: { side: 1920, q: 0.75 },
  best: { side: 2800, q: 0.85 },
};
const OFFICE = /\.(docx|pptx|xlsx|docm|pptm|xlsm|odt|odp|ods)$/i;
const PICTURE = /\.(jpe?g|png)$/i;
const VIDEO = /\.(mp4|m4v|mov|wmv|avi|mpe?g|webm|mp3|m4a|wav|wma)$/i;

onReady(() => {
  backToTools();
  const go = $<HTMLButtonElement>('sh-go');
  const { items } = fileList({
    accept: (f) => OFFICE.test(f.name),
    wrong: 'Choose a Word (.docx), PowerPoint (.pptx) or Excel (.xlsx) file. Older .doc, .ppt and .xls files need saving as the new type first.',
    onChange: () => {
      go.disabled = !items.length;
      $('sh-hint').textContent = items.length ? `${items.length} ${items.length === 1 ? 'file' : 'files'}` : '';
    },
  });

  go.onclick = async () => {
    const level = LEVELS[(document.querySelector<HTMLInputElement>('input[name="level"]:checked') || { value: 'balanced' }).value];
    go.disabled = true;
    const notes: string[] = [];
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      try {
        busy(`Opening ${it.file.name}...`, n / items.length);
        const zip = await JSZip.loadAsync(await it.file.arrayBuffer());
        const pics = Object.values(zip.files).filter((f) => !f.dir && PICTURE.test(f.name));
        const media = Object.values(zip.files).filter((f) => !f.dir && VIDEO.test(f.name));
        let changed = 0;
        for (let i = 0; i < pics.length; i++) {
          const f = pics[i];
          busy(`${it.file.name}: picture ${i + 1} of ${pics.length}`, (n + i / pics.length) / items.length);
          await tick();
          const data = await f.async('uint8array');
          if (data.length < 40 * 1024) continue; // tiny ones are not worth it
          const isPng = /\.png$/i.test(f.name);
          try {
            const pic = await loadPic(new Blob([data as BlobPart], { type: isPng ? 'image/png' : 'image/jpeg' }));
            try {
              const [w, h] = fit(pic.w, pic.h, level.side);
              const c = draw(pic, w, h, isPng ? 'image/png' : 'image/jpeg');
              // PNG photos without see-through parts shrink most with fewer colours.
              const out = isPng ? await encode(c, 'image/png', hasAlpha(c) ? 0.95 : level.q + 0.15) : await encode(c, 'image/jpeg', level.q);
              if (out.size < data.length * 0.92) {
                zip.file(f.name, new Uint8Array(await out.arrayBuffer()));
                changed++;
              }
            } finally {
              pic.close();
            }
          } catch {
            /* a picture the browser can't read stays as it is */
          }
        }
        busy(`Saving ${it.file.name}...`, (n + 1) / items.length);
        await tick();
        const odf = /\.od[tps]$/i.test(it.file.name);
        let blob: Blob;
        // OpenDocument needs its "mimetype" entry first and uncompressed.
        if (odf && zip.file('mimetype')) {
          const mt = await zip.file('mimetype')!.async('string');
          zip.remove('mimetype');
          const fresh = new JSZip();
          fresh.file('mimetype', mt, { compression: 'STORE' });
          for (const f of Object.values(zip.files)) if (!f.dir) fresh.file(f.name, await f.async('uint8array'));
          blob = await fresh.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 }, mimeType: it.file.type });
        } else {
          blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 }, mimeType: it.file.type || undefined });
        }
        const mediaBytes = (await Promise.all(media.map((m) => m.async('uint8array').then((d) => d.length)))).reduce((a, b) => a + b, 0);
        let note = changed ? `${changed} of ${pics.length} pictures made smaller` : pics.length ? 'pictures were already small' : 'no pictures inside';
        if (media.length) {
          note += ` · ${media.length} video or sound ${media.length === 1 ? 'file' : 'files'} (${Math.round(mediaBytes / 1048576)} MB) left as is`;
          notes.push(it.file.name);
        }
        if (blob.size >= it.file.size) showResult(it, { blob: it.file, name: it.file.name }, `${note} · already as small as it gets`);
        else showResult(it, { blob, name: it.file.name.replace(OFFICE, (m) => ` (smaller)${m}`) }, note);
      } catch (err) {
        showError(it, /zip|central|end of/i.test(String((err as Error).message)) ? 'This file could not be opened. Is it password protected?' : (err as Error).message || 'Could not read this file');
      }
    }
    busy(null);
    go.disabled = false;
    finish(items, 'Smaller files.zip');
    if (notes.length) toast('Videos inside a file are left as they are. Compress them first with Compress Video, then put them back in.');
  };
});
