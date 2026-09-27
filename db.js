'use strict';

/* =========================================================
   保存層（IndexedDB）
   作品・話・資料を1件ずつ別のレコードとして保存するので、
   別タブで別の話を編集しても互いに上書きしません。
   ========================================================= */

const DB = (() => {
  const NAME = 'noveltool';
  const VERSION = 1;
  const LEGACY_DATA_KEY = 'noveltool.data.v1'; // 旧版（localStorage）の原稿
  const LEGACY_UI_KEY = 'noveltool.ui.v1';
  const LEGACY_REFS_DB = 'noveltool-refs'; // 旧版の資料

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
          db.createObjectStore('episodes', { keyPath: 'id' }).createIndex('workId', 'workId');
          db.createObjectStore('refs', { keyPath: 'id' }).createIndex('workId', 'workId');
          db.createObjectStore('meta', { keyPath: 'key' });
        };
        r.onsuccess = () => {
          const db = r.result;
          // 新しい版のページが開かれたら接続を譲る
          db.onversionchange = () => db.close();
          resolve(db);
        };
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error('データベースが別のタブで使用中です'));
      });
    }
    return dbPromise;
  }

  // fn の中では IndexedDB の要求だけを await すること（トランザクションが途切れないように）
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

  const byOrder = (a, b) => (a.order - b.order) || String(a.created || '').localeCompare(String(b.created || ''));

  /* ---------- 旧版からの移行 ---------- */

  function readLegacy() {
    let data = null;
    let workId = null;
    try {
      const raw = localStorage.getItem(LEGACY_DATA_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && Array.isArray(d.works)) data = d;
      }
    } catch (e) { console.error(e); }
    try { workId = JSON.parse(localStorage.getItem(LEGACY_UI_KEY) || '{}').workId || null; } catch (e) { /* noop */ }
    return { data, workId };
  }

  // 旧版の資料DBが存在するときだけ中身を読む（存在しなければ作らない）
  function readLegacyRefs() {
    return new Promise((resolve) => {
      let created = false;
      let r;
      try { r = indexedDB.open(LEGACY_REFS_DB); } catch (e) { resolve([]); return; }
      r.onupgradeneeded = () => { created = true; r.transaction.abort(); };
      r.onerror = (e) => { if (e.preventDefault) e.preventDefault(); resolve([]); };
      r.onsuccess = () => {
        const db = r.result;
        if (created || !db.objectStoreNames.contains('files')) { db.close(); resolve([]); return; }
        const g = db.transaction('files', 'readonly').objectStore('files').getAll();
        g.onsuccess = () => { db.close(); resolve(g.result || []); };
        g.onerror = () => { db.close(); resolve([]); };
      };
    });
  }

  async function init() {
    const legacy = readLegacy();
    const legacyRefs = await readLegacyRefs();
    // 移行と初期作品の作成は1つのトランザクションで行う（同時に開いた別タブと重複しない）
    return run(['meta', 'works', 'episodes', 'refs'], 'readwrite', async (s) => {
      const now = Date.now();
      const report = { works: 0, episodes: 0, refs: 0 };

      if (!(await req(s.meta.get('migratedV1')))) {
        if (legacy.data) {
          legacy.data.works.forEach((w, wi) => {
            s.works.put({ id: w.id, title: w.title || '無題', order: wi, created: now + wi });
            report.works++;
            (w.episodes || []).forEach((e, ei) => {
              s.episodes.put({ id: e.id, workId: w.id, title: e.title || '', body: e.body || '', order: ei, created: now + ei, updated: e.updated || now, rev: 1 });
              report.episodes++;
            });
          });
        }
        s.meta.put({ key: 'migratedV1', at: now, works: report.works });
      }

      let works = await req(s.works.getAll());
      if (!works.length) {
        const w = { id: uid(), title: '新しい作品', order: 0, created: now };
        s.works.put(w);
        s.episodes.put({ id: uid(), workId: w.id, title: '第1話', body: '', order: 0, created: now, updated: now, rev: 1 });
        works = [w];
      }

      if (!(await req(s.meta.get('migratedRefs')))) {
        if (legacyRefs.length) {
          works.sort(byOrder);
          const target = works.find((w) => w.id === legacy.workId) || works[0];
          for (const r of legacyRefs) {
            s.refs.put({ id: r.id || uid(), workId: target.id, name: r.name, path: r.name, text: r.text || '', updated: r.added || now });
            report.refs++;
          }
          report.refsWork = target.title;
        }
        s.meta.put({ key: 'migratedRefs', at: now, refs: report.refs });
      }
      return report;
    });
  }

  /* ---------- 作品 ---------- */

  async function works() {
    const list = await run('works', 'readonly', (s) => req(s.works.getAll()));
    return list.sort(byOrder);
  }

  function putWork(w) {
    return run('works', 'readwrite', (s) => { s.works.put({ ...w }); });
  }

  async function createWork(title) {
    const now = Date.now();
    return run(['works', 'episodes'], 'readwrite', async (s) => {
      const all = await req(s.works.getAll());
      const order = all.reduce((m, w) => Math.max(m, w.order), -1) + 1;
      const w = { id: uid(), title, order, created: now };
      s.works.put(w);
      s.episodes.put({ id: uid(), workId: w.id, title: '第1話', body: '', order: 0, created: now, updated: now, rev: 1 });
      return w;
    });
  }

  function deleteWork(id) {
    return run(['works', 'episodes', 'refs'], 'readwrite', async (s) => {
      s.works.delete(id);
      for (const k of await req(s.episodes.index('workId').getAllKeys(id))) s.episodes.delete(k);
      for (const k of await req(s.refs.index('workId').getAllKeys(id))) s.refs.delete(k);
    });
  }

  /* ---------- 話 ---------- */

  async function episodes(workId) {
    const list = await run('episodes', 'readonly', (s) => req(s.episodes.index('workId').getAll(workId)));
    return list.sort(byOrder);
  }

  function addEpisode(ep) {
    return run('episodes', 'readwrite', (s) => { s.episodes.put({ ...ep }); });
  }

  // タイトルと本文だけを保存する。別タブで先に保存された版があれば、消さずにコピーとして残す。
  function saveEpisode(ep) {
    const snap = { id: ep.id, workId: ep.workId, title: ep.title, body: ep.body, updated: ep.updated, rev: ep.rev || 0, order: ep.order, created: ep.created };
    return run('episodes', 'readwrite', async (s) => {
      const cur = await req(s.episodes.get(snap.id));
      const out = { rev: 0, copy: null, restored: false };
      if (!cur) {
        // 別タブで削除されていた → 書いていた内容で復元
        const rec = { ...snap, rev: snap.rev + 1 };
        s.episodes.put(rec);
        out.rev = rec.rev;
        out.restored = true;
        return out;
      }
      if ((cur.rev || 0) !== snap.rev && (cur.body !== snap.body || cur.title !== snap.title)) {
        const copy = { ...cur, id: uid(), title: `${cur.title || '無題'}（別タブで保存された版）`, order: cur.order + 0.5, created: Date.now(), rev: 1 };
        s.episodes.put(copy);
        out.copy = copy;
      }
      const rec = { ...cur, title: snap.title, body: snap.body, updated: snap.updated, rev: (cur.rev || 0) + 1 };
      s.episodes.put(rec);
      out.rev = rec.rev;
      return out;
    });
  }

  // 並び順だけを書き換える（本文には触れない）
  function setOrders(list) {
    return run('episodes', 'readwrite', async (s) => {
      for (const { id, order } of list) {
        const cur = await req(s.episodes.get(id));
        if (cur && cur.order !== order) s.episodes.put({ ...cur, order });
      }
    });
  }

  function deleteEpisode(id) {
    return run('episodes', 'readwrite', (s) => { s.episodes.delete(id); });
  }

  function getEpisode(id) {
    return run('episodes', 'readonly', (s) => req(s.episodes.get(id)));
  }

  /* ---------- 資料 ---------- */

  async function refs(workId) {
    return run('refs', 'readonly', (s) => req(s.refs.index('workId').getAll(workId)));
  }

  // 同じファイル名の資料は上書き更新する
  function upsertRefs(workId, items) {
    return run('refs', 'readwrite', async (s) => {
      const existing = await req(s.refs.index('workId').getAll(workId));
      const byName = new Map(existing.map((r) => [r.name, r]));
      const result = { added: 0, updated: 0, last: null };
      for (const it of items) {
        const old = byName.get(it.name);
        const rec = { id: old ? old.id : uid(), workId, name: it.name, path: it.path || it.name, text: it.text, updated: Date.now() };
        s.refs.put(rec);
        byName.set(rec.name, rec);
        if (old) result.updated++; else result.added++;
        result.last = rec;
      }
      return result;
    });
  }

  function deleteRefs(ids) {
    return run('refs', 'readwrite', (s) => { for (const id of ids) s.refs.delete(id); });
  }

  function deleteAllRefs(workId) {
    return run('refs', 'readwrite', async (s) => {
      for (const k of await req(s.refs.index('workId').getAllKeys(workId))) s.refs.delete(k);
    });
  }

  /* ---------- 作品単位の書き出し・読み込み ---------- */

  async function exportWork(id) {
    return run(['works', 'episodes', 'refs'], 'readonly', async (s) => {
      const w = await req(s.works.get(id));
      if (!w) return null;
      const eps = (await req(s.episodes.index('workId').getAll(id))).sort(byOrder);
      const rs = (await req(s.refs.index('workId').getAll(id))).sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
      return { ...w, episodes: eps, refs: rs };
    });
  }

  // replace=true なら同じIDの作品の原稿と資料を入れ替える。false なら新しい作品として追加。
  function importWork(data, replace) {
    const now = Date.now();
    return run(['works', 'episodes', 'refs'], 'readwrite', async (s) => {
      const all = await req(s.works.getAll());
      const existing = data.id ? all.find((w) => w.id === data.id) : null;
      let work;
      if (existing && replace) {
        for (const k of await req(s.episodes.index('workId').getAllKeys(existing.id))) s.episodes.delete(k);
        for (const k of await req(s.refs.index('workId').getAllKeys(existing.id))) s.refs.delete(k);
        work = { ...existing, title: data.title };
      } else {
        const id = data.id && !existing ? data.id : uid();
        work = { id, title: data.title, order: all.reduce((m, w) => Math.max(m, w.order), -1) + 1, created: now };
      }
      s.works.put(work);
      data.episodes.forEach((e, i) => {
        s.episodes.put({ id: uid(), workId: work.id, title: e.title, body: e.body, order: i, created: now + i, updated: now, rev: 1 });
      });
      for (const r of data.refs || []) {
        s.refs.put({ id: uid(), workId: work.id, name: r.name, path: r.name, text: r.text, updated: now });
      }
      return work;
    });
  }

  /* ---------- 別タブへの通知 ---------- */

  const TAB_ID = uid();
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('noveltool') : null;
  const listeners = [];
  if (channel) {
    channel.onmessage = (e) => {
      if (!e.data || e.data.from === TAB_ID) return;
      for (const fn of listeners) fn(e.data);
    };
  }
  function notify(msg) {
    if (channel) channel.postMessage({ ...msg, from: TAB_ID });
  }
  function onMessage(fn) { listeners.push(fn); }

  return {
    uid, init, works, putWork, createWork, deleteWork,
    episodes, addEpisode, saveEpisode, setOrders, deleteEpisode, getEpisode,
    refs, upsertRefs, deleteRefs, deleteAllRefs,
    exportWork, importWork, notify, onMessage, TAB_ID,
  };
})();
