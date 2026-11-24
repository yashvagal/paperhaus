/**
 * Paperhaus: QR Code Generator. Links, Wi-Fi, contact cards (vCard), email, phone and text.
 * The code holds the details itself (no short link through a service), so it never expires.
 * PNG, SVG or a one-page PDF; colours, size and damage tolerance.
 */
import QRCode from 'qrcode';
import { $, backToTools, onReady, save, toast } from './shrink-common.js';

const v = (id: string): string => ($<HTMLInputElement>(id)?.value || '').trim();
const kind = (): string => (document.querySelector<HTMLInputElement>('input[name="kind"]:checked') || { value: 'url' }).value;
// Wi-Fi and vCard text need some characters escaped.
const wifiEsc = (s: string): string => s.replace(/([\\;,:"])/g, '\\$1');
const vEsc = (s: string): string => s.replace(/([\\;,])/g, '\\$1').replace(/\n/g, '\\n');

function payload(): string {
  switch (kind()) {
    case 'url': {
      const u = v('qr-url');
      if (!u) return '';
      return /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`;
    }
    case 'wifi': {
      const ssid = v('qr-ssid');
      if (!ssid) return '';
      const sec = $<HTMLSelectElement>('qr-wsec').value;
      const pass = sec === 'nopass' ? '' : `P:${wifiEsc(v('qr-wpass'))};`;
      return `WIFI:T:${sec};S:${wifiEsc(ssid)};${pass}${$<HTMLInputElement>('qr-whidden').checked ? 'H:true;' : ''};`;
    }
    case 'contact': {
      const fn = v('qr-fn');
      const ln = v('qr-ln');
      if (!fn && !ln && !v('qr-cphone') && !v('qr-cemail')) return '';
      const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${vEsc(ln)};${vEsc(fn)};;;`, `FN:${vEsc([fn, ln].filter(Boolean).join(' '))}`];
      if (v('qr-org')) lines.push(`ORG:${vEsc(v('qr-org'))}`);
      if (v('qr-title')) lines.push(`TITLE:${vEsc(v('qr-title'))}`);
      if (v('qr-cphone')) lines.push(`TEL;TYPE=CELL:${v('qr-cphone')}`);
      if (v('qr-cemail')) lines.push(`EMAIL:${v('qr-cemail')}`);
      if (v('qr-cweb')) lines.push(`URL:${v('qr-cweb')}`);
      lines.push('END:VCARD');
      return lines.join('\n');
    }
    case 'email': {
      const to = v('qr-to');
      if (!to) return '';
      const q = new URLSearchParams();
      if (v('qr-subj')) q.set('subject', v('qr-subj'));
      if (v('qr-body')) q.set('body', v('qr-body'));
      const qs = q.toString().replace(/\+/g, '%20');
      return `mailto:${to}${qs ? `?${qs}` : ''}`;
    }
    case 'phone': {
      const num = v('qr-num').replace(/[^\d+]/g, '');
      if (!num) return '';
      const sms = (document.querySelector<HTMLInputElement>('input[name="ptype"]:checked') || { value: 'tel' }).value === 'sms';
      return sms ? `SMSTO:${num}:${v('qr-sms')}` : `tel:${num}`;
    }
    default:
      return v('qr-text');
  }
}

function opts(width: number) {
  const clear = $<HTMLInputElement>('qr-clear').checked;
  return {
    errorCorrectionLevel: $<HTMLSelectElement>('qr-ecc').value as 'L' | 'M' | 'Q' | 'H',
    margin: 2,
    width,
    color: { dark: $<HTMLInputElement>('qr-dark').value, light: clear ? '#0000' : $<HTMLInputElement>('qr-light').value },
  };
}

function fileName(): string {
  const k = kind();
  const label =
    k === 'url' ? v('qr-url').replace(/^https?:\/\//, '').split('/')[0] : k === 'wifi' ? `wifi ${v('qr-ssid')}` : k === 'contact' ? [v('qr-fn'), v('qr-ln')].join(' ') : k === 'email' ? v('qr-to') : k === 'phone' ? v('qr-num') : 'text';
  return `QR ${label}`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

onReady(() => {
  backToTools();
  const canvas = $<HTMLCanvasElement>('qr-canvas');
  const buttons = ['qr-png', 'qr-svg', 'qr-pdf'].map((id) => $<HTMLButtonElement>(id));
  let text = '';
  let timer = 0;

  const draw = async () => {
    text = payload();
    $('qr-empty').classList.toggle('sh-hidden', !!text);
    canvas.style.visibility = text ? 'visible' : 'hidden';
    buttons.forEach((b) => (b.disabled = !text));
    if (!text) return;
    try {
      await QRCode.toCanvas(canvas, text, opts(600));
      // The library sets a fixed pixel size; let the preview box size it.
      canvas.style.width = '100%';
      canvas.style.height = '100%';
    } catch {
      toast('That is too much for one QR code. Shorten it.');
      buttons.forEach((b) => (b.disabled = true));
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = window.setTimeout((): void => {
      void draw();
    }, 120);
  };

  const showKind = () => {
    document.querySelectorAll<HTMLElement>('.qr-fields').forEach((f) => f.classList.toggle('sh-hidden', f.dataset.kind !== kind()));
    later();
  };
  document.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener('change', showKind));
  document.querySelectorAll('input[name="ptype"]').forEach((r) =>
    r.addEventListener('change', () => {
      document.querySelector('.qr-sms')!.classList.toggle('sh-hidden', (document.querySelector<HTMLInputElement>('input[name="ptype"]:checked') || { value: '' }).value !== 'sms');
      later();
    })
  );
  document.querySelector('main')!.addEventListener('input', later);
  document.querySelector('main')!.addEventListener('change', later);
  // Prefill from ?text= or ?url= (for example from another tool).
  const qp = new URLSearchParams(location.search);
  if (qp.get('url')) $<HTMLInputElement>('qr-url').value = qp.get('url')!;
  showKind();

  $('qr-png').onclick = async () => {
    const size = Number($<HTMLSelectElement>('qr-size').value);
    const c = document.createElement('canvas');
    await QRCode.toCanvas(c, text, opts(size));
    c.toBlob((b) => b && save(b, `${fileName()}.png`), 'image/png');
  };
  $('qr-svg').onclick = async () => {
    const svg = await QRCode.toString(text, { ...opts(Number($<HTMLSelectElement>('qr-size').value)), type: 'svg' });
    save(new Blob([svg], { type: 'image/svg+xml' }), `${fileName()}.svg`);
  };
  $('qr-pdf').onclick = async () => {
    // A one-page PDF with the code centred, 8 cm wide: ready to print.
    const { PDFDocument } = await import('pdf-lib');
    const c = document.createElement('canvas');
    await QRCode.toCanvas(c, text, { ...opts(1200), color: { dark: $<HTMLInputElement>('qr-dark').value, light: $<HTMLInputElement>('qr-light').value } });
    const png = await new Promise<Blob>((ok) => c.toBlob((b) => ok(b as Blob), 'image/png'));
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);
    const img = await doc.embedPng(new Uint8Array(await png.arrayBuffer()));
    const w = 226.77; // 8 cm
    page.drawImage(img, { x: (595.28 - w) / 2, y: (841.89 - w) / 2, width: w, height: w });
    save(new Blob([(await doc.save()) as BlobPart], { type: 'application/pdf' }), `${fileName()}.pdf`);
  };
});
