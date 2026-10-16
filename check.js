'use strict';

/* =========================================================
   表記ゆれチェック
   - 作品ごとの用語辞書（正しい表記・ゆれやすい表記・ルビ・メモ）
   - 人物事典（別ツール）の名前・別名も辞書として使う（読むだけ）
   - 登録したゆれ／辞書にないゆれの候補／初出のルビ漏れ／よくあるゆれ を一覧にし、
     クリックで該当箇所へ移動。置換は1件ずつ確認して選べる
   app.js の $, ui, saveUI, esc, fmt, TOKEN_RE, episodes, flatEpisodes, curEp, chapterOf,
   epId, workId, curWork, selectEpisode, markDirty, flushSave, lock, lockName, HAS_LOCKS,
   setStatus, renderAll, renderMain, wideMQ, el, DB, uid を使います。
   ========================================================= */

/* ---------- 人物事典のデータ（読むだけ） ---------- */
// 人物事典ツールの IndexedDB「noveltool-people」が存在するときだけ開く（存在しなければ作らない）

const PeopleSource = (() => {
  const NAME = 'noveltool-people';
  const PEOPLE_STORES = ['people', 'persons', 'characters'];

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
        if (created) { db.close(); resolve(null); return; }
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
  }

  const getAll = (db, store) => new Promise((resolve, reject) => {
    const q = db.transaction(store, 'readonly').objectStore(store).getAll();
    q.onsuccess = () => resolve(q.result || []);
    q.onerror = () => reject(q.error);
  });

  const pick = (rec, keys) => { for (const k of keys) if (rec[k] !== undefined && rec[k] !== null && rec[k] !== '') return rec[k]; return null; };
  const list = (v) => {
    if (!v) return [];
    const arr = Array.isArray(v) ? v : String(v).split(/[、,，/／\n]+/);
    return arr.map((x) => (typeof x === 'string' ? x : (x && (x.name || x.text)) || '')).map((x) => x.trim()).filter(Boolean);
  };

  // 項目名が多少違っても読めるようにしておく
  function normalize(rec) {
    const name = String(pick(rec, ['name', '名前', 'fullName', 'title']) || '').trim();
    return {
      id: rec.id,
      workId: pick(rec, ['workId', 'work']) || null,
      name,
      aliases: list(pick(rec, ['aliases', 'alias', '別名', 'otherNames', 'nicknames'])).filter((a) => a !== name),
      ruby: String(pick(rec, ['ruby', 'reading', 'yomi', 'kana', '読み', 'ルビ']) || '').trim(),
      variants: list(pick(rec, ['variants', 'ゆれ', 'misspellings'])),
    };
  }

  // → null（人物事典なし）| { works: [{id,title}], people: [...] }
  async function load() {
    const db = await openExisting();
    if (!db) return null;
    try {
      const store = PEOPLE_STORES.find((n) => db.objectStoreNames.contains(n));
      const works = db.objectStoreNames.contains('works') ? await getAll(db, 'works') : [];
      const people = store ? (await getAll(db, store)).map(normalize).filter((p) => p.name) : [];
      return {
        works: works.map((w) => ({ id: w.id, title: w.title || w.name || '無題' })).sort((a, b) => String(a.title).localeCompare(String(b.title), 'ja')),
        people,
      };
    } catch (e) {
      console.error(e);
      return { works: [], people: [] };
    } finally {
      db.close();
    }
  }

  // 人物事典で変更があったら知らせてもらう
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('noveltool-people') : null;
  function onChange(fn) { if (channel) channel.onmessage = () => fn(); }
  return { load, onChange };
})();

/* ---------- よくある表記ゆれ ---------- */
// どの形も「語幹」を置き換える。後ろの送り仮名・助詞は先読みで確かめるだけで置き換えない

const PARTICLE_AFTER = '(?=[はにのもがをでだやへと、。」』！？!?…―\\s]|$)';
const COMMON_RULES = [
  { id: 'iu', label: '（〜と）いう／言う', note: '「という」「っていう」の「いう」', forms: [
    { key: 'hira', label: 'いう', re: /(?<=[とっ])い(?=う|った|って|わ[なれせず]|います|いまし|えば|おう)/g, stem: 'い' },
    { key: 'kanji', label: '言う', re: /(?<=[とっ])言(?=う|った|って|わ[なれせず]|います|いまし|えば|おう)/g, stem: '言' },
  ] },
  { id: 'toki', label: 'とき／時', note: '「〜するとき」の「とき」', forms: [
    { key: 'hira', label: 'とき', re: new RegExp('(?<=[ぁ-ん])とき' + PARTICLE_AFTER, 'g'), stem: 'とき' },
    { key: 'kanji', label: '時', re: new RegExp('(?<=[ぁ-ん])時' + PARTICLE_AFTER, 'g'), stem: '時' },
  ] },
  { id: 'koto', label: 'こと／事', note: '「〜すること」の「こと」', forms: [
    { key: 'hira', label: 'こと', re: new RegExp('(?<=[ぁ-ん])こと' + PARTICLE_AFTER, 'g'), stem: 'こと' },
    { key: 'kanji', label: '事', re: new RegExp('(?<=[ぁ-ん])事' + PARTICLE_AFTER, 'g'), stem: '事' },
  ] },
  { id: 'tokoro', label: 'ところ／所', note: '「〜したところ」の「ところ」', forms: [
    { key: 'hira', label: 'ところ', re: new RegExp('(?<=[ぁ-ん])ところ' + PARTICLE_AFTER, 'g'), stem: 'ところ' },
    { key: 'kanji', label: '所', re: new RegExp('(?<=[ぁ-ん])所' + PARTICLE_AFTER, 'g'), stem: '所' },
  ] },
  { id: 'mono', label: 'もの／物', note: '「〜するもの」の「もの」', forms: [
    { key: 'hira', label: 'もの', re: new RegExp('(?<=[るたい])もの' + PARTICLE_AFTER, 'g'), stem: 'もの' },
    { key: 'kanji', label: '物', re: new RegExp('(?<=[るたい])物' + PARTICLE_AFTER, 'g'), stem: '物' },
  ] },
  { id: 'dekiru', label: 'できる／出来る', forms: [
    { key: 'hira', label: 'できる', re: /でき(?=る|た|て|な|ま|れ|ず|そう)/g, stem: 'でき' },
    { key: 'kanji', label: '出来る', re: /出来(?=る|た|て|な|ま|れ|ず|そう)/g, stem: '出来' },
  ] },
  { id: 'wakaru', label: 'わかる／分かる／判る', forms: [
    { key: 'hira', label: 'わかる', re: /わか(?=る|った|って|らな|らず|りま|れば)/g, stem: 'わか' },
    { key: 'kanji', label: '分かる', re: /分か(?=る|った|って|らな|らず|りま|れば)/g, stem: '分か' },
    { key: 'han', label: '判る・解る', re: /[判解](?=る|った|って|らな|らず|りま|れば)/g, stem: '判' },
  ] },
  { id: 'kudasai', label: 'ください／下さい', forms: [
    { key: 'hira', label: 'ください', re: /くださ(?=い|る|れ|っ)/g, stem: 'くださ' },
    { key: 'kanji', label: '下さい', re: /下さ(?=い|る|れ|っ)/g, stem: '下さ' },
  ] },
  ...[
    ['subete', 'すべて', '全て'], ['samazama', 'さまざま', '様々'], ['iroiro', 'いろいろ', '色々'],
    ['takusan', 'たくさん', '沢山'], ['hotondo', 'ほとんど', '殆ど'], ['sudeni', 'すでに', '既に'],
    ['sarani', 'さらに', '更に'], ['tatoeba', 'たとえば', '例えば'], ['naze', 'なぜ', '何故'],
    ['yahari', 'やはり', '矢張り'], ['itsumo', 'いつも', '何時も'], ['marude', 'まるで', '丸で'],
  ].map(([id, hira, kanji]) => ({ id, label: `${hira}／${kanji}`, forms: [
    { key: 'hira', label: hira, re: new RegExp(hira, 'g'), stem: hira },
    { key: 'kanji', label: kanji, re: new RegExp(kanji, 'g'), stem: kanji },
  ] })),
  { id: 'bang', label: '！？の全角／半角', forms: [
    { key: 'full', label: '全角 ！？', re: /[！？]/g, conv: (s) => s.replace(/!/g, '！').replace(/\?/g, '？') },
    { key: 'half', label: '半角 !?', re: /[!?]/g, conv: (s) => s.replace(/！/g, '!').replace(/？/g, '?') },
  ] },
  { id: 'dots', label: '…／・・・（三点リーダー）', forms: [
    { key: 'leader', label: '…', re: /…/g, stem: '…' },
    { key: 'dots', label: '・・・', re: /・・・/g, stem: '・・・' },
  ] },
];

/* ---------- 文字の判定・正規化 ---------- */

const KANJI_RE_CLASS = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF々〆ヶ';
const RE_ALL_KANJI = new RegExp(`^[${KANJI_RE_CLASS}]+$`, 'u');
const RE_ALL_KATA = /^[ァ-ヺー・＝]+$/;
const RE_KANJI_RUN = new RegExp(`[${KANJI_RE_CLASS}]+`, 'gu');
const RE_KATA_RUN = /[ァ-ヺー・＝]+/g;

// 人名などでよく使われる異体字
const ITAIJI = {
  邊: '辺', 邉: '辺', 齋: '斎', 齊: '斎', 髙: '高', 﨑: '崎', 嵜: '崎', 嶋: '島', 嶌: '島', 澤: '沢', 濱: '浜', 廣: '広',
  國: '国', 櫻: '桜', 龍: '竜', 惠: '恵', 眞: '真', 實: '実', 藏: '蔵', 德: '徳', 壽: '寿', 與: '与', 來: '来', 曾: '曽',
  萬: '万', 冨: '富', 學: '学', 鐵: '鉄', 靜: '静', 會: '会', 條: '条', 槇: '槙', 淵: '渕', 戶: '戸', 圓: '円',
  榮: '栄', 傳: '伝', 黑: '黒', 縣: '県', 邨: '村', 嶽: '岳', 峯: '峰', 舘: '館', 劍: '剣', 劔: '剣', 釼: '剣', 聰: '聡',
  藝: '芸', 驛: '駅', 豐: '豊', 禮: '礼', 彌: '弥', 晉: '晋', 檜: '桧', 莊: '荘', 埜: '野', 遙: '遥', 凜: '凛',
};
const itaiNorm = (s) => s.replace(/./gu, (c) => ITAIJI[c] || c);

const SMALL_KANA = { ァ: 'ア', ィ: 'イ', ゥ: 'ウ', ェ: 'エ', ォ: 'オ', ッ: 'ツ', ャ: 'ヤ', ュ: 'ユ', ョ: 'ヨ', ヮ: 'ワ', ヵ: 'カ', ヶ: 'ケ' };
function kataNorm(s) {
  return s.replace(/ヴァ/g, 'バ').replace(/ヴィ/g, 'ビ').replace(/ヴェ/g, 'ベ').replace(/ヴォ/g, 'ボ').replace(/ヴ/g, 'ブ')
    .replace(/[ァィゥェォッャュョヮヵヶ]/g, (c) => SMALL_KANA[c]).replace(/[ー・＝\s]/g, '');
}

function hamming(a, b) {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++d > 1) return d;
  return d;
}

// 1文字の追加・削除・置き換えで一致するか
function within1(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) return hamming(a, b) === 1;
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.slice(i) === l.slice(i + 1);
}

/* ---------- 本文の分解 ---------- */
// ルビの読みや記号を除いた「表示される文字」の区間と、本文中の位置の対応を作る

function lineSegments(line) {
  const segs = [];
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(line))) {
    if (m.index > last) segs.push({ type: 'text', text: line.slice(last, m.index), raw: last });
    if (m[1] !== undefined) segs.push({ type: 'bouten', text: m[1], raw: m.index + 2 });
    else if (m[2] !== undefined) segs.push({ type: 'esc', text: '《', raw: m.index + 1 });
    else if (m[3] !== undefined) segs.push({ type: 'ruby', text: m[3], raw: m.index + 1, rt: m[4] });
    else segs.push({ type: 'ruby', text: m[5], raw: m.index, rt: m[6] });
    last = TOKEN_RE.lastIndex;
  }
  if (last < line.length) segs.push({ type: 'text', text: line.slice(last), raw: last });
  return segs.filter((s) => s.type !== 'esc');
}

function buildDoc(ep, no) {
  let off = 0;
  const lines = ep.body.split('\n').map((line, i) => {
    const L = { line, n: i + 1, off, segs: lineSegments(line) };
    off += line.length + 1;
    return L;
  });
  return { ep, no, lines };
}

function occ(doc, L, sg, i, len) {
  return { ep: doc.ep, no: doc.no, line: L.n, lineText: L.line, col: sg.raw + i, start: L.off + sg.raw + i, len, seg: sg, segOff: i, text: sg.text.substr(i, len) };
}

function findWord(doc, w) {
  const out = [];
  if (!w) return out;
  for (const L of doc.lines) {
    for (const sg of L.segs) {
      let i = sg.text.indexOf(w);
      while (i >= 0) {
        out.push(occ(doc, L, sg, i, w.length));
        i = sg.text.indexOf(w, i + 1);
      }
    }
  }
  return out;
}

// 見つかった語が、より長い正しい表記の一部かどうか（例：「アレク」が「アレクサンダー」の中にある）
function insideAllowed(o, word, allowed) {
  for (const f of allowed) {
    if (f === word || f.length <= word.length) continue;
    let k = f.indexOf(word);
    while (k >= 0) {
      const st = o.segOff - k;
      if (st >= 0 && o.seg.text.substr(st, f.length) === f) return true;
      k = f.indexOf(word, k + 1);
    }
  }
  return false;
}

/* ---------- 本体 ---------- */

const Check = (() => {
  const C = {
    panel: $('#refs'), refsPane: $('#refsPane'), pane: $('#checkPane'), body: $('#chkBody'),
  };

  let checkWork = null;
  let terms = [];
  let settings = defaults();
  let peopleData = null;   // 人物事典の内容（null＝見つからない）
  let view = 'run';        // run | dict | rules
  let scope = 'ep';        // ep | chapter | work
  let result = null;       // 直前のチェック結果
  const openGroups = new Set();
  let replacing = null;    // 置換の確認中のグループ
  let replaceSel = new Set();
  let editing = null;      // 編集中の用語（'new' または id）
  let dictFilter = '';
  let lastUndo = null;
  const search = { open: false, find: '', to: '' }; // 「検索して置換」の入力（描き直しても消えないように）

  function defaults() {
    return { rules: {}, rubyMode: 'work', candidates: true, ignore: [], peopleWorkId: null };
  }

  /* ----- 辞書（用語＋人物） ----- */

  function linkedPeople() {
    if (!peopleData) return [];
    const w = curWork();
    let pwId = settings.peopleWorkId;
    if (!pwId && w) {
      const same = peopleData.works.find((x) => x.title === w.title);
      if (same) pwId = same.id;
    }
    const hasWorkIds = peopleData.people.some((p) => p.workId);
    if (!hasWorkIds || !peopleData.works.length) return peopleData.people;
    return pwId ? peopleData.people.filter((p) => p.workId === pwId) : [];
  }

  function entries() {
    const list = terms.map((t) => ({ kind: 'term', id: t.id, word: t.word, aliases: [], variants: t.variants || [], ruby: t.ruby || '', memo: t.memo || '' }));
    for (const p of linkedPeople()) {
      list.push({ kind: 'person', id: 'person:' + (p.id || p.name), word: p.name, aliases: p.aliases, variants: p.variants, ruby: p.ruby, memo: '' });
    }
    return list.filter((e) => e.word);
  }

  /* ----- チェック ----- */

  function scopeEpisodes() {
    const flat = flatEpisodes();
    if (scope === 'ep') return flat.filter((e) => e.id === epId);
    if (scope === 'chapter') {
      const ep = curEp();
      if (!ep) return [];
      const cid = chapterOf(ep) ? chapterOf(ep).id : null;
      return flat.filter((e) => (chapterOf(e) ? chapterOf(e).id : null) === cid);
    }
    return flat;
  }

  function scopeLabel() {
    if (scope === 'ep') { const ep = curEp(); return ep ? `この話「${ep.title || '無題'}」` : 'この話'; }
    if (scope === 'chapter') { const ch = chapterOf(curEp()); return ch ? `この章「${ch.title || '無題の章'}」` : '章なしの話'; }
    return '作品全体';
  }

  function run() {
    const flat = flatEpisodes();
    const numbers = new Map(flat.map((e, i) => [e.id, i + 1]));
    const inScope = scopeEpisodes();
    const scopeIds = new Set(inScope.map((e) => e.id));
    const docs = inScope.map((e) => buildDoc(e, numbers.get(e.id)));
    const es = entries();
    const allowed = [...new Set(es.flatMap((e) => [e.word, ...e.aliases]).filter(Boolean))];
    const allowedSet = new Set(allowed);
    const variantSet = new Set(es.flatMap((e) => e.variants));
    const groups = [];

    // 1. 登録したゆれ
    for (const e of es) {
      for (const v of e.variants) {
        if (!v || allowedSet.has(v)) continue;
        const found = docs.flatMap((d) => findWord(d, v)).filter((o) => !insideAllowed(o, v, allowed));
        if (found.length) {
          groups.push({ type: 'variant', key: `v:${e.id}:${v}`, label: `「${v}」→「${e.word}」`, sub: e.kind === 'person' ? '人物事典' : (e.memo || ''), occ: found.map((o) => ({ ...o, to: e.word })) });
        }
      }
    }

    // 2. 辞書にないゆれの候補（辞書の語に近いのに、辞書にない表記）
    if (settings.candidates) {
      const known = new Set([...allowed, ...variantSet, ...settings.ignore]);
      const cands = new Map();
      const add = (surface, target, o) => {
        if (!cands.has(surface)) cands.set(surface, { target, occ: [] });
        cands.get(surface).occ.push({ ...o, to: target });
      };
      const kanjiForms = allowed.filter((f) => f.length >= 2 && RE_ALL_KANJI.test(f));
      const kataForms = allowed.filter((f) => f.length >= 3 && RE_ALL_KATA.test(f));
      const kanjiNorm = new Map(kanjiForms.map((f) => [f, itaiNorm(f)]));
      const kataNormed = new Map(kataForms.map((f) => [f, kataNorm(f)]));
      for (const d of docs) {
        for (const L of d.lines) {
          for (const sg of L.segs) {
            if (kanjiForms.length) {
              RE_KANJI_RUN.lastIndex = 0;
              let m;
              while ((m = RE_KANJI_RUN.exec(sg.text))) {
                const runText = m[0];
                for (const f of kanjiForms) {
                  const n = f.length;
                  for (let j = 0; j + n <= runText.length; j++) {
                    const w = runText.substr(j, n);
                    if (w === f || known.has(w)) continue;
                    if (itaiNorm(w) === kanjiNorm.get(f) || (n >= 3 && hamming(w, f) === 1)) {
                      const o = occ(d, L, sg, m.index + j, n);
                      if (!insideAllowed(o, w, allowed)) add(w, f, o);
                    }
                  }
                }
              }
            }
            if (kataForms.length) {
              RE_KATA_RUN.lastIndex = 0;
              let m;
              while ((m = RE_KATA_RUN.exec(sg.text))) {
                const parts = [{ t: m[0], at: m.index }];
                if (m[0].includes('・')) {
                  let at = m.index;
                  for (const p of m[0].split('・')) { if (p) parts.push({ t: p, at }); at += p.length + 1; }
                }
                for (const { t, at } of parts) {
                  if (known.has(t)) continue;
                  const tn = kataNorm(t);
                  for (const f of kataForms) {
                    if (t === f) continue;
                    if (tn === kataNormed.get(f) || (f.length >= 4 && within1(t, f))) { add(t, f, occ(d, L, sg, at, t.length)); break; }
                  }
                }
              }
            }
          }
        }
      }
      for (const [surface, c] of cands) {
        groups.push({ type: 'candidate', key: `c:${surface}`, label: `「${surface}」→「${c.target}」？`, sub: `辞書の「${c.target}」に近い表記`, surface, target: c.target, occ: c.occ });
      }
    }

    // 3. 初出でルビがない
    const rubyIssues = [];
    for (const e of es) {
      if (!e.ruby) continue;
      const check = (o) => {
        if (o.seg.type === 'ruby') return;
        rubyIssues.push({
          type: 'ruby', key: `r:${e.id}:${o.ep.id}`, label: `${e.word}（${e.ruby}）`, sub: e.kind === 'person' ? '人物事典' : '',
          occ: [{ ...o, to: `｜${e.word}《${e.ruby}》`, fixable: o.seg.type === 'text' }],
        });
      };
      if (settings.rubyMode === 'episode') {
        for (const d of docs) { const o = findWord(d, e.word)[0]; if (o) check(o); }
      } else {
        // 作品全体で最初に出てくる箇所（範囲外なら報告しない）
        for (const ep of flat) {
          const o = findWord(buildDoc(ep, numbers.get(ep.id)), e.word)[0];
          if (o) { if (scopeIds.has(ep.id)) check(o); break; }
        }
      }
    }
    groups.push(...rubyIssues);

    // 4. よくあるゆれ（選んだものだけ）
    for (const rule of COMMON_RULES) {
      const prefKey = settings.rules[rule.id];
      if (!prefKey) continue;
      const pref = rule.forms.find((f) => f.key === prefKey);
      if (!pref) continue;
      for (const f of rule.forms) {
        if (f === pref) continue;
        const found = [];
        for (const d of docs) {
          for (const L of d.lines) {
            for (const sg of L.segs) {
              f.re.lastIndex = 0;
              let m;
              while ((m = f.re.exec(sg.text))) {
                if (!m[0]) { f.re.lastIndex++; continue; }
                const o = occ(d, L, sg, m.index, m[0].length);
                found.push({ ...o, to: pref.conv ? pref.conv(m[0]) : pref.stem });
              }
            }
          }
        }
        if (found.length) groups.push({ type: 'rule', key: `u:${rule.id}:${f.key}`, label: `「${f.label}」→「${pref.label}」`, sub: rule.label, occ: found });
      }
    }

    result = { at: new Date(), scope, scopeLabel: scopeLabel(), count: inScope.length, groups };
    replacing = null;
    for (const g of groups) if (g.occ.length <= 3) openGroups.add(g.key);
    render();
  }

  /* ----- 該当箇所へ移動 ----- */

  function caretTop(ta, pos) {
    const cs = getComputedStyle(ta);
    const div = document.createElement('div');
    for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'wordBreak', 'overflowWrap']) div.style[p] = cs[p];
    Object.assign(div.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', boxSizing: 'border-box', width: ta.clientWidth + 'px', border: '0' });
    div.textContent = ta.value.slice(0, pos);
    const mark = document.createElement('span');
    mark.textContent = '​';
    div.appendChild(mark);
    document.body.appendChild(div);
    const top = mark.offsetTop;
    div.remove();
    return top;
  }

  function jump(o) {
    if (!wideMQ.matches && ui.mtab !== 'write') { ui.mtab = 'write'; saveUI(); Refs.layout(); }
    if (ui.view === 'preview') { ui.view = wideMQ.matches ? 'split' : 'edit'; saveUI(); }
    if (o.ep.id !== epId) selectEpisode(o.ep.id); else renderMain();
    // チェックの後に本文が変わっていたら、近くで同じ文字を探し直す
    const body = o.ep.body;
    let start = o.start;
    if (body.substr(start, o.len) !== o.text) {
      const before = body.lastIndexOf(o.text, start);
      const after = body.indexOf(o.text, start);
      const cand = [before, after].filter((x) => x >= 0).sort((a, b) => Math.abs(a - start) - Math.abs(b - start));
      if (!cand.length) { setStatus('該当箇所が見つかりません（本文が変わったようです。もう一度チェックしてください）'); return; }
      start = cand[0];
    }
    requestAnimationFrame(() => {
      const ta = el.editor;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(start, start + o.len);
      ta.scrollTop = Math.max(0, caretTop(ta, start) - ta.clientHeight / 3);
    });
  }

  /* ----- 置換 ----- */

  async function lockedElsewhere() {
    const set = new Set();
    try {
      if (HAS_LOCKS && navigator.locks.query) {
        const st = await navigator.locks.query();
        const prefix = lockName('');
        for (const l of st.held || []) {
          if (!l.name || !l.name.startsWith(prefix)) continue;
          const id = l.name.slice(prefix.length);
          if (!(id === lock.epId && lock.holder)) set.add(id);
        }
      }
    } catch (e) { console.error(e); }
    if (epId && !lock.editable) set.add(epId);
    return set;
  }

  // items: [{ ep, start, len, text, to }]
  async function applyReplacements(items) {
    const locked = await lockedElsewhere();
    const byEp = new Map();
    for (const it of items) {
      if (!byEp.has(it.ep.id)) byEp.set(it.ep.id, []);
      byEp.get(it.ep.id).push(it);
    }
    let done = 0;
    let skippedLocked = 0;
    let skippedChanged = 0;
    const undo = [];
    for (const [id, list] of byEp) {
      const ep = episodes.find((e) => e.id === id);
      if (!ep || locked.has(id)) { skippedLocked += list.length; continue; }
      let body = ep.body;
      list.sort((a, b) => b.start - a.start);
      let lastStart = Infinity;
      for (const it of list) {
        if (it.start + it.len > lastStart || body.substr(it.start, it.len) !== it.text) { skippedChanged++; continue; }
        body = body.slice(0, it.start) + it.to + body.slice(it.start + it.len);
        lastStart = it.start;
        done++;
      }
      if (body !== ep.body) {
        undo.push({ ep, before: ep.body, after: body });
        ep.body = body;
        ep.updated = Date.now();
        markDirty(ep);
      }
    }
    await flushSave();
    renderAll();
    if (undo.length) lastUndo = undo;
    const notes = [];
    if (skippedLocked) notes.push(`${skippedLocked}件は別のタブで編集中の話のため置換しませんでした`);
    if (skippedChanged) notes.push(`${skippedChanged}件は本文が変わっていたため置換しませんでした`);
    setStatus(`${done}件を置換しました` + (notes.length ? `（${notes.join('。')}）` : ''));
    if (notes.length) alert(`${done}件を置換しました。\n${notes.join('\n')}`);
    run();
  }

  async function undoLast() {
    if (!lastUndo) return;
    let restored = 0;
    let skipped = 0;
    for (const u of lastUndo) {
      if (u.ep.body === u.after && episodes.includes(u.ep)) {
        u.ep.body = u.before;
        u.ep.updated = Date.now();
        markDirty(u.ep);
        restored++;
      } else {
        skipped++;
      }
    }
    lastUndo = null;
    await flushSave();
    renderAll();
    setStatus(skipped ? `${restored}話を元に戻しました（${skipped}話は置換の後に書き換えられていたため戻していません）` : '直前の置換を元に戻しました');
    run();
  }

  /* ----- 設定と辞書の保存 ----- */

  async function saveSettings() {
    if (!checkWork) return;
    await DB.putCheckSettings(checkWork, settings);
    DB.notify({ t: 'check', workId: checkWork });
  }

  async function saveTerm(t) {
    await DB.putTerm(t);
    const i = terms.findIndex((x) => x.id === t.id);
    if (i >= 0) terms[i] = t; else terms.push(t);
    DB.notify({ t: 'terms', workId: checkWork });
  }

  async function removeTerm(t) {
    if (!confirm(`用語「${t.word}」を辞書から削除しますか？`)) return;
    await DB.deleteTerm(t.id);
    terms = terms.filter((x) => x.id !== t.id);
    DB.notify({ t: 'terms', workId: checkWork });
    render();
  }

  const splitList = (s) => [...new Set(String(s || '').split(/[、,，\n]+/).map((x) => x.trim()).filter(Boolean))];

  /* ----- 描画 ----- */

  function ctxHtml(o, to) {
    const s = o.col;
    const e = s + o.len;
    const pre = o.lineText.slice(Math.max(0, s - 14), s);
    const post = o.lineText.slice(e, e + 14);
    const mid = to !== undefined
      ? `<del>${esc(o.text)}</del><ins>${esc(to)}</ins>`
      : `<mark>${esc(o.text)}</mark>`;
    return `${s > 14 ? '…' : ''}${esc(pre)}${mid}${esc(post)}${e + 14 < o.lineText.length ? '…' : ''}`;
  }

  const where = (o) => `${o.no}. ${esc(o.ep.title || '無題')}　${o.line}行目`;

  function groupHtml(g) {
    const open = openGroups.has(g.key);
    const isRep = replacing === g.key;
    const fixable = g.type !== 'ruby' || g.occ[0].fixable;
    const actions = [];
    if (g.type === 'ruby') {
      if (fixable) actions.push(`<button type="button" class="btn small" data-act="ruby-fix" data-key="${esc(g.key)}">ルビを付ける</button>`);
    } else if (!isRep) {
      actions.push(`<button type="button" class="btn small" data-act="replace" data-key="${esc(g.key)}">置換…</button>`);
    }
    if (g.type === 'candidate') {
      const t = terms.find((x) => x.word === g.target);
      if (t) actions.push(`<button type="button" class="btn small" data-act="add-variant" data-key="${esc(g.key)}" title="「${esc(g.surface)}」を「${esc(g.target)}」のゆれとして辞書に登録">ゆれとして登録</button>`);
      actions.push(`<button type="button" class="btn small" data-act="ignore" data-key="${esc(g.key)}" title="この表記は正しいものとして、今後は候補に出さない">無視</button>`);
    }
    const items = g.occ.map((o, i) => isRep
      ? `<li><label class="rep-item"><input type="checkbox" data-sel="${i}"${replaceSel.has(i) ? ' checked' : ''}>
          <span><small>${where(o)}</small><span class="ctx">${ctxHtml(o, o.to)}</span></span></label>
          <button type="button" class="icon-btn" data-act="jump" data-key="${esc(g.key)}" data-i="${i}" title="この箇所へ移動" aria-label="この箇所へ移動">→</button></li>`
      : `<li><button type="button" class="occ" data-act="jump" data-key="${esc(g.key)}" data-i="${i}">
          <small>${where(o)}</small><span class="ctx">${ctxHtml(o)}</span></button></li>`).join('');
    const repBar = isRep ? `<div class="rep-bar">
        <button type="button" class="btn small" data-act="sel-all">すべて選ぶ</button>
        <button type="button" class="btn small" data-act="sel-none">すべて外す</button>
        <span class="spacer"></span>
        <button type="button" class="btn small" data-act="rep-cancel">やめる</button>
        <button type="button" class="btn small primary" data-act="rep-apply"${replaceSel.size ? '' : ' disabled'}>選んだ${replaceSel.size}件を置換</button>
      </div>` : '';
    return `<div class="chk-group${isRep ? ' replacing' : ''}">
      <div class="chk-ghead">
        <button type="button" class="chev-btn" data-act="toggle" data-key="${esc(g.key)}" aria-expanded="${open || isRep}" aria-label="開閉">▸</button>
        <span class="chk-label">${esc(g.label)}${g.sub ? `<small>${esc(g.sub)}</small>` : ''}</span>
        <span class="chk-count">${g.occ.length}件</span>
        <span class="chk-actions">${actions.join('')}</span>
      </div>
      ${isRep ? '<p class="note rep-note">置換する箇所を選んでください（チェックを外した箇所はそのまま残ります）。</p>' : ''}
      <ol class="chk-occ"${open || isRep ? '' : ' hidden'}>${items}</ol>
      ${repBar}
    </div>`;
  }

  const SECTIONS = [
    ['variant', '登録した表記ゆれ'],
    ['candidate', '辞書にない表記ゆれの候補'],
    ['ruby', '初出でルビがない用語'],
    ['rule', 'よくある表記ゆれ'],
    ['search', '検索して置換'],
  ];

  function renderRun() {
    const es = entries();
    const enabledRules = COMMON_RULES.filter((r) => settings.rules[r.id]).length;
    let h = `<div class="chk-bar">
      <label>範囲 <select data-set="scope">
        <option value="ep"${scope === 'ep' ? ' selected' : ''}>この話</option>
        <option value="chapter"${scope === 'chapter' ? ' selected' : ''}>この章</option>
        <option value="work"${scope === 'work' ? ' selected' : ''}>作品全体</option>
      </select></label>
      <button type="button" class="btn small primary" data-act="run">チェックする</button>
    </div>
    <p class="note">辞書：用語${terms.length}件・人物${linkedPeople().length}人／よくあるゆれ：${enabledRules ? `${enabledRules}種類` : 'なし（「設定」で選べます）'}</p>`;
    if (lastUndo) h += `<div class="chk-undo"><span>直前の置換を取り消せます</span><button type="button" class="btn small" data-act="undo">元に戻す</button></div>`;
    if (!result) {
      h += es.length || enabledRules
        ? '<p class="chk-empty">「チェックする」を押すと、表記ゆれやルビ漏れを一覧にします。</p>'
        : '<p class="chk-empty">まず「用語辞書」に用語を登録するか、「設定」でよくある表記ゆれを選んでください。</p>';
    } else {
      const total = result.groups.reduce((a, g) => a + g.occ.length, 0);
      const t = result.at;
      h += `<p class="chk-summary">${esc(result.scopeLabel)}（${result.count}話）：${total ? `<b>${total}件</b>` : '見つかりませんでした'}<small>${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')} にチェック</small></p>`;
      for (const [type, title] of SECTIONS) {
        const gs = result.groups.filter((g) => g.type === type);
        if (!gs.length) continue;
        h += `<section class="chk-sec"><h4>${title}<span>${gs.reduce((a, g) => a + g.occ.length, 0)}</span></h4>${gs.map(groupHtml).join('')}</section>`;
      }
    }
    h += `<details class="chk-search"${search.open ? ' open' : ''}>
      <summary>検索して置換</summary>
      <form data-form="search">
        <label>検索<input type="text" name="find" value="${esc(search.find)}" required></label>
        <label>置換<input type="text" name="to" value="${esc(search.to)}"></label>
        <button type="submit" class="btn small">箇所を探す</button>
      </form>
      <p class="note">範囲（上で選んだもの）の中から探して、置換する箇所を1件ずつ選べます。ルビの読みは対象外です。</p>
    </details>`;
    return h;
  }

  function termHtml(t) {
    return `<li class="term">
      <div class="term-main"><b>${esc(t.word)}</b>${t.ruby ? `<span class="term-ruby">（${esc(t.ruby)}）</span>` : ''}</div>
      ${t.variants && t.variants.length ? `<div class="term-sub">ゆれ：${t.variants.map(esc).join('、')}</div>` : ''}
      ${t.memo ? `<div class="term-memo">${esc(t.memo)}</div>` : ''}
      <div class="term-acts">
        <button type="button" data-act="edit-term" data-id="${esc(t.id)}">編集</button>
        <button type="button" class="danger" data-act="del-term" data-id="${esc(t.id)}">削除</button>
      </div>
    </li>`;
  }

  function termForm() {
    const t = editing === 'new' ? { word: '', variants: [], ruby: '', memo: '' } : terms.find((x) => x.id === editing);
    if (!t) return '';
    return `<form class="term-form" data-form="term">
      <h4>${editing === 'new' ? '用語を追加' : '用語を編集'}</h4>
      <label>正しい表記<input type="text" name="word" value="${esc(t.word)}" required></label>
      <label>ゆれやすい表記<input type="text" name="variants" value="${esc((t.variants || []).join('、'))}" placeholder="「、」で区切って複数"></label>
      <label>ルビ<input type="text" name="ruby" value="${esc(t.ruby || '')}" placeholder="初出でルビを付ける場合の読み"></label>
      <label>メモ<textarea name="memo" rows="2">${esc(t.memo || '')}</textarea></label>
      <div class="dialog-actions">
        <button type="button" class="btn small" data-act="cancel-term">キャンセル</button>
        <button type="submit" class="btn small primary">保存</button>
      </div>
    </form>`;
  }

  function renderDict() {
    const q = dictFilter.trim();
    const shown = terms.filter((t) => !q || [t.word, t.ruby, t.memo, ...(t.variants || [])].some((x) => x && x.includes(q)))
      .sort((a, b) => (a.ruby || a.word).localeCompare(b.ruby || b.word, 'ja'));
    let h = `<div class="chk-bar">
      <input type="search" data-set="dict-filter" value="${esc(dictFilter)}" placeholder="辞書を検索" aria-label="辞書を検索">
      <button type="button" class="btn small primary" data-act="new-term">＋ 用語を追加</button>
    </div>`;
    if (editing) h += termForm();
    h += terms.length
      ? `<ul class="term-list">${shown.map(termHtml).join('') || '<li class="note">見つかりません。</li>'}</ul>`
      : '<p class="chk-empty">この作品の用語はまだありません。「＋ 用語を追加」で、正しい表記・ゆれやすい表記・ルビ・メモを登録できます。</p>';

    // 人物事典
    h += '<h4 class="dict-h">人物事典から（名前・別名）</h4>';
    if (!peopleData) {
      h += '<p class="note">人物事典が見つかりません。人物事典に登録すると、名前・別名もここで辞書として使われます。</p>';
    } else {
      if (peopleData.works.length && peopleData.people.some((p) => p.workId)) {
        const w = curWork();
        const auto = !settings.peopleWorkId && w && peopleData.works.find((x) => x.title === w.title);
        h += `<label class="people-link">使う人物事典の作品 <select data-set="people-work">
          <option value="">${auto ? `自動（同じ名前の「${esc(auto.title)}」）` : '選んでください'}</option>
          ${peopleData.works.map((x) => `<option value="${esc(x.id)}"${settings.peopleWorkId === x.id ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}
        </select></label>`;
      }
      const ps = linkedPeople();
      h += ps.length
        ? `<ul class="term-list people">${ps.map((p) => `<li class="term"><div class="term-main"><b>${esc(p.name)}</b>${p.ruby ? `<span class="term-ruby">（${esc(p.ruby)}）</span>` : ''}</div>
            ${p.aliases.length ? `<div class="term-sub">別名：${p.aliases.map(esc).join('、')}</div>` : ''}
            ${p.variants.length ? `<div class="term-sub">ゆれ：${p.variants.map(esc).join('、')}</div>` : ''}</li>`).join('')}</ul>`
        : '<p class="note">この作品の人物は見つかりませんでした。</p>';
      h += '<p class="note">人物の名前・別名はどれも「正しい表記」として扱います。編集は人物事典で行ってください。</p>';
    }
    return h;
  }

  function renderRules() {
    let h = `<h4 class="dict-h">ルビの初出</h4>
      <label class="opt"><input type="radio" name="rubyMode" data-set="ruby-mode" value="work"${settings.rubyMode !== 'episode' ? ' checked' : ''}> 作品全体で最初に出てくるところにルビがあるか</label>
      <label class="opt"><input type="radio" name="rubyMode" data-set="ruby-mode" value="episode"${settings.rubyMode === 'episode' ? ' checked' : ''}> 話ごとに、最初に出てくるところにルビがあるか</label>
      <h4 class="dict-h">辞書にない表記ゆれの候補</h4>
      <label class="opt"><input type="checkbox" data-set="candidates"${settings.candidates ? ' checked' : ''}> 辞書の語や人物名に近い表記を候補として出す</label>
      <p class="note">例：「渡邊」（「渡辺」の異体字）、「アレキサンダー」（「アレクサンダー」と1文字違い）、「魔道具」（「魔導具」と1文字違い）など。</p>`;
    if (settings.ignore.length) {
      h += `<div class="ignore-list">無視している候補：${settings.ignore.map((w) => `<span class="chip">${esc(w)}<button type="button" data-act="unignore" data-word="${esc(w)}" aria-label="${esc(w)} を候補に戻す">×</button></span>`).join('')}</div>`;
    }
    h += '<h4 class="dict-h">よくある表記ゆれ（チェックしたものだけ）</h4><p class="note">統一したい表記を選ぶと、もう一方の表記を指摘します。</p><ul class="rule-list">';
    for (const r of COMMON_RULES) {
      const pref = settings.rules[r.id];
      h += `<li class="rule${pref ? ' on' : ''}">
        <label class="opt"><input type="checkbox" data-set="rule" data-rule="${r.id}"${pref ? ' checked' : ''}> <b>${esc(r.label)}</b>${r.note ? `<small>${esc(r.note)}</small>` : ''}</label>
        <div class="rule-forms"${pref ? '' : ' hidden'}>統一先：${r.forms.map((f) => `<label><input type="radio" name="rule-${r.id}" data-set="rule-pref" data-rule="${r.id}" value="${f.key}"${pref === f.key ? ' checked' : ''}> ${esc(f.label)}</label>`).join('')}</div>
      </li>`;
    }
    h += '</ul>';
    return h;
  }

  function render() {
    if (!C.pane) return;
    document.querySelectorAll('button[data-cview]').forEach((b) => b.classList.toggle('on', b.dataset.cview === view));
    if (!checkWork) { C.body.innerHTML = '<p class="chk-empty">作品を開くと使えます。</p>'; return; }
    C.body.innerHTML = view === 'dict' ? renderDict() : view === 'rules' ? renderRules() : renderRun();
  }

  function renderSide() {
    const side = ui.sideTab === 'check' ? 'check' : 'refs';
    document.querySelectorAll('button[data-side]').forEach((b) => {
      b.classList.toggle('on', b.dataset.side === side);
      b.setAttribute('aria-selected', String(b.dataset.side === side));
    });
    C.refsPane.hidden = side !== 'refs';
    C.pane.hidden = side !== 'check';
    if (side === 'check') render();
  }

  /* ----- 操作 ----- */

  const groupByKey = (k) => (result ? result.groups.find((g) => g.key === k) : null);

  C.body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.tagName === 'INPUT') return;
    const g = b.dataset.key ? groupByKey(b.dataset.key) : null;
    switch (b.dataset.act) {
      case 'run': await flushSave(); run(); break;
      case 'toggle':
        if (openGroups.has(b.dataset.key)) openGroups.delete(b.dataset.key); else openGroups.add(b.dataset.key);
        render();
        break;
      case 'jump': if (g) jump(g.occ[Number(b.dataset.i)]); break;
      case 'replace':
        if (!g) break;
        replacing = g.key;
        replaceSel = new Set(g.occ.map((_, i) => i));
        render();
        break;
      case 'sel-all': { const rg = groupByKey(replacing); if (rg) replaceSel = new Set(rg.occ.map((_, i) => i)); render(); break; }
      case 'sel-none': replaceSel = new Set(); render(); break;
      case 'rep-cancel':
        if (result) result.groups = result.groups.filter((x) => x.type !== 'search' || x.key !== replacing);
        replacing = null;
        render();
        break;
      case 'rep-apply': {
        const rg = groupByKey(replacing);
        if (!rg || !replaceSel.size) break;
        const items = rg.occ.filter((_, i) => replaceSel.has(i));
        const eps = new Set(items.map((o) => o.ep.id)).size;
        if (!confirm(`${eps}話の${items.length}か所を置換します。よろしいですか？\n（直後なら「元に戻す」で取り消せます）`)) break;
        replacing = null;
        await applyReplacements(items);
        break;
      }
      case 'ruby-fix': {
        if (!g) break;
        const o = g.occ[0];
        await applyReplacements([o]);
        break;
      }
      case 'ignore':
        if (!g) break;
        settings.ignore = [...new Set([...settings.ignore, g.surface])];
        await saveSettings();
        result.groups = result.groups.filter((x) => x !== g);
        render();
        break;
      case 'add-variant': {
        if (!g) break;
        const t = terms.find((x) => x.word === g.target);
        if (!t) break;
        await saveTerm({ ...t, variants: [...new Set([...(t.variants || []), g.surface])] });
        setStatus(`「${g.surface}」を「${t.word}」のゆれとして登録しました`);
        run();
        break;
      }
      case 'undo': await undoLast(); break;
      case 'new-term': editing = 'new'; render(); C.body.querySelector('input[name="word"]').focus(); break;
      case 'edit-term': editing = b.dataset.id; render(); C.body.querySelector('input[name="word"]').focus(); break;
      case 'cancel-term': editing = null; render(); break;
      case 'del-term': { const t = terms.find((x) => x.id === b.dataset.id); if (t) await removeTerm(t); break; }
      case 'unignore':
        settings.ignore = settings.ignore.filter((w) => w !== b.dataset.word);
        await saveSettings();
        render();
        break;
      default: break;
    }
  });

  C.body.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.sel !== undefined) {
      const i = Number(t.dataset.sel);
      if (t.checked) replaceSel.add(i); else replaceSel.delete(i);
      const btn = C.body.querySelector('[data-act="rep-apply"]');
      if (btn) { btn.disabled = !replaceSel.size; btn.textContent = `選んだ${replaceSel.size}件を置換`; }
      return;
    }
    switch (t.dataset.set) {
      case 'scope': scope = t.value; result = null; replacing = null; render(); break;
      case 'ruby-mode': settings.rubyMode = t.value; await saveSettings(); break;
      case 'candidates': settings.candidates = t.checked; await saveSettings(); break;
      case 'rule': {
        const r = COMMON_RULES.find((x) => x.id === t.dataset.rule);
        if (t.checked) settings.rules[r.id] = settings.rules[r.id] || r.forms[0].key; else delete settings.rules[r.id];
        await saveSettings();
        render();
        break;
      }
      case 'rule-pref': settings.rules[t.dataset.rule] = t.value; await saveSettings(); break;
      case 'people-work': settings.peopleWorkId = t.value || null; await saveSettings(); render(); break;
      default: break;
    }
  });

  C.body.addEventListener('toggle', (e) => {
    if (e.target.classList && e.target.classList.contains('chk-search')) search.open = e.target.open;
  }, true);

  C.body.addEventListener('input', (e) => {
    const f = e.target.form;
    if (f && f.dataset.form === 'search') { search.find = f.find.value; search.to = f.to.value; return; }
    if (e.target.dataset.set !== 'dict-filter') return;
    dictFilter = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const inp = C.body.querySelector('[data-set="dict-filter"]');
    inp.focus();
    inp.setSelectionRange(pos, pos);
  });

  C.body.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.dataset.form === 'term') {
      const word = f.word.value.trim();
      if (!word) return;
      const dup = terms.find((x) => x.word === word && x.id !== editing);
      if (dup) { alert(`「${word}」はすでに辞書にあります。`); return; }
      const base = editing === 'new' ? { id: uid(), workId: checkWork, created: Date.now() } : terms.find((x) => x.id === editing);
      await saveTerm({ ...base, word, variants: splitList(f.variants.value).filter((v) => v !== word), ruby: f.ruby.value.trim(), memo: f.memo.value.trim(), updated: Date.now() });
      editing = null;
      render();
      setStatus(`用語「${word}」を保存しました`);
    } else if (f.dataset.form === 'search') {
      const find = f.find.value;
      const to = f.to.value;
      if (!find) return;
      await flushSave();
      const flat = flatEpisodes();
      const numbers = new Map(flat.map((x, i) => [x.id, i + 1]));
      const found = scopeEpisodes().flatMap((ep) => findWord(buildDoc(ep, numbers.get(ep.id)), find)).map((o) => ({ ...o, to }));
      if (!result) result = { at: new Date(), scope, scopeLabel: scopeLabel(), count: scopeEpisodes().length, groups: [] };
      result.groups = result.groups.filter((x) => x.type !== 'search');
      if (!found.length) { setStatus(`「${find}」は見つかりませんでした`); render(); return; }
      const g = { type: 'search', key: `s:${find}`, label: `「${find}」→「${to}」`, sub: '', occ: found };
      result.groups.push(g);
      replacing = g.key;
      replaceSel = new Set(found.map((_, i) => i));
      render();
    }
  });

  document.querySelectorAll('button[data-cview]').forEach((b) => b.addEventListener('click', () => {
    view = b.dataset.cview;
    editing = null;
    render();
  }));
  document.querySelectorAll('button[data-side]').forEach((b) => b.addEventListener('click', () => {
    ui.sideTab = b.dataset.side;
    saveUI();
    renderSide();
  }));

  /* ----- 作品の切り替え・読み込み ----- */

  async function loadPeople() {
    try { peopleData = await PeopleSource.load(); } catch (e) { console.error(e); peopleData = null; }
  }

  async function reload() {
    const wid = checkWork;
    if (!wid) { terms = []; settings = defaults(); render(); return; }
    const [ts, st] = await Promise.all([DB.terms(wid), DB.checkSettings(wid)]);
    if (checkWork !== wid) return;
    terms = ts;
    settings = { ...defaults(), ...(st || {}) };
    if (editing && editing !== 'new' && !terms.some((t) => t.id === editing)) editing = null;
    render();
  }

  async function setWork(id) {
    if (checkWork !== id) {
      checkWork = id;
      result = null;
      replacing = null;
      editing = null;
      lastUndo = null;
      openGroups.clear();
      terms = [];
      settings = defaults();
    }
    await reload();
  }

  PeopleSource.onChange(async () => { await loadPeople(); render(); });
  // 別のタブで人物事典を開いて戻ってきたときにも読み直す
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && ui.sideTab === 'check') { await loadPeople(); render(); }
  });

  loadPeople().then(render);
  renderSide();

  return { setWork, reload, renderSide };
})();
