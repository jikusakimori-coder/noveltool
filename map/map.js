'use strict';

/* =========================================================
   配置図ツール
   執筆ツール・年表ツールとは別のデータベース（noveltool-map）に保存します。
   年表ツールのデータベースは読むだけで、書き換えません。
   ========================================================= */

const MDB = (() => {
  const NAME = 'noveltool-map';
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
          db.createObjectStore('maps', { keyPath: 'id' }).createIndex('workId', 'workId');
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
    return run(['works', 'maps'], 'readwrite', async (s) => {
      s.works.delete(id);
      for (const k of await req(s.maps.index('workId').getAllKeys(id))) s.maps.delete(k);
    });
  }
  async function maps(workId) {
    const list = await run('maps', 'readonly', (s) => req(s.maps.index('workId').getAll(workId)));
    return list.sort((a, b) => (a.order - b.order) || (a.created - b.created));
  }
  function putMap(m) { return run('maps', 'readwrite', (s) => { s.maps.put(m); }); }
  function deleteMap(id) { return run('maps', 'readwrite', (s) => { s.maps.delete(id); }); }
  // data: { work, maps }。replace=true なら同じIDの作品を置き換える
  function importWork(data, replace) {
    const now = Date.now();
    return run(['works', 'maps'], 'readwrite', async (s) => {
      const all = await req(s.works.getAll());
      const existing = data.work.id ? all.find((w) => w.id === data.work.id) : null;
      let work;
      if (existing && replace) {
        for (const k of await req(s.maps.index('workId').getAllKeys(existing.id))) s.maps.delete(k);
        work = { ...existing, ...data.work, id: existing.id, order: existing.order, created: existing.created };
      } else {
        const id = data.work.id && !existing ? data.work.id : uid();
        work = { ...data.work, id, order: all.reduce((m, w) => Math.max(m, w.order), -1) + 1, created: now };
      }
      s.works.put(work);
      // 地図のIDは作り直し、リンク先も付け替える（ほかの作品の地図とぶつからないように）
      const idMap = new Map(data.maps.map((m) => [m.id, uid() + Math.random().toString(36).slice(2, 4)]));
      data.maps.forEach((m, i) => {
        const shapes = m.shapes.map((sh) => (sh.link ? { ...sh, link: idMap.get(sh.link) || null } : sh));
        s.maps.put({ ...m, id: idMap.get(m.id), workId: work.id, shapes, order: i, created: now + i });
      });
      return work;
    });
  }

  const TAB = uid();
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('noveltool-map') : null;
  let listener = null;
  if (channel) channel.onmessage = (e) => { if (e.data && e.data.from !== TAB && listener) listener(e.data); };
  function notify(msg) { if (channel) channel.postMessage({ ...msg, from: TAB }); }
  function onMessage(fn) { listener = fn; }

  return { uid, works, putWork, deleteWork, maps, putMap, deleteMap, importWork, notify, onMessage };
})();

/* ---------- 年表ツールのデータ（読むだけ） ---------- */

const TLR = (() => {
  const NAME = 'noveltool-timeline';
  // 存在するときだけ開く（存在しなければ作らない。作ってしまうと年表ツールが初期化できなくなる）
  function openExisting() {
    return new Promise((resolve) => {
      let created = false;
      let r;
      try { r = indexedDB.open(NAME); } catch (e) { resolve(null); return; }
      r.onupgradeneeded = () => { created = true; r.transaction.abort(); };
      r.onerror = (e) => { if (e.preventDefault) e.preventDefault(); resolve(null); };
      r.onblocked = () => resolve(null);
      r.onsuccess = () => {
        const db = r.result;
        if (created || !db.objectStoreNames.contains('works') || !db.objectStoreNames.contains('events')) { db.close(); resolve(null); return; }
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
  }
  async function read(fn) {
    const db = await openExisting();
    if (!db) return null;
    try {
      return await fn(db);
    } finally {
      db.close();
    }
  }
  const getAll = (db, store, index, key) => new Promise((resolve, reject) => {
    const st = db.transaction(store, 'readonly').objectStore(store);
    const r = index ? st.index(index).getAll(key) : st.getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
  async function works() {
    const list = await read((db) => getAll(db, 'works'));
    return (list || []).sort((a, b) => (a.order - b.order) || (a.created - b.created));
  }
  async function events(workId) {
    if (!workId) return [];
    return (await read((db) => getAll(db, 'events', 'workId', workId))) || [];
  }
  // 年表ツールで変更があったら知らせてもらう
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('noveltool-timeline') : null;
  function onChange(fn) { if (channel) channel.onmessage = () => fn(); }
  return { works, events, onChange };
})();

/* ---------- 小物 ---------- */

const $ = (s) => document.querySelector(s);
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const SHAPE_COLORS = ['#ead9b5', '#cfe0ec', '#d9e8c6', '#efcfc8', '#ddd2ea', '#f3e6a8', '#d6d3cc', '#c6e3dd'];
const LINE_KINDS = {
  road: { label: '道', color: '#d4c49c', width: 1.2 },
  wall: { label: '塀・壁', color: '#5b5048', width: 0.25 },
  moat: { label: '堀', color: '#6fa6d4', width: 1.6 },
  river: { label: '川', color: '#7fbde6', width: 2 },
  fence: { label: '柵・生け垣', color: '#6f8a4e', width: 0.2 },
  other: { label: 'そのほか', color: '#8a7f73', width: 0.2 },
};
const SYM_KINDS = {
  gate: '門', door: '扉', stairs: '階段', well: '井戸', tree: '木', star: '目印',
};
const TYPE_LABEL = { rect: '四角', poly: '多角形', line: '線', symbol: '記号', pin: '年表の場所' };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const r2 = (n) => Math.round(n * 100) / 100;
function wdIndex(d) {
  if (!/^\d{4,}-\d{2}-\d{2}$/.test(d || '')) return -1;
  const [y, m, dd] = d.split('-').map(Number);
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, dd);
  return t.getUTCDay();
}
function fmtM(n) {
  if (!isFinite(n)) return '';
  if (n >= 1000) return `${r2(n / 1000)} km`;
  return `${n >= 100 ? Math.round(n) : n >= 10 ? Math.round(n * 10) / 10 : r2(n)} m`;
}
function shade(hex, f) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#888888';
  const n = parseInt(m[1], 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return '#' + [ch(n >> 16), ch((n >> 8) & 255), ch(n & 255)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
function textOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#222';
  const n = parseInt(m[1], 16);
  const l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l > 0.55 ? '#2a2723' : '#ffffff';
}
const rot = (p, c, deg) => {
  const a = deg * Math.PI / 180;
  const dx = p[0] - c[0];
  const dy = p[1] - c[1];
  return [c[0] + dx * Math.cos(a) - dy * Math.sin(a), c[1] + dx * Math.sin(a) + dy * Math.cos(a)];
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/* ---------- 状態 ---------- */

let works = [];
let workId = null;
let maps = [];
let mapId = null;
let floorId = null;
let tool = 'select';
let selId = null;
let armedPlace = null; // 「置く」を押した年表の場所
let navStack = []; // リンクでたどった地図
const tl = { works: [], work: null, events: [] };
const views = {}; // mapId → { cx, cy, s }
const UI_KEY = 'noveltool.map.ui.v1';
let ui = { lastWork: null, lastMap: {}, snap: 0.5, lineKind: 'road', symKind: 'gate', partFilter: {} };
try { ui = { ...ui, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') }; } catch (e) { /* noop */ }
function saveUI() { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* noop */ } }

function curWork() { return works.find((w) => w.id === workId) || null; }
function curMap() { return maps.find((m) => m.id === mapId) || null; }
function shapeById(id) { const m = curMap(); return m ? m.shapes.find((s) => s.id === id) || null : null; }
function floorIdx(m, fid) { return m.floors.findIndex((f) => f.id === fid); }

function normMap(m) {
  const floors = Array.isArray(m.floors) && m.floors.length ? m.floors.map((f) => ({ id: String(f.id || MDB.uid()), name: String(f.name || '階') })) : [{ id: 'f1', name: '1階' }];
  const shapes = (Array.isArray(m.shapes) ? m.shapes : []).map((s) => normShape(s, floors)).filter(Boolean);
  return {
    id: m.id, workId: m.workId, name: m.name || '無題の地図',
    width: Math.max(5, Math.min(500, Number(m.width) || 40)), height: Math.max(5, Math.min(500, Number(m.height) || 30)),
    scale: Number(m.scale) > 0 ? Number(m.scale) : 1, floors, shapes, order: m.order || 0, created: m.created || 0,
  };
}
function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
function pts(a) { return Array.isArray(a) ? a.map((p) => [num(p[0], 0), num(p[1], 0)]) : []; }
function normShape(s, floors) {
  if (!s || !TYPE_LABEL[s.type]) return null;
  const floor = floors.some((f) => f.id === s.floor) ? s.floor : floors[0].id;
  const base = { id: String(s.id || MDB.uid()), type: s.type, floor, name: String(s.name || ''), memo: String(s.memo || ''), place: String(s.place || '') };
  if (s.type === 'rect') return { ...base, x: num(s.x, 0), y: num(s.y, 0), w: Math.max(0.1, num(s.w, 4)), h: Math.max(0.1, num(s.h, 3)), rot: num(s.rot, 0), color: s.color || SHAPE_COLORS[0], link: s.link || null };
  if (s.type === 'poly') { const p = pts(s.points); return p.length >= 3 ? { ...base, points: p, color: s.color || SHAPE_COLORS[0], link: s.link || null } : null; }
  if (s.type === 'line') { const p = pts(s.points); const k = LINE_KINDS[s.kind] ? s.kind : 'other'; return p.length >= 2 ? { ...base, points: p, kind: k, color: s.color || '', width: num(s.width, 0) } : null; }
  if (s.type === 'symbol') return { ...base, kind: SYM_KINDS[s.kind] ? s.kind : 'star', x: num(s.x, 0), y: num(s.y, 0), size: Math.max(0.2, num(s.size, 1.5)), rot: num(s.rot, 0), link: s.link || null };
  if (s.type === 'pin') return s.place ? { ...base, x: num(s.x, 0), y: num(s.y, 0) } : null;
  return null;
}

/* =========================================================
   図形の計算
   ========================================================= */

function rectCorners(s) {
  const c = [s.x + s.w / 2, s.y + s.h / 2];
  return [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]].map((p) => rot(p, c, s.rot || 0));
}
function shapePoints(s) {
  if (s.type === 'rect') return rectCorners(s);
  if (s.type === 'poly' || s.type === 'line') return s.points;
  const r = s.type === 'symbol' ? s.size / 2 : 0.5;
  return [[s.x - r, s.y - r], [s.x + r, s.y + r]];
}
function bboxOf(list) {
  const xs = list.map((p) => p[0]);
  const ys = list.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
function shapeCenter(s) {
  if (s.type === 'rect') return [s.x + s.w / 2, s.y + s.h / 2];
  if (s.type === 'symbol' || s.type === 'pin') return [s.x, s.y];
  const b = bboxOf(s.points);
  return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
}
function moveShape(s, o, dx, dy) {
  if (s.type === 'poly' || s.type === 'line') s.points = o.points.map((p) => [r2(p[0] + dx), r2(p[1] + dy)]);
  else { s.x = r2(o.x + dx); s.y = r2(o.y + dy); }
}
function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; }
  return Math.abs(a / 2);
}
function polyLen(p) { let l = 0; for (let i = 1; i < p.length; i++) l += dist(p[i - 1], p[i]); return l; }
// 線の名前を置く位置（いちばん長い区間のまんなか）
function lineLabelPos(p) {
  let best = 0;
  let at = [p[0], p[1]];
  for (let i = 1; i < p.length; i++) { const d = dist(p[i - 1], p[i]); if (d > best) { best = d; at = [p[i - 1], p[i]]; } }
  return [(at[0][0] + at[1][0]) / 2, (at[0][1] + at[1][1]) / 2];
}

/* =========================================================
   SVG を組み立てる（画面表示と PNG 保存の両方で使う）
   ========================================================= */

const FONT = 'system-ui, -apple-system, &quot;Hiragino Sans&quot;, &quot;Noto Sans JP&quot;, &quot;Yu Gothic UI&quot;, sans-serif';
function palette(forExport) {
  const dark = !forExport && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
  return dark
    ? { back: '#2d2b28', paper: '#24231f', grid: '#33312c', grid5: '#46433c', edge: '#5a564e', text: '#e8e4dc', halo: '#24231f', sel: '#7fb49f', ghost: 0.22 }
    : { back: '#efece5', paper: '#fffdf8', grid: '#ebe6db', grid5: '#d6cfbf', edge: '#b9b1a1', text: '#2a2723', halo: '#fffdf8', sel: '#3d6b5a', ghost: 0.18 };
}
function textSvg(x, y, str, fs, fill, halo, extra = '') {
  if (!str) return '';
  const h = halo ? ` paint-order="stroke" stroke="${halo}" stroke-width="${r2(fs * 0.28)}" stroke-linejoin="round"` : '';
  return `<text x="${r2(x)}" y="${r2(y)}" font-size="${r2(fs)}" fill="${fill}" text-anchor="middle" dominant-baseline="central" font-family="${FONT}"${h}${extra}>${esc(str)}</text>`;
}
function mapName(id) { const m = maps.find((x) => x.id === id); return m ? m.name : ''; }

// 建物・部屋の名前と、リンク先・年表の場所
function areaLabels(s, c, size, pal) {
  const fs = Math.max(0.42, Math.min(0.95, size * 0.28));
  const ink = textOn(s.color);
  const lines = [];
  if (s.name) lines.push([s.name, fs, '']);
  if (s.place && s.place !== s.name) lines.push([`📍${s.place}`, fs * 0.7, '']);
  if (s.link && mapName(s.link)) lines.push([`→ ${mapName(s.link)}`, fs * 0.7, ' font-weight="600"']);
  const total = lines.reduce((a, l) => a + l[1] * 1.25, 0);
  let y = c[1] - total / 2;
  return lines.map(([t, f, ex]) => { y += f * 1.25; return textSvg(c[0], y - f * 0.62, t, f, ink, null, ex); }).join('');
}

function symbolBody(kind, z, stroke, fill) {
  const sw = r2(z * 0.07);
  const h = z / 2;
  switch (kind) {
    case 'gate':
      return `<rect x="${-h}" y="${r2(-z * 0.14)}" width="${r2(z * 0.2)}" height="${r2(z * 0.28)}" fill="${stroke}"/>` +
        `<rect x="${r2(h - z * 0.2)}" y="${r2(-z * 0.14)}" width="${r2(z * 0.2)}" height="${r2(z * 0.28)}" fill="${stroke}"/>` +
        `<line x1="${r2(-h - z * 0.08)}" y1="${r2(-z * 0.24)}" x2="${r2(h + z * 0.08)}" y2="${r2(-z * 0.24)}" stroke="${stroke}" stroke-width="${r2(z * 0.12)}" stroke-linecap="round"/>`;
    case 'door':
      return `<line x1="${-h}" y1="0" x2="${h}" y2="0" stroke="${stroke}" stroke-width="${sw}" stroke-dasharray="${r2(z * 0.08)} ${r2(z * 0.06)}"/>` +
        `<line x1="${-h}" y1="0" x2="${-h}" y2="${-z}" stroke="${stroke}" stroke-width="${r2(sw * 1.6)}"/>` +
        `<path d="M ${-h} ${-z} A ${z} ${z} 0 0 1 ${h} 0" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
    case 'stairs': {
      let d = '';
      for (let i = 1; i < 5; i++) { const y = r2(-h + (z * i) / 5); d += `M ${-h} ${y} H ${h} `; }
      return `<rect x="${-h}" y="${-h}" width="${z}" height="${z}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>` +
        `<path d="${d}" stroke="${stroke}" stroke-width="${r2(sw * 0.7)}"/>` +
        `<path d="M 0 ${r2(h * 0.8)} V ${r2(-h * 0.7)} M ${r2(-h * 0.3)} ${r2(-h * 0.35)} L 0 ${r2(-h * 0.75)} L ${r2(h * 0.3)} ${r2(-h * 0.35)}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    case 'well':
      return `<circle r="${r2(z * 0.42)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/><circle r="${r2(z * 0.26)}" fill="#8ec3e6" stroke="${stroke}" stroke-width="${r2(sw * 0.7)}"/>`;
    case 'tree':
      return `<circle r="${r2(z * 0.45)}" fill="#9cc58a" stroke="#4f7a3c" stroke-width="${sw}"/><circle r="${r2(z * 0.08)}" fill="#6b5034"/>`;
    default: {
      const p = [];
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const r = i % 2 ? z * 0.2 : z * 0.48; p.push(`${r2(Math.cos(a) * r)},${r2(Math.sin(a) * r)}`); }
      return `<polygon points="${p.join(' ')}" fill="#f0c94a" stroke="#9a7a1c" stroke-width="${sw}" stroke-linejoin="round"/>`;
    }
  }
}

function shapeSvg(s, pal) {
  const id = ` data-id="${esc(s.id)}"`;
  if (s.type === 'rect' || s.type === 'poly') {
    const stroke = shade(s.color, 0.62);
    const body = s.type === 'rect'
      ? `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}"${s.rot ? ` transform="rotate(${s.rot} ${r2(s.x + s.w / 2)} ${r2(s.y + s.h / 2)})"` : ''} fill="${s.color}" stroke="${stroke}" stroke-width="0.08" stroke-linejoin="round"/>`
      : `<polygon points="${s.points.map((p) => p.join(',')).join(' ')}" fill="${s.color}" stroke="${stroke}" stroke-width="0.08" stroke-linejoin="round"/>`;
    const b = bboxOf(shapePoints(s));
    const size = s.type === 'rect' ? Math.min(s.w, s.h) : Math.min(b.x1 - b.x0, b.y1 - b.y0);
    return `<g class="sh"${id}>${body}${areaLabels(s, shapeCenter(s), size, pal)}</g>`;
  }
  if (s.type === 'line') {
    const k = LINE_KINDS[s.kind];
    const color = s.color || k.color;
    const w = s.width > 0 ? s.width : k.width;
    const d = 'M ' + s.points.map((p) => p.join(' ')).join(' L ');
    let body = '';
    if (s.kind === 'moat' || s.kind === 'river' || s.kind === 'road') {
      body += `<path d="${d}" fill="none" stroke="${shade(color, s.kind === 'road' ? 0.78 : 0.7)}" stroke-width="${r2(w + 0.16)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    body += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${s.kind === 'fence' ? ` stroke-dasharray="${r2(w * 3)} ${r2(w * 2)}"` : ''}/>`;
    const hit = `<path d="${d}" fill="none" stroke="transparent" stroke-width="${Math.max(w, 0.8)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    const lp = lineLabelPos(s.points);
    return `<g class="sh"${id}>${body}${hit}${textSvg(lp[0], lp[1], s.name, 0.55, pal.text, pal.halo)}</g>`;
  }
  if (s.type === 'symbol') {
    const z = s.size;
    const link = s.link && mapName(s.link) ? `→ ${mapName(s.link)}` : '';
    const label = [s.name, s.place && s.place !== s.name ? `📍${s.place}` : ''].filter(Boolean).join(' ');
    return `<g class="sh"${id}><g transform="translate(${s.x} ${s.y})${s.rot ? ` rotate(${s.rot})` : ''}"><circle r="${r2(z * 0.6)}" fill="transparent"/>${symbolBody(s.kind, z, '#4a4038', pal.paper)}</g>` +
      textSvg(s.x, s.y + z * 0.6 + 0.35, label, 0.5, pal.text, pal.halo) +
      textSvg(s.x, s.y + z * 0.6 + (label ? 0.95 : 0.35), link, 0.42, pal.text, pal.halo, ' font-weight="600"') + '</g>';
  }
  // 年表の場所のピン
  return `<g class="sh"${id}><path d="M ${s.x} ${s.y} l -0.32 -0.62 a 0.36 0.36 0 1 1 0.64 0 z" fill="#c0504d" stroke="#7a2e2c" stroke-width="0.05"/>` +
    `<circle cx="${s.x}" cy="${r2(s.y - 0.78)}" r="0.13" fill="#fff"/>` +
    textSvg(s.x, s.y + 0.4, s.place, 0.5, pal.text, pal.halo, ' font-weight="600"') + '</g>';
}

function niceScaleCells(m) {
  // 5マス前後で、きりのよい長さ（m）になるものさし
  const target = m.scale * 5;
  const p = Math.pow(10, Math.floor(Math.log10(target)));
  const nice = [1, 2, 5, 10].map((k) => k * p).reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
  return { meters: nice, cells: nice / m.scale };
}

// 地図の背景（紙・方眼・ものさし）
function backgroundSvg(m, pal) {
  let minor = '';
  let major = '';
  for (let x = 0; x <= m.width; x++) (x % 5 ? (minor += `M ${x} 0 V ${m.height} `) : (major += `M ${x} 0 V ${m.height} `));
  for (let y = 0; y <= m.height; y++) (y % 5 ? (minor += `M 0 ${y} H ${m.width} `) : (major += `M 0 ${y} H ${m.width} `));
  const sc = niceScaleCells(m);
  const by = m.height + 0.9;
  return `<rect x="0" y="0" width="${m.width}" height="${m.height}" fill="${pal.paper}"/>` +
    `<path d="${minor}" stroke="${pal.grid}" stroke-width="0.04" fill="none"/>` +
    `<path d="${major}" stroke="${pal.grid5}" stroke-width="0.06" fill="none"/>` +
    `<rect x="0" y="0" width="${m.width}" height="${m.height}" fill="none" stroke="${pal.edge}" stroke-width="0.08"/>` +
    `<g><rect x="0" y="${r2(by - 0.15)}" width="${r2(sc.cells)}" height="0.3" fill="${pal.text}"/>` +
    `<rect x="${r2(sc.cells / 2)}" y="${r2(by - 0.15)}" width="${r2(sc.cells / 2)}" height="0.3" fill="${pal.paper}" stroke="${pal.text}" stroke-width="0.05"/>` +
    `<text x="${r2(sc.cells + 0.4)}" y="${r2(by)}" font-size="0.5" fill="${pal.text}" dominant-baseline="central" font-family="${FONT}">${esc(fmtM(sc.meters))}　（1マス＝${esc(fmtM(m.scale))}）</text></g>`;
}

function mapSvgBody(m, fid, pal) {
  const fi = floorIdx(m, fid);
  const below = fi > 0 ? m.floors[fi - 1].id : null;
  let h = backgroundSvg(m, pal);
  if (below) {
    const ghost = m.shapes.filter((s) => s.floor === below && s.type !== 'pin');
    if (ghost.length) h += `<g opacity="${pal.ghost}" pointer-events="none">${ghost.map((s) => shapeSvg(s, pal)).join('')}</g>`;
  }
  const mine = m.shapes.filter((s) => s.floor === fid);
  h += mine.filter((s) => s.type !== 'pin').map((s) => shapeSvg(s, pal)).join('');
  h += mine.filter((s) => s.type === 'pin').map((s) => shapeSvg(s, pal)).join('');
  return h;
}

/* =========================================================
   画面の地図（表示位置・選択枠・操作）
   ========================================================= */

const svg = $('#canvas');
const wrap = $('#canvasWrap');
let draft = null; // 描きかけ { type: 'poly'|'line', points, cursor } / { type: 'rect', a, b } / { type: 'measure', a, b }
let drag = null;
let measureLine = null; // 最後にはかった線（次の操作まで残す）

function view() {
  const m = curMap();
  if (!views[m.id]) fitView(m);
  return views[m.id];
}
function fitView(m) {
  const W = wrap.clientWidth || 800;
  const H = wrap.clientHeight || 600;
  const s = Math.max(2, Math.min(80, Math.min((W - 40) / m.width, (H - 60) / (m.height + 1.6))));
  views[m.id] = { cx: m.width / 2, cy: (m.height + 1.4) / 2, s };
}
function applyViewBox() {
  const v = view();
  const W = wrap.clientWidth || 800;
  const H = wrap.clientHeight || 600;
  svg.setAttribute('viewBox', `${v.cx - W / 2 / v.s} ${v.cy - H / 2 / v.s} ${W / v.s} ${H / v.s}`);
}
function toWorld(e) {
  const m = svg.getScreenCTM();
  if (!m) return [0, 0];
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  return [p.x, p.y];
}
function snapStep() { return Number(ui.snap) || 0; }
function snapV(v, step = snapStep()) { return step ? Math.round(v / step) * step : r2(v); }
function snapP(p, step) { return [snapV(p[0], step), snapV(p[1], step)]; }

function selectionSvg(s, hs, pal) {
  const stroke = `stroke="${pal.sel}" stroke-width="${r2(hs * 0.35)}"`;
  const knob = (p, hd, extra = '') => `<circle class="hd${hd === 'rot' ? ' hd-rot' : ''}" data-hd="${hd}" cx="${r2(p[0])}" cy="${r2(p[1])}" r="${r2(hs)}" fill="${pal.paper}" ${stroke}${extra}/>`;
  let h = '';
  if (s.type === 'rect') {
    const c = rectCorners(s);
    h += `<polygon points="${c.map((p) => p.map(r2).join(',')).join(' ')}" fill="none" ${stroke} stroke-dasharray="${r2(hs)} ${r2(hs * 0.6)}" pointer-events="none"/>`;
    const top = rot([s.x + s.w / 2, s.y - hs * 4], shapeCenter(s), s.rot || 0);
    const mid = rot([s.x + s.w / 2, s.y], shapeCenter(s), s.rot || 0);
    h += `<line x1="${r2(mid[0])}" y1="${r2(mid[1])}" x2="${r2(top[0])}" y2="${r2(top[1])}" ${stroke} pointer-events="none"/>`;
    h += c.map((p, i) => knob(p, 'c' + i)).join('') + knob(top, 'rot');
  } else if (s.type === 'poly' || s.type === 'line') {
    const b = bboxOf(s.points);
    if (s.type === 'poly') {
      const c = shapeCenter(s);
      const top = [c[0], b.y0 - hs * 4];
      h += `<rect x="${r2(b.x0)}" y="${r2(b.y0)}" width="${r2(b.x1 - b.x0)}" height="${r2(b.y1 - b.y0)}" fill="none" ${stroke} stroke-dasharray="${r2(hs)} ${r2(hs * 0.6)}" opacity=".6" pointer-events="none"/>`;
      h += `<line x1="${r2(c[0])}" y1="${r2(b.y0)}" x2="${r2(top[0])}" y2="${r2(top[1])}" ${stroke} pointer-events="none"/>`;
      h += knob(top, 'rot') + `<rect class="hd" data-hd="scale" x="${r2(b.x1 - hs)}" y="${r2(b.y1 - hs)}" width="${r2(hs * 2)}" height="${r2(hs * 2)}" fill="${pal.paper}" ${stroke}/>`;
    }
    h += s.points.map((p, i) => knob(p, 'v' + i, ' fill-opacity="1"')).join('');
  } else if (s.type === 'symbol') {
    const z = s.size * 0.6;
    const top = rot([s.x, s.y - z - hs * 3], [s.x, s.y], s.rot || 0);
    const corner = rot([s.x + z, s.y + z], [s.x, s.y], s.rot || 0);
    h += `<circle cx="${s.x}" cy="${s.y}" r="${r2(z)}" fill="none" ${stroke} stroke-dasharray="${r2(hs)} ${r2(hs * 0.6)}" pointer-events="none"/>`;
    h += knob(top, 'rot') + knob(corner, 'size');
  } else {
    h += `<circle cx="${s.x}" cy="${r2(s.y - 0.55)}" r="0.75" fill="none" ${stroke} stroke-dasharray="${r2(hs)} ${r2(hs * 0.6)}" pointer-events="none"/>`;
  }
  return `<g class="sel">${h}</g>`;
}

function draftSvg(hs, pal) {
  const st = `stroke="${pal.sel}" stroke-width="${r2(hs * 0.35)}"`;
  if (!draft) {
    if (!measureLine) return '';
    return measureSvg(measureLine.a, measureLine.b, hs, pal);
  }
  if (draft.type === 'rect') {
    const x = Math.min(draft.a[0], draft.b[0]);
    const y = Math.min(draft.a[1], draft.b[1]);
    const w = Math.abs(draft.b[0] - draft.a[0]);
    const h = Math.abs(draft.b[1] - draft.a[1]);
    const m = curMap();
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${pal.sel}" fill-opacity=".12" ${st} stroke-dasharray="${r2(hs)} ${r2(hs * 0.6)}"/>` +
      textSvg(x + w / 2, y + h + hs * 3, `${fmtM(w * m.scale)} × ${fmtM(h * m.scale)}`, hs * 2.4, pal.text, pal.halo);
  }
  if (draft.type === 'measure') return measureSvg(draft.a, draft.b, hs, pal);
  const p = draft.cursor ? [...draft.points, draft.cursor] : draft.points;
  let h = `<path d="M ${p.map((q) => q.map(r2).join(' ')).join(' L ')}${draft.type === 'poly' && p.length > 2 ? ' Z' : ''}" fill="${draft.type === 'poly' ? pal.sel : 'none'}" fill-opacity=".12" ${st}/>`;
  h += draft.points.map((q, i) => `<circle cx="${r2(q[0])}" cy="${r2(q[1])}" r="${r2(hs * (i === 0 ? 1.2 : 0.8))}" fill="${i === 0 ? pal.sel : pal.paper}" ${st}/>`).join('');
  return h;
}
function measureSvg(a, b, hs, pal) {
  const m = curMap();
  const d = dist(a, b);
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return `<line x1="${r2(a[0])}" y1="${r2(a[1])}" x2="${r2(b[0])}" y2="${r2(b[1])}" stroke="#c0504d" stroke-width="${r2(hs * 0.4)}" stroke-dasharray="${r2(hs * 1.2)} ${r2(hs * 0.6)}"/>` +
    `<circle cx="${r2(a[0])}" cy="${r2(a[1])}" r="${r2(hs * 0.6)}" fill="#c0504d"/><circle cx="${r2(b[0])}" cy="${r2(b[1])}" r="${r2(hs * 0.6)}" fill="#c0504d"/>` +
    textSvg(mid[0], mid[1] - hs * 2.5, `${fmtM(d * m.scale)}（${r2(d)}マス）`, hs * 2.6, '#c0504d', pal.halo, ' font-weight="700"');
}

function renderCanvas() {
  const m = curMap();
  if (!m) return;
  applyViewBox();
  const pal = palette(false);
  const v = view();
  const hs = 6 / v.s;
  let h = `<rect x="-10000" y="-10000" width="20000" height="20000" fill="${pal.back}" data-bg="1"/>`;
  h += mapSvgBody(m, floorId, pal);
  const s = shapeById(selId);
  if (s && s.floor === floorId) h += selectionSvg(s, hs, pal);
  h += draftSvg(hs, pal);
  svg.innerHTML = h;
  svg.setAttribute('class', `canvas tool-${tool}${armedPlace ? ' placing' : ''}${drag && drag.mode === 'pan' ? ' panning' : ''}`);
  renderHint();
}

function renderHint() {
  const m = curMap();
  let t = '';
  if (armedPlace) t = `「${armedPlace}」を置く場所を押してください（Esc でやめる）`;
  else if (tool === 'rect') t = 'ドラッグで四角を描きます（押しただけなら 4×3 マス）';
  else if (tool === 'poly') t = draft ? '次の点を押します。最初の点を押すか、ダブルクリック・Enter で完成。Backspace で1点戻す' : '多角形の角を順に押していきます';
  else if (tool === 'line') t = draft ? '次の点を押します。最後の点をもう一度押すか Enter で完成' : `線（${LINE_KINDS[ui.lineKind].label}）の点を順に押していきます`;
  else if (tool === 'symbol') t = `押したところに「${SYM_KINDS[ui.symKind]}」を置きます`;
  else if (tool === 'measure') t = 'ドラッグで距離をはかります';
  else t = '図形を押して選択・ドラッグで移動。何もないところをドラッグで地図を動かす／ホイールで拡大縮小。リンクのある建物はダブルクリックでその地図へ';
  const f = m.floors.find((x) => x.id === floorId);
  $('#hint').textContent = `${m.floors.length > 1 && f ? `［${f.name}］` : ''}${t}`;
  $('#hint').toggleAttribute('data-idle', tool === 'select' && !armedPlace);
}

/* ---------- 変更の記録・保存・元に戻す ---------- */

const undoStack = {};
const redoStack = {};
let editKey = null;
function snapshot() {
  const m = curMap();
  (undoStack[m.id] = undoStack[m.id] || []).push(JSON.stringify({ shapes: m.shapes, floors: m.floors }));
  if (undoStack[m.id].length > 80) undoStack[m.id].shift();
  redoStack[m.id] = [];
  updateUndoButtons();
}
function restore(from, to) {
  const m = curMap();
  const st = from[m.id];
  if (!st || !st.length) return;
  (to[m.id] = to[m.id] || []).push(JSON.stringify({ shapes: m.shapes, floors: m.floors }));
  const d = JSON.parse(st.pop());
  m.shapes = d.shapes;
  m.floors = d.floors;
  if (!m.floors.some((f) => f.id === floorId)) floorId = m.floors[0].id;
  if (!shapeById(selId)) selId = null;
  editKey = null;
  changed(true);
}
function updateUndoButtons() {
  const m = curMap();
  $('#undoBtn').disabled = !m || !(undoStack[m.id] || []).length;
  $('#redoBtn').disabled = !m || !(redoStack[m.id] || []).length;
}

let saveTimer = null;
let dirtyMap = null;
function changed(panel) {
  dirtyMap = curMap();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
  renderCanvas();
  if (panel) { renderPanel(); renderSidebar(); }
  updateUndoButtons();
}
async function flushSave() {
  clearTimeout(saveTimer);
  const m = dirtyMap;
  dirtyMap = null;
  if (!m) return;
  try {
    await MDB.putMap(m);
    MDB.notify({ type: 'map', id: m.id, workId: m.workId });
  } catch (err) {
    console.error(err);
    alert('保存できませんでした：' + err.message);
  }
}
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });

/* ---------- ポインター操作 ---------- */

const pointers = new Map();
let lastTap = { id: null, t: 0 };

function addShape(s) {
  snapshot();
  const m = curMap();
  m.shapes.push({ ...s, id: MDB.uid(), floor: floorId });
  selId = m.shapes[m.shapes.length - 1].id;
  if (tool !== 'select' && tool !== 'symbol') setTool('select', true);
  changed(true);
}
function nextColor() {
  const m = curMap();
  const n = m.shapes.filter((s) => s.type === 'rect' || s.type === 'poly').length;
  return SHAPE_COLORS[n % SHAPE_COLORS.length];
}
function finishDraft() {
  if (!draft || (draft.type !== 'poly' && draft.type !== 'line')) return;
  const p = draft.points;
  const type = draft.type;
  draft = null;
  if (type === 'poly' && p.length >= 3) addShape({ type: 'poly', points: p, color: nextColor(), name: '', memo: '', place: '', link: null });
  else if (type === 'line' && p.length >= 2) addShape({ type: 'line', points: p, kind: ui.lineKind, color: '', width: 0, name: '', memo: '', place: '' });
  else renderCanvas();
}

svg.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.pointerType === 'mouse') {
    if (e.button === 1) { startPan(e); e.preventDefault(); }
    return;
  }
  svg.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 2) {
    // 2本指：拡大縮小と移動
    const [a, b] = [...pointers.values()];
    const v = view();
    drag = { mode: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]), s0: v.s, mid0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], c0: [v.cx, v.cy] };
    draft = draft && draft.type === 'rect' ? null : draft;
    return;
  }
  const p = toWorld(e);
  measureLine = null;
  if (armedPlace) {
    const sp = snapP(p, snapStep());
    const place = armedPlace;
    setArmed(null);
    addShape({ type: 'pin', place, x: sp[0], y: sp[1], name: '', memo: '' });
    return;
  }
  if (tool === 'rect') { const a = snapP(p); draft = { type: 'rect', a, b: a }; drag = { mode: 'create' }; renderCanvas(); return; }
  if (tool === 'measure') { const a = snapP(p); draft = { type: 'measure', a, b: a }; drag = { mode: 'create' }; renderCanvas(); return; }
  if (tool === 'symbol') {
    const sp = snapP(p);
    addShape({ type: 'symbol', kind: ui.symKind, x: sp[0], y: sp[1], size: 1.5, rot: 0, name: '', memo: '', place: '', link: null });
    return;
  }
  if (tool === 'poly' || tool === 'line') {
    const sp = snapP(p);
    const hs = 6 / view().s;
    if (!draft) draft = { type: tool, points: [sp], cursor: sp };
    else {
      const first = draft.points[0];
      const last = draft.points[draft.points.length - 1];
      if (tool === 'poly' && draft.points.length >= 3 && dist(sp, first) <= hs * 2) { finishDraft(); return; }
      if (dist(sp, last) <= hs * 1.5) { finishDraft(); return; }
      draft.points.push(sp);
    }
    renderCanvas();
    return;
  }
  // 選択
  const hd = e.target.closest('[data-hd]');
  const sel = shapeById(selId);
  if (hd && sel) {
    snapshot();
    drag = { mode: 'handle', hd: hd.dataset.hd, id: sel.id, o: clone(sel), start: p };
    return;
  }
  const g = e.target.closest('.sh');
  if (g) {
    const id = g.dataset.id;
    const now = Date.now();
    if (lastTap.id === id && now - lastTap.t < 380) {
      lastTap = { id: null, t: 0 };
      const s = shapeById(id);
      if (s && s.link && maps.some((x) => x.id === s.link)) { openMap(s.link, { via: mapId }); return; }
    }
    lastTap = { id, t: now };
    const changedSel = selId !== id;
    selId = id;
    const s = shapeById(id);
    drag = { mode: 'move', id, o: clone(s), start: p, moved: false };
    renderCanvas();
    if (changedSel) renderPanel();
    return;
  }
  // 何もないところ：選択を外して地図を動かす
  if (selId) { selId = null; renderPanel(); }
  startPan(e);
});

function startPan(e) {
  const v = view();
  drag = { mode: 'pan', x0: e.clientX, y0: e.clientY, c0: [v.cx, v.cy] };
  renderCanvas();
}

svg.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (drag && drag.mode === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const v = view();
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    v.s = Math.max(2, Math.min(200, drag.s0 * d / drag.d0));
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    v.cx = drag.c0[0] - (mid[0] - drag.mid0[0]) / v.s;
    v.cy = drag.c0[1] - (mid[1] - drag.mid0[1]) / v.s;
    renderCanvas();
    return;
  }
  if (!drag) {
    if (draft && (draft.type === 'poly' || draft.type === 'line')) { draft.cursor = snapP(toWorld(e)); renderCanvas(); }
    return;
  }
  const p = toWorld(e);
  if (drag.mode === 'pan') {
    const v = view();
    v.cx = drag.c0[0] - (e.clientX - drag.x0) / v.s;
    v.cy = drag.c0[1] - (e.clientY - drag.y0) / v.s;
    applyViewBox();
    return;
  }
  if (drag.mode === 'create') { draft.b = snapP(p); renderCanvas(); return; }
  const s = shapeById(drag.id);
  if (!s) return;
  if (drag.mode === 'move') {
    const dx = snapV(p[0] - drag.start[0]);
    const dy = snapV(p[1] - drag.start[1]);
    if (!drag.moved && (dx || dy)) { drag.moved = true; snapshot(); }
    if (drag.moved) { moveShape(s, drag.o, dx, dy); renderCanvas(); }
    return;
  }
  if (drag.mode === 'handle') { dragHandle(s, drag, p, e.shiftKey); renderCanvas(); }
});

function dragHandle(s, d, p, shift) {
  const o = d.o;
  if (d.hd === 'rot') {
    const c = shapeCenter(o);
    let a = Math.atan2(p[1] - c[1], p[0] - c[0]) * 180 / Math.PI + 90;
    // 15度ごとに止める（Shift で自由に）
    if (!shift) a = Math.round(a / 15) * 15;
    a = ((Math.round(a) % 360) + 360) % 360;
    if (s.type === 'poly') {
      const a0 = d.a0 === undefined ? (d.a0 = Math.atan2(d.start[1] - c[1], d.start[0] - c[0]) * 180 / Math.PI + 90) : d.a0;
      let delta = Math.atan2(p[1] - c[1], p[0] - c[0]) * 180 / Math.PI + 90 - a0;
      if (!shift) delta = Math.round(delta / 15) * 15;
      s.points = o.points.map((q) => rot(q, c, delta).map(r2));
    } else s.rot = a > 180 ? a - 360 : a;
    return;
  }
  if (s.type === 'rect' && d.hd[0] === 'c') {
    const i = Number(d.hd.slice(1));
    const corners = rectCorners(o);
    const opp = corners[(i + 2) % 4];
    const q = o.rot ? p : snapP(p);
    const local = rot(q, opp, -(o.rot || 0));
    const w = Math.max(0.5, Math.abs(local[0] - opp[0]));
    const h = Math.max(0.5, Math.abs(local[1] - opp[1]));
    const sx = Math.sign(local[0] - opp[0]) || 1;
    const sy = Math.sign(local[1] - opp[1]) || 1;
    const farLocal = [opp[0] + sx * w, opp[1] + sy * h];
    const far = rot(farLocal, opp, o.rot || 0);
    const c = [(far[0] + opp[0]) / 2, (far[1] + opp[1]) / 2];
    s.w = r2(w);
    s.h = r2(h);
    s.x = r2(c[0] - w / 2);
    s.y = r2(c[1] - h / 2);
    return;
  }
  if (d.hd[0] === 'v') {
    const i = Number(d.hd.slice(1));
    s.points = o.points.map((q, j) => (j === i ? snapP(p) : q));
    return;
  }
  if (d.hd === 'scale') {
    const b = bboxOf(o.points);
    const q = snapP(p);
    const fx = Math.max(0.05, (q[0] - b.x0) / Math.max(0.01, b.x1 - b.x0));
    const fy = Math.max(0.05, (q[1] - b.y0) / Math.max(0.01, b.y1 - b.y0));
    s.points = o.points.map((pt) => [r2(b.x0 + (pt[0] - b.x0) * fx), r2(b.y0 + (pt[1] - b.y0) * fy)]);
    return;
  }
  if (d.hd === 'size') {
    const local = rot(p, [o.x, o.y], -(o.rot || 0));
    s.size = r2(Math.max(0.4, Math.max(local[0] - o.x, local[1] - o.y) / 0.6));
  }
}

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (!drag) return;
  const d = drag;
  if (d.mode === 'pinch') { if (pointers.size < 2) drag = null; return; }
  drag = null;
  if (d.mode === 'pan') { renderCanvas(); return; }
  if (d.mode === 'create') {
    const dr = draft;
    draft = null;
    if (dr.type === 'measure') {
      if (dist(dr.a, dr.b) > 0.01) measureLine = { a: dr.a, b: dr.b };
      renderCanvas();
      return;
    }
    let x = Math.min(dr.a[0], dr.b[0]);
    let y = Math.min(dr.a[1], dr.b[1]);
    let w = Math.abs(dr.b[0] - dr.a[0]);
    let h = Math.abs(dr.b[1] - dr.a[1]);
    if (w < 0.5 || h < 0.5) { w = 4; h = 3; x = dr.a[0]; y = dr.a[1]; }
    addShape({ type: 'rect', x: r2(x), y: r2(y), w: r2(w), h: r2(h), rot: 0, color: nextColor(), name: '', memo: '', place: '', link: null });
    return;
  }
  if ((d.mode === 'move' && d.moved) || d.mode === 'handle') changed(true);
}
svg.addEventListener('pointerup', endPointer);
svg.addEventListener('pointercancel', endPointer);

svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const v = view();
  if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.5 && e.deltaMode === 0 && Math.abs(e.deltaX) > 0) {
    // トラックパッドの2本指スクロールは移動
    v.cx += e.deltaX / v.s;
    v.cy += e.deltaY / v.s;
    applyViewBox();
    return;
  }
  const p = toWorld(e);
  const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
  zoomAt(p, f);
}, { passive: false });

function zoomAt(p, f) {
  const v = view();
  const ns = Math.max(2, Math.min(200, v.s * f));
  v.cx = p[0] - (p[0] - v.cx) * v.s / ns;
  v.cy = p[1] - (p[1] - v.cy) * v.s / ns;
  v.s = ns;
  renderCanvas();
}
$('#zoomIn').addEventListener('click', () => { const v = view(); zoomAt([v.cx, v.cy], 1.25); });
$('#zoomOut').addEventListener('click', () => { const v = view(); zoomAt([v.cx, v.cy], 0.8); });
$('#zoomFit').addEventListener('click', () => { fitView(curMap()); renderCanvas(); });
new ResizeObserver(() => { if (curMap() && !$('#stage').hidden) renderCanvas(); }).observe(wrap);

// 年表の場所を一覧からドラッグして置く
wrap.addEventListener('dragover', (e) => {
  if (![...e.dataTransfer.types].includes('text/x-place')) return;
  e.preventDefault();
  wrap.classList.add('drop');
});
wrap.addEventListener('dragleave', () => wrap.classList.remove('drop'));
wrap.addEventListener('drop', (e) => {
  wrap.classList.remove('drop');
  const place = e.dataTransfer.getData('text/x-place');
  if (!place || !curMap()) return;
  e.preventDefault();
  const p = snapP(toWorld(e));
  setArmed(null);
  addShape({ type: 'pin', place, x: p[0], y: p[1], name: '', memo: '' });
});

document.addEventListener('keydown', (e) => {
  if (!curMap() || document.querySelector('dialog[open]')) return;
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !inField) { e.preventDefault(); if (e.shiftKey) restore(redoStack, undoStack); else restore(undoStack, redoStack); return; }
  if (mod && e.key.toLowerCase() === 'y' && !inField) { e.preventDefault(); restore(redoStack, undoStack); return; }
  if (inField) return;
  if (e.key === 'Escape') {
    if (armedPlace) setArmed(null);
    else if (draft) { draft = null; renderCanvas(); }
    else if (selId) { selId = null; renderCanvas(); renderPanel(); }
    return;
  }
  if (e.key === 'Enter' && draft) { e.preventDefault(); finishDraft(); return; }
  if (e.key === 'Backspace' && draft && draft.points) {
    e.preventDefault();
    draft.points.pop();
    if (!draft.points.length) draft = null;
    renderCanvas();
    return;
  }
  const s = shapeById(selId);
  if ((e.key === 'Delete' || e.key === 'Backspace') && s) { e.preventDefault(); deleteSelected(); return; }
  if (mod && e.key.toLowerCase() === 'd' && s) { e.preventDefault(); duplicateSelected(); return; }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key] && s) {
    e.preventDefault();
    const step = (snapStep() || 0.1) * (e.shiftKey ? 5 : 1);
    if (editKey !== 'nudge' + s.id) { snapshot(); editKey = 'nudge' + s.id; }
    moveShape(s, clone(s), arrows[e.key][0] * step, arrows[e.key][1] * step);
    changed(false);
    return;
  }
  if (mod || e.altKey) return;
  const keys = { v: 'select', r: 'rect', p: 'poly', l: 'line', s: 'symbol', m: 'measure' };
  if (keys[e.key.toLowerCase()]) setTool(keys[e.key.toLowerCase()]);
});

function deleteSelected() {
  const m = curMap();
  snapshot();
  m.shapes = m.shapes.filter((x) => x.id !== selId);
  selId = null;
  changed(true);
}
function duplicateSelected() {
  const s = shapeById(selId);
  if (!s) return;
  const c = clone(s);
  moveShape(c, clone(s), 1, 1);
  delete c.id;
  addShape(c);
}

/* ---------- 道具 ---------- */

function setTool(t, keepDraft) {
  tool = t;
  if (!keepDraft) draft = null;
  measureLine = null;
  if (t !== 'select' && armedPlace) setArmed(null);
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  $('#lineKind').hidden = t !== 'line';
  $('#symKind').hidden = t !== 'symbol';
  renderCanvas();
}
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#lineKind').innerHTML = Object.entries(LINE_KINDS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
$('#symKind').innerHTML = Object.entries(SYM_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
$('#lineKind').value = LINE_KINDS[ui.lineKind] ? ui.lineKind : 'road';
$('#symKind').value = SYM_KINDS[ui.symKind] ? ui.symKind : 'gate';
$('#lineKind').addEventListener('change', (e) => { ui.lineKind = e.target.value; saveUI(); renderHint(); });
$('#symKind').addEventListener('change', (e) => { ui.symKind = e.target.value; saveUI(); renderHint(); });
$('#snapSel').value = String(ui.snap);
$('#snapSel').addEventListener('change', (e) => { ui.snap = Number(e.target.value); saveUI(); });
$('#undoBtn').addEventListener('click', () => restore(undoStack, redoStack));
$('#redoBtn').addEventListener('click', () => restore(redoStack, undoStack));

/* =========================================================
   右の詳細（選んだ図形の設定と、年表のできごと）
   ========================================================= */

const panel = $('#panel');

function placesInfo() {
  const counts = new Map();
  for (const ev of tl.events) if (ev.place) counts.set(ev.place, (counts.get(ev.place) || 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}
function usedPlaces() {
  const set = new Set();
  for (const m of maps) for (const s of m.shapes) if (s.place) set.add(s.place);
  return set;
}

function sideOf(w, date, time) {
  if (!w || !w.origin || date < w.origin) return 'common';
  if (date > w.origin) return 'route';
  if (w.originTime && time && time < w.originTime) return 'common';
  return 'route';
}
function eventsHtml(place) {
  const w = tl.work;
  if (!w) return '<p class="note">「作品の設定」で年表を選ぶと、この場所のできごとが出ます。</p>';
  const filter = ui.partFilter[workId] || '';
  const parts = Array.isArray(w.parts) ? w.parts : [];
  const list = tl.events.filter((ev) => ev.place === place && (!filter || (ev.parts || []).includes(filter)))
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || '') || ((a.created || 0) - (b.created || 0)));
  const total = tl.events.filter((ev) => ev.place === place).length;
  let h = `<h4>年表のできごと（${list.length}${filter ? `／${total}` : ''}件）</h4>`;
  h += `<label class="fld"><span>部で絞り込み</span><select data-act="partFilter"><option value="">すべての部</option>${parts.map((p) => `<option value="${esc(p.id)}"${filter === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>`;
  if (!list.length) return h + `<p class="note">${total ? 'この部では、この場所のできごとはありません。' : 'この場所が登録されたできごとはまだありません。'}</p>`;
  h += '<ul class="ev-list">' + list.map((ev) => {
    const side = sideOf(w, ev.date, ev.time);
    const evParts = (ev.parts || []).map((id) => parts.find((p) => p.id === id)).filter(Boolean);
    const color = evParts.length === 1 ? evParts[0].color : '';
    const wi = wdIndex(ev.date);
    const notes = evParts.filter((p) => (!filter || p.id === filter) && ev.partNotes && ev.partNotes[p.id])
      .map((p) => `<div class="pnote" style="--c:${esc(p.color)}"><b>${esc(p.name)}：</b>${esc(ev.partNotes[p.id])}</div>`).join('');
    return `<li class="ev-item"${color ? ` style="--c:${esc(color)}"` : ''}>
      <div class="when">${esc((ev.date || '').replace(/-/g, '/'))}<span class="wd-${wi}">（${WD[wi] || ''}）</span>${ev.time ? ' ' + esc(ev.time) : ''}　${side === 'common' ? '共通' : 'ルート'}</div>
      <div class="tt">${esc(ev.text)}</div>
      ${(ev.people || []).length ? `<div class="meta">${ev.people.map((p) => `<span class="person">${esc(p)}</span>`).join('')}</div>` : ''}
      ${evParts.length ? `<div class="marks">${evParts.map((p) => `<span class="mark${side === 'route' ? ' route' : ''}" style="--c:${esc(p.color)}">${side === 'route' ? '' : '描写：'}${esc(p.name)}</span>`).join('')}</div>` : ''}
      ${notes}
    </li>`;
  }).join('') + '</ul>';
  return h + `<p class="note"><a href="../timeline/?work=${encodeURIComponent(w.id)}">年表ツールで開く</a></p>`;
}

function colorField(s) {
  return `<div class="fld"><span>色</span><div class="swatches">${SHAPE_COLORS.map((c) => `<button type="button" data-color="${c}" style="background:${c}" class="${s.color === c ? 'on' : ''}" aria-label="${c}"></button>`).join('')}
    <input type="color" data-f="color" value="${esc(/^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#cccccc')}" aria-label="ほかの色"></div></div>`;
}
function linkField(s) {
  const others = maps.filter((m) => m.id !== mapId);
  return `<div class="fld"><span>リンク先の地図（詳しい地図へ移動）</span>
    <select data-f="link"><option value="">なし</option>${others.map((m) => `<option value="${esc(m.id)}"${s.link === m.id ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
    <div class="btn-row">${s.link && maps.some((m) => m.id === s.link) ? `<button type="button" class="btn small primary" data-act="openLink">「${esc(mapName(s.link))}」を開く</button>` : ''}
    <button type="button" class="btn small" data-act="newLinked">＋ 新しい地図を作ってリンク</button></div></div>`;
}
function placeField(s) {
  return `<label class="fld"><span>年表の場所${s.type === 'pin' ? '' : '（任意）'}</span><input type="text" data-f="place" list="placeDl" value="${esc(s.place)}" autocomplete="off" placeholder="年表に登録した場所の名前"></label>`;
}
function floorField(s) {
  const m = curMap();
  if (m.floors.length < 2) return '';
  return `<label class="fld"><span>階</span><select data-f="floor">${m.floors.map((f) => `<option value="${esc(f.id)}"${s.floor === f.id ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>`;
}

function renderPanel() {
  const m = curMap();
  if (!m) { panel.innerHTML = ''; return; }
  const s = shapeById(selId);
  const sc = m.scale;
  if (!s) {
    const parents = maps.filter((x) => x.shapes.some((sh) => sh.link === m.id));
    panel.innerHTML = `<h3>${esc(m.name)}</h3>
      <p class="note">${m.width}×${m.height}マス（${fmtM(m.width * sc)} × ${fmtM(m.height * sc)}）／1マス＝${fmtM(sc)}${m.floors.length > 1 ? `／${m.floors.length}階分` : ''}</p>
      ${parents.length ? `<h4>この地図へのリンク元</h4><ul class="parents">${parents.map((p) => `<li><button type="button" class="linkish" data-open="${esc(p.id)}">${esc(p.name)}</button></li>`).join('')}</ul>` : ''}
      <h4>使い方</h4>
      <p class="note">上の道具で、四角・多角形（建物や部屋）、線（道・塀・堀・川など）、記号（門・扉・階段など）を描きます。図形を押すと、ここで名前・色・メモ・リンク先の地図・年表の場所を設定できます。左の「年表の場所」から、場所を地図に置けます。</p>`;
    return;
  }
  let h = `<h3>${esc(s.name || s.place || TYPE_LABEL[s.type])}<span class="kind">${TYPE_LABEL[s.type]}${s.type === 'line' ? `・${LINE_KINDS[s.kind].label}` : s.type === 'symbol' ? `・${SYM_KINDS[s.kind]}` : ''}</span></h3>`;
  if (s.type !== 'pin') h += `<label class="fld"><span>名前</span><input type="text" data-f="name" value="${esc(s.name)}" autocomplete="off"></label>`;
  if (s.type === 'rect') {
    h += `<div class="fld-row"><label class="fld"><span>横（マス）</span><input type="number" data-f="w" step="0.5" min="0.5" value="${s.w}"></label>
      <label class="fld"><span>縦（マス）</span><input type="number" data-f="h" step="0.5" min="0.5" value="${s.h}"></label>
      <label class="fld"><span>回転（度）</span><input type="number" data-f="rot" step="15" value="${s.rot || 0}"></label></div>
      <p class="measure">${fmtM(s.w * sc)} × ${fmtM(s.h * sc)}（約${r2(s.w * s.h * sc * sc)} ㎡）</p>`;
  } else if (s.type === 'poly') {
    const b = bboxOf(s.points);
    h += `<p class="measure">幅 ${fmtM((b.x1 - b.x0) * sc)} × 奥行 ${fmtM((b.y1 - b.y0) * sc)}（約${r2(polyArea(s.points) * sc * sc)} ㎡）・角 ${s.points.length}</p>`;
  } else if (s.type === 'line') {
    h += `<label class="fld"><span>種類</span><select data-f="kind">${Object.entries(LINE_KINDS).map(([k, v]) => `<option value="${k}"${s.kind === k ? ' selected' : ''}>${v.label}</option>`).join('')}</select></label>
      <label class="fld"><span>太さ（マス。0 で種類のめやす：${LINE_KINDS[s.kind].width}）</span><input type="number" data-f="width" step="0.1" min="0" value="${s.width || 0}"></label>
      <p class="measure">長さ ${fmtM(polyLen(s.points) * sc)}</p>`;
  } else if (s.type === 'symbol') {
    h += `<label class="fld"><span>種類</span><select data-f="kind">${Object.entries(SYM_KINDS).map(([k, v]) => `<option value="${k}"${s.kind === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      <div class="fld-row"><label class="fld"><span>大きさ（マス）</span><input type="number" data-f="size" step="0.5" min="0.5" value="${s.size}"></label>
      <label class="fld"><span>向き（度）</span><input type="number" data-f="rot" step="15" value="${s.rot || 0}"></label></div>`;
  }
  if (s.type === 'rect' || s.type === 'poly') h += colorField(s);
  if (s.type === 'line') h += `<div class="fld"><span>色</span><div class="inline"><input type="color" data-f="color" value="${esc(s.color || LINE_KINDS[s.kind].color)}" aria-label="線の色"><button type="button" class="btn small" data-act="lineColorReset">種類の色に戻す</button></div></div>`;
  h += `<label class="fld"><span>メモ</span><textarea data-f="memo" rows="3">${esc(s.memo)}</textarea></label>`;
  if (s.type === 'rect' || s.type === 'poly' || s.type === 'symbol') h += linkField(s);
  if (s.type !== 'line') h += placeField(s);
  h += floorField(s);
  h += `<div class="btn-row"><button type="button" class="btn small" data-act="dup">複製</button>
    <button type="button" class="btn small" data-act="front">前面へ</button><button type="button" class="btn small" data-act="back">背面へ</button>
    <button type="button" class="btn small danger" data-act="del">削除</button></div>`;
  if (s.place) h += eventsHtml(s.place);
  panel.innerHTML = h;
}

panel.addEventListener('input', (e) => {
  const f = e.target.dataset.f;
  const s = shapeById(selId);
  if (!f || !s) return;
  if (editKey !== f + s.id) { snapshot(); editKey = f + s.id; }
  let v = e.target.value;
  if (['w', 'h', 'rot', 'size', 'width'].includes(f)) {
    v = Number(v);
    if (!isFinite(v) || (f !== 'rot' && v < 0) || ((f === 'w' || f === 'h' || f === 'size') && v <= 0)) return;
    if (f === 'w' || f === 'h') {
      // 中心を変えずに大きさを変える
      const c = shapeCenter(s);
      s[f] = v;
      s.x = r2(c[0] - s.w / 2);
      s.y = r2(c[1] - s.h / 2);
      changed(false);
      return;
    }
  }
  if (f === 'link') v = v || null;
  s[f] = v;
  changed(false);
  if (e.target.tagName === 'SELECT' || f === 'place') {
    if (f === 'floor') { selId = null; }
    renderPanel();
    if (f === 'place') { const inp = panel.querySelector('[data-f="place"]'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }
    renderSidebar();
  }
});
panel.addEventListener('change', (e) => {
  // 数値欄などの入力が終わったら表示を整える
  if (e.target.dataset.f && e.target.tagName === 'INPUT' && e.target.type !== 'text') renderPanel();
  if (e.target.dataset.act === 'partFilter') { ui.partFilter[workId] = e.target.value; saveUI(); renderPanel(); }
  editKey = null;
});
panel.addEventListener('click', async (e) => {
  const open = e.target.closest('[data-open]');
  if (open) { openMap(open.dataset.open); return; }
  const sw = e.target.closest('[data-color]');
  const s = shapeById(selId);
  if (sw && s) { snapshot(); s.color = sw.dataset.color; changed(true); return; }
  const b = e.target.closest('[data-act]');
  if (!b || !s || b.tagName === 'SELECT') return;
  const m = curMap();
  const act = b.dataset.act;
  if (act === 'del') deleteSelected();
  else if (act === 'dup') duplicateSelected();
  else if (act === 'front' || act === 'back') {
    snapshot();
    m.shapes = m.shapes.filter((x) => x !== s);
    if (act === 'front') m.shapes.push(s); else m.shapes.unshift(s);
    changed(true);
  } else if (act === 'lineColorReset') { snapshot(); s.color = ''; changed(true); }
  else if (act === 'openLink') openMap(s.link, { via: mapId });
  else if (act === 'newLinked') {
    const nm = await createMap({ name: s.name ? `${s.name}の中` : '新しい地図', scale: Math.max(0.1, r2(m.scale / 4)) });
    if (!nm) return;
    snapshot();
    s.link = nm.id;
    changed(true);
  }
});

/* =========================================================
   左の一覧（地図・年表の場所）
   ========================================================= */

function renderSidebar() {
  // 地図：リンクでつながった地図を入れ子にして並べる
  const linked = new Map(maps.map((m) => [m.id, uniqLinks(m)]));
  const childOf = new Set([...linked.values()].flat());
  const roots = maps.filter((m) => !childOf.has(m.id));
  const seen = new Set();
  const item = (m) => {
    if (seen.has(m.id)) return '';
    seen.add(m.id);
    const kids = (linked.get(m.id) || []).map((id) => maps.find((x) => x.id === id)).filter(Boolean).map(item).join('');
    return `<li><button type="button" class="map-item${m.id === mapId ? ' current' : ''}" data-map="${esc(m.id)}">${esc(m.name)}${m.floors.length > 1 ? `<span class="sub">${m.floors.length}階</span>` : ''}</button>${kids ? `<ul>${kids}</ul>` : ''}</li>`;
  };
  let h = roots.map(item).join('');
  h += maps.filter((m) => !seen.has(m.id)).map(item).join(''); // 輪になっているもの
  $('#mapList').innerHTML = h || '<li class="note">まだ地図がありません。</li>';

  const note = $('#placesNote');
  const list = $('#placeList');
  if (!tl.work) {
    note.textContent = tl.works.length ? '「作品の設定」で連動する年表を選ぶと、年表に登録した場所が出ます。' : '年表ツールで場所を登録すると、ここに出ます。';
    list.innerHTML = '';
  } else {
    const places = placesInfo();
    const used = usedPlaces();
    note.textContent = places.length ? `「${tl.work.title}」の場所。「置く」を押してから地図を押すか、地図へドラッグします。` : `年表「${tl.work.title}」には、まだ場所が登録されていません。`;
    list.innerHTML = places.map((p) => `<li class="place-row${armedPlace === p.name ? ' armed' : ''}">
      <button type="button" class="place-name" draggable="true" data-place="${esc(p.name)}" title="${used.has(p.name) ? '地図の上の場所を表示' : '地図へドラッグして置けます'}">${esc(p.name)}<span class="cnt">${p.count}件</span>${used.has(p.name) ? '<span class="on-map">●地図あり</span>' : ''}</button>
      <button type="button" class="btn small" data-arm="${esc(p.name)}">${armedPlace === p.name ? 'やめる' : '置く'}</button></li>`).join('');
  }
  $('#placeDl').innerHTML = placesInfo().map((p) => `<option value="${esc(p.name)}"></option>`).join('');
}
function uniqLinks(m) { return [...new Set(m.shapes.map((s) => s.link).filter((id) => id && id !== m.id && maps.some((x) => x.id === id)))]; }

$('#mapList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-map]');
  if (!b) return;
  openMap(b.dataset.map);
  document.body.classList.remove('drawer-open');
});
$('#placeList').addEventListener('click', (e) => {
  const arm = e.target.closest('[data-arm]');
  if (arm) {
    setArmed(armedPlace === arm.dataset.arm ? null : arm.dataset.arm);
    if (armedPlace) document.body.classList.remove('drawer-open');
    return;
  }
  const nm = e.target.closest('[data-place]');
  if (!nm) return;
  // 地図に置いてあれば、その図形を表示する（なければ置く準備）
  const name = nm.dataset.place;
  const here = (m) => m.shapes.find((s) => s.place === name);
  const target = (curMap() && here(curMap()) ? curMap() : maps.find(here));
  if (target) {
    const s = here(target);
    if (target.id !== mapId) openMap(target.id);
    floorId = s.floor;
    selId = s.id;
    const v = view();
    [v.cx, v.cy] = shapeCenter(s);
    renderFloors();
    renderCanvas();
    renderPanel();
    document.body.classList.remove('drawer-open');
  } else {
    setArmed(name);
    document.body.classList.remove('drawer-open');
  }
});
$('#placeList').addEventListener('dragstart', (e) => {
  const nm = e.target.closest('[data-place]');
  if (!nm) return;
  e.dataTransfer.setData('text/x-place', nm.dataset.place);
  e.dataTransfer.setData('text/plain', nm.dataset.place);
  e.dataTransfer.effectAllowed = 'copy';
});
function setArmed(name) {
  armedPlace = name;
  if (name && tool !== 'select') setTool('select');
  renderSidebar();
  if (curMap()) renderCanvas();
}
$('#menuBtn').addEventListener('click', () => document.body.classList.toggle('drawer-open'));
$('#scrim').addEventListener('click', () => document.body.classList.remove('drawer-open'));

/* =========================================================
   作品・地図・階
   ========================================================= */

function urlParams() { const u = new URLSearchParams(location.search); return { work: u.get('work'), map: u.get('map') }; }
function setUrl(push) {
  const u = new URL(location.href);
  if (workId) u.searchParams.set('work', workId); else u.searchParams.delete('work');
  if (mapId) u.searchParams.set('map', mapId); else u.searchParams.delete('map');
  if (u.href !== location.href) window.history[push ? 'pushState' : 'replaceState'](null, '', u.href);
}

async function loadWorks() { works = await MDB.works(); }
async function loadTimeline() {
  try {
    tl.works = await TLR.works();
  } catch (e) { console.error(e); tl.works = []; }
  const w = curWork();
  tl.work = w && w.timelineWorkId ? tl.works.find((x) => x.id === w.timelineWorkId) || null : null;
  try {
    tl.events = tl.work ? await TLR.events(tl.work.id) : [];
  } catch (e) { console.error(e); tl.events = []; }
}

async function openWork(id, push) {
  await flushSave();
  const w = works.find((x) => x.id === id) || works.find((x) => x.id === ui.lastWork) || works[0] || null;
  workId = w ? w.id : null;
  maps = w ? (await MDB.maps(w.id)).map(normMap) : [];
  ui.lastWork = workId;
  saveUI();
  navStack = [];
  selId = null;
  draft = null;
  setArmed(null);
  await loadTimeline();
  const want = urlParams().map;
  const m = maps.find((x) => x.id === want) || maps.find((x) => x.id === (ui.lastMap || {})[workId]) || maps[0] || null;
  mapId = m ? m.id : null;
  floorId = m ? m.floors[0].id : null;
  setUrl(push);
  renderAll();
}

function openMap(id, opt = {}) {
  const m = maps.find((x) => x.id === id);
  if (!m) return;
  flushSave();
  if (opt.via) navStack.push(opt.via);
  else if (!opt.back) navStack = [];
  mapId = m.id;
  floorId = m.floors[0].id;
  selId = null;
  draft = null;
  measureLine = null;
  ui.lastMap = { ...(ui.lastMap || {}), [workId]: mapId };
  saveUI();
  setUrl(true);
  renderAll();
}
$('#backBtn').addEventListener('click', () => {
  const id = navStack.pop();
  if (id) openMap(id, { back: true });
});

function renderFloors() {
  const m = curMap();
  $('#floorTabs').innerHTML = m.floors.map((f) => `<button type="button" data-floor="${esc(f.id)}" class="${f.id === floorId ? 'on' : ''}">${esc(f.name)}</button>`).join('');
  $('#floorTabs').hidden = m.floors.length < 2;
}
$('#floorTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-floor]');
  if (!b) return;
  floorId = b.dataset.floor;
  selId = null;
  draft = null;
  renderFloors();
  renderCanvas();
  renderPanel();
});
$('#addFloor').addEventListener('click', () => {
  const m = curMap();
  snapshot();
  const n = m.floors.length + 1;
  const f = { id: MDB.uid(), name: `${n}階` };
  m.floors.push(f);
  floorId = f.id;
  selId = null;
  renderFloors();
  changed(true);
});

function renderAll() {
  const w = curWork();
  $('#workSel').innerHTML = works.map((x) => `<option value="${esc(x.id)}">${esc(x.title || '無題')}</option>`).join('') || '<option value="">（作品がありません）</option>';
  $('#workSel').value = workId || '';
  $('#timelineLink').href = tl.work ? `../timeline/?work=${encodeURIComponent(tl.work.id)}` : '../timeline/';
  for (const id of ['#workSettings', '#exportJson']) $(id).disabled = !w;
  $('#exportPng').disabled = !curMap();
  $('#addMap').disabled = !w;
  const m = curMap();
  document.title = m ? `${m.name} — 配置図` : '配置図ツール';
  $('#stage').hidden = !m;
  $('#empty').hidden = !!m;
  if (!w) {
    $('#emptyMsg').textContent = 'まだ作品がありません。';
    $('#emptyAction').textContent = '＋ 作品を作る';
    $('#emptyAction').onclick = () => openWorkDialog(null);
  } else if (!m) {
    $('#emptyMsg').textContent = `「${w.title}」には、まだ地図がありません。`;
    $('#emptyAction').textContent = '＋ 地図を作る';
    $('#emptyAction').onclick = () => createMap({});
  }
  renderSidebar();
  if (m) {
    const back = navStack.length ? maps.find((x) => x.id === navStack[navStack.length - 1]) : null;
    $('#backBtn').hidden = !back;
    if (back) $('#backBtn').textContent = `← ${back.name}`;
    renderFloors();
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
    renderCanvas();
    updateUndoButtons();
  }
  renderPanel();
}

$('#workSel').addEventListener('change', (e) => openWork(e.target.value, true));
window.addEventListener('popstate', () => {
  const p = urlParams();
  if (p.work && p.work !== workId) openWork(p.work);
  else if (p.map && p.map !== mapId) openMap(p.map, { back: true });
});

/* ---------- 作品の設定 ---------- */

let editingWork = null;
function openWorkDialog(w) {
  editingWork = w;
  $('#workTitle').textContent = w ? '作品の設定' : '新しい作品';
  $('#workDelete').hidden = !w;
  const sel = $('#workTimeline');
  sel.innerHTML = '<option value="">（連動しない）</option>' + tl.works.map((x) => `<option value="${esc(x.id)}">${esc(x.title || '無題')}</option>`).join('');
  sel.value = w ? (w.timelineWorkId || '') : (tl.works[0] ? tl.works[0].id : '');
  $('#workName').value = w ? w.title : (tl.works[0] ? tl.works[0].title : '');
  $('#workDialog').showModal();
}
$('#workTimeline').addEventListener('change', (e) => {
  // 新しい作品で名前が空なら、年表の名前を入れる
  const t = tl.works.find((x) => x.id === e.target.value);
  if (!editingWork && t && !$('#workName').value.trim()) $('#workName').value = t.title;
});
$('#newWork').addEventListener('click', async () => { await loadTimeline(); openWorkDialog(null); });
$('#workSettings').addEventListener('click', async () => { await loadTimeline(); openWorkDialog(curWork()); });
$('#workForm').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const title = $('#workName').value.trim();
  if (!title) return;
  const tid = $('#workTimeline').value || null;
  const w = editingWork
    ? { ...editingWork, title, timelineWorkId: tid }
    : { id: MDB.uid(), title, timelineWorkId: tid, order: works.reduce((m, x) => Math.max(m, x.order), -1) + 1, created: Date.now() };
  await MDB.putWork(w);
  MDB.notify({ type: 'works' });
  $('#workDialog').close();
  await loadWorks();
  if (editingWork) {
    await loadTimeline();
    renderAll();
  } else {
    await openWork(w.id, true);
    await createMap({ name: '全体図' });
  }
});
$('#workDelete').addEventListener('click', async () => {
  const w = editingWork;
  if (!w || !confirm(`作品「${w.title}」と、その地図${maps.length}枚をすべて削除しますか？\n（元に戻せません。必要なら先に書き出してください）\n※年表ツールのデータは消えません。`)) return;
  await MDB.deleteWork(w.id);
  MDB.notify({ type: 'works' });
  $('#workDialog').close();
  await loadWorks();
  await openWork(null);
});

/* ---------- 地図の設定 ---------- */

let mapEdit = null; // { map, floors, resolve }
function createMap(preset) {
  return openMapDialog(null, preset);
}
function openMapDialog(m, preset = {}) {
  return new Promise((resolve) => {
    const base = m || { name: preset.name || (maps.length ? '新しい地図' : '全体図'), width: preset.width || 40, height: preset.height || 30, scale: preset.scale || 2, floors: [{ id: MDB.uid(), name: '1階' }] };
    mapEdit = { map: m, floors: clone(base.floors), resolve };
    $('#mapTitle').textContent = m ? '地図の設定' : '新しい地図';
    $('#mapName').value = base.name;
    $('#mapW').value = base.width;
    $('#mapH').value = base.height;
    $('#mapScale').value = base.scale;
    $('#mapDelete').hidden = !m;
    renderFloorRows();
    updateSizeNote();
    $('#mapDialog').returnValue = '';
    $('#mapDialog').showModal();
    $('#mapDialog').addEventListener('close', () => { if (mapEdit && mapEdit.resolve === resolve) { mapEdit = null; resolve(null); } }, { once: true });
  });
}
function updateSizeNote() {
  const w = Number($('#mapW').value);
  const h = Number($('#mapH').value);
  const sc = Number($('#mapScale').value);
  $('#mapSizeNote').textContent = w > 0 && h > 0 && sc > 0 ? `地図の広さ：${fmtM(w * sc)} × ${fmtM(h * sc)}` : '';
}
for (const id of ['#mapW', '#mapH', '#mapScale']) $(id).addEventListener('input', updateSizeNote);
function renderFloorRows() {
  const fs = mapEdit.floors;
  $('#floorRows').innerHTML = fs.map((f, i) => `<div class="floor-row" data-i="${i}">
    <input type="text" value="${esc(f.name)}" aria-label="階の名前" required>
    <button type="button" class="icon-btn" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="下の階へ">↑</button>
    <button type="button" class="icon-btn" data-act="down" ${i === fs.length - 1 ? 'disabled' : ''} aria-label="上の階へ">↓</button>
    <button type="button" class="icon-btn" data-act="del" ${fs.length < 2 ? 'disabled' : ''} aria-label="この階を削除">✕</button></div>`).join('');
}
$('#floorRows').addEventListener('input', (e) => {
  const row = e.target.closest('.floor-row');
  if (row) mapEdit.floors[Number(row.dataset.i)].name = e.target.value;
});
$('#floorRows').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const i = Number(b.closest('.floor-row').dataset.i);
  const fs = mapEdit.floors;
  if (b.dataset.act === 'up' && i > 0) [fs[i - 1], fs[i]] = [fs[i], fs[i - 1]];
  else if (b.dataset.act === 'down' && i < fs.length - 1) [fs[i + 1], fs[i]] = [fs[i], fs[i + 1]];
  else if (b.dataset.act === 'del' && fs.length > 1) {
    const n = mapEdit.map ? mapEdit.map.shapes.filter((s) => s.floor === fs[i].id).length : 0;
    if (n && !confirm(`「${fs[i].name}」に描いた図形${n}個も削除されます（保存したとき）。よろしいですか？`)) return;
    fs.splice(i, 1);
  }
  renderFloorRows();
});
$('#floorAddRow').addEventListener('click', () => {
  mapEdit.floors.push({ id: MDB.uid(), name: `${mapEdit.floors.length + 1}階` });
  renderFloorRows();
});
$('#mapForm').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  if (!$('#mapForm').reportValidity()) return;
  const floors = mapEdit.floors.map((f) => ({ id: f.id, name: f.name.trim() || '階' }));
  const vals = { name: $('#mapName').value.trim(), width: Math.round(Number($('#mapW').value)), height: Math.round(Number($('#mapH').value)), scale: Number($('#mapScale').value), floors };
  const { map: old, resolve } = mapEdit;
  mapEdit = null;
  $('#mapDialog').close();
  if (old) {
    if (old.id === mapId) snapshot();
    Object.assign(old, vals);
    old.shapes = old.shapes.filter((s) => floors.some((f) => f.id === s.floor));
    if (!floors.some((f) => f.id === floorId)) floorId = floors[0].id;
    if (!shapeById(selId)) selId = null;
    fitView(old);
    dirtyMap = old;
    await flushSave();
    renderAll();
    resolve(old);
  } else {
    const m = { id: MDB.uid(), workId, ...vals, shapes: [], order: maps.reduce((a, x) => Math.max(a, x.order), -1) + 1, created: Date.now() };
    await MDB.putMap(m);
    MDB.notify({ type: 'map', id: m.id, workId });
    maps.push(m);
    const via = mapId;
    resolve(m);
    openMap(m.id, via ? { via } : {});
  }
});
$('#mapDelete').addEventListener('click', async () => {
  const m = mapEdit && mapEdit.map;
  if (!m) return;
  const refs = maps.filter((x) => x !== m && x.shapes.some((s) => s.link === m.id));
  if (!confirm(`地図「${m.name}」を削除しますか？${refs.length ? `\n${refs.map((x) => `「${x.name}」`).join('')}からのリンクも外れます。` : ''}`)) return;
  const resolve = mapEdit.resolve;
  mapEdit = null;
  $('#mapDialog').close();
  await MDB.deleteMap(m.id);
  for (const x of refs) {
    x.shapes.forEach((s) => { if (s.link === m.id) s.link = null; });
    await MDB.putMap(x);
  }
  maps = maps.filter((x) => x !== m);
  delete undoStack[m.id];
  MDB.notify({ type: 'map', id: m.id, workId });
  navStack = navStack.filter((id) => id !== m.id);
  resolve(null);
  if (maps.length) openMap(navStack.pop() || maps[0].id, { back: true });
  else { mapId = null; setUrl(false); renderAll(); }
});
$('#addMap').addEventListener('click', () => createMap({}));
$('#mapSettings').addEventListener('click', () => openMapDialog(curMap()));

/* =========================================================
   書き出し・読み込み・画像
   ========================================================= */

function safeName(s) { return (s || '無題').replace(/[\\/:*?"<>|]/g, '_').trim() || '無題'; }
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function shapeOut(s) {
  const o = { ...s };
  for (const k of ['name', 'memo', 'place']) if (!o[k]) delete o[k];
  if (!o.link) delete o.link;
  if (o.type === 'line') { if (!o.color) delete o.color; if (!o.width) delete o.width; }
  if ((o.type === 'rect' || o.type === 'symbol') && !o.rot) delete o.rot;
  return o;
}
function exportData() {
  const w = curWork();
  return {
    format: 'noveltool-map',
    version: 1,
    work: { id: w.id, title: w.title, timelineWorkId: w.timelineWorkId || null, timelineTitle: tl.work ? tl.work.title : null },
    maps: maps.map((m) => ({ id: m.id, name: m.name, width: m.width, height: m.height, scale: m.scale, floors: m.floors, shapes: m.shapes.map(shapeOut) })),
  };
}
$('#exportJson').addEventListener('click', async () => {
  await flushSave();
  const w = curWork();
  download(`${safeName(w.title)}_配置図.json`, new Blob([JSON.stringify(exportData(), null, 2).replace(/\[\s+(-?[\d.e+-]+),\s+(-?[\d.e+-]+)\s+\]/g, '[$1, $2]') + '\n'], { type: 'application/json' }));
});

function parseImport(text) {
  let d;
  try { d = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error('JSONとして読めません（' + e.message + '）'); }
  if (!d || typeof d !== 'object') throw new Error('中身が空です。');
  const rawMaps = Array.isArray(d.maps) ? d.maps : Array.isArray(d) ? d : null;
  if (!rawMaps || !rawMaps.length) throw new Error('「maps」に地図が1つもありません（READMEの「配置図のJSON」を参照）。');
  const w = d.work || {};
  const ids = new Set();
  const list = rawMaps.map((m, i) => {
    let id = String(m.id || `map${i + 1}`);
    while (ids.has(id)) id += '_';
    ids.add(id);
    return normMap({ ...m, id });
  });
  // リンク先は同じファイルの地図だけ（地図の名前で書いてあっても探す）
  for (const m of list) {
    for (const s of m.shapes) {
      if (!s.link) continue;
      const t = list.find((x) => x.id === s.link) || list.find((x) => x.name === s.link);
      s.link = t ? t.id : null;
    }
  }
  return { work: { id: w.id ? String(w.id) : '', title: String(w.title || '読み込んだ配置図'), timelineWorkId: w.timelineWorkId || null, timelineTitle: w.timelineTitle || null }, maps: list };
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
  await loadTimeline();
  // 年表は、IDが同じもの、なければ名前が同じものと連動させる
  const t = tl.works.find((x) => x.id === data.work.timelineWorkId) || (data.work.timelineTitle ? tl.works.find((x) => x.title === data.work.timelineTitle) : null);
  data.work.timelineWorkId = t ? t.id : null;
  delete data.work.timelineTitle;
  const existing = data.work.id ? works.find((w) => w.id === data.work.id) : null;
  const dlg = $('#importDialog');
  const shapes = data.maps.reduce((a, m) => a + m.shapes.length, 0);
  $('#importMsg').textContent = `「${data.work.title}」（地図${data.maps.length}枚・図形${shapes}個）を読み込みます。` +
    (existing ? `同じ作品「${existing.title}」がすでにあります。` : '') + (t ? `年表「${t.title}」と連動します。` : '');
  $('#importReplace').hidden = !existing;
  $('#importAdd').textContent = existing ? '別の作品として追加' : '読み込む';
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    const mode = dlg.returnValue;
    if (mode !== 'add' && mode !== 'replace') return;
    try {
      await flushSave();
      const w = await MDB.importWork(data, mode === 'replace');
      MDB.notify({ type: 'works' });
      await loadWorks();
      await openWork(w.id, true);
    } catch (err) {
      console.error(err);
      alert('読み込めませんでした：' + err.message);
    }
  }, { once: true });
});

$('#exportPng').addEventListener('click', async () => {
  const m = curMap();
  if (!m) return;
  const pal = palette(true);
  const f = m.floors.find((x) => x.id === floorId);
  const title = `${m.name}${m.floors.length > 1 && f ? `（${f.name}）` : ''}`;
  // 地図の範囲と、はみ出した図形を含める
  const all = m.shapes.filter((s) => s.floor === floorId).flatMap(shapePoints);
  const b = bboxOf([[0, 0], [m.width, m.height + 1.6], ...all]);
  const x0 = b.x0 - 1;
  const y0 = b.y0 - 2.2;
  const w = b.x1 - b.x0 + 2;
  const h = b.y1 - b.y0 + 3.2;
  const px = Math.max(8, Math.min(40, 6000 / Math.max(w, h)));
  const body = `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="${pal.back}"/>` +
    `<text x="${x0 + 1}" y="${y0 + 1.1}" font-size="0.9" font-weight="700" fill="${pal.text}" dominant-baseline="central" font-family="${FONT}">${esc(title)}</text>` +
    mapSvgBody(m, floorId, pal);
  const src = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * px)}" height="${Math.round(h * px)}" viewBox="${x0} ${y0} ${w} ${h}">${body}</svg>`;
  const url = URL.createObjectURL(new Blob([src], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('画像を作れませんでした')); img.src = url; });
    const c = document.createElement('canvas');
    c.width = Math.round(w * px);
    c.height = Math.round(h * px);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    download(`${safeName(title)}.png`, blob);
  } catch (err) {
    alert('画像を保存できませんでした：' + err.message);
  } finally {
    URL.revokeObjectURL(url);
  }
});

/* ---------- 別タブの変更を反映 ---------- */

MDB.onMessage(async (msg) => {
  if (drag || draft) return;
  if (msg.type === 'works') {
    await loadWorks();
    if (!works.some((w) => w.id === workId)) { await openWork(null); return; }
    await loadTimeline();
    renderAll();
  } else if (msg.type === 'map' && msg.workId === workId) {
    if (dirtyMap) return; // こちらに未保存の変更があるときは上書きしない
    maps = (await MDB.maps(workId)).map(normMap);
    if (!curMap()) mapId = maps[0] ? maps[0].id : null;
    if (curMap() && !curMap().floors.some((f) => f.id === floorId)) floorId = curMap().floors[0].id;
    if (!shapeById(selId)) selId = null;
    renderAll();
  }
});
TLR.onChange(async () => {
  await loadTimeline();
  renderSidebar();
  if (shapeById(selId)) renderPanel();
});
window.addEventListener('focus', async () => {
  // 年表ツールを別のタブで書き換えたあと戻ってきたとき
  if (!curWork()) return;
  await loadTimeline();
  renderSidebar();
  if (shapeById(selId) && !panel.contains(document.activeElement)) renderPanel();
});

/* ---------- 起動 ---------- */

(async () => {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await loadWorks();
    await loadTimeline();
    await openWork(urlParams().work);
    setTool('select');
  } catch (err) {
    console.error(err);
    $('#empty').hidden = false;
    $('#emptyMsg').textContent = 'データを開けませんでした：' + err.message;
    $('#emptyAction').hidden = true;
  }
})();
