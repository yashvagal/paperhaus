/* Paperhaus home: start from the file.
 *
 * Drop or choose a file and Paperhaus suggests what to do with it; or pick one of eight
 * tasks. Convert, Edit, Secure and AI open as hubs: the full tool list, filtered to that
 * task. Recent files (kept in this browser by flow.js) and pinned tools sit below.
 * Only runs where the home markup (#ph-home, written by kit/build.mjs) is on the page.
 */
(function () {
  'use strict';

  var home = document.getElementById('ph-home');
  if (!home) return;
  var flow = window.paperhausFlow;

  // Hubs: which of the tool list's categories each one shows.
  var HUBS = {
    convert: { title: 'Convert', sub: 'To and from PDF: Word, Excel, PowerPoint, images, web pages and more.', cats: ['convert-to-pdf', 'convert-from-pdf'] },
    edit: { title: 'Edit', sub: 'Text, images, notes, highlights, stamps and form fields.', cats: ['edit-annotate'] },
    secure: { title: 'Secure and redact', sub: 'Passwords, permissions, redaction, hidden data and signatures.', cats: ['secure-pdf'] },
    ai: { title: 'AI on this device', sub: 'Summarize, translate and read scans. Nothing is uploaded.', cats: ['ai-on-this-device'] },
  };

  // Office and other formats with a "<ext> to PDF" tool.
  var TO_PDF = {
    doc: 'word-to-pdf', docx: 'word-to-pdf', odt: 'odt-to-pdf', rtf: 'rtf-to-pdf', wpd: 'wpd-to-pdf', wps: 'wps-to-pdf', pages: 'pages-to-pdf',
    xls: 'excel-to-pdf', xlsx: 'excel-to-pdf', ods: 'ods-to-pdf', csv: 'csv-to-pdf',
    ppt: 'powerpoint-to-pdf', pptx: 'powerpoint-to-pdf', odp: 'odp-to-pdf',
    txt: 'txt-to-pdf', md: 'markdown-to-pdf', json: 'json-to-pdf', xml: 'xml-to-pdf', html: 'html-to-pdf', htm: 'html-to-pdf',
    epub: 'epub-to-pdf', mobi: 'mobi-to-pdf', fb2: 'fb2-to-pdf', cbz: 'cbz-to-pdf', xps: 'xps-to-pdf', eml: 'email-to-pdf', msg: 'email-to-pdf',
    svg: 'svg-to-pdf', psd: 'psd-to-pdf', vsd: 'vsd-to-pdf', pub: 'pub-to-pdf', odg: 'odg-to-pdf',
  };

  function $(sel) {
    return home.querySelector(sel);
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }
  function size(n) {
    return n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  }
  function ext(name) {
    return ((String(name).match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
  }
  function when(ms) {
    var d = new Date(ms);
    var today = new Date();
    var y = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return 'today';
    if (d.toDateString() === y.toDateString()) return 'yesterday';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ---------------------------------------------------------------- suggestions for a file

  function suggestionsFor(files) {
    var kinds = files.map(function (f) {
      return flow ? flow.kindOf(f.name, f.type) : 'other';
    });
    var pdfs = kinds.filter(function (k) {
      return k === 'pdf';
    }).length;
    if (files.length > 1 && pdfs === files.length) {
      return [
        ['merge-pdf', 'Merge into one PDF', true],
        ['pdf-multi-tool', 'Merge and reorder pages'],
        ['compress-pdf', 'Make them smaller'],
        ['pdf-to-zip', 'Put them in a ZIP'],
      ];
    }
    if (kinds.every(function (k) {
      return k === 'image';
    })) {
      return [
        ['image-to-pdf', files.length > 1 ? 'Make one PDF from them' : 'Make a PDF', true],
        ['scan-document', 'Clean up as a scan'],
      ];
    }
    if (kinds[0] === 'pdf') {
      return [
        ['request-signatures?mode=me', 'Sign it', true],
        ['request-signatures?mode=meothers', 'Sign it with others'],
        ['request-signatures?mode=others', 'Get it signed by others'],
        ['form-filler', 'Fill in the form', false, 'form'],
        ['compress-pdf', 'Make smaller'],
        ['pdf-multi-tool', 'Pages: reorder, delete, add'],
        ['pdf-to-word', 'Turn into Word'],
        ['redact-pdf', 'Black out details'],
        ['protect-pdf', 'Add a password'],
        ['edit-pdf', 'Edit, add text or notes'],
        ['summarize-pdf', 'Summarize'],
      ];
    }
    var page = TO_PDF[ext(files[0].name)];
    if (page) return [[page, 'Convert to PDF', true]];
    return [];
  }

  function looksLikeForm(file) {
    // A quick look for an interactive form, without opening the whole PDF.
    return file
      .slice(0, Math.min(file.size, 8 * 1024 * 1024))
      .arrayBuffer()
      .then(function (buf) {
        var s = new TextDecoder('latin1').decode(new Uint8Array(buf));
        return /\/AcroForm/.test(s) && /\/FT\s*\/(Tx|Btn|Ch)/.test(s);
      })
      .catch(function () {
        return false;
      });
  }

  var current = [];
  function offer(files, recs) {
    current = recs;
    var box = $('#ph-suggest');
    box.textContent = '';
    box.hidden = false;
    var head = el('div', 'ph-suggest-head');
    var badge = el('span', 'ph-filebadge', (ext(files[0].name) || 'file').slice(0, 4).toUpperCase());
    head.appendChild(badge);
    var info = el('div', 'ph-suggest-info');
    info.appendChild(el('strong', '', files.length > 1 ? files.length + ' files' : files[0].name));
    var total = files.reduce(function (n, f) {
      return n + f.size;
    }, 0);
    var meta = el('span', '', size(total) + ' · stays on this device');
    info.appendChild(meta);
    head.appendChild(info);
    var clearBtn = el('button', 'ph-linkbtn', 'Clear');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', function () {
      box.hidden = true;
      current = [];
      if (flow && flow.clearCurrent) flow.clearCurrent();
    });
    head.appendChild(clearBtn);
    box.appendChild(head);
    var list = suggestionsFor(files);
    if (!list.length) {
      box.appendChild(el('p', 'ph-muted', 'Paperhaus has no tool for this kind of file yet. Search all tools below.'));
      return;
    }
    box.appendChild(el('div', 'ph-label', 'Suggested for ' + (files.length > 1 ? 'these files' : 'this file')));
    var chips = el('div', 'ph-chips');
    var ids = recs.map(function (r) {
      return r.id;
    });
    list.forEach(function (s) {
      var a = el('a', 'ph-chip' + (s[2] ? ' is-main' : ''), s[1]);
      var parts = s[0].split('?');
      a.href = '/' + parts[0] + '.html?' + (parts[1] ? parts[1] + '&' : '') + 'ph-file=' + encodeURIComponent(ids.join(','));
      if (s[3] === 'form') {
        a.hidden = true;
        looksLikeForm(files[0]).then(function (yes) {
          a.hidden = !yes;
          if (yes) meta.textContent += ' · has form fields';
        });
      }
      chips.appendChild(a);
    });
    // The first few up front; the rest behind "More" so the choice stays simple.
    var extra = Array.prototype.slice.call(chips.children).filter(function (c, i) {
      return i >= 6 && c.dataset.form !== '1';
    });
    if (extra.length > 1) {
      extra.forEach(function (c) {
        c.classList.add('ph-chip-more');
      });
      chips.classList.add('is-short');
      var more = el('button', 'ph-chip ph-chip-toggle', 'More (' + extra.length + ')');
      more.type = 'button';
      more.addEventListener('click', function () {
        chips.classList.remove('is-short');
        more.remove();
      });
      chips.appendChild(more);
    }
    box.appendChild(chips);
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function take(fileList) {
    var files = Array.prototype.slice.call(fileList || []).slice(0, 20);
    if (!files.length) return;
    if (!flow) {
      offer(files, []);
      return;
    }
    Promise.all(
      files.map(function (f) {
        return flow.put(f, f.name, { tool: 'Opened on Home', temp: true });
      })
    ).then(function (recs) {
      // These become the document you're working on: every tool starts with them.
      if (flow.setCurrent) flow.setCurrent(recs);
      offer(files, recs);
    });
  }

  // ---------------------------------------------------------------- drop zone

  var drop = $('#ph-drop');
  var input = $('#ph-file');
  $('#ph-choose').addEventListener('click', function () {
    input.click();
  });
  input.addEventListener('change', function () {
    take(input.files);
    input.value = '';
  });
  ['dragenter', 'dragover'].forEach(function (t) {
    document.addEventListener(t, function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
      e.preventDefault();
      drop.classList.add('is-over');
    });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    document.addEventListener(t, function (e) {
      if (t === 'dragleave' && e.relatedTarget) return;
      drop.classList.remove('is-over');
    });
  });
  document.addEventListener('drop', function (e) {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    take(e.dataTransfer.files);
  });
  drop.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === drop) {
      e.preventDefault();
      input.click();
    }
  });
  // Paste a file, or a web page address, anywhere on the home page.
  document.addEventListener('paste', function (e) {
    if (e.target && e.target.closest && e.target.closest('input, textarea')) return;
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) return take(files);
    var text = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if (/^https?:\/\/\S+$/i.test(text.trim())) location.href = '/html-to-pdf.html?url=' + encodeURIComponent(text.trim());
  });
  var urlForm = $('#ph-url');
  if (urlForm)
    urlForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('#ph-url input').value.trim();
    if (!v) return;
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    location.href = '/html-to-pdf.html?url=' + encodeURIComponent(v);
  });

  // ---------------------------------------------------------------- recent files

  var showAll = false;
  function renderRecent() {
    var host = $('#ph-recent-list');
    if (!flow) return;
    var syncOn = flow.syncCached();
    heading(syncOn);
    (flow.listAll || flow.list)()
      .then(function (all) {
        var recs = all.filter(function (r) {
          return r.kept;
        });
        host.textContent = '';
        if (!recs.length) {
          host.appendChild(
            el('p', 'ph-muted', syncOn
              ? 'Nothing yet. Files you save show up here, on all your devices.'
              : 'Files you make here show up on this device, so you can keep working on them. Nothing is uploaded.')
          );
        }
        var SHOW = 5;
        recs.forEach(function (r, i) {
          var row = el('div', 'ph-recent-row');
          if (i >= SHOW && !showAll) row.hidden = true;
          row.appendChild(el('span', 'ph-filebadge', (ext(r.name) || 'file').slice(0, 4).toUpperCase()));
          var info = el('div', 'ph-recent-info');
          info.appendChild(el('strong', '', r.name));
          info.appendChild(el('span', '', (r.tool ? r.tool + ' · ' : '') + when(r.at) + (r.remote ? ' · synced' : '')));
          row.appendChild(info);
          var open = el('button', 'ph-linkbtn', 'Open');
          open.type = 'button';
          // Open it in the viewer, with quick tools for any change (view-document.html).
          open.addEventListener('click', function () {
            location.href = '/view-document.html?id=' + encodeURIComponent(r.id);
          });
          row.appendChild(open);
          host.appendChild(row);
        });
        if (recs.length > SHOW && !showAll) {
          var more = el('button', 'ph-linkbtn ph-recent-more', 'Show all ' + recs.length + ' files');
          more.type = 'button';
          more.addEventListener('click', function () {
            showAll = true;
            host.querySelectorAll('.ph-recent-row[hidden]').forEach(function (r) {
              r.hidden = false;
            });
            more.remove();
          });
          host.appendChild(more);
        }
        syncRow(host);
      })
      .catch(function () {
        host.textContent = '';
        host.appendChild(el('p', 'ph-muted', 'Recent files are not available in this browser window.'));
      });
  }

  function heading(on) {
    var h = document.querySelector('#ph-recent .ph-card-head h2');
    var sub = document.querySelector('#ph-recent .ph-card-head span');
    if (h) h.textContent = on ? 'Recent files' : 'Recent on this device';
    if (sub) sub.textContent = on ? 'On all your devices' : 'Only you see these';
  }

  /** The switch under Recent: sync these files across the person's devices. */
  function syncRow(host) {
    if (!flow.setSync) return;
    var on = flow.syncCached();
    var box = el('div', 'ph-sync');
    var text = el('div', 'ph-sync-text');
    text.appendChild(el('strong', '', on ? 'Syncing across your devices' : 'Sync across your devices'));
    text.appendChild(
      el('span', '', on
        ? 'Encrypted, newest 30 files.'
        : 'Off: these files stay on this device.')
    );
    box.appendChild(text);
    if (on && flow.syncStatus) {
      var state = el('span', 'ph-sync-state', 'Checking your account...');
      text.appendChild(state);
      flow.syncStatus().then(function (st) {
        if (st.offline) {
          state.textContent = "Can't reach your synced files right now. Reload the page (you may need to sign in again).";
          state.classList.add('ph-sync-bad');
          return;
        }
        var n = st.files.length;
        state.textContent = (n ? n + (n === 1 ? ' file' : ' files') + ' in your account' : 'No files in your account yet') + ' · checked ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        var again = el('button', 'ph-linkbtn ph-sync-again', 'Check now');
        again.type = 'button';
        again.addEventListener('click', function () {
          again.disabled = true;
          flow.syncStatus(true).then(function () {
            return flow.catchUp();
          }).then(renderRecent, renderRecent);
        });
        state.appendChild(document.createTextNode(' '));
        state.appendChild(again);
      });
    }
    var btn = el('button', on ? 'ph-sync-btn' : 'ph-sync-btn ph-sync-btn-on', on ? 'Turn off' : 'Turn on');
    btn.type = 'button';
    var sure = false;
    btn.addEventListener('click', function () {
      if (on && !sure) {
        sure = true;
        btn.textContent = 'Turn off and remove synced copies';
        return;
      }
      btn.disabled = true;
      btn.textContent = on ? 'Turning off...' : 'Turning on...';
      flow
        .setSync(!on)
        .then(function () {
          renderRecent();
        })
        .catch(function () {
          btn.disabled = false;
          btn.textContent = 'Could not reach Paperhaus. Try again';
        });
    });
    box.appendChild(btn);
    host.appendChild(box);
  }

  // ---------------------------------------------------------------- pinned tools (the tool list's stars)

  function renderPins() {
    var host = $('#ph-pins-list');
    var ids = [];
    try {
      ids = JSON.parse(localStorage.getItem('favoriteTools') || '[]');
    } catch (e) {
      ids = [];
    }
    host.textContent = '';
    var shown = 0;
    (Array.isArray(ids) ? ids : []).slice(0, 12).forEach(function (id) {
      var btn = document.querySelector('.tool-fav-btn[data-fav-id="' + CSS.escape(String(id)) + '"]');
      var card = btn && btn.parentElement && btn.parentElement.querySelector('a.tool-card');
      if (!card) return;
      var a = el('a', 'ph-pin-chip', (card.querySelector('h3') || card).textContent.trim());
      a.href = card.getAttribute('href');
      host.appendChild(a);
      shown++;
    });
    // The card shows only once something is starred.
    var card = $('#ph-pins');
    if (card) card.hidden = !shown;
  }

  // ---------------------------------------------------------------- sent for signature
  // The last few requests sent from this account (this browser plus the account's synced
  // list), with where each stands. Details and actions are on the Sign page.
  function renderSentHome() {
    var host = $('#ph-sent-list');
    if (!host || !flow || !flow.localSent) return;
    Promise.all([flow.localSent(), flow.listRecords ? flow.listRecords('sent').catch(function () { return []; }) : []])
      .then(function (both) {
        var byId = {};
        var gone = {};
        both[1].forEach(function (r) {
          if (r && r.gone) gone[r.id] = 1;
          else if (r && r.id && r.senderToken) byId[r.id] = r;
        });
        both[0].forEach(function (r) {
          if (r && r.id) byId[r.id] = r;
        });
        var now = Date.now();
        var list = Object.keys(byId)
          .map(function (k) {
            return byId[k];
          })
          .filter(function (s) {
            return !gone[s.id] && (s.retainUntil || s.expires || 0) > now;
          })
          .sort(function (a, b) {
            return (b.createdAt || 0) - (a.createdAt || 0);
          })
          .slice(0, 4);
        host.textContent = '';
        if (!list.length) {
          host.appendChild(el('p', 'ph-muted', 'Nothing sent yet. Send a PDF to someone to sign and you can follow it here.'));
          var go = el('a', 'ph-btn ph-sent-go', 'Send a PDF for signature');
          go.href = 'request-signatures.html';
          host.appendChild(go);
          return;
        }
        list.forEach(function (s) {
          var row = el('a', 'ph-recent-row ph-sent-row');
          row.href = 'request-signatures.html#documents';
          var dot = el('span', 'ph-sent-dot');
          row.appendChild(dot);
          var info = el('div', 'ph-recent-info');
          info.appendChild(el('strong', '', s.title || 'Document'));
          var line = el('span', '', 'Checking...');
          info.appendChild(line);
          row.appendChild(info);
          host.appendChild(row);
          fetch('/api/esign/p/' + encodeURIComponent(s.id) + '?t=' + encodeURIComponent(s.senderToken), { cache: 'no-store' })
            .then(function (r) {
              if (r.status === 404) return { status: 'gone' };
              return r.json();
            })
            .then(function (st) {
              var n = st.n || (s.signers || []).length;
              var done = (st.signers || []).filter(function (x) {
                return x.signed;
              }).length;
              var text = {
                complete: 'Signed by everyone',
                out: 'Waiting · ' + done + ' of ' + n + ' signed',
                cancelled: 'Cancelled · you can undo it',
                declined: 'Declined',
                expired: 'Time ran out',
                gone: 'Deleted',
              }[st.status] || '';
              line.textContent = text;
              dot.className = 'ph-sent-dot is-' + (st.status || 'gone');
            })
            .catch(function () {
              line.textContent = '';
            });
        });
      })
      .catch(function () {
        host.textContent = '';
      });
  }

  // ---------------------------------------------------------------- hubs

  var grid = document.getElementById('tool-grid');
  // The full list of 127 tools stays folded away until asked for (Tools tab, "See all",
  // a hub), so Home is short; search finds any tool too.
  var gridView = document.getElementById('grid-view');
  if (gridView && !document.getElementById('ph-tools-more')) {
    var moreTools = el('button', 'ph-btn ph-tools-more', 'Show all tools');
    moreTools.id = 'ph-tools-more';
    moreTools.type = 'button';
    moreTools.addEventListener('click', function () {
      location.hash = 'all-tools';
    });
    gridView.insertBefore(moreTools, gridView.firstChild);
  }
  (function () {
    var k = location.hash.replace('#', '');
    document.body.classList.toggle('ph-tools-collapsed', !(typeof HUBS !== 'undefined' && HUBS[k]) && k !== 'all-tools');
  })();
  function applyHub() {
    var key = location.hash.replace('#', '');
    var hub = HUBS[key];
    document.body.classList.toggle('ph-in-hub', !!hub);
    document.body.classList.toggle('ph-tools-collapsed', !hub && key !== 'all-tools');
    var bar = document.getElementById('ph-hubbar');
    if (!grid) return;
    grid.querySelectorAll(':scope > .category-group').forEach(function (g) {
      var on =
        !hub ||
        hub.cats.some(function (c) {
          return g.classList.contains('is-cat-' + c);
        });
      g.style.display = on ? '' : 'none';
      if (hub && on) {
        g.classList.remove('collapsed');
        var t = g.querySelector('.category-tools');
        if (t) {
          t.style.maxHeight = 'none';
          t.style.overflow = 'visible';
        }
      }
    });
    if (hub) {
      bar.hidden = false;
      bar.querySelector('h2').textContent = hub.title;
      bar.querySelector('p').textContent = hub.sub;
      var top = bar.getBoundingClientRect().top + window.scrollY - 90;
      window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    } else bar.hidden = true;
  }
  window.addEventListener('hashchange', applyHub);
  document.getElementById('ph-hub-back').addEventListener('click', function () {
    history.pushState(null, '', location.pathname + location.search);
    applyHub();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ---------------------------------------------------------------- once the tool list is drawn

  function whenGridReady(fn) {
    if (!grid) return;
    if (grid.querySelector('.category-group')) return fn();
    var mo = new MutationObserver(function () {
      if (grid.querySelector('.category-group')) {
        mo.disconnect();
        fn();
      }
    });
    mo.observe(grid, { childList: true });
  }
  whenGridReady(function () {
    var hrefs = {};
    grid.querySelectorAll(':scope > .category-group a.tool-card').forEach(function (a) {
      hrefs[a.getAttribute('href')] = 1;
    });
    var n = Object.keys(hrefs).length;
    var link = document.getElementById('ph-all-link');
    if (link && n) link.textContent = 'See all ' + n + ' tools';
    var search = document.getElementById('search-bar');
    if (search && n) search.placeholder = 'Search all ' + n + ' tools, like "rotate" or "Excel"';
    renderPins();
    grid.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.tool-fav-btn')) setTimeout(renderPins, 50);
    });
    applyHub();
  });

  renderRecent();
  renderSentHome();
  var homeSearch = $('#ph-home-search');
  if (homeSearch)
    homeSearch.addEventListener('click', function () {
      if (flow && flow.openSearch) flow.openSearch();
    });
  // From My documents: "Open" shows what you can do with that file.
  (function () {
    var params = new URLSearchParams(location.search);
    var id = params.get('ph-open');
    if (!id || !flow) return;
    params.delete('ph-open');
    history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash);
    flow.getAny(id).then(function (rec) {
      if (!rec || !rec.blob) return;
      offer([new File([rec.blob], rec.name, { type: rec.type })], [rec]);
      window.scrollTo({ top: home.getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });
    });
  })();
  // Check the account's sync setting (it may have been turned on from another device).
  if (flow && flow.syncStatus) {
    var was = flow.syncCached();
    flow.syncStatus(true).then(function (st) {
      if (st.on !== was || (st.on && st.files.length)) renderRecent();
      if (st.on) flow.catchUp().then(function () {}, function () {});
    });
  }
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) renderRecent();
  });
  // Coming back to the tab (say after saving something on the phone) picks up new synced files.
  var lastCheck = Date.now();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !flow || !flow.syncStatus || Date.now() - lastCheck < 15000) return;
    lastCheck = Date.now();
    flow.syncStatus(true).then(function () {
      renderRecent();
      if (flow.syncCached()) flow.catchUp().then(function () {}, function () {});
    });
  });
})();
