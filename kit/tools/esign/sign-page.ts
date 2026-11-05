/**
 * Paperhaus: the signing page. Public, no sign-in: whoever has the link signs.
 *
 * The link is /sign-request#<id>.<key>.<token>. The key and token never leave this
 * browser except as the token's role check; the document and every value typed here are
 * encrypted before they are sent back.
 */
import '@phosphor-icons/web/regular';
import './esign.css';
import {
  type Envelope,
  type Field,
  type State,
  type Submission,
  ApiError,
  CONSENT,
  FIELD_LABELS,
  SCRIPT_FONTS,
  SIGNER_COLORS,
  api,
  buildSignedPdf,
  checkPng,
  decrypt,
  decryptJson,
  downloadBytes,
  encrypt,
  formatDate,
  fromB64,
  openPdf,
  parseLink,
  renderPages,
  sha256hex,
  signedName,
  textPng,
  trimPng,
  typedPng,
} from './esign-common.js';

type Value = { png: string; text?: string; checked?: boolean };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let link: { id: string; key: Uint8Array; token: string };
let state: State;
let env: Envelope;
let doc: Uint8Array;
let subs: (Submission | null)[] = [];
let me = -1; // my signer index, or -1 for the read-only link
let canSign = false;
const values: Record<string, Value> = {};
const adopted: { signature: string; initials: string } = { signature: '', initials: '' };

// ------------------------------------------------------------------ small helpers

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
function fail(title: string, text: string): void {
  $('es-load').classList.add('hidden');
  $('es-doc-view').classList.add('hidden');
  $('es-bar').classList.add('hidden');
  $('es-fail').classList.remove('hidden');
  $('es-fail-title').textContent = title;
  $('es-fail-text').textContent = text;
}
function note(kind: 'good' | 'bad' | 'warn' | '', text: string): void {
  const n = $('es-status');
  n.className = `es-note${kind ? ` es-${kind}` : ''}`;
  n.textContent = text;
}
const firstName = (s: string) => s.trim().split(/\s+/)[0] || s;
const myFields = () => env.fields.filter((f) => f.signer === me);
const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => [...w][0].toUpperCase())
    .slice(0, 3)
    .join('');

// ------------------------------------------------------------------ start

async function start(): Promise<void> {
  const parsed = parseLink(location.hash);
  // The key stays out of the address bar from here on, so it is not left on screen.
  if (parsed) history.replaceState(null, '', location.pathname);
  if (!parsed) {
    fail('This link is incomplete', 'Open the signing link from your email again. If you copied it, make sure you copied all of it.');
    return;
  }
  link = parsed;
  try {
    state = await api.state(link.id, link.token);
  } catch (err) {
    const e = err as ApiError;
    if (e.status === 404) fail('This request has ended', 'The sender cancelled it, or it is more than 14 days old. Ask them to send it again.');
    else if (e.status === 403) fail('This link does not work', 'Open the signing link from your email again, all of it.');
    else fail('Paperhaus could not be reached', 'Check your connection and reload the page.');
    return;
  }
  try {
    env = await decryptJson<Envelope>(link.key, fromB64(state.envelope!));
  } catch {
    fail('This link does not work', 'Part of the link is missing or changed. Open it from your email again, all of it.');
    return;
  }
  // Keep the key in memory for the session and restore the address if the page reloads.
  try {
    sessionStorage.setItem('paperhaus-esign-link', `${link.id}.${b64(link.key)}.${link.token}`);
  } catch {
    /* private mode */
  }

  $('es-load-text').textContent = 'Decrypting the document...';
  try {
    doc = await decrypt(link.key, await api.doc(link.id, link.token));
  } catch {
    fail('The document could not be opened', 'Reload the page to try again.');
    return;
  }
  if ((await sha256hex(doc)) !== env.docSha256) {
    fail('The document did not match', 'What arrived is not the document that was sent, so it cannot be signed. Ask the sender to send it again.');
    return;
  }
  me = state.role === 'signer' && state.index !== null ? state.index : -1;
  if (me >= 0 && !state.signers[me].signed && state.status === 'out') void api.view(link.id, link.token).catch((): undefined => undefined);
  await loadSubs();
  document.title = `${env.title} | Sign with Paperhaus`;
  await show();
}

function b64(u: Uint8Array): string {
  let s = '';
  for (const c of u) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function loadSubs(): Promise<void> {
  subs = new Array(env.signers.length).fill(null);
  try {
    for (const r of await api.subs(link.id, link.token)) subs[r.index] = await decryptJson<Submission>(link.key, fromB64(r.data));
  } catch {
    /* shown without the others' values */
  }
}

// ------------------------------------------------------------------ the page

async function show(): Promise<void> {
  $('es-load').classList.add('hidden');
  $('es-doc-view').classList.remove('hidden');
  $('es-from').textContent = `From ${env.sender.name}${env.sender.email ? ` (${env.sender.email})` : ''} · ${formatDate(env.createdAt)}`;
  $('es-title').textContent = env.title;
  const msg = $('es-message');
  msg.classList.toggle('hidden', !env.message);
  msg.textContent = env.message;
  renderPeople();
  decide();
  const pdf = await openPdf(doc);
  await renderPages(pdf, $('es-pages'));
  pdf.destroy();
  renderFields();
  updateBar();
}

function renderPeople(): void {
  const host = $('es-people');
  host.textContent = '';
  env.signers.forEach((s, i) => {
    const st = state.signers[i];
    const row = document.createElement('div');
    row.className = 'es-person';
    const declined = state.declined && state.declined.index === i;
    const status = st.signed ? `Signed ${formatDate(st.signed.at)}` : declined ? 'Declined' : st.viewed ? 'Opened' : 'Waiting';
    row.innerHTML = `<span class="es-dot" style="background:${SIGNER_COLORS[i % SIGNER_COLORS.length]}"></span><span class="es-person-name"></span><span class="es-chip"></span>`;
    row.querySelector('.es-person-name')!.textContent = `${env.ordered ? `${i + 1}. ` : ''}${s.name}${i === me ? ' (you)' : ''}`;
    const chip = row.querySelector('.es-chip')!;
    chip.textContent = status;
    if (st.signed) chip.classList.add('es-good');
    if (declined) chip.classList.add('es-bad');
    host.appendChild(row);
  });
}

/** What this visitor can do now, and the banner that says so. */
function decide(): void {
  canSign = false;
  $('es-done-actions').classList.toggle('hidden', state.status !== 'complete');
  if (state.status === 'declined') {
    const who = env.signers[state.declined!.index]?.name || 'A signer';
    note('bad', `${who} declined to sign on ${formatDate(state.declined!.at, true)}, so this request is closed.`);
    return;
  }
  if (state.status === 'complete') {
    note('good', `Everyone has signed. Download the signed PDF, with its signing certificate on the last page.`);
    return;
  }
  if (me < 0) {
    const signed = state.signers.filter((s) => s.signed).length;
    note('', `${signed} of ${state.n} have signed. The signed PDF is ready to download here once everyone has signed.`);
    return;
  }
  if (state.signers[me].signed) {
    note('good', `You signed on ${formatDate(state.signers[me].signed!.at, true)}. ${firstName(env.sender.name)} will send everyone the signed copy once the others have signed.`);
    return;
  }
  if (env.ordered) {
    const before = state.signers.findIndex((s, i) => i < me && !s.signed);
    if (before >= 0) {
      note('warn', `${env.signers[before].name} signs before you. You can read the document now, and sign once they have.`);
      return;
    }
  }
  canSign = true;
  const n = myFields().filter((f) => f.required).length;
  note('', `Hi ${firstName(env.signers[me].name)}. Tap each highlighted field to fill it in, ${n} required. Then press Finish.`);
}

// ------------------------------------------------------------------ fields

function renderFields(): void {
  document.querySelectorAll('#es-pages .es-field').forEach((el) => el.remove());
  const boxes = Array.from(document.querySelectorAll<HTMLElement>('#es-pages .es-page'));
  for (const f of env.fields) {
    const box = boxes[f.page];
    if (!box) continue;
    const el = document.createElement('div');
    el.dataset.id = f.id;
    el.style.setProperty('--c', SIGNER_COLORS[f.signer % SIGNER_COLORS.length]);
    el.style.left = `${f.x * 100}%`;
    el.style.top = `${f.y * 100}%`;
    el.style.width = `${f.w * 100}%`;
    el.style.height = `${f.h * 100}%`;
    const theirs = subs[f.signer]?.values[f.id];
    if (theirs?.png) {
      // Already signed (by someone else, or by me before): show what they put there.
      el.className = 'es-field es-filled';
      el.innerHTML = `<img alt="" />`;
      el.querySelector('img')!.src = theirs.png;
    } else if (f.signer === me && canSign) {
      el.className = 'es-field es-mine';
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      fillMine(el, f);
    } else {
      el.className = 'es-field es-other';
      const who = env.signers[f.signer] ? firstName(env.signers[f.signer].name) : '';
      el.innerHTML = `<span class="es-field-label"></span>`;
      el.querySelector('span')!.textContent = f.type === 'checkbox' ? '' : `${FIELD_LABELS[f.type]}${f.signer === me ? '' : ` · ${who}`}`;
    }
    box.appendChild(el);
  }
}

function fillMine(el: HTMLElement, f: Field): void {
  const v = values[f.id];
  el.classList.toggle('is-done', !!v);
  el.textContent = '';
  if (f.type === 'date') {
    // Filled in for you with today's date.
    const text = formatDate(Date.now());
    values[f.id] = { png: '', text };
    el.classList.add('is-done');
    el.innerHTML = '<span class="es-field-text"></span>';
    el.querySelector('span')!.textContent = text;
    return;
  }
  if (f.type === 'name' || f.type === 'text') {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 200;
    input.placeholder = f.type === 'name' ? 'Your full name' : f.label || 'Type here';
    input.value = v?.text ?? (f.type === 'name' ? env.signers[me].name : '');
    if (input.value) values[f.id] = { png: '', text: input.value };
    el.classList.toggle('is-done', !!input.value);
    input.addEventListener('input', () => {
      const t = input.value.trim();
      if (t) values[f.id] = { png: '', text: t };
      else delete values[f.id];
      el.classList.toggle('is-done', !!t);
      updateBar();
    });
    el.appendChild(input);
    return;
  }
  if (f.type === 'checkbox') {
    if (v?.checked) el.innerHTML = '<i class="ph ph-check es-check"></i>';
    el.onclick = () => {
      if (values[f.id]?.checked) delete values[f.id];
      else values[f.id] = { png: '', checked: true };
      fillMine(el, f);
      updateBar();
    };
    return;
  }
  // Signature or initials.
  if (v?.png) {
    el.innerHTML = '<img alt="" />';
    el.querySelector('img')!.src = v.png;
  } else {
    el.innerHTML = `<span class="es-field-label"></span>`;
    el.querySelector('span')!.textContent = f.type === 'signature' ? 'Tap to sign' : 'Initials';
  }
  el.onclick = () => {
    const kind = f.type as 'signature' | 'initials';
    if (adopted[kind] && !v) {
      values[f.id] = { png: adopted[kind] };
      fillMine(el, f);
      updateBar();
      return;
    }
    void adopt(kind).then((png) => {
      if (!png) return;
      // A new signature replaces it everywhere it is already used.
      for (const g of myFields()) if (g.type === kind && values[g.id]) values[g.id] = { png };
      values[f.id] = { png };
      refreshMine();
      updateBar();
    });
  };
  el.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.click();
    }
  };
}

function refreshMine(): void {
  for (const f of myFields()) {
    const el = document.querySelector<HTMLElement>(`#es-pages .es-field[data-id="${f.id}"]`);
    if (el && el.classList.contains('es-mine')) fillMine(el, f);
  }
}

// ------------------------------------------------------------------ adopt a signature

function adopt(kind: 'signature' | 'initials'): Promise<string | null> {
  return new Promise((resolve) => {
    const name = env.signers[me].name;
    const wrap = document.createElement('div');
    wrap.className = 'es-modal-wrap';
    wrap.innerHTML = `
      <div class="es-modal" role="dialog" aria-modal="true" aria-labelledby="es-adopt-title">
        <h3 class="es-h2" id="es-adopt-title">${kind === 'signature' ? 'Your signature' : 'Your initials'}</h3>
        <div class="es-tabs" role="tablist">
          <button type="button" data-tab="type" class="is-on">Type</button>
          <button type="button" data-tab="draw">Draw</button>
        </div>
        <div data-pane="type">
          <input class="es-input" type="text" maxlength="80" />
          <div class="es-styles"></div>
        </div>
        <div data-pane="draw" class="hidden">
          <canvas class="es-pad"></canvas>
          <div class="es-row" style="justify-content:space-between;margin-top:0.4rem">
            <span class="es-sub">Draw with your finger, a pen or the mouse.</span>
            <button type="button" class="es-btn es-small" data-clear>Clear</button>
          </div>
        </div>
        <div class="es-row" style="justify-content:flex-end;margin-top:1rem">
          <button type="button" class="es-btn" data-cancel>Cancel</button>
          <button type="button" class="es-btn es-primary" data-ok>Use this</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    document.body.classList.add('es-noscroll');
    const input = wrap.querySelector<HTMLInputElement>('input')!;
    const styles = wrap.querySelector<HTMLElement>('.es-styles')!;
    const pad = wrap.querySelector<HTMLCanvasElement>('canvas')!;
    let tab = 'type';
    let font = SCRIPT_FONTS[0];
    let drawn = false;
    input.value = kind === 'signature' ? name : initialsOf(name);

    const drawStyles = () => {
      styles.textContent = '';
      for (const f of SCRIPT_FONTS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'es-style' + (f === font ? ' is-on' : '');
        b.innerHTML = `<span class="${kind === 'signature' ? 'es-sig' : 'es-sig es-ini'}"></span>`;
        const s = b.querySelector('span')!;
        s.style.fontFamily = `"${f}", cursive`;
        s.textContent = input.value || ' ';
        b.onclick = () => {
          font = f;
          drawStyles();
        };
        styles.appendChild(b);
      }
    };
    drawStyles();
    input.addEventListener('input', drawStyles);

    // Drawing pad, sized to the screen's pixels.
    const ctx = pad.getContext('2d')!;
    const sizePad = () => {
      const r = pad.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      pad.width = Math.round(r.width * dpr);
      pad.height = Math.round(r.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#14213d';
      drawn = false;
    };
    let last: { x: number; y: number } | null = null;
    pad.addEventListener('pointerdown', (e) => {
      pad.setPointerCapture(e.pointerId);
      const r = pad.getBoundingClientRect();
      last = { x: e.clientX - r.left, y: e.clientY - r.top };
      ctx.beginPath();
      ctx.arc(last.x, last.y, 1.2, 0, Math.PI * 2);
      ctx.fillStyle = '#14213d';
      ctx.fill();
      drawn = true;
    });
    pad.addEventListener('pointermove', (e) => {
      if (!last) return;
      const r = pad.getBoundingClientRect();
      const p = { x: e.clientX - r.left, y: e.clientY - r.top };
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
    });
    const end = (): void => {
      last = null;
    };
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);

    wrap.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        tab = b.dataset.tab!;
        wrap.querySelectorAll<HTMLElement>('[data-tab]').forEach((x) => x.classList.toggle('is-on', x === b));
        wrap.querySelectorAll<HTMLElement>('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab));
        if (tab === 'draw') sizePad();
      })
    );
    wrap.querySelector<HTMLElement>('[data-clear]')!.onclick = sizePad;

    const close = (png: string | null) => {
      wrap.remove();
      document.body.classList.remove('es-noscroll');
      document.removeEventListener('keydown', onKey);
      resolve(png);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close(null);
    });
    wrap.querySelector<HTMLElement>('[data-cancel]')!.onclick = () => close(null);
    wrap.querySelector<HTMLElement>('[data-ok]')!.onclick = async () => {
      let png: string;
      if (tab === 'type') {
        const text = input.value.trim();
        if (!text) return toast(kind === 'signature' ? 'Type your name' : 'Type your initials');
        png = await typedPng(text, font);
      } else {
        if (!drawn) return toast('Draw your signature first');
        png = trimPng(pad);
      }
      adopted[kind] = png;
      close(png);
    };
    setTimeout(() => input.focus(), 50);
  });
}

// ------------------------------------------------------------------ the bottom bar

function missing(): Field[] {
  return myFields()
    .filter((f) => f.required && !values[f.id])
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
}

function updateBar(): void {
  const bar = $('es-bar');
  bar.classList.toggle('hidden', !canSign);
  document.body.classList.toggle('es-has-bar', canSign);
  if (!canSign) return;
  const req = myFields().filter((f) => f.required).length;
  const left = missing().length;
  $('es-progress').textContent = left ? `${req - left} of ${req} required fields done` : 'All set. Press Finish.';
  $<HTMLButtonElement>('es-finish').disabled = left > 0;
  $('es-next').classList.toggle('hidden', left === 0);
}

function goNext(): void {
  const f = missing()[0];
  if (!f) return;
  const el = document.querySelector<HTMLElement>(`#es-pages .es-field[data-id="${f.id}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 500, delay: 300 });
  el.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ finish and decline

function confirmFinish(): Promise<boolean> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'es-modal-wrap';
    wrap.innerHTML = `
      <div class="es-modal" role="dialog" aria-modal="true">
        <h3 class="es-h2" data-title></h3>
        <label class="es-check-row" style="margin:0.6rem 0 1rem"><input type="checkbox" /> <span data-consent></span></label>
        <div class="es-row" style="justify-content:flex-end">
          <button type="button" class="es-btn" data-v="0">Back</button>
          <button type="button" class="es-btn es-primary" data-v="1" disabled><i class="ph ph-signature"></i> Sign</button>
        </div>
      </div>`;
    wrap.querySelector('[data-title]')!.textContent = `Sign “${env.title}”`;
    wrap.querySelector('[data-consent]')!.textContent = CONSENT;
    const box = wrap.querySelector<HTMLInputElement>('input')!;
    const ok = wrap.querySelector<HTMLButtonElement>('[data-v="1"]')!;
    box.onchange = () => (ok.disabled = !box.checked);
    wrap.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-v]');
      if (!b && e.target !== wrap) return;
      if (b?.dataset.v === '1' && !box.checked) return;
      wrap.remove();
      resolve(b?.dataset.v === '1');
    });
    document.body.appendChild(wrap);
  });
}

async function finish(): Promise<void> {
  if (missing().length) return goNext();
  if (!(await confirmFinish())) return;
  busy('Signing...');
  try {
    // Every value becomes a picture sized to its box, so any language or script prints right.
    const out: Submission = {
      values: {},
      signedName: env.signers[me].name,
      consent: CONSENT,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    };
    for (const f of myFields()) {
      const v = values[f.id];
      if (!v) continue;
      const el = document.querySelector<HTMLElement>(`#es-pages .es-field[data-id="${f.id}"]`);
      const w = el?.clientWidth || 200;
      const h = el?.clientHeight || 30;
      if (f.type === 'checkbox') out.values[f.id] = { png: v.checked ? checkPng() : '', checked: !!v.checked };
      else if (v.text !== undefined) out.values[f.id] = { png: textPng(v.text, w, h), text: v.text };
      else out.values[f.id] = { png: v.png };
    }
    state = await api.sign(link.id, link.token, await encrypt(link.key, JSON.stringify(out)));
    subs[me] = out;
    decide();
    renderPeople();
    renderFields();
    updateBar();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast(state.status === 'complete' ? 'Signed. Everyone is done.' : 'Signed. Thank you.');
  } catch (err) {
    const e = err as ApiError;
    if (e.code === 'already_signed') {
      toast('You had already signed');
      await reload();
    } else if (e.code === 'not_your_turn') {
      await reload();
    } else if (e.code === 'declined' || e.status === 404) {
      await reload();
    } else {
      toast('Could not sign. Check your connection and try again.');
    }
  } finally {
    busy(null);
  }
}

async function decline(): Promise<void> {
  const reason = await new Promise<string | null>((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'es-modal-wrap';
    wrap.innerHTML = `
      <div class="es-modal" role="dialog" aria-modal="true">
        <h3 class="es-h2">Decline to sign?</h3>
        <p class="es-sub" style="margin-bottom:0.8rem">This closes the request for everyone. <span data-who></span> will see that you declined.</p>
        <label class="es-label">Reason (optional)<textarea class="es-textarea" maxlength="500"></textarea></label>
        <div class="es-row" style="justify-content:flex-end;margin-top:1rem">
          <button type="button" class="es-btn" data-v="0">Back</button>
          <button type="button" class="es-btn es-primary es-danger-fill" data-v="1">Decline</button>
        </div>
      </div>`;
    wrap.querySelector('[data-who]')!.textContent = env.sender.name;
    wrap.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-v]');
      if (!b && e.target !== wrap) return;
      const text = wrap.querySelector('textarea')!.value.trim();
      wrap.remove();
      resolve(b?.dataset.v === '1' ? text : null);
    });
    document.body.appendChild(wrap);
  });
  if (reason === null) return;
  busy('Declining...');
  try {
    state = await api.decline(link.id, link.token, reason ? await encrypt(link.key, reason) : null);
    decide();
    renderPeople();
    renderFields();
    updateBar();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch {
    await reload();
  } finally {
    busy(null);
  }
}

async function reload(): Promise<void> {
  try {
    state = await api.state(link.id, link.token);
    await loadSubs();
  } catch {
    /* keep what is shown */
  }
  decide();
  renderPeople();
  renderFields();
  updateBar();
}

async function download(): Promise<void> {
  busy('Building the signed PDF...');
  try {
    await loadSubs();
    downloadBytes(await buildSignedPdf(doc, env, state, subs), signedName(env));
  } catch (err) {
    console.error(err);
    toast('Could not build the PDF. Reload and try again.');
  } finally {
    busy(null);
  }
}

// ------------------------------------------------------------------ wire up

function init(): void {
  // A reload loses the address's # part (it is removed for privacy), so keep it for this tab.
  if (!location.hash) {
    try {
      const saved = sessionStorage.getItem('paperhaus-esign-link');
      if (saved) history.replaceState(null, '', `${location.pathname}#${saved}`);
    } catch {
      /* private mode */
    }
  }
  $('es-next').addEventListener('click', goNext);
  $('es-finish').addEventListener('click', () => void finish());
  $('es-decline').addEventListener('click', () => void decline());
  $('es-download').addEventListener('click', () => void download());
  let t = 0;
  let lastW = window.innerWidth;
  window.addEventListener('resize', () => {
    if (Math.abs(window.innerWidth - lastW) < 40 || !doc) return;
    lastW = window.innerWidth;
    clearTimeout(t);
    t = window.setTimeout(async () => {
      const pdf = await openPdf(doc);
      await renderPages(pdf, $('es-pages'));
      pdf.destroy();
      renderFields();
    }, 300);
  });
  void start();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
