/* Paperhaus: keep working on the same file, and remember recent files on this device.
 *
 * When any tool saves a file, Paperhaus keeps a copy in this browser (IndexedDB, never
 * uploaded) and offers the next steps: compress it, add a password, sign it... The next
 * tool opens with the file already loaded, so there is no download and upload again.
 *
 * How it knows a tool saved a file: tools save by clicking a download link to a blob, so
 * this watches blob links being made and clicked. How the next tool gets the file: its
 * address carries ?ph-file=<id>, and the file is put into the page's file picker.
 * Runs on every app page; plain script, no build step.
 */
(function () {
  'use strict';

  var DB = 'paperhaus-flow';
  var MAX_FILES = 12;
  var MAX_BYTES = 200 * 1024 * 1024;

  // ---------------------------------------------------------------- storage

  function db() {
    return new Promise(function (resolve, reject) {
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () {
        r.result.createObjectStore('files', { keyPath: 'id' });
      };
      r.onsuccess = function () {
        resolve(r.result);
      };
      r.onerror = function () {
        reject(r.error);
      };
    });
  }

  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction('files', mode);
        var out = fn(t.objectStore('files'));
        t.oncomplete = function () {
          resolve(out && 'result' in out ? out.result : out);
        };
        t.onerror = function () {
          reject(t.error);
        };
      });
    });
  }

  function list() {
    return tx('readonly', function (s) {
      return s.getAll();
    }).then(function (all) {
      return (all || []).sort(function (a, b) {
        return b.at - a.at;
      });
    });
  }

  function get(id) {
    return tx('readonly', function (s) {
      return s.get(id);
    });
  }

  function put(blob, name, meta) {
    var rec = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: name || 'file',
      type: blob.type || guessType(name),
      size: blob.size,
      at: Date.now(),
      tool: (meta && meta.tool) || '',
      what: (meta && meta.what) || '',
      kept: !(meta && meta.temp),
      blob: blob,
    };
    return tx('readwrite', function (s) {
      s.put(rec);
    })
      .then(prune)
      .then(function () {
        return rec;
      });
  }

  /** Keep the newest files, within a size budget. Hand-off copies go after an hour. */
  function prune() {
    return list().then(function (all) {
      var total = 0;
      var kept = 0;
      var drop = [];
      all.forEach(function (r) {
        var stale = !r.kept && Date.now() - r.at > 3600000;
        if (stale || kept >= MAX_FILES || total + r.size > MAX_BYTES) drop.push(r.id);
        else {
          total += r.size;
          if (r.kept) kept++;
        }
      });
      if (!drop.length) return;
      return tx('readwrite', function (s) {
        drop.forEach(function (id) {
          s.delete(id);
        });
      });
    });
  }

  function clear() {
    return tx('readwrite', function (s) {
      s.clear();
    });
  }

  function guessType(name) {
    var ext = (String(name).match(/\.([a-z0-9]+)$/i) || [])[1] || '';
    ext = ext.toLowerCase();
    return (
      {
        pdf: 'application/pdf',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        zip: 'application/zip',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        txt: 'text/plain',
        csv: 'text/csv',
      }[ext] || ''
    );
  }

  // ---------------------------------------------------------------- what to do next

  var PDF_STEPS = [
    ['compress-pdf', 'Compress', 'Smaller for email.'],
    ['protect-pdf', 'Add a password', 'Only people with the password can open it.'],
    ['request-signatures', 'Sign or send for signatures', 'Sealed, timestamped and recorded.'],
    ['pdf-multi-tool', 'Pages', 'Merge, reorder, rotate, delete or split.'],
    ['redact-pdf', 'Redact', 'Black out details before sharing.'],
    ['pdf-to-word', 'Convert to Word', 'An editable .docx.'],
    ['page-numbers', 'Add page numbers', 'Numbers in the corner of every page.'],
    ['summarize-pdf', 'Summarize', 'Key points, written on this device.'],
  ];
  var IMAGE_STEPS = [
    ['image-to-pdf', 'Make a PDF', 'Put the pictures into one PDF.'],
    ['scan-document', 'Clean up as a scan', 'Crop, straighten and remove shadows.'],
  ];

  function kindOf(name, type) {
    var n = String(name).toLowerCase();
    if (type === 'application/pdf' || /\.pdf$/.test(n)) return 'pdf';
    if (/^image\//.test(type || '') || /\.(png|jpe?g|webp|heic|heif|gif|bmp|tiff?)$/.test(n)) return 'image';
    return 'other';
  }

  function stepsFor(kind) {
    var here = (location.pathname.match(/\/([^/]+?)(?:\.html)?\/?$/) || [])[1] || '';
    var steps = kind === 'pdf' ? PDF_STEPS : kind === 'image' ? IMAGE_STEPS : [];
    return steps.filter(function (s) {
      return s[0] !== here;
    });
  }

  function toolHref(page, ids) {
    return '/' + page + '.html?ph-file=' + encodeURIComponent(ids.join(','));
  }

  // ---------------------------------------------------------------- watching for saved files

  var blobs = new Map();
  var make = URL.createObjectURL;
  var revoke = URL.revokeObjectURL;
  URL.createObjectURL = function (obj) {
    var url = make.call(URL, obj);
    if (obj instanceof Blob) blobs.set(url, obj);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    blobs.delete(url);
    return revoke.call(URL, url);
  };

  var last = { name: '', at: 0 };
  function seen(a) {
    try {
      if (!a || !a.hasAttribute('download') || !a.href) return;
      var name = a.getAttribute('download') || 'file';
      if (last.name === name && Date.now() - last.at < 1500) return;
      var blob = blobs.get(a.href);
      if (!blob && /^data:/.test(a.href)) {
        fetch(a.href)
          .then(function (r) {
            return r.blob();
          })
          .then(function (b) {
            saved(b, name);
          });
      } else if (blob) saved(blob, name);
      else return;
      last = { name: name, at: Date.now() };
    } catch (e) {
      /* never get in the way of a download */
    }
  }

  var click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    seen(this);
    return click.apply(this, arguments);
  };
  var dispatch = HTMLAnchorElement.prototype.dispatchEvent;
  HTMLAnchorElement.prototype.dispatchEvent = function (ev) {
    if (ev && ev.type === 'click') seen(this);
    return dispatch.apply(this, arguments);
  };
  document.addEventListener(
    'click',
    function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
      if (a && e.isTrusted) seen(a);
    },
    true
  );

  function toolName() {
    var h = document.querySelector('main h1, h1');
    var t = (h && h.textContent) || document.title.split('|')[0];
    return t.replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  function saved(blob, name) {
    if (!blob || !blob.size) return;
    put(blob, name, { tool: toolName() })
      .then(function (rec) {
        showDone(rec);
      })
      .catch(function () {
        /* storage full or blocked: the download itself still happened */
      });
  }

  // ---------------------------------------------------------------- the "keep working" panel

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function size(n) {
    return n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  }

  var panel = null;
  function closeDone() {
    if (panel) panel.remove();
    panel = null;
  }

  function showDone(rec) {
    closeDone();
    var steps = stepsFor(kindOf(rec.name, rec.type));
    panel = el('aside', 'ph-done');
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-label', 'File ready');
    var head = el('div', 'ph-done-head');
    var ok = el('span', 'ph-done-ok');
    ok.innerHTML = '<i class="ph ph-check" aria-hidden="true"></i>';
    head.appendChild(ok);
    var title = el('div', 'ph-done-title');
    title.appendChild(el('strong', '', rec.name));
    title.appendChild(el('span', '', size(rec.size) + ' · saved to Recent on this device'));
    head.appendChild(title);
    var x = el('button', 'ph-done-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
    x.addEventListener('click', closeDone);
    head.appendChild(x);
    panel.appendChild(head);
    if (steps.length) {
      panel.appendChild(el('div', 'ph-done-label', 'Keep working on this file'));
      var grid = el('div', 'ph-done-steps');
      steps.slice(0, 6).forEach(function (s) {
        var a = el('a', 'ph-done-step');
        a.href = toolHref(s[0], [rec.id]);
        a.appendChild(el('strong', '', s[1]));
        a.appendChild(el('span', '', s[2]));
        grid.appendChild(a);
      });
      panel.appendChild(grid);
    }
    document.body.appendChild(panel);
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeDone();
  });

  // ---------------------------------------------------------------- receiving a file

  function pickerFor() {
    return (
      document.getElementById('file-input') ||
      document.getElementById('pdf-file-input') ||
      document.getElementById('es-file') ||
      document.getElementById('mt-file') ||
      document.getElementById('sc-import') ||
      document.querySelector('main input[type="file"]') ||
      document.querySelector('input[type="file"]')
    );
  }

  function receive() {
    var params = new URLSearchParams(location.search);
    var ids = (params.get('ph-file') || '').split(',').filter(Boolean).slice(0, 20);
    if (!ids.length) return;
    params.delete('ph-file');
    var rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
    Promise.all(ids.map(get)).then(function (recs) {
      var files = recs.filter(Boolean).map(function (r) {
        return new File([r.blob], r.name, { type: r.type || r.blob.type, lastModified: r.at });
      });
      if (!files.length) return;
      var tries = 0;
      (function hand() {
        var input = pickerFor();
        // Wait until the tool has wired up its picker (it runs after this script).
        if (!input || (document.readyState !== 'complete' && tries < 40)) {
          if (tries++ < 60) setTimeout(hand, 150);
          return;
        }
        setTimeout(function () {
          try {
            var dt = new DataTransfer();
            (input.multiple ? files : files.slice(0, 1)).forEach(function (f) {
              dt.items.add(f);
            });
            input.files = dt.files;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (e) {
            /* very old browser: the person picks the file as usual */
          }
        }, 250);
      })();
    });
  }

  window.paperhausFlow = { list: list, get: get, put: put, clear: clear, kindOf: kindOf, toolHref: toolHref, showDone: showDone };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', receive);
  else receive();
})();
