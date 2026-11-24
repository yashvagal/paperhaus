/** Paperhaus: ZIP Files. Make a ZIP from any files, or open a ZIP and take files out. */
import JSZip from 'jszip';
import { $, backToTools, onReady, fileList, save, busy, alertBox, size, baseName, tick } from './shrink-common.js';

const isZip = (f: File): boolean => /\.zip$/i.test(f.name) || /zip/.test(f.type);
const mode = (): string => (document.querySelector<HTMLInputElement>('input[name="zmode"]:checked') || { value: 'make' }).value;

onReady(() => {
  backToTools();
  const go = $<HTMLButtonElement>('sh-go');
  const nameBox = $<HTMLInputElement>('sh-zip-name');
  const { items } = fileList({
    accept: () => true,
    wrong: '',
    onChange: () => {
      // A single ZIP added means "open it".
      if (items.length === 1 && isZip(items[0].file) && mode() === 'make') {
        document.querySelector<HTMLInputElement>('input[name="zmode"][value="open"]')!.checked = true;
      }
      sync();
    },
  });
  const sync = () => {
    const open = mode() === 'open';
    $('sh-zip-name-box').classList.toggle('sh-hidden', open);
    go.innerHTML = open ? '<i class="ph ph-folder-open"></i> Open the ZIP' : '<i class="ph ph-file-zip"></i> Make the ZIP';
    const zips = items.filter((i) => isZip(i.file)).length;
    go.disabled = open ? !zips : !items.length;
    const total = items.reduce((n, i) => n + i.file.size, 0);
    $('sh-hint').textContent = items.length ? `${items.length} ${items.length === 1 ? 'file' : 'files'}, ${size(total)}` : '';
    if (!open && items.length && !nameBox.value) nameBox.placeholder = items.length === 1 ? baseName(items[0].file.name) : 'Files';
  };
  document.querySelectorAll('input[name="zmode"]').forEach((r) => r.addEventListener('change', sync));
  sync();

  go.onclick = async () => {
    go.disabled = true;
    try {
      if (mode() === 'make') {
        busy('Making the ZIP...', 0);
        const zip = new JSZip();
        const used = new Set<string>();
        for (const it of items) {
          let name = it.file.name;
          for (let i = 2; used.has(name.toLowerCase()); i++) name = `${baseName(it.file.name)} (${i})${it.file.name.slice(baseName(it.file.name).length)}`;
          used.add(name.toLowerCase());
          zip.file(name, it.file);
        }
        const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } }, (m) => busy('Making the ZIP...', m.percent / 100));
        const name = `${(nameBox.value.trim() || nameBox.placeholder || 'Files').replace(/[\\/:*?"<>|]+/g, ' ').trim()}.zip`;
        save(blob, name);
        showDone(`${name} · ${size(blob.size)}`, () => save(blob, name), 'Download the ZIP');
      } else {
        const out: { name: string; blob: Blob }[] = [];
        for (const it of items.filter((i) => isZip(i.file))) {
          busy(`Opening ${it.file.name}...`);
          await tick();
          let zip: JSZip;
          try {
            zip = await JSZip.loadAsync(it.file);
          } catch {
            alertBox('Could not open this ZIP', `${it.file.name} may be damaged or password protected.`);
            continue;
          }
          const files = Object.values(zip.files).filter((f) => !f.dir && !/(^|\/)(__MACOSX|\.DS_Store)/.test(f.name));
          for (let i = 0; i < files.length; i++) {
            busy(`Taking out ${i + 1} of ${files.length}...`, i / files.length);
            out.push({ name: files[i].name.split('/').pop() || files[i].name, blob: await files[i].async('blob') });
          }
        }
        busy(null);
        listOut(out);
      }
    } finally {
      busy(null);
      go.disabled = false;
    }
  };

  function showDone(text: string, onDl: () => void, label: string) {
    $('sh-done').classList.remove('hidden');
    $('sh-total').textContent = text;
    const all = $<HTMLButtonElement>('sh-all');
    all.innerHTML = `<i class="ph ph-download-simple"></i> ${label}`;
    all.onclick = onDl;
  }

  /** The files taken out of a ZIP, each with its own Download. */
  function listOut(out: { name: string; blob: Blob }[]) {
    const box = $('sh-done');
    box.classList.remove('hidden');
    $('sh-total').textContent = out.length ? `${out.length} ${out.length === 1 ? 'file' : 'files'} inside` : 'The ZIP is empty';
    const all = $<HTMLButtonElement>('sh-all');
    all.classList.toggle('sh-hidden', out.length < 2);
    all.innerHTML = '<i class="ph ph-download-simple"></i> Download all';
    all.onclick = async () => {
      for (const f of out) {
        save(f.blob, f.name);
        await new Promise((r) => setTimeout(r, 350));
      }
    };
    box.querySelector('.sh-list')?.remove();
    const list = document.createElement('div');
    list.className = 'sh-list';
    list.style.marginTop = '0.8rem';
    for (const f of out.slice(0, 500)) {
      const row = document.createElement('div');
      row.className = 'sh-row';
      row.innerHTML = '<span class="sh-thumb"><i class="ph ph-file"></i></span><div class="sh-info"><strong></strong><span class="sh-meta"></span></div><div class="sh-acts"><button type="button" class="es-btn es-small"><i class="ph ph-download-simple"></i> Download</button></div>';
      row.querySelector('strong')!.textContent = f.name;
      row.querySelector('.sh-meta')!.textContent = size(f.blob.size);
      row.querySelector('button')!.onclick = () => save(f.blob, f.name);
      list.appendChild(row);
    }
    box.insertBefore(list, box.querySelector('.sh-help'));
  }
});
