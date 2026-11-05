/**
 * Paperhaus: Request Signatures (the sender's side).
 *
 * Choose a PDF, add signers, place their fields, and create one private signing link per
 * signer. The links are emailed from the sender's own account (Gmail or Outlook compose,
 * or their email app); Paperhaus never sends email itself. The PDF and the field layout
 * are encrypted here before upload, and the key lives only in the links and in this
 * browser's list of sent requests.
 */
import './esign.css';
import { showAlert } from '../../ui.js';
import {
  type Envelope,
  type Field,
  type FieldType,
  type PdfDoc,
  type State,
  type Submission,
  ApiError,
  FIELD_LABELS,
  SIGNER_COLORS,
  api,
  b64url,
  buildSignedPdf,
  decrypt,
  decryptJson,
  downloadBytes,
  encrypt,
  escapeHtml,
  formatDate,
  fromB64,
  openPdf,
  randomToken,
  renderPages,
  sha256hex,
  signLink,
  signedName,
} from './esign-common.js';

interface Draft {
  file: File | null;
  bytes: Uint8Array | null;
  pdf: PdfDoc | null;
  pages: number;
  signers: { name: string; email: string }[];
  fields: Field[];
}

interface Sent {
  id: string;
  key: string;
  senderToken: string;
  readToken: string;
  tokens: string[];
  title: string;
  from: string;
  fromName: string;
  message: string;
  signers: { name: string; email: string }[];
  createdAt: number;
  expires: number;
  ordered: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const draft: Draft = { file: null, bytes: null, pdf: null, pages: 0, signers: [], fields: [] };
const ui = { who: 0, tool: null as FieldType | null, selected: '' };
let identity = { email: '', name: '' };

// Default box sizes, as fractions of the page width (height follows the page shape).
const SIZES: Record<FieldType, [number, number]> = {
  signature: [0.3, 0.07],
  initials: [0.1, 0.06],
  date: [0.2, 0.035],
  name: [0.26, 0.035],
  text: [0.26, 0.035],
  checkbox: [0.035, 0.035],
};

// ------------------------------------------------------------------ storage (this browser)

const DB = 'paperhaus-esign';
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('sent', { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function saveSent(s: Sent): Promise<void> {
  const d = await db();
  await new Promise<void>((res, rej) => {
    const tx = d.transaction('sent', 'readwrite');
    tx.objectStore('sent').put(s);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function deleteSent(id: string): Promise<void> {
  const d = await db();
  await new Promise<void>((res) => {
    const tx = d.transaction('sent', 'readwrite');
    tx.objectStore('sent').delete(id);
    tx.oncomplete = () => res();
  });
}
async function listSent(): Promise<Sent[]> {
  const d = await db();
  return new Promise((res) => {
    const r = d.transaction('sent').objectStore('sent').getAll();
    r.onsuccess = () => res((r.result as Sent[]).sort((a, b) => b.createdAt - a.createdAt));
    r.onerror = () => res([]);
  });
}

const prefs = {
  get(k: string): string {
    try {
      return localStorage.getItem(`paperhaus-esign-${k}`) || '';
    } catch {
      return '';
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(`paperhaus-esign-${k}`, v);
    } catch {
      /* ignore */
    }
  },
};

// ------------------------------------------------------------------ small UI helpers

function busy(text: string | null): void {
  $('es-busy').classList.toggle('hidden', text === null);
  if (text) $('es-busy-text').textContent = text;
}
let toastTimer = 0;
function toast(text: string): void {
  const t = $('es-toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.add('hidden'), 2600);
}
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied');
  } catch {
    window.prompt('Copy this link:', text);
  }
}
const uid = () => Math.random().toString(36).slice(2, 10);
const validEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

// ------------------------------------------------------------------ document

async function loadFile(file: File): Promise<void> {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    showAlert('Not a PDF', 'Choose a PDF file.');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showAlert('PDF too large', 'Signing requests can be up to 20 MB. Try Compress PDF first.');
    return;
  }
  busy('Opening the PDF...');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await openPdf(bytes);
    draft.file = file;
    draft.bytes = bytes;
    draft.pdf = pdf;
    draft.pages = pdf.numPages;
    draft.fields = [];
    $('es-drop').classList.add('hidden');
    $('es-doc').classList.remove('hidden');
    $('es-doc-name').textContent = file.name;
    $('es-doc-info').textContent = `${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}`;
    const title = $<HTMLInputElement>('es-title');
    if (!title.value) title.value = file.name.replace(/\.pdf$/i, '');
    await drawPages();
  } catch (err) {
    console.error(err);
    showAlert('Could not open this PDF', 'It may be damaged or password protected. Unlock it first, then try again.');
  } finally {
    busy(null);
  }
}

async function drawPages(): Promise<void> {
  if (!draft.pdf) return;
  const boxes = await renderPages(draft.pdf, $('es-pages'));
  boxes.forEach((box) => box.addEventListener('pointerdown', (e) => placeField(e, box)));
  renderFields();
}

// ------------------------------------------------------------------ signers

function renderSigners(): void {
  const host = $('es-signers');
  host.textContent = '';
  draft.signers.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'es-signer';
    row.innerHTML = `
      <span class="es-order"><span class="es-dot" style="display:inline-block;background:${SIGNER_COLORS[i % SIGNER_COLORS.length]}"></span></span>
      <input class="es-input es-signer-name" type="text" placeholder="Full name" maxlength="80" />
      <input class="es-input es-signer-email" type="email" placeholder="Email" maxlength="120" />
      <button class="es-btn es-small es-danger" type="button" aria-label="Remove signer"><i class="ph ph-trash"></i></button>`;
    const [name, email] = row.querySelectorAll('input');
    name.value = s.name;
    email.value = s.email;
    name.addEventListener('input', () => {
      s.name = name.value;
      renderWhos();
      renderFields();
    });
    email.addEventListener('input', () => (s.email = email.value.trim()));
    row.querySelector('button')!.addEventListener('click', () => removeSigner(i));
    host.appendChild(row);
  });
  if (!draft.signers.length) host.innerHTML = '<p class="es-sub" style="margin-bottom:0.6rem">Add at least one signer.</p>';
  renderWhos();
}

function addSigner(name = '', email = ''): void {
  if (draft.signers.length >= 10) {
    showAlert('Up to 10 signers', 'A signing request can have up to 10 signers.');
    return;
  }
  draft.signers.push({ name, email });
  ui.who = draft.signers.length - 1;
  renderSigners();
}

function removeSigner(i: number): void {
  draft.signers.splice(i, 1);
  draft.fields = draft.fields.filter((f) => f.signer !== i).map((f) => (f.signer > i ? { ...f, signer: f.signer - 1 } : f));
  ui.who = Math.min(ui.who, Math.max(0, draft.signers.length - 1));
  renderSigners();
  renderFields();
}

function renderWhos(): void {
  const host = $('es-whos');
  host.textContent = '';
  draft.signers.forEach((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'es-who' + (i === ui.who ? ' is-on' : '');
    b.style.setProperty('--c', SIGNER_COLORS[i % SIGNER_COLORS.length]);
    b.innerHTML = `<span class="es-dot" style="background:${SIGNER_COLORS[i % SIGNER_COLORS.length]}"></span><span></span>`;
    b.querySelector('span:last-child')!.textContent = s.name.trim() || `Signer ${i + 1}`;
    b.addEventListener('click', () => {
      ui.who = i;
      renderWhos();
    });
    host.appendChild(b);
  });
  if (!draft.signers.length) host.innerHTML = '<span class="es-sub">Add a signer first</span>';
}

// ------------------------------------------------------------------ fields

function setTool(t: FieldType | null): void {
  ui.tool = ui.tool === t ? null : t;
  document.querySelectorAll<HTMLElement>('#es-types .es-tool').forEach((b) => b.classList.toggle('is-on', b.dataset.type === ui.tool));
  $('es-pages').classList.toggle('es-placing', !!ui.tool);
}

function placeField(e: PointerEvent, box: HTMLElement): void {
  if (!ui.tool || (e.target as HTMLElement).closest('.es-field')) return;
  if (!draft.signers.length) {
    showAlert('Add a signer first', 'Each field belongs to a signer. Add one in step 2.');
    return;
  }
  const r = box.getBoundingClientRect();
  const [fw, fh] = SIZES[ui.tool];
  const w = fw;
  const h = (fh * r.width) / r.height;
  const x = Math.min(Math.max((e.clientX - r.left) / r.width - w / 2, 0), 1 - w);
  const y = Math.min(Math.max((e.clientY - r.top) / r.height - h / 2, 0), 1 - h);
  const f: Field = {
    id: uid(),
    page: Number(box.dataset.page),
    x,
    y,
    w,
    h,
    type: ui.tool,
    signer: ui.who,
    required: ui.tool !== 'checkbox',
  };
  draft.fields.push(f);
  ui.selected = f.id;
  renderFields();
}

function renderFields(): void {
  document.querySelectorAll('#es-pages .es-field').forEach((el) => el.remove());
  const boxes = Array.from(document.querySelectorAll<HTMLElement>('#es-pages .es-page'));
  for (const f of draft.fields) {
    const box = boxes[f.page];
    if (!box) continue;
    const el = document.createElement('div');
    el.className = 'es-field es-edit' + (f.id === ui.selected ? ' is-selected' : '');
    el.style.setProperty('--c', SIGNER_COLORS[f.signer % SIGNER_COLORS.length]);
    el.style.left = `${f.x * 100}%`;
    el.style.top = `${f.y * 100}%`;
    el.style.width = `${f.w * 100}%`;
    el.style.height = `${f.h * 100}%`;
    const who = draft.signers[f.signer]?.name.trim().split(/\s+/)[0] || `Signer ${f.signer + 1}`;
    el.innerHTML = `<span class="es-field-label"></span><span class="es-x" role="button" aria-label="Remove field">&times;</span><span class="es-grip"></span>`;
    el.querySelector('.es-field-label')!.textContent = f.type === 'checkbox' ? '' : `${FIELD_LABELS[f.type]} · ${who}`;
    el.title = `${FIELD_LABELS[f.type]} for ${who}`;
    el.querySelector('.es-x')!.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      draft.fields = draft.fields.filter((x) => x.id !== f.id);
      renderFields();
    });
    el.addEventListener('pointerdown', (e) => dragField(e, f, el, box, (e.target as HTMLElement).classList.contains('es-grip')));
    box.appendChild(el);
  }
  updateCreateHint();
}

function dragField(e: PointerEvent, f: Field, el: HTMLElement, box: HTMLElement, resize: boolean): void {
  if ((e.target as HTMLElement).classList.contains('es-x')) return;
  e.preventDefault();
  e.stopPropagation();
  ui.selected = f.id;
  document.querySelectorAll('#es-pages .es-field.is-selected').forEach((x) => x.classList.remove('is-selected'));
  el.classList.add('is-selected');
  const r = box.getBoundingClientRect();
  const sx = e.clientX;
  const sy = e.clientY;
  const start = { ...f };
  el.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    const dx = (ev.clientX - sx) / r.width;
    const dy = (ev.clientY - sy) / r.height;
    if (resize) {
      f.w = Math.min(Math.max(start.w + dx, 0.02), 1 - f.x);
      f.h = Math.min(Math.max(start.h + dy, 0.012), 1 - f.y);
    } else {
      f.x = Math.min(Math.max(start.x + dx, 0), 1 - f.w);
      f.y = Math.min(Math.max(start.y + dy, 0), 1 - f.h);
    }
    el.style.left = `${f.x * 100}%`;
    el.style.top = `${f.y * 100}%`;
    el.style.width = `${f.w * 100}%`;
    el.style.height = `${f.h * 100}%`;
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function updateCreateHint(): void {
  const missing = draft.signers.map((s, i) => ({ s, i })).filter(({ i }) => !draft.fields.some((f) => f.signer === i));
  const hint = $('es-create-hint');
  if (!draft.bytes) hint.textContent = 'Choose a PDF first.';
  else if (!draft.signers.length) hint.textContent = 'Add at least one signer.';
  else if (missing.length) hint.textContent = `No fields yet for ${missing.map(({ s, i }) => s.name || `Signer ${i + 1}`).join(', ')}.`;
  else hint.textContent = `${draft.fields.length} field${draft.fields.length === 1 ? '' : 's'} for ${draft.signers.length} signer${draft.signers.length === 1 ? '' : 's'}.`;
}

// ------------------------------------------------------------------ create

async function create(): Promise<void> {
  const from = $<HTMLInputElement>('es-from').value.trim();
  const fromName = $<HTMLInputElement>('es-from-name').value.trim() || identity.name || from.split('@')[0];
  const title = $<HTMLInputElement>('es-title').value.trim() || draft.file?.name.replace(/\.pdf$/i, '') || 'Document';
  const message = $<HTMLTextAreaElement>('es-message').value.trim();
  const ordered = $<HTMLInputElement>('es-ordered').checked;

  if (!draft.bytes || !draft.file) return showAlert('Choose a PDF', 'Add the document in step 1.');
  if (!draft.signers.length) return showAlert('Add a signer', 'Add at least one signer in step 2.');
  for (const [i, s] of draft.signers.entries()) {
    if (!s.name.trim()) return showAlert('Name needed', `Add a name for signer ${i + 1}.`);
    if (!validEmail(s.email)) return showAlert('Email needed', `Check the email address for ${s.name || `signer ${i + 1}`}.`);
  }
  for (const [i, s] of draft.signers.entries()) {
    if (!draft.fields.some((f) => f.signer === i && (f.type === 'signature' || f.type === 'initials'))) {
      return showAlert('A signature field is missing', `Place at least one Signature or Initials field for ${s.name}.`);
    }
  }
  if (!validEmail(from)) return showAlert('Your email', 'Add the email address you will send the invitations from.');
  prefs.set('from', from);
  prefs.set('from-name', fromName);

  busy('Encrypting and creating links...');
  try {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const tokens = draft.signers.map(() => randomToken());
    const senderToken = randomToken();
    const readToken = randomToken();
    const envelope: Envelope = {
      v: 1,
      title,
      message,
      docName: draft.file.name,
      docSha256: await sha256hex(draft.bytes),
      sender: { name: fromName, email: from },
      ordered,
      createdAt: Date.now(),
      signers: draft.signers.map((s) => ({ name: s.name.trim(), email: s.email.trim() })),
      fields: draft.fields,
      readToken,
    };
    const form = new FormData();
    form.append(
      'meta',
      JSON.stringify({
        signers: draft.signers.length,
        ordered,
        tokens: await Promise.all(tokens.map((t) => sha256hex(t))),
        senderToken: await sha256hex(senderToken),
        readToken: await sha256hex(readToken),
      })
    );
    form.append('doc', new Blob([(await encrypt(key, draft.bytes)) as BlobPart]), 'doc');
    form.append('env', new Blob([(await encrypt(key, JSON.stringify(envelope))) as BlobPart]), 'env');
    const res = await api.create(form);
    const sent: Sent = {
      id: res.id,
      key: b64url(key),
      senderToken,
      readToken,
      tokens,
      title,
      from,
      fromName,
      message,
      signers: envelope.signers,
      createdAt: envelope.createdAt,
      expires: res.expires,
      ordered,
    };
    await saveSent(sent);
    showReady(sent);
    void renderSent();
  } catch (err) {
    console.error(err);
    const e = err as ApiError;
    if (e.status === 401) showAlert('Please sign in again', 'Your Paperhaus sign-in has ended. Reload the page and sign in.');
    else if (e.status === 503) showAlert('E-sign is not set up yet', 'The storage for signing requests is not connected. See "Request Signatures" in kit/README.md.');
    else showAlert('Could not create the links', String(e.message || err));
  } finally {
    busy(null);
  }
}

// ------------------------------------------------------------------ emailing (from the sender's own account)

function mail(s: Sent, i: number): { to: string; subject: string; body: string } {
  const signer = s.signers[i];
  const link = signLink(s.id, fromB64(s.key), s.tokens[i]);
  const first = signer.name.split(/\s+/)[0];
  const lines = [
    `Hi ${first},`,
    '',
    `Please review and sign "${s.title}".`,
  ];
  if (s.message) lines.push('', s.message);
  lines.push(
    '',
    'Open your signing link:',
    link,
    '',
    `This link is just for you, so please don't forward it. It works until ${formatDate(s.expires)}.`,
    s.ordered ? 'People sign in order, so the link may ask you to wait for someone before you.' : '',
    '',
    s.fromName
  );
  return { to: signer.email, subject: `Please sign: ${s.title}`, body: lines.filter((l, n, a) => !(l === '' && a[n - 1] === '')).join('\n') };
}

function composeLinks(m: { to: string; subject: string; body: string }, from: string): { gmail: string; outlook: string; app: string } {
  const e = encodeURIComponent;
  return {
    gmail: `https://mail.google.com/mail/?view=cm&fs=1&authuser=${e(from)}&to=${e(m.to)}&su=${e(m.subject)}&body=${e(m.body)}`,
    outlook: `https://outlook.office.com/mail/deeplink/compose?to=${e(m.to)}&subject=${e(m.subject)}&body=${e(m.body)}`,
    app: `mailto:${e(m.to)}?subject=${e(m.subject)}&body=${e(m.body)}`,
  };
}

function sendButtons(s: Sent, i: number): HTMLElement {
  const m = mail(s, i);
  const l = composeLinks(m, s.from);
  const wrap = document.createElement('div');
  wrap.className = 'es-row';
  wrap.innerHTML = `
    <a class="es-btn es-small" target="_blank" rel="noopener" href="${escapeHtml(l.gmail)}"><i class="ph ph-google-logo"></i> Gmail</a>
    <a class="es-btn es-small" target="_blank" rel="noopener" href="${escapeHtml(l.outlook)}"><i class="ph ph-microsoft-outlook-logo"></i> Outlook</a>
    <a class="es-btn es-small" href="${escapeHtml(l.app)}"><i class="ph ph-envelope-simple"></i> Email app</a>
    <button class="es-btn es-small" type="button"><i class="ph ph-link"></i> Copy link</button>`;
  wrap.querySelector('button')!.addEventListener('click', () => void copy(signLink(s.id, fromB64(s.key), s.tokens[i])));
  const meEmail = [identity.email, s.from].map((x) => x.toLowerCase());
  if (meEmail.includes(s.signers[i].email.toLowerCase())) {
    const a = document.createElement('a');
    a.className = 'es-btn es-small es-primary';
    a.target = '_blank';
    a.rel = 'noopener';
    a.href = signLink(s.id, fromB64(s.key), s.tokens[i]);
    a.innerHTML = '<i class="ph ph-signature"></i> Sign now';
    wrap.prepend(a);
  }
  return wrap;
}

function showReady(s: Sent): void {
  const host = $('es-ready-list');
  host.textContent = '';
  s.signers.forEach((sig, i) => {
    const row = document.createElement('div');
    row.className = 'es-sendrow';
    row.innerHTML = `<div style="min-width:0"><div class="es-who-name"></div><div class="es-who-mail"></div></div>`;
    row.querySelector('.es-who-name')!.textContent = `${s.ordered ? `${i + 1}. ` : ''}${sig.name}`;
    row.querySelector('.es-who-mail')!.textContent = sig.email;
    row.appendChild(sendButtons(s, i));
    host.appendChild(row);
  });
  $('es-ready').classList.remove('hidden');
  $('es-ready').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ------------------------------------------------------------------ sent requests

async function renderSent(): Promise<void> {
  const list = (await listSent()).filter((s) => s.expires > Date.now());
  $('es-sent').classList.toggle('hidden', !list.length);
  const host = $('es-sent-list');
  host.textContent = '';
  for (const s of list) {
    const item = document.createElement('div');
    item.className = 'es-env';
    item.innerHTML = `
      <div class="es-env-head">
        <div style="min-width:0"><div class="es-env-title"></div><div class="es-sub es-env-when"></div></div>
        <div class="es-row es-env-actions"></div>
      </div>
      <div class="es-sendlist es-env-signers" style="margin-top:0.6rem"></div>`;
    item.querySelector('.es-env-title')!.textContent = s.title;
    item.querySelector('.es-env-when')!.textContent = `Sent ${formatDate(s.createdAt)} · open until ${formatDate(s.expires)}`;
    host.appendChild(item);
    void fillSent(item, s);
  }
}

async function fillSent(item: HTMLElement, s: Sent): Promise<void> {
  const actions = item.querySelector<HTMLElement>('.es-env-actions')!;
  const signersHost = item.querySelector<HTMLElement>('.es-env-signers')!;
  let state: State;
  try {
    state = await api.state(s.id, s.senderToken);
  } catch (err) {
    if ((err as ApiError).status === 404) {
      actions.innerHTML = '<span class="es-chip">Expired or cancelled</span>';
      const b = document.createElement('button');
      b.className = 'es-btn es-small';
      b.textContent = 'Remove';
      b.onclick = async () => {
        await deleteSent(s.id);
        void renderSent();
      };
      actions.appendChild(b);
    } else actions.innerHTML = '<span class="es-chip es-bad">Could not load</span>';
    return;
  }
  const signed = state.signers.filter((x) => x.signed).length;
  const chip = document.createElement('span');
  chip.className = 'es-chip' + (state.status === 'complete' ? ' es-good' : state.status === 'declined' ? ' es-bad' : '');
  chip.textContent =
    state.status === 'complete' ? 'Completed' : state.status === 'declined' ? 'Declined' : `${signed} of ${state.n} signed`;
  actions.appendChild(chip);

  if (state.status === 'complete') {
    const dl = document.createElement('button');
    dl.className = 'es-btn es-small es-primary';
    dl.innerHTML = '<i class="ph ph-download-simple"></i> Signed PDF';
    dl.onclick = () => void downloadSigned(s, state);
    actions.appendChild(dl);
  }
  const cancel = document.createElement('button');
  cancel.className = 'es-btn es-small es-danger';
  cancel.innerHTML = state.status === 'complete' ? '<i class="ph ph-trash"></i> Delete' : '<i class="ph ph-x"></i> Cancel';
  cancel.onclick = () => void cancelSent(s, state.status === 'complete');
  actions.appendChild(cancel);

  s.signers.forEach((sig, i) => {
    const st = state.signers[i];
    const row = document.createElement('div');
    row.className = 'es-sendrow';
    const status = st.signed ? `Signed ${formatDate(st.signed.at, true)}` : st.viewed ? `Opened ${formatDate(st.viewed.at, true)}` : 'Not opened yet';
    row.innerHTML = `<div style="min-width:0"><div class="es-who-name"></div><div class="es-who-mail"></div></div>`;
    row.querySelector('.es-who-name')!.textContent = `${s.ordered ? `${i + 1}. ` : ''}${sig.name}`;
    row.querySelector('.es-who-mail')!.textContent = `${sig.email} · ${status}`;
    if (state.declined && state.declined.index === i) {
      const line = row.querySelector('.es-who-mail')!;
      line.textContent = `${sig.email} · Declined ${formatDate(state.declined.at, true)}`;
      const reason = state.declined.reason;
      if (reason) {
        void decrypt(fromB64(s.key), fromB64(reason))
          .then((r) => (line.textContent += `: "${new TextDecoder().decode(r)}"`))
          .catch((): undefined => undefined);
      }
    }
    if (!st.signed && state.status === 'out') row.appendChild(sendButtons(s, i));
    signersHost.appendChild(row);
  });

  if (state.status === 'complete') {
    // Everyone can get the finished copy from a read-only link.
    const row = document.createElement('div');
    row.className = 'es-sendrow';
    row.innerHTML = '<div><div class="es-who-name">Send everyone the signed copy</div><div class="es-who-mail">A read-only link to the finished PDF</div></div>';
    const link = signLink(s.id, fromB64(s.key), s.readToken);
    const m = {
      to: s.signers.map((x) => x.email).join(','),
      subject: `Signed: ${s.title}`,
      body: `Hi all,\n\nEveryone has signed "${s.title}". Download the signed PDF here:\n${link}\n\nThe link works until ${formatDate(s.expires)}.\n\n${s.fromName}`,
    };
    const l = composeLinks(m, s.from);
    const btns = document.createElement('div');
    btns.className = 'es-row';
    btns.innerHTML = `
      <a class="es-btn es-small" target="_blank" rel="noopener" href="${escapeHtml(l.gmail)}"><i class="ph ph-google-logo"></i> Gmail</a>
      <a class="es-btn es-small" target="_blank" rel="noopener" href="${escapeHtml(l.outlook)}"><i class="ph ph-microsoft-outlook-logo"></i> Outlook</a>
      <a class="es-btn es-small" href="${escapeHtml(l.app)}"><i class="ph ph-envelope-simple"></i> Email app</a>`;
    row.appendChild(btns);
    signersHost.appendChild(row);
  }
}

async function downloadSigned(s: Sent, state: State): Promise<void> {
  busy('Building the signed PDF...');
  try {
    const key = fromB64(s.key);
    const full = await api.state(s.id, s.senderToken);
    const env = await decryptJson<Envelope>(key, fromB64(full.envelope!));
    const doc = await decrypt(key, await api.doc(s.id, s.senderToken));
    const raw = await api.subs(s.id, s.senderToken);
    const subs: (Submission | null)[] = new Array(env.signers.length).fill(null);
    for (const r of raw) subs[r.index] = await decryptJson<Submission>(key, fromB64(r.data));
    const out = await buildSignedPdf(doc, env, full || state, subs);
    downloadBytes(out, signedName(env));
  } catch (err) {
    console.error(err);
    showAlert('Could not build the signed PDF', String((err as Error).message || err));
  } finally {
    busy(null);
  }
}

async function cancelSent(s: Sent, done: boolean): Promise<void> {
  const ok = await confirmBox(
    done ? 'Delete this request?' : 'Cancel this request?',
    done
      ? 'The signed copy is removed from Paperhaus now instead of in 14 days. Download it first if you need it.'
      : 'The signing links stop working, and the document is deleted from Paperhaus.'
  );
  if (!ok) return;
  busy('Deleting...');
  try {
    await api.cancel(s.id, s.senderToken).catch((e: ApiError) => {
      if (e.status !== 404) throw e;
    });
    await deleteSent(s.id);
    void renderSent();
  } catch (err) {
    showAlert('Could not delete it', String((err as Error).message || err));
  } finally {
    busy(null);
  }
}

function confirmBox(title: string, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'es-modal-wrap';
    wrap.innerHTML = `<div class="es-modal" role="dialog" aria-modal="true"><h3 class="es-h2"></h3><p class="es-sub" style="margin-bottom:1rem"></p><div class="es-row" style="justify-content:flex-end"><button class="es-btn" data-v="0" type="button">Keep it</button><button class="es-btn es-primary" data-v="1" type="button">Yes</button></div></div>`;
    wrap.querySelector('h3')!.textContent = title;
    wrap.querySelector('p')!.textContent = text;
    wrap.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-v]');
      if (!b && e.target !== wrap) return;
      wrap.remove();
      resolve(b?.dataset.v === '1');
    });
    document.body.appendChild(wrap);
  });
}

function resetDraft(): void {
  draft.file = draft.bytes = null;
  draft.pdf?.destroy();
  draft.pdf = null;
  draft.fields = [];
  draft.signers = [];
  $('es-drop').classList.remove('hidden');
  $('es-doc').classList.add('hidden');
  $<HTMLInputElement>('es-title').value = '';
  $<HTMLTextAreaElement>('es-message').value = '';
  $('es-pages').innerHTML = '<p class="es-sub">Choose a PDF first.</p>';
  $('es-ready').classList.add('hidden');
  renderSigners();
  updateCreateHint();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ------------------------------------------------------------------ start

async function loadIdentity(): Promise<void> {
  try {
    const r = await fetch('/cdn-cgi/access/get-identity', { credentials: 'same-origin' });
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
      const j = await r.json();
      identity = { email: j.email || '', name: j.name || '' };
    }
  } catch {
    /* not behind Access */
  }
  const from = $<HTMLInputElement>('es-from');
  from.value = prefs.get('from') || identity.email;
  $<HTMLInputElement>('es-from-name').value = prefs.get('from-name') || identity.name;
}

function init(): void {
  $('back-to-tools')?.addEventListener('click', () => (location.href = import.meta.env.BASE_URL));
  const input = $<HTMLInputElement>('es-file');
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    input.value = '';
    if (f) void loadFile(f);
  });
  const drop = $('es-drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    const f = e.dataTransfer?.files?.[0];
    if (f) void loadFile(f);
  });
  $('es-doc-change').addEventListener('click', () => input.click());
  $('es-add').addEventListener('click', () => addSigner());
  $('es-add-me').addEventListener('click', () => {
    const email = $<HTMLInputElement>('es-from').value.trim() || identity.email;
    const name = $<HTMLInputElement>('es-from-name').value.trim() || identity.name;
    if (draft.signers.some((s) => s.email.toLowerCase() === email.toLowerCase() && email)) return toast('You are already a signer');
    addSigner(name, email);
  });
  document.querySelectorAll<HTMLElement>('#es-types .es-tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.type as FieldType)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setTool(null);
    if ((e.key === 'Delete' || e.key === 'Backspace') && ui.selected && !(e.target as HTMLElement).closest('input,textarea')) {
      draft.fields = draft.fields.filter((f) => f.id !== ui.selected);
      ui.selected = '';
      renderFields();
    }
  });
  $('es-create').addEventListener('click', () => void create());
  $('es-new').addEventListener('click', resetDraft);
  $('es-refresh').addEventListener('click', () => void renderSent());
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout((): void => void drawPages(), 300);
  });
  renderSigners();
  updateCreateHint();
  void loadIdentity();
  void renderSent();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
