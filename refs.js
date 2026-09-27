'use strict';

/* =========================================================
   資料ビューア
   資料（MDファイル）は作品ごとに IndexedDB に保存します（db.js）。
   app.js の $, ui, saveUI, esc, decodeText, wideMQ, setStatus, curWork を使います。
   ========================================================= */

const Refs = (() => {
  const R = {
    panel: $('#refs'), splitter: $('#splitter'), content: $('#content'),
    listBtn: $('#refListBtn'), name: $('#refName'), tocBtn: $('#refTocBtn'),
    list: $('#refList'), toc: $('#refToc'), body: $('#refBody'),
    file: $('#refFile'), folder: $('#refFolder'), toggle: $('#refsToggle'),
  };

  let refs = [];        // 開いている作品の資料
  let headings = [];
  let refsWork = null;  // 資料を表示している作品
  const selected = new Set();

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

  const byName = (a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true });
  const isDoc = (name) => /\.(md|markdown|txt)$/i.test(name);

  function current() { return refs.find((r) => r.id === ui.refId) || null; }

  function renderList() {
    if (!refsWork) {
      R.list.innerHTML = '<p class="note">作品を開くと、その作品の資料を読み込めます。</p>';
      return;
    }
    for (const id of [...selected]) if (!refs.some((r) => r.id === id)) selected.delete(id);
    const all = refs.length > 0 && selected.size === refs.length;
    const items = refs.map((r) => `
      <li class="${r.id === ui.refId ? 'current' : ''}">
        <input type="checkbox" class="ref-check" data-check="${esc(r.id)}"${selected.has(r.id) ? ' checked' : ''} aria-label="${esc(r.name)} を選択">
        <button type="button" class="ref-item" data-id="${esc(r.id)}" title="${esc(r.path || r.name)}">${esc(r.name)}</button>
      </li>`).join('');
    R.list.innerHTML = `
      <div class="ref-tools">
        <button type="button" class="btn small" data-act="pick-files">ファイルを選ぶ</button>
        <button type="button" class="btn small" data-act="pick-folder">フォルダを選ぶ</button>
      </div>
      ${refs.length ? `
        <div class="ref-bulk">
          <label><input type="checkbox" data-act="check-all"${all ? ' checked' : ''}> すべて選択</label>
          <button type="button" class="btn small danger" data-act="delete-selected"${selected.size ? '' : ' disabled'}>選択した資料を削除${selected.size ? `（${selected.size}件）` : ''}</button>
        </div>
        <ul>${items}</ul>
        <button type="button" class="btn small danger ref-delete-all" data-act="delete-all">この作品の資料をすべて削除</button>`
        : '<p class="note">この作品の資料はまだありません。</p>'}
      <p class="note">資料は作品ごとにこのブラウザ内へ保存され、リポジトリには含まれません。同じファイル名を読み込むと上書き更新します。ファイルやフォルダは、この欄にドラッグ＆ドロップしても読み込めます。</p>`;
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
      R.body.innerHTML = refsWork
        ? `<div class="ref-empty"><p>この作品の設定資料やプロットなどの Markdown（.md）ファイルを読み込むと、ここに表示されます。</p>
            <p class="ref-empty-actions">
              <button type="button" class="btn primary" data-act="pick-files">ファイルを選ぶ</button>
              <button type="button" class="btn" data-act="pick-folder">フォルダを選ぶ</button>
            </p>
            <p class="note">ファイルやフォルダをここにドラッグ＆ドロップしても読み込めます。</p></div>`
        : '';
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

  function closeList() {
    R.list.hidden = true;
    R.listBtn.setAttribute('aria-expanded', 'false');
  }

  /* ---------- 作品ごとの資料 ---------- */

  async function load() {
    const wid = refsWork;
    const prev = current();
    let list = [];
    if (wid) {
      try { list = await DB.refs(wid); } catch (e) { console.error(e); }
    }
    if (refsWork !== wid) return;
    refs = list.sort(byName);
    if (!current()) ui.refId = refs[0] ? refs[0].id : null;
    renderList();
    const now = current();
    // 表示中の資料が変わっていなければ、スクロール位置を保つ
    if (!(prev && now && prev.id === now.id && prev.text === now.text)) renderDoc();
    else R.name.textContent = now.name;
  }

  function setWork(id) {
    if (refsWork === id) { load(); return; }
    refsWork = id;
    refs = [];
    selected.clear();
    ui.refId = id ? (ui.lastRef[id] || null) : null;
    closeList();
    renderList();
    renderDoc();
    load();
  }

  function selectRef(id) {
    ui.refId = id;
    saveUI();
    closeList();
    renderList();
    renderDoc();
  }

  /* ---------- 読み込み ---------- */

  // items: [{ file, path }]
  async function importItems(items, { filter = false } = {}) {
    const wid = refsWork;
    if (!wid) { alert('先に作品を開いてください。'); return; }
    const targets = filter ? items.filter((it) => isDoc(it.file.name)) : items;
    const skipped = items.length - targets.length;
    if (!targets.length) {
      alert(items.length ? 'MDファイル（.md）が見つかりませんでした。' : '読み込むファイルがありません。');
      return;
    }
    const loaded = [];
    const failed = [];
    for (const { file, path } of targets) {
      try {
        loaded.push({ name: file.name, path: path || file.name, text: decodeText(await file.arrayBuffer()) });
      } catch (e) {
        console.error(e);
        failed.push(file.name);
      }
    }
    if (!loaded.length) { alert(`読み込めませんでした：\n${failed.join('\n')}`); return; }
    let res;
    try {
      res = await DB.upsertRefs(wid, loaded);
    } catch (e) {
      console.error(e);
      alert('資料を保存できませんでした（保存容量不足などの可能性があります）。');
      return;
    }
    DB.notify({ t: 'refs', workId: wid });
    if (refsWork !== wid) return;
    ui.refId = res.last.id;
    saveUI();
    closeList();
    await load();
    renderDoc();
    let msg = `資料を${res.added + res.updated}件読み込みました`;
    if (res.updated) msg += `（うち${res.updated}件は上書き更新）`;
    setStatus(msg);
    const notes = [];
    if (skipped) notes.push(`MDファイル以外の${skipped}件は読み込みませんでした。`);
    if (failed.length) notes.push(`読み込めなかったファイル：\n${failed.join('\n')}`);
    if (notes.length) alert(notes.join('\n\n'));
  }

  // ドロップされたファイル・フォルダを（フォルダの中身も含めて）集める
  function readEntries(reader) {
    return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  }
  async function walk(entry, out) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, path: entry.fullPath.replace(/^\//, '') });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await readEntries(reader);
        for (const e of batch) await walk(e, out);
      } while (batch.length);
    }
  }
  async function collectDropped(dt) {
    // DataTransfer はイベント中しか読めないので、先に同期で取り出しておく
    const entries = dt.items ? [...dt.items].map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean) : [];
    const files = [...dt.files];
    if (!entries.length) return files.map((file) => ({ file, path: file.name }));
    const out = [];
    for (const en of entries) await walk(en, out);
    return out;
  }

  /* ---------- 削除 ---------- */

  async function removeRefs(ids, message, all) {
    if (!ids.length || !confirm(message)) return;
    const wid = refsWork;
    try {
      if (all) await DB.deleteAllRefs(wid); else await DB.deleteRefs(ids);
    } catch (e) {
      console.error(e);
      alert('削除できませんでした。');
      return;
    }
    DB.notify({ t: 'refs', workId: wid });
    for (const id of ids) selected.delete(id);
    if (ids.includes(ui.refId)) ui.refId = null;
    await load();
    renderDoc();
    setStatus(`資料を${ids.length}件削除しました`);
  }

  function nameList(list) {
    const shown = list.slice(0, 10).map((r) => '・' + r.name).join('\n');
    return list.length > 10 ? `${shown}\n…ほか${list.length - 10}件` : shown;
  }

  function onAction(act) {
    switch (act) {
      case 'pick-files': R.file.click(); break;
      case 'pick-folder': R.folder.click(); break;
      case 'delete-selected': {
        const list = refs.filter((r) => selected.has(r.id));
        removeRefs(list.map((r) => r.id), `選択した${list.length}件の資料を削除しますか？\n\n${nameList(list)}\n\n（元のファイルは消えません）`);
        break;
      }
      case 'delete-all': {
        const w = curWork();
        removeRefs(refs.map((r) => r.id), `作品「${w ? w.title : ''}」の資料${refs.length}件をすべて削除しますか？\n\n${nameList(refs)}\n\n（元のファイルは消えません）`, true);
        break;
      }
      default: break;
    }
  }

  /* ---------- 操作 ---------- */

  R.listBtn.addEventListener('click', () => {
    R.list.hidden = !R.list.hidden;
    R.listBtn.setAttribute('aria-expanded', String(!R.list.hidden));
  });
  R.list.addEventListener('click', (e) => {
    const act = e.target.closest('button[data-act]');
    if (act) { onAction(act.dataset.act); return; }
    const item = e.target.closest('[data-id]');
    if (item) selectRef(item.dataset.id);
  });
  R.list.addEventListener('change', (e) => {
    const c = e.target;
    if (c.dataset.check) {
      if (c.checked) selected.add(c.dataset.check); else selected.delete(c.dataset.check);
    } else if (c.dataset.act === 'check-all') {
      if (c.checked) refs.forEach((r) => selected.add(r.id)); else selected.clear();
    } else {
      return;
    }
    renderList();
  });
  R.body.addEventListener('click', (e) => {
    const act = e.target.closest('button[data-act]');
    if (act) onAction(act.dataset.act);
  });
  $('#refAdd').addEventListener('click', () => R.file.click());

  R.file.addEventListener('change', () => {
    const items = [...R.file.files].map((file) => ({ file, path: file.name }));
    R.file.value = '';
    if (items.length) importItems(items);
  });
  R.folder.addEventListener('change', () => {
    const items = [...R.folder.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
    R.folder.value = '';
    if (items.length) importItems(items, { filter: true });
  });

  // ファイルやフォルダを資料パネルにドラッグ＆ドロップして読み込む
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  R.panel.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    R.panel.classList.add('dropping');
  });
  R.panel.addEventListener('dragleave', (e) => { if (!R.panel.contains(e.relatedTarget)) R.panel.classList.remove('dropping'); });
  R.panel.addEventListener('drop', async (e) => {
    R.panel.classList.remove('dropping');
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    let items;
    try {
      items = await collectDropped(e.dataTransfer);
    } catch (err) {
      console.error(err);
      alert('ドロップされたファイルを読み込めませんでした。');
      return;
    }
    importItems(items, { filter: true });
  });
  // パネルの外にドロップしてもページが開き直されないようにする
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });

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

  return {
    setWork,
    reload: load,
    count: () => refs.length,
  };
})();
