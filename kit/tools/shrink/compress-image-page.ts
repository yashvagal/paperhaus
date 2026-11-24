/** Paperhaus: Compress Images. Quality level or a target size; same type, JPG or WebP. */
import { $, backToTools, onReady, fileList, isImage, loadPic, draw, encode, hasAlpha, fit, toTarget, sameFormat, typeOf, showResult, showError, finish, targetBytes, busy, toast, baseName, tick, EXT, type Fmt } from './shrink-common.js';

const LEVELS: Record<string, { q: number; side: number }> = {
  small: { q: 0.62, side: 1920 },
  balanced: { q: 0.78, side: 3000 },
  best: { q: 0.88, side: 0 },
};

onReady(() => {
  backToTools();
  const go = $<HTMLButtonElement>('sh-go');
  const { items } = fileList({
    accept: isImage,
    wrong: 'Choose pictures: JPG, PNG, WebP, HEIC, GIF or AVIF.',
    onChange: () => {
      go.disabled = !items.length;
      $('sh-hint').textContent = items.length ? `${items.length} ${items.length === 1 ? 'picture' : 'pictures'}` : '';
    },
  });

  go.onclick = async () => {
    const level = LEVELS[(document.querySelector<HTMLInputElement>('input[name="level"]:checked') || { value: 'balanced' }).value];
    const target = targetBytes('sh-target', 'sh-target-unit');
    const wanted = $<HTMLSelectElement>('sh-format').value;
    go.disabled = true;
    let missed = 0;
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      busy(`Compressing ${n + 1} of ${items.length}...`, n / items.length);
      await tick();
      try {
        const pic = await loadPic(it.file);
        try {
          const type = typeOf(it.file);
          const probe = draw(pic, Math.min(pic.w, 400), Math.min(pic.h, 400) * (Math.min(pic.w, 400) / pic.w), 'image/png');
          const alpha = /png|webp|gif|avif|svg/.test(type) && hasAlpha(probe);
          let fmt: Fmt = wanted === 'same' ? sameFormat(type, alpha) : (wanted as Fmt);
          if (fmt === 'image/jpeg' && alpha && wanted === 'same') fmt = 'image/png';
          let blob: Blob;
          let note = '';
          if (target) {
            const r = await toTarget(pic, fmt, target, level.side);
            blob = r.blob;
            if (!r.fits) {
              missed++;
              note = 'could not get under the size';
            }
            if (r.w !== pic.w) note = [note, `${r.w}×${r.h}`].filter(Boolean).join(' · ');
          } else {
            const [w, h] = fit(pic.w, pic.h, level.side);
            blob = await encode(draw(pic, w, h, fmt), fmt, level.q);
            if (w !== pic.w) note = `${w}×${h}`;
          }
          const sameType = fmt === sameFormat(type, alpha) && !/heic|heif|svg/.test(type);
          // Never hand back a bigger file in the same type: keep the original then.
          if (!target && sameType && blob.size >= it.file.size) {
            showResult(it, { blob: it.file, name: it.file.name }, 'already as small as it gets');
          } else {
            showResult(it, { blob, name: `${baseName(it.file.name)}.${EXT[fmt]}` }, note);
          }
        } finally {
          pic.close();
        }
      } catch (err) {
        showError(it, (err as Error).message || 'Could not read this picture');
      }
    }
    busy(null);
    go.disabled = false;
    finish(items, 'Compressed pictures.zip');
    if (missed) toast(`${missed} could not get under that size, even made smaller. They are as small as they go.`);
  };
});
