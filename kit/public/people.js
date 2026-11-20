/* Paperhaus: the owner's invite list page (people.html). Talks to /api/admin/. */
(function () {
  var list = document.getElementById('list');
  var msg = document.getElementById('msg');
  var count = document.getElementById('count');
  var email = document.getElementById('email');
  var nameIn = document.getElementById('name');
  var addbtn = document.getElementById('addbtn');
  var me = '';
  var names = {};
  var emails = [];
  var ERR = {
    not_allowed: 'Only the owner can change who can use Paperhaus.',
    not_configured: 'This page is not set up yet: the Cloudflare key is missing.',
    bad_email: 'That does not look like an email address.',
    cannot_remove_owner: 'You cannot remove yourself.',
  };
  function say(text, kind) { msg.textContent = text; msg.className = 'msg' + (kind ? ' ' + kind : ''); }
  function call(path, body) {
    return fetch('/api/admin/' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(ERR[j.error] || j.detail || 'Something went wrong. Try again.'); return j; }); });
  }
  function el(tag, cls, text) { var x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; }
  function take(j) { if (j.emails) emails = j.emails; if (j.names) names = j.names; render(); }
  function label(e) { return names[e] || ''; }
  function render() {
    list.innerHTML = '';
    count.textContent = emails.length + (emails.length === 1 ? ' person' : ' people');
    emails.slice().sort(function (a, b) { return (label(a) || a).localeCompare(label(b) || b); }).forEach(function (e) {
      var li = el('li');
      var who = el('div', 'who');
      var n = label(e);
      who.appendChild(n ? el('strong', '', n) : el('strong', 'noname', 'No name yet'));
      who.appendChild(el('small', '', e + (e === me ? ' · you' : '')));
      li.appendChild(who);
      var acts = el('div', 'acts');
      var ed = el('button', 'ed', n ? 'Edit name' : 'Add name');
      ed.type = 'button';
      ed.addEventListener('click', function () { editName(li, who, acts, e); });
      acts.appendChild(ed);
      if (e !== me) {
        var wb = el('button', 'ed', 'Send welcome');
        wb.type = 'button';
        wb.title = 'Email them the "You\'re in" note with how to sign in';
        wb.addEventListener('click', function () {
          wb.disabled = true;
          call('welcome', { email: e }).then(function (j) {
            if (j.welcomed) { wb.textContent = 'Sent'; say('Welcome email sent to ' + (n || e) + '.', 'good'); }
            else { wb.disabled = false; say('Could not send the welcome email: ' + (j.welcomeError || 'try again'), 'bad'); }
          }).catch(function (err) { wb.disabled = false; say(err.message, 'bad'); });
        });
        acts.appendChild(wb);
        var b = el('button', 'rm', 'Remove');
        b.type = 'button';
        b.addEventListener('click', function () {
          if (!b.classList.contains('sure')) { b.classList.add('sure'); b.textContent = 'Remove ' + (n || e.split('@')[0]) + '?'; return; }
          b.disabled = true;
          call('remove', { email: e }).then(function (j) { take(j); say(e + ' removed.', 'good'); })
            .catch(function (err) { b.disabled = false; say(err.message, 'bad'); });
        });
        acts.appendChild(b);
      }
      li.appendChild(acts);
      list.appendChild(li);
    });
  }
  function editName(li, who, acts, e) {
    var input = el('input', 'nm');
    input.type = 'text'; input.maxLength = 80; input.placeholder = 'Full name'; input.value = label(e);
    input.setAttribute('aria-label', 'Name for ' + e);
    var save = el('button', 'ed', 'Save');
    save.type = 'button';
    who.hidden = true; acts.hidden = true;
    li.insertBefore(input, who); li.insertBefore(save, who);
    input.focus();
    function done() {
      save.disabled = true;
      call('name', { email: e, name: input.value }).then(function (j) { take(j); say('Saved.', 'good'); })
        .catch(function (err) { save.disabled = false; say(err.message, 'bad'); });
    }
    save.addEventListener('click', done);
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); done(); } if (ev.key === 'Escape') render(); });
  }
  document.getElementById('add').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var e = email.value.trim().toLowerCase();
    var n = nameIn.value.trim();
    if (!e) return;
    addbtn.disabled = true; say('Adding...');
    var wel = document.getElementById('welcome');
    call('add', { email: e, name: n, welcome: !!(wel && wel.checked) }).then(function (j) {
      take(j); email.value = ''; nameIn.value = '';
      if (!j.changed) { say((n ? 'Saved ' + n + '. ' : '') + e + ' was already on the list. Use Send welcome to email them.', 'good'); return; }
      if (j.welcomed) say((n || e) + ' can now sign in. A welcome email with how to sign in is on its way.', 'good');
      else if (wel && wel.checked) say((n || e) + ' can now sign in, but the welcome email did not send: ' + (j.welcomeError || 'try Send welcome') + '.', 'bad');
      else say((n || e) + ' can now sign in.', 'good');
    }).catch(function (err) { say(err.message, 'bad'); })
      .then(function () { addbtn.disabled = false; });
  });
  fetch('/cdn-cgi/access/get-identity').then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
    .then(function (id) {
      me = String((id && id.email) || '').toLowerCase();
      if (me) return null;
      return call('me').then(function (j) { me = String((j && j.email) || '').toLowerCase(); }, function () {});
    })
    .then(function () { return call('people'); })
    .then(take)
    .catch(function (err) { list.innerHTML = ''; say(err.message, 'bad'); });
})();
