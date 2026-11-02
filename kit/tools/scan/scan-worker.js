/* Paperhaus scanner engine.
 * A classic web worker that runs OpenCV.js off the main thread, so the camera view stays
 * smooth. Everything happens on the device; nothing is sent anywhere.
 *
 * Messages in:  { id, type, ...args }   Messages out: { id, ok, result | error }
 *   init     ()                                        -> { version }
 *   ingest   { blob, maxSide }                         -> { blob, w, h, corners, found }
 *   detect   { buffer, w, h }        (RGBA pixels)     -> { corners, found }
 *   render   { blob, corners, rotation, filter, brightness, contrast, maxSide,
 *              aspect?, format, quality }               -> { blob, w, h }
 *   qr       { buffer, w, h }                          -> { text, points }
 *
 * Corners are normalised (0-1) in the order top-left, top-right, bottom-right, bottom-left.
 */
/* global cv, importScripts */

const CV_URL = new URL(self.location.href).searchParams.get('cv');
let ready = null;

function loadCv() {
  if (!ready) {
    ready = (async () => {
      importScripts(CV_URL);
      let m = self.cv;
      if (m instanceof Promise) m = await m;
      if (!m.Mat) {
        // OpenCV.js hands back a "thenable" module. Take the module from its callback,
        // and drop `then` so it is not treated as a promise again.
        m = await new Promise((resolve) => {
          m.then((mod) => {
            delete mod.then;
            resolve(mod);
          });
        });
      }
      self.cv = m;
      return m;
    })();
  }
  return ready;
}

// Track Mats so every path frees them.
function scope() {
  const mats = [];
  return {
    add(m) {
      mats.push(m);
      return m;
    },
    free() {
      for (const m of mats) {
        try {
          if (m && !m.isDeleted()) m.delete();
        } catch (_) {
          /* already gone */
        }
      }
    },
  };
}

const odd = (n) => (n % 2 === 0 ? n + 1 : n);

// ------------------------------------------------------------- image I/O

async function decode(blob, maxSide) {
  let bmp;
  try {
    // Respect the camera's rotation flag (EXIF), so phone photos come out upright.
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (_) {
    bmp = await createImageBitmap(blob); // older Safari: applies EXIF by default
  }
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return { canvas, ctx, w, h };
}

function matFromCanvas(ctx, w, h) {
  return cv.matFromImageData(ctx.getImageData(0, 0, w, h));
}

async function matToBlob(rgba, format, quality) {
  const w = rgba.cols;
  const h = rgba.rows;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.data), w, h), 0, 0);
  const type = format === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await canvas.convertToBlob({ type, quality });
  return { blob, w, h };
}

// ------------------------------------------------------------- edge detection

function orderCorners(pts) {
  // pts: [[x,y] x4] -> tl, tr, br, bl
  const bySum = [...pts].sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  const byDiff = [...pts].sort((a, b) => a[1] - a[0] - (b[1] - b[0]));
  const tl = bySum[0];
  const br = bySum[3];
  const tr = byDiff[0];
  const bl = byDiff[3];
  return [tl, tr, br, bl];
}

function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function matToPoints(m) {
  const pts = [];
  for (let i = 0; i < m.rows; i++) pts.push([m.data32S[i * 2], m.data32S[i * 2 + 1]]);
  return pts;
}

// How square the corners are (1 = perfect rectangle in the image).
function rectangularity(p) {
  let worst = 1;
  for (let i = 0; i < 4; i++) {
    const a = p[(i + 3) % 4];
    const b = p[i];
    const c = p[(i + 1) % 4];
    const v1 = [a[0] - b[0], a[1] - b[1]];
    const v2 = [c[0] - b[0], c[1] - b[1]];
    const cos = Math.abs((v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) + 1e-9));
    worst = Math.min(worst, 1 - cos);
  }
  return worst;
}

function quadFromContour(c, s, minArea) {
  const peri = cv.arcLength(c, true);
  for (const eps of [0.02, 0.03, 0.045, 0.06]) {
    const approx = s.add(new cv.Mat());
    cv.approxPolyDP(c, approx, eps * peri, true);
    if (approx.rows === 4 && cv.isContourConvex(approx)) {
      const pts = matToPoints(approx);
      if (polyArea(pts) >= minArea) return pts;
    }
  }
  // Fall back to the convex hull of a big blob, reduced to four points.
  const hull = s.add(new cv.Mat());
  cv.convexHull(c, hull, false, true);
  const hp = cv.arcLength(hull, true);
  for (const eps of [0.02, 0.04, 0.06, 0.08, 0.1]) {
    const approx = s.add(new cv.Mat());
    cv.approxPolyDP(hull, approx, eps * hp, true);
    if (approx.rows === 4) {
      const pts = matToPoints(approx);
      if (polyArea(pts) >= minArea) return pts;
    }
  }
  return null;
}

// rgba: CV_8UC4 Mat at any size. Returns normalised corners or null.
function findDocument(rgba) {
  const s = scope();
  try {
    const W = rgba.cols;
    const H = rgba.rows;
    const scale = Math.min(1, 520 / Math.max(W, H));
    const small = s.add(new cv.Mat());
    cv.resize(rgba, small, new cv.Size(Math.round(W * scale), Math.round(H * scale)), 0, 0, cv.INTER_AREA);
    const w = small.cols;
    const h = small.rows;
    const area = w * h;

    const gray = s.add(new cv.Mat());
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    // Saturation helps when a white page sits on a coloured surface.
    const rgb = s.add(new cv.Mat());
    cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
    const hsv = s.add(new cv.Mat());
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const ch = s.add(new cv.MatVector());
    cv.split(hsv, ch);
    const sat = s.add(ch.get(1));

    const kernel = s.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9)));
    const dil = s.add(cv.Mat.ones(3, 3, cv.CV_8U));

    const cands = [];
    const consider = (src, lo, hi) => {
      const blur = s.add(new cv.Mat());
      cv.GaussianBlur(src, blur, new cv.Size(5, 5), 0);
      const closed = s.add(new cv.Mat());
      cv.morphologyEx(blur, closed, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 2);
      const edges = s.add(new cv.Mat());
      cv.Canny(closed, edges, lo, hi);
      cv.dilate(edges, edges, dil);
      const contours = s.add(new cv.MatVector());
      const hier = s.add(new cv.Mat());
      cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const list = [];
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        s.add(c);
        const a = cv.contourArea(c);
        if (a > area * 0.08) list.push([a, c]);
      }
      list.sort((x, y) => y[0] - x[0]);
      for (const [, c] of list.slice(0, 6)) {
        const q = quadFromContour(c, s, area * 0.1);
        if (!q) continue;
        const ordered = orderCorners(q);
        const ratio = polyArea(ordered) / area;
        // Prefer big, rectangular quads; a quad hugging the frame edge is fine.
        const score = ratio * (0.4 + 0.6 * rectangularity(ordered));
        if (score > 0.07) cands.push({ q: ordered, score });
      }
    };
    consider(gray, 30, 90);
    consider(gray, 10, 40);
    consider(sat, 20, 60);
    consider(sat, 8, 30);

    if (!cands.length) return null;
    // Several edge maps each propose quads. A leaky outline (one corner wandering off
    // into the table) is rare and different every time, while the true page outline
    // shows up again and again. Pick the outline most proposals agree on and average it.
    const near = (a, b) => {
      const d = Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
      return d < 0.025 * Math.max(w, h);
    };
    // Group matching proposals. Take the largest outline that at least two proposals
    // agree on (a page is bigger than anything printed on it); if nothing repeats, take
    // the strongest single proposal.
    const groups = cands.map((c) => {
      const group = cands.filter((o) => near(c.q, o.q));
      const total = group.reduce((a, o) => a + o.score, 0);
      const q = c.q.map((_, i) => [
        group.reduce((a, o) => a + o.q[i][0] * o.score, 0) / total,
        group.reduce((a, o) => a + o.q[i][1] * o.score, 0) / total,
      ]);
      return { q, count: group.length, area: polyArea(q), total };
    });
    const repeated = groups.filter((g) => g.count >= 2);
    const pool = repeated.length ? repeated : groups;
    const pick = pool.reduce((a, g) => (repeated.length ? g.area > a.area : g.total > a.total) ? g : a);
    const best = pick.q;
    // Pull the corners in a hair so no sliver of the table shows at the edges.
    const cx = best.reduce((a, p) => a + p[0], 0) / 4;
    const cy = best.reduce((a, p) => a + p[1], 0) / 4;
    return best.map(([x, y]) => {
      const nx = x + (cx - x) * 0.008;
      const ny = y + (cy - y) * 0.008;
      return [Math.min(1, Math.max(0, nx / w)), Math.min(1, Math.max(0, ny / h))];
    });
  } finally {
    s.free();
  }
}

const FULL = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

// ------------------------------------------------------------- filters

// Estimate the page's lighting and divide it out. This removes shadows and turns the
// paper white while keeping ink colours. The lighting is modelled as a smooth surface
// (a cubic polynomial) fitted to the brightest pixels of each small block, rejecting
// blocks that sit darker than the surface. Photos, logos and coloured bands are much
// darker than paper, so they are left alone instead of being bleached.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

const terms = (x, y, deg) =>
  deg === 3
    ? [1, x, y, x * x, x * y, y * y, x * x * x, x * x * y, x * y * y, y * y * y]
    : [1, x, y, x * x, x * y, y * y];

function fitSurface(samples, deg) {
  let pts = samples;
  let coef = null;
  for (let iter = 0; iter < 5; iter++) {
    const k = deg === 3 ? 10 : 6;
    if (pts.length < k * 2) return coef;
    const A = Array.from({ length: k }, () => new Array(k).fill(0));
    const b = new Array(k).fill(0);
    for (const [x, y, v] of pts) {
      const t = terms(x, y, deg);
      for (let i = 0; i < k; i++) {
        b[i] += t[i] * v;
        for (let j = 0; j < k; j++) A[i][j] += t[i] * t[j];
      }
    }
    const c = solve(A, b);
    if (!c) return coef;
    coef = c;
    const keep = pts.filter(([x, y, v]) => {
      const t = terms(x, y, deg);
      let f = 0;
      for (let i = 0; i < t.length; i++) f += c[i] * t[i];
      return v > f - 10;
    });
    if (keep.length === pts.length) break;
    pts = keep;
  }
  return coef;
}

function flatten(src, s, strength) {
  const W = src.cols;
  const H = src.rows;
  const nch = src.channels();
  const f = Math.min(1, 240 / Math.max(W, H));
  const sw = Math.max(16, Math.round(W * f));
  const sh = Math.max(16, Math.round(H * f));
  const small = s.add(new cv.Mat());
  cv.resize(src, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
  const data = small.data;
  const B = 12;
  const nx = Math.max(4, Math.round(sw / B));
  const ny = Math.max(4, Math.round(sh / B));

  const bgSmall = s.add(new cv.Mat(sh, sw, nch === 1 ? cv.CV_8UC1 : cv.CV_8UC3));
  const out = bgSmall.data;
  for (let ch = 0; ch < nch; ch++) {
    const samples = [];
    for (let by = 0; by < ny; by++) {
      for (let bx = 0; bx < nx; bx++) {
        const x0 = Math.floor((bx * sw) / nx);
        const x1 = Math.floor(((bx + 1) * sw) / nx);
        const y0 = Math.floor((by * sh) / ny);
        const y1 = Math.floor(((by + 1) * sh) / ny);
        const vals = [];
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) vals.push(data[(y * sw + x) * nch + ch]);
        if (!vals.length) continue;
        vals.sort((a, b) => a - b);
        const v = vals[Math.floor(vals.length * 0.9)];
        samples.push([((x0 + x1) / 2 / sw) * 2 - 1, ((y0 + y1) / 2 / sh) * 2 - 1, v]);
      }
    }
    // Start from the brighter blocks: paper is the brightest large thing on a page.
    const sorted = samples.map((p) => p[2]).sort((a, b) => a - b);
    const top = sorted[Math.floor(sorted.length * 0.9)] || 255;
    const seed = samples.filter((p) => p[2] > top - 70);
    const coef = fitSurface(seed, 3) || fitSurface(seed, 2);
    for (let y = 0; y < sh; y++) {
      const ny2 = (y / sh) * 2 - 1;
      for (let x = 0; x < sw; x++) {
        let v = top;
        if (coef) {
          const t = terms((x / sw) * 2 - 1, ny2, coef.length === 10 ? 3 : 2);
          v = 0;
          for (let i = 0; i < t.length; i++) v += coef[i] * t[i];
        }
        out[(y * sw + x) * nch + ch] = Math.max(24, Math.min(255, Math.round(v)));
      }
    }
  }
  const bg = s.add(new cv.Mat());
  cv.resize(bgSmall, bg, new cv.Size(W, H), 0, 0, cv.INTER_CUBIC);
  const res = s.add(new cv.Mat());
  cv.divide(src, bg, res, 255);
  if (strength < 1) cv.addWeighted(res, strength, src, 1 - strength, 0, res);
  return res;
}

function levels(m, black, white) {
  const a = 255 / Math.max(1, white - black);
  m.convertTo(m, -1, a, -black * a);
}

function saturate(rgb, amount, s) {
  const hsv = s.add(new cv.Mat());
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const ch = s.add(new cv.MatVector());
  cv.split(hsv, ch);
  const sat = s.add(ch.get(1));
  sat.convertTo(sat, -1, amount, 0);
  ch.set(1, sat);
  cv.merge(ch, hsv);
  cv.cvtColor(hsv, rgb, cv.COLOR_HSV2RGB);
}

// rgba in, rgba out
function applyFilter(rgba, filter, s) {
  if (filter === 'original') return rgba;
  const rgb = s.add(new cv.Mat());
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  let out3;
  let gray = null;

  if (filter === 'magic') {
    out3 = flatten(rgb, s, 1);
    levels(out3, 30, 250);
    saturate(out3, 1.3, s);
  } else if (filter === 'whiteboard') {
    out3 = flatten(rgb, s, 1);
    levels(out3, 60, 240);
    saturate(out3, 1.8, s);
  } else if (filter === 'lighten') {
    out3 = flatten(rgb, s, 0.55);
    levels(out3, 0, 228);
  } else if (filter === 'gray') {
    gray = s.add(new cv.Mat());
    cv.cvtColor(flatten(rgb, s, 0.75), gray, cv.COLOR_RGB2GRAY);
    levels(gray, 20, 245);
  } else if (filter === 'bw') {
    const g = s.add(new cv.Mat());
    cv.cvtColor(rgb, g, cv.COLOR_RGB2GRAY);
    const flat = flatten(g, s, 1);
    gray = s.add(new cv.Mat());
    const block = odd(Math.max(15, Math.round(Math.min(flat.cols, flat.rows) / 28)));
    cv.adaptiveThreshold(flat, gray, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 12);
    // Keep flat areas pure white: anything the flattening already saw as paper stays paper.
    const paper = s.add(new cv.Mat());
    cv.threshold(flat, paper, 225, 255, cv.THRESH_BINARY);
    cv.bitwise_or(gray, paper, gray);
  } else {
    return rgba;
  }

  const result = s.add(new cv.Mat());
  if (gray) cv.cvtColor(gray, result, cv.COLOR_GRAY2RGBA);
  else cv.cvtColor(out3, result, cv.COLOR_RGB2RGBA);
  return result;
}

// ------------------------------------------------------------- render

function warp(rgba, corners, maxSide, aspect, s) {
  const W = rgba.cols;
  const H = rgba.rows;
  const p = corners.map(([x, y]) => [x * W, y * H]);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let outW = Math.max(d(p[0], p[1]), d(p[3], p[2]));
  let outH = Math.max(d(p[0], p[3]), d(p[1], p[2]));
  if (aspect) {
    // Forced shape (ID cards), matching the card's orientation. Keep the larger side.
    const want = outW >= outH ? aspect : 1 / aspect;
    if (outW / outH >= want) outH = outW / want;
    else outW = outH * want;
  }
  const scale = Math.min(1, maxSide / Math.max(outW, outH));
  outW = Math.max(1, Math.round(outW * scale));
  outH = Math.max(1, Math.round(outH * scale));

  // Shrink the source first when the output is much smaller, to avoid jagged text.
  let src = rgba;
  let pts = p;
  if (scale < 0.7) {
    const shrunk = s.add(new cv.Mat());
    const f = Math.max(scale * 1.15, 0.05);
    cv.resize(rgba, shrunk, new cv.Size(Math.round(W * f), Math.round(H * f)), 0, 0, cv.INTER_AREA);
    src = shrunk;
    pts = p.map(([x, y]) => [x * f, y * f]);
  }

  const from = s.add(cv.matFromArray(4, 1, cv.CV_32FC2, pts.flat()));
  const to = s.add(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]));
  const M = s.add(cv.getPerspectiveTransform(from, to));
  const out = s.add(new cv.Mat());
  cv.warpPerspective(src, out, M, new cv.Size(outW, outH), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
  return out;
}

async function render(a) {
  const s = scope();
  try {
    const srcMax = Math.min(4000, Math.max(a.maxSide * 1.6, 1200));
    const { ctx, w, h } = await decode(a.blob, srcMax);
    const rgba = s.add(matFromCanvas(ctx, w, h));
    let m = warp(rgba, a.corners || FULL, a.maxSide, a.aspect || 0, s);
    m = applyFilter(m, a.filter || 'original', s);

    const br = Number(a.brightness) || 0;
    const ct = Number(a.contrast) || 0;
    if (br || ct) {
      const alpha = 1 + ct / 100;
      m.convertTo(m, -1, alpha, br * 1.28 + 128 * (1 - alpha));
      // convertTo touches alpha too; restore it to opaque.
      const ch = s.add(new cv.MatVector());
      cv.split(m, ch);
      const opaque = s.add(new cv.Mat(m.rows, m.cols, cv.CV_8UC1, new cv.Scalar(255)));
      ch.set(3, opaque);
      cv.merge(ch, m);
    }

    const rot = ((Number(a.rotation) || 0) % 360 + 360) % 360;
    if (rot) {
      const r = s.add(new cv.Mat());
      const code = rot === 90 ? cv.ROTATE_90_CLOCKWISE : rot === 180 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE;
      cv.rotate(m, r, code);
      m = r;
    }
    return await matToBlob(m, a.format, a.quality ?? 0.85);
  } finally {
    s.free();
  }
}

async function ingest(a) {
  const s = scope();
  try {
    const { canvas, ctx, w, h } = await decode(a.blob, a.maxSide || 3600);
    const rgba = s.add(matFromCanvas(ctx, w, h));
    const corners = findDocument(rgba);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    return { blob, w, h, corners: corners || FULL, found: !!corners };
  } finally {
    s.free();
  }
}

function detect(a) {
  const s = scope();
  try {
    const m = s.add(cv.matFromImageData(new ImageData(new Uint8ClampedArray(a.buffer), a.w, a.h)));
    const corners = findDocument(m);
    return { corners, found: !!corners };
  } finally {
    s.free();
  }
}

let qrDetector = null;
function qr(a) {
  const s = scope();
  try {
    const m = s.add(cv.matFromImageData(new ImageData(new Uint8ClampedArray(a.buffer), a.w, a.h)));
    const g = s.add(new cv.Mat());
    cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY);
    if (!qrDetector) qrDetector = new cv.QRCodeDetector();
    const pts = s.add(new cv.Mat());
    const text = qrDetector.detectAndDecode(g, pts);
    return { text: text || '' };
  } finally {
    s.free();
  }
}

async function qrFromBlob(a) {
  const { ctx, w, h } = await decode(a.blob, 1600);
  const data = ctx.getImageData(0, 0, w, h);
  return qr({ buffer: data.data.buffer, w, h });
}

self.onmessage = async (e) => {
  const { id, type, ...args } = e.data;
  try {
    await loadCv();
    let result;
    if (type === 'init') result = { ok: true };
    else if (type === 'ingest') result = await ingest(args);
    else if (type === 'detect') result = detect(args);
    else if (type === 'render') result = await render(args);
    else if (type === 'qr') result = qr(args);
    else if (type === 'qrBlob') result = await qrFromBlob(args);
    else throw new Error(`Unknown request: ${type}`);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
