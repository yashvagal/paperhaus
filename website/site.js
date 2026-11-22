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

/* Clean section links: links to a section on the same page (href="#how" or "/#how") scroll there
   without putting "#how" in the address bar, and a page opened with a "#section" (for example from
   the privacy page's "/#faq") scrolls to it and then drops the hash. Without JavaScript the links
   still work as ordinary anchors. */
(function () {
  if (window.__cleanAnchors) return;
  window.__cleanAnchors = true;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function find(hash) {
    if (!hash || hash === "#" || hash === "#top") return document.getElementById("top") || document.body;
    try { return document.getElementById(decodeURIComponent(hash.slice(1))); } catch (e) { return null; }
  }
  function go(el, smooth) {
    if (el === document.body) window.scrollTo({ top: 0, behavior: smooth && !reduce ? "smooth" : "auto" });
    else el.scrollIntoView({ behavior: smooth && !reduce ? "smooth" : "auto", block: "start" });
    if (el !== document.body && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      try { el.focus({ preventScroll: true }); } catch (e) {}
    }
  }
  function strip() {
    if (location.hash && history.replaceState) history.replaceState(history.state, "", location.pathname + location.search);
  }
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href*='#']") : null;
    if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
    var url;
    try { url = new URL(a.href, location.href); } catch (err) { return; }
    if (url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search) return;
    var el = find(url.hash);
    if (!el) return;
    e.preventDefault();
    go(el, true);
    strip();
  }, true);
  function arrive() {
    if (!location.hash) return;
    var el = find(location.hash);
    strip();
    if (el) requestAnimationFrame(function () { go(el, false); });
  }
  window.addEventListener("hashchange", arrive);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", arrive);
  else arrive();
})();
