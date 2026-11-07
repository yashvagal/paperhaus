#!/usr/bin/env node
// Phase 0 kit build: brands BentoPDF, serves every engine from your own site,
// and makes the output fit Cloudflare Pages' free plan.
//
// Cloudflare Pages build command:  node kit/build.mjs
// Output directory:                dist
//
// Nothing in src/ is changed permanently: the temporary source patches, the Paperhaus
// tools (kit/tools) and the copied logo are removed again when the build finishes,
// so upstream merges stay clean.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync,
  readdirSync, statSync, openSync, readSync, closeSync, cpSync,
} from 'node:fs';
import { join, dirname, basename, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(KIT);
const DIST = join(ROOT, 'dist');
const CACHE = join(ROOT, 'node_modules', '.cache', 'phase0-kit');

// Cloudflare Pages free plan: 25 MiB per file, 20,000 files, 100 header rules,
// 2,000 characters per header value.
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PART_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 20000;

// Extra engines the Paperhaus tools use, served from your own site like the rest.
const OPENCV_PACKAGE = '@techstark/opencv-js@4.12.0-release.1';
const OPENCV_URL = '/wasm/opencv-4.12.0/opencv.js';
const SCAN_WORKER_URL = '/kit-tools/scan/scan-worker.js';

const log = (msg) => console.log(`[phase0-kit] ${msg}`);
// Errors are thrown (not process.exit) so every `finally` runs and the temporary
// source changes are always put back, even when the build fails.
class KitError extends Error {}
const fail = (msg) => {
  throw new KitError(msg);
};
process.on('uncaughtException', (err) => {
  console.error(err instanceof KitError ? `\n[phase0-kit] ERROR: ${err.message}\n` : err);
  process.exit(1);
});

// ---------------------------------------------------------------- settings

function loadKitEnv() {
  const env = {};
  const text = readFileSync(join(KIT, 'kit.env'), 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    env[key] = value;
  }
  // Cloudflare dashboard variables override kit.env, handy for quick tests.
  for (const key of Object.keys(env)) {
    if (process.env[`KIT_${key}`]) env[key] = process.env[`KIT_${key}`];
  }
  if (!env.BRAND_NAME) fail('BRAND_NAME is empty in kit/kit.env');
  if (!env.SOURCE_URL || env.SOURCE_URL.includes('YOUR-GITHUB-USERNAME')) {
    log('WARNING: SOURCE_URL in kit/kit.env is still the placeholder. Set it to your fork so the account menu links to your source code.');
  }
  env.OCR_LANGUAGES = (env.OCR_LANGUAGES || 'eng')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return env;
}

// ---------------------------------------------------------------- versions

function readVersions() {
  const cdn = readFileSync(join(ROOT, 'src/js/const/cdn-version.ts'), 'utf8');
  const pick = (re, src, what) => {
    const m = src.match(re);
    if (!m) fail(`Could not read the ${what} version from BentoPDF's source. Upstream may have moved it; check kit/build.mjs readVersions().`);
    return m[1];
  };
  const provider = readFileSync(join(ROOT, 'src/js/utils/wasm-provider.ts'), 'utf8');
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const lockVersion = (name) => {
    const v = lock.packages?.[`node_modules/${name}`]?.version;
    if (!v) fail(`Could not find ${name} in package-lock.json`);
    return v;
  };
  return {
    pymupdf: pick(/pymupdf:\s*'([^']+)'/, cdn, 'PyMuPDF'),
    ghostscript: pick(/ghostscript:\s*'([^']+)'/, cdn, 'Ghostscript'),
    cpdf: pick(/coherentpdf@([0-9][^/'"]*)/, provider, 'CoherentPDF'),
    tesseract: lockVersion('tesseract.js'),
    tesseractCore: lockVersion('tesseract.js-core'),
  };
}

// ---------------------------------------------------------------- helpers

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (res.status !== 0) fail(`${cmd} ${args.join(' ')} exited with code ${res.status}`);
}

function npmPack(spec) {
  mkdirSync(join(CACHE, 'tgz'), { recursive: true });
  const safe = spec.replace(/[@/]/g, '_');
  const marker = join(CACHE, 'tgz', `${safe}.name`);
  if (existsSync(marker)) {
    const file = join(CACHE, 'tgz', readFileSync(marker, 'utf8').trim());
    if (existsSync(file)) return file;
  }
  const out = execFileSync('npm', ['pack', spec, '--pack-destination', join(CACHE, 'tgz'), '--json', '--silent'], {
    cwd: CACHE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
  const name = JSON.parse(out)[0].filename.replace(/^@/, '').replace(/\//g, '-');
  writeFileSync(marker, name);
  return join(CACHE, 'tgz', name);
}

function extract(tgz) {
  const dir = join(CACHE, 'x', basename(tgz, '.tgz'));
  if (!existsSync(join(dir, 'package'))) {
    mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['-xzf', tgz, '-C', dir]);
  }
  return join(dir, 'package');
}

function download(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 0) return;
  mkdirSync(dirname(dest), { recursive: true });
  const res = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', dest, url], { stdio: 'inherit' });
  if (res.status !== 0) {
    rmSync(dest, { force: true });
    fail(`Download failed: ${url}`);
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out); else out.push({ path: p, size: s.size });
  }
  return out;
}

// ---------------------------------------------------------------- engines

// Paths are versioned so browsers can cache them forever and an upgrade
// never serves a stale file.
function engineUrls(v) {
  return {
    pymupdf: `/wasm/pymupdf-${v.pymupdf}/`,
    gs: `/wasm/gs-${v.ghostscript}/`,
    cpdf: `/wasm/cpdf-${v.cpdf}/`,
    ocr: `/wasm/ocr-${v.tesseract}`,
  };
}

function fetchEngines(v, env, urls) {
  log('Fetching engines from the npm registry (cached after the first build)...');
  const target = (p) => join(DIST, p.replace(/^\//, ''));
  installKitToolAssets(target);

  cpSync(extract(npmPack(`@bentopdf/pymupdf-wasm@${v.pymupdf}`)), target(urls.pymupdf), { recursive: true });

  const gs = extract(npmPack(`@bentopdf/gs-wasm@${v.ghostscript}`));
  cpSync(existsSync(join(gs, 'assets')) ? join(gs, 'assets') : gs, target(urls.gs), { recursive: true });

  const cpdf = extract(npmPack(`coherentpdf@${v.cpdf}`));
  cpSync(existsSync(join(cpdf, 'dist')) ? join(cpdf, 'dist') : cpdf, target(urls.cpdf), { recursive: true });

  const ocr = target(urls.ocr);
  mkdirSync(join(ocr, 'lang-data'), { recursive: true });
  copyFileSync(join(extract(npmPack(`tesseract.js@${v.tesseract}`)), 'dist', 'worker.min.js'), join(ocr, 'worker.min.js'));
  cpSync(extract(npmPack(`tesseract.js-core@${v.tesseractCore}`)), join(ocr, 'core'), { recursive: true });

  for (const lang of env.OCR_LANGUAGES) {
    const pkg = extract(npmPack(`@tesseract.js-data/${lang}@1.0.0`));
    const file = join(pkg, '4.0.0_best_int', `${lang}.traineddata.gz`);
    if (!existsSync(file)) fail(`OCR language "${lang}" not found. Check OCR_LANGUAGES in kit/kit.env.`);
    copyFileSync(file, join(ocr, 'lang-data', `${lang}.traineddata.gz`));
  }

  // OCR text-layer fonts: same selection logic as BentoPDF's offline-bundle script,
  // fetched from GitHub (the githack links in BentoPDF mirror GitHub raw files).
  const mapping = readFileSync(join(ROOT, 'src/js/config/font-mappings.ts'), 'utf8');
  const [langSection, fontSection = ''] = mapping.split('export const fontFamilyToUrl');
  const langToFamily = {};
  for (const m of langSection.matchAll(/^\s*([a-z_]+):\s*'([^']+)',/gm)) langToFamily[m[1]] = m[2];
  const familyToUrl = {};
  for (const m of fontSection.matchAll(/^\s*'([^']+)':\s*\n?\s*'([^']+)',/gm)) familyToUrl[m[1]] = m[2];
  const families = new Set(['Noto Sans', ...env.OCR_LANGUAGES.map((l) => langToFamily[l] || 'Noto Sans')]);
  for (const family of families) {
    const url = familyToUrl[family] || familyToUrl['Noto Sans'];
    if (!url) fail(`No font URL found for ${family} in font-mappings.ts`);
    const githubUrl = url.replace('https://rawcdn.githack.com/', 'https://raw.githubusercontent.com/');
    const cached = join(CACHE, 'fonts', basename(url));
    download(githubUrl, cached);
    mkdirSync(join(ocr, 'fonts'), { recursive: true });
    copyFileSync(cached, join(ocr, 'fonts', basename(url)));
  }
  log(`Engines ready: PyMuPDF ${v.pymupdf}, Ghostscript ${v.ghostscript}, CoherentPDF ${v.cpdf}, Tesseract ${v.tesseract}, OCR: ${env.OCR_LANGUAGES.join(', ')}`);
}

// ---------------------------------------------------------------- source patch

// LibreOffice's engine files are 28 MB and 48 MB, over Cloudflare Pages' 25 MiB
// per-file cap. They are split into parts after the build, and this patch teaches
// the loader to reassemble them. Reverted after the build.
const LOADER = join(ROOT, 'src/js/utils/libreoffice-loader.ts');
// The fetch at the start of fetchAsDecompressedUrl(), from the request up to reading the
// body. Matched loosely, so wording changes in BentoPDF's error message don't break it.
const LOADER_ANCHOR = /  const response = await fetch\(url\);\n[\s\S]{0,600}?\n  let blob = await response\.blob\(\);/;
const LOADER_REPLACEMENT = `  // [phase0-kit] reassemble files split to fit Cloudflare Pages' 25 MiB limit
  let blob: Blob;
  let manifest: { parts: string[] } | null = null;
  try {
    const m = await fetch(\`\${url}.parts.json\`);
    if (m.ok) manifest = await m.json();
  } catch {
    manifest = null;
  }
  if (manifest && Array.isArray(manifest.parts) && manifest.parts.length) {
    const base = url.slice(0, url.lastIndexOf('/') + 1);
    const pieces = await Promise.all(
      manifest.parts.map(async (name) => {
        const r = await fetch(base + name);
        if (!r.ok) throw new Error(\`Failed to fetch \${base + name}: HTTP \${r.status}\`);
        return r.blob();
      })
    );
    blob = new Blob(pieces);
  } else {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(\`Failed to fetch \${url}: HTTP \${response.status}\`);
    }
    blob = await response.blob();
  }`;

function patchLoader() {
  const src = readFileSync(LOADER, 'utf8');
  if (src.includes('[phase0-kit]')) return src; // already patched (interrupted earlier run)
  if (!LOADER_ANCHOR.test(src)) {
    fail('BentoPDF changed src/js/utils/libreoffice-loader.ts, so the kit cannot patch it. Office conversion needs that patch on Cloudflare Pages. Update LOADER_ANCHOR in kit/build.mjs to match the new code.');
  }
  writeFileSync(LOADER, src.replace(LOADER_ANCHOR, () => LOADER_REPLACEMENT));
  log('Patched the LibreOffice loader to reassemble split files (temporary).');
  return src;
}

// ---------------------------------------------------------------- Paperhaus tools
// Tools that are not part of BentoPDF live in kit/tools/<tool>/. For the build they are
// copied into BentoPDF's source tree and listed in its tool registry, then removed.

const SCAN_TOOL = {
  dir: join(KIT, 'tools', 'scan'),
  page: 'scan-document',
  files: [
    ['scan-document.html', 'src/pages/scan-document.html'],
    ['scan-page.ts', 'src/js/logic/kit-scan/scan-page.ts'],
    ['scan.css', 'src/js/logic/kit-scan/scan.css'],
  ],
  // Added to the home page: first in Popular Tools, plus a category of its own.
  popular: `      {
        href: import.meta.env.BASE_URL + 'scan-document.html',
        name: 'Scan to PDF',
        icon: 'ph-scan',
        subtitle: 'Scan pages with your camera. Auto crop, shadow removal and searchable text.',
      },
`,
  category: `  {
    name: 'Scan',
    tools: [
      {
        href: import.meta.env.BASE_URL + 'scan-document.html',
        name: 'Scan to PDF',
        icon: 'ph-scan',
        subtitle: 'Scan documents, receipts and notes with your camera, or from photos.',
      },
      {
        href: import.meta.env.BASE_URL + 'scan-document.html?mode=id',
        name: 'Scan ID Card',
        icon: 'ph-identification-card',
        subtitle: 'Front and back on one page at real card size, ready to print.',
      },
      {
        href: import.meta.env.BASE_URL + 'scan-document.html?mode=book',
        name: 'Scan a Book',
        icon: 'ph-book-open',
        subtitle: 'Photograph two facing pages and get them as two PDF pages.',
      },
      {
        href: import.meta.env.BASE_URL + 'scan-document.html?mode=qr',
        name: 'Scan QR Code',
        icon: 'ph-qr-code',
        subtitle: 'Read a QR code with your camera or from a picture.',
      },
    ],
  },
`,
};

// Sign: one tool for signing yourself, signing with others and sending to others. It takes
// Sign PDF's place in the tool list (the page is request-signatures, from when it only sent
// requests). The signing page (sign-request) is public, so it is a page of its own without
// the app's navigation; the API it talks to is functions/api/esign/.
const SIGN_PDF_ENTRY = `      {
        href: import.meta.env.BASE_URL + 'sign-pdf.html',
        name: 'Sign PDF',
        icon: 'ph-pen-nib',
        subtitle: 'Draw, type, or upload your signature.',
      },
`;
const ESIGN_TOOL = {
  name: 'Sign',
  dir: join(KIT, 'tools', 'esign'),
  pages: ['request-signatures', 'sign-request'],
  files: [
    ['request-signatures.html', 'src/pages/request-signatures.html'],
    ['sign-request.html', 'src/pages/sign-request.html'],
    ['request-page.ts', 'src/js/logic/kit-esign/request-page.ts'],
    ['sign-page.ts', 'src/js/logic/kit-esign/sign-page.ts'],
    ['esign-common.ts', 'src/js/logic/kit-esign/esign-common.ts'],
    ['esign-seal.ts', 'src/js/logic/kit-esign/esign-seal.ts'],
    ['esign.css', 'src/js/logic/kit-esign/esign.css'],
  ],
  // Wherever BentoPDF lists Sign PDF.
  replacesSignPdf: `      {
        href: import.meta.env.BASE_URL + 'request-signatures.html',
        name: 'Sign',
        icon: 'ph-signature',
        subtitle: 'Sign yourself, sign with others, or send it out. Sealed and recorded.',
      },
`,
};

// Pages: BentoPDF's multi tool already merges, reorders, rotates, deletes, extracts and
// splits in one view; it is listed under that plainer name.
const MULTI_TOOL_ENTRY = `        href: import.meta.env.BASE_URL + 'pdf-multi-tool.html',
        name: 'PDF Multi Tool',
        icon: 'ph-pencil-ruler',
        subtitle:
          'Merge, Split, Organize, Delete, Rotate, Add Blank Pages, Extract and Duplicate in a unified interface.',
`;
const PAGES_ENTRY = `        href: import.meta.env.BASE_URL + 'pdf-multi-tool.html',
        name: 'Pages',
        icon: 'ph-squares-four',
        subtitle: 'Merge, reorder, rotate, delete, extract and split in one view.',
`;

// Tools added to match iLovePDF's list (written for Paperhaus from its own spec, see
// kit/PROVENANCE.md): PDF to PowerPoint, HTML to PDF, Redact PDF, Summarize PDF and
// Translate PDF. HTML to PDF fetches pages through functions/api/fetch.js.
const entry = (page, name, icon, subtitle) => `      {
        href: import.meta.env.BASE_URL + '${page}.html',
        name: '${name}',
        icon: '${icon}',
        subtitle: '${subtitle}',
      },
`;
const categoryAnchor = (name) => `    name: '${name}',\n    tools: [\n`;
const MORE_TOOL = {
  name: 'PowerPoint, HTML, Redact, Summarize, Translate',
  dir: join(KIT, 'tools', 'more'),
  pages: ['pdf-to-powerpoint', 'html-to-pdf', 'redact-pdf', 'summarize-pdf', 'translate-pdf'],
  files: [
    ['pdf-to-powerpoint.html', 'src/pages/pdf-to-powerpoint.html'],
    ['html-to-pdf.html', 'src/pages/html-to-pdf.html'],
    ['redact-pdf.html', 'src/pages/redact-pdf.html'],
    ['summarize-pdf.html', 'src/pages/summarize-pdf.html'],
    ['translate-pdf.html', 'src/pages/translate-pdf.html'],
    ['more-common.ts', 'src/js/logic/kit-more/more-common.ts'],
    ['more.css', 'src/js/logic/kit-more/more.css'],
    ['pptx-page.ts', 'src/js/logic/kit-more/pptx-page.ts'],
    ['html-page.ts', 'src/js/logic/kit-more/html-page.ts'],
    ['redact-page.ts', 'src/js/logic/kit-more/redact-page.ts'],
    ['summarize-page.ts', 'src/js/logic/kit-more/summarize-page.ts'],
    ['translate-page.ts', 'src/js/logic/kit-more/translate-page.ts'],
  ],
  // [where, what]: each entry goes first in that existing category.
  inserts: [
    ['Popular Tools', entry('redact-pdf', 'Redact PDF', 'ph-eraser', 'Black out words, numbers and areas for good.')],
    ['Convert from PDF', entry('pdf-to-powerpoint', 'PDF to PowerPoint', 'ph-presentation-chart', 'Each page as a slide, with editable text or as pictures.')],
    ['Convert to PDF', entry('html-to-pdf', 'HTML to PDF', 'ph-file-html', 'Turn a web page or an HTML file into a PDF.')],
    ['Secure PDF', entry('redact-pdf', 'Redact PDF', 'ph-eraser', 'Find and black out names, emails, numbers and areas for good.')],
  ],
  // A category of its own, before Edit & Annotate.
  category: `  {
    name: 'AI on this device',
    tools: [
${entry('summarize-pdf', 'Summarize PDF', 'ph-sparkle', 'Key points of a PDF, written by the AI built into Chrome.')}${entry('translate-pdf', 'Translate PDF', 'ph-translate', 'Translate a PDF and keep its layout, right in Chrome.')}    ],
  },
`,
  // npm packages the tools need that BentoPDF does not ship (installed without saving).
  packages: ['pptxgenjs@3.12.0'],
};

const VITE_CONFIG = join(ROOT, 'vite.config.ts');
const TOOLS_CONFIG = join(ROOT, 'src/js/config/tools.ts');
const VITE_ANCHOR = '          // Tool Pages\n';
const POPULAR_ANCHOR = "    name: 'Popular Tools',\n    tools: [\n";
const CATEGORY_ANCHOR = "  {\n    name: 'Edit & Annotate',";
const KIT_TOOLS = [
  { ...SCAN_TOOL, name: 'Scan', pages: [SCAN_TOOL.page] },
  ESIGN_TOOL,
  MORE_TOOL,
];
const KIT_LOGIC_DIRS = ['src/js/logic/kit-scan', 'src/js/logic/kit-esign', 'src/js/logic/kit-more'];

function installKitTools() {
  const vite = readFileSync(VITE_CONFIG, 'utf8');
  const tools = readFileSync(TOOLS_CONFIG, 'utf8');
  const undo = () => {
    writeFileSync(VITE_CONFIG, vite);
    writeFileSync(TOOLS_CONFIG, tools);
    for (const tool of KIT_TOOLS) for (const [, dest] of tool.files) rmSync(join(ROOT, dest), { force: true });
    for (const d of KIT_LOGIC_DIRS) rmSync(join(ROOT, d), { recursive: true, force: true });
  };
  if (vite.includes('[phase0-kit]') || tools.includes('[phase0-kit]')) {
    fail('vite.config.ts or tools.ts still holds changes from an interrupted build. Restore them with: git checkout -- vite.config.ts src/js/config/tools.ts');
  }
  for (const [anchor, src, what] of [
    [VITE_ANCHOR, vite, 'vite.config.ts'],
    [POPULAR_ANCHOR, tools, 'src/js/config/tools.ts'],
    [CATEGORY_ANCHOR, tools, 'src/js/config/tools.ts'],
    [SIGN_PDF_ENTRY, tools, 'src/js/config/tools.ts (Sign PDF entry)'],
    [MULTI_TOOL_ENTRY, tools, 'src/js/config/tools.ts (PDF Multi Tool entry)'],
    ...MORE_TOOL.inserts.map(([cat]) => [categoryAnchor(cat), tools, `src/js/config/tools.ts (${cat} category)`]),
  ]) {
    if (!src.includes(anchor)) fail(`BentoPDF changed ${what}, so the kit cannot add its tools. Update the anchors in kit/build.mjs (installKitTools).`);
  }
  for (const tool of KIT_TOOLS) {
    for (const page of tool.pages) {
      if (existsSync(join(ROOT, 'src/pages', `${page}.html`))) {
        fail(`BentoPDF now has its own src/pages/${page}.html. Rename the kit's ${tool.name} page in kit/build.mjs.`);
      }
    }
  }

  for (const tool of KIT_TOOLS) {
    for (const [from, dest] of tool.files) {
      mkdirSync(dirname(join(ROOT, dest)), { recursive: true });
      copyFileSync(join(tool.dir, from), join(ROOT, dest));
    }
  }
  const inputs = KIT_TOOLS.flatMap((t) => t.pages)
    .map((page) => `          '${page}': resolve(__dirname, 'src/pages/${page}.html'),\n`)
    .join('');
  writeFileSync(VITE_CONFIG, vite.replace(VITE_ANCHOR,
    `${VITE_ANCHOR}          // [phase0-kit] Paperhaus tools (temporary)\n${inputs}`));
  let next = tools
    .replace(POPULAR_ANCHOR, `${POPULAR_ANCHOR}      // [phase0-kit]\n${SCAN_TOOL.popular}`)
    .replace(CATEGORY_ANCHOR, `  // [phase0-kit]\n${SCAN_TOOL.category}${MORE_TOOL.category}${CATEGORY_ANCHOR}`)
    .replaceAll(SIGN_PDF_ENTRY, `      // [phase0-kit]\n${ESIGN_TOOL.replacesSignPdf}`)
    .replaceAll(MULTI_TOOL_ENTRY, PAGES_ENTRY);
  for (const [cat, item] of MORE_TOOL.inserts) {
    const a = categoryAnchor(cat);
    // In Popular Tools, Scan stays first.
    if (cat === 'Popular Tools') next = next.replace(SCAN_TOOL.popular, `${SCAN_TOOL.popular}${item}`);
    else next = next.replace(a, `${a}      // [phase0-kit]\n${item}`);
  }
  writeFileSync(TOOLS_CONFIG, next);
  ensureKitPackages();
  log(`Added the Paperhaus tools (temporary): ${KIT_TOOLS.map((t) => t.name).join(', ')}.`);
  return undo;
}

/** Install the extra npm packages the kit's tools import, without touching package.json. */
function ensureKitPackages() {
  const missing = KIT_TOOLS.flatMap((t) => t.packages || []).filter((spec) => {
    const name = spec.replace(/@[^@/]+$/, '');
    return !existsSync(join(ROOT, 'node_modules', name, 'package.json'));
  });
  if (!missing.length) return;
  log(`Installing for the Paperhaus tools: ${missing.join(', ')}`);
  run('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--ignore-scripts', ...missing]);
}

function installKitToolAssets(target) {
  const worker = join(DIST, SCAN_WORKER_URL.replace(/^\//, ''));
  mkdirSync(dirname(worker), { recursive: true });
  copyFileSync(join(SCAN_TOOL.dir, 'scan-worker.js'), worker);
  const cv = extract(npmPack(OPENCV_PACKAGE));
  const cvDir = target(dirname(OPENCV_URL));
  mkdirSync(cvDir, { recursive: true });
  copyFileSync(join(cv, 'dist', 'opencv.js'), join(cvDir, 'opencv.js'));
  copyFileSync(join(cv, 'LICENSE'), join(cvDir, 'LICENSE'));
}

// ---------------------------------------------------------------- post-build

function splitLargeFiles() {
  for (const { path, size } of walk(DIST)) {
    if (size <= MAX_FILE_BYTES) continue;
    const name = basename(path);
    const parts = [];
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(PART_BYTES);
      for (let i = 0, offset = 0; offset < size; i++, offset += PART_BYTES) {
        const n = readSync(fd, buf, 0, PART_BYTES, offset);
        const partName = `${name}.part${i}.gz`;
        writeFileSync(join(dirname(path), partName), buf.subarray(0, n));
        parts.push(partName);
      }
    } finally {
      closeSync(fd);
    }
    writeFileSync(`${path}.parts.json`, JSON.stringify({ parts, bytes: size }));
    rmSync(path);
    log(`Split ${relative(DIST, path)} (${(size / 1048576).toFixed(1)} MB) into ${parts.length} parts.`);
  }
}

function writeHeaders() {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' blob: data:",
    "media-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-src 'self' blob:",
    "frame-ancestors 'self'",
    "form-action 'self'",
  ].join('; ');

  const rules = [
    ['/*', {
      'Content-Security-Policy': csp,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Frame-Options': 'SAMEORIGIN',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // camera=(self): the Scan tool uses the camera, on this site only.
      'Permissions-Policy': 'geolocation=(), camera=(self), microphone=(), payment=(), usb=(), interest-cohort=()',
      'X-Robots-Tag': 'noindex, nofollow',
    }],
    ['/wasm/*', { 'Cache-Control': 'public, max-age=31536000, immutable' }],
    ['/assets/*', { 'Cache-Control': 'public, max-age=31536000, immutable' }],
    ['/libreoffice-wasm/*', { 'Cache-Control': 'public, max-age=604800' }],
    ['/sw.js', { 'Cache-Control': 'no-cache' }],
  ];

  let text = '# Generated by kit/build.mjs. Edit there, not here.\n';
  for (const [path, headers] of rules) {
    text += `${path}\n`;
    for (const [k, v] of Object.entries(headers)) {
      if (v.length > 2000) fail(`Header ${k} is over Cloudflare's 2,000-character limit.`);
      text += `  ${k}: ${v}\n`;
    }
    text += '\n';
  }
  writeFileSync(join(DIST, '_headers'), text);
  writeFileSync(join(DIST, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  // Only the e-sign API runs as a Pages Function. Every other request is served as a
  // plain file, so it never counts toward the free plan's daily Functions requests.
  writeFileSync(join(DIST, '_routes.json'), JSON.stringify({ version: 1, include: ['/api/*'], exclude: [] }, null, 2) + '\n');
}

// The Paperhaus look. kit/theme/base.css is the shared engine; each direction in
// kit/theme/<name>/ adds theme.css (tokens and signature touches) and logo.svg.
// The two are joined into one stylesheet and linked into every page after
// BentoPDF's own styles. Embedded viewers and engines are left alone.
const THEME_SKIP = new Set(['wasm', 'libreoffice-wasm', 'pdfjs-viewer', 'pdfjs-annotation-viewer', 'kit-theme']);
const THEME_MARK = 'data-paperhaus-theme';
const DEFAULT_THEME = 'soft';

function themeName(env) {
  return (env.THEME || DEFAULT_THEME).trim();
}

// The logo: BRAND_LOGO if set, otherwise the current direction's mark.
function resolveLogo(env) {
  if (env.BRAND_LOGO) {
    const custom = join(ROOT, env.BRAND_LOGO);
    if (!existsSync(custom)) fail(`Logo not found: ${env.BRAND_LOGO}`);
    return custom;
  }
  return join(BRAND, 'paperhaus-mark.svg');
}

// The Paperhaus brand kit: logo mark, favicon, app icon and wordmark files.
const BRAND = join(KIT, 'brand');

// Logo in the header and footer, browser-tab icon, and the pinned-app icons.
function brandAssets(env, bg) {
  if (!existsSync(join(DIST, 'images'))) return;
  const logo = resolveLogo(env);
  if (extname(logo) === '.svg') copyFileSync(logo, join(DIST, 'images', 'brand-logo.svg'));
  // A custom BRAND_LOGO also becomes the tab icon; otherwise the brand favicon is used.
  copyFileSync(env.BRAND_LOGO && extname(logo) === '.svg' ? logo : join(BRAND, 'paperhaus-favicon.svg'), join(DIST, 'images', 'favicon.svg'));
  brandWebApp(env, bg);
}

const escapeHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// *word* in kit.env copy becomes the italic accent word.
const withEm = (t) => escapeHtml(t).replace(/\*([^*]+)\*/g, '<em>$1</em>');

// The home page: start from the file (drop zone and suggestions), eight tasks, recent
// files and pinned tools, written into BentoPDF's header block. kit/tools/pin/home.js
// makes it work; the full tool list stays below it under "All tools".
const HOME_TASKS = [
  ['request-signatures.html', 'ph-signature', 'Sign', 'Sign yourself, or send to others to sign. Sealed and recorded.'],
  ['#edit', 'ph-pencil-simple-line', 'Edit', 'Text, images, notes, highlights and form fields.'],
  ['pdf-multi-tool.html', 'ph-squares-four', 'Pages', 'Merge, reorder, rotate, delete, extract and split.'],
  ['#convert', 'ph-arrows-left-right', 'Convert', 'To and from PDF. Word, Excel, PowerPoint, images, web pages.'],
  ['compress-pdf.html', 'ph-arrows-in', 'Compress', 'Make files smaller for email, with a quality you choose.'],
  ['#secure', 'ph-shield-check', 'Secure and redact', 'Passwords, permissions, black out details, remove hidden data.'],
  ['scan-document.html', 'ph-scan', 'Scan', 'Use your phone camera. Pages are cropped and straightened.'],
  ['#ai', 'ph-sparkle', 'AI on this device', 'Summarize, translate, find text in scans. Nothing is uploaded.'],
];

function homeMarkup(env) {
  const eyebrow = escapeHtml((env.BRAND_NAME || 'paperhaus').toLowerCase());
  const title = withEm(env.HOME_TITLE || 'What are we *working on?*');
  const note = escapeHtml(env.HOME_NOTE || 'Nothing is uploaded or stored');
  const tasks = HOME_TASKS.map(([href, icon, name, sub], i) =>
    `<a class="ph-task" href="${href}" style="--c:var(--c${(i % 6) + 1});--i:var(--i${(i % 6) + 1})">` +
    `<span class="ph-task-icon"><i class="ph ${icon}" aria-hidden="true"></i></span>` +
    `<span class="ph-task-name">${escapeHtml(name)}</span><span class="ph-task-sub">${escapeHtml(sub)}</span></a>`).join('');
  return '<!--ph-header-->' +
    // BentoPDF's script rewrites the header's first h2 and first p (simple mode); these
    // hidden two take that, so the real headings keep their words.
    '<h2 hidden></h2><p hidden></p>' +
    `<section id="ph-home" class="ph-home">` +
    `<div class="ph-eyebrow">${eyebrow}</div><h1 class="ph-title">${title}</h1>` +
    `<div id="ph-drop" class="ph-drop">` +
    `<i class="ph ph-upload-simple ph-drop-icon" aria-hidden="true"></i>` +
    `<div class="ph-drop-title">Drop any file here</div>` +
    `<div class="ph-drop-sub">PDF, Word, Excel, PowerPoint or photos. Paperhaus suggests what to do with it.</div>` +
    `<div class="ph-drop-actions"><button type="button" id="ph-choose" class="ph-btn ph-btn-main"><i class="ph ph-folder-open" aria-hidden="true"></i> Choose a file</button>` +
    `<a href="scan-document.html" class="ph-btn"><i class="ph ph-scan" aria-hidden="true"></i> Scan with camera</a></div>` +
    `<form id="ph-url" class="ph-url"><i class="ph ph-globe-simple" aria-hidden="true"></i><input type="url" inputmode="url" placeholder="Paste a web page link" aria-label="Web page link to make a PDF"><button type="submit" class="ph-btn">Make PDF</button></form>` +
    `<input type="file" id="ph-file" multiple hidden>` +
    (note ? `<div class="ph-note">${note}</div>` : '') +
    `</div>` +
    `<div id="ph-suggest" class="ph-suggest" hidden></div>` +
    `<div class="ph-sec-head"><h2>Or pick a task</h2><a id="ph-all-link" href="#all-tools">See all tools</a></div>` +
    `<div class="ph-tasks">${tasks}</div>` +
    `<div class="ph-lists">` +
    `<div class="ph-card" id="ph-recent"><div class="ph-card-head"><h2>Recent on this device</h2><span>Only you see these</span></div><div id="ph-recent-list"></div></div>` +
    `<div class="ph-card" id="ph-pins"><div class="ph-card-head"><h2>Pinned tools</h2><span>Star a tool to pin it</span></div><div id="ph-pins-list" class="ph-pins-list"></div>` +
    `<p class="ph-card-foot">Everything you open, convert or sign is processed in this browser. Signing requests are encrypted before they leave it.</p></div>` +
    `</div></section>` +
    `<div id="ph-hubbar" class="ph-hubbar" hidden><button type="button" id="ph-hub-back" class="ph-linkbtn"><i class="ph ph-arrow-left" aria-hidden="true"></i> Home</button><h2></h2><p></p></div>` +
    `<h2 id="all-tools" class="ph-all-title">All tools</h2>` +
    `<nav class="ph-tabbar" aria-label="Quick actions">` +
    `<a href="/" aria-current="page"><i class="ph ph-house" aria-hidden="true"></i>Home</a>` +
    `<a href="scan-document.html"><i class="ph ph-scan" aria-hidden="true"></i>Scan</a>` +
    `<a href="request-signatures.html"><i class="ph ph-signature" aria-hidden="true"></i>Sign</a>` +
    `<a href="#all-tools"><i class="ph ph-squares-four" aria-hidden="true"></i>Tools</a>` +
    `<a href="#ph-recent"><i class="ph ph-clock-counter-clockwise" aria-hidden="true"></i>Recent</a></nav>` +
    '<!--/ph-header-->';
}

function rewriteHomeHeader(env) {
  const file = join(DIST, 'index.html');
  if (!existsSync(file)) return;
  const html = readFileSync(file, 'utf8');
  // First run: BentoPDF's header holds only a heading and a paragraph. Later runs
  // (--theme-only) replace the block between the Paperhaus markers instead.
  const marked = /<!--ph-header-->[\s\S]*?<!--\/ph-header-->/;
  const original = /(<div id="tools-header"[^>]*>)([\s\S]*?)(<\/div>)/;
  if (!marked.test(html) && !original.test(html)) {
    log('WARNING: could not find the home page header; leaving BentoPDF\'s heading in place.');
    return;
  }
  const inner = homeMarkup(env);
  // Function replacements, so a $ in the copy is never read as a pattern.
  const out = marked.test(html) ? html.replace(marked, () => inner) : html.replace(original, (m, open, body, close) => open + inner + close);
  writeFileSync(file, out);
}

function applyTheme(env) {
  const name = themeName(env);
  if (name === 'none') {
    log('THEME=none: keeping BentoPDF\'s default look.');
    brandAssets(env, '#fbf1e4');
    return;
  }
  const dir = join(KIT, 'theme', name);
  if (!existsSync(join(dir, 'theme.css'))) {
    const options = readdirSync(join(KIT, 'theme')).filter((d) => existsSync(join(KIT, 'theme', d, 'theme.css')));
    fail(`Theme "${name}" not found. Options: ${options.join(', ')}, or none.`);
  }
  const css = readFileSync(join(KIT, 'theme', 'base.css'), 'utf8') + '\n' + readFileSync(join(dir, 'theme.css'), 'utf8');

  const out = join(DIST, 'kit-theme');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(KIT, 'theme', 'fonts'), join(out, 'fonts'), { recursive: true });
  writeFileSync(join(out, 'paperhaus.css'), css);

  // Browser chrome colour: the direction's light and dark backgrounds.
  const bgs = [...css.matchAll(/--bg:\s*(#[0-9a-fA-F]{3,8})/g)].map((m) => m[1]);
  const light = bgs.at(-2) || bgs.at(0) || '#ffffff';
  const dark = bgs.at(-1) || light;

  // Cache-bust with a content hash so a restyle shows up immediately.
  let hash = 0;
  for (let i = 0; i < css.length; i++) hash = (hash * 31 + css.charCodeAt(i)) >>> 0;
  const tags = `<link rel="stylesheet" href="/kit-theme/paperhaus.css?v=${hash.toString(36)}" ${THEME_MARK}>` +
    `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${light}" ${THEME_MARK}>` +
    `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${dark}" ${THEME_MARK}>`;
  const strip = new RegExp(`<(?:link|meta)[^>]*${THEME_MARK}[^>]*>`, 'g');

  let pages = 0;
  const visit = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) {
        if (!THEME_SKIP.has(entry)) visit(p);
      } else if (entry.endsWith('.html')) {
        const html = readFileSync(p, 'utf8');
        if (!html.includes('</head>')) continue;
        writeFileSync(p, brandTitles(html.replace(strip, ''), env.BRAND_NAME).replace('</head>', `${tags}</head>`));
        pages++;
      }
    }
  };
  visit(DIST);
  rewriteHomeHeader(env);

  brandAssets(env, light);
  log(`Applied the "${name}" design to ${pages} pages.`);
}

// ---------------------------------------------------------------- pinning
// Paperhaus is pinned from the browser like an app (no app store). Every page gets the
// web app manifest (fetched with the sign-in cookie, so Cloudflare Access lets it through),
// the iPhone home screen tags, and the Pin button and account chip from kit/tools/pin/.
const PIN_MARK = 'data-paperhaus-pin';

function addPinning(env) {
  const out = join(DIST, 'kit-tools', 'pin');
  mkdirSync(out, { recursive: true });
  let hash = 0;
  for (const f of ['pin.js', 'pin.css', 'flow.js', 'flow.css', 'home.js', 'home.css']) {
    const text = readFileSync(join(KIT, 'tools', 'pin', f), 'utf8');
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    writeFileSync(join(out, f), text);
  }
  const v = hash.toString(36);
  const brand = escapeHtml(env.BRAND_NAME);
  // The public Paperhaus website, linked from the account menu. Only http(s) addresses.
  const siteUrl = /^https?:\/\/[^\s"<>]+$/i.test(env.SITE_URL || '') ? env.SITE_URL.replace(/\/+$/, '') : '';
  // The fork's source code (AGPL offer), linked from the account menu.
  const sourceUrl = /^https?:\/\/[^\s"<>]+$/i.test(env.SOURCE_URL || '') && !env.SOURCE_URL.includes('YOUR-GITHUB-USERNAME') ? env.SOURCE_URL : '';
  const tags =
    `<link rel="manifest" href="/site.webmanifest" crossorigin="use-credentials" ${PIN_MARK}>` +
    `<link rel="apple-touch-icon" sizes="180x180" href="/images/apple-touch-icon.png" ${PIN_MARK}>` +
    `<meta name="mobile-web-app-capable" content="yes" ${PIN_MARK}>` +
    `<meta name="apple-mobile-web-app-capable" content="yes" ${PIN_MARK}>` +
    `<meta name="apple-mobile-web-app-title" content="${brand}" ${PIN_MARK}>` +
    `<meta name="apple-mobile-web-app-status-bar-style" content="default" ${PIN_MARK}>` +
    (siteUrl ? `<meta name="paperhaus-site" content="${escapeHtml(siteUrl)}" ${PIN_MARK}>` : '') +
    (sourceUrl ? `<meta name="paperhaus-source" content="${escapeHtml(sourceUrl)}" ${PIN_MARK}>` : '') +
    `<link rel="stylesheet" href="/kit-tools/pin/pin.css?v=${v}" ${PIN_MARK}>` +
    `<link rel="stylesheet" href="/kit-tools/pin/flow.css?v=${v}" ${PIN_MARK}>` +
    // flow.js first: it has to see the blob links tools make for their downloads.
    `<script src="/kit-tools/pin/flow.js?v=${v}" defer ${PIN_MARK}></script>` +
    `<script src="/kit-tools/pin/pin.js?v=${v}" defer ${PIN_MARK}></script>`;
  const homeTags =
    `<link rel="stylesheet" href="/kit-tools/pin/home.css?v=${v}" ${PIN_MARK}>` +
    `<script src="/kit-tools/pin/home.js?v=${v}" defer ${PIN_MARK}></script>`;
  // BentoPDF's own versions of these tags, and ours from an earlier run, are replaced.
  const strip = [
    new RegExp(`<script[^>]*${PIN_MARK}[^>]*></script>`, 'g'),
    new RegExp(`<(?:link|meta)[^>]*${PIN_MARK}[^>]*>`, 'g'),
    /<link\s+rel="(?:manifest|apple-touch-icon)"[^>]*>/g,
    /<meta\s+name="(?:apple-)?mobile-web-app-(?:capable|title|status-bar-style)"[^>]*>/g,
  ];
  let pages = 0;
  const visit = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) {
        if (!THEME_SKIP.has(entry) && entry !== 'kit-tools') visit(p);
      } else if (entry.endsWith('.html')) {
        let html = readFileSync(p, 'utf8');
        if (!html.includes('</head>')) continue;
        // Public pages (the signing page) have no account, so no account chip or pinning.
        if (html.includes('name="paperhaus-public"')) continue;
        for (const re of strip) html = html.replace(re, '');
        const isHome = p === join(DIST, 'index.html');
        writeFileSync(p, html.replace('</head>', `${tags}${isHome ? homeTags : ''}</head>`));
        pages++;
      }
    }
  };
  visit(DIST);
  log(`Added pinning and the account chip to ${pages} pages.`);
}

// Browser tab titles and share previews say your brand instead of BentoPDF.
// (The footer keeps the BentoPDF credit and source link, as AGPL-3.0 asks.)
function brandTitles(html, brand) {
  const swap = (text) => text.replace(/BentoPDF/g, brand);
  return html
    .replace(/<title>[\s\S]*?<\/title>/, swap)
    .replace(/<meta\s+(?:name|property)="(?:title|og:title|og:site_name|twitter:title|apple-mobile-web-app-title)"\s+content="[^"]*"/g, swap);
}

// The installable app (Add to Home Screen): Paperhaus name, the design's icons, and a
// Scan shortcut on the app icon. Icons come from kit/brand/icons/.
function brandWebApp(env, bg) {
  const icons = join(BRAND, 'icons');
  if (existsSync(icons) && existsSync(join(DIST, 'images'))) {
    for (const f of ['favicon-192x192.png', 'favicon-512x512.png', 'maskable-512x512.png', 'apple-touch-icon.png']) {
      copyFileSync(join(icons, f), join(DIST, 'images', f));
    }
    copyFileSync(join(icons, 'favicon.ico'), join(DIST, 'favicon.ico'));
  }
  const file = join(DIST, 'site.webmanifest');
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* write a fresh one */
  }
  Object.assign(manifest, {
    id: '/',
    name: env.BRAND_NAME,
    short_name: env.BRAND_NAME,
    description: 'Private document tools that run in your browser. Nothing is uploaded or stored.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // Opening the pinned app again brings back the window you already have.
    launch_handler: { client_mode: ['focus-existing', 'auto'] },
    background_color: bg,
    theme_color: bg,
    icons: [
      { src: '/images/favicon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/images/favicon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/images/maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/images/apple-touch-icon.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
    ],
    // Press and hold (phone) or right-click (computer) the pinned icon for these.
    shortcuts: [
      ['Scan to PDF', 'Scan', '/scan-document'],
      ['Merge PDF', 'Merge', '/merge-pdf'],
      ['Compress PDF', 'Compress', '/compress-pdf'],
      ['Sign', 'Sign', '/request-signatures'],
    ].map(([name, short_name, url]) => ({
      name,
      short_name,
      url,
      icons: [{ src: '/images/favicon-192x192.png', sizes: '192x192', type: 'image/png' }],
    })),
  });
  delete manifest.orientation;
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
}

function verify(urls) {
  const files = walk(DIST);
  const tooBig = files.filter((f) => f.size > MAX_FILE_BYTES);
  if (tooBig.length) fail(`Files over 25 MiB remain: ${tooBig.map((f) => relative(DIST, f.path)).join(', ')}`);
  if (files.length > MAX_FILES) fail(`${files.length} files is over Cloudflare Pages' ${MAX_FILES}-file limit.`);
  for (const p of [`${urls.pymupdf}`, `${urls.gs}`, `${urls.cpdf}coherentpdf.browser.min.js`, `${urls.ocr}/worker.min.js`]) {
    if (!existsSync(join(DIST, p.replace(/^\//, '')))) fail(`Expected engine file missing: ${p}`);
  }
  const total = files.reduce((a, f) => a + f.size, 0);
  log(`Checks passed: ${files.length} files, ${(total / 1048576).toFixed(0)} MB, largest ${(Math.max(...files.map((f) => f.size)) / 1048576).toFixed(1)} MB.`);
}

// BentoPDF's own build regenerates a few tracked files (blog pages, a partial,
// a header config). Put back any it changed, so a local build leaves nothing
// to commit. Files you had already edited are left alone.
function modifiedTrackedFiles() {
  const res = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0) return null;
  return new Set(res.stdout.split('\n').filter(Boolean).map((l) => l.slice(3)));
}

function restoreBuildByproducts(before) {
  const after = modifiedTrackedFiles();
  if (!before || !after) return;
  const changed = [...after].filter((f) => !before.has(f));
  if (!changed.length) return;
  spawnSync('git', ['checkout', '--', ...changed], { cwd: ROOT });
  log(`Restored ${changed.length} file(s) BentoPDF's build regenerated: ${changed.join(', ')}`);
}

// ---------------------------------------------------------------- main

const env = loadKitEnv();

// node kit/build.mjs --theme-only : restyle an existing dist/ in a few seconds,
// handy while adjusting a design in kit/theme/<name>/theme.css.
if (process.argv.includes('--theme-only')) {
  if (!existsSync(DIST)) fail('No dist/ folder yet. Run a full build first: node kit/build.mjs');
  applyTheme(env);
  addPinning(env);
  process.exit(0);
}

const versions = readVersions();
const urls = engineUrls(versions);

const logoSrc = resolveLogo(env);
const logoPublicPath = `images/brand-logo${extname(logoSrc)}`;
const logoDest = join(ROOT, 'public', logoPublicPath);
const logoExisted = existsSync(logoDest);

// The footer line is FOOTER_TEXT from kit.env, or nothing. (Left empty, BentoPDF would put
// its own copyright line there, so a no-break space stands in.) The AGPL source offer
// lives in the account menu instead: "Source code", linking to SOURCE_URL.
const footer = (env.FOOTER_TEXT || '').trim() || '\u00a0';

const buildEnv = {
  ...process.env,
  SIMPLE_MODE: 'true',
  COMPRESSION_MODE: 'o',
  DISABLE_GITHUB_STARS: 'true',
  DISABLE_TOOLS: env.DISABLE_TOOLS || '',
  VITE_BRAND_NAME: env.BRAND_NAME,
  VITE_BRAND_LOGO: logoPublicPath,
  VITE_FOOTER_TEXT: footer,
  VITE_DEFAULT_LANGUAGE: env.DEFAULT_LANGUAGE || 'en',
  VITE_WASM_PYMUPDF_URL: urls.pymupdf,
  VITE_WASM_GS_URL: urls.gs,
  VITE_WASM_CPDF_URL: urls.cpdf,
  VITE_TESSERACT_WORKER_URL: `${urls.ocr}/worker.min.js`,
  VITE_TESSERACT_CORE_URL: `${urls.ocr}/core`,
  VITE_TESSERACT_LANG_URL: `${urls.ocr}/lang-data`,
  VITE_TESSERACT_AVAILABLE_LANGUAGES: env.OCR_LANGUAGES.join(','),
  VITE_OCR_FONT_BASE_URL: `${urls.ocr}/fonts`,
  VITE_CORS_PROXY_URL: '',
  VITE_OPENCV_URL: OPENCV_URL,
  VITE_SCAN_WORKER_URL: SCAN_WORKER_URL,
};

log(`Building "${env.BRAND_NAME}" on BentoPDF ${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version}`);
const trackedBefore = modifiedTrackedFiles();
let originalLoader = null;
let removeKitTools = () => {};
try {
  originalLoader = patchLoader();
  removeKitTools = installKitTools();
  copyFileSync(logoSrc, logoDest);
  rmSync(DIST, { recursive: true, force: true });
  run('npm', ['run', 'build'], { env: buildEnv });
} finally {
  if (originalLoader !== null) writeFileSync(LOADER, originalLoader);
  removeKitTools();
  if (!logoExisted) rmSync(logoDest, { force: true });
  log('Reverted temporary source changes.');
  restoreBuildByproducts(trackedBefore);
}

fetchEngines(versions, env, urls);
splitLargeFiles();
applyTheme(env);
addPinning(env);
writeHeaders();
verify(urls);
log('Done. Deploy the dist/ folder.');
