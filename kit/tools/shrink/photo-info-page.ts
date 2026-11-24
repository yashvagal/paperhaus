/** Paperhaus: Remove Photo Info. Shows what each photo carries, then removes it. */
import { $, backToTools, onReady, fileList, isImage, loadPic, draw, encode, showResult, showError, finish, busy, toast, baseName, tick, type Item } from './shrink-common.js';
import { kind, jpegInfo, jpegStrip, pngInfo, pngStrip, webpInfo, webpStrip, type PhotoInfo } from './photo-meta.js';

const infos = new WeakMap<Item, PhotoInfo>();

function readInfo(d: Uint8Array): PhotoInfo {
  const k = kind(d);
  return k === 'jpg' ? jpegInfo(d) : k === 'png' ? pngInfo(d) : k === 'webp' ? webpInfo(d) : { other: [] };
}

function niceDate(s?: string): string {
  const m = s && s.match(/^(\d{4}):(\d\d):(\d\d)[ T](\d\d):(\d\d)/);
  if (!m) return s || '';
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function showInfo(it: Item, info: PhotoInfo, heic: boolean): void {
  const box = document.createElement('div');
  box.className = 'sh-found';
  const line = (text: string, cls = '') => {
    const s = document.createElement('span');
    s.textContent = text;
    if (cls) s.className = cls;
    box.appendChild(s);
  };
  if (info.gps) line(info.gps === true ? 'Location: yes' : `Location: ${info.gps.lat.toFixed(4)}, ${info.gps.lon.toFixed(4)}`, 'is-gps');
  if (info.camera) line(`Camera: ${info.camera}`);
  if (info.taken) line(`Taken: ${niceDate(info.taken)}`);
  if (info.software) line(`Edited with: ${info.software}`);
  for (const o of info.other.slice(0, 4)) line(o);
  if (!box.childElementCount) line(heic ? 'iPhone photo: location, camera and date are usually inside' : 'No hidden details found');
  it.row.querySelector('.sh-info')!.appendChild(box);
}

onReady(() => {
  backToTools();
  const go = $<HTMLButtonElement>('sh-go');
  const { items } = fileList({
    accept: isImage,
    wrong: 'Choose photos: JPG, PNG, WebP or HEIC.',
    onChange: () => {
      go.disabled = !items.length;
      $('sh-hint').textContent = items.length ? `${items.length} ${items.length === 1 ? 'photo' : 'photos'}` : '';
    },
    onAdd: (it) => {
      void it.file.slice(0, Math.min(it.file.size, 32 * 1024 * 1024)).arrayBuffer().then((buf) => {
        const info = readInfo(new Uint8Array(buf));
        infos.set(it, info);
        showInfo(it, info, /heic|heif/i.test(it.file.type + it.file.name));
      });
    },
  });

  go.onclick = async () => {
    go.disabled = true;
    let located = 0;
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      busy(`Cleaning ${n + 1} of ${items.length}...`, n / items.length);
      await tick();
      try {
        const d = new Uint8Array(await it.file.arrayBuffer());
        const k = kind(d);
        const info = infos.get(it) || readInfo(d);
        if (info.gps) located++;
        let blob: Blob;
        let name = it.file.name;
        if (k === 'jpg') blob = new Blob([jpegStrip(d, info.orientation) as BlobPart], { type: 'image/jpeg' });
        else if (k === 'png') blob = new Blob([pngStrip(d) as BlobPart], { type: 'image/png' });
        else if (k === 'webp') blob = new Blob([webpStrip(d) as BlobPart], { type: 'image/webp' });
        else {
          // HEIC, AVIF and others: a fresh JPG carries nothing but the picture.
          const pic = await loadPic(it.file);
          try {
            blob = await encode(draw(pic, pic.w, pic.h, 'image/jpeg'), 'image/jpeg', 0.92);
          } finally {
            pic.close();
          }
          name = `${baseName(it.file.name)}.jpg`;
        }
        showResult(it, { blob, name }, 'photo info removed');
      } catch (err) {
        showError(it, (err as Error).message || 'Could not read this photo');
      }
    }
    busy(null);
    go.disabled = false;
    finish(items, 'Photos without info.zip');
    if (located) toast(`Removed the location from ${located} ${located === 1 ? 'photo' : 'photos'}.`);
  };
});
