'use strict';

/* =========================================================
   ZIP の作成・読み込み（外部ライブラリなし）
   作成：無圧縮・ファイル名は UTF-8
   読み込み：無圧縮と deflate（Windows や Mac で圧縮し直したもの）に対応
   ========================================================= */

const Zip = (() => {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  // entries: [{ path, text }]。path が / で終わるものはフォルダとして作る
  function create(entries) {
    const enc = new TextEncoder();
    const { time, date } = dosDateTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
      const name = enc.encode(entry.path);
      const data = entry.path.endsWith('/') ? new Uint8Array(0) : enc.encode(entry.text || '');
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // ファイル名は UTF-8
      local.setUint16(8, 0, true); // 無圧縮
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(local, name, data);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, time, true);
      cen.setUint16(14, date, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(38, entry.path.endsWith('/') ? 0x10 : 0, true);
      cen.setUint32(42, offset, true);
      central.push(cen, name);

      offset += 30 + name.length + data.length;
    }
    const cenSize = central.reduce((a, p) => a + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  function decodeName(bytes, utf8) {
    if (utf8) return new TextDecoder('utf-8').decode(bytes);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      // 日本語版 Windows で作った ZIP のファイル名は Shift_JIS
      return new TextDecoder('shift_jis').decode(bytes);
    }
  }

  async function inflate(raw) {
    if (typeof DecompressionStream === 'undefined') throw new Error('このブラウザでは圧縮された ZIP を読み込めません。');
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // → [{ path, dir, data }]
  async function read(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let e = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    }
    if (e < 0) throw new Error('ZIP ファイルとして読み込めませんでした。');
    const count = dv.getUint16(e + 10, true);
    let p = dv.getUint32(e + 16, true);
    const out = [];
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP ファイルが壊れています。');
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true);
      const xlen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const path = decodeName(buf.subarray(p + 46, p + 46 + nlen), flags & 0x0800).replace(/\\/g, '/');
      p += 46 + nlen + xlen + clen;
      if (path.endsWith('/')) { out.push({ path, dir: true, data: null }); continue; }
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const raw = buf.subarray(start, start + csize);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = await inflate(raw);
      else throw new Error(`「${path}」は対応していない圧縮形式です。`);
      out.push({ path, dir: false, data });
    }
    return out;
  }

  return { create, read };
})();
