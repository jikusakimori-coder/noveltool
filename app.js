'use strict';

/* =========================================================
   小説執筆ノート
   データはすべて localStorage に保存（サーバー送信なし）
   ========================================================= */

const STORE_KEY = 'noveltool.data.v1';
const UI_KEY = 'noveltool.ui.v1';

// 書き出しファイルの書式
const EXPORT_HEADER = '#noveltool v1';
const WORK_MARK = '=====作品：';
const EP_MARK = '-----話：';

const $ = (s) => document.querySelector(s);
const el = {
  crumb: $('#crumb'), counts: $('#counts'), saveStatus: $('#saveStatus'),
  workList: $('#workList'), empty: $('#empty'), emptyMsg: $('#emptyMsg'), emptyAction: $('#emptyAction'),
  workspace: $('#workspace'), epTitle: $('#epTitle'), editor: $('#editor'), preview: $('#preview'),
  epUp: $('#epUp'), epDown: $('#epDown'),
  importFile: $('#importFile'), importDialog: $('#importDialog'), importMsg: $('#importMsg'),
};
const wideMQ = window.matchMedia('(min-width: 900px)');

/* ---------- データ ---------- */

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function newEpisode(title, body = '') { return { id: uid(), title, body, updated: Date.now() }; }
function newWork(title) { return { id: uid(), title, episodes: [newEpisode('第1話')] }; }

function loadData() {
  let raw = null;
  try { raw = localStorage.getItem(STORE_KEY); } catch (e) { console.error(e); }
  if (raw) {
    try {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.works)) return d;
    } catch (e) { console.error(e); }
    // 壊れたデータは消さずに退避しておく
    try { localStorage.setItem(STORE_KEY + '.broken.' + Date.now(), raw); } catch (e) { /* noop */ }
  }
  return { version: 1, works: [newWork('新しい作品')] };
}

function loadUI() {
  const def = { workId: null, epId: null, view: 'edit', dir: 'h', open: [], pvSize: 17 };
  try { return Object.assign(def, JSON.parse(localStorage.getItem(UI_KEY) || '{}')); } catch (e) { return def; }
}

let data = loadData();
let ui = loadUI();

function curWork() { return data.works.find((w) => w.id === ui.workId) || null; }
function curEp() { const w = curWork(); return w ? w.episodes.find((e) => e.id === ui.epId) || null : null; }

function ensureSelection() {
  let w = curWork();
  if (!w && data.works.length) { w = data.works[0]; ui.workId = w.id; }
  if (!w) { ui.workId = null; ui.epId = null; return; }
  if (!w.episodes.some((e) => e.id === ui.epId)) ui.epId = w.episodes[0] ? w.episodes[0].id : null;
  if (!ui.open.includes(w.id)) ui.open.push(w.id);
}

/* ---------- 保存 ---------- */

let saveTimer = null;
let dirty = false;
let saveErrorShown = false;

function markDirty() {
  dirty = true;
  setStatus('編集中…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

function saveNow() {
  clearTimeout(saveTimer);
  if (!dirty) return true;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
    dirty = false;
    const t = new Date();
    setStatus(`保存済み ${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`);
    return true;
  } catch (e) {
    console.error(e);
    setStatus('保存できません', true);
    if (!saveErrorShown) {
      saveErrorShown = true;
      alert('原稿を保存できませんでした（ブラウザの保存容量不足の可能性があります）。\n「全原稿を書き出し」でバックアップを取ってください。');
    }
    return false;
  }
}

function saveUI() {
  try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* noop */ }
}

function setStatus(text, isError = false) {
  el.saveStatus.textContent = text;
  el.saveStatus.classList.toggle('error', isError);
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
function workCount(w) { return w.episodes.reduce((a, e) => a + epCount(e), 0); }
const fmt = (n) => n.toLocaleString('ja-JP');

/* ---------- 描画 ---------- */

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

function renderSidebar() {
  const html = data.works.map((w) => {
    const open = ui.open.includes(w.id);
    const eps = w.episodes.map((e, i) => `
      <li><button type="button" class="row-btn ep${e.id === ui.epId ? ' current' : ''}" data-act="select-ep" data-work="${w.id}" data-ep="${e.id}">
        <span class="no">${i + 1}</span><span class="name">${esc(e.title || '無題')}</span><span class="cnt">${fmt(epCount(e))}</span>
      </button></li>`).join('');
    return `
    <li class="work${open ? ' open' : ''}">
      <button type="button" class="row-btn work-title" data-act="toggle-work" data-work="${w.id}" aria-expanded="${open}">
        <span class="chev">▸</span><span class="name">${esc(w.title || '無題')}</span><span class="cnt">${fmt(workCount(w))}字</span>
      </button>
      <div class="work-actions">
        <button type="button" data-act="rename-work" data-work="${w.id}">名前を変更</button>
        <button type="button" data-act="export-work" data-work="${w.id}">この作品を書き出し</button>
        <button type="button" class="danger" data-act="delete-work" data-work="${w.id}">削除</button>
      </div>
      <ol class="eps">${eps}</ol>
      <button type="button" class="add-ep" data-act="add-ep" data-work="${w.id}">＋ 話を追加</button>
    </li>`;
  }).join('');
  el.workList.innerHTML = html;
}

function renderCounts() {
  const w = curWork();
  const ep = curEp();
  el.crumb.textContent = w ? (w.title || '無題') : '小説執筆ノート';
  el.counts.innerHTML = w
    ? (ep ? `<span>この話 <b>${fmt(epCount(ep))}</b>字</span>` : '') + `<span>作品計 <b>${fmt(workCount(w))}</b>字</span>`
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
  if (!ep) {
    if (w) {
      el.emptyMsg.textContent = 'この作品にはまだ話がありません。';
      el.emptyAction.textContent = '＋ 話を追加';
      el.emptyAction.onclick = () => addEpisode(w);
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
      el.editor.value = ep.body;
    }
    if (document.activeElement !== el.epTitle) el.epTitle.value = ep.title;
    const idx = w.episodes.indexOf(ep);
    el.epUp.disabled = idx <= 0;
    el.epDown.disabled = idx >= w.episodes.length - 1;
  }

  const view = effectiveView();
  document.body.dataset.view = view;
  document.querySelectorAll('[data-view]').forEach((b) => { if (b.tagName === 'BUTTON') b.classList.toggle('on', b.dataset.view === ui.view); });
  document.querySelectorAll('[data-dir]').forEach((b) => b.classList.toggle('on', b.dataset.dir === ui.dir));
  el.preview.classList.toggle('vertical', ui.dir === 'v');
  el.preview.style.setProperty('--pv-size', ui.pvSize + 'px');
  if (view !== 'edit') renderPreview();
  renderCounts();
}

function renderAll() {
  ensureSelection();
  renderSidebar();
  renderMain();
  saveUI();
}

/* ---------- 操作 ---------- */

function selectEpisode(workId, epId) {
  ui.workId = workId;
  ui.epId = epId;
  if (!ui.open.includes(workId)) ui.open.push(workId);
  closeDrawer();
  renderAll();
}

function addWork() {
  const title = prompt('作品名を入力してください', '新しい作品');
  if (title === null) return;
  const w = newWork(title.trim() || '無題');
  data.works.push(w);
  markDirty();
  selectEpisode(w.id, w.episodes[0].id);
  saveNow();
}

function addEpisode(w) {
  const ep = newEpisode(`第${w.episodes.length + 1}話`);
  w.episodes.push(ep);
  markDirty();
  selectEpisode(w.id, ep.id);
  saveNow();
  el.epTitle.focus();
  el.epTitle.select();
}

function renameWork(w) {
  const title = prompt('作品名', w.title);
  if (title === null) return;
  w.title = title.trim() || '無題';
  markDirty();
  renderAll();
}

function deleteWork(w) {
  if (!confirm(`作品「${w.title}」を削除しますか？\n全${w.episodes.length}話・${fmt(workCount(w))}字が消え、元に戻せません。`)) return;
  data.works = data.works.filter((x) => x !== w);
  ui.open = ui.open.filter((id) => id !== w.id);
  if (ui.workId === w.id) { ui.workId = null; ui.epId = null; }
  markDirty();
  saveNow();
  renderAll();
}

function toggleWork(w) {
  const open = ui.open.includes(w.id);
  if (open && ui.workId === w.id) {
    ui.open = ui.open.filter((id) => id !== w.id);
  } else {
    if (!open) ui.open.push(w.id);
    if (ui.workId !== w.id) { ui.workId = w.id; ui.epId = null; }
  }
  renderAll();
}

el.workList.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const w = data.works.find((x) => x.id === b.dataset.work);
  if (!w) return;
  switch (b.dataset.act) {
    case 'toggle-work': toggleWork(w); break;
    case 'select-ep': selectEpisode(w.id, b.dataset.ep); break;
    case 'add-ep': addEpisode(w); break;
    case 'rename-work': renameWork(w); break;
    case 'export-work': download(buildExport([w]), `${safeName(w.title)}_${stamp()}.txt`); break;
    case 'delete-work': deleteWork(w); break;
  }
});

$('#addWork').addEventListener('click', addWork);

// 本文の入力
let liveTimer = null;
el.editor.addEventListener('input', () => {
  const ep = curEp();
  if (!ep) return;
  ep.body = el.editor.value;
  ep.updated = Date.now();
  markDirty();
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    renderCounts();
    renderSidebar();
    if (effectiveView() === 'split') renderPreview();
  }, 250);
});

el.epTitle.addEventListener('input', () => {
  const ep = curEp();
  if (!ep) return;
  ep.title = el.epTitle.value;
  markDirty();
  renderSidebar();
});
el.epTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); el.editor.focus(); }
});

function moveEpisode(delta) {
  const w = curWork();
  const ep = curEp();
  if (!w || !ep) return;
  const i = w.episodes.indexOf(ep);
  const j = i + delta;
  if (j < 0 || j >= w.episodes.length) return;
  w.episodes.splice(i, 1);
  w.episodes.splice(j, 0, ep);
  markDirty();
  renderAll();
}
el.epUp.addEventListener('click', () => moveEpisode(-1));
el.epDown.addEventListener('click', () => moveEpisode(1));

$('#epDelete').addEventListener('click', () => {
  const w = curWork();
  const ep = curEp();
  if (!w || !ep) return;
  if (!confirm(`「${ep.title || '無題'}」（${fmt(epCount(ep))}字）を削除しますか？\n元に戻せません。`)) return;
  const i = w.episodes.indexOf(ep);
  w.episodes.splice(i, 1);
  const next = w.episodes[Math.min(i, w.episodes.length - 1)];
  ui.epId = next ? next.id : null;
  markDirty();
  saveNow();
  renderAll();
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

// 表示切り替え
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
    dirty = true;
    saveNow();
  }
});

// 閉じる・裏に回るときは必ず保存
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
window.addEventListener('pagehide', saveNow);
window.addEventListener('beforeunload', saveNow);

// 別のタブで保存された内容を反映
window.addEventListener('storage', (e) => {
  if (e.key !== STORE_KEY || !e.newValue || dirty) return;
  try {
    const d = JSON.parse(e.newValue);
    if (d && Array.isArray(d.works)) {
      data = d;
      countCache.clear();
      el.editor.dataset.ep = '';
      renderAll();
      setStatus('別タブの変更を反映しました');
    }
  } catch (err) { /* noop */ }
});

/* ---------- 書き出し・読み込み ---------- */

function escapeBodyLine(line) {
  return (line.startsWith(WORK_MARK) || line.startsWith(EP_MARK) || line.startsWith('\\')) ? '\\' + line : line;
}

function buildExport(works) {
  let out = EXPORT_HEADER + '\n';
  for (const w of works) {
    out += WORK_MARK + (w.title || '無題') + '\n';
    for (const ep of w.episodes) {
      out += EP_MARK + (ep.title || '無題') + '\n';
      out += ep.body.split('\n').map(escapeBodyLine).join('\n') + '\n';
    }
  }
  return out;
}

function parseImport(text, fallbackTitle) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!text.startsWith(EXPORT_HEADER)) {
    // 普通のテキストファイルは「1作品・1話」として取り込む
    return [{ title: fallbackTitle, episodes: [{ title: '第1話', body: text.replace(/\n+$/, '') }] }];
  }
  if (text.endsWith('\n')) text = text.slice(0, -1);
  const lines = text.split('\n');
  const works = [];
  let w = null;
  let ep = null;
  let buf = [];
  const flush = () => { if (ep) ep.body = buf.join('\n'); buf = []; };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(WORK_MARK)) {
      flush();
      ep = null;
      w = { title: line.slice(WORK_MARK.length).trim() || '無題', episodes: [] };
      works.push(w);
    } else if (line.startsWith(EP_MARK)) {
      flush();
      if (!w) { w = { title: fallbackTitle, episodes: [] }; works.push(w); }
      ep = { title: line.slice(EP_MARK.length).trim(), body: '' };
      w.episodes.push(ep);
    } else if (ep) {
      buf.push(line.startsWith('\\') ? line.slice(1) : line);
    }
  }
  flush();
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

$('#exportAll').addEventListener('click', () => {
  saveNow();
  download(buildExport(data.works), `noveltool_全原稿_${stamp()}.txt`);
});
$('#importBtn').addEventListener('click', () => el.importFile.click());

el.importFile.addEventListener('change', async () => {
  const file = el.importFile.files[0];
  el.importFile.value = '';
  if (!file) return;
  let works;
  try {
    const text = decodeText(await file.arrayBuffer());
    works = parseImport(text, file.name.replace(/\.[^.]+$/, '') || '読み込んだ作品');
  } catch (e) {
    console.error(e);
    alert('ファイルを読み込めませんでした。');
    return;
  }
  if (!works.length) { alert('読み込める原稿が見つかりませんでした。'); return; }
  const epTotal = works.reduce((a, w) => a + w.episodes.length, 0);
  el.importMsg.textContent = `「${file.name}」から ${works.length}作品・${epTotal}話 を読み込みます。`;
  el.importDialog.returnValue = '';
  el.importDialog.showModal();
  el.importDialog.addEventListener('close', function onClose() {
    el.importDialog.removeEventListener('close', onClose);
    const mode = el.importDialog.returnValue;
    if (mode !== 'append' && mode !== 'replace') return;
    const imported = works.map((w) => ({
      id: uid(),
      title: w.title,
      episodes: w.episodes.map((e) => newEpisode(e.title, e.body)),
    }));
    if (mode === 'replace') { data.works = imported; ui.open = []; }
    else data.works.push(...imported);
    countCache.clear();
    el.editor.dataset.ep = '';
    const first = imported[0];
    ui.workId = first.id;
    ui.epId = first.episodes[0] ? first.episodes[0].id : null;
    markDirty();
    saveNow();
    closeDrawer();
    renderAll();
    setStatus('読み込みました');
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

/* ---------- 起動 ---------- */
renderAll();
setStatus('');
