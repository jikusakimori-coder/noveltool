'use strict';

/* =========================================================
   伏線管理
   ほかのツールとは別のデータベース（noveltool-clues）に保存します。
   人物事典・年表・執筆ツールのデータは、候補を出すために読むだけです。
   ========================================================= */

const CDB = (() => {
  const NAME = 'noveltool-clues';
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
          db.createObjectStore('clues', { keyPath: 'id' }).createIndex('workId', 'workId');
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
    return run(['works', 'clues'], 'readwrite', async (s) => {
      s.works.delete(id);
      for (const k of await req(s.clues.index('workId').getAllKeys(id))) s.clues.delete(k);
    });
  }
  function clues(workId) { return run('clues', 'readonly', (s) => req(s.clues.index('workId').getAll(workId))); }
  function putClue(c) { return run('clues', 'readwrite', (s) => { s.clues.put(c); }); }
  function deleteClue(id) { return run('clues', 'readwrite', (s) => { s.clues.delete(id); }); }
  // 部を消したとき、伏線からその部を外す
  function removeParts(workId, ids) {
    return run('clues', 'readwrite', async (s) => {
      for (const c of await req(s.clues.index('workId').getAll(workId))) {
        const parts = (c.shownParts || []).filter((p) => !ids.includes(p));
        if (parts.length !== (c.shownParts || []).length) s.clues.put({ ...c, shownParts: parts });
      }
    });
  }
  // data: { work, clues }。replace=true なら同じIDの作品を置き換える
  function importWork(data, replace) {
    const now = Date.now();
    return run(['works', 'clues'], 'readwrite', async (s) => {
      const all = await req(s.works.getAll());
      const existing = data.work.id ? all.find((w) => w.id === data.work.id) : null;
      let work;
      if (existing && replace) {
        for (const k of await req(s.clues.index('workId').getAllKeys(existing.id))) s.clues.delete(k);
        work = { ...existing, ...data.work, id: existing.id, order: existing.order, created: existing.created };
      } else {
        const id = data.work.id && !existing ? data.work.id : uid();
        work = { ...data.work, id, order: all.reduce((m, w) => Math.max(m, w.order), -1) + 1, created: now };
      }
      s.works.put(work);
      data.clues.forEach((c, i) => s.clues.put({ ...c, id: uid() + i.toString(36), workId: work.id, created: now + i, updated: now }));
      return work;
    });
  }

  const TAB = uid();
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('noveltool-clues') : null;
  let listener = null;
  if (channel) channel.onmessage = (e) => { if (e.data && e.data.from !== TAB && listener) listener(e.data); };
  function notify(msg) { if (channel) channel.postMessage({ ...msg, from: TAB }); }
  function onMessage(fn) { listener = fn; }

  return { uid, works, putWork, deleteWork, clues, putClue, deleteClue, removeParts, importWork, notify, onMessage };
})();

/* ---------- ほかのツールのデータ（読むだけ） ---------- */

// データベースが存在するときだけ開いて読む（存在しなければ作らない。作ってしまうとそのツールが初期化できなくなる）
function readOther(name, stores, fn) {
  return new Promise((resolve) => {
    let created = false;
    let r;
    try { r = indexedDB.open(name); } catch (e) { resolve(null); return; }
    r.onupgradeneeded = () => { created = true; r.transaction.abort(); };
    r.onerror = (e) => { if (e.preventDefault) e.preventDefault(); resolve(null); };
    r.onblocked = () => resolve(null);
    r.onsuccess = async () => {
      const db = r.result;
      db.onversionchange = () => db.close();
      if (created || stores.some((s) => !db.objectStoreNames.contains(s))) { db.close(); resolve(null); return; }
      try {
        const t = db.transaction(stores, 'readonly');
        const get = (store, index, key) => new Promise((res, rej) => {
          const st = t.objectStore(store);
          const q = index ? st.index(index).getAll(key) : st.getAll();
          q.onsuccess = () => res(q.result || []);
          q.onerror = () => rej(q.error);
        });
        resolve(await fn(get));
      } catch (e) {
        console.error(e);
        resolve(null);
      } finally {
        db.close();
      }
    };
  });
}
const byOrder = (a, b) => ((a.order || 0) - (b.order || 0)) || ((a.created || 0) - (b.created || 0));
const OTHER = {
  peopleWorks: () => readOther('noveltool-people', ['works'], (get) => get('works')).then((l) => (l || []).sort(byOrder)),
  peopleNames: (wid) => readOther('noveltool-people', ['people'], (get) => get('people', 'workId', wid))
    .then((l) => (l || []).sort(byOrder).map((p) => p.name).filter(Boolean)),
  timelineWorks: () => readOther('noveltool-timeline', ['works'], (get) => get('works')).then((l) => (l || []).sort(byOrder)),
  timelineNames: (wid) => readOther('noveltool-timeline', ['events'], (get) => get('events', 'workId', wid))
    .then((l) => (l || []).flatMap((e) => e.people || [])),
  novelWorks: () => readOther('noveltool', ['works'], (get) => get('works')).then((l) => (l || []).sort(byOrder)),
  // 執筆ツールの話を、画面と同じ順（章なし → 章の順）に並べる
  novelEpisodes: (wid) => readOther('noveltool', ['episodes', 'chapters'], async (get) => {
    const chs = (await get('chapters', 'workId', wid)).sort(byOrder);
    const eps = (await get('episodes', 'workId', wid)).sort(byOrder);
    const out = eps.filter((e) => !e.chapterId || !chs.some((c) => c.id === e.chapterId));
    for (const c of chs) out.push(...eps.filter((e) => e.chapterId === c.id));
    return out.map((e) => e.title || '').filter(Boolean);
  }).then((l) => l || []),
};

/* ---------- 小物 ---------- */

const $ = (s) => document.querySelector(s);
const KINDS = { foreshadow: '伏線', clue: '手がかり', misdirect: 'ミスリード' };
const STATUSES = { open: '未回収', done: '回収済み', hold: '保留' };
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const uniq = (l) => [...new Set(l.filter(Boolean))];
function fold(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}
const natural = (a, b) => a.localeCompare(b, 'ja', { numeric: true });

/* ---------- 状態 ---------- */

let works = [];
let workId = null;
let clues = [];
const src = { peopleWorks: [], timelineWorks: [], novelWorks: [], names: [], episodes: [] };
const UI_KEY = 'noveltool.clues.ui.v1';
let ui = { lastWork: null, byWork: {} };
try { ui = { ...ui, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') }; } catch (e) { /* noop */ }
function saveUI() { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* noop */ } }
function fv() {
  const v = ui.byWork[workId] || (ui.byWork[workId] = {});
  for (const k of ['status', 'kind', 'part', 'person', 'ep', 'q']) if (typeof v[k] !== 'string') v[k] = '';
  return v;
}
function curWork() { return works.find((w) => w.id === workId) || null; }
function normWork(w) { return { ...w, parts: Array.isArray(w.parts) ? w.parts : [], links: w.links || {} }; }
function normClue(c) {
  return {
    ...c,
    text: c.text || '', kind: KINDS[c.kind] ? c.kind : 'foreshadow', status: STATUSES[c.status] ? c.status : 'open',
    planted: c.planted || '', payoffPlan: c.payoffPlan || '', payoff: c.payoff || '',
    shownParts: Array.isArray(c.shownParts) ? c.shownParts : [], people: Array.isArray(c.people) ? c.people : [], memo: c.memo || '',
  };
}

// 人物の候補：人物事典 → 年表 → この作品で使った名前
function peopleCandidates() { return uniq([...src.names, ...clues.flatMap((c) => c.people)]); }
// 話の候補：執筆ツールの話の順 → この作品で使った話（自然順）
function episodeList() {
  const used = uniq(clues.flatMap((c) => [c.planted, c.payoffPlan, c.payoff])).filter((e) => !src.episodes.includes(e)).sort(natural);
  return uniq([...src.episodes, ...used]);
}
function epRank(list, ep) { const i = list.indexOf(ep); return ep ? (i < 0 ? 1e6 : i) : 2e6; }

async function loadSources() {
  const w = curWork();
  const [pw, tw, nw] = await Promise.all([OTHER.peopleWorks(), OTHER.timelineWorks(), OTHER.novelWorks()]);
  src.peopleWorks = pw;
  src.timelineWorks = tw;
  src.novelWorks = nw;
  const l = w ? w.links : {};
  const [pn, tn, eps] = await Promise.all([
    l.people && pw.some((x) => x.id === l.people) ? OTHER.peopleNames(l.people) : [],
    l.timeline && tw.some((x) => x.id === l.timeline) ? OTHER.timelineNames(l.timeline) : [],
    l.novel && nw.some((x) => x.id === l.novel) ? OTHER.novelEpisodes(l.novel) : [],
  ]);
  src.names = uniq([...pn, ...tn]);
  src.episodes = uniq(eps);
}

/* ---------- 読み込み・切り替え ---------- */

function urlWorkId() { return new URLSearchParams(location.search).get('work'); }
function setUrl(push) {
  const u = new URL(location.href);
  if (workId) u.searchParams.set('work', workId); else u.searchParams.delete('work');
  if (u.href !== location.href) history[push ? 'pushState' : 'replaceState'](null, '', u.href);
}
async function loadWorks() { works = (await CDB.works()).map(normWork); }
async function loadClues() { clues = workId ? (await CDB.clues(workId)).map(normClue) : []; }
async function openWork(id, push) {
  const w = works.find((x) => x.id === id) || works.find((x) => x.id === ui.lastWork) || works[0] || null;
  workId = w ? w.id : null;
  ui.lastWork = workId;
  saveUI();
  await loadClues();
  await loadSources();
  setUrl(push);
  renderAll();
}

/* ---------- 描画 ---------- */

function renderAll() {
  const w = curWork();
  $('#workSel').innerHTML = works.map((x) => `<option value="${esc(x.id)}">${esc(x.title || '無題')}</option>`).join('') || '<option value="">（作品がありません）</option>';
  $('#workSel').value = workId || '';
  document.title = w ? `${w.title} — 伏線管理` : '伏線管理';
  for (const id of ['#workSettings', '#exportJson']) $(id).disabled = !w;
  $('#toolbar').hidden = !w;
  $('#listWrap').hidden = !w;
  $('#empty').hidden = !!w;
  if (!w) {
    $('#emptyMsg').textContent = 'まだ作品がありません。';
    $('#emptyAction').textContent = '＋ 作品を作る';
    $('#emptyAction').onclick = () => openWorkDialog(null);
    return;
  }
  renderToolbar();
  renderList();
}

function renderToolbar() {
  const w = curWork();
  const v = fv();
  const count = (st) => clues.filter((c) => !st || c.status === st).length;
  $('#statusSeg').innerHTML = [['', 'すべて'], ...Object.entries(STATUSES)].map(([k, l]) =>
    `<button type="button" data-status="${k}" class="${v.status === k ? 'on' : ''}">${l}<span class="n">${count(k)}</span></button>`).join('');
  const opt = (val, label, cur) => `<option value="${esc(val)}"${val === cur ? ' selected' : ''}>${esc(label)}</option>`;
  $('#kindSel').innerHTML = opt('', '種類：すべて', v.kind) + Object.entries(KINDS).map(([k, l]) => opt(k, l, v.kind)).join('');
  if (v.part && !w.parts.some((p) => p.id === v.part)) v.part = '';
  $('#partSel').hidden = !w.parts.length;
  $('#partSel').innerHTML = opt('', '部：すべて', v.part) + w.parts.map((p) => opt(p.id, `${p.name}で見せた`, v.part)).join('');
  const names = uniq(clues.flatMap((c) => c.people));
  if (v.person && !names.includes(v.person)) v.person = '';
  $('#personSel').innerHTML = opt('', '人物：すべて', v.person) + names.map((n) => opt(n, n, v.person)).join('');
  const eps = episodeList();
  if (v.ep && !eps.includes(v.ep)) v.ep = '';
  $('#epSel').innerHTML = opt('', '話：すべて', v.ep) + eps.map((e) => {
    const n = clues.filter((c) => c.planted === e || c.payoffPlan === e || c.payoff === e).length;
    return opt(e, n ? `${e}（${n}）` : e, v.ep);
  }).join('');
  for (const [id, k] of [['#kindSel', 'kind'], ['#partSel', 'part'], ['#personSel', 'person'], ['#epSel', 'ep']]) $(id).classList.toggle('active', !!v[k]);
  if ($('#search').value !== v.q) $('#search').value = v.q;
  $('#search').classList.toggle('active', !!v.q);
  $('#clearFilter').hidden = !['status', 'kind', 'part', 'person', 'ep', 'q'].some((k) => v[k]);
}

function filtered() {
  const v = fv();
  const q = fold(v.q.trim());
  const eps = episodeList();
  return clues.filter((c) => {
    if (v.status && c.status !== v.status) return false;
    if (v.kind && c.kind !== v.kind) return false;
    if (v.part && !c.shownParts.includes(v.part)) return false;
    if (v.person && !c.people.includes(v.person)) return false;
    if (v.ep && c.planted !== v.ep && c.payoffPlan !== v.ep && c.payoff !== v.ep) return false;
    if (q && !fold([c.text, c.memo, ...c.people].join('\n')).includes(q)) return false;
    return true;
  }).sort((a, b) => (epRank(eps, a.planted) - epRank(eps, b.planted)) || natural(a.planted, b.planted) || (a.created - b.created));
}

function renderList() {
  const w = curWork();
  const v = fv();
  const list = filtered();
  const open = clues.filter((c) => c.status === 'open').length;
  $('#summary').innerHTML = clues.length
    ? `全${clues.length}件（未回収 <b>${open}</b>）${list.length !== clues.length ? `／表示中 <b>${list.length}</b>件` : ''}${v.ep ? `　「${esc(v.ep)}」で張る・回収するもの` : ''}`
    : '';
  if (!list.length) {
    $('#list').innerHTML = `<p class="empty-list">${clues.length ? '条件に合うものがありません。' : '「＋ 伏線・手がかり」から登録してください。'}</p>`;
    return;
  }
  const partName = (id) => (w.parts.find((p) => p.id === id) || {}).name;
  const epCell = (val, label, roleWord) => {
    const hit = v.ep && val === v.ep;
    return `<td class="ep${hit ? ' hit' : ''}" data-l="${label}">${hit ? `<span class="role">${roleWord}</span>` : ''}${esc(val)}</td>`;
  };
  let h = '<table class="ctable"><thead><tr><th>状態</th><th>種類</th><th>内容</th><th>張った話</th><th>読者に見せた部</th><th>回収予定</th><th>回収した話</th><th>関わる人物</th></tr></thead><tbody>';
  for (const c of list) {
    h += `<tr data-id="${esc(c.id)}" tabindex="0">
      <td><span class="badge ${c.status}">${STATUSES[c.status]}</span></td>
      <td><span class="badge ${c.kind}">${KINDS[c.kind]}</span></td>
      <td class="text"><div class="tx">${esc(c.text)}</div>${c.memo ? `<div class="memo">${esc(c.memo)}</div>` : ''}</td>
      ${epCell(c.planted, '張った話', 'この話で張る')}
      <td data-l="見せた部">${c.shownParts.length ? `<div class="chips">${c.shownParts.map(partName).filter(Boolean).map((n) => `<span class="chip-s">${esc(n)}</span>`).join('')}</div>` : ''}</td>
      ${epCell(c.payoffPlan, '回収予定', '回収予定')}
      ${epCell(c.payoff, '回収した話', 'この話で回収')}
      <td data-l="人物">${c.people.length ? `<div class="chips">${c.people.map((n) => `<span class="chip-s">${esc(n)}</span>`).join('')}</div>` : ''}</td>
    </tr>`;
  }
  $('#list').innerHTML = h + '</tbody></table>';
}

/* ---------- 絞り込み ---------- */

$('#workSel').addEventListener('change', (e) => openWork(e.target.value, true));
window.addEventListener('popstate', () => openWork(urlWorkId()));
function setFilter(k, val) {
  fv()[k] = val;
  saveUI();
  renderToolbar();
  renderList();
}
$('#statusSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-status]'); if (b) setFilter('status', b.dataset.status); });
$('#kindSel').addEventListener('change', (e) => setFilter('kind', e.target.value));
$('#partSel').addEventListener('change', (e) => setFilter('part', e.target.value));
$('#personSel').addEventListener('change', (e) => setFilter('person', e.target.value));
$('#epSel').addEventListener('change', (e) => setFilter('ep', e.target.value));
$('#search').addEventListener('input', (e) => { fv().q = e.target.value; saveUI(); $('#search').classList.toggle('active', !!e.target.value); $('#clearFilter').hidden = false; renderList(); });
$('#clearFilter').addEventListener('click', () => {
  const v = fv();
  for (const k of ['status', 'kind', 'part', 'person', 'ep', 'q']) v[k] = '';
  saveUI();
  renderToolbar();
  renderList();
});
$('#list').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openClue(clues.find((c) => c.id === tr.dataset.id));
});
$('#list').addEventListener('keydown', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openClue(clues.find((c) => c.id === tr.dataset.id)); }
});

/* ---------- 伏線・手がかりの入力 ---------- */

let editing = null; // { id, created, kind, status, people, parts:Set }
function openClue(c) {
  const w = curWork();
  const v = fv();
  const base = c || {
    text: '', kind: v.kind || 'foreshadow', status: v.status || 'open', planted: v.ep || '', payoffPlan: '', payoff: '',
    shownParts: v.part ? [v.part] : [], people: v.person ? [v.person] : [], memo: '',
  };
  editing = { id: c ? c.id : null, created: c ? c.created : 0, kind: base.kind, status: base.status, people: [...base.people], parts: new Set(base.shownParts) };
  $('#clueTitle').textContent = c ? '伏線・手がかりを編集' : '伏線・手がかりを追加';
  $('#cText').value = base.text;
  $('#cPlanted').value = base.planted;
  $('#cPlan').value = base.payoffPlan;
  $('#cPayoff').value = base.payoff;
  $('#cMemo').value = base.memo;
  $('#cPeopleIn').value = '';
  $('#clueDelete').hidden = !c;
  $('#epDl').innerHTML = episodeList().map((e) => `<option value="${esc(e)}"></option>`).join('');
  $('#peopleDl').innerHTML = peopleCandidates().map((n) => `<option value="${esc(n)}"></option>`).join('');
  $('#cParts').innerHTML = w.parts.length
    ? w.parts.map((p) => `<label><input type="checkbox" value="${esc(p.id)}"${editing.parts.has(p.id) ? ' checked' : ''}> ${esc(p.name)}</label>`).join('')
    : '<p class="note">部がありません。「作品の設定」で追加できます。</p>';
  renderRadios();
  renderPeopleChips();
  $('#clueDialog').showModal();
  if (!c) $('#cText').focus();
}
function renderRadios() {
  $('#cKind').innerHTML = Object.entries(KINDS).map(([k, l]) => `<button type="button" data-kind="${k}" class="${editing.kind === k ? 'on' : ''}">${l}</button>`).join('');
  $('#cStatus').innerHTML = Object.entries(STATUSES).map(([k, l]) => `<button type="button" data-st="${k}" class="${editing.status === k ? 'on' : ''}">${l}</button>`).join('');
}
$('#cKind').addEventListener('click', (e) => { const b = e.target.closest('[data-kind]'); if (b) { editing.kind = b.dataset.kind; renderRadios(); } });
$('#cStatus').addEventListener('click', (e) => { const b = e.target.closest('[data-st]'); if (b) { editing.status = b.dataset.st; editing.statusTouched = true; renderRadios(); } });
// 「回収した話」を入れたら回収済みに、消したら未回収に（状態を自分で選んでいないとき）
$('#cPayoff').addEventListener('input', (e) => {
  if (editing.statusTouched) return;
  const has = !!e.target.value.trim();
  if (has && editing.status === 'open') editing.status = 'done';
  else if (!has && editing.status === 'done') editing.status = 'open';
  renderRadios();
});
$('#cParts').addEventListener('change', (e) => {
  if (e.target.checked) editing.parts.add(e.target.value); else editing.parts.delete(e.target.value);
});

function renderPeopleChips() {
  $('#cPeopleChips').innerHTML = editing.people.map((p, i) => `<span class="chip">${esc(p)}<button type="button" data-i="${i}" aria-label="${esc(p)}を外す">✕</button></span>`).join('');
  $('#cPeopleSug').innerHTML = peopleCandidates().filter((p) => !editing.people.includes(p)).map((p) => `<button type="button">${esc(p)}</button>`).join('');
}
function addPeople(text) {
  for (const n of text.split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean)) if (!editing.people.includes(n)) editing.people.push(n);
  renderPeopleChips();
}
const pin = $('#cPeopleIn');
pin.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' || e.key === ',' || e.key === '、') {
    e.preventDefault();
    if (pin.value.trim()) { addPeople(pin.value); pin.value = ''; }
  } else if (e.key === 'Backspace' && !pin.value && editing.people.length) {
    editing.people.pop();
    renderPeopleChips();
  }
});
pin.addEventListener('input', (e) => {
  const v = pin.value;
  const picked = (!e.inputType || e.inputType === 'insertReplacementText') && peopleCandidates().includes(v.trim());
  if (/[、,，]/.test(v) || picked) { addPeople(v); pin.value = ''; }
});
pin.addEventListener('blur', () => { if (pin.value.trim()) { addPeople(pin.value); pin.value = ''; } });
$('#cPeopleChips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (b) { editing.people.splice(Number(b.dataset.i), 1); renderPeopleChips(); }
});
$('#cPeopleSug').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) addPeople(b.textContent); });
$('#cPeopleBox').addEventListener('click', (e) => { if (e.target === e.currentTarget) pin.focus(); });

$('#clueForm').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const text = $('#cText').value.replace(/\s+$/, '');
  if (!text.trim()) { $('#cText').reportValidity(); return; }
  if (pin.value.trim()) { addPeople(pin.value); pin.value = ''; }
  const w = curWork();
  const now = Date.now();
  const c = {
    id: editing.id || CDB.uid(), workId, text, kind: editing.kind, status: editing.status,
    planted: $('#cPlanted').value.trim(), payoffPlan: $('#cPlan').value.trim(), payoff: $('#cPayoff').value.trim(),
    shownParts: w.parts.map((p) => p.id).filter((id) => editing.parts.has(id)), people: [...editing.people],
    memo: $('#cMemo').value.replace(/\s+$/, ''), created: editing.created || now, updated: now,
  };
  try {
    await CDB.putClue(c);
    const i = clues.findIndex((x) => x.id === c.id);
    if (i >= 0) clues[i] = c; else clues.push(c);
    CDB.notify({ type: 'clues', workId });
    $('#clueDialog').close();
    renderToolbar();
    renderList();
  } catch (err) {
    console.error(err);
    alert('保存できませんでした：' + err.message);
  }
});
$('#clueDelete').addEventListener('click', async () => {
  if (!editing.id || !confirm('この伏線・手がかりを削除しますか？')) return;
  await CDB.deleteClue(editing.id);
  clues = clues.filter((c) => c.id !== editing.id);
  CDB.notify({ type: 'clues', workId });
  $('#clueDialog').close();
  renderToolbar();
  renderList();
});
$('#addClue').addEventListener('click', () => openClue(null));

/* ---------- 作品の設定 ---------- */

let wEdit = null; // { work, parts }
async function openWorkDialog(w) {
  await loadSources();
  wEdit = { work: w, parts: JSON.parse(JSON.stringify(w ? w.parts : [])) };
  $('#workTitle').textContent = w ? '作品の設定' : '新しい作品';
  $('#workName').value = w ? w.title : '';
  $('#workDelete').hidden = !w;
  const l = w ? w.links : {};
  const fill = (id, list, cur) => {
    $(id).innerHTML = '<option value="">（連動しない）</option>' + list.map((x) => `<option value="${esc(x.id)}">${esc(x.title || '無題')}</option>`).join('');
    $(id).value = list.some((x) => x.id === cur) ? cur : '';
  };
  fill('#linkPeople', src.peopleWorks, l.people);
  fill('#linkTimeline', src.timelineWorks, l.timeline);
  fill('#linkNovel', src.novelWorks, l.novel);
  renderPartRows();
  $('#workDialog').showModal();
  if (!w) $('#workName').focus();
}
// 新しい作品で名前を入れたら、同じ名前の作品をほかのツールから選んでおく
$('#workName').addEventListener('change', () => {
  if (wEdit.work) return;
  const name = $('#workName').value.trim();
  for (const [id, list] of [['#linkPeople', src.peopleWorks], ['#linkTimeline', src.timelineWorks], ['#linkNovel', src.novelWorks]]) {
    const m = list.find((x) => x.title === name);
    if (m && !$(id).value) $(id).value = m.id;
  }
});
function renderPartRows() {
  const ps = wEdit.parts;
  $('#partRows').innerHTML = ps.map((p, i) => `<div class="row" data-i="${i}">
    <input type="text" value="${esc(p.name)}" aria-label="部の名前" required>
    <button type="button" class="icon-btn" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="前へ">↑</button>
    <button type="button" class="icon-btn" data-act="down" ${i === ps.length - 1 ? 'disabled' : ''} aria-label="後ろへ">↓</button>
    <button type="button" class="icon-btn" data-act="del" aria-label="この部を削除">✕</button></div>`).join('') || '<p class="note">部がありません。</p>';
}
$('#partRows').addEventListener('input', (e) => {
  const row = e.target.closest('.row');
  if (row) wEdit.parts[Number(row.dataset.i)].name = e.target.value;
});
$('#partRows').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const i = Number(b.closest('.row').dataset.i);
  const ps = wEdit.parts;
  if (b.dataset.act === 'up' && i > 0) [ps[i - 1], ps[i]] = [ps[i], ps[i - 1]];
  else if (b.dataset.act === 'down' && i < ps.length - 1) [ps[i + 1], ps[i]] = [ps[i], ps[i + 1]];
  else if (b.dataset.act === 'del') {
    const n = wEdit.work ? clues.filter((c) => c.shownParts.includes(ps[i].id)).length : 0;
    if (n && !confirm(`「${ps[i].name}」を削除しますか？\n${n}件の「読者に見せた部」から外れます（保存したとき）。`)) return;
    ps.splice(i, 1);
  }
  renderPartRows();
});
$('#partAdd').addEventListener('click', () => {
  wEdit.parts.push({ id: CDB.uid(), name: `第${wEdit.parts.length + 1}部` });
  renderPartRows();
  const inp = $('#partRows .row:last-child input');
  if (inp) inp.select();
});
function importTimelineParts() {
  const t = src.timelineWorks.find((x) => x.id === $('#linkTimeline').value);
  if (!t) return 0;
  let n = 0;
  for (const p of t.parts || []) if (p.name && !wEdit.parts.some((x) => x.name === p.name)) { wEdit.parts.push({ id: CDB.uid() + n, name: p.name }); n++; }
  renderPartRows();
  return n;
}
$('#partFromTimeline').addEventListener('click', () => {
  if (!$('#linkTimeline').value) { alert('先に「年表」を選んでください。'); return; }
  if (!importTimelineParts()) alert('新しく足す部はありませんでした。');
});
$('#newWork').addEventListener('click', () => openWorkDialog(null));
$('#workSettings').addEventListener('click', () => openWorkDialog(curWork()));
$('#workForm').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  if (!$('#workForm').reportValidity()) return;
  // 年表を選んで部がまだないときは、年表の部をそのまま使う
  if (!wEdit.parts.length && $('#linkTimeline').value) importTimelineParts();
  const parts = wEdit.parts.map((p) => ({ id: p.id, name: p.name.trim() || '部' }));
  const links = { people: $('#linkPeople').value || null, timeline: $('#linkTimeline').value || null, novel: $('#linkNovel').value || null };
  const old = wEdit.work;
  const w = old
    ? { ...old, title: $('#workName').value.trim(), parts, links }
    : { id: CDB.uid(), title: $('#workName').value.trim(), parts, links, order: works.reduce((m, x) => Math.max(m, x.order), -1) + 1, created: Date.now() };
  try {
    await CDB.putWork(w);
    if (old) {
      const gone = old.parts.map((p) => p.id).filter((id) => !parts.some((p) => p.id === id));
      if (gone.length) await CDB.removeParts(w.id, gone);
    }
    CDB.notify({ type: 'works' });
    $('#workDialog').close();
    await loadWorks();
    await openWork(w.id, !old);
  } catch (err) {
    console.error(err);
    alert('保存できませんでした：' + err.message);
  }
});
$('#workDelete').addEventListener('click', async () => {
  const w = wEdit.work;
  if (!w || !confirm(`作品「${w.title}」の伏線・手がかり${clues.length}件をすべて削除しますか？\n（元に戻せません。必要なら先に書き出してください）`)) return;
  await CDB.deleteWork(w.id);
  delete ui.byWork[w.id];
  CDB.notify({ type: 'works' });
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
  const title = (list, id) => (list.find((x) => x.id === id) || {}).title || undefined;
  const partName = (id) => (w.parts.find((p) => p.id === id) || {}).name;
  const eps = episodeList();
  return {
    format: 'noveltool-clues',
    version: 1,
    work: {
      id: w.id, title: w.title,
      peopleTitle: title(src.peopleWorks, w.links.people), timelineTitle: title(src.timelineWorks, w.links.timeline), novelTitle: title(src.novelWorks, w.links.novel),
    },
    parts: w.parts.map((p) => p.name),
    clues: [...clues].sort((a, b) => (epRank(eps, a.planted) - epRank(eps, b.planted)) || natural(a.planted, b.planted) || (a.created - b.created)).map((c) => {
      const o = { text: c.text, kind: KINDS[c.kind], status: STATUSES[c.status] };
      if (c.planted) o.planted = c.planted;
      const sp = c.shownParts.map(partName).filter(Boolean);
      if (sp.length) o.shownParts = sp;
      if (c.payoffPlan) o.payoffPlan = c.payoffPlan;
      if (c.payoff) o.payoff = c.payoff;
      if (c.people.length) o.people = c.people;
      if (c.memo) o.memo = c.memo;
      return o;
    }),
  };
}
$('#exportJson').addEventListener('click', () => {
  const w = curWork();
  const blob = new Blob([JSON.stringify(exportData(), null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safeName(w.title)}_伏線.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

function keyOf(map, v, def) {
  const s = String(v == null ? '' : v).trim();
  if (map[s]) return s;
  const hit = Object.entries(map).find(([, l]) => l === s);
  return hit ? hit[0] : def;
}
function parseImport(text) {
  let d;
  try { d = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error('JSONとして読めません（' + e.message + '）'); }
  if (!d || typeof d !== 'object' || !Array.isArray(d.clues)) throw new Error('「clues」（伏線の一覧）がありません（READMEの「伏線管理のJSON」を参照）。');
  const str = (v) => (v == null ? '' : String(v));
  const parts = [];
  const partId = (name) => {
    const n = str(name).trim();
    if (!n) return null;
    let p = parts.find((x) => x.name === n || x.id === n);
    if (!p) { p = { id: CDB.uid() + parts.length.toString(36), name: n }; parts.push(p); }
    return p.id;
  };
  for (const p of Array.isArray(d.parts) ? d.parts : []) partId(typeof p === 'object' && p ? p.name : p);
  const list = [];
  for (const c of d.clues) {
    if (!c || typeof c !== 'object' || !str(c.text).trim()) continue;
    const payoff = str(c.payoff).trim();
    list.push({
      text: str(c.text).replace(/\s+$/, ''),
      kind: keyOf(KINDS, c.kind, 'foreshadow'),
      status: keyOf(STATUSES, c.status, payoff ? 'done' : 'open'),
      planted: str(c.planted).trim(), payoffPlan: str(c.payoffPlan).trim(), payoff,
      shownParts: uniq((Array.isArray(c.shownParts) ? c.shownParts : c.shownParts ? str(c.shownParts).split(/[、,，]/) : []).map(partId)),
      people: uniq((Array.isArray(c.people) ? c.people : c.people ? str(c.people).split(/[、,，]/) : []).map((x) => str(x).trim())),
      memo: str(c.memo).replace(/\s+$/, ''),
    });
  }
  const w = d.work || {};
  return {
    work: { id: w.id ? str(w.id) : '', title: str(w.title || '読み込んだ伏線'), parts, links: {} },
    titles: { people: w.peopleTitle, timeline: w.timelineTitle, novel: w.novelTitle },
    clues: list,
  };
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
  await loadSources();
  // 連動先は、ほかのツールの作品名で探す
  const find = (list, t) => (t ? (list.find((x) => x.title === t) || {}).id || null : null);
  data.work.links = { people: find(src.peopleWorks, data.titles.people), timeline: find(src.timelineWorks, data.titles.timeline), novel: find(src.novelWorks, data.titles.novel) };
  const existing = data.work.id ? works.find((w) => w.id === data.work.id) : null;
  if (existing && existing.links) for (const k of ['people', 'timeline', 'novel']) if (!data.work.links[k]) data.work.links[k] = existing.links[k] || null;
  const dlg = $('#importDialog');
  $('#importMsg').textContent = `「${data.work.title}」（伏線・手がかり${data.clues.length}件）を読み込みます。` + (existing ? `同じ作品「${existing.title}」がすでにあります。` : '');
  $('#importReplace').hidden = !existing;
  $('#importAdd').textContent = existing ? '別の作品として追加' : '読み込む';
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    const mode = dlg.returnValue;
    if (mode !== 'add' && mode !== 'replace') return;
    try {
      const w = await CDB.importWork(data, mode === 'replace');
      CDB.notify({ type: 'works' });
      await loadWorks();
      await openWork(w.id, true);
    } catch (err) {
      console.error(err);
      alert('読み込めませんでした：' + err.message);
    }
  }, { once: true });
});

/* ---------- 別タブの変更を反映 ---------- */

CDB.onMessage(async (msg) => {
  if (document.querySelector('dialog[open]')) return;
  if (msg.type === 'works') {
    await loadWorks();
    if (!works.some((w) => w.id === workId)) { await openWork(null); return; }
    await loadClues();
    await loadSources();
    renderAll();
  } else if (msg.workId === workId) {
    await loadClues();
    renderToolbar();
    renderList();
  }
});
// ほかのツールで人物や話を変えたあと戻ってきたとき
window.addEventListener('focus', async () => {
  if (!curWork() || document.querySelector('dialog[open]')) return;
  await loadSources();
  renderToolbar();
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
