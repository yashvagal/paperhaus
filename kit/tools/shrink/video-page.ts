/**
 * Paperhaus: Compress Video. Re-encodes a video to H.264 MP4 at a lower size, or to fit
 * under a size (email, WhatsApp, Discord), with the browser's own video encoder (WebCodecs,
 * through Mediabunny). Nothing is uploaded, and the phone or computer's video chip does the
 * work, so it is fast. Works in Chrome, Edge and Safari; not every browser can do it.
 */
import { Input, Output, Conversion, BlobSource, BufferTarget, Mp4OutputFormat, ALL_FORMATS, Quality, canEncodeVideo, canEncodeAudio } from 'mediabunny';
import { $, backToTools, onReady, fileList, showResult, showError, finish, busy, toast, baseName, size, type Item } from './shrink-common.js';

const isVideo = (f: File): boolean => /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(f.name);
const val = (name: string): string => (document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`) || { value: '' }).value;

let current: Conversion | null = null;

async function compress(it: Item, onProgress: (p: number) => void): Promise<{ blob: Blob; note: string }> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(it.file) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('No video found in this file');
  const duration = await input.computeDuration();
  const w0 = track.displayWidth;
  const h0 = track.displayHeight;
  const mute = $<HTMLInputElement>('sh-mute').checked;
  const level = val('level');
  const audioBits = mute ? 0 : 96000;
  let bitrate: number;
  let shortSide: number;
  if (level === 'target') {
    const mb = parseFloat($<HTMLInputElement>('sh-mb').value) || 25;
    // Leave room for the container and keep a little under the limit.
    bitrate = Math.max(150000, (mb * 1048576 * 8 * 0.92) / Math.max(1, duration) - audioBits);
    shortSide = bitrate >= 4e6 ? 1080 : bitrate >= 1.8e6 ? 720 : bitrate >= 800000 ? 540 : bitrate >= 400000 ? 360 : 240;
  } else if (level === 'small') {
    bitrate = 1.2e6;
    shortSide = 720;
  } else {
    bitrate = 2.5e6;
    shortSide = 1080;
  }
  const k = Math.min(1, shortSide / Math.min(w0, h0));
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const width = even(w0 * k);
  const height = even(h0 * k);
  const quality = new Quality({ bitrate: Math.round(bitrate) });
  if (!(await canEncodeVideo('avc', { width, height, quality }))) {
    throw new Error('This browser cannot make videos. Try Chrome, Edge or Safari on a computer or phone.');
  }
  const aac = !mute && (await canEncodeAudio('aac', { quality: new Quality({ bitrate: audioBits }) }).catch((): boolean => false));
  // 60 fps phone videos become 30 fps: half the frames, about the same look.
  const stats = await track.computePacketStats(120).catch((): null => null);
  const fps = stats ? stats.averagePacketRate : 0;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const conversion = await Conversion.init({
    input,
    output,
    video: { width, height, fit: 'contain', codec: 'avc', quality, forceTranscode: true, frameRate: fps > 31 ? 30 : undefined },
    audio: mute ? { discard: true } : aac ? { codec: 'aac', quality: new Quality({ bitrate: audioBits }) } : {},
    showWarnings: false,
  });
  if (!conversion.isValid) throw new Error('This video could not be converted in this browser.');
  const lostSound = !mute && conversion.discardedTracks.some((t: { track: { type: string } }) => t.track.type === 'audio');
  conversion.onProgress = (p: number): void => onProgress(p);
  current = conversion;
  await conversion.execute();
  current = null;
  const buf = (output.target as BufferTarget).buffer;
  if (!buf) throw new Error('Nothing came out. Try again.');
  const notes = [`${width}×${height}`, `${Math.round(duration)}s`];
  if (lostSound) notes.push('sound could not be kept in this browser');
  return { blob: new Blob([buf], { type: 'video/mp4' }), note: notes.join(' · ') };
}

onReady(() => {
  backToTools();
  const go = $<HTMLButtonElement>('sh-go');
  const { items } = fileList({
    accept: isVideo,
    wrong: 'Choose a video: MP4, MOV (iPhone), WebM or MKV.',
    onChange: () => {
      go.disabled = !items.length;
      $('sh-hint').textContent = items.length ? `${items.length} ${items.length === 1 ? 'video' : 'videos'}, ${size(items.reduce((n, i) => n + i.file.size, 0))}` : '';
    },
  });
  const sync = () => $('sh-target-box').classList.toggle('sh-hidden', val('level') !== 'target');
  document.querySelectorAll('input[name="level"]').forEach((r) => r.addEventListener('change', sync));
  document.querySelectorAll<HTMLButtonElement>('[data-mb]').forEach((b) =>
    b.addEventListener('click', () => {
      $<HTMLInputElement>('sh-mb').value = b.dataset.mb!;
    })
  );
  sync();
  if (typeof (window as unknown as { VideoEncoder?: unknown }).VideoEncoder === 'undefined') {
    $('sh-hint').textContent = 'This browser cannot make videos. Use Chrome, Edge or Safari.';
  }

  // A Stop button on the progress card.
  const card = document.querySelector('#mt-busy .es-busy-card');
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'es-btn es-small';
  stop.textContent = 'Stop';
  stop.onclick = () => void current?.cancel();
  card?.appendChild(stop);

  go.onclick = async () => {
    go.disabled = true;
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      const label = items.length > 1 ? `Video ${n + 1} of ${items.length}` : 'Compressing';
      busy(`${label}... 0%`, 0);
      try {
        const out = await compress(it, (p) => busy(`${label}... ${Math.round(p * 100)}%`, p));
        if (out.blob.size >= it.file.size) showResult(it, { blob: it.file, name: it.file.name }, 'already as small as it gets');
        else showResult(it, { blob: out.blob, name: `${baseName(it.file.name)} (smaller).mp4` }, out.note);
      } catch (err) {
        const e = err as Error;
        if (/cancel/i.test(e.name + e.message)) {
          showError(it, 'stopped');
          break;
        }
        showError(it, e.message || 'Could not compress this video');
      }
    }
    current = null;
    busy(null);
    go.disabled = false;
    finish(items, 'Smaller videos.zip');
    if (items.some((i) => i.out && i.out.blob.size > 25 * 1048576) && val('level') !== 'target') toast('Still over 25 MB? Choose "Fit under a size" and pick Email.');
  };
});
