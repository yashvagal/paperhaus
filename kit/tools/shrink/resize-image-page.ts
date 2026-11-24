/** Paperhaus: Resize Images. Longest side, percent, exact size, or a preset for social posts (cropped to fill). */
import { $, backToTools, onReady, fileList, isImage, loadPic, draw, encode, hasAlpha, sameFormat, typeOf, showResult, showError, finish, busy, baseName, tick, EXT, type Pic, type Fmt } from './shrink-common.js';

// Sizes people ask for most (in pixels), cropped from the middle to fill.
const SOCIAL: Record<string, [number, number]> = {
  'ig-post': [1080, 1080],
  'ig-portrait': [1080, 1350],
  story: [1080, 1920],
  'li-banner': [1584, 396],
  'yt-thumb': [1280, 720],
  'x-header': [1500, 500],
  passport: [600, 600],
};

const val = (name: string): string => (document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`) || { value: '' }).value;
const num = (id: string): number => parseInt($<HTMLInputElement>(id).value, 10) || 0;

/** Draw a picture cropped from the centre to exactly w x h. */
function cover(pic: Pic, w: number, h: number, fmt: Fmt): HTMLCanvasElement {
  const k = Math.max(w / pic.w, h / pic.h);
  const full = draw(pic, Math.round(pic.w * k), Math.round(pic.h * k), fmt);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(full, Math.round((full.width - w) / 2), Math.round((full.height - h) / 2), w, h, 0, 0, w, h);
  return c;
}

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
  const showMode = () => {
    const m = val('mode');
    for (const k of ['side', 'pct', 'exact', 'social']) $(`sh-mode-${k}`)?.classList.toggle('sh-hidden', m !== k);
    $('sh-noup-row').classList.toggle('sh-hidden', m === 'social');
  };
  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', showMode));
  document.querySelectorAll('input[name="side"]').forEach((r) => r.addEventListener('change', () => $('sh-side-custom').classList.toggle('sh-hidden', val('side') !== 'custom')));
  $<HTMLInputElement>('sh-pct').addEventListener('input', () => ($('sh-pct-out').textContent = `${$<HTMLInputElement>('sh-pct').value}%`));
  showMode();

  go.onclick = async () => {
    const mode = val('mode');
    const noUp = $<HTMLInputElement>('sh-noup').checked;
    go.disabled = true;
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      busy(`Resizing ${n + 1} of ${items.length}...`, n / items.length);
      await tick();
      try {
        const pic = await loadPic(it.file);
        try {
          const type = typeOf(it.file);
          const alpha = /png|webp|gif|avif|svg/.test(type) && hasAlpha(draw(pic, Math.min(pic.w, 300), Math.max(1, Math.round(pic.h * (Math.min(pic.w, 300) / pic.w))), 'image/png'));
          const fmt = sameFormat(type, alpha);
          let canvas: HTMLCanvasElement;
          if (mode === 'social') {
            const [w, h] = SOCIAL[val('social')] || SOCIAL['ig-post'];
            canvas = cover(pic, w, h, fmt);
          } else {
            let w = pic.w;
            let h = pic.h;
            if (mode === 'side') {
              const side = val('side') === 'custom' ? num('sh-side') : parseInt(val('side'), 10);
              const k = side / Math.max(pic.w, pic.h);
              w = pic.w * k;
              h = pic.h * k;
            } else if (mode === 'pct') {
              const k = num('sh-pct') / 100;
              w = pic.w * k;
              h = pic.h * k;
            } else {
              const W = num('sh-w');
              const H = num('sh-h');
              const keep = $<HTMLInputElement>('sh-keep').checked;
              if (W && H && !keep) {
                w = W;
                h = H;
              } else if (W || H) {
                const k = W && H ? Math.min(W / pic.w, H / pic.h) : W ? W / pic.w : H / pic.h;
                w = pic.w * k;
                h = pic.h * k;
              }
            }
            if (noUp && (w > pic.w || h > pic.h)) {
              w = pic.w;
              h = pic.h;
            }
            canvas = draw(pic, Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), fmt);
          }
          let blob = await encode(canvas, fmt, fmt === 'image/png' ? 1 : 0.9);
          // Same size and type as before but a bigger file: keep the original.
          if (canvas.width === pic.w && canvas.height === pic.h && fmt === typeOf(it.file) && blob.size >= it.file.size) blob = it.file;
          showResult(it, { blob, name: `${baseName(it.file.name)} ${canvas.width}x${canvas.height}.${EXT[fmt]}` }, `${pic.w}×${pic.h} → ${canvas.width}×${canvas.height}`);
        } finally {
          pic.close();
        }
      } catch (err) {
        showError(it, (err as Error).message || 'Could not read this picture');
      }
    }
    busy(null);
    go.disabled = false;
    finish(items, 'Resized pictures.zip');
  };
});
