/* Paperhaus: My documents. Every file you made (kit/tools/pin/flow.js keeps them, synced to
 * your account) grouped by the tool that made it, plus the documents you sent for signature.
 * Plain module; the data helpers come from window.paperhausFlow. */
import './documents.css';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const x = document.createElement(tag);
  if (cls) x.className = cls;
  if (text != null) x.textContent = text;
  return x;
};
let filter = 'all';
let files = [];
let sent = [];

function flowReady() {
  return new Promise((resolve) => {
    let n = 0;
    (function wait() {
      if (window.paperhausFlow && window.paperhausFlow.listAll) return resolve(window.paperhausFlow);
      if (++n > 60) return resolve(null);
      setTimeout(wait, 100);
    })();
  });
}

const size = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
function when(t) {
  const d = new Date(t);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? 'Today, ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
const toolOf = (r) => (r.tool || '').trim() || 'Other';

function toast(text) {
  const t = $('#dc-toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

function matches(name) {
  const q = ($('#dc-search').value || '').trim().toLowerCase();
  return !q || String(name || '').toLowerCase().includes(q);
}

function renderFilters() {
  const host = $('#dc-filters');
  host.textContent = '';
  const counts = {};
  files.forEach((r) => (counts[toolOf(r)] = (counts[toolOf(r)] || 0) + 1));
  const chips = [['all', `All (${files.length + sent.length})`]];
  if (sent.length) chips.push(['sign', `Sent for signature (${sent.length})`]);
  Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))
    .forEach((t) => chips.push([t, `${t} (${counts[t]})`]));
  if (!chips.some((c) => c[0] === filter)) filter = 'all';
  chips.forEach(([key, label]) => {
    const b = el('button', 'dc-filter', label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(key === filter));
    b.onclick = () => {
      filter = key;
      render();
    };
    host.appendChild(b);
  });
}

function render() {
  renderFilters();
  renderSign();
  renderGroups();
}

// ---------------------------------------------------------------- files, by tool
function renderGroups() {
  const host = $('#dc-groups');
  host.textContent = '';
  if (filter === 'sign') return;
  const shown = files.filter((r) => matches(r.name) && (filter === 'all' || toolOf(r) === filter));
  if (!shown.length) {
    const card = el('section', 'dc-card');
    card.appendChild(el('h2', 'dc-empty-title', files.length ? 'No files match' : 'No files yet'));
    card.appendChild(
      el('p', 'dc-muted', files.length ? 'Try another name, or show All.' : 'When you save a file from any tool (compress, merge, convert, sign and more), it shows up here on all your devices.')
    );
    if (!files.length) {
      const a = el('a', 'dc-btn dc-btn-main', 'Start with a file');
      a.href = '/';
      card.appendChild(a);
    }
    host.appendChild(card);
    return;
  }
  const groups = {};
  shown.forEach((r) => (groups[toolOf(r)] = groups[toolOf(r)] || []).push(r));
  Object.keys(groups)
    .sort((a, b) => groups[b][0].at - groups[a][0].at)
    .forEach((tool) => {
      const card = el('section', 'dc-card');
      const head = el('div', 'dc-card-head');
      head.appendChild(el('h2', '', tool));
      head.appendChild(el('span', 'dc-count', groups[tool].length === 1 ? '1 file' : groups[tool].length + ' files'));
      card.appendChild(head);
      groups[tool].forEach((r) => card.appendChild(fileRow(r)));
      host.appendChild(card);
    });
}

function fileRow(r) {
  const flow = window.paperhausFlow;
  const row = el('div', 'dc-row');
  const badge = el('span', 'dc-badge', ((r.name.split('.').pop() || 'file').slice(0, 4) || 'file').toUpperCase());
  row.appendChild(badge);
  const info = el('div', 'dc-info');
  info.appendChild(el('strong', '', r.name));
  info.appendChild(el('span', '', [when(r.at), r.size ? size(r.size) : '', r.remote ? 'on another device' : ''].filter(Boolean).join(' · ')));
  row.appendChild(info);
  const acts = el('div', 'dc-acts');
  const get = () => (r.blob ? Promise.resolve(r) : flow.getAny(r.id));
  const open = el('button', 'dc-btn dc-btn-main', 'Open');
  open.type = 'button';
  open.title = 'Open it and use any tool on it';
  open.onclick = () => (location.href = '/view-document.html?id=' + encodeURIComponent(r.id));
  const save = (rec) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(rec.blob);
    a.download = rec.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 2000);
  };
  const dl = el('button', 'dc-btn', 'Download');
  dl.type = 'button';
  dl.onclick = () => {
    dl.disabled = true;
    get()
      .then((rec) => {
        if (!rec || !rec.blob) throw new Error('missing');
        save(rec);
      })
      .catch(() => toast('That file is not available right now.'))
      .finally(() => (dl.disabled = false));
  };
  // Share: the phone's Share sheet (Messages, WhatsApp, Mail...). Shown where the browser can share.
  const sh = el('button', 'dc-btn', 'Share');
  sh.type = 'button';
  sh.hidden = !navigator.share;
  let ready = null;
  const share = (rec) =>
    flow.shareFile(rec.blob, rec.name, rec.type).then((res) => {
      if (res === 'again') {
        // The file had to come from another device first; one more tap opens the Share sheet.
        ready = rec;
        sh.textContent = 'Tap to share';
        return;
      }
      ready = null;
      sh.textContent = 'Share';
      if (res === 'none') {
        save(rec);
        toast('This browser cannot share files, so it was downloaded instead.');
      }
    });
  sh.onclick = () => {
    if (ready) return share(ready);
    if (r.blob) return share(r);
    sh.disabled = true;
    sh.textContent = 'Getting it...';
    flow
      .getAny(r.id)
      .then((rec) => {
        if (!rec || !rec.blob) throw new Error('missing');
        sh.disabled = false;
        return share(rec);
      })
      .catch(() => {
        sh.disabled = false;
        sh.textContent = 'Share';
        toast('That file is not available right now.');
      });
  };
  const rm = el('button', 'dc-btn dc-btn-quiet', 'Remove');
  rm.type = 'button';
  rm.onclick = () => {
    if (!rm.classList.contains('is-sure')) {
      rm.classList.add('is-sure');
      rm.textContent = 'Remove from all devices?';
      return;
    }
    rm.disabled = true;
    flow.removeFile(r.id).then(() => {
      files = files.filter((x) => x.id !== r.id);
      toast('Removed');
      render();
    });
  };
  acts.append(open, dl, sh, rm);
  row.appendChild(acts);
  return row;
}

// ---------------------------------------------------------------- sent for signature
function renderSign() {
  const card = $('#dc-sign-card');
  const host = $('#dc-sign');
  const show = filter === 'all' || filter === 'sign';
  card.hidden = !show;
  if (!show) return;
  host.textContent = '';
  const list = sent.filter((s) => matches(s.title));
  if (!list.length) {
    host.appendChild(el('p', 'dc-muted', sent.length ? 'No documents match.' : 'Nothing sent yet. Use Sign to send a PDF to someone to sign, and follow it here.'));
    if (!sent.length) {
      const a = el('a', 'dc-btn', 'Send a PDF for signature');
      a.href = 'request-signatures.html';
      host.appendChild(a);
    }
    return;
  }
  (filter === 'sign' ? list : list.slice(0, 5)).forEach((s) => {
    const row = el('a', 'dc-row dc-row-link');
    row.href = 'request-signatures.html#documents';
    const dot = el('span', 'dc-dot');
    row.appendChild(dot);
    const info = el('div', 'dc-info');
    info.appendChild(el('strong', '', s.title || 'Document'));
    const line = el('span', '', 'Checking...');
    info.appendChild(line);
    row.appendChild(info);
    row.appendChild(el('i', 'ph ph-caret-right dc-go'));
    host.appendChild(row);
    status(s).then((st) => {
      line.textContent = st.text + ' · sent ' + when(s.createdAt);
      dot.className = 'dc-dot is-' + st.kind;
    });
  });
  if (filter !== 'sign' && list.length > 5) {
    const more = el('button', 'dc-btn dc-btn-quiet', `Show all ${list.length}`);
    more.type = 'button';
    more.onclick = () => {
      filter = 'sign';
      render();
    };
    host.appendChild(more);
  }
}

const statusCache = {};
function status(s) {
  if (!statusCache[s.id]) {
    statusCache[s.id] = fetch('/api/esign/p/' + encodeURIComponent(s.id) + '?t=' + encodeURIComponent(s.senderToken), { cache: 'no-store' })
      .then((r) => (r.status === 404 ? { status: 'gone' } : r.json()))
      .then((st) => {
        const n = st.n || (s.signers || []).length;
        const done = (st.signers || []).filter((x) => x.signed).length;
        const text =
          {
            complete: 'Signed by everyone',
            out: `Waiting · ${done} of ${n} signed`,
            cancelled: 'Cancelled · you can undo it in Sign',
            declined: 'Declined',
            expired: 'Time ran out',
            gone: 'Deleted',
          }[st.status] || '';
        return { text, kind: st.status || 'gone' };
      })
      .catch(() => ({ text: '', kind: 'gone' }));
  }
  return statusCache[s.id];
}

// ---------------------------------------------------------------- load
async function load() {
  const flow = await flowReady();
  if (!flow) {
    $('#dc-groups').appendChild(el('p', 'dc-muted', 'Your documents are not available in this browser window.'));
    return;
  }
  const params = new URLSearchParams(location.search);
  if (params.get('tool')) filter = params.get('tool');
  const [all, local, remote] = await Promise.all([
    flow.listAll().catch(() => []),
    flow.localSent ? flow.localSent().catch(() => []) : [],
    flow.listRecords ? flow.listRecords('sent').catch(() => []) : [],
  ]);
  files = all.filter((r) => r.kept);
  const byId = {};
  const gone = {};
  remote.forEach((r) => {
    if (r && r.gone) gone[r.id] = 1;
    else if (r && r.id && r.senderToken) byId[r.id] = r;
  });
  local.forEach((r) => r && r.id && (byId[r.id] = r));
  const now = Date.now();
  sent = Object.values(byId)
    .filter((s) => !gone[s.id] && (s.retainUntil || s.expires || 0) > now)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  render();
}

$('#dc-search').addEventListener('input', () => {
  renderSign();
  renderGroups();
});
load();
