'use strict';

/* =========================================================
   小説執筆ノート
   原稿と資料はブラウザ内の IndexedDB に保存します（db.js）。
   URL の ?work=作品ID で開く作品が決まるので、
   ブラウザの別タブ・別ウィンドウで別の作品を開けます。
   ========================================================= */

const UI_KEY = 'noveltool.ui.v2';
const LEGACY_UI_KEY = 'noveltool.ui.v1';
// 表示の好み（すべてのタブで共通）
const PREF_KEYS = ['view', 'dir', 'pvSize', 'refsOpen', 'refW', 'mtab', 'tocOpen'];

// 書き出しファイルの書式
const EXPORT_HEADER = '#noveltool v2';
const WORK_MARK = '=====作品：';
const ID_MARK = '@@@@@作品ID：';
const EP_MARK = '-----話：';
const REF_MARK = '+++++資料：';

const $ = (s) => document.querySelector(s);
const el = {
  tabs: $('#workTabs'), counts: $('#counts'), saveStatus: $('#saveStatus'),
  sideTitle: $('#sideTitle'), sideCount: $('#sideCount'), epList: $('#epList'), storageInfo: $('#storageInfo'),
  empty: $('#empty'), emptyMsg: $('#emptyMsg'), emptyAction: $('#emptyAction'),
  workspace: $('#workspace'), epTitle: $('#epTitle'), editor: $('#editor'), preview: $('#preview'),
  epUp: $('#epUp'), epDown: $('#epDown'), epDelete: $('#epDelete'),
  lockBanner: $('#lockBanner'), lockMsg: $('#lockMsg'),
  importFile: $('#importFile'), importDialog: $('#importDialog'), importMsg: $('#importMsg'),
  importList: $('#importList'), importModeBox: $('#importModeBox'),
};
const wideMQ = window.matchMedia('(min-width: 900px)');
const uid = DB.uid;

/* ---------- 状態 ---------- */

let works = [];      // 作品の一覧（タイトルなど）
let workId = null;   // このタブで開いている作品
let episodes = [];   // 開いている作品の話（order 順）
let epId = null;     // 開いている話
const dirty = new Map(); // 未保存の話 id → 話

function loadUI() {
  const def = { view: 'edit', dir: 'h', pvSize: 17, refsOpen: true, refW: 420, mtab: 'write', tocOpen: false, lastWork: null, lastEp: {}, lastRef: {} };
  let cur = null;
  try { cur = JSON.parse(localStorage.getItem(UI_KEY) || 'null'); } catch (e) { /* noop */ }
  if (!cur) {
    cur = {};
    try {
      const old = JSON.parse(localStorage.getItem(LEGACY_UI_KEY) || '{}');
      for (const k of PREF_KEYS) if (old[k] !== undefined) cur[k] = old[k];
      if (old.workId) cur.lastWork = old.workId;
      if (old.workId && old.epId) cur.lastEp = { [old.workId]: old.epId };
    } catch (e) { /* noop */ }
  }
  return Object.assign(def, cur, { refId: null });
}
let ui = loadUI();

// 別タブの記録を消さないよう、保存済みの内容に「このタブの分」だけを書き足す
function saveUI() {
  try {
    const s = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
    for (const k of PREF_KEYS) s[k] = ui[k];
    s.lastEp = { ...(s.lastEp || {}) };
    s.lastRef = { ...(s.lastRef || {}) };
    if (workId) {
      s.lastWork = workId;
      if (epId) s.lastEp[workId] = epId;
      if (ui.refId) s.lastRef[workId] = ui.refId;
    }
    localStorage.setItem(UI_KEY, JSON.stringify(s));
    ui.lastEp = s.lastEp;
    ui.lastRef = s.lastRef;
  } catch (e) { /* noop */ }
}

function curWork() { return works.find((w) => w.id === workId) || null; }
function curEp() { return episodes.find((e) => e.id === epId) || null; }

/* ---------- 保存 ---------- */

let saveTimer = null;
let saving = null;
let saveErrorShown = false;
let persistAsked = false;

function setStatus(text, isError = false) {
  el.saveStatus.textContent = text;
  el.saveStatus.classList.toggle('error', isError);
}

function markDirty(ep) {
  dirty.set(ep.id, ep);
  setStatus('編集中…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}

async function flushSave() {
  clearTimeout(saveTimer);
  while (saving) await saving;
  if (!dirty.size) return true;
  const items = [...dirty.values()];
  dirty.clear();
  saving = saveItems(items);
  try { return await saving; } finally { saving = null; }
}

async function saveItems(items) {
  const byWork = new Map();
  const notes = [];
  let ok = true;
  for (const ep of items) {
    try {
      const r = await DB.saveEpisode(ep);
      ep.rev = r.rev;
      if (!byWork.has(ep.workId)) byWork.set(ep.workId, []);
      byWork.get(ep.workId).push(ep.id);
      if (r.copy) {
        if (ep.workId === workId) episodes.push(r.copy);
        notes.push(`「${ep.title || '無題'}」は別のタブでも保存されていたため、その内容を「${r.copy.title}」として残しました。`);
      }
      if (r.restored) notes.push(`「${ep.title || '無題'}」は別のタブで削除されていましたが、書いていた内容で復元しました。`);
    } catch (e) {
      console.error(e);
      ok = false;
      if (!dirty.has(ep.id)) dirty.set(ep.id, ep);
    }
  }
  for (const [wid, ids] of byWork) DB.notify({ t: 'episodes', workId: wid, ids });
  if (!ok) {
    setStatus('保存できません', true);
    if (!saveErrorShown) {
      saveErrorShown = true;
      alert('原稿を保存できませんでした（ブラウザの保存容量不足などの可能性があります）。\n「この作品を書き出し」でバックアップを取ってください。');
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 5000);
    return false;
  }
  if (notes.length) {
    episodes.sort((a, b) => a.order - b.order);
    renderSidebar();
    alert(notes.join('\n'));
  }
  if (!dirty.size) {
    const t = new Date();
    setStatus(`保存済み ${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`);
  }
  if (!persistAsked && navigator.storage && navigator.storage.persist) {
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }
  return true;
}

/* ---------- 編集の占有（同じ話を複数のタブで同時に書かない） ---------- */

const HAS_LOCKS = !!(navigator.locks && navigator.locks.request);
const lock = { epId: null, token: null, holder: 0, release: null, abort: null, editable: true };
let lockSeq = 0;

function lockName(id) { return 'noveltool-episode-' + id; }

function requestLock(token, opts) {
  const rid = ++lockSeq;
  const options = { ...opts };
  if (!opts.ifAvailable && !opts.steal) {
    const ac = new AbortController();
    lock.abort = ac;
    options.signal = ac.signal;
  }
  navigator.locks.request(lockName(lock.epId), options, (l) => {
    if (lock.token !== token) return undefined;
    if (!l) {
      setEditable(false, 'busy');
      requestLock(token, {});
      return undefined;
    }
    return new Promise((resolve) => {
      lock.release = resolve;
      lock.holder = rid;
      onLockGranted(token);
    });
  }).catch(() => {
    // 別のタブに編集を引き継がれた
    if (lock.token !== token || lock.holder !== rid) return;
    lock.holder = 0;
    lock.release = null;
    flushSave();
    setEditable(false, 'stolen');
    requestLock(token, {});
  });
}

function acquireLock(id) {
  releaseLock();
  lock.epId = id;
  if (!id || !HAS_LOCKS) { setEditable(true); return; }
  lock.token = {};
  requestLock(lock.token, { ifAvailable: true });
}

function releaseLock() {
  lock.token = null;
  lock.holder = 0;
  if (lock.abort) lock.abort.abort();
  if (lock.release) lock.release();
  lock.abort = null;
  lock.release = null;
  lock.epId = null;
}

function takeLock() {
  if (!lock.token) return;
  if (lock.abort) lock.abort.abort();
  lock.abort = null;
  requestLock(lock.token, { steal: true });
}

async function onLockGranted(token) {
  // 別タブで書かれた最新の内容を読み直してから編集可能にする
  const id = lock.epId;
  try {
    const rec = await DB.getEpisode(id);
    if (lock.token !== token) return;
    const ep = episodes.find((e) => e.id === id);
    if (rec && ep && !dirty.has(id) && rec.rev !== ep.rev) {
      Object.assign(ep, { title: rec.title, body: rec.body, rev: rec.rev, updated: rec.updated });
      renderAll();
    }
  } catch (e) { console.error(e); }
  if (lock.token === token) setEditable(true);
}

function setEditable(on, reason) {
  lock.editable = on;
  el.editor.readOnly = !on;
  el.epTitle.readOnly = !on;
  el.epDelete.disabled = !on;
  $('#insRuby').disabled = !on;
  $('#insBouten').disabled = !on;
  el.lockBanner.hidden = on;
  if (!on) {
    el.lockMsg.textContent = reason === 'stolen'
      ? '別のタブでこの話の編集を始めたため、このタブは読み取り専用になりました。'
      : 'この話は別のタブで編集中のため、読み取り専用で表示しています。';
  }
}

/* ---------- カクヨム記法の解析 ---------- */

const KANJI = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u{20000}-\\u{2FFFF}々〆〇ヶ仝';
// 1: 傍点《《…》》 / 2: ｜《 のエスケープ / 3,4: ｜親文字《ルビ》 / 5,6: 漢字《ルビ》
const TOKEN_RE = new RegExp(
  '《《([^《》\\n]+?)》》' +
  '|([｜|])《' +
  '|[｜|]([^｜|《》\\n]{1,50})《([^《》\\n]{1,50})》' +
  `|([${KANJI}]{1,20})《([^《》\\n]{1,50})》`,
  'gu'
);

function tokenize(line) {
  const out = [];
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(line))) {
    if (m.index > last) out.push({ type: 'text', text: line.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ type: 'bouten', text: m[1] });
    else if (m[2] !== undefined) out.push({ type: 'text', text: '《' });
    else if (m[3] !== undefined) out.push({ type: 'ruby', base: m[3], rt: m[4] });
    else out.push({ type: 'ruby', base: m[5], rt: m[6] });
    last = TOKEN_RE.lastIndex;
  }
  if (last < line.length) out.push({ type: 'text', text: line.slice(last) });
  return out;
}

/* ---------- 文字数 ---------- */
// 画面に表示される本文の文字数（ルビの読み・記号・空白・改行は数えない）

function countVisible(s) { return Array.from(s.replace(/\s+/g, '')).length; }

function countChars(text) {
  let n = 0;
  for (const line of text.split('\n')) {
    for (const t of tokenize(line)) n += countVisible(t.type === 'ruby' ? t.base : t.text);
  }
  return n;
}

const countCache = new Map();
function epCount(ep) {
  const c = countCache.get(ep.id);
  if (c && c.body === ep.body) return c.n;
  const n = countChars(ep.body);
  countCache.set(ep.id, { body: ep.body, n });
  return n;
}
function workTotal() { return episodes.reduce((a, e) => a + epCount(e), 0); }
const fmt = (n) => n.toLocaleString('ja-JP');

/* ---------- 描画 ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 縦書き用：半角の2桁までの数字と !? の連続を縦中横に
function textHtml(s) {
  return s.split(/([0-9]+|[!?]{2,})/).map((part, i) => {
    if (i % 2 === 1 && (/^[0-9]{1,2}$/.test(part) || /^[!?]{2}$/.test(part))) {
      return `<span class="tcy">${esc(part)}</span>`;
    }
    return esc(part);
  }).join('');
}

function lineHtml(line) {
  if (line.trim() === '') return '<p><br></p>';
  const inner = tokenize(line).map((t) => {
    if (t.type === 'ruby') return `<ruby>${esc(t.base)}<rp>《</rp><rt>${esc(t.rt)}</rt><rp>》</rp></ruby>`;
    if (t.type === 'bouten') return `<em class="bouten">${esc(t.text)}</em>`;
    return textHtml(t.text);
  }).join('');
  return `<p>${inner}</p>`;
}

function renderPreview() {
  const ep = curEp();
  if (!ep) { el.preview.innerHTML = ''; return; }
  const body = ep.body.trim() === ''
    ? '<p class="pv-empty">本文はまだありません。</p>'
    : ep.body.split('\n').map(lineHtml).join('');
  el.preview.innerHTML = `<h2 class="pv-title">${textHtml(ep.title || '無題')}</h2><div class="pv-body">${body}</div>`;
}

function renderTabs() {
  el.tabs.innerHTML = works.map((w) => {
    const cur = w.id === workId;
    return `<a class="wtab${cur ? ' current' : ''}" href="?work=${encodeURIComponent(w.id)}" data-work="${esc(w.id)}"${cur ? ' aria-current="page"' : ''}
      title="${esc(w.title || '無題')}（Ctrl／⌘＋クリックで別のタブに開く）">${esc(w.title || '無題')}</a>`;
  }).join('') + '<button type="button" class="wtab-add" data-act="add-work" title="新しい作品" aria-label="新しい作品">＋</button>';
  const cur = el.tabs.querySelector('.current');
  if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderSidebar() {
  const w = curWork();
  el.sideTitle.textContent = w ? (w.title || '無題') : '作品がありません';
  el.sideCount.textContent = w ? `${fmt(workTotal())}字` : '';
  $('#addEp').hidden = !w;
  document.querySelector('.work-actions').hidden = !w;
  el.epList.innerHTML = episodes.map((e, i) => `
    <li><button type="button" class="row-btn ep${e.id === epId ? ' current' : ''}" data-ep="${esc(e.id)}">
      <span class="no">${i + 1}</span><span class="name">${esc(e.title || '無題')}</span><span class="cnt">${fmt(epCount(e))}</span>
    </button></li>`).join('');
}

function renderCounts() {
  const w = curWork();
  const ep = curEp();
  el.counts.innerHTML = w
    ? (ep ? `<span>この話 <b>${fmt(epCount(ep))}</b>字</span>` : '') + `<span>作品計 <b>${fmt(workTotal())}</b>字</span>`
    : '';
}

function effectiveView() {
  return ui.view === 'split' && !wideMQ.matches ? 'edit' : ui.view;
}

function renderMain() {
  const w = curWork();
  const ep = curEp();
  el.workspace.hidden = !ep;
  el.empty.hidden = !!ep;
  el.emptyAction.hidden = false;
  if (!ep) {
    if (w) {
      el.emptyMsg.textContent = 'この作品にはまだ話がありません。';
      el.emptyAction.textContent = '＋ 話を追加';
      el.emptyAction.onclick = addEpisode;
    } else {
      el.emptyMsg.textContent = '作品がありません。';
      el.emptyAction.textContent = '＋ 新しい作品';
      el.emptyAction.onclick = addWork;
    }
  } else {
    if (el.editor.dataset.ep !== ep.id) {
      el.editor.value = ep.body;
      el.editor.dataset.ep = ep.id;
      el.editor.scrollTop = 0;
      el.preview.scrollTop = 0;
      el.preview.scrollLeft = 0;
    } else if (el.editor.value !== ep.body) {
      // 別タブで更新された内容を反映（スクロール位置とカーソルはなるべく保つ）
      const top = el.editor.scrollTop;
      const s = el.editor.selectionStart;
      const e = el.editor.selectionEnd;
      el.editor.value = ep.body;
      el.editor.scrollTop = top;
      if (document.activeElement === el.editor) el.editor.setSelectionRange(Math.min(s, ep.body.length), Math.min(e, ep.body.length));
    }
    if (document.activeElement !== el.epTitle || el.epTitle.readOnly) el.epTitle.value = ep.title;
    const idx = episodes.indexOf(ep);
    el.epUp.disabled = idx <= 0;
    el.epDown.disabled = idx >= episodes.length - 1;
  }

  const view = effectiveView();
  document.body.dataset.view = view;
  document.querySelectorAll('button[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === ui.view));
  document.querySelectorAll('button[data-dir]').forEach((b) => b.classList.toggle('on', b.dataset.dir === ui.dir));
  el.preview.classList.toggle('vertical', ui.dir === 'v');
  el.preview.style.setProperty('--pv-size', ui.pvSize + 'px');
  if (view !== 'edit') renderPreview();
  renderCounts();
}

function renderAll() {
  const w = curWork();
  document.title = w ? `${w.title || '無題'} - 小説執筆ノート` : '小説執筆ノート';
  renderTabs();
  renderSidebar();
  renderMain();
}

/* ---------- 作品の切り替え ---------- */

function urlWorkId() { return new URLSearchParams(location.search).get('work'); }

function setUrl(id, push) {
  try {
    const u = new URL(location.href);
    if (id) u.searchParams.set('work', id); else u.searchParams.delete('work');
    if (u.href === location.href) return;
    history[push ? 'pushState' : 'replaceState'](null, '', u.href);
  } catch (e) { /* file:// などで履歴を変更できない場合は URL を変えずに続ける */ }
}

let openSeq = 0;
async function openWork(id, { push = false } = {}) {
  const seq = ++openSeq;
  await flushSave();
  if (seq !== openSeq) return;
  releaseLock();
  let w = works.find((x) => x.id === id);
  if (!w) {
    if (id) setStatus('指定された作品が見つからないため、別の作品を開きました');
    w = works.find((x) => x.id === ui.lastWork) || works[0] || null;
    push = false;
  }
  workId = w ? w.id : null;
  const list = w ? await DB.episodes(w.id) : [];
  if (seq !== openSeq) return;
  episodes = list;
  const last = w ? ui.lastEp[w.id] : null;
  epId = episodes.some((e) => e.id === last) ? last : (episodes[0] ? episodes[0].id : null);
  setUrl(workId, push);
  el.editor.dataset.ep = '';
  renderAll();
  acquireLock(epId);
  saveUI();
  Refs.setWork(workId);
}

el.tabs.addEventListener('click', (e) => {
  if (e.target.closest('[data-act="add-work"]')) { addWork(); return; }
  const a = e.target.closest('a[data-work]');
  if (!a) return;
  // Ctrl／⌘／Shift＋クリックや中クリックはブラウザに任せて別タブ・別窓で開く
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  if (a.dataset.work !== workId) openWork(a.dataset.work, { push: true });
});
window.addEventListener('popstate', () => openWork(urlWorkId()));

/* ---------- 作品の操作 ---------- */

async function addWork() {
  const title = prompt('作品名を入力してください', '新しい作品');
  if (title === null) return;
  const w = await DB.createWork(title.trim() || '無題');
  works = await DB.works();
  DB.notify({ t: 'works' });
  await openWork(w.id, { push: true });
}

$('#renameWork').addEventListener('click', async () => {
  const w = curWork();
  if (!w) return;
  const title = prompt('作品名', w.title);
  if (title === null) return;
  w.title = title.trim() || '無題';
  await DB.putWork(w);
  DB.notify({ t: 'works' });
  renderAll();
});

$('#deleteWork').addEventListener('click', async () => {
  const w = curWork();
  if (!w) return;
  const refCount = Refs.count();
  if (!confirm(`作品「${w.title}」を削除しますか？\n全${episodes.length}話・${fmt(workTotal())}字と、資料${refCount}件が消えます。元に戻せません。`)) return;
  await flushSave();
  releaseLock();
  dirty.clear();
  await DB.deleteWork(w.id);
  DB.notify({ t: 'works', deleted: w.id });
  works = await DB.works();
  await openWork(works[0] ? works[0].id : null);
  setStatus('作品を削除しました');
});

async function reloadWorks() {
  works = await DB.works();
  if (workId && !curWork()) {
    alert('開いていた作品は、別のタブで削除されました。');
    dirty.clear();
    await openWork(null);
    return;
  }
  renderAll();
}

/* ---------- 話の操作 ---------- */

function selectEpisode(id) {
  if (id === epId) { closeDrawer(); return; }
  epId = id;
  closeDrawer();
  renderAll();
  acquireLock(id);
  saveUI();
}

el.epList.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ep]');
  if (b) selectEpisode(b.dataset.ep);
});

async function addEpisode() {
  const w = curWork();
  if (!w) return;
  const now = Date.now();
  const ep = {
    id: uid(), workId: w.id, title: `第${episodes.length + 1}話`, body: '',
    order: episodes.reduce((m, e) => Math.max(m, e.order), -1) + 1, created: now, updated: now, rev: 1,
  };
  await DB.addEpisode(ep);
  episodes.push(ep);
  DB.notify({ t: 'episodes', workId: w.id, ids: [ep.id] });
  selectEpisode(ep.id);
  el.epTitle.focus();
  el.epTitle.select();
}
$('#addEp').addEventListener('click', addEpisode);

// 本文の入力
let liveTimer = null;
el.editor.addEventListener('input', () => {
  const ep = curEp();
  if (!ep || !lock.editable) return;
  ep.body = el.editor.value;
  ep.updated = Date.now();
  markDirty(ep);
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    renderCounts();
    renderSidebar();
    if (effectiveView() === 'split') renderPreview();
  }, 250);
});

el.epTitle.addEventListener('input', () => {
  const ep = curEp();
  if (!ep || !lock.editable) return;
  ep.title = el.epTitle.value;
  ep.updated = Date.now();
  markDirty(ep);
  renderSidebar();
});
el.epTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); el.editor.focus(); }
});

async function moveEpisode(delta) {
  const ep = curEp();
  if (!ep) return;
  const i = episodes.indexOf(ep);
  const j = i + delta;
  if (j < 0 || j >= episodes.length) return;
  episodes.splice(i, 1);
  episodes.splice(j, 0, ep);
  episodes.forEach((e, k) => { e.order = k; });
  renderAll();
  await DB.setOrders(episodes.map((e) => ({ id: e.id, order: e.order })));
  DB.notify({ t: 'episodes', workId, ids: [] });
}
el.epUp.addEventListener('click', () => moveEpisode(-1));
el.epDown.addEventListener('click', () => moveEpisode(1));

el.epDelete.addEventListener('click', async () => {
  const ep = curEp();
  if (!ep || !lock.editable) return;
  if (!confirm(`「${ep.title || '無題'}」（${fmt(epCount(ep))}字）を削除しますか？\n元に戻せません。`)) return;
  dirty.delete(ep.id);
  releaseLock();
  await DB.deleteEpisode(ep.id);
  const i = episodes.indexOf(ep);
  episodes.splice(i, 1);
  DB.notify({ t: 'episodes', workId, ids: [], deleted: [ep.id] });
  const next = episodes[Math.min(i, episodes.length - 1)];
  epId = null;
  if (next) selectEpisode(next.id); else renderAll();
});

$('#epCopy').addEventListener('click', async () => {
  const ep = curEp();
  if (!ep) return;
  try {
    await navigator.clipboard.writeText(ep.body);
    setStatus('本文をコピーしました');
  } catch (e) {
    el.editor.focus();
    el.editor.select();
    setStatus('選択しました。コピーしてください');
  }
});

$('#lockTake').addEventListener('click', takeLock);

// 別タブで保存・並べ替え・削除された話を取り込む（このタブで未保存の話はそのまま）
async function refreshEpisodes() {
  const fresh = await DB.episodes(workId);
  const map = new Map(episodes.map((e) => [e.id, e]));
  const next = [];
  for (const rec of fresh) {
    const local = map.get(rec.id);
    if (!local) { next.push(rec); continue; }
    map.delete(rec.id);
    local.order = rec.order;
    if (!dirty.has(rec.id) && local.rev !== rec.rev) {
      Object.assign(local, { title: rec.title, body: rec.body, rev: rec.rev, updated: rec.updated });
    }
    next.push(local);
  }
  // DB から消えた話：未保存の変更があれば残し（次の保存で復元）、なければ一覧から外す
  let removedCurrent = false;
  for (const local of map.values()) {
    if (dirty.has(local.id)) next.push(local);
    else if (local.id === epId) removedCurrent = true;
  }
  next.sort((a, b) => a.order - b.order);
  episodes = next;
  if (removedCurrent) {
    epId = null;
    setStatus('開いていた話は別のタブで削除されました');
    if (episodes[0]) { selectEpisode(episodes[0].id); return; }
    releaseLock();
  }
  renderAll();
}

DB.onMessage(async (msg) => {
  try {
    if (msg.t === 'works') await reloadWorks();
    else if (msg.t === 'episodes' && msg.workId === workId) await refreshEpisodes();
    else if (msg.t === 'refs' && msg.workId === workId) Refs.reload();
  } catch (e) { console.error(e); }
});

/* ---------- 表示切り替え ---------- */

document.querySelectorAll('button[data-view]').forEach((b) => b.addEventListener('click', () => {
  ui.view = b.dataset.view;
  renderMain();
  saveUI();
}));
document.querySelectorAll('button[data-dir]').forEach((b) => b.addEventListener('click', () => {
  ui.dir = b.dataset.dir;
  el.preview.scrollLeft = 0;
  el.preview.scrollTop = 0;
  renderMain();
  saveUI();
}));
function changeFont(d) {
  ui.pvSize = Math.max(12, Math.min(28, ui.pvSize + d));
  el.preview.style.setProperty('--pv-size', ui.pvSize + 'px');
  saveUI();
}
$('#fontDown').addEventListener('click', () => changeFont(-1));
$('#fontUp').addEventListener('click', () => changeFont(1));
wideMQ.addEventListener('change', renderMain);

// 縦書きプレビューではマウスホイールで横方向にスクロール
el.preview.addEventListener('wheel', (e) => {
  if (ui.dir !== 'v' || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  el.preview.scrollLeft -= e.deltaY;
  e.preventDefault();
}, { passive: false });

// ルビ・傍点の挿入
function insertAround(before, after, caretInside) {
  const ta = el.editor;
  if (ta.readOnly) return;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const sel = ta.value.slice(s, e);
  const text = before + sel + after;
  ta.focus();
  ta.setSelectionRange(s, e);
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch (err) { ok = false; }
  if (!ok) {
    ta.setRangeText(text, s, e, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const caret = sel ? s + before.length + sel.length + caretInside : s + before.length;
  ta.setSelectionRange(caret, caret);
}
$('#insRuby').addEventListener('click', () => insertAround('｜', '《》', 1));
$('#insBouten').addEventListener('click', () => insertAround('《《', '》》', 2));

// 画面の開閉（スマホ）
function closeDrawer() { document.body.classList.remove('drawer-open'); }
$('#menuBtn').addEventListener('click', () => document.body.classList.toggle('drawer-open'));
$('#scrim').addEventListener('click', closeDrawer);

// Ctrl+S / Cmd+S で即保存
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    flushSave();
  }
});

// 閉じる・裏に回るときは必ず保存
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
window.addEventListener('pagehide', () => { flushSave(); });
window.addEventListener('beforeunload', (e) => {
  if (!dirty.size && !saving) return;
  flushSave();
  e.preventDefault();
  e.returnValue = '';
});

/* ---------- 書き出し・読み込み ---------- */

function escapeLine(line) {
  return [WORK_MARK, ID_MARK, EP_MARK, REF_MARK, '\\'].some((m) => line.startsWith(m)) ? '\\' + line : line;
}
const escapeText = (text) => text.split('\n').map(escapeLine).join('\n') + '\n';

function buildExport(list) {
  let out = EXPORT_HEADER + '\n';
  for (const w of list) {
    out += WORK_MARK + (w.title || '無題') + '\n';
    out += ID_MARK + w.id + '\n';
    for (const ep of w.episodes) out += EP_MARK + (ep.title || '無題') + '\n' + escapeText(ep.body);
    for (const r of w.refs) out += REF_MARK + r.name + '\n' + escapeText(r.text);
  }
  return out;
}

function parseImport(text, fallbackTitle) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const head = text.match(/^#noveltool v(\d+)/);
  if (!head) {
    // 普通のテキストファイルは「1作品・1話」として取り込む
    return [{ id: null, title: fallbackTitle, episodes: [{ title: '第1話', body: text.replace(/\n+$/, '') }], refs: [] }];
  }
  const v2 = Number(head[1]) >= 2;
  if (text.endsWith('\n')) text = text.slice(0, -1);
  const lines = text.split('\n');
  const works = [];
  let w = null;
  let cur = null;
  let buf = [];
  const flush = () => { if (cur) cur.text = buf.join('\n'); buf = []; };
  const ensureWork = () => {
    if (!w) { w = { id: null, title: fallbackTitle, episodes: [], refs: [] }; works.push(w); }
    return w;
  };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(WORK_MARK)) {
      flush();
      cur = null;
      w = { id: null, title: line.slice(WORK_MARK.length).trim() || '無題', episodes: [], refs: [] };
      works.push(w);
    } else if (v2 && w && !cur && line.startsWith(ID_MARK)) {
      w.id = line.slice(ID_MARK.length).trim() || null;
    } else if (line.startsWith(EP_MARK)) {
      flush();
      cur = { title: line.slice(EP_MARK.length).trim(), text: '' };
      ensureWork().episodes.push(cur);
    } else if (v2 && line.startsWith(REF_MARK)) {
      flush();
      cur = { name: line.slice(REF_MARK.length).trim() || '無題.md', text: '' };
      ensureWork().refs.push(cur);
    } else if (cur) {
      buf.push(line.startsWith('\\') ? line.slice(1) : line);
    }
  }
  flush();
  for (const x of works) x.episodes = x.episodes.map((e) => ({ title: e.title, body: e.text }));
  return works;
}

function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    // UTF-8 でなければ Shift_JIS として読む
    return new TextDecoder('shift_jis').decode(buf);
  }
}

$('#exportWork').addEventListener('click', async () => {
  if (!workId) return;
  await flushSave();
  const w = await DB.exportWork(workId);
  if (w) download(buildExport([w]), `${safeName(w.title)}_${stamp()}.txt`);
});

$('#exportAll').addEventListener('click', async () => {
  await flushSave();
  const list = [];
  for (const w of await DB.works()) {
    const x = await DB.exportWork(w.id);
    if (x) list.push(x);
  }
  download(buildExport(list), `noveltool_全作品_${stamp()}.txt`);
});

$('#importBtn').addEventListener('click', () => el.importFile.click());

el.importFile.addEventListener('change', async () => {
  const file = el.importFile.files[0];
  el.importFile.value = '';
  if (!file) return;
  let list;
  try {
    const text = decodeText(await file.arrayBuffer());
    list = parseImport(text, file.name.replace(/\.[^.]+$/, '') || '読み込んだ作品');
  } catch (e) {
    console.error(e);
    alert('ファイルを読み込めませんでした。');
    return;
  }
  if (!list.length) { alert('読み込める作品が見つかりませんでした。'); return; }
  works = await DB.works();
  const exists = (x) => !!(x.id && works.some((w) => w.id === x.id));
  el.importMsg.textContent = `「${file.name}」に ${list.length}作品 があります。読み込む作品を選んでください。`;
  el.importList.innerHTML = list.map((x, i) => `
    <li><label><input type="checkbox" data-i="${i}" checked>
      <span><b>${esc(x.title)}</b><small>${x.episodes.length}話・資料${x.refs.length}件${exists(x) ? '・<em>同じ作品があります</em>' : ''}</small></span>
    </label></li>`).join('');
  el.importModeBox.hidden = !list.some(exists);
  el.importDialog.returnValue = '';
  el.importDialog.showModal();
  el.importDialog.addEventListener('close', async function onClose() {
    el.importDialog.removeEventListener('close', onClose);
    if (el.importDialog.returnValue !== 'ok') return;
    const picked = [...el.importList.querySelectorAll('input:checked')].map((c) => list[Number(c.dataset.i)]);
    if (!picked.length) return;
    const replace = el.importDialog.querySelector('input[name="importMode"]:checked').value === 'replace';
    const replacing = replace ? picked.filter(exists) : [];
    if (replacing.length && !confirm(`次の作品の原稿と資料を、ファイルの内容で置き換えます。元に戻せません。\n\n${replacing.map((x) => '・' + x.title).join('\n')}`)) return;
    await flushSave();
    releaseLock();
    const done = [];
    try {
      for (const x of picked) done.push(await DB.importWork(x, replace));
    } catch (e) {
      console.error(e);
      alert('読み込みの途中で保存できなくなりました。');
    }
    DB.notify({ t: 'works' });
    for (const w of done) {
      DB.notify({ t: 'episodes', workId: w.id, ids: [] });
      DB.notify({ t: 'refs', workId: w.id });
    }
    works = await DB.works();
    closeDrawer();
    if (done.length) {
      await openWork(done[0].id, { push: done[0].id !== workId });
      setStatus(`${done.length}作品を読み込みました`);
    } else {
      await openWork(workId);
    }
  });
});

function download(text, filename) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function safeName(s) { return (s || '無題').replace(/[\\/:*?"<>|\n\r\t]/g, '_').slice(0, 60); }

async function showStorage() {
  if (!navigator.storage || !navigator.storage.estimate) return;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const mb = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'GB' : Math.max(0.1, n / 1e6).toFixed(1) + 'MB');
    el.storageInfo.textContent = `保存容量：${mb(usage || 0)} 使用中（上限の目安 ${mb(quota || 0)}）`;
  } catch (e) { /* noop */ }
}

/* ---------- 起動 ---------- */

async function init() {
  let report;
  try {
    report = await DB.init();
    works = await DB.works();
  } catch (e) {
    console.error(e);
    document.body.classList.remove('loading');
    el.workspace.hidden = true;
    el.empty.hidden = false;
    el.emptyMsg.textContent = 'ブラウザの保存領域（IndexedDB）を開けませんでした。プライベートブラウズを解除するか、別のブラウザでお試しください。';
    el.emptyAction.hidden = true;
    return;
  }
  await openWork(urlWorkId() || ui.lastWork);
  document.body.classList.remove('loading');
  if (report.works || report.refs) {
    const parts = [];
    if (report.works) parts.push(`原稿（${report.works}作品・${report.episodes}話）`);
    if (report.refs) parts.push(`資料${report.refs}件（作品「${report.refsWork}」に登録）`);
    setStatus('以前のデータを移行しました');
    alert(`保存先を新しい形式（IndexedDB）に変更し、${parts.join('と')}を移しました。\n以前のデータもブラウザ内にそのまま残してあります。`);
  }
  showStorage();
}
window.addEventListener('DOMContentLoaded', init);
