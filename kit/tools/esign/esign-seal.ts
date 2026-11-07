/**
 * Paperhaus e-sign: the seal. Adds an invisible certificate signature slot to a finished
 * PDF, hashes the file around it, has the server sign that hash (see
 * functions/_shared/seal.js) and writes the signature in. No browser-only imports, so it
 * can be tested on its own.
 */
import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';

export interface SealResult {
  cms: string;
  signedAt: number;
  timestamp: { by: string; at: number | null } | null;
  cert: string;
}

const SEAL_BYTES = 24576; // room for the CMS signature with its timestamp token
const BR_MARK = '**********';

function latin1(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return s;
}

function toHex(u: Uint8Array): string {
  let s = '';
  for (const b of u) s += b.toString(16).padStart(2, '0');
  return s;
}

function stdB64(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/**
 * Add the Paperhaus seal: an invisible certificate signature over the whole file. Only
 * the SHA-256 of the file (around the signature slot) is sent to be signed.
 */
export async function sealPdf(bytes: Uint8Array, sign: (digestHex: string) => Promise<SealResult>): Promise<{ pdf: Uint8Array; seal: SealResult }> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = pdf.getPages();
  const page = pages[pages.length - 1];
  const ctx = pdf.context;
  const sig = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, PDFName.of(BR_MARK), PDFName.of(BR_MARK), PDFName.of(BR_MARK)],
    Contents: PDFHexString.of('0'.repeat(SEAL_BYTES * 2)),
    Reason: PDFString.of('Everyone signed. Sealed by Paperhaus.'),
    Name: PDFString.of('Paperhaus Seal'),
    M: PDFString.fromDate(new Date()),
  });
  const sigRef = ctx.register(sig);
  const widget = ctx.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: [0, 0, 0, 0],
    V: sigRef,
    T: PDFString.of('Paperhaus seal'),
    F: 132,
    P: page.ref,
  });
  const widgetRef = ctx.register(widget);
  page.node.addAnnot(widgetRef);
  const form = pdf.getForm();
  form.acroForm.addField(widgetRef);
  form.acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  const out = await pdf.save({ useObjectStreams: false, updateFieldAppearances: false });

  const text = latin1(out);
  const br = /\/ByteRange\s*\[\s*0\s+\/\*{10}\s+\/\*{10}\s+\/\*{10}\s*\]/.exec(text);
  const slot = `<${'0'.repeat(SEAL_BYTES * 2)}>`;
  const at = text.indexOf(slot);
  if (!br || at < 0) throw new Error('Could not add the seal to this PDF.');
  const a = at;
  const b = at + slot.length;
  const range = `/ByteRange [0 ${a} ${b} ${out.length - b}]`;
  if (range.length > br[0].length) throw new Error('Could not add the seal to this PDF.');
  out.set(new TextEncoder().encode(range.padEnd(br[0].length, ' ')), br.index);
  const signed = new Uint8Array(a + (out.length - b));
  signed.set(out.subarray(0, a), 0);
  signed.set(out.subarray(b), a);
  const digest = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', signed)));
  const seal = await sign(digest);
  const cms = toHex(stdB64(seal.cms));
  if (cms.length > SEAL_BYTES * 2) throw new Error('The seal is larger than expected.');
  out.set(new TextEncoder().encode(cms), a + 1);
  return { pdf: out, seal };
}

