'use strict';

/* =========================================================
   資料ビューア
   読み込んだ MD ファイルはブラウザ内（IndexedDB）に保存します。
   原稿とは別の保存場所なので、原稿の保存容量を圧迫しません。
   app.js の $, ui, saveUI, esc, decodeText, wideMQ を使います。
   ========================================================= */

(() => {
  const R = {
    panel: $('#refs'), splitter: $('#splitter'), content: $('#content'),
    listBtn: $('#refListBtn'), name: $('#refName'), tocBtn: $('#refTocBtn'),
    list: $('#refList'), toc: $('#refToc'), body: $('#refBody'),
    file: $('#refFile'), toggle: $('#refsToggle'),
  };

  if (ui.refsOpen === undefined) ui.refsOpen = true;
  if (!ui.refW) ui.refW = 420;
  if (!ui.mtab) ui.mtab = 'write';
  if (ui.tocOpen === undefined) ui.tocOpen = false;

  let refs = []; // { id, name, text, added }
  let headings = [];
  let persistent = true;

  /* ---------- IndexedDB ---------- */

  const DB_NAME = 'noveltool-refs';
  const STORE = 'files';
  let dbPromise = null;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function run(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  async function persist(op) {
    if (!persistent) return;
    try {
      await op();
    } catch (e) {
      console.error(e);
      persistent = false;
      alert('資料をブラウザに保存できませんでした。表示はできますが、再読み込みすると消えます。');
    }
  }

  /* ---------- Markdown ---------- */

  const KANJI_CLS = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u{20000}-\\u{2FFFF}々〆〇ヶ仝';
  // エスケープ済みの HTML に対してカクヨム記法を適用（タグをまたがない）
  const MD_RUBY_RE = new RegExp(
    '《《([^《》<>\\n]+?)》》' +
    '|[｜|]《' +
    '|[｜|]([^｜|《》<>\\n]{1,50})《([^《》<>\\n]{1,50})》' +
    `|([${KANJI_CLS}]{1,20})《([^《》<>\\n]{1,50})》`,
    'gu'
  );
  function rubyify(html) {
    return html.replace(MD_RUBY_RE, (m, bouten, pb, pr, kb, kr) => {
      if (bouten !== undefined) return `<em class="bouten">${bouten}</em>`;
      if (pb !== undefined) return `<ruby>${pb}<rp>《</rp><rt>${pr}</rt><rp>》</rp></ruby>`;
      if (kb !== undefined) return `<ruby>${kb}<rp>《</rp><rt>${kr}</rt><rp>》</rp></ruby>`;
      return '《';
    });
  }

  function fmtInline(s) {
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;.*?&quot;)?\)/g, (m, alt) => `<span class="md-img">［画像${alt ? '：' + alt : ''}］</span>`);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;.*?&quot;)?\)/g, (m, text, url) =>
      /^(https?:|mailto:)/i.test(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>` : text);
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
    s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
    s = s.replace(/(^|[^*])\*([^*\s](?:[^*]*?[^*\s])?)\*(?!\*)/g, '$1<em>$2</em>');
    return rubyify(s);
  }

  function inline(raw) {
    return raw.split(/(`[^`]+`)/).map((p, i) => (i % 2 ? `<code>${esc(p.slice(1, -1))}</code>` : fmtInline(p))).join('');
  }

  function plainText(raw) {
    return raw
      .replace(/`/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|~~|\*/g, '')
      .replace(/《《(.+?)》》/g, '$1')
      .replace(/[｜|]([^《》]+?)《[^《》]*》/g, '$1')
      .replace(/《[^《》]*》/g, '')
      .trim();
  }

  const RE = {
    blank: /^\s*$/,
    fence: /^ {0,3}(```+|~~~+)/,
    atx: /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/,
    hr: /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/,
    quote: /^ {0,3}>/,
    list: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
    tableSep: /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
    setext1: /^ {0,3}=+\s*$/,
    setext2: /^ {0,3}-+\s*$/,
  };

  function isTableStart(lines, i) {
    return lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && RE.tableSep.test(lines[i + 1]);
  }
  function startsBlock(lines, i) {
    const l = lines[i];
    return RE.blank.test(l) || RE.fence.test(l) || RE.atx.test(l) || RE.hr.test(l) || RE.quote.test(l) || RE.list.test(l) || isTableStart(lines, i);
  }
  const indentOf = (l) => l.match(/^\s*/)[0].length;
  function dedent(lines) {
    const n = Math.min(...lines.filter((l) => !RE.blank.test(l)).map(indentOf));
    return lines.map((l) => l.slice(Math.min(n, indentOf(l))));
  }
  function splitRow(row) {
    return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  }

  function heading(level, raw, ctx) {
    const id = 'ref-h-' + ctx.heads.length;
    ctx.heads.push({ level, text: plainText(raw) || '（無題の見出し）', id });
    return `<h${level} id="${id}">${inline(raw)}</h${level}>`;
  }

  function blocks(lines, ctx) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      let m;
      if (RE.blank.test(l)) { i++; continue; }

      if ((m = l.match(RE.fence))) {
        const fence = m[1];
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }
      if ((m = l.match(RE.atx))) {
        out.push(heading(m[1].length, m[2] || '', ctx));
        i++;
        continue;
      }
      if (RE.hr.test(l)) { out.push('<hr>'); i++; continue; }

      if (RE.quote.test(l)) {
        const buf = [];
        while (i < lines.length && !RE.blank.test(lines[i]) && (RE.quote.test(lines[i]) || !startsBlock(lines, i))) {
          buf.push(lines[i++].replace(/^ {0,3}> ?/, ''));
        }
        out.push(`<blockquote>${blocks(buf, ctx)}</blockquote>`);
        continue;
      }

      if (isTableStart(lines, i)) {
        const head = splitRow(lines[i]);
        const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
        i += 2;
        const rows = [];
        while (i < lines.length && !RE.blank.test(lines[i]) && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
        const cell = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
        out.push('<div class="table-wrap"><table><thead><tr>' + head.map((c, k) => cell('th', c, k)).join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + head.map((_, k) => cell('td', r[k] || '', k)).join('') + '</tr>').join('') + '</tbody></table></div>');
        continue;
      }

      if ((m = l.match(RE.list))) {
        i = list(lines, i, ctx, out);
        continue;
      }

      // 段落（改行はそのまま改行として表示）
      const buf = [l];
      i++;
      let setext = 0;
      while (i < lines.length) {
        if (RE.setext1.test(lines[i])) { setext = 1; i++; break; }
        if (RE.setext2.test(lines[i])) { setext = 2; i++; break; }
        if (startsBlock(lines, i)) break;
        buf.push(lines[i++]);
      }
      if (setext) out.push(heading(setext, buf.map((s) => s.trim()).join(' '), ctx));
      else out.push(`<p>${buf.map((s) => inline(s.trim())).join('<br>')}</p>`);
    }
    return out.join('');
  }

  function list(lines, i, ctx, out) {
    const first = lines[i].match(RE.list);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const start = ordered ? parseInt(first[2], 10) : 1;
    const items = [];
    let cur = null;
    while (i < lines.length) {
      const l = lines[i];
      const m = l.match(RE.list);
      if (m && m[1].length === indent && /\d/.test(m[2]) === ordered) {
        cur = { text: [m[3]], sub: [] };
        items.push(cur);
        i++;
      } else if (RE.blank.test(l)) {
        let j = i + 1;
        while (j < lines.length && RE.blank.test(lines[j])) j++;
        const nm = j < lines.length ? lines[j].match(RE.list) : null;
        const continues = j < lines.length && (indentOf(lines[j]) > indent || (nm && nm[1].length === indent && /\d/.test(nm[2]) === ordered));
        if (!continues) break;
        if (cur.sub.length) cur.sub.push('');
        i++;
      } else if (indentOf(l) > indent) {
        cur.sub.push(l);
        i++;
      } else if (!cur.sub.length && !startsBlock(lines, i) && !RE.blank.test(lines[i - 1])) {
        cur.text.push(l.trim());
        i++;
      } else {
        break;
      }
    }
    const tag = ordered ? 'ol' : 'ul';
    const attr = ordered && start !== 1 ? ` start="${start}"` : '';
    out.push(`<${tag}${attr}>` + items.map((it) => {
      let text = it.text.map((s) => inline(s)).join('<br>');
      let cls = '';
      const task = it.text[0].match(/^\[([ xX])\]\s+/);
      if (task) {
        cls = ' class="task"';
        text = `<span class="check">${task[1] === ' ' ? '☐' : '☑'}</span>` + inline(it.text[0].slice(task[0].length)) +
          it.text.slice(1).map((s) => '<br>' + inline(s)).join('');
      }
      const sub = it.sub.length ? blocks(dedent(it.sub), ctx) : '';
      return `<li${cls}>${text}${sub}</li>`;
    }).join('') + `</${tag}>`);
    return i;
  }

  function renderMarkdown(src) {
    const lines = src.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    const ctx = { heads: [] };
    const html = blocks(lines, ctx);
    return { html, heads: ctx.heads };
  }

  /* ---------- 表示 ---------- */

  function current() { return refs.find((r) => r.id === ui.refId) || null; }

  function renderList() {
    const items = refs.map((r) => `
      <li class="${r.id === ui.refId ? 'current' : ''}">
        <button type="button" class="ref-item" data-id="${r.id}">${esc(r.name)}</button>
        <button type="button" class="icon-btn danger" data-del="${r.id}" title="この資料を削除" aria-label="${esc(r.name)} を削除">✕</button>
      </li>`).join('');
    R.list.innerHTML = (refs.length ? `<ul>${items}</ul>` : '<p class="note">まだ資料がありません。</p>') +
      `<p class="note">資料はこのブラウザ内だけに保存され、リポジトリや書き出しファイルには含まれません。同じ名前のファイルを読み込むと上書きします。${persistent ? '' : '<br><b>※ このブラウザでは保存できないため、再読み込みで消えます。</b>'}</p>`;
  }

  function renderToc() {
    R.toc.innerHTML = headings.length
      ? headings.map((h) => `<button type="button" class="toc-item lv${h.level}" data-target="${h.id}">${esc(h.text)}</button>`).join('')
      : '<p class="note">この資料には見出しがありません。</p>';
    markActiveHeading();
  }

  function renderDoc() {
    const r = current();
    R.name.textContent = r ? r.name : (refs.length ? '資料を選択' : '資料');
    if (!r) {
      headings = [];
      R.body.innerHTML = `<div class="ref-empty"><p>設定資料やプロットなどの Markdown（.md）ファイルを読み込むと、ここに表示されます。</p>
        <button type="button" class="btn primary" data-act="ref-add">MDファイルを読み込む</button></div>`;
    } else {
      const { html, heads } = renderMarkdown(r.text);
      headings = heads;
      R.body.innerHTML = html || '<p class="note">（空のファイルです）</p>';
    }
    R.body.scrollTop = 0;
    renderToc();
  }

  function renderRefsLayout() {
    document.body.dataset.refs = ui.refsOpen ? 'open' : 'closed';
    document.body.dataset.mtab = ui.mtab;
    R.toggle.classList.toggle('on', ui.refsOpen);
    R.toggle.setAttribute('aria-pressed', String(ui.refsOpen));
    document.querySelectorAll('button[data-mtab]').forEach((b) => b.classList.toggle('on', b.dataset.mtab === ui.mtab));
    R.toc.hidden = !ui.tocOpen;
    R.tocBtn.classList.toggle('on', ui.tocOpen);
    R.tocBtn.setAttribute('aria-pressed', String(ui.tocOpen));
    applyWidth();
  }

  /* ---------- 読み込み・削除・切り替え ---------- */

  async function importFiles(files) {
    let last = null;
    for (const f of files) {
      let text;
      try {
        text = decodeText(await f.arrayBuffer());
      } catch (e) {
        console.error(e);
        alert(`「${f.name}」を読み込めませんでした。`);
        continue;
      }
      let rec = refs.find((r) => r.name === f.name);
      if (rec) {
        rec.text = text;
        rec.added = Date.now();
      } else {
        rec = { id: uid(), name: f.name, text, added: Date.now() };
        refs.push(rec);
      }
      const saved = { ...rec };
      await persist(() => run('readwrite', (st) => st.put(saved)));
      last = rec;
    }
    if (!last) return;
    sortRefs();
    ui.refId = last.id;
    saveUI();
    R.list.hidden = true;
    R.listBtn.setAttribute('aria-expanded', 'false');
    renderList();
    renderDoc();
  }

  async function removeRef(id) {
    const r = refs.find((x) => x.id === id);
    if (!r || !confirm(`資料「${r.name}」を削除しますか？\n（元のファイルは消えません）`)) return;
    refs = refs.filter((x) => x !== r);
    await persist(() => run('readwrite', (st) => st.delete(id)));
    if (ui.refId === id) ui.refId = refs[0] ? refs[0].id : null;
    saveUI();
    renderList();
    renderDoc();
  }

  function selectRef(id) {
    ui.refId = id;
    saveUI();
    R.list.hidden = true;
    R.listBtn.setAttribute('aria-expanded', 'false');
    renderList();
    renderDoc();
  }

  function sortRefs() {
    refs.sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
  }

  R.listBtn.addEventListener('click', () => {
    R.list.hidden = !R.list.hidden;
    R.listBtn.setAttribute('aria-expanded', String(!R.list.hidden));
  });
  R.list.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { removeRef(del.dataset.del); return; }
    const item = e.target.closest('[data-id]');
    if (item) selectRef(item.dataset.id);
  });
  $('#refAdd').addEventListener('click', () => R.file.click());
  R.body.addEventListener('click', (e) => { if (e.target.closest('[data-act="ref-add"]')) R.file.click(); });
  R.file.addEventListener('change', () => {
    const files = Array.from(R.file.files);
    R.file.value = '';
    if (files.length) importFiles(files);
  });

  // ファイルを資料パネルにドラッグ＆ドロップしても読み込めます
  R.panel.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); R.panel.classList.add('dropping'); } });
  R.panel.addEventListener('dragleave', (e) => { if (!R.panel.contains(e.relatedTarget)) R.panel.classList.remove('dropping'); });
  R.panel.addEventListener('drop', (e) => {
    R.panel.classList.remove('dropping');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    importFiles(Array.from(e.dataTransfer.files));
  });

  /* ---------- 目次 ---------- */

  R.tocBtn.addEventListener('click', () => {
    ui.tocOpen = !ui.tocOpen;
    saveUI();
    renderRefsLayout();
  });
  R.toc.addEventListener('click', (e) => {
    const b = e.target.closest('[data-target]');
    if (!b) return;
    const target = R.body.querySelector('#' + b.dataset.target);
    if (!target) return;
    R.body.scrollTo({ top: target.offsetTop - 8, behavior: 'smooth' });
    if (!wideMQ.matches) {
      ui.tocOpen = false;
      saveUI();
      renderRefsLayout();
    }
  });

  let tocRaf = 0;
  function markActiveHeading() {
    if (R.toc.hidden || !headings.length) return;
    const top = R.body.scrollTop + 24;
    let active = headings[0].id;
    for (const h of headings) {
      const el = R.body.querySelector('#' + h.id);
      if (el && el.offsetTop <= top) active = h.id; else break;
    }
    R.toc.querySelectorAll('.toc-item').forEach((b) => {
      const on = b.dataset.target === active;
      if (on && !b.classList.contains('active')) {
        const top = b.offsetTop;
        if (top < R.toc.scrollTop || top + b.offsetHeight > R.toc.scrollTop + R.toc.clientHeight) {
          R.toc.scrollTop = top - R.toc.clientHeight / 2;
        }
      }
      b.classList.toggle('active', on);
    });
  }
  R.body.addEventListener('scroll', () => {
    cancelAnimationFrame(tocRaf);
    tocRaf = requestAnimationFrame(markActiveHeading);
  });

  /* ---------- 表示／非表示・タブ ---------- */

  function setRefsOpen(open) {
    ui.refsOpen = open;
    saveUI();
    renderRefsLayout();
  }
  R.toggle.addEventListener('click', () => setRefsOpen(!ui.refsOpen));
  $('#refsClose').addEventListener('click', () => setRefsOpen(false));
  document.querySelectorAll('button[data-mtab]').forEach((b) => b.addEventListener('click', () => {
    ui.mtab = b.dataset.mtab;
    saveUI();
    renderRefsLayout();
  }));

  /* ---------- 境目のドラッグ ---------- */

  const MIN_REF = 240;
  const MIN_WRITER = 360;
  function clampWidth(w) {
    const max = Math.max(MIN_REF, R.content.clientWidth - MIN_WRITER);
    return Math.round(Math.min(max, Math.max(MIN_REF, w)));
  }
  function applyWidth() {
    if (!wideMQ.matches) { R.panel.style.width = ''; return; }
    R.panel.style.width = clampWidth(ui.refW) + 'px';
  }

  let drag = null;
  R.splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    R.splitter.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, w: R.panel.getBoundingClientRect().width };
    document.body.classList.add('resizing');
  });
  R.splitter.addEventListener('pointermove', (e) => {
    if (!drag) return;
    ui.refW = clampWidth(drag.w - (e.clientX - drag.x));
    R.panel.style.width = ui.refW + 'px';
  });
  function endDrag() {
    if (!drag) return;
    drag = null;
    document.body.classList.remove('resizing');
    saveUI();
  }
  R.splitter.addEventListener('pointerup', endDrag);
  R.splitter.addEventListener('pointercancel', endDrag);
  R.splitter.addEventListener('dblclick', () => { ui.refW = 420; applyWidth(); saveUI(); });
  R.splitter.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 80 : 20;
    if (e.key === 'ArrowLeft') ui.refW = clampWidth(ui.refW + step);
    else if (e.key === 'ArrowRight') ui.refW = clampWidth(ui.refW - step);
    else return;
    e.preventDefault();
    applyWidth();
    saveUI();
  });
  window.addEventListener('resize', applyWidth);
  wideMQ.addEventListener('change', applyWidth);

  /* ---------- 起動 ---------- */

  renderRefsLayout();
  renderList();
  renderDoc();

  (async () => {
    try {
      refs = (await run('readonly', (st) => st.getAll())) || [];
    } catch (e) {
      console.error(e);
      persistent = false;
      refs = [];
    }
    sortRefs();
    if (!current()) ui.refId = refs[0] ? refs[0].id : null;
    renderList();
    renderDoc();
  })();
})();
