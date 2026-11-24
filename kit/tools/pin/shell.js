/*
 * Paperhaus: one layout for every tool page.
 *
 * The 126 tools that came from BentoPDF and the ones written for Paperhaus (Sign, Scan,
 * the image and Office tools, My documents) used to have different page layouts. This puts
 * them all in the same frame, lined up with the header:
 *
 *   Home / <group> / <tool>                      the path back
 *   [desk object]  Tool name                     the group's object from the Home desk
 *                  one line on what it does
 *   [the tool itself, on a paper card]
 *   More in <group>: a few paper tags            and a note that files stay on the device
 *
 * The group comes from /tools-index.json (each tool lists the groups it is in) and the
 * drawing from /desk.json (the same drawings as the desk on Home). The title row is built
 * straight away so nothing jumps; the group, drawing and tags fill in when those arrive.
 */
(function () {
  'use strict';

  var page = (location.pathname.split('/').pop() || '').replace(/\.html$/, '');
  if (/^(|index|my-documents|view-document|people|privacy|about|sign-request|licensing|faq|contact|terms|404)$/.test(page)) return;

  // Group slug -> [what to call it, where it links, desk object]. First match wins, so a tool
  // listed in several groups shows the most useful one.
  var GROUPS = [
    ['sign', 'Sign', '/request-signatures.html', 'pen'],
    ['scan', 'Scan', '/scan-document.html', 'camera'],
    ['make-files-smaller', 'Make smaller', '/#smaller', 'press'],
    ['secure-pdf', 'Protect', '/#secure', 'lock'],
    ['edit-annotate', 'Edit', '/#edit', 'pencil'],
    ['organize-manage', 'Combine or split', '/#all-tools', 'stapler'],
    ['convert-to-pdf', 'Convert', '/#convert', 'copier'],
    ['convert-from-pdf', 'Convert', '/#convert', 'copier'],
    ['photos-and-images', 'Photos and images', '/#convert', 'copier'],
    ['ai-on-this-device', 'Summarize or translate', '/#ai', 'lens'],
    ['optimize-repair', 'Fix and optimize', '/#all-tools', 'press'],
    ['handy-tools', 'Handy tools', '/#all-tools', 'stapler'],
  ];
  var PAGE_GROUP = { 'request-signatures': 'sign', 'sign-pdf': 'sign', 'scan-document': 'scan' };

  function el(tag, cls, text) {
    var x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text != null) x.textContent = text;
    return x;
  }
  function getJSON(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).catch(function () {
      return null;
    });
  }

  function start() {
    var card = document.getElementById('tool-uploader');
    var kit = !card && document.querySelector('main.es-wrap');
    var host = card || kit;
    if (!host || document.querySelector('.ph-shell')) return;
    var h1 = host.querySelector('h1');
    if (!h1) return;
    document.body.classList.add('ph-tool-page');

    // The frame: lined up with the header (same container).
    var shell;
    if (card) {
      shell = el('div', 'ph-shell container mx-auto px-4');
      card.parentNode.insertBefore(shell, card);
    } else {
      shell = kit;
      shell.classList.add('ph-shell', 'container', 'mx-auto');
    }

    // Home / group / tool
    var old = host.querySelector('nav[data-bentopdf-breadcrumb]');
    var crumbs = el('nav', 'ph-crumbs');
    crumbs.setAttribute('aria-label', 'Breadcrumb');
    var home = el('a', '', 'Home');
    home.href = '/';
    var groupLink = el('a', 'ph-crumb-group');
    groupLink.hidden = true;
    var sep2 = el('span', 'ph-crumb-sep', '/');
    sep2.hidden = true;
    var here = el('span', 'ph-crumb-here', (h1.textContent || '').trim());
    here.setAttribute('aria-current', 'page');
    crumbs.append(home, el('span', 'ph-crumb-sep', '/'), groupLink, sep2, here);
    if (old) old.remove();

    // [object] Title / one line
    var head = el('div', 'ph-tool-head');
    var spot = el('span', 'ph-spot');
    spot.setAttribute('aria-hidden', 'true');
    var title = el('div', 'ph-tool-title');
    var sub = h1.nextElementSibling && h1.nextElementSibling.tagName === 'P' ? h1.nextElementSibling : null;
    head.append(spot, title);

    if (card) {
      shell.append(crumbs, head, card);
      title.appendChild(h1);
      if (sub) title.appendChild(sub);
    } else {
      shell.insertBefore(crumbs, shell.firstChild);
      shell.insertBefore(head, h1);
      title.appendChild(h1);
      if (sub) title.appendChild(sub);
    }

    // More in <group>, at the end of the page.
    var more = el('section', 'ph-more');
    more.hidden = true;
    var moreHead = el('h2', '', '');
    var list = el('div', 'ph-more-list');
    var note = el('p', 'ph-local', 'Files stay on your device. What you save is kept in My documents.');
    more.append(moreHead, list, note);
    shell.appendChild(more);

    Promise.all([getJSON('/tools-index.json'), getJSON('/desk.json')]).then(function (r) {
      var tools = Array.isArray(r[0]) ? r[0] : [];
      var desk = r[1] || {};
      var me = tools.filter(function (t) {
        return (t.href || '').replace(/\.html$/, '') === page;
      })[0];
      var cats = (me && me.cats) || [];
      if (PAGE_GROUP[page]) cats = [PAGE_GROUP[page]].concat(cats);
      var group = null;
      for (var i = 0; i < GROUPS.length && !group; i++) if (cats.indexOf(GROUPS[i][0]) >= 0) group = GROUPS[i];
      if (!group) {
        spot.classList.add('is-empty');
        more.hidden = false;
        moreHead.hidden = true;
        return;
      }
      groupLink.textContent = group[1];
      groupLink.href = group[2];
      // "Home / Sign / Sign" says the same thing twice.
      var same = group[1].toLowerCase() === here.textContent.toLowerCase();
      groupLink.hidden = same;
      sep2.hidden = same;
      if (desk[group[3]]) spot.innerHTML = '<svg viewBox="0 0 120 80" focusable="false">' + desk[group[3]] + '</svg>';
      else spot.classList.add('is-empty');
      var others = tools.filter(function (t) {
        return t !== me && (t.cats || []).indexOf(group[0]) >= 0;
      }).slice(0, 4);
      if (others.length) {
        moreHead.textContent = 'More in ' + group[1];
        others.forEach(function (t) {
          var a = el('a', 'ph-more-tag');
          a.href = '/' + t.href.replace(/^\//, '');
          a.appendChild(el('strong', '', t.name));
          if (t.sub) a.appendChild(el('span', '', t.sub));
          list.appendChild(a);
        });
      } else moreHead.hidden = true;
      more.hidden = false;
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
