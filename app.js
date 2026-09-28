'use strict';

/* =========================================================
   小説執筆ノート
   原稿と資料はブラウザ内の IndexedDB に保存します（db.js）。
   URL の ?work=作品ID で開く作品が決まるので、
   ブラウザの別タブ・別ウィンドウで別の作品を開けます。
   構成は「作品 ＞ 章 ＞ 話」。章は任意で、章に入れない話（章なし）は章より前に並びます。
   ========================================================= */

const UI_KEY = 'noveltool.ui.v2';
const LEGACY_UI_KEY = 'noveltool.ui.v1';
// 表示の好み（すべてのタブで共通）
const PREF_KEYS = ['view', 'dir', 'pvSize', 'refsOpen', 'refW', 'mtab', 'tocOpen', 'exportFormat', 'collapsed'];

// 書き出しファイルの書式（作品全体を1つのテキストにしたもの）
const TEXT_HEADER = '#noveltool v3';
const T_WORK = '【作品】';
const T_WORK_ID = '【作品ID】';
const T_CHAPTER = '【章】';
const T_EPISODE = '【話】';
// ZIP に入れる構成ファイル（読み込み時に章と話の構成を復元する）
const MANIFEST_NAME = 'noveltool.json';
// 以前の書き出し形式（読み込みのみ対応）
const OLD_WORK_MARK = '=====作品：';
const OLD_ID_MARK = '@@@@@作品ID：';
const OLD_EP_MARK = '-----話：';
const OLD_REF_MARK = '+++++資料：';

const $ = (s) => document.querySelector(s);
const el = {
  tabs: $('#workTabs'), counts: $('#counts'), saveStatus: $('#saveStatus'),
  sideTitle: $('#sideTitle'), sideCount: $('#sideCount'), epList: $('#epList'), storageInfo: $('#storageInfo'),
  sidebar: $('#sidebar'),
  empty: $('#empty'), emptyMsg: $('#emptyMsg'), emptyAction: $('#emptyAction'),
  workspace: $('#workspace'), epTitle: $('#epTitle'), editor: $('#editor'), preview: $('#preview'),
  epUp: $('#epUp'), epDown: $('#epDown'), epDelete: $('#epDelete'), epChapter: $('#epChapter'),
  lockBanner: $('#lockBanner'), lockMsg: $('#lockMsg'), updateBanner: $('#updateBanner'),
  importFile: $('#importFile'), importFolder: $('#importFolder'),
  importDialog: $('#importDialog'), importMsg: $('#importMsg'), importList: $('#importList'), importModeBox: $('#importModeBox'),
  exportDialog: $('#exportDialog'), exportTitle: $('#exportTitle'),
  chapterDialog: $('#chapterDialog'), chapterMsg: $('#chapterMsg'),
};
const wideMQ = window.matchMedia('(min-width: 900px)');
const uid = DB.uid;

/* ---------- 状態 ---------- */

let works = [];      // 作品の一覧（タイトルなど）
let workId = null;   // このタブで開いている作品
let chapters = [];   // 開いている作品の章（order 順）
let episodes = [];   // 開いている作品の話
let epId = null;     // 開いている話
const dirty = new Map(); // 未保存の話 id → 話
let chapterMenu = null;  // メニューを開いている章

function loadUI() {
  const def = {
    view: 'edit', dir: 'h', pvSize: 17, refsOpen: true, refW: 420, mtab: 'write', tocOpen: false,
    exportFormat: 'zip', collapsed: {}, lastWork: null, lastEp: {}, lastRef: {},
  };
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

/* ---------- 章と話の並び ---------- */

const byOrder = (a, b) => (a.order - b.order) || ((a.created || 0) - (b.created || 0));

// [{ chapter: null（章なし）| 章, eps: [話…] }]。章なしが先頭、そのあと章の順
function groups() {
  const none = { chapter: null, eps: [] };
  const map = new Map(chapters.map((c) => [c.id, { chapter: c, eps: [] }]));
  for (const e of episodes) ((e.chapterId && map.get(e.chapterId)) || none).eps.push(e);
  const list = [none, ...chapters.map((c) => map.get(c.id))];
  for (const g of list) g.eps.sort(byOrder);
  return list;
}
const gid = (g) => (g.chapter ? g.chapter.id : null);
function flatEpisodes() { return groups().flatMap((g) => g.eps); }
function chapterOf(ep) { return (ep && ep.chapterId && chapters.find((c) => c.id === ep.chapterId)) || null; }

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
let appClosed = false; // 新しい版のツールが開かれて、このタブの保存が止まった

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
  if (appClosed) { setEditable(false, 'closed'); return; }
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
  if (appClosed) { on = false; reason = 'closed'; }
  lock.editable = on;
  el.editor.readOnly = !on;
  el.epTitle.readOnly = !on;
  el.epDelete.disabled = !on;
  $('#insRuby').disabled = !on;
  $('#insBouten').disabled = !on;
  el.lockBanner.hidden = on || reason === 'closed';
  if (!on && reason !== 'closed') {
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
const sumCount = (eps) => eps.reduce((a, e) => a + epCount(e), 0);
function workTotal() { return sumCount(episodes); }
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
  const ch = chapterOf(ep);
  const body = ep.body.trim() === ''
    ? '<p class="pv-empty">本文はまだありません。</p>'
    : ep.body.split('\n').map(lineHtml).join('');
  el.preview.innerHTML = (ch ? `<p class="pv-chapter">${textHtml(ch.title || '無題の章')}</p>` : '') +
    `<h2 class="pv-title">${textHtml(ep.title || '無題')}</h2><div class="pv-body">${body}</div>`;
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

function epRowHtml(e, no) {
  return `<li class="ep-row" data-ep="${esc(e.id)}">
    <span class="drag" data-drag="${esc(e.id)}" title="ドラッグして並べ替え・章を移動" aria-hidden="true">⋮⋮</span>
    <button type="button" class="row-btn ep${e.id === epId ? ' current' : ''}" data-ep="${esc(e.id)}">
      <span class="no">${no}</span><span class="name">${esc(e.title || '無題')}</span><span class="cnt">${fmt(epCount(e))}</span>
    </button></li>`;
}

function renderSidebar() {
  const w = curWork();
  el.sideTitle.textContent = w ? (w.title || '無題') : '作品がありません';
  el.sideCount.textContent = w ? `${fmt(workTotal())}字` : '';
  $('#addEp').hidden = !w;
  $('#addChapter').hidden = !w;
  document.querySelector('.work-actions').hidden = !w;
  let no = 0;
  el.epList.innerHTML = groups().map((g) => {
    const rows = g.eps.map((e) => epRowHtml(e, ++no)).join('');
    if (!g.chapter) {
      // 章がある作品では「章なし」の見出しを出す（空のときはドラッグ中だけ表示）
      const head = chapters.length
        ? `<div class="grp-head nochap"><span class="name">章なし</span><span class="cnt">${g.eps.length ? `${g.eps.length}話・${fmt(sumCount(g.eps))}字` : ''}</span></div>`
        : '';
      return `<li class="grp${g.eps.length ? '' : ' empty'}" data-chapter="">${head}<ol class="grp-eps">${rows}</ol></li>`;
    }
    const c = g.chapter;
    const collapsed = !!ui.collapsed[c.id];
    const i = chapters.indexOf(c);
    return `<li class="grp chapter${collapsed ? ' collapsed' : ''}" data-chapter="${esc(c.id)}">
      <div class="grp-head">
        <button type="button" class="chev-btn" data-act="toggle-ch" data-ch="${esc(c.id)}" aria-expanded="${!collapsed}" aria-label="章を開閉">▸</button>
        <span class="name">${esc(c.title || '無題の章')}</span>
        <span class="cnt">${g.eps.length}話・${fmt(sumCount(g.eps))}字</span>
        <button type="button" class="icon-btn ch-menu-btn" data-act="ch-menu" data-ch="${esc(c.id)}" aria-expanded="${chapterMenu === c.id}" aria-label="章のメニュー">⋯</button>
      </div>
      <div class="ch-actions"${chapterMenu === c.id ? '' : ' hidden'}>
        <button type="button" data-act="ch-rename" data-ch="${esc(c.id)}">名前を変更</button>
        <button type="button" data-act="ch-add-ep" data-ch="${esc(c.id)}">この章に話を追加</button>
        <button type="button" data-act="ch-up" data-ch="${esc(c.id)}"${i === 0 ? ' disabled' : ''}>↑ 前へ</button>
        <button type="button" data-act="ch-down" data-ch="${esc(c.id)}"${i === chapters.length - 1 ? ' disabled' : ''}>↓ 後ろへ</button>
        <button type="button" class="danger" data-act="ch-delete" data-ch="${esc(c.id)}">章を削除</button>
      </div>
      <ol class="grp-eps">${rows || '<li class="grp-empty">話がありません（ここへドラッグで移動）</li>'}</ol>
    </li>`;
  }).join('');
}

function renderCounts() {
  const w = curWork();
  const ep = curEp();
  const ch = chapterOf(ep);
  const chCount = ch ? sumCount(episodes.filter((e) => e.chapterId === ch.id)) : 0;
  el.counts.innerHTML = w
    ? (ep ? `<span>この話 <b>${fmt(epCount(ep))}</b>字</span>` : '') +
      (ch ? `<span class="count-chapter">この章 <b>${fmt(chCount)}</b>字</span>` : '') +
      `<span>作品計 <b>${fmt(workTotal())}</b>字</span>`
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
      el.emptyAction.onclick = () => addEpisode();
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
    const gs = groups();
    const gi = gs.findIndex((g) => g.eps.includes(ep));
    const i = gs[gi].eps.indexOf(ep);
    el.epUp.disabled = gi === 0 && i === 0;
    el.epDown.disabled = gi === gs.length - 1 && i === gs[gi].eps.length - 1;
    el.epChapter.hidden = !chapters.length;
    el.epChapter.innerHTML = '<option value="">章なし</option>' +
      chapters.map((c) => `<option value="${esc(c.id)}">${esc(c.title || '無題の章')}</option>`).join('');
    el.epChapter.value = chapterOf(ep) ? ep.chapterId : '';
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
  } catch (e) { /* 履歴を変更できない場合は URL を変えずに続ける */ }
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
  const [chs, eps] = w ? await Promise.all([DB.chapters(w.id), DB.episodes(w.id)]) : [[], []];
  if (seq !== openSeq) return;
  chapters = chs;
  episodes = eps;
  chapterMenu = null;
  const last = w ? ui.lastEp[w.id] : null;
  const flat = flatEpisodes();
  epId = flat.some((e) => e.id === last) ? last : (flat[0] ? flat[0].id : null);
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
  const chText = chapters.length ? `${chapters.length}章・` : '';
  if (!confirm(`作品「${w.title}」を削除しますか？\n全${chText}${episodes.length}話・${fmt(workTotal())}字と、資料${refCount}件が消えます。元に戻せません。`)) return;
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

// chapterId を省略すると、最後の章（章がなければ章なし）の末尾に追加
async function addEpisode(chapterId) {
  const w = curWork();
  if (!w) return;
  const gs = groups();
  const target = chapterId === undefined ? gs[gs.length - 1] : gs.find((g) => gid(g) === chapterId);
  if (!target) return;
  const now = Date.now();
  const ep = {
    id: uid(), workId: w.id, chapterId: gid(target), title: `第${episodes.length + 1}話`, body: '',
    order: target.eps.reduce((m, e) => Math.max(m, e.order), -1) + 1, created: now, updated: now, rev: 1,
  };
  await DB.addEpisode(ep);
  episodes.push(ep);
  if (ep.chapterId) delete ui.collapsed[ep.chapterId];
  DB.notify({ t: 'episodes', workId: w.id, ids: [ep.id] });
  selectEpisode(ep.id);
  el.epTitle.focus();
  el.epTitle.select();
}
$('#addEp').addEventListener('click', () => addEpisode());

// 話を chapterId の章（null＝章なし）の index 番目へ移す（index は移す話を除いた並びでの位置）
async function placeEpisode(id, chapterId, index) {
  const ep = episodes.find((e) => e.id === id);
  if (!ep) return;
  const gs = groups();
  const src = gs.find((g) => g.eps.includes(ep));
  const dst = gs.find((g) => gid(g) === chapterId);
  if (!src || !dst) return;
  src.eps.splice(src.eps.indexOf(ep), 1);
  dst.eps.splice(Math.max(0, Math.min(index, dst.eps.length)), 0, ep);
  ep.chapterId = chapterId;
  const changed = new Set([src, dst]);
  const list = [];
  for (const g of changed) {
    g.eps.forEach((e, i) => { e.order = i; list.push({ id: e.id, order: i, chapterId: gid(g) }); });
  }
  if (chapterId) delete ui.collapsed[chapterId];
  renderAll();
  try {
    await DB.setPlacements(list);
  } catch (e) {
    console.error(e);
    alert('並べ替えを保存できませんでした。');
  }
  DB.notify({ t: 'episodes', workId, ids: [] });
}

function moveEpisode(delta) {
  const ep = curEp();
  if (!ep) return;
  const gs = groups();
  const gi = gs.findIndex((g) => g.eps.includes(ep));
  const g = gs[gi];
  const i = g.eps.indexOf(ep);
  if (delta < 0) {
    if (i > 0) placeEpisode(ep.id, gid(g), i - 1);
    else if (gi > 0) placeEpisode(ep.id, gid(gs[gi - 1]), gs[gi - 1].eps.length); // 前の章の最後へ
  } else if (i < g.eps.length - 1) {
    placeEpisode(ep.id, gid(g), i + 1);
  } else if (gi < gs.length - 1) {
    placeEpisode(ep.id, gid(gs[gi + 1]), 0); // 次の章の最初へ
  }
}
el.epUp.addEventListener('click', () => moveEpisode(-1));
el.epDown.addEventListener('click', () => moveEpisode(1));

el.epChapter.addEventListener('change', () => {
  const ep = curEp();
  if (!ep) return;
  const chapterId = el.epChapter.value || null;
  const dst = groups().find((g) => gid(g) === chapterId);
  placeEpisode(ep.id, chapterId, dst ? dst.eps.filter((e) => e !== ep).length : 0);
});

el.epDelete.addEventListener('click', async () => {
  const ep = curEp();
  if (!ep || !lock.editable) return;
  if (!confirm(`「${ep.title || '無題'}」（${fmt(epCount(ep))}字）を削除しますか？\n元に戻せません。`)) return;
  const flat = flatEpisodes();
  const i = flat.indexOf(ep);
  dirty.delete(ep.id);
  releaseLock();
  await DB.deleteEpisode(ep.id);
  episodes.splice(episodes.indexOf(ep), 1);
  DB.notify({ t: 'episodes', workId, ids: [], deleted: [ep.id] });
  const rest = flat.filter((e) => e !== ep);
  const next = rest[Math.min(i, rest.length - 1)];
  epId = null;
  if (next) selectEpisode(next.id); else renderAll();
});

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

/* ---------- 章の操作 ---------- */

async function addChapter() {
  const w = curWork();
  if (!w) return;
  const title = prompt('章の名前を入力してください', `第${chapters.length + 1}章`);
  if (title === null) return;
  const ch = { id: uid(), workId: w.id, title: title.trim() || '無題の章', order: chapters.reduce((m, c) => Math.max(m, c.order), -1) + 1, created: Date.now() };
  await DB.putChapter(ch);
  chapters.push(ch);
  DB.notify({ t: 'chapters', workId: w.id });
  renderAll();
  setStatus(`章「${ch.title}」を追加しました`);
}
$('#addChapter').addEventListener('click', addChapter);

async function renameChapter(ch) {
  const title = prompt('章の名前', ch.title);
  if (title === null) return;
  ch.title = title.trim() || '無題の章';
  chapterMenu = null;
  await DB.putChapter(ch);
  DB.notify({ t: 'chapters', workId });
  renderAll();
}

async function moveChapter(ch, delta) {
  const i = chapters.indexOf(ch);
  const j = i + delta;
  if (j < 0 || j >= chapters.length) return;
  chapters.splice(i, 1);
  chapters.splice(j, 0, ch);
  chapters.forEach((c, k) => { c.order = k; });
  renderAll();
  await DB.setChapterOrders(chapters.map((c) => ({ id: c.id, order: c.order })));
  DB.notify({ t: 'chapters', workId });
}

function askChapterDelete(ch, eps) {
  return new Promise((resolve) => {
    el.chapterMsg.textContent = `章「${ch.title || '無題の章'}」には ${eps.length}話（${fmt(sumCount(eps))}字）が入っています。中の話をどうしますか？`;
    el.chapterDialog.returnValue = '';
    el.chapterDialog.showModal();
    el.chapterDialog.addEventListener('close', () => resolve(el.chapterDialog.returnValue), { once: true });
  });
}

async function deleteChapter(ch) {
  const eps = episodes.filter((e) => e.chapterId === ch.id);
  let mode = 'unassign';
  if (eps.length) {
    mode = await askChapterDelete(ch, eps);
    if (mode !== 'unassign' && mode !== 'delete') return;
    if (mode === 'delete' && !confirm(`章「${ch.title}」と、中の${eps.length}話（${fmt(sumCount(eps))}字）を削除します。元に戻せません。よろしいですか？`)) return;
  } else if (!confirm(`章「${ch.title || '無題の章'}」を削除しますか？（この章に話はありません）`)) {
    return;
  }
  await flushSave();
  if (mode === 'delete') {
    for (const e of eps) dirty.delete(e.id);
    if (eps.some((e) => e.id === epId)) releaseLock();
  }
  await DB.deleteChapter(ch.id, mode);
  DB.notify({ t: 'chapters', workId });
  DB.notify({ t: 'episodes', workId, ids: [] });
  chapterMenu = null;
  delete ui.collapsed[ch.id];
  await refreshStructure();
  setStatus(mode === 'delete' ? `章と${eps.length}話を削除しました` : '章を削除し、中の話を「章なし」に移しました');
}

el.epList.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (act) {
    const ch = chapters.find((c) => c.id === act.dataset.ch);
    if (!ch) return;
    switch (act.dataset.act) {
      case 'toggle-ch':
        if (ui.collapsed[ch.id]) delete ui.collapsed[ch.id]; else ui.collapsed[ch.id] = true;
        saveUI();
        renderSidebar();
        break;
      case 'ch-menu':
        chapterMenu = chapterMenu === ch.id ? null : ch.id;
        renderSidebar();
        break;
      case 'ch-rename': renameChapter(ch); break;
      case 'ch-add-ep': chapterMenu = null; addEpisode(ch.id); break;
      case 'ch-up': moveChapter(ch, -1); break;
      case 'ch-down': moveChapter(ch, 1); break;
      case 'ch-delete': deleteChapter(ch); break;
      default: break;
    }
    return;
  }
  if (dragJustEnded) return;
  const b = e.target.closest('button[data-ep]');
  if (b) selectEpisode(b.dataset.ep);
});

/* ---------- ドラッグで並べ替え・章の移動 ---------- */
// マウスでもタッチでも使えるよう、⋮⋮ のつまみを Pointer Events で動かす

let drag = null;
let dragJustEnded = false;

function clearDropMarks() {
  el.epList.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-into'));
}

function findDropTarget(x, y) {
  const node = document.elementFromPoint(x, y);
  if (!node || !el.epList.contains(node)) return null;
  const epsOf = (grp) => [...grp.querySelectorAll(':scope > .grp-eps > .ep-row')].map((r) => r.dataset.ep).filter((id) => id !== drag.id);
  const row = node.closest('.ep-row');
  if (row) {
    const grp = row.closest('.grp');
    if (row.dataset.ep === drag.id) return { chapterId: grp.dataset.chapter || null, index: null, mark: null };
    const r = row.getBoundingClientRect();
    const after = y > r.top + r.height / 2;
    const list = epsOf(grp);
    return { chapterId: grp.dataset.chapter || null, index: list.indexOf(row.dataset.ep) + (after ? 1 : 0), mark: [row, after ? 'drop-after' : 'drop-before'] };
  }
  const grp = node.closest('.grp');
  if (!grp) return null;
  const list = epsOf(grp);
  const head = node.closest('.grp-head');
  // 章の見出しに重ねたら先頭へ（閉じている章なら末尾へ）、それ以外の場所なら末尾へ
  const toStart = head && !grp.classList.contains('collapsed');
  return { chapterId: grp.dataset.chapter || null, index: toStart ? 0 : list.length, mark: [head || grp, 'drop-into'] };
}

el.epList.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('[data-drag]');
  if (!handle || e.button !== 0) return;
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  drag = { id: handle.dataset.drag, x: e.clientX, y: e.clientY, started: false, target: null, handle };
});

el.epList.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
    drag.started = true;
    document.body.classList.add('ep-dragging');
    const row = el.epList.querySelector(`.ep-row[data-ep="${CSS.escape(drag.id)}"]`);
    if (row) row.classList.add('dragging');
  }
  // 端に近づいたら一覧をスクロール
  const box = el.sidebar.getBoundingClientRect();
  if (e.clientY < box.top + 48) el.sidebar.scrollTop -= 12;
  else if (e.clientY > box.bottom - 48) el.sidebar.scrollTop += 12;
  clearDropMarks();
  drag.target = findDropTarget(e.clientX, e.clientY);
  if (drag.target && drag.target.mark) drag.target.mark[0].classList.add(drag.target.mark[1]);
});

function endDrag(apply) {
  if (!drag) return;
  const d = drag;
  drag = null;
  clearDropMarks();
  document.body.classList.remove('ep-dragging');
  el.epList.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
  if (!d.started) return;
  // ドラッグの直後に起きるクリックで話が選ばれないようにする
  dragJustEnded = true;
  setTimeout(() => { dragJustEnded = false; }, 0);
  if (apply && d.target && d.target.index !== null) placeEpisode(d.id, d.target.chapterId, d.target.index);
}
el.epList.addEventListener('pointerup', () => endDrag(true));
el.epList.addEventListener('pointercancel', () => endDrag(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drag) endDrag(false); });

/* ---------- 別タブの変更の取り込み ---------- */

// 別タブで保存・並べ替え・削除された章と話を取り込む（このタブで未保存の話はそのまま）
async function refreshStructure() {
  const [freshChs, fresh] = await Promise.all([DB.chapters(workId), DB.episodes(workId)]);
  chapters = freshChs;
  if (chapterMenu && !chapters.some((c) => c.id === chapterMenu)) chapterMenu = null;
  const map = new Map(episodes.map((e) => [e.id, e]));
  const next = [];
  for (const rec of fresh) {
    const local = map.get(rec.id);
    if (!local) { next.push(rec); continue; }
    map.delete(rec.id);
    local.order = rec.order;
    local.chapterId = rec.chapterId || null;
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
  episodes = next;
  if (removedCurrent) {
    epId = null;
    setStatus('開いていた話は削除されました');
    const first = flatEpisodes()[0];
    if (first) { selectEpisode(first.id); return; }
    releaseLock();
  }
  renderAll();
}

DB.onMessage(async (msg) => {
  try {
    if (msg.t === 'works') await reloadWorks();
    else if ((msg.t === 'episodes' || msg.t === 'chapters') && msg.workId === workId) await refreshStructure();
    else if (msg.t === 'refs' && msg.workId === workId) Refs.reload();
  } catch (e) { console.error(e); }
});

// 新しい版のツールが別のタブで開かれたら、保存してからこのタブを止める
DB.onVersionChange(() => flushSave(), () => {
  appClosed = true;
  setEditable(false, 'closed');
  el.updateBanner.hidden = false;
});
DB.onBlocked(() => setStatus('以前の版のタブが閉じるのを待っています…'));
$('#reloadBtn').addEventListener('click', () => location.reload());

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

/* ---------- 書き出し ---------- */
// 作品ごとに本文だけを書き出す（資料は含めない）。ルビ・傍点はカクヨム記法のまま。

// ファイル名に使えない文字を置き換える
function safeName(s, max = 50) {
  const t = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, max);
  return t || '無題';
}
const pad = (n, w) => String(n).padStart(w, '0');

function orderedForExport(w) {
  const chs = w.chapters;
  const none = w.episodes.filter((e) => !e.chapterId || !chs.some((c) => c.id === e.chapterId)).sort(byOrder);
  const list = [{ chapter: null, eps: none }, ...chs.map((c) => ({ chapter: c, eps: w.episodes.filter((e) => e.chapterId === c.id).sort(byOrder) }))];
  return list;
}

function escapeTextLine(line) {
  return [T_WORK, T_WORK_ID, T_CHAPTER, T_EPISODE, '\\'].some((m) => line.startsWith(m)) ? '\\' + line : line;
}

// ② 作品全体を1つのテキストに（章タイトル・話タイトルを見出しとして挟む）
function buildSingleText(w) {
  let out = `${TEXT_HEADER}\n${T_WORK}${w.title || '無題'}\n${T_WORK_ID}${w.id}\n\n`;
  for (const g of orderedForExport(w)) {
    if (g.chapter) out += `${T_CHAPTER}${g.chapter.title || '無題の章'}\n\n`;
    for (const ep of g.eps) {
      out += `${T_EPISODE}${ep.title || '無題'}\n`;
      out += ep.body.split('\n').map(escapeTextLine).join('\n') + '\n\n';
    }
  }
  return out;
}

// ① 1話ずつ別々のファイルを、章ごとのフォルダに分けて ZIP に
function buildZipEntries(w) {
  const root = safeName(w.title);
  const total = w.episodes.length;
  const width = Math.max(3, String(total).length);
  const entries = [{ path: root + '/' }];
  const manifest = { format: 'noveltool-episodes', version: 1, work: { id: w.id, title: w.title }, chapters: [], episodes: [] };
  let no = 0;
  orderedForExport(w).forEach((g, gi) => {
    let folder = '';
    if (g.chapter) {
      folder = `${pad(gi, 2)}_${safeName(g.chapter.title || '無題の章')}`;
      entries.push({ path: `${root}/${folder}/` });
      manifest.chapters.push({ title: g.chapter.title, folder });
    }
    for (const ep of g.eps) {
      no++;
      const file = `${folder ? folder + '/' : ''}${root}_${pad(no, width)}_${safeName(ep.title || '無題')}.txt`;
      entries.push({ path: `${root}/${file}`, text: ep.body });
      manifest.episodes.push({ title: ep.title, chapter: g.chapter ? manifest.chapters.length - 1 : null, file });
    }
  });
  entries.push({ path: `${root}/${MANIFEST_NAME}`, text: JSON.stringify(manifest, null, 2) });
  return entries;
}

$('#exportWork').addEventListener('click', () => {
  const w = curWork();
  if (!w) return;
  el.exportTitle.textContent = `「${w.title || '無題'}」を書き出し`;
  const radio = el.exportDialog.querySelector(`input[name="exportFormat"][value="${ui.exportFormat === 'single' ? 'single' : 'zip'}"]`);
  radio.checked = true;
  el.exportDialog.returnValue = '';
  el.exportDialog.showModal();
});

el.exportDialog.addEventListener('close', async () => {
  if (el.exportDialog.returnValue !== 'ok' || !workId) return;
  ui.exportFormat = el.exportDialog.querySelector('input[name="exportFormat"]:checked').value;
  saveUI();
  await flushSave();
  const w = await DB.exportWork(workId);
  if (!w) return;
  if (ui.exportFormat === 'single') {
    download(new Blob([buildSingleText(w)], { type: 'text/plain;charset=utf-8' }), `${safeName(w.title)}.txt`);
  } else {
    download(Zip.create(buildZipEntries(w)), `${safeName(w.title)}.zip`);
  }
  setStatus('書き出しました');
});

/* ---------- 読み込み ---------- */
// 作品データの形：{ id, title, chapters: [{ title }], episodes: [{ title, body, chapter: 章の番号 or null }], refs }

function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    // UTF-8 でなければ Shift_JIS として読む
    return new TextDecoder('shift_jis').decode(buf);
  }
}
const normalizeText = (t) => t.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

// ② の形式（#noveltool v3）
function parseSingleText(text, fallbackTitle) {
  if (text.endsWith('\n')) text = text.slice(0, -1);
  const lines = text.split('\n');
  const list = [];
  let w = null;
  let cur = null;
  let chapter = null;
  let buf = [];
  const flush = () => {
    if (cur) {
      if (buf.length && buf[buf.length - 1] === '') buf.pop(); // 話と話の間の空行
      cur.body = buf.join('\n');
    }
    buf = [];
    cur = null;
  };
  const ensureWork = () => {
    if (!w) { w = { id: null, title: fallbackTitle, chapters: [], episodes: [], refs: [] }; list.push(w); chapter = null; }
    return w;
  };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(T_WORK_ID) && w && !cur && !w.chapters.length && !w.episodes.length) {
      w.id = line.slice(T_WORK_ID.length).trim() || null;
    } else if (line.startsWith(T_WORK)) {
      flush();
      w = { id: null, title: line.slice(T_WORK.length).trim() || fallbackTitle, chapters: [], episodes: [], refs: [] };
      list.push(w);
      chapter = null;
    } else if (line.startsWith(T_CHAPTER)) {
      flush();
      chapter = ensureWork().chapters.push({ title: line.slice(T_CHAPTER.length).trim() || '無題の章' }) - 1;
    } else if (line.startsWith(T_EPISODE)) {
      flush();
      cur = { title: line.slice(T_EPISODE.length).trim(), body: '', chapter };
      ensureWork().episodes.push(cur);
    } else if (cur) {
      buf.push(line.startsWith('\\') ? line.slice(1) : line);
    }
  }
  flush();
  return list;
}

// 以前の形式（#noveltool v1 / v2）。章はなく、v2 には資料が入っていることがある
function parseOldText(text, fallbackTitle, v2) {
  if (text.endsWith('\n')) text = text.slice(0, -1);
  const lines = text.split('\n');
  const list = [];
  let w = null;
  let cur = null;
  let buf = [];
  const flush = () => { if (cur) cur.body = buf.join('\n'); buf = []; };
  const ensureWork = () => {
    if (!w) { w = { id: null, title: fallbackTitle, chapters: [], episodes: [], refs: [] }; list.push(w); }
    return w;
  };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(OLD_WORK_MARK)) {
      flush();
      cur = null;
      w = { id: null, title: line.slice(OLD_WORK_MARK.length).trim() || '無題', chapters: [], episodes: [], refs: [] };
      list.push(w);
    } else if (v2 && w && !cur && line.startsWith(OLD_ID_MARK)) {
      w.id = line.slice(OLD_ID_MARK.length).trim() || null;
    } else if (line.startsWith(OLD_EP_MARK)) {
      flush();
      cur = { title: line.slice(OLD_EP_MARK.length).trim(), body: '', chapter: null };
      ensureWork().episodes.push(cur);
    } else if (v2 && line.startsWith(OLD_REF_MARK)) {
      flush();
      const ref = { name: line.slice(OLD_REF_MARK.length).trim() || '無題.md', text: '' };
      ensureWork().refs.push(ref);
      cur = { set body(v) { ref.text = v; } };
    } else if (cur) {
      buf.push(line.startsWith('\\') ? line.slice(1) : line);
    }
  }
  flush();
  for (const x of list) x.episodes = x.episodes.filter((e) => 'title' in e);
  return list;
}

function parseTextFile(raw, fallbackTitle) {
  const text = normalizeText(raw);
  const head = text.match(/^#noveltool v(\d+)/);
  if (!head) {
    // 普通のテキストファイルは「1作品・1話」として取り込む
    return [{ id: null, title: fallbackTitle, chapters: [], episodes: [{ title: '第1話', body: text.replace(/\n+$/, ''), chapter: null }], refs: [] }];
  }
  const v = Number(head[1]);
  return v >= 3 ? parseSingleText(text, fallbackTitle) : parseOldText(text, fallbackTitle, v >= 2);
}

const naturalSort = (a, b) => a.localeCompare(b, 'ja', { numeric: true });
const baseName = (p) => p.split('/').pop();

// ① の形式（ZIP を展開したもの、またはフォルダ）。entries: [{ path, dir, data }]
function parseEpisodeTree(entries, fallbackTitle) {
  entries = entries.map((e) => ({ ...e, path: e.path.replace(/\\/g, '/').replace(/^\.\//, '') }))
    .filter((e) => !e.path.split('/').some((seg) => seg === '__MACOSX' || seg.startsWith('._') || seg === '.DS_Store'));
  const text = (e) => normalizeText(decodeText(e.data));

  // 構成ファイルがあれば、それに従って章と話を復元する
  const manifests = entries.filter((e) => !e.dir && baseName(e.path) === MANIFEST_NAME).sort((a, b) => a.path.length - b.path.length);
  if (manifests.length) {
    const mf = manifests[0];
    const root = mf.path.slice(0, mf.path.length - MANIFEST_NAME.length);
    let info;
    try { info = JSON.parse(text(mf)); } catch (e) { info = null; }
    if (info && info.work && Array.isArray(info.episodes)) {
      const byPath = new Map(entries.filter((e) => !e.dir).map((e) => [e.path, e]));
      const missing = [];
      const eps = info.episodes.map((x) => {
        const f = byPath.get(root + x.file);
        if (!f) missing.push(x.file);
        return { title: x.title || '無題', body: f ? text(f) : '', chapter: Number.isInteger(x.chapter) ? x.chapter : null };
      });
      return {
        works: [{ id: info.work.id || null, title: info.work.title || fallbackTitle, chapters: (info.chapters || []).map((c) => ({ title: c.title || '無題の章' })), episodes: eps, refs: [] }],
        missing,
      };
    }
  }

  // 構成ファイルがないときは、フォルダ名とファイル名から組み立てる
  const files = entries.filter((e) => !e.dir && /\.txt$/i.test(e.path));
  const dirs = entries.filter((e) => e.dir).map((e) => e.path.replace(/\/$/, ''));
  const all = [...files.map((f) => f.path), ...dirs];
  const firstSegs = new Set(all.map((p) => p.split('/')[0]));
  const nested = all.some((p) => p.includes('/'));
  const rootName = firstSegs.size === 1 && nested && files.every((f) => f.path.includes('/')) ? [...firstSegs][0] : null;
  const rel = (p) => (rootName ? p.slice(rootName.length + 1) : p);
  const title = rootName || fallbackTitle;
  const prefix = safeName(title) + '_';
  const epTitle = (name) => {
    let t = name.replace(/\.txt$/i, '');
    if (t.startsWith(prefix)) t = t.slice(prefix.length);
    const m = t.match(/^(\d+)[_\s.-]+(.*)$/);
    return m ? (m[2] || '無題') : t;
  };
  const chapterFolders = new Set();
  for (const f of files) { const r = rel(f.path); if (r.includes('/')) chapterFolders.add(r.split('/')[0]); }
  for (const d of dirs) { const r = rel(d); if (r && !r.includes('/')) chapterFolders.add(r); }
  const folderList = [...chapterFolders].sort(naturalSort);
  const chaptersOut = folderList.map((f) => ({ title: f.replace(/^\d+[_\s.-]+/, '') || f }));
  const eps = files.map((f) => {
    const r = rel(f.path);
    const folder = r.includes('/') ? r.split('/')[0] : null;
    return { name: baseName(r), folder, title: epTitle(baseName(r)), body: text(f) };
  });
  const sorted = [
    ...eps.filter((e) => !e.folder).sort((a, b) => naturalSort(a.name, b.name)),
    ...folderList.flatMap((fd) => eps.filter((e) => e.folder === fd).sort((a, b) => naturalSort(a.name, b.name))),
  ];
  return {
    works: [{ id: null, title, chapters: chaptersOut, episodes: sorted.map((e) => ({ title: e.title, body: e.body, chapter: e.folder ? folderList.indexOf(e.folder) : null })), refs: [] }],
    missing: [],
  };
}

$('#importBtn').addEventListener('click', () => el.importFile.click());
$('#importFolderBtn').addEventListener('click', () => el.importFolder.click());

el.importFile.addEventListener('change', async () => {
  const file = el.importFile.files[0];
  el.importFile.value = '';
  if (!file) return;
  const fallback = file.name.replace(/\.[^.]+$/, '') || '読み込んだ作品';
  try {
    if (/\.zip$/i.test(file.name)) {
      const { works: list, missing } = parseEpisodeTree(await Zip.read(file), fallback);
      await confirmImport(file.name, list, missing);
    } else {
      await confirmImport(file.name, parseTextFile(decodeText(await file.arrayBuffer()), fallback), []);
    }
  } catch (e) {
    console.error(e);
    alert(`ファイルを読み込めませんでした。\n${e.message || ''}`);
  }
});

el.importFolder.addEventListener('change', async () => {
  const files = [...el.importFolder.files];
  el.importFolder.value = '';
  if (!files.length) return;
  try {
    const entries = [];
    for (const f of files) entries.push({ path: f.webkitRelativePath || f.name, dir: false, data: new Uint8Array(await f.arrayBuffer()) });
    const folder = (files[0].webkitRelativePath || '').split('/')[0] || '読み込んだ作品';
    const { works: list, missing } = parseEpisodeTree(entries, folder);
    await confirmImport(folder, list, missing);
  } catch (e) {
    console.error(e);
    alert(`フォルダを読み込めませんでした。\n${e.message || ''}`);
  }
});

async function confirmImport(sourceName, list, missing) {
  list = list.filter((x) => x.episodes.length || x.chapters.length || (x.refs && x.refs.length));
  if (!list.length) { alert('読み込める話が見つかりませんでした。'); return; }
  works = await DB.works();
  const exists = (x) => !!(x.id && works.some((w) => w.id === x.id));
  const info = (x) => [x.chapters.length ? `${x.chapters.length}章` : '', `${x.episodes.length}話`, x.refs && x.refs.length ? `資料${x.refs.length}件` : ''].filter(Boolean).join('・');
  el.importMsg.textContent = list.length > 1
    ? `「${sourceName}」に ${list.length}作品 があります。読み込む作品を選んでください。`
    : `「${sourceName}」から次の作品を読み込みます。`;
  el.importList.innerHTML = list.map((x, i) => `
    <li><label><input type="checkbox" data-i="${i}" checked>
      <span><b>${esc(x.title)}</b><small>${info(x)}${exists(x) ? '・<em>同じ作品があります</em>' : ''}</small></span>
    </label></li>`).join('') +
    (missing.length ? `<li class="import-warn">見つからなかったファイル（空の話として読み込みます）：${missing.map(esc).join('、')}</li>` : '');
  el.importModeBox.hidden = !list.some(exists);
  el.importDialog.returnValue = '';
  el.importDialog.showModal();
  const result = await new Promise((resolve) => el.importDialog.addEventListener('close', () => resolve(el.importDialog.returnValue), { once: true }));
  if (result !== 'ok') return;
  const picked = [...el.importList.querySelectorAll('input:checked')].map((c) => list[Number(c.dataset.i)]);
  if (!picked.length) return;
  const replace = el.importDialog.querySelector('input[name="importMode"]:checked').value === 'replace';
  const replacing = replace ? picked.filter(exists) : [];
  if (replacing.length && !confirm(`次の作品の章と話を、ファイルの内容で置き換えます（資料はそのまま残ります）。元に戻せません。\n\n${replacing.map((x) => '・' + x.title).join('\n')}`)) return;
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
    DB.notify({ t: 'chapters', workId: w.id });
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
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
    el.emptyMsg.textContent = `ブラウザの保存領域（IndexedDB）を開けませんでした。プライベートブラウズを解除するか、別のブラウザでお試しください。${e && e.message ? `\n（${e.message}）` : ''}`;
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
