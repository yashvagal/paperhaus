/**
 * Paperhaus: read and remove the hidden details in photos (EXIF, XMP, IPTC, comments),
 * without re-encoding the picture. JPG keeps its exact compressed data, PNG and WebP keep
 * their pixel chunks; only the metadata blocks are dropped. A JPG that relied on EXIF to
 * stand upright gets a tiny new EXIF holding only that rotation, so it still shows right.
 */

export interface PhotoInfo {
  camera?: string;
  taken?: string;
  software?: string;
  gps?: { lat: number; lon: number } | true;
  orientation?: number;
  other: string[]; // "XMP", "IPTC", "Comment", "Text: ..."
}

const u16 = (d: Uint8Array, o: number, le: boolean): number => (le ? d[o] | (d[o + 1] << 8) : (d[o] << 8) | d[o + 1]);
const u32 = (d: Uint8Array, o: number, le: boolean): number =>
  (le ? d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24) : (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
const ascii = (d: Uint8Array, o: number, n: number): string => {
  let s = '';
  for (let i = 0; i < n && o + i < d.length; i++) {
    const c = d[o + i];
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
};

/** Read the parts of a TIFF (EXIF) block people care about. */
export function readTiff(t: Uint8Array, info: PhotoInfo): void {
  if (t.length < 8) return;
  const le = t[0] === 0x49;
  if (!le && t[0] !== 0x4d) return;
  const ifd = (off: number, fn: (tag: number, type: number, count: number, valOff: number) => void) => {
    if (off + 2 > t.length) return;
    const n = u16(t, off, le);
    for (let i = 0; i < n && off + 2 + i * 12 + 12 <= t.length; i++) {
      const e = off + 2 + i * 12;
      const type = u16(t, e + 2, le);
      const count = u32(t, e + 4, le);
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 } as Record<number, number>)[type] || 1;
      const valOff = size * count <= 4 ? e + 8 : u32(t, e + 8, le);
      fn(u16(t, e, le), type, count, valOff);
    }
  };
  let make = '';
  let model = '';
  let exifOff = 0;
  let gpsOff = 0;
  ifd(u32(t, 4, le), (tag, type, count, v) => {
    if (tag === 0x010f) make = ascii(t, v, count);
    else if (tag === 0x0110) model = ascii(t, v, count);
    else if (tag === 0x0131) info.software = ascii(t, v, count);
    else if (tag === 0x0132 && !info.taken) info.taken = ascii(t, v, count);
    else if (tag === 0x0112) info.orientation = u16(t, v, le);
    else if (tag === 0x8769) exifOff = u32(t, v, le);
    else if (tag === 0x8825) gpsOff = u32(t, v, le);
  });
  if (make || model) info.camera = model.toLowerCase().startsWith(make.toLowerCase()) ? model : [make, model].filter(Boolean).join(' ');
  if (exifOff) ifd(exifOff, (tag, _type, count, v) => {
    if (tag === 0x9003) info.taken = ascii(t, v, count);
  });
  if (gpsOff) {
    const g: Record<number, number[] | string> = {};
    ifd(gpsOff, (tag, type, count, v) => {
      if (type === 2) g[tag] = ascii(t, v, count);
      else if (type === 5) g[tag] = Array.from({ length: count }, (_, i) => u32(t, v + i * 8, le) / (u32(t, v + i * 8 + 4, le) || 1));
    });
    const deg = (a: unknown) => (Array.isArray(a) && a.length >= 3 ? a[0] + a[1] / 60 + a[2] / 3600 : NaN);
    const lat = deg(g[2]) * (g[1] === 'S' ? -1 : 1);
    const lon = deg(g[4]) * (g[3] === 'W' ? -1 : 1);
    info.gps = Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon) ? { lat, lon } : Object.keys(g).length > 1 ? true : undefined;
  }
}

// ---------------------------------------------------------------- JPG

interface Seg {
  marker: number;
  start: number;
  end: number;
}

/** The segments before the image data, and where the image data (from SOS) starts and ends. */
function jpegSegments(d: Uint8Array): { segs: Seg[]; sos: number; eoi: number } | null {
  if (d[0] !== 0xff || d[1] !== 0xd8) return null;
  const segs: Seg[] = [];
  let o = 2;
  while (o + 4 <= d.length) {
    if (d[o] !== 0xff) return null;
    const marker = d[o + 1];
    if (marker === 0xff) {
      o++;
      continue;
    }
    const len = (d[o + 2] << 8) | d[o + 3];
    if (marker === 0xda) {
      // Image data runs until a marker that is not a restart (D0-D7) or a stuffed byte.
      let p = o + 2 + len;
      while (p + 1 < d.length) {
        if (d[p] === 0xff && d[p + 1] !== 0 && !(d[p + 1] >= 0xd0 && d[p + 1] <= 0xd7)) {
          if (d[p + 1] === 0xd9) return { segs, sos: o, eoi: p + 2 };
          // Progressive JPGs have more segments (DHT, SOS) between scans.
          if (d[p + 1] === 0xff) {
            p++;
            continue;
          }
          break;
        }
        p++;
      }
      // Not a baseline end: walk the rest as segments until EOI.
      let q = p;
      while (q + 1 < d.length) {
        if (d[q] === 0xff && d[q + 1] === 0xd9) return { segs, sos: o, eoi: q + 2 };
        q++;
      }
      return { segs, sos: o, eoi: d.length };
    }
    segs.push({ marker, start: o, end: o + 2 + len });
    o += 2 + len;
  }
  return null;
}

const startsWith = (d: Uint8Array, o: number, s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (d[o + i] !== s.charCodeAt(i)) return false;
  return true;
};

export function jpegInfo(d: Uint8Array): PhotoInfo {
  const info: PhotoInfo = { other: [] };
  const j = jpegSegments(d);
  if (!j) return info;
  for (const s of j.segs) {
    const body = s.start + 4;
    if (s.marker === 0xe1 && startsWith(d, body, 'Exif\0\0')) readTiff(d.subarray(body + 6, s.end), info);
    else if (s.marker === 0xe1 && startsWith(d, body, 'http://ns.adobe.com/xap')) info.other.includes('XMP') || info.other.push('XMP');
    else if (s.marker === 0xed) info.other.includes('IPTC') || info.other.push('IPTC');
    else if (s.marker === 0xfe) info.other.push(`Comment: ${ascii(d, body, Math.min(60, s.end - body))}`);
  }
  if (j.eoi < d.length - 2) info.other.push('Extra pictures after the photo (depth map or preview)');
  return info;
}

/** A minimal EXIF block holding only the rotation. */
function orientationExif(o: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0, 0, 0];
  const body = [...'Exif'].map((c) => c.charCodeAt(0)).concat([0, 0], tiff);
  const len = body.length + 2;
  return new Uint8Array([0xff, 0xe1, len >> 8, len & 255, ...body]);
}

export function jpegStrip(d: Uint8Array, orientation?: number): Uint8Array {
  const j = jpegSegments(d);
  if (!j) throw new Error('This JPG could not be read.');
  const keep: Uint8Array[] = [d.subarray(0, 2)];
  if (orientation && orientation > 1 && orientation <= 8) keep.push(orientationExif(orientation));
  for (const s of j.segs) {
    const body = s.start + 4;
    const m = s.marker;
    const isApp = m >= 0xe0 && m <= 0xef;
    const keepApp = (m === 0xe0 && startsWith(d, body, 'JFIF')) || (m === 0xe2 && startsWith(d, body, 'ICC_PROFILE')) || m === 0xee;
    if (m === 0xfe || (isApp && !keepApp)) continue;
    keep.push(d.subarray(s.start, s.end));
  }
  keep.push(d.subarray(j.sos, j.eoi));
  const out = new Uint8Array(keep.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of keep) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- PNG

const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'iCCN']);

function pngChunks(d: Uint8Array): { type: string; start: number; end: number; data: number; len: number }[] {
  const out = [];
  let o = 8;
  while (o + 12 <= d.length) {
    const len = u32(d, o, false);
    const type = ascii(d, o + 4, 4);
    out.push({ type, start: o, end: o + 12 + len, data: o + 8, len });
    o += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

export function pngInfo(d: Uint8Array): PhotoInfo {
  const info: PhotoInfo = { other: [] };
  for (const c of pngChunks(d)) {
    if (c.type === 'eXIf') readTiff(d.subarray(c.data, c.data + c.len), info);
    else if (c.type === 'tEXt' || c.type === 'iTXt' || c.type === 'zTXt') {
      const key = ascii(d, c.data, Math.min(79, c.len));
      if (/XML:com.adobe.xmp/i.test(key)) info.other.includes('XMP') || info.other.push('XMP');
      else info.other.push(`Text: ${key}`);
    } else if (c.type === 'tIME') info.other.push('Date saved');
  }
  return info;
}

export function pngStrip(d: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [d.subarray(0, 8)];
  for (const c of pngChunks(d)) if (!PNG_DROP.has(c.type)) parts.push(d.subarray(c.start, c.end));
  return concat(parts);
}

// ---------------------------------------------------------------- WebP

function riffChunks(d: Uint8Array): { type: string; start: number; end: number; data: number; len: number }[] {
  const out = [];
  let o = 12;
  while (o + 8 <= d.length) {
    const len = u32(d, o + 4, true);
    const type = ascii(d, o, 4);
    const end = o + 8 + len + (len & 1);
    out.push({ type, start: o, end, data: o + 8, len });
    o = end;
  }
  return out;
}

export function webpInfo(d: Uint8Array): PhotoInfo {
  const info: PhotoInfo = { other: [] };
  for (const c of riffChunks(d)) {
    if (c.type === 'EXIF') {
      let t = d.subarray(c.data, c.data + c.len);
      if (startsWith(t, 0, 'Exif\0\0')) t = t.subarray(6);
      readTiff(t, info);
    } else if (c.type === 'XMP ') info.other.push('XMP');
  }
  return info;
}

export function webpStrip(d: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const c of riffChunks(d)) {
    if (c.type === 'EXIF' || c.type === 'XMP ') continue;
    const chunk = d.slice(c.start, c.end);
    if (c.type === 'VP8X') chunk[8] &= ~(0x08 | 0x04);
    parts.push(chunk);
  }
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(d.subarray(0, 12));
  out.set(body, 12);
  const size = out.length - 8;
  out[4] = size & 255;
  out[5] = (size >> 8) & 255;
  out[6] = (size >> 16) & 255;
  out[7] = (size >>> 24) & 255;
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function kind(d: Uint8Array): 'jpg' | 'png' | 'webp' | 'other' {
  if (d[0] === 0xff && d[1] === 0xd8) return 'jpg';
  if (d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) return 'png';
  if (startsWith(d, 0, 'RIFF') && startsWith(d, 8, 'WEBP')) return 'webp';
  return 'other';
}
