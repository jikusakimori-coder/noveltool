'use strict';

/* =========================================================
   人物事典
   ほかのツールとは別のデータベース（noveltool-people）に保存します。
   ========================================================= */

const PDB = (() => {
  const NAME = 'noveltool-people';
  const VERSION = 1;
  let dbPromise = null;

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const r = indexedDB.open(NAME, VERSION);
        r.onupgradeneeded = () => {
          const db = r.result;
          db.createObjectStore('works', { keyPath: 'id' });
          db.createObjectStore('people', { keyPath: 'id' }).createIndex('workId', 'workId');
          db.createObjectStore('calls', { keyPath: 'id' }).createIndex('workId', 'workId');
        };
        r.onsuccess = () => {
          const db = r.result;
          db.onversionchange = () => { db.close(); location.reload(); };
          resolve(db);
        };
        r.onerror = () => reject(r.error);
      });
    }
    return dbPromise;
  }
  // fn の中では IndexedDB の要求だけを await すること
  async function run(names, mode, fn) {
    const db = await open();
    const t = db.transaction(names, mode);
    const done = new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('保存が中断されました'));
    });
    const s = {};
    for (const n of [].concat(names)) s[n] = t.objectStore(n);
    let result;
    try {
      result = await fn(s);
    } catch (e) {
      try { t.abort(); } catch (err) { /* noop */ }
      done.catch(() => {});
      throw e;
    }
    await done;
    return result;
  }

  async function works() {
    const list = await run('works', 'readonly', (s) => req(s.works.getAll()));
    return list.sort((a, b) => (a.order - b.order) || (a.created - b.created));
  }
  function putWork(w) { return run('works', 'readwrite', (s) => { s.works.put(w); }); }
  function deleteWork(id) {
    return run(['works', 'people', 'calls'], 'readwrite', async (s) => {
      s.works.delete(id);
      for (const k of await req(s.people.index('workId').getAllKeys(id))) s.people.delete(k);
      for (const k of await req(s.calls.index('workId').getAllKeys(id))) s.calls.delete(k);
    });
  }
  async function people(workId) {
    const list = await run('people', 'readonly', (s) => req(s.people.index('workId').getAll(workId)));
    return list.sort((a, b) => (a.order - b.order) || (a.created - b.created));
  }
  function putPeople(list) { return run('people', 'readwrite', (s) => { for (const p of list) s.people.put(p); }); }
  // 人物を消すときは、その人物の呼び方もまとめて消す
  function deletePerson(workId, id) {
    return run(['people', 'calls'], 'readwrite', async (s) => {
      s.people.delete(id);
      for (const c of await req(s.calls.index('workId').getAll(workId))) if (c.from === id || c.to === id) s.calls.delete(c.id);
    });
  }
  function calls(workId) { return run('calls', 'readonly', (s) => req(s.calls.index('workId').getAll(workId))); }
  function putCall(c) { return run('calls', 'readwrite', (s) => { s.calls.put(c); }); }
  function deleteCall(id) { return run('calls', 'readwrite', (s) => { s.calls.delete(id); }); }
  // 部・ルートを消したとき、その部の呼び方も消す
  function deletePartCalls(workId, partIds) {
    return run('calls', 'readwrite', async (s) => {
      for (const c of await req(s.calls.index('workId').getAll(workId))) if (partIds.includes(c.part)) s.calls.delete(c.id);
    });
  }
  // data: { work, people, calls }。replace=true なら同じIDの作品を置き換える
  function importWork(data, replace) {
    const now = Date.now();
    return run(['works', 'people', 'calls'], 'readwrite', async (s) => {
      const all = await req(s.works.getAll());
      const existing = data.work.id ? all.find((w) => w.id === data.work.id) : null;
      let work;
      if (existing && replace) {
        for (const k of await req(s.people.index('workId').getAllKeys(existing.id))) s.people.delete(k);
        for (const k of await req(s.calls.index('workId').getAllKeys(existing.id))) s.calls.delete(k);
        work = { ...existing, ...data.work, id: existing.id, order: existing.order, created: existing.created };
      } else {
        const id = data.work.id && !existing ? data.work.id : uid();
        work = { ...data.work, id, order: all.reduce((m, w) => Math.max(m, w.order), -1) + 1, created: now };
      }
      s.works.put(work);
      // 人物のIDは作り直す（ほかの作品の人物とぶつからないように）
      const ids = new Map(data.people.map((p, i) => [p.id, uid() + i.toString(36)]));
      data.people.forEach((p, i) => s.people.put({ ...p, id: ids.get(p.id), workId: work.id, order: i, created: now + i }));
      for (const c of data.calls) {
        const from = ids.get(c.from);
        const to = ids.get(c.to);
        if (from && to) s.calls.put({ ...c, from, to, workId: work.id, id: callId(work.id, c.part, from, to) });
      }
      return work;
    });
  }
  function callId(workId, part, from, to) { return `${workId}|${part || ''}|${from}|${to}`; }

  const TAB = uid();
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('noveltool-people') : null;
  let listener = null;
  if (channel) channel.onmessage = (e) => { if (e.data && e.data.from !== TAB && listener) listener(e.data); };
  function notify(msg) { if (channel) channel.postMessage({ ...msg, from: TAB }); }
  function onMessage(fn) { listener = fn; }

  return { uid, works, putWork, deleteWork, people, putPeople, deletePerson, calls, putCall, deleteCall, deletePartCalls, importWork, callId, notify, onMessage };
})();

/* ---------- 年表ツールの部（読むだけ。年表のデータベースがなければ作らない） ---------- */

function readTimelineWorks() {
  return new Promise((resolve) => {
    let created = false;
    let r;
    try { r = indexedDB.open('noveltool-timeline'); } catch (e) { resolve([]); return; }
    r.onupgradeneeded = () => { created = true; r.transaction.abort(); };
    r.onerror = (e) => { if (e.preventDefault) e.preventDefault(); resolve([]); };
    r.onblocked = () => resolve([]);
    r.onsuccess = () => {
      const db = r.result;
      if (created || !db.objectStoreNames.contains('works')) { db.close(); resolve([]); return; }
      const g = db.transaction('works', 'readonly').objectStore('works').getAll();
      g.onsuccess = () => { db.close(); resolve((g.result || []).sort((a, b) => (a.order - b.order) || (a.created - b.created))); };
      g.onerror = () => { db.close(); resolve([]); };
    };
  });
}

/* ---------- 小物 ---------- */

const $ = (s) => document.querySelector(s);
const DEFAULT_FIELDS = [
  { id: 'yomi', label: '読み', type: 'text' },
  { id: 'alias', label: '別名・愛称', type: 'text' },
  { id: 'age', label: '年齢', type: 'text' },
  { id: 'affiliation', label: '所属・立場', type: 'text', filter: true },
  { id: 'appearance', label: '外見', type: 'long' },
  { id: 'personality', label: '性格', type: 'long' },
  { id: 'firstPerson', label: '一人称', type: 'text' },
  { id: 'tone', label: '口調の特徴', type: 'long' },
  { id: 'catchphrase', label: '口癖', type: 'text' },
  { id: 'memo', label: 'メモ', type: 'long' },
];
const FIRST_PERSON = 'firstPerson';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const clone = (o) => JSON.parse(JSON.stringify(o));
// 検索用：カタカナをひらがなに、英字を小文字に、全角英数を半角に
function fold(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/\s+/g, '');
}
function splitValues(s) { return String(s || '').split(/[、,，／/]/).map((x) => x.trim()).filter(Boolean); }

/* ---------- 状態 ---------- */

let works = [];
let workId = null;
let people = [];
let calls = new Map(); // callId → { from, to, part, call, note }
let personId = null;
const UI_KEY = 'noveltool.people.ui.v1';
let ui = { lastWork: null, tab: 'list', byWork: {} };
try { ui = { ...ui, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') }; } catch (e) { /* noop */ }
function saveUI() { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* noop */ } }
function wv() {
  const v = ui.byWork[workId] || (ui.byWork[workId] = {});
  if (typeof v.q !== 'string') v.q = '';
  if (typeof v.group !== 'string') v.group = '';
  const w = curWork();
  if (!w || !w.parts.some((p) => p.id === v.part)) v.part = '';
  return v;
}

function curWork() { return works.find((w) => w.id === workId) || null; }
function curPerson() { return people.find((p) => p.id === personId) || null; }
function normWork(w) {
  return {
    ...w,
    fields: Array.isArray(w.fields) ? w.fields : clone(DEFAULT_FIELDS),
    parts: Array.isArray(w.parts) ? w.parts : [],
  };
}
function filterFields() { const w = curWork(); return w ? w.fields.filter((f) => f.filter) : []; }

// 呼び方：部の設定があればそれを、なければ基本を使う
function callOf(from, to, part) {
  const own = calls.get(PDB.callId(workId, part, from, to));
  if (part) {
    const base = calls.get(PDB.callId(workId, '', from, to));
    return { own: own || null, base: base || null, use: own || base || null, inherited: !own && !!base };
  }
  return { own: own || null, base: own || null, use: own || null, inherited: false };
}

function matches(p) {
  const v = wv();
  if (v.group) {
    const vals = filterFields().flatMap((f) => splitValues(p.values[f.id]));
    if (!vals.includes(v.group)) return false;
  }
  if (v.q) {
    const q = fold(v.q);
    const hay = fold([p.name, ...Object.values(p.values || {})].join('\n'));
    if (!hay.includes(q)) return false;
  }
  return true;
}
function visiblePeople() { return people.filter(matches); }
function groupOptions() {
  const set = new Set();
  for (const p of people) for (const f of filterFields()) splitValues(p.values[f.id]).forEach((x) => set.add(x));
  return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
}

/* ---------- 読み込み・切り替え ---------- */

function urlWorkId() { return new URLSearchParams(location.search).get('work'); }
function setUrl(push) {
  const u = new URL(location.href);
  if (workId) u.searchParams.set('work', workId); else u.searchParams.delete('work');
  if (u.href !== location.href) history[push ? 'pushState' : 'replaceState'](null, '', u.href);
}
async function loadWorks() { works = (await PDB.works()).map(normWork); }
async function loadData() {
  people = workId ? (await PDB.people(workId)).map((p) => ({ ...p, values: p.values || {} })) : [];
  calls = new Map(workId ? (await PDB.calls(workId)).map((c) => [c.id, c]) : []);
}
async function openWork(id, push) {
  await flushSave();
  const w = works.find((x) => x.id === id) || works.find((x) => x.id === ui.lastWork) || works[0] || null;
  workId = w ? w.id : null;
  await loadData();
  ui.lastWork = workId;
  saveUI();
  const v = workId ? wv() : {};
  personId = people.some((p) => p.id === v.person) ? v.person : (people[0] ? people[0].id : null);
  setUrl(push);
  renderAll();
}

/* ---------- 描画 ---------- */

function renderAll() {
  const w = curWork();
  $('#workSel').innerHTML = works.map((x) => `<option value="${esc(x.id)}">${esc(x.title || '無題')}</option>`).join('') || '<option value="">（作品がありません）</option>';
  $('#workSel').value = workId || '';
  document.title = w ? `${w.title} — 人物事典` : '人物事典';
  for (const id of ['#workSettings', '#exportJson']) $(id).disabled = !w;
  $('#toolbar').hidden = !w;
  $('#empty').hidden = !!w;
  $('#listView').hidden = !w;
  $('#callsView').hidden = !w;
  if (!w) {
    $('#emptyMsg').textContent = 'まだ作品がありません。';
    $('#emptyAction').textContent = '＋ 作品を作る';
    $('#emptyAction').onclick = () => openWorkDialog(null);
    return;
  }
  document.body.dataset.tab = ui.tab === 'calls' ? 'calls' : 'list';
  document.querySelectorAll('[data-tab]').forEach((b) => { if (b.tagName === 'BUTTON') b.classList.toggle('on', b.dataset.tab === document.body.dataset.tab); });
  renderToolbar();
  renderList();
  renderDetail();
  renderCalls();
}

function renderToolbar() {
  const w = curWork();
  const v = wv();
  const groups = groupOptions();
  if (v.group && !groups.includes(v.group)) v.group = '';
  const ff = filterFields();
  $('#groupSel').hidden = !ff.length;
  $('#groupSel').innerHTML = `<option value="">${esc(ff.map((f) => f.label).join('・') || '所属')}：すべて</option>` + groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
  $('#groupSel').value = v.group;
  $('#groupSel').classList.toggle('active', !!v.group);
  if ($('#search').value !== v.q) $('#search').value = v.q;
  $('#partBox').hidden = !w.parts.length;
  $('#partSeg').innerHTML = `<button type="button" data-part="" class="${v.part ? '' : 'on'}">基本</button>` +
    w.parts.map((p) => `<button type="button" data-part="${esc(p.id)}" class="${v.part === p.id ? 'on' : ''}">${esc(p.name)}</button>`).join('');
}

function renderList() {
  const w = curWork();
  const list = visiblePeople();
  const ff = filterFields();
  const yomi = w.fields.find((f) => f.id === 'yomi');
  $('#personList').innerHTML = list.map((p) => {
    const grp = ff.map((f) => p.values[f.id]).filter(Boolean).join(' ／ ');
    return `<li><button type="button" class="pitem${p.id === personId ? ' current' : ''}" data-person="${esc(p.id)}">
      <span class="nm">${esc(p.name || '（名前なし）')}</span>${yomi && p.values.yomi ? `<span class="yomi">${esc(p.values.yomi)}</span>` : ''}
      ${grp ? `<span class="grp">${esc(grp)}</span>` : ''}</button></li>`;
  }).join('') || `<li class="none">${people.length ? '条件に合う人物がいません。' : '「＋ 人物」から登録してください。'}</li>`;
}

function renderDetail() {
  const w = curWork();
  const p = curPerson();
  const d = $('#detail');
  if (!p) {
    d.innerHTML = `<p class="note">${people.length ? '左の一覧から人物を選んでください。' : 'まだ人物がいません。「＋ 人物」から登録してください。'}</p>`;
    return;
  }
  const i = people.indexOf(p);
  let h = `<div class="detail-inner"><div class="detail-head">
    <button type="button" class="btn small back-list" data-act="backList">← 一覧</button>
    <h2>${esc(p.name || '（名前なし）')}</h2>
    <button type="button" class="icon-btn" data-act="up" ${i <= 0 ? 'disabled' : ''} title="一覧で前へ" aria-label="一覧で前へ">↑</button>
    <button type="button" class="icon-btn" data-act="down" ${i >= people.length - 1 ? 'disabled' : ''} title="一覧で後ろへ" aria-label="一覧で後ろへ">↓</button>
    <button type="button" class="btn small danger" data-act="delete">削除</button></div>`;
  h += '<div class="fgrid">';
  h += `<label class="fld name"><span>名前</span><input type="text" data-f="name" value="${esc(p.name)}" autocomplete="off"></label>`;
  for (const f of w.fields) {
    const val = p.values[f.id] || '';
    h += f.type === 'long'
      ? `<label class="fld long"><span>${esc(f.label)}</span><textarea data-v="${esc(f.id)}" rows="3">${esc(val)}</textarea></label>`
      : `<label class="fld"><span>${esc(f.label)}</span><input type="text" data-v="${esc(f.id)}" value="${esc(val)}" autocomplete="off"></label>`;
  }
  h += '</div>';
  h += `<div class="calls-of" id="callsOf">${callsOfHtml(p)}</div></div>`;
  d.innerHTML = h;
}

// 人物ページの「呼び方」：この人物が呼ぶ・呼ばれる
function callsOfHtml(p) {
  const w = curWork();
  const v = wv();
  const part = v.part;
  const others = people.filter((x) => x.id !== p.id);
  if (!others.length) return '';
  const partName = part ? (w.parts.find((x) => x.id === part) || {}).name : '';
  const row = (who, from, to) => {
    const c = callOf(from, to, part);
    const u = c.use;
    return `<li data-from="${esc(from)}" data-to="${esc(to)}"><span class="who">${esc(who.name || '（名前なし）')}</span>
      <span class="how${c.own && part ? ' ov' : ''}">${u && u.call ? esc(u.call) : '<span class="note">—</span>'}${u && u.note ? `<span class="nt">${esc(u.note)}</span>` : ''}</span></li>`;
  };
  return `<h3>呼び方${partName ? `<span class="sub">${esc(partName)}（オレンジは${esc(partName)}だけの呼び方）</span>` : ''}</h3>
    <div class="call-cols">
      <div><h4>${esc(p.name || 'この人物')}が呼ぶとき</h4><ul>${others.map((o) => row(o, p.id, o.id)).join('')}</ul></div>
      <div><h4>${esc(p.name || 'この人物')}を呼ぶとき</h4><ul>${others.map((o) => row(o, o.id, p.id)).join('')}</ul></div>
    </div>`;
}

function renderCalls() {
  const w = curWork();
  const v = wv();
  const list = visiblePeople();
  const part = v.part;
  const partName = part ? (w.parts.find((x) => x.id === part) || {}).name : '';
  $('#callsNote').innerHTML = list.length < 2
    ? (people.length < 2 ? '人物を2人以上登録すると、呼び方表を作れます。' : '検索・絞り込みに合う人物が2人以上いるときに表示します。')
    : `<span class="legend"><span>縦が<b>呼ぶ側</b>、横が<b>呼ばれる側</b>です。マスを押して入力します。</span>${part ? `<span><span class="ov">オレンジ</span>は${esc(partName)}だけの呼び方、薄い文字は基本と同じ</span>` : ''}${w.fields.some((f) => f.id === FIRST_PERSON) ? '<span>斜めのマスは一人称</span>' : ''}</span>`;
  if (list.length < 2) { $('#callsWrap').innerHTML = ''; return; }
  const fp = w.fields.some((f) => f.id === FIRST_PERSON);
  let h = `<table class="ctable"><thead><tr><th class="corner">呼ぶ側 ＼ 呼ばれる側</th>${list.map((p) => `<th scope="col">${esc(p.name || '（名前なし）')}</th>`).join('')}</tr></thead><tbody>`;
  for (const a of list) {
    h += `<tr><th scope="row">${esc(a.name || '（名前なし）')}</th>`;
    for (const b of list) {
      if (a === b) {
        const self = fp && a.values[FIRST_PERSON] ? `一人称：${esc(a.values[FIRST_PERSON])}` : '';
        h += `<td class="self">${self}</td>`;
        continue;
      }
      const c = callOf(a.id, b.id, part);
      const u = c.use;
      const cls = !u ? '' : c.inherited ? ' inherit' : part && c.own ? ' ov' : '';
      h += `<td data-from="${esc(a.id)}" data-to="${esc(b.id)}" title="${esc(`${a.name} → ${b.name}`)}">${u && (u.call || u.note)
        ? `<span class="how${cls}">${esc(u.call || '（補足のみ）')}</span>${u.note ? `<span class="nt">${esc(u.note)}</span>` : ''}`
        : '<span class="empty-cell">—</span>'}</td>`;
    }
    h += '</tr>';
  }
  h += '</tbody></table>';
  const wrap = $('#callsWrap');
  const sx = wrap.scrollLeft;
  const sy = wrap.scrollTop;
  wrap.innerHTML = h;
  wrap.scrollLeft = sx;
  wrap.scrollTop = sy;
}

/* ---------- 操作：上部・絞り込み ---------- */

$('#workSel').addEventListener('change', (e) => openWork(e.target.value, true));
window.addEventListener('popstate', () => openWork(urlWorkId()));
document.querySelectorAll('button[data-tab]').forEach((b) => b.addEventListener('click', () => {
  ui.tab = b.dataset.tab;
  saveUI();
  renderAll();
}));
$('#search').addEventListener('input', (e) => {
  wv().q = e.target.value;
  saveUI();
  renderList();
  renderCalls();
});
$('#groupSel').addEventListener('change', (e) => {
  wv().group = e.target.value;
  saveUI();
  renderToolbar();
  renderList();
  renderCalls();
});
$('#partSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-part]');
  if (!b) return;
  wv().part = b.dataset.part;
  saveUI();
  renderToolbar();
  renderCalls();
  const co = $('#callsOf');
  if (co && curPerson()) co.innerHTML = callsOfHtml(curPerson());
});

/* ---------- 人物 ---------- */

$('#addPerson').addEventListener('click', async () => {
  await flushSave();
  const now = Date.now();
  const p = { id: PDB.uid(), workId, name: '', values: {}, order: people.reduce((m, x) => Math.max(m, x.order), -1) + 1, created: now };
  // 所属で絞り込んでいるときは、その所属を最初から入れておく
  const v = wv();
  const ff = filterFields();
  if (v.group && ff.length) p.values[ff[0].id] = v.group;
  v.q = '';
  people.push(p);
  await PDB.putPeople([p]);
  PDB.notify({ type: 'people', workId });
  selectPerson(p.id);
  if (ui.tab !== 'list') { ui.tab = 'list'; renderAll(); }
  const inp = $('#detail [data-f="name"]');
  if (inp) inp.focus();
});

function selectPerson(id) {
  personId = id;
  wv().person = id;
  saveUI();
  renderToolbar();
  renderList();
  renderDetail();
  document.body.classList.add('show-detail');
}
$('#personList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-person]');
  if (!b) return;
  await flushSave();
  selectPerson(b.dataset.person);
});

let saveTimer = null;
const dirty = new Set();
function markDirty(p) {
  dirty.add(p);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!dirty.size) return;
  const list = [...dirty];
  dirty.clear();
  try {
    await PDB.putPeople(list);
    PDB.notify({ type: 'people', workId });
  } catch (err) {
    console.error(err);
    alert('保存できませんでした：' + err.message);
  }
}
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });

$('#detail').addEventListener('input', (e) => {
  const p = curPerson();
  if (!p) return;
  const f = e.target.dataset.f;
  const v = e.target.dataset.v;
  if (f === 'name') {
    p.name = e.target.value;
    $('#detail h2').textContent = p.name || '（名前なし）';
  } else if (v) {
    p.values[v] = e.target.value;
  } else return;
  markDirty(p);
  renderList();
});
$('#detail').addEventListener('change', (e) => {
  // 入力が終わったら、絞り込みの候補と呼び方表を整える
  if (e.target.dataset.f || e.target.dataset.v) { renderToolbar(); renderCalls(); }
});
$('#detail').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-from]');
  if (li) { openCall(li.dataset.from, li.dataset.to); return; }
  const b = e.target.closest('[data-act]');
  const p = curPerson();
  if (!b || !p) return;
  const act = b.dataset.act;
  if (act === 'backList') { document.body.classList.remove('show-detail'); return; }
  if (act === 'delete') {
    const n = [...calls.values()].filter((c) => c.from === p.id || c.to === p.id).length;
    if (!confirm(`「${p.name || '（名前なし）'}」を削除しますか？${n ? `\nこの人物の呼び方${n}件も消えます。` : ''}`)) return;
    dirty.delete(p);
    await PDB.deletePerson(workId, p.id);
    PDB.notify({ type: 'people', workId });
    const i = people.indexOf(p);
    people.splice(i, 1);
    for (const [k, c] of calls) if (c.from === p.id || c.to === p.id) calls.delete(k);
    personId = people[Math.min(i, people.length - 1)] ? people[Math.min(i, people.length - 1)].id : null;
    document.body.classList.remove('show-detail');
    renderAll();
    return;
  }
  if (act === 'up' || act === 'down') {
    const i = people.indexOf(p);
    const j = act === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= people.length) return;
    [people[i], people[j]] = [people[j], people[i]];
    people.forEach((x, k) => { if (x.order !== k) { x.order = k; dirty.add(x); } });
    await flushSave();
    renderList();
    renderDetail();
    renderCalls();
  }
});

/* ---------- 呼び方の入力 ---------- */

let callEdit = null; // { from, to, part }
function openCall(from, to) {
  const w = curWork();
  const a = people.find((x) => x.id === from);
  const b = people.find((x) => x.id === to);
  if (!a || !b) return;
  const part = wv().part;
  const partName = part ? (w.parts.find((x) => x.id === part) || {}).name : '';
  const c = callOf(from, to, part);
  callEdit = { from, to, part };
  $('#callTitle').textContent = `${a.name || '（名前なし）'} → ${b.name || '（名前なし）'}${partName ? `（${partName}）` : ''}`;
  $('#callBase').textContent = part
    ? (c.base && (c.base.call || c.base.note) ? `基本の呼び方：${c.base.call || '（なし）'}${c.base.note ? `（${c.base.note}）` : ''}。${partName}だけ違うときに入力します。` : `基本の呼び方はまだありません。ここに書くと${partName}だけの呼び方になります。`)
    : `${a.name || 'この人物'}が${b.name || '相手'}をどう呼ぶか。部・ルートで違うときは、上で部を選んでから入力します。`;
  $('#callText').value = c.own ? c.own.call || '' : '';
  $('#callNote').value = c.own ? c.own.note || '' : '';
  $('#callText').placeholder = part && c.base && c.base.call ? `基本：${c.base.call}` : '例：〇〇さん';
  $('#callReset').hidden = !part || !c.own;
  $('#callClear').hidden = !c.own;
  $('#callDialog').showModal();
  $('#callText').focus();
}
async function saveCall(text, note) {
  const { from, to, part } = callEdit;
  const id = PDB.callId(workId, part, from, to);
  if (!text.trim() && !note.trim()) {
    calls.delete(id);
    await PDB.deleteCall(id);
  } else {
    const c = { id, workId, from, to, part, call: text.trim(), note: note.replace(/\s+$/, '') };
    calls.set(id, c);
    await PDB.putCall(c);
  }
  PDB.notify({ type: 'calls', workId });
  renderCalls();
  const co = $('#callsOf');
  if (co && curPerson()) co.innerHTML = callsOfHtml(curPerson());
}
$('#callForm').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  await saveCall($('#callText').value, $('#callNote').value);
  $('#callDialog').close();
});
// 「基本と同じにする」「消す」は、この部（または基本）の呼び方を消す
for (const id of ['#callReset', '#callClear']) {
  $(id).addEventListener('click', async () => {
    await saveCall('', '');
    $('#callDialog').close();
  });
}
$('#callsWrap').addEventListener('click', (e) => {
  const td = e.target.closest('td[data-from]');
  if (td) openCall(td.dataset.from, td.dataset.to);
});

/* ---------- 作品の設定 ---------- */

let editing = null; // { work, fields, parts }
function openWorkDialog(w) {
  editing = { work: w, fields: clone(w ? w.fields : DEFAULT_FIELDS), parts: clone(w ? w.parts : []) };
  $('#workTitle').textContent = w ? '作品の設定' : '新しい作品';
  $('#workName').value = w ? w.title : '';
  $('#workDelete').hidden = !w;
  renderFieldRows();
  renderPartRows();
  $('#workDialog').showModal();
  if (!w) $('#workName').focus();
}
function renderFieldRows() {
  const fs = editing.fields;
  $('#fieldRows').innerHTML = fs.map((f, i) => `<div class="row" data-i="${i}">
    <input type="text" data-k="label" value="${esc(f.label)}" aria-label="項目名" required>
    <label><input type="checkbox" data-k="long"${f.type === 'long' ? ' checked' : ''}>長文</label>
    <label><input type="checkbox" data-k="filter"${f.filter ? ' checked' : ''}>絞り込み</label>
    <button type="button" class="icon-btn" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="前へ">↑</button>
    <button type="button" class="icon-btn" data-act="down" ${i === fs.length - 1 ? 'disabled' : ''} aria-label="後ろへ">↓</button>
    <button type="button" class="icon-btn" data-act="del" aria-label="この項目を削除">✕</button></div>`).join('') || '<p class="note">名前のほかに項目がありません。</p>';
}
function renderPartRows() {
  const ps = editing.parts;
  $('#partRows').innerHTML = ps.map((p, i) => `<div class="row" data-i="${i}">
    <input type="text" data-k="name" value="${esc(p.name)}" aria-label="部・ルートの名前" required>
    <button type="button" class="icon-btn" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="前へ">↑</button>
    <button type="button" class="icon-btn" data-act="down" ${i === ps.length - 1 ? 'disabled' : ''} aria-label="後ろへ">↓</button>
    <button type="button" class="icon-btn" data-act="del" aria-label="この部・ルートを削除">✕</button></div>`).join('') || '<p class="note">部・ルートがなければ、呼び方は「基本」だけになります。</p>';
}
function rowsHandler(listKey, render, confirmDel) {
  return {
    input(e) {
      const row = e.target.closest('.row');
      if (!row) return;
      const it = editing[listKey][Number(row.dataset.i)];
      const k = e.target.dataset.k;
      if (k === 'long') it.type = e.target.checked ? 'long' : 'text';
      else if (k === 'filter') it.filter = e.target.checked;
      else if (k) it[k] = e.target.value;
    },
    click(e) {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const i = Number(b.closest('.row').dataset.i);
      const list = editing[listKey];
      if (b.dataset.act === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
      else if (b.dataset.act === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
      else if (b.dataset.act === 'del') { if (!confirmDel(list[i])) return; list.splice(i, 1); }
      render();
    },
  };
}
const fh = rowsHandler('fields', renderFieldRows, (f) => {
  const n = editing.work ? people.filter((p) => (p.values[f.id] || '').trim()).length : 0;
  return !n || confirm(`項目「${f.label}」を削除しますか？\n${n}人分の内容も消えます（保存したとき）。`);
});
const ph = rowsHandler('parts', renderPartRows, (p) => {
  const n = editing.work ? [...calls.values()].filter((c) => c.part === p.id).length : 0;
  return !n || confirm(`「${p.name}」を削除しますか？\n${p.name}だけの呼び方${n}件も消えます（保存したとき）。`);
});
$('#fieldRows').addEventListener('input', fh.input);
$('#fieldRows').addEventListener('change', fh.input);
$('#fieldRows').addEventListener('click', fh.click);
$('#partRows').addEventListener('input', ph.input);
$('#partRows').addEventListener('click', ph.click);
$('#fieldAdd').addEventListener('click', () => {
  editing.fields.push({ id: PDB.uid(), label: '新しい項目', type: 'text' });
  renderFieldRows();
  const inp = $('#fieldRows .row:last-child input[type=text]');
  if (inp) inp.select();
});
$('#partAdd').addEventListener('click', () => {
  editing.parts.push({ id: PDB.uid(), name: editing.parts.length ? `ルート${editing.parts.length + 1}` : '第一部' });
  renderPartRows();
  const inp = $('#partRows .row:last-child input[type=text]');
  if (inp) inp.select();
});

let tlWorks = [];
$('#partFromTimeline').addEventListener('click', async () => {
  tlWorks = (await readTimelineWorks()).filter((w) => Array.isArray(w.parts) && w.parts.length);
  const sel = $('#tlSel');
  sel.innerHTML = tlWorks.map((w) => `<option value="${esc(w.id)}">${esc(w.title || '無題')}（${w.parts.map((p) => esc(p.name)).join('・')}）</option>`).join('');
  const same = tlWorks.find((w) => w.title === $('#workName').value.trim());
  if (same) sel.value = same.id;
  $('#tlNote').textContent = tlWorks.length ? 'すでにある同じ名前の部・ルートは足しません。' : '部のある年表が見つかりません（年表ツールで年表を作ると選べます）。';
  $('#tlOk').disabled = !tlWorks.length;
  $('#tlDialog').returnValue = '';
  $('#tlDialog').showModal();
});
$('#tlDialog').addEventListener('close', () => {
  if ($('#tlDialog').returnValue !== 'ok') return;
  const w = tlWorks.find((x) => x.id === $('#tlSel').value);
  if (!w) return;
  for (const p of w.parts) if (p.name && !editing.parts.some((x) => x.name === p.name)) editing.parts.push({ id: PDB.uid(), name: p.name });
  renderPartRows();
});

$('#newWork').addEventListener('click', () => openWorkDialog(null));
$('#workSettings').addEventListener('click', () => openWorkDialog(curWork()));
$('#workForm').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  if (!$('#workForm').reportValidity()) return;
  const fields = editing.fields.map((f) => ({ id: f.id, label: f.label.trim() || '項目', type: f.type === 'long' ? 'long' : 'text', ...(f.filter ? { filter: true } : {}) }));
  const parts = editing.parts.map((p) => ({ id: p.id, name: p.name.trim() || '部' }));
  const old = editing.work;
  const w = old
    ? { ...old, title: $('#workName').value.trim(), fields, parts }
    : { id: PDB.uid(), title: $('#workName').value.trim(), fields, parts, order: works.reduce((m, x) => Math.max(m, x.order), -1) + 1, created: Date.now() };
  try {
    await flushSave();
    await PDB.putWork(w);
    if (old) {
      // 消した項目の内容と、消した部の呼び方を片づける
      const gone = old.fields.map((f) => f.id).filter((id) => !fields.some((f) => f.id === id));
      if (gone.length) {
        const changedPeople = people.filter((p) => gone.some((id) => id in p.values));
        changedPeople.forEach((p) => gone.forEach((id) => delete p.values[id]));
        if (changedPeople.length) await PDB.putPeople(changedPeople);
      }
      const goneParts = old.parts.map((p) => p.id).filter((id) => !parts.some((p) => p.id === id));
      if (goneParts.length) await PDB.deletePartCalls(w.id, goneParts);
    }
    PDB.notify({ type: 'works' });
    $('#workDialog').close();
    await loadWorks();
    if (old) { await loadData(); renderAll(); } else await openWork(w.id, true);
  } catch (err) {
    console.error(err);
    alert('保存できませんでした：' + err.message);
  }
});
$('#workDelete').addEventListener('click', async () => {
  const w = editing.work;
  if (!w || !confirm(`作品「${w.title}」の人物${people.length}人と呼び方をすべて削除しますか？\n（元に戻せません。必要なら先に書き出してください）`)) return;
  await PDB.deleteWork(w.id);
  delete ui.byWork[w.id];
  PDB.notify({ type: 'works' });
  $('#workDialog').close();
  await loadWorks();
  await openWork(null);
});

/* =========================================================
   書き出し・読み込み（JSON）
   ========================================================= */

function safeName(s) { return (s || '無題').replace(/[\\/:*?"<>|]/g, '_').trim() || '無題'; }
function exportData() {
  const w = curWork();
  return {
    format: 'noveltool-people',
    version: 1,
    work: { id: w.id, title: w.title },
    fields: w.fields,
    parts: w.parts,
    people: people.map((p) => {
      const values = {};
      for (const f of w.fields) if (p.values[f.id]) values[f.id] = p.values[f.id];
      return { id: p.id, name: p.name, values };
    }),
    calls: [...calls.values()].filter((c) => people.some((p) => p.id === c.from) && people.some((p) => p.id === c.to))
      .sort((a, b) => people.findIndex((p) => p.id === a.from) - people.findIndex((p) => p.id === b.from) || people.findIndex((p) => p.id === a.to) - people.findIndex((p) => p.id === b.to) || (a.part || '').localeCompare(b.part || ''))
      .map((c) => ({ from: c.from, to: c.to, ...(c.part ? { part: c.part } : {}), call: c.call, ...(c.note ? { note: c.note } : {}) })),
  };
}
$('#exportJson').addEventListener('click', async () => {
  await flushSave();
  const w = curWork();
  const blob = new Blob([JSON.stringify(exportData(), null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safeName(w.title)}_人物事典.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

function parseImport(text) {
  let d;
  try { d = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error('JSONとして読めません（' + e.message + '）'); }
  if (!d || typeof d !== 'object' || !Array.isArray(d.people)) throw new Error('「people」（人物の一覧）がありません（READMEの「人物事典のJSON」を参照）。');
  const str = (v) => (v == null ? '' : String(v));
  // 項目：省略すると最初からある項目
  const fields = [];
  for (const f of Array.isArray(d.fields) ? d.fields : clone(DEFAULT_FIELDS)) {
    const label = str(typeof f === 'string' ? f : f.label).trim();
    if (!label) continue;
    let id = str(typeof f === 'object' && f.id) || (DEFAULT_FIELDS.find((x) => x.label === label) || {}).id || PDB.uid() + fields.length;
    while (fields.some((x) => x.id === id)) id += '_';
    fields.push({ id, label, type: f.type === 'long' ? 'long' : 'text', ...(f.filter ? { filter: true } : {}) });
  }
  const fieldOf = (k) => fields.find((f) => f.id === k) || fields.find((f) => f.label === k);
  const parts = [];
  for (const p of Array.isArray(d.parts) ? d.parts : []) {
    const name = str(typeof p === 'string' ? p : p.name).trim();
    if (!name) continue;
    let id = str(typeof p === 'object' && p.id) || PDB.uid() + parts.length;
    while (parts.some((x) => x.id === id)) id += '_';
    parts.push({ id, name });
  }
  const pp = [];
  for (const [i, p] of d.people.entries()) {
    if (!p || typeof p !== 'object') continue;
    let id = str(p.id) || `p${i + 1}`;
    while (pp.some((x) => x.id === id)) id += '_';
    const values = {};
    // values の中、または人物の項目に直接書いた値を、項目のIDか項目名で受け取る
    const src = { ...p, ...(p.values && typeof p.values === 'object' ? p.values : {}) };
    for (const [k, v] of Object.entries(src)) {
      if (k === 'id' || k === 'name' || k === 'values' || v == null || typeof v === 'object') continue;
      let f = fieldOf(k);
      if (!f && p.values && k in p.values) {
        // 知らない項目は、項目として足す
        f = { id: PDB.uid() + fields.length, label: k, type: String(v).includes('\n') ? 'long' : 'text' };
        fields.push(f);
      }
      if (f && str(v)) values[f.id] = str(v);
    }
    pp.push({ id, name: str(p.name).trim(), values });
  }
  const personOf = (k) => pp.find((x) => x.id === str(k)) || pp.find((x) => x.name === str(k));
  const partOf = (k) => parts.find((x) => x.id === str(k)) || parts.find((x) => x.name === str(k));
  const cl = [];
  for (const c of Array.isArray(d.calls) ? d.calls : []) {
    const a = personOf(c.from);
    const b = personOf(c.to);
    if (!a || !b || a === b) continue;
    let part = '';
    if (c.part) {
      const p = partOf(c.part);
      if (p) part = p.id;
      else { const np = { id: PDB.uid() + parts.length, name: str(c.part) }; parts.push(np); part = np.id; }
    }
    const call = str(c.call).trim();
    const note = str(c.note).replace(/\s+$/, '');
    if (!call && !note) continue;
    cl.push({ from: a.id, to: b.id, part, call, note });
  }
  const w = d.work || {};
  return { work: { id: w.id ? str(w.id) : '', title: str(w.title || '読み込んだ人物事典'), fields, parts }, people: pp, calls: cl };
}
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try {
    data = parseImport(await file.text());
  } catch (err) {
    alert('読み込めませんでした：' + err.message);
    return;
  }
  const existing = data.work.id ? works.find((w) => w.id === data.work.id) : null;
  const dlg = $('#importDialog');
  $('#importMsg').textContent = `「${data.work.title}」（人物${data.people.length}人・呼び方${data.calls.length}件）を読み込みます。` + (existing ? `同じ作品「${existing.title}」がすでにあります。` : '');
  $('#importReplace').hidden = !existing;
  $('#importAdd').textContent = existing ? '別の作品として追加' : '読み込む';
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    const mode = dlg.returnValue;
    if (mode !== 'add' && mode !== 'replace') return;
    try {
      await flushSave();
      const w = await PDB.importWork(data, mode === 'replace');
      PDB.notify({ type: 'works' });
      await loadWorks();
      await openWork(w.id, true);
    } catch (err) {
      console.error(err);
      alert('読み込めませんでした：' + err.message);
    }
  }, { once: true });
});

/* ---------- 別タブの変更を反映 ---------- */

PDB.onMessage(async (msg) => {
  if (dirty.size || document.querySelector('dialog[open]')) return;
  if (msg.type === 'works') {
    await loadWorks();
    if (!works.some((w) => w.id === workId)) { await openWork(null); return; }
    await loadData();
    renderAll();
  } else if (msg.workId === workId) {
    const active = document.activeElement;
    const typing = active && $('#detail').contains(active);
    await loadData();
    if (!people.some((p) => p.id === personId)) personId = people[0] ? people[0].id : null;
    renderToolbar();
    renderList();
    renderCalls();
    if (!typing) renderDetail();
  }
});

/* ---------- 起動 ---------- */

(async () => {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await loadWorks();
    await openWork(urlWorkId());
  } catch (err) {
    console.error(err);
    $('#empty').hidden = false;
    $('#emptyMsg').textContent = 'データを開けませんでした：' + err.message;
    $('#emptyAction').hidden = true;
  }
})();
