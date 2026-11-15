/* Paperhaus: the owner's invite list page (people.html). Talks to /api/admin/. */
(function () {
  var list = document.getElementById('list');
  var msg = document.getElementById('msg');
  var count = document.getElementById('count');
  var email = document.getElementById('email');
  var addbtn = document.getElementById('addbtn');
  var me = '';
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
  function render(emails) {
    list.innerHTML = '';
    count.textContent = emails.length + (emails.length === 1 ? ' person' : ' people');
    emails.slice().sort().forEach(function (e) {
      var li = document.createElement('li');
      var s = document.createElement('span');
      s.textContent = e;
      li.appendChild(s);
      if (e === me) {
        var y = document.createElement('span'); y.className = 'you'; y.textContent = 'you'; li.appendChild(y);
      } else {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'rm'; b.textContent = 'Remove';
        b.addEventListener('click', function () {
          if (!b.classList.contains('sure')) { b.classList.add('sure'); b.textContent = 'Remove ' + e.split('@')[0] + '?'; return; }
          b.disabled = true;
          call('remove', { email: e }).then(function (j) { render(j.emails); say(e + ' removed.', 'good'); })
            .catch(function (err) { b.disabled = false; say(err.message, 'bad'); });
        });
        li.appendChild(b);
      }
      list.appendChild(li);
    });
  }
  document.getElementById('add').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var e = email.value.trim().toLowerCase();
    if (!e) return;
    addbtn.disabled = true; say('Adding...');
    call('add', { email: e }).then(function (j) {
      render(j.emails); email.value = '';
      say(j.changed ? e + ' can now sign in.' : e + ' was already on the list.', 'good');
    }).catch(function (err) { say(err.message, 'bad'); })
      .then(function () { addbtn.disabled = false; });
  });
  fetch('/cdn-cgi/access/get-identity').then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
    .then(function (id) { me = String((id && id.email) || '').toLowerCase(); return call('people'); })
    .then(function (j) { render(j.emails); })
    .catch(function (err) { list.innerHTML = ''; say(err.message, 'bad'); });
})();
