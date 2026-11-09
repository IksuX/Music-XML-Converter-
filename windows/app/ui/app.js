/* Nuty → MusicXML (Windows) — main window. Talks to Python via window.pywebview.api. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var api = null;
  var state = null;
  var logIndex = 0;
  var selected = {};
  var lastJobsKey = '';
  var settingsSynced = false;

  // ------------------------------------------------------------ start
  function ready() {
    api = window.pywebview.api;
    bind();
    tick();
    setInterval(tick, 400);
  }
  if (window.pywebview && window.pywebview.api) { ready(); }
  else { window.addEventListener('pywebviewready', ready); }

  function tick() {
    api.get_state(logIndex).then(render).catch(function (e) { console.error(e); });
  }

  // ------------------------------------------------------------ rysowanie
  function render(s) {
    state = s;
    // log
    if (s.log_reset) { $('log-lines').textContent = ''; }
    if (s.log_lines && s.log_lines.length) { appendLog(s.log_lines); }
    if (s.log_total < logIndex) { $('log-lines').textContent = ''; }
    logIndex = s.log_total;
    $('log-count').textContent = $('log-lines').childElementCount + ' linii';

    // silnik
    Array.prototype.forEach.call(document.querySelectorAll('#engine button'), function (b) {
      b.classList.toggle('on', b.dataset.v === s.settings.engine);
      b.disabled = s.running;
    });
    badge('b-vector', true);
    badge('b-audiveris', !!s.engines.audiveris);
    badge('b-oemer', !!s.engines.oemer);
    $('setup-banner').hidden = !!(s.engines.audiveris || s.engines.oemer);

    // opcje zapisu
    if (!settingsSynced || !s.running) {
      $('out-loc').value = s.settings.output_location;
      $('keep-mxl').checked = s.settings.keep_mxl;
      settingsSynced = true;
    }
    $('out-folder').hidden = s.settings.output_location !== 'folder';
    var f = s.settings.output_folder;
    $('out-folder').querySelector('span').textContent = f ? f.split(/[\\/]/).pop() : 'Wybierz folder…';
    $('out-folder').title = f || '';
    $('keep-mxl-wrap').hidden = s.settings.engine === 'oemer';
    ['out-loc', 'out-folder', 'keep-mxl'].forEach(function (id) { $(id).disabled = s.running; });

    // lista
    renderJobs(s.jobs);

    // stopka
    $('missing').textContent = s.missing || '';
    $('spin').hidden = !(s.running || s.installing);
    $('btn-cancel').hidden = !s.running;
    $('btn-start').hidden = s.running;
    $('btn-start').disabled = !s.can_start;
    $('btn-clear').disabled = s.running || !s.jobs.length;
    $('btn-reset').hidden = s.running || !s.jobs.some(function (j) { return j.status !== 'waiting'; });

    renderUpdate(s.update);
    renderSettings(s);
  }

  function renderUpdate(u) {
    if (!u) { return; }
    var a = u.available;
    $('update-banner').hidden = !a || (u.dismissed && !u.busy);
    if (a) {
      $('up-ver').textContent = a.version;
      $('up-cur').textContent = u.current;
    }
    var downloading = u.busy && a && u.progress > 0;
    $('up-prog').hidden = !downloading;
    $('up-prog').value = u.progress || 0;
    $('up-status').textContent = a ? u.status : '';
    $('up-install').disabled = u.busy || state.running || state.installing;
    $('up-later').disabled = u.busy;
    $('cur-ver').textContent = u.current;
    $('up-check-status').textContent = a ? '' : (u.status || '');
  }

  function badge(id, ok) {
    var el = $(id);
    el.classList.toggle('ok', ok);
    var base = el.dataset.base || (el.dataset.base = el.textContent);
    el.lastChild.textContent = ok ? base : base + ': brak';
  }

  function appendLog(lines) {
    var box = $('log-lines');
    var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    var frag = document.createDocumentFragment();
    lines.forEach(function (l) {
      var d = document.createElement('div');
      d.textContent = l;
      if (l.indexOf('⚠︎') === 0 || l.indexOf('[PDF] UWAGA') === 0) { d.className = 'w'; }
      else if (l.indexOf('✓') === 0) { d.className = 'o'; }
      else if (l.indexOf('▶︎') === 0) { d.className = 's'; }
      frag.appendChild(d);
      if (/^(⚠︎|✓|ℹ︎)/.test(l) && $('log').hidden && /Instal|Zainstal|Pobier/.test(l)) { $('log').hidden = false; }
    });
    box.appendChild(frag);
    while (box.childElementCount > 3000) { box.removeChild(box.firstChild); }
    if (atBottom) { box.scrollTop = box.scrollHeight; }
  }

  function renderJobs(jobs) {
    $('empty').hidden = jobs.length > 0;
    $('jobs').hidden = jobs.length === 0;
    var key = JSON.stringify(jobs) + JSON.stringify(selected);
    if (key === lastJobsKey) { return; }
    lastJobsKey = key;
    var ul = $('jobs');
    ul.textContent = '';
    jobs.forEach(function (j) {
      var li = document.createElement('li');
      li.className = 'job' + (selected[j.id] ? ' sel' : '');
      li.dataset.id = j.id;
      var icon = el('span', 'job__icon', j.pdf ? '📄' : '🖼');
      var main = el('div', 'job__main');
      main.appendChild(el('div', 'job__name', j.name));
      var st = el('div', 'job__status ' + j.status,
        (j.pdf ? (j.pages === 1 ? '1 strona · ' : j.pages + ' str. · ') : '') + statusIcon(j.status) + ' ' + j.text);
      main.appendChild(st);
      var out = el('div', 'job__out');
      j.outputs.forEach(function (o) {
        var play = el('button', '', '▶ ' + (o.label === 'Odtwórz' ? 'Odtwórz' : o.label));
        play.title = 'Odtwórz ' + o.name + ' w odtwarzaczu (jak we wtyczce chóralnej)';
        play.onclick = function (e) { e.stopPropagation(); api.play(o.path); };
        var ed = el('button', 'ico', '✎');
        ed.title = 'Otwórz ' + o.name + ' w domyślnym programie (np. MuseScore)';
        ed.onclick = function (e) { e.stopPropagation(); api.open_external(o.path); };
        out.appendChild(play); out.appendChild(ed);
      });
      if (j.outputs.length) {
        var rv = el('button', 'ico', '📁');
        rv.title = 'Pokaż w folderze';
        rv.onclick = function (e) { e.stopPropagation(); api.reveal(j.outputs[0].path); };
        out.appendChild(rv);
      }
      li.appendChild(icon); li.appendChild(main); li.appendChild(out);
      li.onclick = function (e) {
        if (!e.ctrlKey && !e.metaKey) { selected = {}; }
        selected[j.id] = !selected[j.id];
        lastJobsKey = '';
        renderJobs(state.jobs);
      };
      ul.appendChild(li);
    });
  }

  function statusIcon(s) {
    return { waiting: '⏱', working: '⚙', done: '✔', partial: '⚠', failed: '✖' }[s] || '';
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined) { e.textContent = text; }
    return e;
  }

  // ------------------------------------------------------------ ustawienia
  var settingsOpenedSync = false;
  function renderSettings(s) {
    var dlg = $('settings');
    if (!dlg.open) { settingsOpenedSync = false; return; }
    if (!settingsOpenedSync) {
      $('use-vector').checked = s.settings.use_vector;
      $('ocr-langs').value = s.settings.ocr_languages;
      $('deskew').checked = s.settings.oemer_deskew;
      $('merge-pages').checked = s.settings.merge_oemer_pages;
      $('auto-update').checked = s.settings.auto_update;
      settingsOpenedSync = true;
    }
    status('st-audiveris', s.engines.audiveris, 'Nie znaleziono — zainstaluj albo wskaż Audiveris.exe');
    status('st-oemer', s.engines.oemer, 'Nie zainstalowano');
    var miss = s.engines.ocr_missing || [];
    var o = $('st-ocr');
    o.className = 'st ' + (miss.length ? 'warn' : 'ok');
    o.textContent = miss.length ? '⚠ Brak plików OCR: ' + miss.join(', ') + ' — tekst pod nutami nie zostanie odczytany'
                                : '✔ Pliki OCR zainstalowane';
    Array.prototype.forEach.call(dlg.querySelectorAll('[data-install],[data-choose]'), function (b) {
      b.disabled = s.installing || s.running;
    });
    $('install-note').hidden = !s.installing;
  }

  function status(id, path, missing) {
    var e = $(id);
    e.className = 'st ' + (path ? 'ok' : 'no');
    e.textContent = path ? '✔ ' + path : '✖ ' + missing;
  }

  // ------------------------------------------------------------ akcje
  function bind() {
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) { return; }
      var a = b.dataset.act;
      if (a === 'add') { api.add_files(); }
      else if (a === 'clear-list') { selected = {}; api.clear_list(); }
      else if (a === 'reset') { api.reset_finished(); }
      else if (a === 'start') { api.start(); }
      else if (a === 'cancel') { api.cancel(); }
      else if (a === 'toggle-log') { toggleLog(); }
      else if (a === 'play-file') { api.choose_player_file(); }
      else if (a === 'open-settings') { api.refresh_engines(); $('settings').showModal(); }
      else if (a === 'log-copy') { copyLog(); }
      else if (a === 'log-save') { api.log_save().then(function (ok) { if (ok) { toast('Log zapisany'); } }); }
      else if (a === 'log-clear') { clearLog(); }
      else if (a === 'up-check') { api.check_update(); }
      else if (a === 'up-notes') { api.open_update_page(); }
      else if (a === 'up-later') { api.dismiss_update(); }
      else if (a === 'up-install') {
        api.install_update().then(function (r) { if (r && !r.ok) { toast(r.error, 5000); } });
      }
    });

    Array.prototype.forEach.call(document.querySelectorAll('#engine button'), function (b) {
      b.onclick = function () { api.set_setting('engine', b.dataset.v); };
    });
    $('out-loc').onchange = function () {
      if (this.value === 'folder' && !state.settings.output_folder) { api.choose_output_folder(); }
      else { api.set_setting('output_location', this.value); }
    };
    $('out-folder').onclick = function () { api.choose_output_folder(); };
    $('keep-mxl').onchange = function () { api.set_setting('keep_mxl', this.checked); };

    $('use-vector').onchange = function () { api.set_setting('use_vector', this.checked); };
    $('deskew').onchange = function () { api.set_setting('oemer_deskew', this.checked); };
    $('merge-pages').onchange = function () { api.set_setting('merge_oemer_pages', this.checked); };
    $('auto-update').onchange = function () { api.set_setting('auto_update', this.checked); };
    $('ocr-langs').onchange = function () { api.set_setting('ocr_languages', this.value.trim() || 'pol+eng'); };
    Array.prototype.forEach.call(document.querySelectorAll('[data-install]'), function (b) {
      b.onclick = function () { $('log').hidden = false; api.install(b.dataset.install); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-choose]'), function (b) {
      b.onclick = function () { api.choose_engine_file(b.dataset.choose); };
    });

    // wygląd przy przeciąganiu (same ścieżki plików odbiera Python — patrz main.py)
    var drop = $('drop'), depth = 0;
    document.addEventListener('dragenter', function (e) { e.preventDefault(); depth++; drop.classList.add('over'); });
    document.addEventListener('dragleave', function () { if (--depth <= 0) { depth = 0; drop.classList.remove('over'); } });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function () { depth = 0; drop.classList.remove('over'); });

    document.addEventListener('keydown', function (e) {
      var ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === 'Enter') { e.preventDefault(); if (state && state.can_start) { api.start(); } }
      else if (ctrl && e.shiftKey && (e.key === 'S' || e.key === 's')) { e.preventDefault(); api.log_save(); }
      else if (ctrl && e.shiftKey && (e.key === 'O' || e.key === 'o')) { e.preventDefault(); api.choose_player_file(); }
      else if (ctrl && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); api.add_files(); }
      else if (ctrl && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); clearLog(); }
      else if (e.key === 'Delete' && !$('settings').open) {
        var ids = Object.keys(selected).filter(function (k) { return selected[k]; });
        if (ids.length) { api.remove(ids); selected = {}; }
      }
    });
  }

  function toggleLog() {
    var l = $('log');
    l.hidden = !l.hidden;
    $('btn-log').textContent = l.hidden ? 'Log ▴' : 'Log ▾';
    if (!l.hidden) { var b = $('log-lines'); b.scrollTop = b.scrollHeight; }
  }

  function clearLog() {
    api.log_clear();
    $('log-lines').textContent = '';
  }

  function copyLog() {
    api.log_text().then(function (t) {
      var done = function () { toast('Log skopiowany do schowka'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(done, function () { fallbackCopy(t); done(); });
      } else { fallbackCopy(t); done(); }
    });
  }

  function fallbackCopy(t) {
    var ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* nic */ }
    document.body.removeChild(ta);
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 1800);
  }
})();
