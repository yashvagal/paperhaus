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
  REASONS,
  SIGNER_COLORS,
  api,
  b64url,
  decrypt,
  decryptJson,
  downloadBytes,
  encrypt,
  escapeHtml,
  finalCopy,
  formatDate,
  openRecord,
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
  signers: { name: string; email: string; reason: string; me?: boolean }[];
  fields: Field[];
}

type Mode = 'me' | 'meothers' | 'others';

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
  signers: { name: string; email: string; reason?: string }[];
  createdAt: number;
  expires: number;
  retainUntil?: number;
  ordered: boolean;
  /** When each signer's invite went out through the sender's Gmail (null: not sent by Paperhaus). */
  mailed?: (number | null)[];
  /** When each signer was last reminded from this account. */
  reminded?: (number | null)[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const draft: Draft = { file: null, bytes: null, pdf: null, pages: 0, signers: [], fields: [] };
const ui = { who: 0, tool: null as FieldType | null, selected: '', mode: 'meothers' as Mode };
const KEEP_DAYS = [14, 365, 2555];
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
// Sent requests also follow the person's account (encrypted, via flow.js) when sync is on,
// so the status shows on their phone too.
interface FlowRecords {
  putRecord(kind: string, id: string, obj: unknown): Promise<boolean>;
  deleteRecord(kind: string, id: string): Promise<boolean>;
  listRecords(kind: string): Promise<unknown[]>;
}
async function flowApi(): Promise<FlowRecords | null> {
  for (let i = 0; i < 30; i++) {
    const f = (window as unknown as { paperhausFlow?: FlowRecords }).paperhausFlow;
    if (f && f.listRecords) return f;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}
async function saveSent(s: Sent): Promise<void> {
  await saveLocal(s);
  void flowApi().then((f) => f && f.putRecord('sent', s.id, s).catch(() => false));
}
async function saveLocal(s: Sent): Promise<void> {
  const d = await db();
  await new Promise<void>((res, rej) => {
    const tx = d.transaction('sent', 'readwrite');
    tx.objectStore('sent').put(s);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function deleteSent(id: string): Promise<void> {
  void flowApi().then((f) => f && f.deleteRecord('sent', id).catch(() => false));
  await deleteLocal(id);
}
async function deleteLocal(id: string): Promise<void> {
  const d = await db();
  await new Promise<void>((res) => {
    const tx = d.transaction('sent', 'readwrite');
    tx.objectStore('sent').delete(id);
    tx.oncomplete = () => res();
  });
}
/** Pull requests sent from the person's other devices into this browser. */
async function pullSent(): Promise<void> {
  const f = await flowApi();
  if (!f) return;
  const remote = (await f.listRecords('sent').catch((): unknown[] => [])) as (Sent & { gone?: boolean })[];
  if (!remote.length) return;
  const have = new Map((await listSent()).map((s) => [s.id, s]));
  for (const r of remote) {
    if (r && r.gone) {
      if (have.has(r.id)) await deleteLocal(r.id);
      continue;
    }
    if (!r || !r.id || !r.key || !r.senderToken) continue;
    const mine = have.get(r.id);
    if (!mine) await saveLocal(r);
    else {
      // Keep the latest "sent" and "reminded" times from either device.
      const merge = (a?: (number | null)[], b?: (number | null)[]): (number | null)[] | undefined =>
        a || b ? s0(a, b).map((_, i) => Math.max((a && a[i]) || 0, (b && b[i]) || 0) || null) : undefined;
      const s0 = (a?: (number | null)[], b?: (number | null)[]): (number | null)[] => ((a || []).length >= (b || []).length ? a || [] : b || []);
      const mailed = merge(mine.mailed, r.mailed);
      const reminded = merge(mine.reminded, r.reminded);
      if (JSON.stringify(mailed) !== JSON.stringify(mine.mailed) || JSON.stringify(reminded) !== JSON.stringify(mine.reminded)) await saveLocal({ ...mine, mailed, reminded });
    }
  }
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
    $('es-newflow').classList.remove('es-nodoc');
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
      <label class="es-reason"><span>Signs as</span><select class="es-input"></select></label>
      <button class="es-btn es-small es-danger" type="button" aria-label="Remove signer"><i class="ph ph-trash"></i></button>`;
    const [name, email] = row.querySelectorAll('input');
    name.value = s.name;
    email.value = s.email;
    if (s.me) {
      row.classList.add('es-signer-me');
      name.title = 'You';
    }
    const reason = row.querySelector('select')!;
    for (const r of REASONS) reason.add(new Option(r, r, false, r === s.reason));
    reason.addEventListener('change', () => (s.reason = reason.value));
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

function addSigner(name = '', email = '', me = false): void {
  if (draft.signers.length >= 10) {
    showAlert('Up to 10 signers', 'A signing request can have up to 10 signers.');
    return;
  }
  draft.signers.push({ name, email, reason: me ? 'Author' : 'Approved', me });
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
    b.querySelector('span:last-child')!.textContent = (s.me ? `${s.name.trim() || 'You'} (you)` : s.name.trim()) || `Signer ${i + 1}`;
    b.addEventListener('click', () => {
      ui.who = i;
      renderWhos();
    });
    host.appendChild(b);
  });
  if (!draft.signers.length) host.innerHTML = '<span class="es-sub">Add a signer first</span>';
}

// ------------------------------------------------------------------ who's signing

function myself(): { name: string; email: string } {
  const email = $<HTMLInputElement>('es-from').value.trim() || identity.email;
  const name = $<HTMLInputElement>('es-from-name').value.trim() || identity.name || email.split('@')[0] || '';
  return { name, email };
}

/** Put "me" first in the signer list (or take me out), moving the fields with each signer. */
function placeMe(wanted: boolean): void {
  const at = draft.signers.findIndex((s) => s.me);
  if (wanted && at === 0) return;
  if (!wanted && at < 0) return;
  const order = draft.signers.map((_, i) => i);
  if (at > 0) {
    order.splice(at, 1);
    order.unshift(at);
  }
  if (!wanted) order.splice(order.indexOf(at), 1);
  const shift = wanted && at < 0 ? 1 : 0;
  const remap = new Map(order.map((oldI, newI) => [oldI, newI + shift]));
  const next = order.map((i) => draft.signers[i]);
  if (shift) {
    const me = myself();
    next.unshift({ name: me.name, email: me.email, reason: 'Author', me: true });
  }
  draft.signers = next;
  draft.fields = draft.fields.filter((f) => remap.has(f.signer)).map((f) => ({ ...f, signer: remap.get(f.signer)! }));
}

function setMode(mode: Mode, user = true): void {
  ui.mode = mode;
  if (user) prefs.set('mode', mode);
  document.querySelectorAll<HTMLElement>('#es-modes .es-mode').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', String(on));
  });
  if (mode === 'me') {
    placeMe(true);
    draft.fields = draft.fields.filter((f) => f.signer === 0);
    draft.signers = [draft.signers[0]];
  } else if (mode === 'meothers') {
    placeMe(true);
    $<HTMLInputElement>('es-ordered').checked = true;
  } else {
    placeMe(false);
  }
  ui.who = mode === 'meothers' && draft.signers.length > 1 ? 1 : 0;
  $('es-signers-card').classList.toggle('hidden', mode === 'me');
  document.querySelectorAll<HTMLElement>('[data-not-me]').forEach((el) => el.classList.toggle('hidden', mode === 'me'));
  $('es-send-title').textContent = mode === 'me' ? 'Sign' : 'Send';
  $('es-create').querySelector('span')!.textContent = mode === 'me' ? 'Sign now' : mode === 'meothers' ? 'Create links, then sign first' : 'Create signing links';
  $('es-create').querySelector('i')!.className = mode === 'me' ? 'ph ph-signature' : 'ph ph-paper-plane-tilt';
  let n = 0;
  document.querySelectorAll<HTMLElement>('[data-step]').forEach((card) => {
    if (!card.classList.contains('hidden')) card.querySelector('.es-step')!.textContent = String(++n);
  });
  renderSigners();
  renderFields();
  renderMail();
}

function keepDays(): number {
  const v = Number(prefs.get('keep'));
  return KEEP_DAYS.includes(v) ? v : 365;
}

function renderKeep(): void {
  const v = keepDays();
  document.querySelectorAll<HTMLElement>('#es-keep button').forEach((b) => {
    const on = Number(b.dataset.keep) === v;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', String(on));
  });
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
    showAlert('Add a signer first', 'Each field belongs to a signer. Add one under Signers.');
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
    const who = (draft.signers[f.signer]?.me && ui.mode === 'me' ? 'You' : draft.signers[f.signer]?.name.trim().split(/\s+/)[0]) || `Signer ${f.signer + 1}`;
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
  else if (missing.length) hint.textContent = ui.mode === 'me' ? 'Place your signature on the page.' : `No fields yet for ${missing.map(({ s, i }) => s.name || `Signer ${i + 1}`).join(', ')}.`;
  else hint.textContent = `${draft.fields.length} field${draft.fields.length === 1 ? '' : 's'} for ${draft.signers.length} signer${draft.signers.length === 1 ? '' : 's'}.`;
}

// ------------------------------------------------------------------ create

async function create(): Promise<void> {
  const from = $<HTMLInputElement>('es-from').value.trim();
  const fromName = $<HTMLInputElement>('es-from-name').value.trim() || identity.name || from.split('@')[0];
  const title = $<HTMLInputElement>('es-title').value.trim() || draft.file?.name.replace(/\.pdf$/i, '') || 'Document';
  const message = $<HTMLTextAreaElement>('es-message').value.trim();
  const ordered = $<HTMLInputElement>('es-ordered').checked;

  if (!draft.bytes || !draft.file) return showAlert('Choose a PDF', 'Add the document first.');
  const meNow = myself();
  const s0 = draft.signers.find((s) => s.me);
  if (s0) {
    if (!s0.name.trim()) s0.name = meNow.name;
    if (!s0.email.trim()) s0.email = meNow.email;
  }
  if (!draft.signers.length) return showAlert('Add a signer', 'Add at least one signer.');
  for (const [i, s] of draft.signers.entries()) {
    if (!s.name.trim()) return showAlert('Name needed', s.me ? 'Add your name.' : `Add a name for signer ${i + 1}.`);
    if (!validEmail(s.email)) return showAlert('Email needed', `Check the email address for ${s.name || `signer ${i + 1}`}.`);
  }
  for (const [i, s] of draft.signers.entries()) {
    if (!draft.fields.some((f) => f.signer === i && (f.type === 'signature' || f.type === 'initials'))) {
      return showAlert('A signature field is missing', s.me && ui.mode === 'me' ? 'Choose Signature, then tap the page where you sign.' : `Place at least one Signature or Initials field for ${s.name}.`);
    }
  }
  if (!validEmail(from)) return showAlert('Your email', 'Add the email address you will send the invitations from.');
  prefs.set('from', from);
  prefs.set('from-name', fromName);

  busy(ui.mode === 'me' ? 'Encrypting...' : 'Encrypting and creating links...');
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
      signers: draft.signers.map((s) => ({ name: s.name.trim(), email: s.email.trim(), reason: s.reason || 'Signer' })),
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
        keepDays: keepDays(),
        docSha256: envelope.docSha256,
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
      retainUntil: (res as { retainUntil?: number }).retainUntil,
      ordered,
    };
    await saveSent(sent);
    if (ui.mode === 'me') {
      // Straight to signing, in this tab. The signing page offers the sealed copy after.
      location.href = signLink(sent.id, key, tokens[0]);
      return;
    }
    if (autoSend()) {
      busy('Sending the invites from your Gmail...');
      const failed = await sendAllInvites(sent);
      if (failed) showAlert('Some invites did not go out', `${lastMailError ? `Gmail said: ${lastMailError}. ` : ''}Use the Send or Gmail buttons next to those people to send them.`);
      else toast('Invites sent from your Gmail');
    }
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

// ------------------------------------------------------------------ Gmail: send automatically

/** The signed-in person's Gmail connections (functions/api/mail); address is the one sending. */
const gmail = { configured: false, connected: false, address: '', accounts: [] as { gmail: string; name: string }[] };

async function loadGmail(): Promise<void> {
  try {
    const r = await fetch('/api/mail/status', { credentials: 'same-origin' });
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
      const j = await r.json();
      gmail.configured = !!j.configured;
      gmail.connected = !!j.connected;
      gmail.accounts = Array.isArray(j.accounts) ? j.accounts : [];
      const saved = prefs.get('mail-from');
      gmail.address = (gmail.accounts.find((a) => a.gmail === saved) || gmail.accounts.find((a) => a.gmail === j.primary) || gmail.accounts[0] || { gmail: '' }).gmail;
    }
  } catch {
    /* not deployed with mail: drafts as before */
  }
  if (gmail.connected) {
    const from = $<HTMLInputElement>('es-from');
    from.value = gmail.address;
  }
  renderMail();
}

const autoSend = (): boolean => gmail.connected && prefs.get('auto-send') !== '0';
const notifyMe = (): boolean => prefs.get('notify') !== '0';
const remindOn = (): boolean => prefs.get('remind') !== '0';

/** Remind signer i now, from the connected Gmail, in their invite thread. */
async function remindSigner(s: Sent, i: number): Promise<number> {
  await mailSetup(s);
  const res = (await mailPost('/api/mail/remind', { id: s.id, t: s.senderToken, index: i, link: signLink(s.id, fromB64(s.key), s.tokens[i]) })) as { at?: number };
  const at = (res && res.at) || Date.now();
  s.reminded = s.reminded || new Array(s.signers.length).fill(null);
  s.reminded[i] = at;
  await saveSent(s);
  return at;
}

// Set to true once Google has verified the app (no more "hasn't verified" screen).
const GOOGLE_REVIEWED = false;

function renderMail(): void {
  const box = $('es-mail');
  const fromInput = $<HTMLInputElement>('es-from');
  const fromLabel = fromInput.closest('label') as HTMLElement;
  box.classList.toggle('hidden', !gmail.configured || ui.mode === 'me');
  // With Gmail sending on, "Send from" lives in this box, so the plain field hides.
  fromLabel.classList.toggle('es-collapsed', gmail.configured);
  if (!gmail.configured) return;
  const connected = gmail.accounts.length > 0;
  box.innerHTML = `
    <div class="es-mail-row"><i class="ph ph-envelope-simple"></i>
      <div style="min-width:0;flex:1"><strong>Send from</strong>
      <span>The emails go out from this address, by themselves.</span></div></div>
    <div class="es-from-pick${connected ? '' : ' hidden'}">
      <select id="es-mailfrom" class="es-input" aria-label="Send from"></select>
      <button id="es-gmail-remove" class="es-linkbtn" type="button">Remove</button>
    </div>
    <div id="es-newfrom" class="es-from-pick${connected ? ' hidden' : ''}">
      <input id="es-newfrom-email" class="es-input" type="email" placeholder="name@company.com" autocomplete="email" aria-label="Email address to send from" />
      <button id="es-gmail-connect" class="es-btn es-small es-primary" type="button"><i class="ph ph-google-logo"></i> Connect</button>
    </div>
    <span id="es-newfrom-note" class="es-sub${connected ? ' hidden' : ''}">Type your Gmail address and press Connect. You only do this once.${GOOGLE_REVIEWED ? '' : ` If Google says it <em>hasn&#39;t verified this app</em>, click <strong>Advanced</strong>, then <strong>Go to ${escapeHtml(location.hostname)}</strong>, and tick <strong>Send email on your behalf</strong>.`}</span>
    ${connected ? `<label class="es-check-row"><input type="checkbox" id="es-auto" /> Send the invites automatically</label>
    <label class="es-check-row"><input type="checkbox" id="es-notify" /> Email me when someone signs or declines, and when everyone is done</label>
    <label class="es-check-row"><input type="checkbox" id="es-remind" /> Remind people who haven't signed (every 3 days, up to 4 times)</label>` : ''}`;

  const sel = $<HTMLSelectElement>('es-mailfrom');
  for (const a of gmail.accounts) sel.add(new Option(a.gmail, a.gmail, false, a.gmail === gmail.address));
  sel.add(new Option('+ Another address...', '__new'));
  const newRow = $('es-newfrom');
  const newNote = $('es-newfrom-note');
  const newEmail = $<HTMLInputElement>('es-newfrom-email');
  if (!connected) newEmail.value = fromInput.value.trim() || identity.email;

  sel.addEventListener('change', () => {
    if (sel.value === '__new') {
      newRow.classList.remove('hidden');
      newNote.classList.remove('hidden');
      newEmail.value = '';
      newEmail.focus();
      return;
    }
    newRow.classList.add('hidden');
    newNote.classList.add('hidden');
    useAddress(sel.value);
  });
  $('es-gmail-remove').addEventListener('click', async () => {
    const which = gmail.address;
    if (!which) return;
    await mailPost('/api/mail/disconnect', { gmail: which }).catch((): undefined => undefined);
    toast(`Removed ${which}`);
    await loadGmail();
  });
  const connect = () => {
    const want = newEmail.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(want)) {
      newEmail.focus();
      return toast('Type the email address to send from');
    }
    const known = gmail.accounts.find((a) => a.gmail.toLowerCase() === want.toLowerCase());
    if (known) {
      useAddress(known.gmail);
      return renderMail();
    }
    connectGmail(want);
  };
  $('es-gmail-connect').addEventListener('click', connect);
  newEmail.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      connect();
    }
  });
  if (!connected) newEmail.addEventListener('input', () => (fromInput.value = newEmail.value.trim()));

  if (!connected) return;
  const auto = $<HTMLInputElement>('es-auto');
  const note = $<HTMLInputElement>('es-notify');
  auto.checked = autoSend();
  note.checked = notifyMe();
  auto.addEventListener('change', () => prefs.set('auto-send', auto.checked ? '1' : '0'));
  note.addEventListener('change', () => prefs.set('notify', note.checked ? '1' : '0'));
  const rem = $<HTMLInputElement>('es-remind');
  rem.checked = remindOn();
  rem.addEventListener('change', () => prefs.set('remind', rem.checked ? '1' : '0'));
}

/** Send from this connected address from now on (remembered here and on the server). */
function useAddress(address: string): void {
  gmail.address = address;
  prefs.set('mail-from', address);
  const from = $<HTMLInputElement>('es-from');
  from.value = address;
  from.dispatchEvent(new Event('input'));
  void mailPost('/api/mail/primary', { gmail: address }).catch((): undefined => undefined);
}

/** Google sign-in in a pop-up, starting at the account for `hint` when given. */
function connectGmail(hint = ''): void {
  const w = window.open(`/api/mail/connect${hint ? `?hint=${encodeURIComponent(hint)}` : ''}`, 'paperhaus-gmail', 'width=520,height=680');
  if (!w) {
    showAlert('Allow the pop-up', 'Your browser blocked the Google sign-in window. Allow pop-ups for Paperhaus and press Connect again.');
    return;
  }
  let handled = false;
  const done = (e: MessageEvent) => {
    if (e.origin !== location.origin || !e.data || !e.data.paperhausGmail) return;
    window.removeEventListener('message', done);
    handled = true;
    if (e.data.paperhausGmail === 'connected') {
      const got = String(e.data.gmail || '');
      if (hint && got.toLowerCase() !== hint.toLowerCase()) {
        showAlert('A different account was connected', `Google connected ${got}, not ${hint}. To send from ${hint}, choose Another address again and pick ${hint} in the Google window (sign in to it there if it is not listed).`);
      } else toast(`Connected ${got}`);
      prefs.set('mail-from', got);
      void loadGmail().then(() => {
        if (got) useAddress(got);
      });
    }
  };
  window.addEventListener('message', done);
  // Also pick it up if the window closes without a message (some phones).
  const timer = setInterval(() => {
    if (w.closed) {
      clearInterval(timer);
      if (!handled) setTimeout(() => void loadGmail(), 300);
    }
  }, 700);
}

async function mailPost(path: string, body: unknown): Promise<any> {
  const r = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === 'gmail_not_connected') {
      void loadGmail();
    }
    throw Object.assign(new Error(j.detail || j.error || `HTTP ${r.status}`), { code: j.error });
  }
  return j;
}

/** Tell the server what it needs to email people about this request later. */
async function mailSetup(s: Sent): Promise<void> {
  await mailPost('/api/mail/esign', {
    id: s.id,
    t: s.senderToken,
    title: s.title,
    senderName: s.fromName,
    notify: notifyMe(),
    remind: remindOn(),
    from: s.from,
    signers: s.signers.map((x, i) => ({ name: x.name, email: x.email, me: isMe(s, i) })),
  });
}

function isMe(s: Sent, i: number): boolean {
  const mine = [identity.email, s.from, gmail.address].filter(Boolean).map((x) => x.toLowerCase());
  return mine.includes(s.signers[i].email.toLowerCase());
}

async function sendInvite(s: Sent, i: number): Promise<void> {
  const m = mail(s, i);
  await mailPost('/api/mail/send', { to: m.to, subject: m.subject, text: m.body, fromName: s.fromName, esign: { id: s.id, t: s.senderToken, index: i } });
  s.mailed = s.mailed || new Array(s.signers.length).fill(null);
  s.mailed[i] = Date.now();
  await saveSent(s);
}

/** Send every invite (not the sender's own) through Gmail. Returns how many failed. */
let lastMailError = '';
async function sendAllInvites(s: Sent): Promise<number> {
  lastMailError = '';
  try {
    await mailSetup(s);
  } catch (err) {
    console.warn('Mail setup failed', err);
    lastMailError = String((err as Error).message || err).slice(0, 200);
    return s.signers.length;
  }
  let failed = 0;
  for (let i = 0; i < s.signers.length; i++) {
    if (isMe(s, i)) continue;
    try {
      await sendInvite(s, i);
    } catch (err) {
      console.warn('Invite failed', err);
      lastMailError = String((err as Error).message || err).slice(0, 200);
      failed++;
    }
  }
  return failed;
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

function sendButtons(s: Sent, i: number, canRemind = true): HTMLElement {
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
  const sentFirst = s.mailed && s.mailed[i];
  if (gmail.connected && !isMe(s, i) && (canRemind || !sentFirst)) {
    // Sent through Gmail already, or send it now; the draft buttons stay as other ways.
    const sentAt = s.mailed && s.mailed[i];
    const remindedAt = s.reminded && s.reminded[i];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `es-btn es-small${sentAt ? '' : ' es-primary'}`;
    b.innerHTML = sentAt ? '<i class="ph ph-bell-ringing"></i> Remind' : '<i class="ph ph-paper-plane-tilt"></i> Send';
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        if (s.mailed && s.mailed[i]) {
          const at = await remindSigner(s, i);
          toast(`Reminded ${s.signers[i].email}`);
          status.textContent = `Reminded ${formatDate(at, true)}`;
        } else {
          await mailSetup(s);
          await sendInvite(s, i);
          toast(`Sent to ${s.signers[i].email}`);
          status.textContent = `Sent ${formatDate(Date.now(), true)}`;
          b.innerHTML = '<i class="ph ph-bell-ringing"></i> Remind';
          b.classList.remove('es-primary');
        }
      } catch (err) {
        const msg = String((err as Error).message || err);
        showAlert('Could not send it', /already_signed/.test(msg) ? 'They have already signed.' : msg);
      } finally {
        b.disabled = false;
      }
    });
    const status = document.createElement('span');
    status.className = 'es-sent-tag';
    status.textContent = remindedAt ? `Reminded ${formatDate(remindedAt, true)}` : sentAt ? `Sent ${formatDate(sentAt, true)}` : '';
    wrap.prepend(status);
    wrap.prepend(b);
  }
  if (isMe(s, i)) {
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

let pulled = false;
type DocGroup = 'waiting' | 'signed' | 'ended';
let docGroup: DocGroup | null = null;
interface DocItem {
  s: Sent;
  state: State | null;
  group: DocGroup;
}

/** Show the New or My documents tab. */
function showTab(tab: 'new' | 'docs', remember = true): void {
  document.querySelectorAll<HTMLElement>('.es-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll<HTMLElement>('.es-panel').forEach((p) => (p.hidden = p.dataset.panel !== tab));
  if (remember) history.replaceState(null, '', tab === 'docs' ? '#documents' : location.pathname + location.search);
  if (tab === 'docs') void renderSent();
}

/** My documents: every request sent from this account, grouped by where it stands. */
async function renderSent(): Promise<void> {
  if (!pulled) {
    pulled = true;
    void pullSent().then(
      (): Promise<void> => renderSent(),
      (): void => undefined
    );
  }
  const list = (await listSent()).filter((s) => (s.retainUntil || s.expires) > Date.now());
  const host = $('es-sent-list');
  const items: DocItem[] = await Promise.all(
    list.map(async (s): Promise<DocItem> => {
      try {
        const state = await api.state(s.id, s.senderToken);
        const group: DocGroup = state.status === 'out' ? 'waiting' : state.status === 'complete' ? 'signed' : 'ended';
        return { s, state, group };
      } catch {
        return { s, state: null, group: 'ended' };
      }
    })
  );
  const count = (g: DocGroup): number => items.filter((x) => x.group === g).length;
  const badge = $('es-docs-badge');
  badge.textContent = String(count('waiting'));
  badge.classList.toggle('hidden', !count('waiting'));
  if (!docGroup || !count(docGroup)) docGroup = (['waiting', 'signed', 'ended'] as DocGroup[]).find((g) => count(g)) || 'waiting';

  const filters = $('es-doc-filters');
  filters.textContent = '';
  const names: Record<DocGroup, string> = { waiting: 'Waiting for signatures', signed: 'Signed', ended: 'Cancelled or ended' };
  (['waiting', 'signed', 'ended'] as DocGroup[]).forEach((g) => {
    if (g === 'ended' && !count(g)) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'es-filter';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(g === docGroup));
    b.textContent = `${names[g]} (${count(g)})`;
    b.onclick = () => {
      docGroup = g;
      void renderSent();
    };
    filters.appendChild(b);
  });

  host.textContent = '';
  const shown = items.filter((x) => x.group === docGroup);
  if (!shown.length) {
    const p = document.createElement('p');
    p.className = 'es-sub es-empty';
    p.textContent = items.length
      ? docGroup === 'waiting'
        ? 'Nothing is waiting for signatures right now.'
        : 'Nothing here yet.'
      : 'Nothing here yet. Documents you send for signature show up here, with who has signed.';
    host.appendChild(p);
    return;
  }
  for (const it of shown) {
    const item = document.createElement('div');
    item.className = 'es-env';
    item.innerHTML = `
      <div class="es-env-head">
        <div style="min-width:0"><div class="es-env-title"></div><div class="es-sub es-env-when"></div></div>
        <div class="es-row es-env-actions"></div>
      </div>
      <div class="es-env-more" hidden>
        <div class="es-sendlist es-env-signers" style="margin-top:0.6rem"></div>
        <div class="es-row es-env-tools" style="margin-top:0.6rem"></div>
      </div>`;
    item.querySelector('.es-env-title')!.textContent = it.s.title;
    host.appendChild(item);
    fillSent(item, it.s, it.state);
  }
}

function names(list: string[]): string {
  if (list.length <= 1) return list[0] || '';
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.length} people`;
}

/** One document: a plain status line, the one or two things to do, and Details. */
function fillSent(item: HTMLElement, s: Sent, state: State | null): void {
  const actions = item.querySelector<HTMLElement>('.es-env-actions')!;
  const when = item.querySelector<HTMLElement>('.es-env-when')!;
  const more = item.querySelector<HTMLElement>('.es-env-more')!;
  const tools = item.querySelector<HTMLElement>('.es-env-tools')!;
  const signersHost = item.querySelector<HTMLElement>('.es-env-signers')!;
  const button = (html: string, cls = '', onclick?: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `es-btn es-small ${cls}`.trim();
    b.innerHTML = html;
    if (onclick) b.onclick = onclick;
    return b;
  };
  if (!state) {
    when.textContent = 'Deleted. It is no longer on Paperhaus.';
    actions.appendChild(
      button('Remove from list', '', async () => {
        await deleteSent(s.id);
        void renderSent();
      })
    );
    return;
  }
  const signedCount = state.signers.filter((x) => x.signed).length;
  const waitingFor = s.signers.map((x, i) => (state.signers[i].signed ? '' : isMe(s, i) ? 'you' : x.name)).filter(Boolean);
  if (state.status === 'out') {
    const next = s.ordered ? waitingFor.slice(0, 1) : waitingFor;
    when.textContent = `Waiting for ${names(next)} · ${signedCount} of ${state.n} signed · sent ${formatDate(s.createdAt)}`;
  } else if (state.status === 'complete') {
    const last = Math.max(...state.signers.map((x) => (x.signed && x.signed.at) || 0));
    when.textContent = `Signed by everyone · ${formatDate(last || s.createdAt)}`;
  } else if (state.status === 'cancelled' && state.cancelled) {
    when.textContent = `Cancelled · you can undo this until ${formatDate(state.cancelled.until)}`;
  } else if (state.status === 'declined' && state.declined) {
    when.textContent = `${s.signers[state.declined.index]?.name || 'Someone'} declined · ${formatDate(state.declined.at)}`;
  } else if (state.status === 'expired') {
    when.textContent = `Time ran out before everyone signed · ${formatDate(s.expires)}`;
  }

  // The main things to do, right on the card.
  if (state.status === 'complete') actions.appendChild(button('<i class="ph ph-download-simple"></i> Download signed PDF', 'es-primary', () => void downloadSigned(s, state)));
  if (state.status === 'cancelled') {
    actions.appendChild(
      button('<i class="ph ph-arrow-counter-clockwise"></i> Undo', 'es-primary', async () => {
        busy('Restoring...');
        try {
          await api.restore(s.id, s.senderToken);
          toast('Restored. The signing links work again.');
          docGroup = null;
          void renderSent();
        } catch (err) {
          showAlert('Could not undo it', /too_late/.test(String((err as Error).message)) ? 'The 7 days to undo have passed.' : String((err as Error).message || err));
        } finally {
          busy(null);
        }
      })
    );
    actions.appendChild(button('Delete now', 'es-danger', () => void deleteNow(s)));
    return;
  }
  if (state.status === 'out' && gmail.connected) {
    let waiting = s.signers.map((_, i) => i).filter((i) => !state.signers[i].signed);
    if (s.ordered) waiting = waiting.slice(0, 1);
    const targets = waiting.filter((i) => !isMe(s, i) && s.mailed && s.mailed[i]);
    if (targets.length) {
      const all = button(`<i class="ph ph-bell-ringing"></i> ${targets.length > 1 ? `Remind ${targets.length} people` : 'Remind'}`);
      all.onclick = async () => {
        all.disabled = true;
        let ok = 0;
        for (const i of targets) {
          try {
            await remindSigner(s, i);
            ok++;
          } catch {
            /* counted below */
          }
        }
        toast(ok === targets.length ? (ok > 1 ? `Reminded ${ok} people` : 'Reminder sent') : `Reminded ${ok} of ${targets.length}`);
        void renderSent();
      };
      actions.appendChild(all);
    }
  }
  const details = button('Details <i class="ph ph-caret-down"></i>');
  details.setAttribute('aria-expanded', 'false');
  details.onclick = () => {
    more.hidden = !more.hidden;
    details.setAttribute('aria-expanded', String(!more.hidden));
    details.innerHTML = more.hidden ? 'Details <i class="ph ph-caret-down"></i>' : 'Hide details <i class="ph ph-caret-up"></i>';
  };
  actions.appendChild(details);

  // Details: each person, the signing record, cancel or delete.
  s.signers.forEach((sig, i) => {
    const st = state.signers[i];
    const row = document.createElement('div');
    row.className = 'es-sendrow';
    const status = st.signed ? `Signed ${formatDate(st.signed.at, true)}` : st.viewed ? `Opened ${formatDate(st.viewed.at, true)}` : 'Not opened yet';
    row.innerHTML = `<div style="min-width:0"><div class="es-who-name"></div><div class="es-who-mail"></div></div>`;
    row.querySelector('.es-who-name')!.textContent = `${s.ordered ? `${i + 1}. ` : ''}${sig.name}${isMe(s, i) ? ' (you)' : ''}`;
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
    // With a fixed order, only the person whose turn it is can be reminded.
    const turn = !s.ordered || s.signers.findIndex((_, j) => !state.signers[j].signed) === i;
    if (!st.signed && state.status === 'out') row.appendChild(sendButtons(s, i, turn));
    signersHost.appendChild(row);
  });
  if (state.status === 'complete') signersHost.appendChild(shareRow(s, state));
  tools.appendChild(button('<i class="ph ph-file-text"></i> Signing record', '', () => void showRecord(s)));
  tools.appendChild(
    button(state.status === 'out' ? '<i class="ph ph-x"></i> Cancel request' : '<i class="ph ph-trash"></i> Delete', 'es-danger', () => void cancelSent(s, state.status !== 'out'))
  );
}

/** "Send everyone the signed copy": a read-only link to the finished PDF. */
function shareRow(s: Sent, state: State): HTMLElement {
  const row = document.createElement('div');
  row.className = 'es-sendrow';
  row.innerHTML = '<div><div class="es-who-name">Send everyone the signed copy</div><div class="es-who-mail">A read-only link to the finished PDF</div></div>';
  const link = signLink(s.id, fromB64(s.key), s.readToken);
  const m = {
    to: s.signers.map((x) => x.email).join(','),
    subject: `Signed: ${s.title}`,
    body: `Hi all,\n\nEveryone has signed "${s.title}". Download the signed PDF here:\n${link}\n\nThe link works until ${formatDate(state.retainUntil || s.expires)}.\n\n${s.fromName}`,
  };
  const l = composeLinks(m, s.from);
  const btns = document.createElement('div');
  btns.className = 'es-row';
  btns.innerHTML = `
    <a class="es-btn es-small" target="_blank" rel="noopener" href="${escapeHtml(l.gmail)}"><i class="ph ph-google-logo"></i> Gmail</a>
    <a class="es-btn es-small" target="_blank" rel="noopener" href="${escapeHtml(l.outlook)}"><i class="ph ph-microsoft-outlook-logo"></i> Outlook</a>
    <a class="es-btn es-small" href="${escapeHtml(l.app)}"><i class="ph ph-envelope-simple"></i> Email app</a>`;
  if (gmail.connected) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'es-btn es-small es-primary';
    b.innerHTML = '<i class="ph ph-paper-plane-tilt"></i> Send to everyone';
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await mailPost('/api/mail/send', { to: s.signers.map((x) => x.email), subject: m.subject, text: m.body, fromName: s.fromName, from: s.from });
        toast('Sent everyone the signed copy');
      } catch (err) {
        showAlert('Could not send it', String((err as Error).message || err));
      } finally {
        b.disabled = false;
      }
    });
    btns.prepend(b);
  }
  row.appendChild(btns);
  return row;
}

async function downloadSigned(s: Sent, state: State): Promise<void> {
  busy(state.sealed ? 'Opening the signed PDF...' : 'Building and sealing the signed PDF...');
  try {
    const key = fromB64(s.key);
    const full = await api.state(s.id, s.senderToken);
    const env = await decryptJson<Envelope>(key, fromB64(full.envelope!));
    const doc = await decrypt(key, await api.doc(s.id, s.senderToken));
    const raw = await api.subs(s.id, s.senderToken);
    const subs: (Submission | null)[] = new Array(env.signers.length).fill(null);
    for (const r of raw) subs[r.index] = await decryptJson<Submission>(key, fromB64(r.data));
    const out = await finalCopy({ id: s.id, key, token: s.senderToken }, env, full || state, doc, subs);
    downloadBytes(out.pdf, signedName(env));
    if (!out.sealed) toast('Downloaded without the seal. Try again later for the sealed copy.');
    void renderSent();
  } catch (err) {
    console.error(err);
    showAlert('Could not build the signed PDF', String((err as Error).message || err));
  } finally {
    busy(null);
  }
}

async function showRecord(s: Sent): Promise<void> {
  busy('Opening the signing record...');
  try {
    const key = fromB64(s.key);
    const st = await api.state(s.id, s.senderToken);
    const env = await decryptJson<Envelope>(key, fromB64(st.envelope!));
    await openRecord(env, st, st.status === 'complete' ? () => void downloadSigned(s, st) : null);
  } catch (err) {
    showAlert('Could not open the signing record', String((err as Error).message || err));
  } finally {
    busy(null);
  }
}

async function cancelSent(s: Sent, done: boolean): Promise<void> {
  const ok = await confirmBox(
    done ? 'Delete this document?' : 'Cancel this request?',
    done
      ? 'It is removed from Paperhaus. You can undo this for 7 days. Download the signed PDF first if you need a copy.'
      : 'The signing links stop working right away. You can undo this for 7 days, then it is deleted.'
  );
  if (!ok) return;
  busy(done ? 'Deleting...' : 'Cancelling...');
  try {
    await api.cancel(s.id, s.senderToken);
    toast(done ? 'Deleted. You can undo it under Cancelled or ended.' : 'Cancelled. You can undo it under Cancelled or ended.');
    docGroup = 'ended';
    void renderSent();
  } catch (err) {
    if ((err as ApiError).status === 404) {
      await deleteSent(s.id);
      void renderSent();
    } else showAlert('Could not do that', String((err as Error).message || err));
  } finally {
    busy(null);
  }
}

/** Delete a cancelled request for good, before the 7 days are up. */
async function deleteNow(s: Sent): Promise<void> {
  const ok = await confirmBox('Delete it for good?', 'It is removed from Paperhaus now and cannot be brought back.');
  if (!ok) return;
  busy('Deleting...');
  try {
    await api.cancel(s.id, s.senderToken, true).catch((e: ApiError) => {
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
    wrap.innerHTML = `<div class="es-modal" role="dialog" aria-modal="true"><h3 class="es-h2"></h3><p class="es-sub" style="margin-bottom:1rem"></p><div class="es-row" style="justify-content:flex-end"><button class="es-btn" data-v="0" type="button">No, keep it</button><button class="es-btn es-primary" data-v="1" type="button">Yes</button></div></div>`;
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
  $('es-newflow').classList.add('es-nodoc');
  $<HTMLInputElement>('es-title').value = '';
  $<HTMLTextAreaElement>('es-message').value = '';
  $('es-pages').innerHTML = '<p class="es-sub">Choose a PDF first.</p>';
  $('es-ready').classList.add('hidden');
  setMode(ui.mode, false);
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
    /* fine */
  }
  // The name the owner gave this person on the invite page (people.html), if any.
  try {
    const r = await fetch('/api/admin/me', { credentials: 'same-origin' });
    if (r.ok) {
      const j = (await r.json()) as { name?: string };
      if (j.name) identity.name = j.name;
    }
  } catch {
    /* not behind Access */
  }
  const from = $<HTMLInputElement>('es-from');
  from.value = prefs.get('from') || identity.email;
  $<HTMLInputElement>('es-from-name').value = prefs.get('from-name') || identity.name;
  const me = draft.signers.find((s) => s.me);
  if (me) {
    const m = myself();
    if (!me.name) me.name = m.name;
    if (!me.email) me.email = m.email;
    renderSigners();
  }
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
    if (draft.signers.some((s) => s.me)) return toast('You are already a signer');
    if (ui.mode === 'others') return setMode('meothers');
    const m = myself();
    addSigner(m.name, m.email, true);
  });
  document.querySelectorAll<HTMLElement>('#es-modes .es-mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as Mode)));
  document.querySelectorAll<HTMLElement>('#es-keep button').forEach((b) =>
    b.addEventListener('click', () => {
      prefs.set('keep', String(b.dataset.keep));
      renderKeep();
    })
  );
  for (const id of ['es-from-name', 'es-from']) {
    $<HTMLInputElement>(id).addEventListener('input', () => {
      const me = draft.signers.find((s) => s.me);
      if (!me) return;
      const m = myself();
      me.name = m.name;
      me.email = m.email;
      renderSigners();
      renderFields();
    });
  }
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
  $('es-refresh').addEventListener('click', () => {
    pulled = false;
    void renderSent();
  });
  document.querySelectorAll<HTMLElement>('.es-tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab === 'docs' ? 'docs' : 'new')));
  window.addEventListener('hashchange', () => showTab(location.hash === '#documents' ? 'docs' : 'new', false));
  showTab(location.hash === '#documents' ? 'docs' : 'new', false);
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout((): void => void drawPages(), 300);
  });
  const asked = new URLSearchParams(location.search).get('mode') as Mode | null;
  const saved = prefs.get('mode') as Mode;
  const modes: Mode[] = ['me', 'meothers', 'others'];
  setMode(asked && modes.includes(asked) ? asked : modes.includes(saved) ? saved : 'meothers', false);
  renderKeep();
  updateCreateHint();
  void loadIdentity().then(loadGmail);
  void renderSent();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
