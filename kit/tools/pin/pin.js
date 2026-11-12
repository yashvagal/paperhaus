/* Paperhaus: pin the site like an app, and show who is signed in.
 *
 * No app store: Paperhaus is a website you pin. Chrome, Edge and Android get a one-tap
 * "Pin" button; iPhone, iPad and Mac Safari get the two steps to do it by hand. Once
 * pinned, it opens in its own window from the dock, taskbar or home screen.
 *
 * Sign-in is Cloudflare Access. When it is in front of the site, the signed-in email is
 * read from Access (same site, nothing stored elsewhere) and shown with a Sign out item.
 * Runs on every page; plain script, no build step.
 */
(function () {
  'use strict';

  var ua = navigator.userAgent;
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/.test(ua);
  var isMacSafari = !isIOS && /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
  var isFirefox = /Firefox\//.test(ua);
  var isEdge = /Edg\//.test(ua);
  var standalone = function () {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: window-controls-overlay)').matches ||
      navigator.standalone === true
    );
  };

  var store = {
    get: function (k) {
      try {
        return localStorage.getItem(k);
      } catch (e) {
        return null;
      }
    },
    set: function (k, v) {
      try {
        if (v === null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch (e) {
        /* private mode */
      }
    },
  };

  var deferredPrompt = null;
  var bar = null;
  var pinBtn = null;

  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) n.setAttribute(k, attrs[k]);
    if (html) n.innerHTML = html;
    return n;
  }

  function mount() {
    var row = document.querySelector('nav[data-simple-nav] .container > div') || document.querySelector('nav[data-simple-nav]');
    if (!row || document.getElementById('ph-bar')) return;
    bar = el('div', { id: 'ph-bar', class: 'ph-bar' });
    row.appendChild(bar);

    pinBtn = el('button', { type: 'button', class: 'ph-pin', id: 'ph-pin', hidden: '' },
      '<i class="ph ph-push-pin" aria-hidden="true"></i><span>' + (isIOS || isAndroid ? 'Add to home screen' : 'Pin app') + '</span>');
    pinBtn.addEventListener('click', onPin);
    bar.appendChild(pinBtn);
    updatePin();
    showAccount();
  }

  // ---------------------------------------------------------------- pinning

  function canPinHere() {
    // Already running as the pinned app: nothing to do. Otherwise always offer it: a
    // pin removed later (or made in another browser) leaves no trace the page can see.
    return !standalone();
  }

  function updatePin() {
    if (!pinBtn) return;
    if (canPinHere()) pinBtn.removeAttribute('hidden');
    else pinBtn.setAttribute('hidden', '');
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    store.set('ph-pinned', null);
    updatePin();
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    store.set('ph-pinned', '1');
    updatePin();
    closeSheet();
  });

  function onPin() {
    if (deferredPrompt) {
      var p = deferredPrompt;
      deferredPrompt = null;
      p.prompt();
      p.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'accepted') store.set('ph-pinned', '1');
        updatePin();
      });
      return;
    }
    openSheet(steps());
  }

  function steps() {
    var signIn = 'Open Paperhaus from there and sign in once. It remembers you for a month.';
    if (isIOS) {
      return {
        title: 'Add Paperhaus to your home screen',
        items: [
          'Tap the <b>Share</b> button <i class="ph ph-export" aria-hidden="true"></i> (at the bottom in Safari, or in the address bar).',
          'Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.',
          signIn + ' A home screen app keeps its own sign-in, separate from Safari.',
        ],
      };
    }
    if (isMacSafari) {
      return {
        title: 'Pin Paperhaus to your Dock',
        items: ['In the menu bar, choose <b>File</b> then <b>Add to Dock</b>.', 'Click <b>Add</b>.', signIn],
      };
    }
    if (isFirefox) {
      return {
        title: 'Pin Paperhaus',
        items: [
          'Firefox does not pin websites as apps. Open this page in <b>Chrome</b>, <b>Edge</b> or <b>Safari</b> and tap Pin app there.',
          'Or keep it one click away: drag this tab to the left and choose <b>Pin Tab</b>, or bookmark it.',
        ],
      };
    }
    if (isAndroid) {
      return {
        title: 'Add Paperhaus to your home screen',
        items: ['Tap the browser menu <b>&#8942;</b>.', 'Tap <b>Add to Home screen</b>, then <b>Install</b>.', signIn],
      };
    }
    if (isEdge) {
      return {
        title: 'Pin Paperhaus',
        items: [
          'Open the menu <b>&#8943;</b> and choose <b>Apps</b>, then <b>Install this site as an app</b>.',
          'Right-click Paperhaus in the taskbar or Dock and choose <b>Pin</b>.',
          'If it is already installed, open it from your apps instead.',
        ],
      };
    }
    return {
      title: 'Pin Paperhaus',
      items: [
        'Click the install icon <i class="ph ph-download-simple" aria-hidden="true"></i> at the right end of the address bar, or open the menu <b>&#8942;</b> and choose <b>Cast, save and share</b>, then <b>Install page as app</b>.',
        'Right-click Paperhaus in the taskbar or Dock and choose <b>Pin</b> or <b>Keep in Dock</b>.',
        'If it is already installed, open it from your apps instead.',
      ],
    };
  }

  var sheet = null;
  function openSheet(s) {
    closeSheet();
    sheet = el('div', { class: 'ph-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': s.title });
    var card = el('div', { class: 'ph-sheet-card' });
    var head = el('div', { class: 'ph-sheet-head' });
    head.appendChild(el('img', { src: '/images/favicon-192x192.png', alt: '', width: '44', height: '44' }));
    head.appendChild(el('h2', {}, s.title));
    var x = el('button', { type: 'button', class: 'ph-sheet-x', 'aria-label': 'Close' }, '<i class="ph ph-x"></i>');
    x.addEventListener('click', closeSheet);
    head.appendChild(x);
    card.appendChild(head);
    var ol = el('ol', { class: 'ph-steps' });
    s.items.forEach(function (t) {
      // One span per step, so bold words and icons flow inside the sentence.
      ol.appendChild(el('li', {}, '<span>' + t + '</span>'));
    });
    card.appendChild(ol);
    card.appendChild(el('p', { class: 'ph-sheet-note' },
      'It is still this website: no app store, nothing to update, and your files stay on your device.'));
    sheet.appendChild(card);
    sheet.addEventListener('click', function (e) {
      if (e.target === sheet) closeSheet();
    });
    document.body.appendChild(sheet);
    x.focus();
  }

  function closeSheet() {
    if (sheet) sheet.remove();
    sheet = null;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeSheet();
      closeMenu();
    }
  });

  // ---------------------------------------------------------------- account

  var menu = null;
  function closeMenu() {
    if (menu) menu.remove();
    menu = null;
  }

  function renderAccount(id) {
    if (!bar || !id || !id.email) return;
    var old = document.getElementById('ph-me');
    if (old) old.remove();
    var name = id.name || id.email.split('@')[0];
    var btn = el('button', { type: 'button', class: 'ph-me', id: 'ph-me', 'aria-haspopup': 'menu', title: id.email },
      '<span class="ph-avatar" aria-hidden="true"></span><span class="ph-me-name"></span>');
    btn.querySelector('.ph-avatar').textContent = name.trim().charAt(0).toUpperCase();
    btn.querySelector('.ph-me-name').textContent = name;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (menu) return closeMenu();
      menu = el('div', { class: 'ph-menu', role: 'menu' });
      var who = el('div', { class: 'ph-menu-who' });
      who.appendChild(el('strong', {})).textContent = name;
      who.appendChild(el('span', {})).textContent = id.email;
      menu.appendChild(who);
      var site = document.querySelector('meta[name="paperhaus-site"]');
      var siteUrl = site && site.getAttribute('content');
      if (siteUrl && /^https?:\/\//i.test(siteUrl)) {
        var about = el('a', { href: siteUrl, role: 'menuitem', class: 'ph-menu-item' },
          '<i class="ph ph-info" aria-hidden="true"></i> About Paperhaus');
        menu.appendChild(about);
      }
      // Pin to the phone's home screen, or as an app on a computer.
      if (canPinHere()) {
        var pinItem = el('button', { type: 'button', role: 'menuitem', class: 'ph-menu-item' },
          '<i class="ph ph-push-pin" aria-hidden="true"></i> ' + (isIOS || isAndroid ? 'Add to home screen' : 'Pin as an app'));
        pinItem.addEventListener('click', function () {
          closeMenu();
          onPin();
        });
        menu.appendChild(pinItem);
      }
      // Recent files live only in this browser (flow.js); this empties that list.
      if (window.paperhausFlow) {
        var clear = el('button', { type: 'button', role: 'menuitem', class: 'ph-menu-item' },
          '<i class="ph ph-broom" aria-hidden="true"></i> Clear recent files');
        clear.addEventListener('click', function () {
          window.paperhausFlow.clear().then(function () {
            clear.innerHTML = '<i class="ph ph-check" aria-hidden="true"></i> Recent files cleared';
            var list = document.getElementById('ph-recent-list');
            if (list) list.innerHTML = '<p class="ph-muted">Files you make here show up on this device, so you can keep working on them. Nothing is uploaded.</p>';
          });
        });
        menu.appendChild(clear);
      }
      var out = el('a', { href: '/cdn-cgi/access/logout', role: 'menuitem', class: 'ph-menu-item' },
        '<i class="ph ph-sign-out" aria-hidden="true"></i> Sign out');
      out.addEventListener('click', function () {
        store.set('ph-identity', null);
      });
      menu.appendChild(out);
      btn.parentNode.appendChild(menu);
    });
    bar.appendChild(btn);
  }

  document.addEventListener('click', function (e) {
    if (menu && !menu.contains(e.target)) closeMenu();
  });

  function showAccount() {
    // Show the last known sign-in straight away, then confirm it with Access.
    try {
      var cached = JSON.parse(store.get('ph-identity') || 'null');
      if (cached) renderAccount(cached);
    } catch (e) {
      /* ignore */
    }
    fetch('/cdn-cgi/access/get-identity', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) {
        var type = r.headers.get('content-type') || '';
        if (!r.ok || type.indexOf('json') === -1) throw new Error('no identity');
        return r.json();
      })
      .then(function (j) {
        var id = { email: j.email || '', name: j.name || '' };
        if (!id.email) throw new Error('no email');
        store.set('ph-identity', JSON.stringify(id));
        renderAccount(id);
      })
      .catch(function () {
        // Not behind Access (for example a local preview): no account chip.
        store.set('ph-identity', null);
        var b = document.getElementById('ph-me');
        if (b) b.remove();
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
