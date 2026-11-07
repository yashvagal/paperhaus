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
        ['compress-pdf', 'Compress them'],
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
        ['request-signatures?mode=others', 'Get it signed by others'],
        ['form-filler', 'Fill in the form', false, 'form'],
        ['compress-pdf', 'Compress'],
        ['pdf-multi-tool', 'Merge or reorder pages'],
        ['pdf-to-word', 'Convert to Word'],
        ['redact-pdf', 'Redact'],
        ['protect-pdf', 'Add a password'],
        ['edit-pdf', 'Edit'],
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
  $('#ph-url').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('#ph-url input').value.trim();
    if (!v) return;
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    location.href = '/html-to-pdf.html?url=' + encodeURIComponent(v);
  });

  // ---------------------------------------------------------------- recent files

  function renderRecent() {
    var host = $('#ph-recent-list');
    if (!flow) return;
    flow
      .list()
      .then(function (all) {
        var recs = all
          .filter(function (r) {
            return r.kept;
          })
          .slice(0, 5);
        host.textContent = '';
        if (!recs.length) {
          host.appendChild(el('p', 'ph-muted', 'Files you make here show up on this device, so you can keep working on them. Nothing is uploaded.'));
          return;
        }
        recs.forEach(function (r) {
          var row = el('div', 'ph-recent-row');
          row.appendChild(el('span', 'ph-filebadge', (ext(r.name) || 'file').slice(0, 4).toUpperCase()));
          var info = el('div', 'ph-recent-info');
          info.appendChild(el('strong', '', r.name));
          info.appendChild(el('span', '', (r.tool ? r.tool + ' · ' : '') + when(r.at)));
          row.appendChild(info);
          var open = el('button', 'ph-linkbtn', 'Open');
          open.type = 'button';
          open.addEventListener('click', function () {
            var f = new File([r.blob], r.name, { type: r.type });
            offer([f], [r]);
            window.scrollTo({ top: home.getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });
          });
          row.appendChild(open);
          host.appendChild(row);
        });
      })
      .catch(function () {
        host.textContent = '';
        host.appendChild(el('p', 'ph-muted', 'Recent files are not available in this browser window.'));
      });
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
    if (!shown) host.appendChild(el('p', 'ph-muted', 'Star any tool in the list below to keep it here.'));
  }

  // ---------------------------------------------------------------- hubs

  var grid = document.getElementById('tool-grid');
  function applyHub() {
    var key = location.hash.replace('#', '');
    var hub = HUBS[key];
    document.body.classList.toggle('ph-in-hub', !!hub);
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
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) renderRecent();
  });
})();
