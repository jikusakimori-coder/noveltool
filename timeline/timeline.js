'use strict';

/* =========================================================
   年表ツール
   執筆ツールとは別のデータベース（noveltool-timeline）に保存します。
   ========================================================= */

const TDB = (() => {
  const NAME = 'noveltool-timeline';
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
          db.createObjectStore('events', { keyPath: 'id' }).createIndex('workId', 'workId');
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
    return run(['works', 'events'], 'readwrite', async (s) => {
      s.works.delete(id);
      for (const k of await req(s.events.index('workId').getAllKeys(id))) s.events.delete(k);
    });
  }
  function events(workId) { return run('events', 'readonly', (s) => req(s.events.index('workId').getAll(workId))); }
  function putEvent(ev) { return run('events', 'readwrite', (s) => { s.events.put(ev); }); }
  function deleteEvent(id) { return run('events', 'readwrite', (s) => { s.events.delete(id); }); }
  // 部を消したとき、できごとからその部を外す
  function removePartFromEvents(workId, partIds) {
    return run('events', 'readwrite', async (s) => {
      for (const ev of await req(s.events.index('workId').getAll(workId))) {
        const parts = ev.parts.filter((p) => !partIds.includes(p));
        const notes = { ...ev.partNotes };
        partIds.forEach((p) => delete notes[p]);
        if (parts.length !== ev.parts.length || Object.keys(notes).length !== Object.keys(ev.partNotes || {}).length) {
          s.events.put({ ...ev, parts, partNotes: notes });
        }
      }
    });
  }
  // data: { work, events }。replace=true なら同じIDの年表を置き換える
  function importWork(data, replace) {
    const now = Date.now();
    return run(['works', 'events'], 'readwrite', async (s) => {
      const all = await req(s.works.getAll());
      const existing = data.work.id ? all.find((w) => w.id === data.work.id) : null;
      let work;
      if (existing && replace) {
        for (const k of await req(s.events.index('workId').getAllKeys(existing.id))) s.events.delete(k);
        work = { ...existing, ...data.work, id: existing.id, order: existing.order, created: existing.created };
      } else {
        const id = data.work.id && !existing ? data.work.id : uid();
        work = { ...data.work, id, order: all.reduce((m, w) => Math.max(m, w.order), -1) + 1, created: now };
      }
      s.works.put(work);
      data.events.forEach((e, i) => {
        s.events.put({ ...e, id: existing && replace && e.id ? e.id : uid(), workId: work.id, created: now + i });
      });
      return work;
    });
  }

  const TAB = uid();
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('noveltool-timeline') : null;
  let listener = null;
  if (channel) channel.onmessage = (e) => { if (e.data && e.data.from !== TAB && listener) listener(e.data); };
  function notify(msg) { if (channel) channel.postMessage({ ...msg, from: TAB }); }
  function onMessage(fn) { listener = fn; }

  return { uid, works, putWork, deleteWork, events, putEvent, deleteEvent, removePartFromEvents, importWork, notify, onMessage };
})();

/* ---------- 共通の小物 ---------- */

const $ = (s) => document.querySelector(s);
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const PART_COLORS = ['#c0504d', '#4f81bd', '#6a9a3a', '#8064a2', '#e08a2e', '#3a9bb0', '#b5559a', '#7a7a3a'];
const DATE_RE = /^\d{4,}-\d{2}-\d{2}$/;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function wdIndex(d) {
  if (!DATE_RE.test(d || '')) return -1;
  const [y, m, dd] = d.split('-').map(Number);
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, dd);
  return t.getUTCDay();
}
function wdOf(d) { const i = wdIndex(d); return i < 0 ? '' : WD[i]; }
function fmtDate(d) { return d ? `${d.replace(/-/g, '/')}（${wdOf(d)}）` : ''; }
function fmtDateHtml(d) {
  const i = wdIndex(d);
  const [y, m, dd] = d.split('-');
  return `<span class="yr">${esc(y)}/</span>${esc(m)}/${esc(dd)}<span class="wd-${i}">（${WD[i] || ''}）</span>`;
}
function normTime(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '');
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}
function cmpEv(a, b) {
  return a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || ((a.created || 0) - (b.created || 0));
}
function uniq(list) { return [...new Set(list.filter(Boolean))]; }
function setWd(elm, d) {
  const i = wdIndex(d);
  elm.textContent = i < 0 ? '' : `（${WD[i]}）`;
  elm.className = `wd wd-${i}`;
}

/* ---------- 状態 ---------- */

let works = [];
let workId = null;
let events = [];
const UI_KEY = 'noveltool.timeline.ui.v1';
let ui = { lastWork: null, byWork: {} };
try { ui = { ...ui, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') }; } catch (e) { /* noop */ }
function saveUI() { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* noop */ } }
function view() {
  if (!ui.byWork[workId]) ui.byWork[workId] = {};
  const v = ui.byWork[workId];
  v.layout = v.layout === 'people' ? 'people' : 'parts';
  if (!Array.isArray(v.people)) v.people = [];
  if (typeof v.place !== 'string') v.place = '';
  const w = curWork();
  if (!w || !w.parts.some((p) => p.id === v.part)) v.part = '';
  return v;
}

function curWork() { return works.find((w) => w.id === workId) || null; }
function partOf(w, id) { return w.parts.find((p) => p.id === id) || null; }

// 起点より前なら 'common'、起点以降なら 'route'
function sideOf(w, date, time) {
  if (!w.origin || date < w.origin) return 'common';
  if (date > w.origin) return 'route';
  if (w.originTime && time && time < w.originTime) return 'common';
  return 'route';
}
function inPeriod(p, date) {
  if (!p.from && !p.to) return false;
  return (!p.from || date >= p.from) && (!p.to || date <= p.to);
}
function allPeople() { return uniq(events.flatMap((e) => e.people || [])); }
function allPlaces() { return uniq(events.map((e) => e.place)).sort((a, b) => a.localeCompare(b, 'ja')); }
function allEpisodes() { return uniq(events.map((e) => e.episode)).sort((a, b) => a.localeCompare(b, 'ja', { numeric: true })); }

function normEvent(e) {
  return {
    id: e.id, workId: e.workId,
    date: e.date || '', time: normTime(e.time),
    text: e.text || '', people: Array.isArray(e.people) ? e.people : [],
    place: e.place || '', episode: e.episode || '', memo: e.memo || '',
    parts: Array.isArray(e.parts) ? e.parts : [], partNotes: e.partNotes || {},
    created: e.created || 0, updated: e.updated || 0,
  };
}

/* ---------- 読み込みと切り替え ---------- */

function urlWorkId() { return new URLSearchParams(location.search).get('work'); }
function setUrl(id, push) {
  const u = new URL(location.href);
  if (id) u.searchParams.set('work', id); else u.searchParams.delete('work');
  if (u.href !== location.href) history[push ? 'pushState' : 'replaceState'](null, '', u.href);
}

async function loadWorks() {
  works = (await TDB.works()).map((w) => ({ ...w, parts: Array.isArray(w.parts) ? w.parts : [] }));
}
async function openWork(id, push) {
  const w = works.find((x) => x.id === id) || works.find((x) => x.id === ui.lastWork) || works[0] || null;
  workId = w ? w.id : null;
  events = w ? (await TDB.events(w.id)).map(normEvent) : [];
  ui.lastWork = workId;
  saveUI();
  setUrl(workId, push);
  renderAll();
}
async function reloadEvents() {
  if (!workId) return;
  events = (await TDB.events(workId)).map(normEvent);
}

/* ---------- 描画 ---------- */

const el = {
  workSel: $('#workSel'), partSeg: $('#partSeg'), grid: $('#gridWrap'), empty: $('#empty'),
  emptyMsg: $('#emptyMsg'), emptyAction: $('#emptyAction'), toolbar: $('#toolbar'),
  peopleList: $('#peopleList'), peopleSum: $('#peopleSum'), placeSel: $('#placeSel'),
};

function renderAll() {
  const w = curWork();
  el.workSel.innerHTML = works.map((x) => `<option value="${esc(x.id)}">${esc(x.title || '無題')}</option>`).join('') ||
    '<option value="">（年表がありません）</option>';
  el.workSel.value = workId || '';
  document.title = w ? `${w.title} — 年表` : '年表ツール';
  for (const id of ['#settingsBtn', '#exportMd', '#exportCsv']) $(id).disabled = !w;
  el.toolbar.hidden = !w;
  if (!w) {
    el.grid.hidden = true;
    el.empty.hidden = false;
    el.emptyMsg.textContent = 'まだ年表がありません。';
    el.emptyAction.textContent = '＋ 新しい年表を作る';
    el.emptyAction.onclick = () => openSettings(null);
    return;
  }
  renderToolbar();
  renderGrid();
}

function renderToolbar() {
  const w = curWork();
  const v = view();
  el.partSeg.innerHTML = `<button type="button" data-part="" class="${v.part ? '' : 'on'}">全体</button>` +
    w.parts.map((p) => `<button type="button" data-part="${esc(p.id)}" class="${v.part === p.id ? 'on' : ''}" title="${esc(p.name)}で描写するできごと＋${esc(p.name)}のルート"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</button>`).join('');
  document.querySelectorAll('[data-layout]').forEach((b) => b.classList.toggle('on', b.dataset.layout === v.layout));

  const people = allPeople();
  v.people = v.people.filter((p) => people.includes(p));
  el.peopleList.innerHTML = people.length
    ? people.map((p) => `<label><input type="checkbox" value="${esc(p)}"${v.people.includes(p) ? ' checked' : ''}> ${esc(p)}</label>`).join('')
    : '<p class="note">まだ人物が登録されていません。</p>';
  el.peopleSum.textContent = v.people.length ? `人物：${v.people.join('、')}` : '人物：すべて';
  el.peopleSum.classList.toggle('active', v.people.length > 0);

  const places = allPlaces();
  if (v.place && !places.includes(v.place)) v.place = '';
  el.placeSel.innerHTML = '<option value="">場所：すべて</option>' + places.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  el.placeSel.value = v.place;
  el.placeSel.classList.toggle('active', !!v.place);
}

function cardHtml(ev, w, opt) {
  const side = sideOf(w, ev.date, ev.time);
  const color = opt.color || (ev.parts.length === 1 && partOf(w, ev.parts[0]) ? partOf(w, ev.parts[0]).color : '');
  let h = `<div class="ev" role="button" tabindex="0" data-id="${esc(ev.id)}"${color ? ` style="--evc:${esc(color)}"` : ''}>`;
  h += `<div class="tt">${opt.showTime && ev.time ? `<span class="tm">${esc(ev.time)}</span>` : ''}${esc(ev.text)}</div>`;
  const meta = [];
  const people = opt.hidePerson ? ev.people.filter((p) => p !== opt.hidePerson) : ev.people;
  people.forEach((p) => meta.push(`<span class="person">${esc(p)}</span>`));
  if (ev.place) meta.push(`<span>📍${esc(ev.place)}</span>`);
  if (ev.episode) meta.push(`<span>📖${esc(ev.episode)}</span>`);
  if (meta.length) h += `<div class="meta">${meta.join('')}</div>`;
  if (opt.marks) {
    const marks = ev.parts.map((id) => partOf(w, id)).filter(Boolean)
      .filter((p) => !opt.skipMark || p.id !== opt.skipMark)
      .map((p) => `<span class="mark${side === 'route' ? ' route' : ''}" style="--c:${esc(p.color)}" title="${side === 'route' ? `${esc(p.name)}のルート` : `${esc(p.name)}で描写`}">${side === 'route' ? '' : '描写：'}${esc(p.name)}</span>`);
    if (!ev.parts.length && opt.marks !== 'others') marks.push(`<span class="mark none">${side === 'route' ? 'ルート未選択' : '描写する部なし'}</span>`);
    if (marks.length) h += `<div class="marks">${opt.marks === 'others' ? '<span class="mark none">ほかに</span>' : ''}${marks.join('')}</div>`;
  }
  const notes = opt.notePart ? [opt.notePart] : ev.parts;
  for (const pid of notes) {
    const note = ev.partNotes[pid];
    const p = partOf(w, pid);
    if (note && p) h += `<div class="pnote" style="--c:${esc(p.color)}"><b>${esc(p.name)}：</b>${esc(note)}</div>`;
  }
  if (ev.memo) h += `<div class="memo">${esc(ev.memo)}</div>`;
  return h + '</div>';
}

function filteredEvents(w, v) {
  return events.filter((ev) => {
    if (v.part && !ev.parts.includes(v.part)) return false;
    if (v.place && ev.place !== v.place) return false;
    if (v.people.length && !ev.people.some((p) => v.people.includes(p))) return false;
    return true;
  }).sort(cmpEv);
}

function renderGrid() {
  const w = curWork();
  const v = view();
  el.empty.hidden = true;
  el.grid.hidden = false;
  const evs = filteredEvents(w, v);
  const viewParts = v.part ? [partOf(w, v.part)] : w.parts;

  // 行：日付＋時刻ごと。部の期間の始まり・終わりの日にも行を作る
  const rows = new Map();
  const rowOf = (date, time) => {
    const k = `${date}|${time}`;
    if (!rows.has(k)) rows.set(k, { date, time, side: sideOf(w, date, time), events: [] });
    return rows.get(k);
  };
  evs.forEach((ev) => rowOf(ev.date, ev.time).events.push(ev));
  const filtering = v.people.length || v.place;
  const starts = new Map();
  const ends = new Map();
  for (const p of viewParts) {
    if (p.from) { (starts.get(p.from) || starts.set(p.from, []).get(p.from)).push(p); }
    if (p.to) { (ends.get(p.to) || ends.set(p.to, []).get(p.to)).push(p); }
  }
  if (!filtering) {
    for (const d of [...starts.keys(), ...ends.keys()]) {
      if (![...rows.values()].some((r) => r.date === d)) rowOf(d, '');
    }
  }
  const list = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  // 列
  let cols;
  if (v.layout === 'people') {
    const names = v.people.length ? v.people : allPeople().filter((p) => evs.some((e) => e.people.includes(p)));
    cols = names.map((n) => ({ kind: 'person', name: n }));
    if (!cols.length) cols = [{ kind: 'nobody' }];
  } else if (v.part) {
    cols = [{ kind: 'part', part: partOf(w, v.part) }];
  } else {
    cols = w.parts.map((p) => ({ kind: 'part', part: p }));
    if (!cols.length || evs.some((e) => e.parts.length === 0 && sideOf(w, e.date, e.time) === 'route')) cols.push({ kind: 'none' });
  }
  const wideCommon = v.layout === 'parts' && !v.part;
  const bandW = Math.max(12, w.parts.length * 8 + 6);
  const bandStyle = `width:${bandW}px;min-width:${bandW}px;max-width:${bandW}px`;

  const bandsHtml = (date, head) => `<div class="bands">${w.parts.map((p) => {
    if (head) return `<span class="band" style="--c:${esc(p.color)}" title="${esc(p.name)}"></span>`;
    const on = inPeriod(p, date);
    const cls = on ? ` on${p.from === date ? ' start' : ''}${p.to === date ? ' end' : ''}` : '';
    return `<span class="band${cls}" style="--c:${esc(p.color)}"${on ? ` title="${esc(p.name)}（${esc(fmtDate(p.from) || '…')}〜${esc(fmtDate(p.to) || '…')}）"` : ''}></span>`;
  }).join('')}</div>`;

  const colHead = (c) => {
    if (c.kind === 'part') {
      const p = c.part;
      const period = p.from || p.to ? `<span class="sub">${esc(fmtDate(p.from) || '…')}〜${esc(fmtDate(p.to) || '…')}</span>` : '';
      return `<th class="col"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}${v.part ? '<span class="sub">で描写するできごと＋ルート</span>' : ''}${period}</th>`;
    }
    if (c.kind === 'person') return `<th class="col">${esc(c.name)}</th>`;
    if (c.kind === 'nobody') return '<th class="col">（人物が登録されたできごとがありません）</th>';
    return `<th class="col">${w.parts.length ? '（ルート未選択）' : 'できごと'}</th>`;
  };

  let h = `<table class="grid" style="--bw:${bandW}px"><thead><tr><th class="c-date">日付</th><th class="c-time">時刻</th><th class="c-band" style="${bandStyle}">${bandsHtml('', true)}</th>${cols.map(colHead).join('')}</tr></thead><tbody>`;

  const originRow = () => {
    const routes = wideCommon ? '各部のルートに分かれます' : (v.part ? `${esc(partOf(w, v.part).name)}のルート` : 'ここから部ごとのルート');
    return `<tr class="origin"><td class="origin-left" colspan="3">▼ 起点</td><td colspan="${cols.length}">${esc(fmtDate(w.origin))}${w.originTime ? ` ${esc(w.originTime)}` : ''}<span class="sub">${routes}</span></td></tr>`;
  };
  let originDone = false;
  list.forEach((r, i) => {
    if (!originDone && r.side === 'route') { h += originRow(); originDone = true; }
    const prev = list[i - 1];
    const next = list[i + 1];
    const same = prev && prev.date === r.date && prev.side === r.side;
    const nextSame = next && next.date === r.date && next.side === r.side;
    const tags = !same ? [
      ...(starts.get(r.date) || []).map((p) => `<span class="ptag" style="--c:${esc(p.color)}">${esc(p.name)} ここから</span>`),
      ...(ends.get(r.date) || []).map((p) => `<span class="ptag" style="--c:${esc(p.color)}">${esc(p.name)} ここまで</span>`),
    ].join('') : '';
    const cls = [r.side === 'common' ? 'common' : 'route', same ? 'same-day' : '', nextSame ? 'next-same-day' : '', r.events.length ? '' : 'marker'].filter(Boolean).join(' ');
    h += `<tr class="${cls}"><td class="c-date"><div class="d">${fmtDateHtml(r.date)}</div>${tags ? `<div class="period-tags">${tags}</div>` : ''}</td>`;
    h += `<td class="c-time">${esc(r.time)}</td><td class="c-band" style="${bandStyle}">${bandsHtml(r.date)}</td>`;
    const attrs = (extra) => `data-date="${esc(r.date)}" data-time="${esc(r.time)}"${extra}`;
    if (r.side === 'common' && wideCommon) {
      h += `<td class="col wide" colspan="${cols.length}" ${attrs('')}>${r.events.map((ev) => cardHtml(ev, w, { marks: true })).join('')}</td>`;
    } else {
      for (const c of cols) {
        let cell = [];
        let opt = {};
        if (c.kind === 'person') {
          cell = r.events.filter((e) => e.people.includes(c.name));
          opt = { marks: true, notePart: v.part || null, hidePerson: c.name };
        } else if (c.kind === 'part') {
          cell = r.events.filter((e) => e.parts.includes(c.part.id));
          opt = { marks: v.part ? false : 'others', skipMark: c.part.id, notePart: c.part.id, color: c.part.color };
          if (!v.part && cell.length) {
            // 複数のルートにまたがるできごとだけ、ほかの部を表示する
            h += `<td class="col" ${attrs(` data-part="${esc(c.part.id)}"`)}>${cell.map((ev) => cardHtml(ev, w, ev.parts.length > 1 ? opt : { ...opt, marks: false })).join('')}</td>`;
            continue;
          }
        } else if (c.kind === 'none') {
          cell = r.events.filter((e) => e.parts.length === 0);
          opt = { marks: false };
        }
        const extra = c.kind === 'part' ? ` data-part="${esc(c.part.id)}"` : c.kind === 'person' ? ` data-person="${esc(c.name)}"` : '';
        h += `<td class="col" ${attrs(extra)}>${cell.map((ev) => cardHtml(ev, w, opt)).join('')}</td>`;
      }
    }
    h += '</tr>';
  });
  if (!originDone) h += originRow();
  h += '</tbody></table>';
  if (!evs.length) {
    h += `<p class="note" style="padding:12px">${events.length ? '条件に合うできごとがありません。' : '「＋ できごと」から登録してください。'}</p>`;
  }
  const sx = el.grid.scrollLeft;
  const sy = el.grid.scrollTop;
  el.grid.innerHTML = h;
  el.grid.scrollLeft = sx;
  el.grid.scrollTop = sy;
}

/* ---------- 操作：上部 ---------- */

el.workSel.addEventListener('change', () => openWork(el.workSel.value, true));
window.addEventListener('popstate', () => openWork(urlWorkId()));
$('#newWork').addEventListener('click', () => openSettings(null));
$('#settingsBtn').addEventListener('click', () => openSettings(curWork()));

el.partSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-part]');
  if (!b) return;
  view().part = b.dataset.part;
  saveUI();
  renderToolbar();
  renderGrid();
});
document.querySelectorAll('[data-layout]').forEach((b) => b.addEventListener('click', () => {
  view().layout = b.dataset.layout;
  saveUI();
  renderToolbar();
  renderGrid();
}));
el.peopleList.addEventListener('change', () => {
  view().people = [...el.peopleList.querySelectorAll('input:checked')].map((i) => i.value);
  saveUI();
  renderToolbar();
  renderGrid();
});
$('#peopleClear').addEventListener('click', () => {
  view().people = [];
  saveUI();
  $('#peopleFilter').open = false;
  renderToolbar();
  renderGrid();
});
document.addEventListener('click', (e) => {
  const d = $('#peopleFilter');
  if (d.open && !d.contains(e.target)) d.open = false;
});
el.placeSel.addEventListener('change', () => {
  view().place = el.placeSel.value;
  saveUI();
  renderToolbar();
  renderGrid();
});
$('#addEvent').addEventListener('click', () => {
  const v = view();
  openEvent(null, { parts: v.part ? [v.part] : [], people: v.people.length === 1 ? [...v.people] : [], place: v.place });
});

el.grid.addEventListener('click', (e) => {
  const card = e.target.closest('.ev');
  if (card) openEvent(events.find((x) => x.id === card.dataset.id));
});
el.grid.addEventListener('keydown', (e) => {
  const card = e.target.closest('.ev');
  if (card && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openEvent(events.find((x) => x.id === card.dataset.id));
  }
});
// 空いているところをダブルクリックすると、その日時（と部・人物）で新しいできごと
el.grid.addEventListener('dblclick', (e) => {
  if (e.target.closest('.ev')) return;
  const td = e.target.closest('td.col');
  if (!td) return;
  const v = view();
  const parts = td.dataset.part ? [td.dataset.part] : (v.part ? [v.part] : []);
  const people = td.dataset.person ? [td.dataset.person] : [];
  openEvent(null, { date: td.dataset.date, time: td.dataset.time, parts, people, place: v.place });
});

/* ---------- できごとの入力 ---------- */

const evd = {
  dlg: $('#evDialog'), form: $('#evForm'), title: $('#evTitle'), date: $('#evDate'), wd: $('#evWd'), time: $('#evTime'),
  text: $('#evText'), chips: $('#evPeopleChips'), pin: $('#evPeopleIn'), sug: $('#evPeopleSug'),
  place: $('#evPlace'), episode: $('#evEpisode'), memo: $('#evMemo'), parts: $('#evParts'),
  partsLbl: $('#evPartsLbl'), sideNote: $('#evSideNote'), del: $('#evDelete'), dup: $('#evDup'),
};
let editing = null; // { id, people: [], parts: Set, notes: {} }

function fillDatalists() {
  const opts = (list) => list.map((x) => `<option value="${esc(x)}"></option>`).join('');
  $('#peopleDl').innerHTML = opts(allPeople());
  $('#placeDl').innerHTML = opts(allPlaces());
  $('#episodeDl').innerHTML = opts(allEpisodes());
}

function openEvent(ev, preset = {}) {
  const w = curWork();
  if (!w) return;
  const src = ev || {
    date: preset.date || lastDate || w.origin || '', time: preset.time || '', text: '',
    people: preset.people || [], place: preset.place || '', episode: '', memo: '', parts: preset.parts || [], partNotes: {},
  };
  editing = { id: ev ? ev.id : null, created: ev ? ev.created : 0, people: [...src.people], parts: new Set(src.parts), notes: { ...src.partNotes } };
  evd.title.textContent = ev ? 'できごとを編集' : 'できごとを追加';
  evd.date.value = src.date;
  evd.time.value = src.time;
  evd.text.value = src.text;
  evd.place.value = src.place;
  evd.episode.value = src.episode;
  evd.memo.value = src.memo;
  evd.pin.value = '';
  evd.del.hidden = !ev;
  evd.dup.hidden = !ev;
  fillDatalists();
  renderPeopleChips();
  renderPartChecks();
  evd.dlg.showModal();
  if (!ev) evd.text.focus();
}

function renderPeopleChips() {
  evd.chips.innerHTML = editing.people.map((p, i) => `<span class="chip">${esc(p)}<button type="button" data-i="${i}" aria-label="${esc(p)}を外す">✕</button></span>`).join('');
  const rest = allPeople().filter((p) => !editing.people.includes(p));
  evd.sug.innerHTML = rest.map((p) => `<button type="button">${esc(p)}</button>`).join('');
}
function addPeople(text) {
  const names = text.split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean);
  for (const n of names) if (!editing.people.includes(n)) editing.people.push(n);
  renderPeopleChips();
}
evd.pin.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' || e.key === ',' || e.key === '、') {
    e.preventDefault();
    if (evd.pin.value.trim()) { addPeople(evd.pin.value); evd.pin.value = ''; }
  } else if (e.key === 'Backspace' && !evd.pin.value && editing.people.length) {
    editing.people.pop();
    renderPeopleChips();
  }
});
// 「、」を入力したときや、候補リストから選んだときに追加する
evd.pin.addEventListener('input', (e) => {
  const v = evd.pin.value;
  const picked = (!e.inputType || e.inputType === 'insertReplacementText') && allPeople().includes(v.trim());
  if (/[、,，]/.test(v) || picked) {
    addPeople(v);
    evd.pin.value = '';
  }
});
evd.pin.addEventListener('blur', () => { if (evd.pin.value.trim()) { addPeople(evd.pin.value); evd.pin.value = ''; } });
evd.chips.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  editing.people.splice(Number(b.dataset.i), 1);
  renderPeopleChips();
});
evd.sug.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  addPeople(b.textContent);
});
$('#evPeopleBox').addEventListener('click', (e) => { if (e.target === e.currentTarget) evd.pin.focus(); });

function renderPartChecks() {
  const w = curWork();
  setWd(evd.wd, evd.date.value);
  const date = evd.date.value;
  const side = date ? sideOf(w, date, normTime(evd.time.value)) : null;
  evd.partsLbl.textContent = side === 'route' ? 'どの部のルートか（複数可）' : side === 'common' ? '描写する部（複数可）' : '部';
  evd.sideNote.textContent = !date ? '日付を入れると、共通のできごとか、部ごとのルートかが決まります。'
    : side === 'common' ? `起点（${fmtDate(w.origin)}${w.originTime ? ' ' + w.originTime : ''}）より前なので、全部に共通のできごとです。どの部で描写するかを選んでください。部ごとに違う点は補足に書けます。`
      : `起点（${fmtDate(w.origin)}${w.originTime ? ' ' + w.originTime : ''}）以降なので、部ごとのルートのできごとです。どの部のルートか選んでください。`;
  if (!w.parts.length) {
    evd.parts.innerHTML = '<p class="note">部がありません。「設定」から追加してください。</p>';
    return;
  }
  evd.parts.innerHTML = w.parts.map((p) => {
    const on = editing.parts.has(p.id);
    const period = p.from || p.to ? `<span class="period">${esc(fmtDate(p.from) || '…')}〜${esc(fmtDate(p.to) || '…')}${date && inPeriod(p, date) ? '（この日を含む）' : ''}</span>` : '';
    return `<div class="pc${on ? ' on' : ''}" style="--c:${esc(p.color)}" data-part="${esc(p.id)}">
      <label><input type="checkbox"${on ? ' checked' : ''}> ${esc(p.name)} ${period}</label>
      <textarea rows="2" placeholder="${esc(p.name)}での補足（この部だけ違う点など）">${esc(editing.notes[p.id] || '')}</textarea>
    </div>`;
  }).join('');
}
evd.parts.addEventListener('change', (e) => {
  const pc = e.target.closest('.pc');
  if (!pc || e.target.type !== 'checkbox') return;
  if (e.target.checked) editing.parts.add(pc.dataset.part); else editing.parts.delete(pc.dataset.part);
  pc.classList.toggle('on', e.target.checked);
  if (e.target.checked) pc.querySelector('textarea').focus();
});
evd.parts.addEventListener('input', (e) => {
  const pc = e.target.closest('.pc');
  if (pc && e.target.tagName === 'TEXTAREA') editing.notes[pc.dataset.part] = e.target.value;
});
evd.date.addEventListener('input', renderPartChecks);
evd.time.addEventListener('input', renderPartChecks);
$('#evTimeClear').addEventListener('click', () => { evd.time.value = ''; renderPartChecks(); });

let lastDate = '';
function collectEvent() {
  const w = curWork();
  if (evd.pin.value.trim()) { addPeople(evd.pin.value); evd.pin.value = ''; }
  const parts = w.parts.map((p) => p.id).filter((id) => editing.parts.has(id));
  const partNotes = {};
  for (const id of parts) if ((editing.notes[id] || '').trim()) partNotes[id] = editing.notes[id].replace(/\s+$/, '');
  const now = Date.now();
  return {
    id: editing.id || TDB.uid(), workId: w.id,
    date: evd.date.value, time: normTime(evd.time.value),
    text: evd.text.value.replace(/[\r\n]+/g, ' ').trim(),
    people: [...editing.people], place: evd.place.value.trim(), episode: evd.episode.value.trim(),
    memo: evd.memo.value.replace(/\s+$/, ''), parts, partNotes,
    created: editing.created || now, updated: now,
  };
}
async function saveEvent(ev) {
  await TDB.putEvent(ev);
  lastDate = ev.date;
  const i = events.findIndex((x) => x.id === ev.id);
  if (i >= 0) events[i] = ev; else events.push(ev);
  TDB.notify({ type: 'events', workId: ev.workId });
  renderToolbar();
  renderGrid();
}

evd.form.addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  if (!DATE_RE.test(evd.date.value)) { evd.date.reportValidity(); return; }
  const ev = collectEvent();
  if (!ev.text) { evd.text.reportValidity(); return; }
  try {
    await saveEvent(ev);
    evd.dlg.close();
  } catch (err) {
    console.error(err);
    alert('保存できませんでした：' + err.message);
  }
});
evd.del.addEventListener('click', async () => {
  if (!editing.id || !confirm('このできごとを削除しますか？')) return;
  await TDB.deleteEvent(editing.id);
  events = events.filter((x) => x.id !== editing.id);
  TDB.notify({ type: 'events', workId });
  evd.dlg.close();
  renderToolbar();
  renderGrid();
});
// 保存してから、同じ日時・人物・場所・部で新しいできごとを開く
evd.dup.addEventListener('click', async () => {
  if (!DATE_RE.test(evd.date.value)) { evd.date.reportValidity(); return; }
  const ev = collectEvent();
  if (!ev.text) { evd.text.reportValidity(); return; }
  await saveEvent(ev);
  evd.dlg.close();
  openEvent(null, { date: ev.date, time: ev.time, people: ev.people, place: ev.place, parts: ev.parts });
});

/* ---------- 年表の設定 ---------- */

const sd = {
  dlg: $('#setDialog'), form: $('#setForm'), title: $('#setTitle'), name: $('#setName'),
  origin: $('#setOrigin'), originWd: $('#setOriginWd'), originTime: $('#setOriginTime'),
  parts: $('#setParts'), del: $('#setDelete'),
};
let setting = null; // { id, parts: [] }

function openSettings(w) {
  setting = w
    ? { id: w.id, parts: w.parts.map((p) => ({ ...p })) }
    : { id: null, parts: ['第一部', '第二部', '第三部', '第四部'].map((name, i) => ({ id: TDB.uid() + i, name, color: PART_COLORS[i], from: '', to: '' })) };
  sd.title.textContent = w ? '年表の設定' : '新しい年表';
  sd.name.value = w ? w.title : '';
  sd.origin.value = w ? w.origin : '';
  sd.originTime.value = w ? w.originTime || '' : '';
  setWd(sd.originWd, sd.origin.value);
  sd.del.hidden = !w;
  renderPartRows();
  sd.dlg.showModal();
  if (!w) sd.name.focus();
}
function renderPartRows() {
  sd.parts.innerHTML = setting.parts.map((p, i) => `<div class="prow" data-i="${i}">
    <input type="color" value="${esc(p.color)}" data-k="color" aria-label="${esc(p.name)}の色">
    <input type="text" class="pname" value="${esc(p.name)}" data-k="name" required aria-label="部の名前" placeholder="部の名前">
    <span class="pbtns">
      <button type="button" class="icon-btn" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="前へ">↑</button>
      <button type="button" class="icon-btn" data-act="down" ${i === setting.parts.length - 1 ? 'disabled' : ''} aria-label="後ろへ">↓</button>
      <button type="button" class="icon-btn" data-act="del" aria-label="この部を削除">✕</button>
    </span>
    <span class="pperiod">描いている期間 <input type="date" value="${esc(p.from)}" data-k="from" aria-label="期間の始まり"> <b class="wd wd-${wdIndex(p.from)}">${p.from ? `（${wdOf(p.from)}）` : ''}</b>〜 <input type="date" value="${esc(p.to)}" data-k="to" aria-label="期間の終わり"> <b class="wd wd-${wdIndex(p.to)}">${p.to ? `（${wdOf(p.to)}）` : ''}</b></span>
  </div>`).join('') || '<p class="note">部がありません。</p>';
}
sd.parts.addEventListener('input', (e) => {
  const row = e.target.closest('.prow');
  const k = e.target.dataset.k;
  if (!row || !k) return;
  setting.parts[Number(row.dataset.i)][k] = e.target.value;
  if (k === 'from' || k === 'to') {
    const b = e.target.nextElementSibling;
    setWd(b, e.target.value);
  }
});
sd.parts.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const i = Number(b.closest('.prow').dataset.i);
  const ps = setting.parts;
  if (b.dataset.act === 'up' && i > 0) [ps[i - 1], ps[i]] = [ps[i], ps[i - 1]];
  else if (b.dataset.act === 'down' && i < ps.length - 1) [ps[i + 1], ps[i]] = [ps[i], ps[i + 1]];
  else if (b.dataset.act === 'del') {
    const used = setting.id ? events.filter((ev) => ev.parts.includes(ps[i].id)).length : 0;
    if (!confirm(`「${ps[i].name}」を削除しますか？${used ? `\n${used}件のできごとから、この部の印と補足が外れます（保存したとき）。` : ''}`)) return;
    ps.splice(i, 1);
  }
  renderPartRows();
});
$('#setAddPart').addEventListener('click', () => {
  const n = setting.parts.length;
  const used = new Set(setting.parts.map((p) => p.color));
  setting.parts.push({ id: TDB.uid(), name: `第${n + 1}部`, color: PART_COLORS.find((c) => !used.has(c)) || PART_COLORS[n % PART_COLORS.length], from: '', to: '' });
  renderPartRows();
  sd.parts.querySelector('.prow:last-child .pname').select();
});
sd.origin.addEventListener('input', () => setWd(sd.originWd, sd.origin.value));
$('#setOriginTimeClear').addEventListener('click', () => { sd.originTime.value = ''; });

sd.form.addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  if (!sd.form.reportValidity()) return;
  const names = setting.parts.map((p) => p.name.trim());
  if (names.some((n) => !n)) { alert('部の名前を入れてください。'); return; }
  if (new Set(names).size !== names.length) { alert('同じ名前の部があります。部の名前は別々にしてください（書き出し・読み込みで区別するため）。'); return; }
  const bad = setting.parts.find((p) => p.from && p.to && p.from > p.to);
  if (bad) { alert(`「${bad.name}」の期間の始まりが終わりより後になっています。`); return; }
  const parts = setting.parts.map((p) => ({ id: p.id, name: p.name.trim(), color: p.color, from: p.from || '', to: p.to || '' }));
  const old = setting.id ? curWork() : null;
  const w = old
    ? { ...old, title: sd.name.value.trim(), origin: sd.origin.value, originTime: normTime(sd.originTime.value), parts }
    : { id: TDB.uid(), title: sd.name.value.trim(), origin: sd.origin.value, originTime: normTime(sd.originTime.value), parts, order: works.reduce((m, x) => Math.max(m, x.order), -1) + 1, created: Date.now() };
  try {
    await TDB.putWork(w);
    if (old) {
      const removed = old.parts.map((p) => p.id).filter((id) => !parts.some((p) => p.id === id));
      if (removed.length) await TDB.removePartFromEvents(w.id, removed);
    }
    TDB.notify({ type: 'works' });
    sd.dlg.close();
    await loadWorks();
    if (old) await reloadEvents();
    await openWork(w.id, !old);
  } catch (err) {
    console.error(err);
    alert('保存できませんでした：' + err.message);
  }
});
sd.del.addEventListener('click', async () => {
  const w = curWork();
  if (!w) return;
  if (!confirm(`年表「${w.title}」と、そのできごと${events.length}件をすべて削除しますか？\n（元に戻せません。必要なら先に書き出してください）`)) return;
  await TDB.deleteWork(w.id);
  delete ui.byWork[w.id];
  TDB.notify({ type: 'works' });
  sd.dlg.close();
  await loadWorks();
  await openWork(null);
});

/* =========================================================
   書き出し（MD・CSV）と読み込み
   ========================================================= */

const MD_MARK = '<!-- noveltool-timeline v1 -->';
const CSV_COLS = ['種別', 'ID', '日付', '曜日', '時刻', 'できごと', '登場人物', '場所', '関連する話', '区分', '部', '部ごとの補足', 'メモ', '期間の終了', '色'];
const LIST_SEP = '、';

function sortedEvents() { return [...events].sort(cmpEv); }
function partNames(w, ids) { return ids.map((id) => partOf(w, id)).filter(Boolean).map((p) => p.name); }
function safeName(s) { return (s || '無題').replace(/[\\/:*?"<>|]/g, '_').trim() || '無題'; }
function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- Markdown ---------- */

// 本文ブロックの行が「#」「\」で始まるときは先頭に「\」を付ける
const escBlock = (s) => s.split('\n').map((l) => (/^[#\\]/.test(l) ? '\\' + l : l)).join('\n');
const escCell = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
const oneLine = (s) => String(s || '').replace(/[\r\n]+/g, ' ');

function toMarkdown(w) {
  const out = [];
  out.push(`# 年表：${oneLine(w.title)}`, '', MD_MARK, `- 年表ID：${w.id}`, `- 起点：${fmtDate(w.origin)}${w.originTime ? ' ' + w.originTime : ''}`, '');
  out.push('## 部', '', '| 部 | 色 | 描いている期間（始まり） | 描いている期間（終わり） | 部ID |', '|---|---|---|---|---|');
  for (const p of w.parts) out.push(`| ${escCell(p.name)} | ${p.color} | ${fmtDate(p.from)} | ${fmtDate(p.to)} | ${escCell(p.id)} |`);
  out.push('');
  const evs = sortedEvents();
  const common = evs.filter((e) => sideOf(w, e.date, e.time) === 'common');
  const route = evs.filter((e) => sideOf(w, e.date, e.time) === 'route');
  const writeEv = (e, key) => {
    out.push(`### ${fmtDate(e.date)}${e.time ? ' ' + e.time : ''}｜${oneLine(e.text)}`);
    out.push(`- ${key}：${partNames(w, e.parts).join(LIST_SEP)}`);
    if (e.people.length) out.push(`- 登場人物：${e.people.map(oneLine).join(LIST_SEP)}`);
    if (e.place) out.push(`- 場所：${oneLine(e.place)}`);
    if (e.episode) out.push(`- 関連する話：${oneLine(e.episode)}`);
    out.push(`- ID：${e.id}`, '');
    for (const id of e.parts) {
      const p = partOf(w, id);
      if (p && e.partNotes[id]) out.push(`#### 補足：${oneLine(p.name)}`, escBlock(e.partNotes[id]), '');
    }
    if (e.memo) out.push('#### メモ', escBlock(e.memo), '');
  };
  out.push('## 共通のできごと（起点まで）', '');
  common.forEach((e) => writeEv(e, '描写する部'));
  out.push(`## 起点　${fmtDate(w.origin)}${w.originTime ? ' ' + w.originTime : ''}`, '', 'ここから部ごとのルートに分かれます。', '');
  out.push('## 起点以降のできごと（部ごとのルート）', '');
  route.forEach((e) => writeEv(e, 'ルート'));
  return out.join('\n');
}

function parseDateText(s) {
  const m = /(\d{4,})[-/](\d{1,2})[-/](\d{1,2})/.exec(s || '');
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}
function splitList(s) { return String(s || '').split(/[、,，]/).map((x) => x.trim()).filter(Boolean); }
function splitRow(line) {
  const cells = [];
  let cur = '';
  const body = line.trim().replace(/^\|/, '');
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && i + 1 < body.length) { cur += body[++i]; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) cells.push(cur.trim());
  return cells;
}

function parseMarkdown(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const work = { id: '', title: '', origin: '', originTime: '', parts: [] };
  const evs = [];
  let ev = null;
  let block = null; // { kind: 'memo' | 'note', name, lines }
  let section = '';
  const pendingNotes = [];
  const flushBlock = () => {
    if (!block) return;
    while (block.lines.length && !block.lines[block.lines.length - 1].trim()) block.lines.pop();
    while (block.lines.length && !block.lines[0].trim()) block.lines.shift();
    const t = block.lines.join('\n');
    if (block.kind === 'memo') ev.memo = t; else pendingNotes.push({ ev, name: block.name, text: t });
    block = null;
  };
  for (const line of lines) {
    if (/^#/.test(line)) {
      flushBlock();
      let m;
      if ((m = /^#\s+(?:年表[：:]\s*)?(.*)$/.exec(line)) && !work.title) { work.title = m[1].trim(); continue; }
      if ((m = /^##\s+(.*)$/.exec(line))) { section = m[1].trim(); ev = null; continue; }
      if ((m = /^###\s+(.*)$/.exec(line))) {
        const h = m[1];
        const sep = h.indexOf('｜');
        const head = sep >= 0 ? h.slice(0, sep) : h;
        const date = parseDateText(head);
        if (!date) { ev = null; continue; }
        const tm = /(\d{1,2}:\d{2})/.exec(head.replace(/\d{4,}[-/]\d{1,2}[-/]\d{1,2}/, ''));
        ev = { id: '', date, time: tm ? normTime(tm[1]) : '', text: sep >= 0 ? h.slice(sep + 1).trim() : '', people: [], place: '', episode: '', memo: '', partNames: [], partNotes: {} };
        evs.push(ev);
        continue;
      }
      if ((m = /^####\s+(.*)$/.exec(line)) && ev) {
        const t = m[1].trim();
        const n = /^補足[：:]\s*(.*)$/.exec(t);
        block = n ? { kind: 'note', name: n[1].trim(), lines: [] } : { kind: 'memo', lines: [] };
        continue;
      }
      continue;
    }
    if (block) { block.lines.push(line.startsWith('\\') ? line.slice(1) : line); continue; }
    let m;
    if (section === '部' && /^\s*\|/.test(line)) {
      const c = splitRow(line);
      if (c[0] === '部' || /^-+$/.test((c[0] || '').replace(/:/g, '')) || !c[0]) continue;
      work.parts.push({ id: c[4] || '', name: c[0], color: /^#[0-9a-f]{6}$/i.test(c[1] || '') ? c[1] : '', from: parseDateText(c[2]), to: parseDateText(c[3]) });
      continue;
    }
    if ((m = /^\s*[-*]\s*([^：:]+)[：:]\s*(.*)$/.exec(line))) {
      const k = m[1].trim();
      const val = m[2].trim();
      if (!ev) {
        if (k === '年表ID') work.id = val;
        else if (k === '起点') {
          work.origin = parseDateText(val);
          const tm = /(\d{1,2}:\d{2})/.exec(val.replace(/\d{4,}[-/]\d{1,2}[-/]\d{1,2}/, ''));
          work.originTime = tm ? normTime(tm[1]) : '';
        }
        continue;
      }
      if (k === '描写する部' || k === 'ルート' || k === '部') ev.partNames = splitList(val);
      else if (k === '登場人物' || k === '人物') ev.people = splitList(val);
      else if (k === '場所') ev.place = val;
      else if (k === '関連する話' || k === '話') ev.episode = val;
      else if (k === 'ID') ev.id = val;
      else if (k === 'メモ') ev.memo = val;
    }
  }
  flushBlock();
  for (const n of pendingNotes) n.ev.partNotes[n.name] = n.text;
  return finishImport(work, evs);
}

/* ---------- CSV ---------- */

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(w) {
  const rows = [CSV_COLS];
  const row = (o) => CSV_COLS.map((c) => o[c] || '');
  rows.push(row({ 種別: '年表', ID: w.id, 日付: w.origin, 曜日: wdOf(w.origin), 時刻: w.originTime, できごと: w.title, 区分: '起点' }));
  for (const p of w.parts) rows.push(row({ 種別: '部', ID: p.id, 日付: p.from, 曜日: wdOf(p.from), できごと: p.name, 期間の終了: p.to, 色: p.color }));
  for (const e of sortedEvents()) {
    const notes = e.parts.map((id) => partOf(w, id)).filter((p) => p && e.partNotes[p.id]).map((p) => `【${p.name}】${e.partNotes[p.id]}`).join('\n');
    rows.push(row({
      種別: 'できごと', ID: e.id, 日付: e.date, 曜日: wdOf(e.date), 時刻: e.time, できごと: e.text,
      登場人物: e.people.join(LIST_SEP), 場所: e.place, 関連する話: e.episode,
      区分: sideOf(w, e.date, e.time) === 'common' ? '共通' : 'ルート', 部: partNames(w, e.parts).join(LIST_SEP),
      部ごとの補足: notes, メモ: e.memo,
    }));
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) throw new Error('CSVが空です。');
  const head = rows[0].map((h) => h.trim());
  const idx = Object.fromEntries(CSV_COLS.map((c) => [c, head.indexOf(c)]));
  if (idx['日付'] < 0 || idx['できごと'] < 0) throw new Error('1行目に「日付」「できごと」などの見出しが必要です（READMEの「年表のCSV」を参照）。');
  const get = (r, c) => (idx[c] >= 0 ? (r[idx[c]] || '') : '').trim();
  const getRaw = (r, c) => (idx[c] >= 0 ? (r[idx[c]] || '') : '').replace(/\r\n?/g, '\n');
  const work = { id: '', title: '', origin: '', originTime: '', parts: [] };
  const evs = [];
  for (const r of rows.slice(1)) {
    const kind = get(r, '種別') || 'できごと';
    if (kind === '年表' || kind === '作品') {
      work.id = get(r, 'ID');
      work.title = get(r, 'できごと');
      work.origin = parseDateText(get(r, '日付'));
      work.originTime = normTime(get(r, '時刻'));
    } else if (kind === '部') {
      work.parts.push({ id: get(r, 'ID'), name: get(r, 'できごと'), color: get(r, '色'), from: parseDateText(get(r, '日付')), to: parseDateText(get(r, '期間の終了')) });
    } else {
      const date = parseDateText(get(r, '日付'));
      if (!date) continue;
      const names = splitList(get(r, '部'));
      const partNotes = {};
      let curName = null;
      for (const line of getRaw(r, '部ごとの補足').split('\n')) {
        const m = /^【(.+?)】(.*)$/.exec(line);
        if (m) { curName = m[1].trim(); partNotes[curName] = m[2]; } else if (curName) partNotes[curName] += '\n' + line;
      }
      evs.push({
        id: get(r, 'ID'), date, time: normTime(get(r, '時刻')), text: get(r, 'できごと'),
        people: splitList(get(r, '登場人物')), place: get(r, '場所'), episode: get(r, '関連する話'),
        memo: getRaw(r, 'メモ').replace(/\s+$/, ''), partNames: names, partNotes,
      });
    }
  }
  return finishImport(work, evs);
}

// 部の名前を部IDに置き換え、足りない部は作る
function finishImport(work, evs) {
  if (!work.title) work.title = '読み込んだ年表';
  const parts = [];
  const byName = new Map();
  const addPart = (p) => {
    if (!p.name || byName.has(p.name)) return byName.get(p.name);
    const part = { id: p.id || TDB.uid() + parts.length, name: p.name, color: /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color.toLowerCase() : PART_COLORS[parts.length % PART_COLORS.length], from: p.from || '', to: p.to || '' };
    parts.push(part);
    byName.set(part.name, part);
    return part;
  };
  work.parts.forEach(addPart);
  for (const e of evs) for (const n of [...e.partNames, ...Object.keys(e.partNotes)]) addPart({ name: n });
  if (!work.origin) {
    // 起点がないときは、最初のできごとの日（なければ今日）にする
    const first = evs.map((e) => e.date).sort()[0];
    work.origin = first || new Date().toISOString().slice(0, 10);
  }
  const events = evs.map((e) => {
    const ids = uniq(e.partNames.map((n) => byName.get(n)).filter(Boolean).map((p) => p.id));
    const partNotes = {};
    for (const [n, t] of Object.entries(e.partNotes)) {
      const p = byName.get(n);
      if (p && t.trim()) {
        partNotes[p.id] = t.replace(/\s+$/, '');
        if (!ids.includes(p.id)) ids.push(p.id);
      }
    }
    return { id: e.id || '', date: e.date, time: e.time, text: e.text || '（無題）', people: uniq(e.people), place: e.place, episode: e.episode, memo: e.memo, parts: ids, partNotes, updated: Date.now() };
  });
  return { work: { id: work.id || '', title: work.title, origin: work.origin, originTime: work.originTime || '', parts }, events };
}

/* ---------- ボタン ---------- */

$('#exportMd').addEventListener('click', () => {
  const w = curWork();
  if (w) download(`${safeName(w.title)}_年表.md`, toMarkdown(w), 'text/markdown;charset=utf-8');
});
$('#exportCsv').addEventListener('click', () => {
  const w = curWork();
  if (w) download(`${safeName(w.title)}_年表.csv`, toCsv(w), 'text/csv;charset=utf-8');
});
$('#importBtn').addEventListener('click', () => $('#importFile').click());

async function readText(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch (e) {
    // Excel で保存し直した CSV（Shift_JIS）にも対応
    return new TextDecoder('shift_jis').decode(buf);
  }
}

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try {
    const text = await readText(file);
    const isCsv = /\.csv$/i.test(file.name) || (!/\.(md|markdown)$/i.test(file.name) && !/^\s*#/.test(text));
    data = isCsv ? parseCsv(text) : parseMarkdown(text);
  } catch (err) {
    console.error(err);
    alert('読み込めませんでした：' + err.message);
    return;
  }
  const existing = data.work.id ? works.find((w) => w.id === data.work.id) : null;
  const dlg = $('#importDialog');
  $('#importMsg').textContent = existing
    ? `「${data.work.title}」（できごと${data.events.length}件）を読み込みます。同じ年表「${existing.title}」がすでにあります。`
    : `「${data.work.title}」（部${data.work.parts.length}つ・できごと${data.events.length}件）を新しい年表として読み込みます。`;
  $('#importReplace').hidden = !existing;
  $('#importAdd').textContent = existing ? '別の年表として追加' : '読み込む';
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    const mode = dlg.returnValue;
    if (mode !== 'add' && mode !== 'replace') return;
    try {
      const w = await TDB.importWork(data, mode === 'replace');
      TDB.notify({ type: 'works' });
      await loadWorks();
      await openWork(w.id, true);
    } catch (err) {
      console.error(err);
      alert('読み込めませんでした：' + err.message);
    }
  }, { once: true });
});

/* ---------- 別タブの変更を反映 ---------- */

TDB.onMessage(async (msg) => {
  if (msg.type === 'works') {
    await loadWorks();
    if (!works.some((w) => w.id === workId)) { await openWork(null); return; }
    await reloadEvents();
    renderAll();
  } else if (msg.type === 'events' && msg.workId === workId) {
    await reloadEvents();
    renderToolbar();
    renderGrid();
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
    el.empty.hidden = false;
    el.emptyMsg.textContent = 'データを開けませんでした：' + err.message;
    el.emptyAction.hidden = true;
  }
})();
