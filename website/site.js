/* Paperhaus front page: points every app link at the app's address from config.js,
 * and shows the pinning steps for the visitor's device. No tracking, no third parties. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- app links
  var base = String(window.PAPERHAUS_APP_URL || '').replace(/\/+$/, '');
  if (/^https?:\/\/[^\s"<>]+$/i.test(base)) {
    document.querySelectorAll('[data-app]').forEach(function (a) {
      a.setAttribute('href', base + a.getAttribute('data-app'));
    });
    try {
      var host = new URL(base).host;
      document.querySelectorAll('[data-app-host]').forEach(function (el) { el.textContent = host; });
    } catch (e) { /* keep the default label */ }
  }

  // ---------------------------------------------------------------- pin steps
  var PIN = {
    iphone: [
      'Open Paperhaus in Safari and tap <b>Share</b>.',
      'Tap <b>Add to Home Screen</b>, then <b>Add</b>.',
      'Open it from your home screen and sign in once.'
    ],
    android: [
      'Open Paperhaus in Chrome and tap <b>Add to home screen</b> at the top right.',
      'Tap <b>Install</b>.',
      'Open it from your home screen. You stay signed in for a month.'
    ],
    mac: [
      'In Chrome or Edge, click <b>Pin app</b> at the top right. In Safari, choose <b>File</b>, then <b>Add to Dock</b>.',
      'It opens in its own window from the Dock.',
      'Right-click the icon for Scan, Merge, Compress and Sign.'
    ],
    windows: [
      'In Chrome or Edge, click <b>Pin app</b> at the top right, then <b>Install</b>.',
      'Right-click Paperhaus in the taskbar and choose <b>Pin to taskbar</b>.',
      'Right-click the icon for Scan, Merge, Compress and Sign.'
    ]
  };
  var list = document.getElementById('pin-steps');
  var tabs = document.querySelectorAll('[data-pin]');
  function show(key) {
    if (!list || !PIN[key]) return;
    list.innerHTML = PIN[key].map(function (s) { return '<li><span>' + s + '</span></li>'; }).join('');
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-pin') === key;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { show(t.getAttribute('data-pin')); });
    t.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      show(next.getAttribute('data-pin'));
    });
  });
  var ua = navigator.userAgent;
  var touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  show(/iPhone|iPad|iPod/.test(ua) || touchMac ? 'iphone' : /Android/.test(ua) ? 'android' : /Mac/.test(ua) ? 'mac' : 'windows');
})();
