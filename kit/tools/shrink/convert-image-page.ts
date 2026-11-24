/** Paperhaus: Convert Images. Anything the browser can read to JPG, PNG or WebP. */
import { $, backToTools, onReady, fileList, isImage, loadPic, draw, encode, canWebp, showResult, showError, finish, busy, toast, baseName, tick, EXT, type Fmt } from './shrink-common.js';

const to = (): Fmt => ((document.querySelector<HTMLInputElement>('input[name="to"]:checked') || { value: 'image/jpeg' }).value as Fmt);

onReady(() => {
  backToTools();
  const go = $<HTMLButtonElement>('sh-go');
  const { items } = fileList({
    accept: isImage,
    wrong: 'Choose pictures: HEIC, JPG, PNG, WebP, AVIF, GIF, BMP or SVG.',
    onChange: () => {
      go.disabled = !items.length;
      $('sh-hint').textContent = items.length ? `${items.length} ${items.length === 1 ? 'picture' : 'pictures'}` : '';
    },
  });
  // Coming from a link like convert-image.html?to=png
  const want = new URLSearchParams(location.search).get('to');
  const pick = want && document.querySelector<HTMLInputElement>(`input[name="to"][value="image/${want === 'jpg' ? 'jpeg' : want}"]`);
  if (pick) pick.checked = true;
  const q = $<HTMLInputElement>('sh-q');
  const sync = () => {
    $('sh-q-box').classList.toggle('sh-hidden', to() === 'image/png');
    $('sh-jpg-note').classList.toggle('sh-hidden', to() !== 'image/jpeg');
    $('sh-q-out').textContent = q.value;
  };
  document.querySelectorAll('input[name="to"]').forEach((r) => r.addEventListener('change', sync));
  q.addEventListener('input', sync);
  sync();

  go.onclick = async () => {
    let fmt = to();
    if (fmt === 'image/webp' && !canWebp()) {
      toast('This browser cannot save WebP, so they are saved as JPG.');
      fmt = 'image/jpeg';
    }
    const quality = fmt === 'image/png' ? 1 : Number(q.value) / 100;
    go.disabled = true;
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      busy(`Converting ${n + 1} of ${items.length}...`, n / items.length);
      await tick();
      try {
        const pic = await loadPic(it.file);
        try {
          const blob = await encode(draw(pic, pic.w, pic.h, fmt), fmt, quality);
          showResult(it, { blob, name: `${baseName(it.file.name)}.${EXT[fmt]}` }, EXT[fmt].toUpperCase());
        } finally {
          pic.close();
        }
      } catch (err) {
        showError(it, (err as Error).message || 'Could not read this picture');
      }
    }
    busy(null);
    go.disabled = false;
    finish(items, `Pictures as ${EXT[fmt].toUpperCase()}.zip`);
  };
});
