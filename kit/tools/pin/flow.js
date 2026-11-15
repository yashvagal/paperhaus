/* Paperhaus: keep working on the same file, and remember recent files.
 *
 * When any tool saves a file, Paperhaus keeps a copy in this browser (IndexedDB) and offers
 * the next steps: compress it, add a password, sign it... The next
 * tool opens with the file already loaded, so there is no download and upload again.
 *
 * How it knows a tool saved a file: tools save by clicking a download link to a blob, so
 * this watches blob links being made and clicked. How the next tool gets the file: its
 * address carries ?ph-file=<id>, and the file is put into the page's file picker.
 * Sync (opt-in, per account): when it is on, each saved file is also encrypted here with the
 * account's key (AES-GCM) and uploaded to /api/files, so it shows up in Recent on every device
 * the person signs in to. On by default; turning it off removes the synced copies.
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
    return store(rec).then(function () {
      if (rec.kept && syncCached()) upload(rec).catch(function () {});
      return rec;
    });
  }

  function store(rec) {
    return tx('readwrite', function (s) {
      s.put(rec);
    }).then(prune);
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

  /** Empties Recent here, and the synced copies too when sync is on. */
  function clear() {
    var local = tx('readwrite', function (s) {
      s.clear();
    });
    var remote = syncCached()
      ? fetch('/api/files', { method: 'DELETE', credentials: 'same-origin' }).catch(function () {})
      : null;
    return Promise.all([local, remote]);
  }

  // ---------------------------------------------------------------- sync across devices

  var SYNC_LIMIT = 24 * 1024 * 1024 - 64;
  var enc = new TextEncoder();
  var dec = new TextDecoder();
  var keyP = null;
  var statusP = null;

  function syncCached() {
    try {
      return localStorage.getItem('ph-sync-on') !== '0';
    } catch (e) {
      return true;
    }
  }
  function remember(on) {
    try {
      localStorage.setItem('ph-sync-on', on ? '1' : '0');
    } catch (e) {
      /* fine */
    }
  }

  function api(path, init) {
    return fetch('/api/files' + path, Object.assign({ credentials: 'same-origin' }, init || {})).then(function (r) {
      if (!r.ok) throw new Error('sync ' + r.status);
      return r;
    });
  }

  /** { on, files } for the signed-in account; one request per page unless refreshed. */
  function syncStatus(refresh) {
    if (!statusP || refresh) {
      statusP = api('')
        .then(function (r) {
          return r.json();
        })
        .then(function (j) {
          remember(!!j.on);
          return { on: !!j.on, files: Array.isArray(j.files) ? j.files : [] };
        })
        .catch(function () {
          statusP = null;
          return { on: syncCached(), files: [], offline: true };
        });
    }
    return statusP;
  }

  function key() {
    if (!keyP) {
      keyP = api('/key')
        .then(function (r) {
          return r.json();
        })
        .then(function (j) {
          return crypto.subtle.importKey('raw', unb64(j.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
        })
        .catch(function (e) {
          keyP = null;
          throw e;
        });
    }
    return keyP;
  }

  function seal(bytes) {
    return key().then(function (k) {
      var iv = crypto.getRandomValues(new Uint8Array(12));
      return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, bytes).then(function (ct) {
        var out = new Uint8Array(12 + ct.byteLength);
        out.set(iv, 0);
        out.set(new Uint8Array(ct), 12);
        return out;
      });
    });
  }

  function unseal(buf) {
    var u = new Uint8Array(buf);
    return key().then(function (k) {
      return crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, k, u.subarray(12));
    });
  }

  function upload(rec) {
    if (!rec.blob || rec.size > SYNC_LIMIT) return Promise.resolve(false);
    var meta = JSON.stringify({ name: rec.name, type: rec.type, tool: rec.tool, what: rec.what, size: rec.size });
    return Promise.all([rec.blob.arrayBuffer().then(seal), seal(enc.encode(meta))]).then(function (both) {
      return api('/' + rec.id, {
        method: 'PUT',
        headers: { 'x-ph-meta': b64(both[1]), 'x-ph-at': String(rec.at), 'content-type': 'application/octet-stream' },
        body: both[0],
      }).then(function () {
        statusP = null;
        return true;
      });
    });
  }

  /** Send files saved here that did not finish uploading (say the page closed mid-upload). */
  function catchUp() {
    if (!syncCached()) return Promise.resolve();
    return syncStatus().then(function (st) {
      if (!st.on || st.offline) return;
      var there = {};
      var oldest = Infinity;
      st.files.forEach(function (f) {
        there[f.id] = 1;
        oldest = Math.min(oldest, f.at);
      });
      var room = 12 - st.files.length;
      return list().then(function (all) {
        var todo = all.filter(function (r) {
          return r.kept && !there[r.id] && r.size <= SYNC_LIMIT && (room > 0 || r.at > oldest);
        });
        todo = todo.slice(0, 12);
        if (!todo.length) return;
        return todo.reverse().reduce(function (p, r) {
          return p.then(function () {
            return upload(r).catch(function () {});
          });
        }, Promise.resolve()).then(function () {
          return syncStatus(true);
        });
      });
    });
  }

  /** Synced files that are not in this browser yet, as Recent entries without a blob. */
  function remoteList() {
    return syncStatus().then(function (st) {
      if (!st.on || !st.files.length) return [];
      return Promise.all(
        st.files.map(function (f) {
          return unseal(unb64(f.meta))
            .then(function (m) {
              var j = JSON.parse(dec.decode(m));
              return { id: f.id, name: j.name || 'file', type: j.type || '', size: j.size || f.size, at: f.at, tool: j.tool || '', what: j.what || '', kept: true, remote: true };
            })
            .catch(function () {
              return null;
            });
        })
      ).then(function (all) {
        return all.filter(Boolean);
      });
    });
  }

  /** Recent here plus synced files from other devices, newest first. */
  function listAll() {
    return Promise.all([list(), remoteList().catch(function () { return []; })]).then(function (both) {
      var have = {};
      both[0].forEach(function (r) {
        have[r.id] = 1;
      });
      return both[0]
        .concat(
          both[1].filter(function (r) {
            return !have[r.id];
          })
        )
        .sort(function (a, b) {
          return b.at - a.at;
        });
    });
  }

  /** A file from Recent here, or downloaded from sync (and then kept here too). */
  function getAny(id) {
    return get(id).then(function (rec) {
      if (rec || !syncCached()) return rec;
      return Promise.all([api('/' + id).then(function (r) { return r.arrayBuffer(); }), remoteList()])
        .then(function (both) {
          var info = both[1].filter(function (r) {
            return r.id === id;
          })[0];
          if (!info) return null;
          return unseal(both[0]).then(function (plain) {
            var r = Object.assign({}, info, { blob: new Blob([plain], { type: info.type }) });
            delete r.remote;
            r.size = r.blob.size;
            return store(r).then(function () {
              return r;
            });
          });
        })
        .catch(function () {
          return null;
        });
    });
  }

  /** Turn sync on (and send what is already in Recent here) or off (and forget synced copies). */
  function setSync(on) {
    return api('/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: !!on }),
    }).then(function () {
      remember(on);
      statusP = null;
      if (!on) return syncStatus(true);
      return syncStatus(true).then(function (st) {
        var there = {};
        st.files.forEach(function (f) {
          there[f.id] = 1;
        });
        return list().then(function (all) {
          var todo = all.filter(function (r) {
            return r.kept && !there[r.id];
          });
          // Oldest first, so the server keeps the newest when it trims.
          return todo.reverse().reduce(function (p, r) {
            return p.then(function () {
              return upload(r).catch(function () {});
            });
          }, Promise.resolve());
        }).then(function () {
          return syncStatus(true);
        });
      });
    });
  }

  function b64(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(s) {
    var bin = atob(s);
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
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
    var where = syncCached() && rec.size <= SYNC_LIMIT ? 'saved to Recent on all your devices' : 'saved to Recent on this device';
    title.appendChild(el('span', '', size(rec.size) + ' · ' + where));
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
    Promise.all(ids.map(getAny)).then(function (recs) {
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

  // ---------------------------------------------------------------- phone tab bar (every page)

  var TABS = [
    ['/', 'ph-house', 'Home', /^\/(index(\.html)?)?$/],
    ['/scan-document.html', 'ph-scan', 'Scan', /^\/scan-document/],
    ['/request-signatures.html', 'ph-signature', 'Sign', /^\/(request-signatures|sign-pdf)/],
    ['/#all-tools', 'ph-squares-four', 'Tools', null],
    ['/#ph-recent', 'ph-clock-counter-clockwise', 'Recent', null],
  ];

  function tabbar() {
    // Normally already in the page (written in at build time); made here only as a fallback.
    if (!document.querySelector('.ph-tabbar')) makeTabbar();
    // On the home page, light up Recent or Tools when the page is scrolled to them by the tab.
    function mark() {
      if (!/^\/(index(\.html)?)?$/.test(location.pathname)) return;
      var want = location.hash === '#ph-recent' ? '/#ph-recent' : location.hash === '#all-tools' ? '/#all-tools' : '/';
      document.querySelectorAll('.ph-tabbar a').forEach(function (a) {
        if (a.getAttribute('href') === want) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      });
    }
    mark();
    window.addEventListener('hashchange', mark);
    // Out of the way while typing, so it does not ride on top of the phone keyboard.
    document.addEventListener('focusin', function (e) {
      if (e.target && e.target.matches && e.target.matches('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]), textarea, select, [contenteditable="true"]')) {
        document.body.classList.add('ph-typing');
      }
    });
    document.addEventListener('focusout', function () {
      document.body.classList.remove('ph-typing');
    });
  }

  function makeTabbar() {
    var nav = el('nav', 'ph-tabbar');
    nav.setAttribute('aria-label', 'Quick actions');
    TABS.forEach(function (t) {
      var a = el('a');
      a.href = t[0];
      a.innerHTML = '<i class="ph ' + t[1] + '" aria-hidden="true"></i>';
      a.appendChild(document.createTextNode(t[2]));
      if (t[3] && t[3].test(location.pathname)) a.setAttribute('aria-current', 'page');
      nav.appendChild(a);
    });
    document.body.appendChild(nav);
    document.body.classList.add('ph-has-tabbar');
  }

  window.paperhausFlow = {
    list: list,
    listAll: listAll,
    get: get,
    getAny: getAny,
    put: put,
    clear: clear,
    kindOf: kindOf,
    toolHref: toolHref,
    showDone: showDone,
    syncStatus: syncStatus,
    syncCached: syncCached,
    setSync: setSync,
    catchUp: catchUp,
    syncLimit: SYNC_LIMIT,
  };

  function start() {
    tabbar();
    receive();
    // On any Paperhaus page, send files saved here that are not in the account yet (once a minute).
    // The home page does its own check, so it is skipped there.
    if (/^\/(index(\.html)?)?$/.test(location.pathname) || !syncCached()) return;
    var last = 0;
    try {
      last = Number(sessionStorage.getItem('ph-sync-check')) || 0;
      if (Date.now() - last < 60000) return;
      sessionStorage.setItem('ph-sync-check', String(Date.now()));
    } catch (e) {
      /* fine */
    }
    setTimeout(function () {
      catchUp().catch(function () {});
    }, 2500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
