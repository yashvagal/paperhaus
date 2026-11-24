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
  // Build version from this script's address, for /tools-index.json (the service worker keeps
  // .json cache-first, so each build fetches it at a new address).
  var BUILD_V = ((document.currentScript && document.currentScript.src) || '').split('?v=')[1] || '';
  var MAX_FILES = 30;
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
      if (rec.kept && syncCached()) uploadSoon(rec);
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
        var stale = !r.kept && Date.now() - r.at > 3600000 && !inCurrent(r.id);
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

  /** Forget one file, here and in the account. */
  function removeFile(id) {
    var local = tx('readwrite', function (s) {
      s.delete(id);
    });
    var remote = syncCached()
      ? fetch('/api/files/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' }).catch(function () {})
      : null;
    statusP = null;
    return Promise.all([local, remote]);
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
  var SYNC_FILES = 30;
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

  // One upload at a time, so two saves never race each other on the account's file list.
  var upQ = Promise.resolve();
  function upload(rec) {
    var run = function () {
      return uploadNow(rec);
    };
    var p = upQ.then(run, run);
    upQ = p.catch(function () {});
    return p;
  }
  /** Upload a just-saved file, trying again a few times if the network drops. */
  function uploadSoon(rec) {
    var waits = [4000, 20000, 90000];
    (function go(i) {
      upload(rec).catch(function () {
        if (i < waits.length) setTimeout(function () {
          go(i + 1);
        }, waits[i]);
      });
    })(0);
  }
  function uploadNow(rec) {
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

  // Small encrypted records that follow the account (the Sign page's "Sent for signing" list).
  function putRecord(kind, id, obj) {
    if (!syncCached()) return Promise.resolve(false);
    return seal(enc.encode(JSON.stringify(obj))).then(function (ct) {
      return api('/rec/' + kind + '/' + id, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ at: obj.createdAt || Date.now(), data: b64(ct) }),
      }).then(function () {
        return true;
      });
    });
  }
  function deleteRecord(kind, id) {
    if (!syncCached()) return Promise.resolve(false);
    return api('/rec/' + kind + '/' + id, { method: 'DELETE' }).then(function () {
      return true;
    });
  }
  function listRecords(kind) {
    if (!syncCached()) return Promise.resolve([]);
    return api('/rec/' + kind)
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        return Promise.all(
          (j.items || []).map(function (it) {
            if (it.gone) return { id: it.id, gone: true };
            return unseal(unb64(it.data))
              .then(function (plain) {
                return JSON.parse(dec.decode(plain));
              })
              .catch(function () {
                return null;
              });
          })
        );
      })
      .then(function (all) {
        return all.filter(Boolean);
      });
  }

  /** Signing requests sent from this browser (the Sign page keeps them in IndexedDB). */
  function localSent() {
    return new Promise(function (resolve) {
      var req;
      try {
        req = indexedDB.open('paperhaus-esign', 1);
      } catch (e) {
        return resolve([]);
      }
      req.onupgradeneeded = function () {
        req.result.createObjectStore('sent', { keyPath: 'id' });
      };
      req.onerror = function () {
        resolve([]);
      };
      req.onsuccess = function () {
        try {
          var g = req.result.transaction('sent').objectStore('sent').getAll();
          g.onsuccess = function () {
            resolve(g.result || []);
          };
          g.onerror = function () {
            resolve([]);
          };
        } catch (e) {
          resolve([]);
        }
      };
    });
  }

  /** Send signing requests made here that the account does not have yet. */
  function catchUpSent() {
    return Promise.all([localSent(), api('/rec/sent').then(function (r) { return r.json(); })]).then(function (both) {
      var there = {};
      (both[1].items || []).forEach(function (it) {
        there[it.id] = 1;
      });
      var now = Date.now();
      var todo = both[0].filter(function (s) {
        return s && s.id && !there[s.id] && (s.retainUntil || s.expires || 0) > now;
      });
      return todo.reduce(function (p, s) {
        return p.then(function () {
          return putRecord('sent', s.id, s).catch(function () {});
        });
      }, Promise.resolve());
    });
  }

  /** Send files saved here that did not finish uploading (say the page closed mid-upload). */
  function catchUp() {
    if (!syncCached()) return Promise.resolve();
    return syncStatus().then(function (st) {
      if (!st.on || st.offline) return;
      catchUpSent().catch(function () {});
      var there = {};
      var oldest = Infinity;
      st.files.forEach(function (f) {
        there[f.id] = 1;
        oldest = Math.min(oldest, f.at);
      });
      var room = SYNC_FILES - st.files.length;
      return list().then(function (all) {
        var todo = all.filter(function (r) {
          return r.kept && !there[r.id] && r.size <= SYNC_LIMIT && (room > 0 || r.at > oldest);
        });
        todo = todo.slice(0, SYNC_FILES);
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
    ['request-signatures?mode=me', 'Sign it', 'Sign it yourself and download it.'],
    ['request-signatures?mode=meothers', 'Sign it with others', 'You sign first, then they get an email.'],
    ['request-signatures?mode=others', 'Get it signed by others', 'They get an email. You get it back signed.'],
    ['compress-pdf', 'Make smaller', 'Easier to email.'],
    ['protect-pdf', 'Add a password', 'Only people with the password can open it.'],
    ['pdf-multi-tool', 'Pages', 'Merge, reorder, rotate, delete or split.'],
    ['redact-pdf', 'Black out details', 'Hide private information before sharing.'],
    ['pdf-to-word', 'Turn into Word', 'An editable .docx.'],
    ['page-numbers', 'Add page numbers', 'Numbers in the corner of every page.'],
    ['summarize-pdf', 'Summarize', 'Key points, written on this device.'],
  ];
  var IMAGE_STEPS = [
    ['image-to-pdf', 'Make a PDF', 'Put the pictures into one PDF.'],
    ['compress-image', 'Make smaller', 'Easier to email or upload.'],
    ['resize-image', 'Resize', 'Pixels, percent, or a post or profile size.'],
    ['convert-image', 'Change the type', 'To JPG, PNG or WebP.'],
    ['remove-photo-info', 'Remove photo info', 'Location, camera and date.'],
    ['scan-document', 'Clean up as a scan', 'Crop, straighten and remove shadows.'],
  ];
  var OFFICE_STEPS = [
    ['compress-office', 'Make smaller', 'Shrinks the pictures inside.'],
  ];
  var VIDEO_STEPS = [['compress-video', 'Make smaller', 'For email, WhatsApp and uploads.']];

  function kindOf(name, type) {
    var n = String(name).toLowerCase();
    if (type === 'application/pdf' || /\.pdf$/.test(n)) return 'pdf';
    if (/^image\//.test(type || '') || /\.(png|jpe?g|webp|heic|heif|gif|bmp|tiff?|avif)$/.test(n)) return 'image';
    if (/\.(docx|pptx|xlsx|odt|odp|ods)$/.test(n)) return 'office';
    if (/^video\//.test(type || '') || /\.(mp4|mov|m4v|webm|mkv)$/.test(n)) return 'video';
    return 'other';
  }

  function stepsFor(kind) {
    var here = (location.pathname.match(/\/([^/]+?)(?:\.html)?\/?$/) || [])[1] || '';
    var steps = kind === 'pdf' ? PDF_STEPS : kind === 'image' ? IMAGE_STEPS : kind === 'office' ? OFFICE_STEPS : kind === 'video' ? VIDEO_STEPS : [];
    return steps.filter(function (s) {
      return s[0] !== here;
    });
  }

  function toolHref(page, ids) {
    var parts = String(page).split('?');
    return '/' + parts[0] + '.html?' + (parts[1] ? parts[1] + '&' : '') + 'ph-file=' + encodeURIComponent(ids.join(','));
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

  // My documents and the viewer only hand out files that are already kept: don't keep them twice.
  var KEEP_OFF = /^\/(my-documents|view-document)(\.html)?$/.test(location.pathname);
  var last = { name: '', at: 0 };
  function seen(a) {
    try {
      if (KEEP_OFF || !a || !a.hasAttribute('download') || !a.href) return;
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

  // A file shared from a tool (the phone's Share sheet) is kept too, like a download.
  try {
    if (navigator.share && !KEEP_OFF) {
      var share0 = navigator.share;
      navigator.share = function (data) {
        var p = share0.apply(navigator, arguments);
        var files = data && data.files ? Array.prototype.slice.call(data.files) : [];
        if (files.length) {
          p.then(function () {
            files.forEach(function (f) {
              saved(f, f.name);
            });
          }, function () {});
        }
        return p;
      };
    }
  } catch (e) {
    /* leave sharing as it is */
  }

  /** Share a file with the phone's Share sheet. Resolves 'shared', 'cancelled', 'again' (tap again) or 'none'. */
  function shareFile(blob, name, type) {
    var f = null;
    try {
      f = new File([blob], name || 'file', { type: type || blob.type || guessType(name) });
    } catch (e) {
      f = null;
    }
    if (!f || !navigator.share || !navigator.canShare || !navigator.canShare({ files: [f] })) return Promise.resolve('none');
    return navigator.share({ files: [f], title: f.name }).then(
      function () {
        return 'shared';
      },
      function (err) {
        var n = err && err.name;
        if (n === 'AbortError') return 'cancelled';
        if (n === 'NotAllowedError') return 'again';
        return 'none';
      }
    );
  }

  function toolName() {
    var h = document.querySelector('main h1, h1');
    var t = (h && h.textContent) || document.title.split('|')[0];
    return t.replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  function saved(blob, name) {
    if (!blob || !blob.size) return;
    // The same file saved again (say downloaded, then shared) is kept once.
    list()
      .then(function (all) {
        var twin = all.filter(function (r) {
          return r.kept && r.name === name && r.size === blob.size && Date.now() - r.at < 30 * 60000;
        })[0];
        return twin || put(blob, name, { tool: toolName() });
      })
      .then(function (rec) {
        setCurrent([rec]);
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
    var where = syncCached() && rec.size <= SYNC_LIMIT ? 'saved to My documents' : 'saved to My documents on this device';
    title.appendChild(el('span', '', size(rec.size) + ' · ' + where));
    head.appendChild(title);
    var x = el('button', 'ph-done-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
    x.addEventListener('click', closeDone);
    head.appendChild(x);
    panel.appendChild(head);
    // Pages that list their own results (image tools, ZIP, QR) get a short note that closes itself.
    var compact = !!document.querySelector('meta[name="ph-done"][content="compact"]');
    if (compact) {
      panel.classList.add('is-compact');
      var mine = panel;
      setTimeout(function () {
        if (panel === mine) closeDone();
      }, 3500);
    }
    if (steps.length && !compact) {
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
    loadInto(ids);
  }

  /** Put these files into the page's file picker, as if the person chose them. */
  function loadInto(ids, onlyIfFits) {
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
        var fit = files.filter(function (f) {
          return accepts(input, f);
        });
        if (onlyIfFits && !fit.length) return;
        if (!onlyIfFits) fit = files;
        setTimeout(function () {
          try {
            var dt = new DataTransfer();
            (input.multiple ? fit : fit.slice(0, 1)).forEach(function (f) {
              dt.items.add(f);
            });
            autoLoading = true;
            input.files = dt.files;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (e) {
            /* very old browser: the person picks the file as usual */
          }
          setTimeout(function () {
            autoLoading = false;
          }, 400);
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
    putRecord: putRecord,
    deleteRecord: deleteRecord,
    listRecords: listRecords,
    localSent: localSent,
    removeFile: removeFile,
    openSearch: openSearch,
    getCurrent: getCurrent,
    setCurrent: setCurrent,
    clearCurrent: clearCurrent,
    useFiles: useFiles,
    shareFile: shareFile,
    syncLimit: SYNC_LIMIT,
  };

  // ---------------------------------------------------------------- search everything
  // One search box (header button, or press /) for tools, your files and the documents
  // you sent for signature. Tools come from /tools-index.json, written by kit/build.mjs.
  var toolsP = null;
  function toolList() {
    if (!toolsP) {
      toolsP = fetch('/tools-index.json?v=' + BUILD_V, { credentials: 'same-origin' })
        .then(function (r) {
          return r.ok ? r.json() : [];
        })
        .catch(function () {
          toolsP = null;
          return [];
        });
    }
    return toolsP;
  }
  var SYNONYMS = { shrink: 'compress', smaller: 'compress', combine: 'merge', join: 'merge', signature: 'sign', esign: 'sign', picture: 'image', photo: 'image', jpg: 'jpg', word: 'word', excel: 'excel', lock: 'password', unlock: 'password', hide: 'redact', 'black out': 'redact' };
  function terms(q) {
    q = String(q || '').toLowerCase().trim();
    Object.keys(SYNONYMS).forEach(function (k) {
      if (q.indexOf(k) !== -1) q += ' ' + SYNONYMS[k];
    });
    return q.split(/\s+/).filter(Boolean);
  }
  function score(text, words) {
    text = String(text || '').toLowerCase();
    var hit = 0;
    words.forEach(function (w) {
      if (text.indexOf(w) !== -1) hit++;
    });
    return hit;
  }

  var searchBox = null;
  function openSearch() {
    if (searchBox) return;
    var wrap = el('div', 'ph-search-wrap');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Search');
    var panel = el('div', 'ph-search');
    var row = el('div', 'ph-search-row');
    row.innerHTML = '<i class="ph ph-magnifying-glass" aria-hidden="true"></i>';
    var input = el('input', 'ph-search-input');
    input.type = 'search';
    input.placeholder = 'Search tools and your documents';
    input.setAttribute('aria-label', 'Search tools and your documents');
    row.appendChild(input);
    var close = el('button', 'ph-search-close', 'Close');
    close.type = 'button';
    row.appendChild(close);
    panel.appendChild(row);
    var results = el('div', 'ph-search-results');
    panel.appendChild(results);
    wrap.appendChild(panel);
    document.body.appendChild(wrap);
    document.documentElement.classList.add('ph-search-open');
    searchBox = wrap;
    setTimeout(function () {
      input.focus();
    }, 30);

    function done() {
      wrap.remove();
      document.documentElement.classList.remove('ph-search-open');
      searchBox = null;
    }
    close.addEventListener('click', done);
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap) done();
    });
    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') done();
      if (e.key === 'Enter') {
        var first = results.querySelector('a');
        if (first) first.click();
      }
    });

    // Gather once: tools, files (here and synced), sent for signature.
    var data = Promise.all([
      toolList(),
      listAll().catch(function () {
        return [];
      }),
      localSent().catch(function () {
        return [];
      }),
      listRecords('sent').catch(function () {
        return [];
      }),
    ]).then(function (all) {
      var byId = {};
      var gone = {};
      all[3].forEach(function (r) {
        if (r && r.gone) gone[r.id] = 1;
        else if (r && r.id) byId[r.id] = r;
      });
      all[2].forEach(function (r) {
        if (r && r.id) byId[r.id] = r;
      });
      var now = Date.now();
      return {
        tools: all[0],
        files: all[1].filter(function (r) {
          return r.kept;
        }),
        sent: Object.keys(byId)
          .map(function (k) {
            return byId[k];
          })
          .filter(function (x) {
            return !gone[x.id] && (x.retainUntil || x.expires || 0) > now;
          }),
      };
    });

    function section(title, items) {
      if (!items.length) return;
      results.appendChild(el('div', 'ph-search-head', title));
      items.forEach(function (it) {
        var a = el('a', 'ph-search-item');
        a.href = it.href;
        a.innerHTML = '<i class="ph ' + it.icon + '" aria-hidden="true"></i>';
        var t = el('span', 'ph-search-text');
        t.appendChild(el('strong', '', it.name));
        if (it.sub) t.appendChild(el('span', '', it.sub));
        a.appendChild(t);
        results.appendChild(a);
      });
    }
    function draw() {
      var q = input.value;
      var words = terms(q);
      data.then(function (d) {
        if (input.value !== q) return;
        results.textContent = '';
        if (!words.length) {
          section(
            'Recent files',
            d.files.slice(0, 4).map(function (r) {
              return { href: '/view-document.html?id=' + encodeURIComponent(r.id), icon: 'ph-file', name: r.name, sub: r.tool || '' };
            })
          );
          results.appendChild(el('p', 'ph-search-hint', 'Type what you want to do, like "compress", "merge" or "sign", or the name of a document.'));
          return;
        }
        var tools = d.tools
          .map(function (t) {
            return { t: t, s: score(t.name, words) * 3 + score(t.sub, words) };
          })
          .filter(function (x) {
            return x.s > 0;
          })
          .sort(function (a, b) {
            return b.s - a.s;
          })
          .slice(0, 8)
          .map(function (x) {
            return { href: '/' + x.t.href, icon: x.t.icon, name: x.t.name, sub: x.t.sub };
          });
        var files = d.files
          .filter(function (r) {
            return score(r.name + ' ' + (r.tool || ''), words) > 0;
          })
          .slice(0, 6)
          .map(function (r) {
            return { href: '/view-document.html?id=' + encodeURIComponent(r.id), icon: 'ph-file', name: r.name, sub: (r.tool ? r.tool + ' · ' : '') + new Date(r.at).toLocaleDateString() };
          });
        var sent = d.sent
          .filter(function (x) {
            return score(x.title, words) > 0;
          })
          .slice(0, 6)
          .map(function (x) {
            return { href: '/request-signatures.html#documents', icon: 'ph-signature', name: x.title, sub: 'Sent for signature · ' + new Date(x.createdAt).toLocaleDateString() };
          });
        section('Your files', files);
        section('Sent for signature', sent);
        section('Tools', tools);
        if (!tools.length && !files.length && !sent.length) results.appendChild(el('p', 'ph-search-hint', 'Nothing found. Try another word, like "pdf to word" or "rotate".'));
      });
    }
    input.addEventListener('input', draw);
    draw();
  }

  function searchButton() {
    var tries = 0;
    (function place() {
      var bar = document.getElementById('ph-bar');
      if (!bar) {
        if (++tries < 40) setTimeout(place, 100);
        return;
      }
      if (document.getElementById('ph-search-btn')) return;
      var b = el('button', 'ph-search-btn');
      b.id = 'ph-search-btn';
      b.type = 'button';
      b.setAttribute('aria-label', 'Search tools and documents');
      b.innerHTML = '<i class="ph ph-magnifying-glass" aria-hidden="true"></i><span>Search</span>';
      b.addEventListener('click', openSearch);
      bar.insertBefore(b, bar.firstChild);
    })();
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        openSearch();
      }
    });
  }


  // ---------------------------------------------------------------- the document you're working on
  // Once you open, upload or save a document, every tool you go to offers it in one tap
  // ("Use <name>?" with Use it / Start new) until you remove it or a couple of hours pass.
  // Tools never load it silently, so a new task never starts with an old file in it.
  // Kept in this browser. The Scan page starts clean and never offers it.
  var CUR_KEY = 'ph-current';
  var CUR_TTL = 2 * 3600000;
  var autoLoading = false;
  var offerOpen = false;
  var SCAN_PAGE = /^\/scan-document(\.html)?$/.test(location.pathname);
  var NOT_TOOLS = /^\/(index(\.html)?|my-documents(\.html)?|view-document(\.html)?|people(\.html)?|privacy(\.html)?|about(\.html)?)?$/;

  function getCurrent() {
    try {
      var c = JSON.parse(localStorage.getItem(CUR_KEY) || 'null');
      if (c && Array.isArray(c.files) && c.files.length && Date.now() - c.at < CUR_TTL) return c;
    } catch (e) {
      /* fine */
    }
    return null;
  }
  function inCurrent(id) {
    var c = getCurrent();
    return !!(c && c.files.some(function (f) {
      return f.id === id;
    }));
  }
  function setCurrent(recs) {
    recs = (recs || []).filter(Boolean).slice(0, 20);
    if (!recs.length) return;
    offerOpen = false;
    try {
      localStorage.setItem(CUR_KEY, JSON.stringify({ at: Date.now(), files: recs.map(function (r) {
        return { id: r.id, name: r.name, type: r.type, size: r.size };
      }) }));
    } catch (e) {
      /* fine */
    }
    currentBar();
  }
  function clearCurrent() {
    var c = getCurrent();
    offerOpen = false;
    try {
      localStorage.removeItem(CUR_KEY);
    } catch (e) {
      /* fine */
    }
    currentBar();
    // Copies made only for working on (not saved files) go too.
    if (c) list().then(function (all) {
      var temp = all.filter(function (r) {
        return !r.kept && c.files.some(function (f) {
          return f.id === r.id;
        });
      });
      if (temp.length) tx('readwrite', function (s) {
        temp.forEach(function (r) {
          s.delete(r.id);
        });
      });
    });
  }
  /** Files the person chose (any file picker, or dropped on Home) become the current ones. */
  function useFiles(files, tool) {
    files = Array.prototype.slice.call(files || []).filter(function (f) {
      return f && f.size && f.size < 200 * 1024 * 1024;
    }).slice(0, 20);
    if (!files.length) return Promise.resolve([]);
    var c = getCurrent();
    var same = c && c.files.length === files.length && files.every(function (f, i) {
      return c.files[i].name === f.name && c.files[i].size === f.size;
    });
    if (same) return Promise.resolve([]);
    return Promise.all(files.map(function (f) {
      return put(f, f.name, { tool: tool || toolName(), temp: true });
    })).then(function (recs) {
      setCurrent(recs);
      return recs;
    });
  }
  function accepts(input, f) {
    var acc = String((input && input.accept) || '').toLowerCase().split(',').map(function (x) {
      return x.trim();
    }).filter(Boolean);
    if (!acc.length) return true;
    var name = String(f.name || '').toLowerCase();
    var type = String(f.type || '').toLowerCase();
    return acc.some(function (a) {
      if (a.charAt(0) === '.') return name.slice(-a.length) === a;
      if (a.slice(-2) === '/*') return type.indexOf(a.slice(0, -1)) === 0;
      return type === a;
    });
  }

  function currentBar() {
    var bar = document.getElementById('ph-current');
    var c = getCurrent();
    if (!c || SCAN_PAGE || document.body.classList.contains('es-signer-page')) {
      if (bar) bar.remove();
      document.body.classList.remove('ph-has-current');
      return;
    }
    if (!bar) {
      bar = el('div', 'ph-current');
      bar.id = 'ph-current';
      bar.setAttribute('role', 'status');
      document.body.appendChild(bar);
    }
    document.body.classList.add('ph-has-current');
    bar.textContent = '';
    bar.classList.toggle('is-offer', offerOpen);
    if (offerOpen) return offerBar(bar, c);
    var open = el('a', 'ph-current-open');
    open.href = '/view-document.html?id=' + encodeURIComponent(c.files[0].id);
    open.innerHTML = '<i class="ph ph-file-text" aria-hidden="true"></i>';
    var t = el('span', 'ph-current-text');
    t.appendChild(el('small', '', 'Working on'));
    t.appendChild(el('strong', '', c.files[0].name + (c.files.length > 1 ? ' +' + (c.files.length - 1) + ' more' : '')));
    open.appendChild(t);
    bar.appendChild(open);
    var x = el('button', 'ph-current-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Stop working on this document');
    x.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i><span>Remove</span>';
    x.addEventListener('click', function () {
      var onTool = !NOT_TOOLS.test(location.pathname) && pickerFor();
      clearCurrent();
      // Start the tool over without it.
      if (onTool) location.reload();
    });
    bar.appendChild(x);
  }

  /** On a tool page: "Use <name>?" with Use it (load it into the tool) or Start new (forget it). */
  function offerBar(bar, c) {
    var name = c.files[0].name + (c.files.length > 1 ? ' and ' + (c.files.length - 1) + ' more' : '');
    var t = el('span', 'ph-current-text');
    t.appendChild(el('small', '', 'Continue with your last file?'));
    t.appendChild(el('strong', '', name));
    bar.appendChild(t);
    var acts = el('div', 'ph-current-acts');
    var use = el('button', 'ph-current-use', 'Use it');
    use.type = 'button';
    use.addEventListener('click', function () {
      offerOpen = false;
      currentBar();
      loadInto(c.files.map(function (f) {
        return f.id;
      }), true);
    });
    var fresh = el('button', 'ph-current-new', 'Start new');
    fresh.type = 'button';
    fresh.addEventListener('click', function () {
      clearCurrent();
    });
    acts.appendChild(use);
    acts.appendChild(fresh);
    bar.appendChild(acts);
  }

  function watchPickers() {
    // Anything chosen in any file picker becomes the document you're working on.
    // (Not on Scan: those are camera photos, not the document.)
    document.addEventListener(
      'change',
      function (e) {
        var t = e.target;
        if (autoLoading || SCAN_PAGE || !t || t.tagName !== 'INPUT' || t.type !== 'file' || t.id === 'ph-file' || !t.files || !t.files.length) return;
        if (offerOpen) {
          offerOpen = false;
          currentBar();
        }
        useFiles(t.files).catch(function () {});
      },
      true
    );
    window.addEventListener('storage', function (e) {
      if (e.key === CUR_KEY) currentBar();
    });
    // Removing the file inside a tool (its trash or x button) removes it everywhere.
    document.addEventListener(
      'click',
      function (e) {
        var c = getCurrent();
        if (!c || NOT_TOOLS.test(location.pathname)) return;
        var b = e.target && e.target.closest && e.target.closest('button, [role="button"]');
        if (!b || b.closest('#ph-current') || !b.querySelector('.ph-trash, .ph-x, [data-lucide="trash-2"], [data-lucide="trash"], [data-lucide="x"], .lucide-trash-2, .lucide-trash, .lucide-x')) return;
        setTimeout(function () {
          var bar = document.getElementById('ph-current');
          var text = document.body.innerText.replace(bar ? bar.innerText : '\u0000', '');
          var still = c.files.some(function (f) {
            return text.indexOf(f.name) !== -1;
          });
          if (!still) clearCurrent();
        }, 500);
      },
      true
    );
  }

  /** On a tool page opened without a file, offer the current document (it fits the tool). */
  function loadCurrent() {
    var c = getCurrent();
    if (!c || SCAN_PAGE || NOT_TOOLS.test(location.pathname) || /[?&]ph-file=/.test(location.search)) return;
    if (/^\/(request-signatures|sign-request)/.test(location.pathname) && location.hash === '#documents') return;
    var tries = 0;
    (function check() {
      var input = pickerFor();
      if (!input || document.readyState !== 'complete') {
        if (tries++ < 60) setTimeout(check, 150);
        return;
      }
      var now = getCurrent();
      if (!now || now.at !== c.at) return;
      var fits = c.files.some(function (f) {
        return accepts(input, { name: f.name, type: f.type });
      });
      if (!fits) return;
      offerOpen = true;
      currentBar();
    })();
  }

  /** A plain tab title: "Compress PDF | Paperhaus" (BentoPDF sets one generic title everywhere). */
  function cleanTitle() {
    var home = /^\/(index(\.html)?)?$/.test(location.pathname);
    var h = document.querySelector('main h1, #uploader h1, h1');
    var name = h && h.textContent.replace(/\s+/g, ' ').trim();
    var want = home || !name ? 'Paperhaus' : name.slice(0, 70) + ' | Paperhaus';
    if (document.title !== want) document.title = want;
  }

  function start() {
    tabbar();
    loadCurrent();
    receive();
    searchButton();
    watchPickers();
    currentBar();
    cleanTitle();
    window.addEventListener('load', function () {
      setTimeout(cleanTitle, 300);
      setTimeout(cleanTitle, 1500);
    });
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
