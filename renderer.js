const $ = id => document.getElementById(id);
const QUICK = ['1.21.1', '1.20.4', '1.19.4', '1.16.5', '1.12.2', '1.8.9'];
let all = [];
let current = '1.12.2';
let since = 0;
let gameDir = '', defaultDir = '';

/* ---- связь с Python ---- */
async function call(url, opt) {
  let r;
  try { r = await fetch(url, opt); }
  catch { throw new Error(I18N.t('noLink')); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Ошибка ' + r.status);
  return d;
}
const post = (url, body) => call(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Electro': '1' }, body: JSON.stringify(body) });

/* ---- версии ---- */
function setVersion(v) {
  const changed = v !== current;
  current = v;
  const t = $('verTitle');
  t.textContent = v;
  if (changed) { t.classList.remove('pop'); void t.offsetWidth; t.classList.add('pop'); }
  renderChips(); closePicker(); onCtxChange();
}

function renderChips() {
  const ids = new Set(all.map(v => v.id));
  const latest = all.find(v => v.type === 'release');
  const list = [...new Set([latest && latest.id, ...QUICK].filter(id => id && (ids.has(id) || !all.length)))];
  const chips = list.map(id => {
    const b = document.createElement('button');
    b.className = 'chip' + (id === current ? ' active' : '');
    b.textContent = id;
    b.addEventListener('click', () => setVersion(id));
    return b;
  });
  const more = document.createElement('button');
  more.className = 'chip';
  more.textContent = I18N.t('allVersions');
  more.addEventListener('click', openPicker);
  $('chips').replaceChildren(...chips, more);
}

function renderList() {
  const q = $('search').value.trim();
  const snaps = $('snapshots').checked;
  const items = all.filter(v => (v.type === 'release' || (snaps && v.type === 'snapshot')) && v.id.includes(q));
  $('verList').replaceChildren(...items.slice(0, 300).map(v => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    if (v.id === current) li.className = 'sel';
    const a = document.createElement('span'); a.textContent = v.id;
    const b = document.createElement('small'); b.textContent = v.type === 'release' ? I18N.t('release') : I18N.t('snapshot');
    li.append(a, b);
    li.addEventListener('click', () => setVersion(v.id));
    return li;
  }));
}

function openPicker() { $('picker').hidden = false; renderList(); $('search').focus(); }
function closePicker() { $('picker').hidden = true; }
$('verBig').addEventListener('click', () => ($('picker').hidden ? openPicker() : closePicker()));
$('search').addEventListener('input', renderList);
$('snapshots').addEventListener('change', renderList);
document.addEventListener('mousedown', e => { if (!$('picker').hidden && !e.target.closest('#picker, #verBig, .chips')) closePicker(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closePicker(); $('drawer').hidden = true; } });

/* ---- настройки ---- */
function setAvatar() {
  const name = $('nickname').value.trim() || 'P';
  $('avatar').textContent = name[0].toUpperCase();
  $('who').textContent = I18N.t('offline') + ': ' + name;
  renderSide();
}
$('nickname').addEventListener('input', setAvatar);
$('openSettings').addEventListener('click', () => { $('drawer').hidden = false; });
$('account').addEventListener('click', () => { $('drawer').hidden = false; });
$('closeSettings').addEventListener('click', () => { $('drawer').hidden = true; });
$('ram').addEventListener('input', () => { $('ramOut').textContent = $('ram').value; renderSide(); });

/* ---- папка игры ---- */
function shortPath(p) { return p.length > 36 ? p.slice(0, 14) + '…' + p.slice(-20) : p; }
function renderSide() {
  $('sideDir').textContent = gameDir ? shortPath(gameDir) : '…';
  $('sideRam').textContent = $('ram').value + ' ' + I18N.t('gb');
  $('sideUser').textContent = $('nickname').value.trim() || 'Player';
}
async function showDirInfo() {
  try {
    const i = await call('/api/dirinfo?path=' + encodeURIComponent(gameDir));
    const txt = i.free != null ? I18N.t('free') + ' ' + i.free + ' ' + I18N.t('gb') : '';
    $('dirInfo').textContent = txt;
    $('sideDirInfo').textContent = txt;
  } catch { $('dirInfo').textContent = ''; $('sideDirInfo').textContent = ''; }
}
function setDirUI(p) { gameDir = p || defaultDir || ''; $('gameDir').value = gameDir; renderSide(); showDirInfo(); }
async function applyDir(p) {
  p = p.trim();
  if (!p || p === gameDir) { $('gameDir').value = gameDir; return; }
  try { const s = await post('/api/settings', { gameDir: p }); setDirUI(s.gameDir); $('error').textContent = ''; }
  catch (e) { $('error').textContent = e.message; $('gameDir').value = gameDir; }
}
async function pickFolder() {
  $('sideDirInfo').textContent = I18N.t('pickerOpening');
  try { const r = await post('/api/pick-folder', { path: gameDir }); if (r.path) await applyDir(r.path); else showDirInfo(); }
  catch (e) { $('error').textContent = e.message; showDirInfo(); }
}
$('pickDir').addEventListener('click', pickFolder);
$('sideDirCard').addEventListener('click', pickFolder);
$('resetDir').addEventListener('click', () => applyDir(defaultDir));
$('gameDir').addEventListener('change', () => applyDir($('gameDir').value));
$('sideRamCard').addEventListener('click', () => { $('drawer').hidden = false; });
$('sideUserCard').addEventListener('click', () => { $('drawer').hidden = false; });

/* ---- журнал ---- */
$('toggleLog').addEventListener('click', () => { $('logpanel').hidden = !$('logpanel').hidden; });
function log(line) {
  const el = $('log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}

/* ---- сигнал «Играть» -> Python ---- */
$('play').addEventListener('click', async () => {
  window.dispatchEvent(new Event('electro:zap'));
  $('error').textContent = '';
  $('log').textContent = '';
  $('play').disabled = true;
  try {
    await post('/api/launch', {
      nickname: $('nickname').value.trim(),
      version: current,
      ramMax: Number($('ram').value),
      showSnapshots: $('snapshots').checked,
      javaPath: $('javaPath').value.trim(), loader,
      gameDir
    });
  } catch (e) {
    $('error').textContent = e.message;
    $('play').disabled = false;
  }
});

/* ---- плавный прогресс ---- */
let target = 0, shown = 0;
(function animate() {
  shown += (target - shown) * 0.12;
  if (Math.abs(target - shown) < 0.05) shown = target;
  $('bar').style.width = shown.toFixed(2) + '%';
  requestAnimationFrame(animate);
})();

/* ---- опрос состояния ---- */
let fails = 0, lastStatus = '', srvErr = false;
const wait = ms => new Promise(r => setTimeout(r, ms));
function showOffline(on, text) { $('offline').hidden = !on; if (text) $('offlineText').textContent = text; }

function renderBusy(s) {
  const launched = s.status === 'Игра запущена';
  $('play').disabled = s.busy;
  $('play').classList.toggle('loading', s.busy && !launched);
  $('playText').textContent = launched ? I18N.t('launched') : s.busy ? I18N.t('starting') : I18N.t('play');
  $('bar').parentElement.classList.toggle('indeterminate', s.busy && !launched && s.progress === 0);
}

async function poll() {
  let delay = 1200;
  try {
    const s = await call('/api/state?since=' + since);
    fails = 0; showOffline(false);
    since = s.next;
    s.log.forEach(log);
    if (s.status !== lastStatus) { lastStatus = s.status; $('status').textContent = I18N.status(s.status); }
    target = s.progress;
    $('pct').textContent = s.busy && s.progress ? Math.round(s.progress) + '%' : '';
    renderBusy(s);
    if (s.error) { $('error').textContent = s.error; srvErr = true; }
    else if (srvErr) { $('error').textContent = ''; srvErr = false; }
    delay = s.busy ? 250 : 800;
  } catch {
    if (++fails >= 2) showOffline(true, I18N.t('connecting'));
  }
  setTimeout(poll, delay);
}

/* ---- старт ---- */
let versionsFailed = false;
async function loadVersions() {
  try {
    all = await call('/api/versions');
    if (!all.some(v => v.id === current)) current = '1.12.2';
    setVersion(current);
    if (versionsFailed) { versionsFailed = false; $('error').textContent = ''; }
  } catch (e) {
    versionsFailed = true;
    $('error').textContent = e.message;
    setTimeout(loadVersions, 3000);
  }
}

(async function init() {
  if (location.protocol !== 'http:') {
    showOffline(true, I18N.t('fileOpen'));
    return;
  }
  $('verTitle').textContent = current;
  setAvatar();
  renderChips();
  let s;
  for (;;) {
    try { s = await call('/api/settings'); break; }
    catch { showOffline(true, I18N.t('connecting')); await wait(700); }
  }
  showOffline(false);
  $('nickname').value = s.nickname;
  $('ram').value = s.ramMax;
  $('ramOut').textContent = s.ramMax;
  $('snapshots').checked = s.showSnapshots;
  $('javaPath').value = s.javaPath || '';
  defaultDir = s.defaultDir || '';
  setDirUI(s.gameDir);
  current = s.version || '1.12.2';
  loader = LOADERS.includes(s.loader) ? s.loader : 'vanilla';
  renderLoaders();
  $('verTitle').textContent = current;
  setAvatar();
  renderChips();
  poll();
  loadVersions();
})();

/* ---- язык и стиль ---- */
const langSel = $('lang');
Object.entries(I18N.langs).forEach(([c, n]) => { const o = document.createElement('option'); o.value = c; o.textContent = n; langSel.append(o); });
langSel.value = I18N.lang;
langSel.addEventListener('change', () => {
  I18N.setLang(langSel.value);
  lastStatus = ''; renderChips(); renderList(); setAvatar(); showDirInfo();
  $('playText').textContent = I18N.t('play');
});
function markTheme() { document.querySelectorAll('.theme-opt').forEach(b => b.classList.toggle('active', b.dataset.theme === I18N.theme)); }
document.querySelectorAll('.theme-opt').forEach(b => b.addEventListener('click', () => { I18N.setTheme(b.dataset.theme); markTheme(); }));
markTheme();
$('playText').textContent = I18N.t('play');

/* ---- окно: свернуть и выйти ---- */
$('winMin').hidden = !window.electroWin;
$('winMin').addEventListener('click', () => window.electroWin && electroWin.minimize());
$('winClose').addEventListener('click', () => {
  if (window.electroWin) electroWin.close();
  else post('/api/quit', {}).catch(() => {}).finally(() => { window.close(); $('offlineText').textContent = '✓'; });
});

/* ---- загрузчики и моды (Modrinth) ---- */
const LOADERS = ['vanilla', 'fabric', 'forge', 'quilt'];
const cap = s => s[0].toUpperCase() + s.slice(1);
let loader = 'vanilla', modsInstalled = [], modsOffset = 0, modsTotal = 0, searchToken = 0, searchTimer = 0, modsTab = 'browse';
const ctx = () => 'loader=' + loader + '&version=' + encodeURIComponent(current);
const modsMsg = (t, bad) => { $('modsMsg').textContent = t || ''; $('modsMsg').classList.toggle('bad', !!bad); };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

function renderLoaders() {
  $('loaders').replaceChildren(...LOADERS.map(l => {
    const b = el('button', 'chip' + (l === loader ? ' active' : ''), cap(l));
    b.addEventListener('click', () => { loader = l; renderLoaders(); onCtxChange(); });
    return b;
  }));
  renderModsCard();
}
function renderModsCard() {
  $('sideMods').textContent = loader === 'vanilla' ? 'Vanilla' : cap(loader) + ' ' + current;
  $('sideModsInfo').textContent = loader === 'vanilla' ? I18N.t('noMods') : modsInstalled.length + ' ' + I18N.t('modsCount');
}
function onCtxChange() {
  renderModsCard(); refreshInstalled();
  if (!$('mods').hidden) { $('modList').replaceChildren(); openMods(); }
}

function setBtn(btn) {
  const on = modsInstalled.some(m => m.project_id === btn.dataset.id);
  btn.disabled = on; btn.textContent = I18N.t(on ? 'installedOk' : 'install'); btn.classList.toggle('primary', !on);
}
async function refreshInstalled() {
  modsInstalled = [];
  if (loader !== 'vanilla') { try { modsInstalled = await call('/api/mods/installed?' + ctx()); } catch {} }
  renderModsCard(); renderInstalled();
  document.querySelectorAll('#modList .install').forEach(setBtn);
}
async function modAction(url, file) {
  try { await post(url, { loader, version: current, file }); modsMsg(''); await refreshInstalled(); }
  catch (e) { modsMsg(e.message, true); }
}
function renderInstalled() {
  $('modInstalled').replaceChildren(...modsInstalled.map(m => {
    const li = el('li', 'mod' + (m.enabled ? '' : ' off'));
    const body = el('div', 'mod-body'); body.append(el('strong', '', m.title), el('span', '', m.file));
    const acts = el('div', 'mod-acts');
    const tg = el('button', 'ghost', I18N.t(m.enabled ? 'on' : 'off'));
    tg.addEventListener('click', () => modAction('/api/mods/toggle', m.file));
    const rm = el('button', 'ghost', I18N.t('remove'));
    rm.addEventListener('click', () => modAction('/api/mods/remove', m.file));
    acts.append(tg, rm); li.append(el('div', 'ph'), body, acts);
    return li;
  }));
}
function modItem(h) {
  const li = el('li', 'mod');
  let ic;
  if (h.icon) { ic = el('img'); ic.src = h.icon; ic.alt = ''; ic.loading = 'lazy'; } else ic = el('div', 'ph');
  const body = el('div', 'mod-body');
  body.append(el('strong', '', h.title), el('span', '', h.description), el('span', 'dl', h.author + '  ⬇ ' + new Intl.NumberFormat().format(h.downloads)));
  const btn = el('button', 'ghost install'); btn.dataset.id = h.id;
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = I18N.t('working'); modsMsg('');
    try {
      const r = await post('/api/mods/install', { project_id: h.id, loader, version: current });
      await refreshInstalled(); modsMsg('✓ ' + r.installed.join(', '));
    } catch (e) { modsMsg(e.message, true); btn.disabled = false; btn.textContent = I18N.t('install'); }
  });
  li.append(ic, body, btn); setBtn(btn);
  return li;
}
async function searchMods(reset) {
  if (loader === 'vanilla') return;
  const my = ++searchToken;
  if (reset) { modsOffset = 0; $('modList').replaceChildren(); }
  modsMsg(I18N.t('loading'));
  try {
    const r = await call('/api/mods/search?' + ctx() + '&q=' + encodeURIComponent($('modSearch').value.trim()) + '&offset=' + modsOffset);
    if (my !== searchToken) return;
    modsTotal = r.total; modsOffset += r.hits.length;
    $('modList').append(...r.hits.map(modItem));
    $('modMore').hidden = modsOffset >= modsTotal;
    modsMsg($('modList').children.length ? '' : I18N.t('nothing'));
  } catch (e) { if (my === searchToken) modsMsg(e.message, true); }
}
function showTab(t) {
  modsTab = t;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  $('tabBrowse').hidden = t !== 'browse'; $('tabInstalled').hidden = t !== 'installed';
}
function openMods() {
  const off = loader === 'vanilla';
  $('mods').hidden = false;
  $('modsFor').textContent = off ? '' : cap(loader) + ' ' + current;
  $('modsTabs').hidden = off;
  if (off) { $('tabBrowse').hidden = $('tabInstalled').hidden = true; modsMsg(I18N.t('needLoader')); return; }
  showTab(modsTab); modsMsg('');
  refreshInstalled().then(() => { if (!$('modList').children.length) searchMods(true); });
}
$('sideModsCard').addEventListener('click', openMods);
$('closeMods').addEventListener('click', () => { $('mods').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('mods').hidden = true; });
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('modSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => searchMods(true), 350); });
$('modMore').addEventListener('click', () => searchMods(false));
$('openModsDir').addEventListener('click', () => post('/api/mods/open', { loader, version: current }).catch(e => modsMsg(e.message, true)));
langSel.addEventListener('change', () => {
  renderModsCard(); renderInstalled();
  document.querySelectorAll('#modList .install').forEach(setBtn);
  if (loader === 'vanilla' && !$('mods').hidden) modsMsg(I18N.t('needLoader'));
});
