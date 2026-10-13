/* DM32 ModJaFont Web writer — core (protocol + patch). Ver 0.1  JA2IZU
   通信手順は dm32_fonttool.py 0.2.7(実機で書込・照合確認済み)を JS に移したもの。 */
(function (root) {
'use strict';

const BLOCK = 0x1000;
const REGIONS = {
  Radio_Y16: { start: 0x0C9000, size: 524288 },
  HZK24S:    { start: 0x180000, size: 498528 },
  HZK24T:    { start: 0x265000, size: 101520 },
};
// 書き込み上限(許可サイズ = これ、または 4KiB 切り上げ)。HZK24T は 0x278000 以降の連絡先 DB を避ける。
const WRITE_LIMIT = { Radio_Y16: 524288, HZK24S: 498528, HZK24T: 77824 };
const ORDER = ['Radio_Y16', 'HZK24S', 'HZK24T'];
const W_READ = 0.39, W_WRITE = 0.55;   // 1ブロックあたりの目安秒(CH340 の実測)
const CD_TYPE = 0x02;
// 適用済み判定の目安: Radio_Y16 の「あ」(区85 点40)のスロット
const PROBE_OFFSET = (846 + (85 - 16) * 94 + 39) * 32;
const PROBE_HEX = '000084c444fc272424f4246444c00000001e2320201f10080641406020390f00';

const roundup = (n, u = BLOCK) => Math.floor((n + u - 1) / u) * u;
// タイマー: 裏タブ/画面消灯でブラウザが setTimeout を間引いても遅れにくいよう、可能なら Web Worker のタイマーを使う
const Timer = (() => {
  let worker = null, tried = false, seq = 0;
  const cbs = new Map();
  function init() {
    if (tried) return worker;
    tried = true;
    try {
      if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return null;
      const code = 'onmessage=function(e){var d=e.data;setTimeout(function(){postMessage(d.id)},d.ms)}';
      worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      worker.onmessage = (e) => { const f = cbs.get(e.data); if (f) { cbs.delete(e.data); f(); } };
      worker.onerror = () => { worker = null; };
    } catch (e) { worker = null; }
    return worker;
  }
  return {
    // cb を ms 後に呼ぶ。戻り値は取り消し関数
    set(ms, cb) {
      const w = init();
      if (w) {
        const id = ++seq; cbs.set(id, cb);
        w.postMessage({ id, ms });
        return () => { cbs.delete(id); };
      }
      const t = setTimeout(cb, ms);
      return () => clearTimeout(t);
    },
    get usingWorker() { return !!init(); },
  };
})();
const sleep = (ms) => new Promise((r) => { Timer.set(ms, r); });
const h2 = (n) => (n & 0xFF).toString(16).padStart(2, '0');
const toHex = (u8, max = 64) => {
  let s = '';
  const m = Math.min(u8.length, max);
  for (let i = 0; i < m; i++) s += (i ? ' ' : '') + h2(u8[i]);
  return s + (u8.length > max ? ' ...' : '');
};
const hex6 = (n) => '0x' + n.toString(16).toUpperCase().padStart(6, '0');
const le = (b, o, n) => { let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 256 + b[o + i]; return v; };
const eq = (a, b) => a.length === b.length && firstDiff(a, b) === null;
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? null : n;
}
function isUniform(b) {
  for (let i = 1; i < b.length; i++) if (b[i] !== b[0]) return false;
  return true;
}
function concat(...arr) {
  let n = 0; for (const a of arr) n += a.length;
  const o = new Uint8Array(n); let p = 0;
  for (const a of arr) { o.set(a, p); p += a.length; }
  return o;
}
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

class ProtocolError extends Error { constructor(m) { super(m); this.name = 'ProtocolError'; } }
class AbortedError extends Error { constructor(m) { super(m); this.name = 'AbortedError'; } }

// ---------------------------------------------------------------- SHA-256(純JS。Web Crypto に依存しない)
const K256 = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
function sha256Bytes(data) {
  const l = data.length;
  const padLen = ((l + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(data); buf[l] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 8, Math.floor(l / 0x20000000));
  dv.setUint32(padLen - 4, (l << 3) >>> 0);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2_ = 0x3c6ef372, h3 = 0xa54ff53a,
      h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let o = 0; o < padLen; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2_, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2_ = (h2_ + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32), ov = new DataView(out.buffer);
  [h0, h1, h2_, h3, h4, h5, h6, h7].forEach((v, i) => ov.setUint32(i * 4, v >>> 0));
  return out;
}
const sha = (u8) => Array.from(sha256Bytes(u8), h2).join('');

// ---------------------------------------------------------------- Link(送受信と記録)
class Link {
  constructor(transport, opt = {}) {
    this.t = transport;
    this.chunks = []; this.len = 0;
    this.lastRx = 0; this.aborted = false; this.readError = null; this._wake = null;
    this.gap = opt.gap !== undefined ? opt.gap : 12;          // 受信完了から次の送信までの最小間隔(ms)
    this.delay = opt.delay !== undefined ? opt.delay : 10;    // 送信後の待ち(ms)
    this.tscale = opt.timeoutScale !== undefined ? opt.timeoutScale : 1;
    this.onLog = opt.onLog || null;
  }
  _log(tag, data) {
    if (this.onLog) this.onLog(tag, data);
  }
  feed(u8) {
    if (u8 && u8.length) { this.chunks.push(u8); this.len += u8.length; this._notify(); }
  }
  clear() { this.chunks = []; this.len = 0; }
  _notify() { const w = this._wake; if (w) { this._wake = null; w(); } }
  abort() { this.aborted = true; this._notify(); }
  setReadError(e) { this.readError = e; this._notify(); }
  _chk() {
    if (this.aborted) throw new AbortedError('中断しました');
    if (this.readError) throw new ProtocolError('シリアルポートの受信エラー: ' + (this.readError.message || this.readError));
  }
  _take(k) {
    const out = new Uint8Array(k); let o = 0;
    while (o < k) {
      const c = this.chunks[0], need = k - o;
      if (c.length <= need) { out.set(c, o); o += c.length; this.chunks.shift(); }
      else { out.set(c.subarray(0, need), o); this.chunks[0] = c.subarray(need); o += need; }
    }
    this.len -= k;
    return out;
  }
  _wait(ms) {
    return new Promise((res) => {
      const cancel = Timer.set(ms, () => { this._wake = null; res(); });
      this._wake = () => { cancel(); res(); };
    });
  }
  async tx(data, delay) {
    this._chk();
    if (delay === undefined) delay = this.delay;
    const wait = this.gap - (Date.now() - this.lastRx);
    if (wait > 0) await sleep(wait);
    this._chk();
    this._log('TX', data);
    try { await this.t.write(data); }
    catch (e) { throw new ProtocolError('送信エラー: ' + (e && e.message ? e.message : e)); }
    if (delay > 0) await sleep(delay);
  }
  // 最大 n バイト。timeout(ms) 内に届いた分を返す(不足でも例外にしない)
  async rx(n, timeoutMs = 500) {
    const end = Date.now() + timeoutMs * this.tscale;
    while (this.len < n) {
      this._chk();
      const left = end - Date.now();
      if (left <= 0) break;
      await this._wait(left);
    }
    this._chk();
    const out = this._take(Math.min(n, this.len));
    this.lastRx = Date.now();
    this._log('RX', out);
    return out;
  }
}

// ---------------------------------------------------------------- Web Serial 接続
async function openSerial(port, link) {
  await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 1 << 20 });
  let sigErr = null;
  try { await port.setSignals({ dataTerminalReady: true, requestToSend: true }); }
  catch (e) { sigErr = e; }
  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();
  const pump = (async () => {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        if (r.value) link.feed(r.value);
      }
    } catch (e) { link.setReadError(e); }
  })();
  link.t = { write: (d) => writer.write(d) };
  await sleep(100);
  link.clear();                       // pyserial の reset_input_buffer 相当
  return {
    sigErr,
    async close() {
      try { await reader.cancel(); } catch (e) { /* ignore */ }
      try { reader.releaseLock(); } catch (e) { /* ignore */ }
      try { writer.releaseLock(); } catch (e) { /* ignore */ }
      try { await port.close(); } catch (e) { /* ignore */ }
      try { await pump; } catch (e) { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------- 通信手順
async function expectAck(link, what, timeout = 1000) {
  const r = await link.rx(1, timeout);
  if (r.length !== 1 || r[0] !== 0x06) {
    throw new ProtocolError(what + ': ACK(06) が来ません (受信=' + (toHex(r) || 'なし') + ')');
  }
}

async function vQuery(link, ctx, frame) {
  await link.tx(frame);
  const h = await link.rx(3);
  if (h.length !== 3 || h[0] !== 0x56) {
    throw new ProtocolError('V 問い合わせ ' + toHex(frame) + ': 想定外の応答 ' + (toHex(h) || 'なし'));
  }
  const n = h[2];
  const body = n ? await link.rx(n) : new Uint8Array(0);
  if (body.length !== n) {
    throw new ProtocolError('V 問い合わせ ' + toHex(frame) + ': 本体長 ' + body.length + ' (期待 ' + n + ')');
  }
  ctx.log('  V ' + toHex(frame) + ' -> ' + toHex(h) + ' | ' + toHex(body));
  return body;
}

async function gQuery(link, ctx) {
  await link.tx(Uint8Array.of(0x47, 0, 0, 0, 0, 0x01));
  const g = await link.rx(0x106);
  if (g.length !== 0x106 || g[0] !== 0x53) {
    throw new ProtocolError('G: 想定外の応答 (' + g.length + ' バイト, 先頭 ' + (g.length ? h2(g[0]) : 'なし') + ')');
  }
  ctx.log('  G -> ' + g.length + ' バイト (先頭 53)');
}

async function cpsPrelude(link, ctx, opt) {
  let range = null;
  await vQuery(link, ctx, Uint8Array.of(0x56, 0, 0, 0x40, 0x0D));
  for (const i of [6, 7, 8]) await vQuery(link, ctx, Uint8Array.of(0x56, 0, 0, 0, i));
  // opt.wantCdRange: 校正データの探索範囲(idx 0x0A)も問い合わせる(読み出し専用の V。CPS の順序からの追加=未確認)
  if (opt && opt.wantCdRange) range = await vQuery(link, ctx, Uint8Array.of(0x56, 0, 0, 0, 0x0A));
  await link.tx(Uint8Array.of(0xFF, 0xFF, 0xFF, 0xFF, 0x0C));   // 返事は読まない(CPS と同じ)
  return range;
}

async function handshake(link, ctx, opt) {
  await link.tx(ascii('PSEARCH'));
  let r = await link.rx(8);
  if (r.length !== 8 || r[0] !== 0x06) throw new ProtocolError('PSEARCH: 想定外の応答 ' + (toHex(r) || 'なし') + '(本体の電源を入れ直して、もう一度試してください)');
  await link.tx(ascii('PASSSTA'));
  r = await link.rx(3);
  if (r.length !== 3 || r[0] !== 0x50) throw new ProtocolError('PASSSTA: 想定外の応答 ' + (toHex(r) || 'なし'));
  ctx.log('PASSSTA 応答: ' + toHex(r) + '(意味は未確認。パスワードは送っていません)');
  await link.tx(ascii('SYSINFO'));
  await expectAck(link, 'SYSINFO');
  const range = await cpsPrelude(link, ctx, opt);
  await link.tx(ascii('PROGRAM'));
  await expectAck(link, 'PROGRAM');
  await link.tx(Uint8Array.of(0x02));
  r = await link.rx(8, 1000);     // 8 バイト。受けたらすぐ 06 を送る
  if (r.length !== 8) throw new ProtocolError('0x02 の応答が 8 バイトではありません (' + r.length + ' バイト: ' + toHex(r) + ')');
  ctx.log('機種情報応答(8 バイト): ' + toHex(r));
  await link.tx(Uint8Array.of(0x06));
  await expectAck(link, '握手の最終ACK');
  return range;
}

const addrBytes = (a) => Uint8Array.of(a & 0xFF, (a >>> 8) & 0xFF, (a >>> 16) & 0xFF);

async function readBlock(link, ctx, addr) {
  const frame = concat(Uint8Array.of(0x52), addrBytes(addr), Uint8Array.of(0x00, 0x10));
  await link.tx(frame);
  const r = await link.rx(BLOCK + 6, 2000);
  if (r.length !== BLOCK + 6) throw new ProtocolError(hex6(addr) + ': 受信長 ' + r.length + ' (期待 ' + (BLOCK + 6) + ')');
  if (r[0] !== 0x57) throw new ProtocolError(hex6(addr) + ': 先頭バイトが 0x57 ではありません (' + h2(r[0]) + ')');
  if (!eq(r.subarray(1, 6), frame.subarray(1, 6))) ctx.log('  注意: ' + hex6(addr) + ' の応答ヘッダがエコーと一致しません: ' + toHex(r.subarray(0, 6)));
  return r.slice(6);
}

async function readSpan(link, ctx, label, start, nbytes, hook) {
  const nblocks = Math.ceil(nbytes / BLOCK);
  const out = new Uint8Array(nblocks * BLOCK);
  const t0 = Date.now();
  for (let i = 0; i < nblocks; i++) {
    out.set(await readBlock(link, ctx, start + i * BLOCK), i * BLOCK);
    if (hook) hook(i + 1, nblocks);
  }
  ctx.log('  ' + label + ' 読み出し ' + nblocks + ' ブロック  ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
  return out.slice(0, nbytes);
}

async function writeBlock(link, addr, chunk) {
  const frame = concat(Uint8Array.of(0x57), addrBytes(addr), Uint8Array.of(chunk.length & 0xFF, (chunk.length >>> 8) & 0xFF), chunk);
  await link.tx(frame, 0);          // ヘッダ+データを 1 フレームで送る
  let r = await link.rx(1, 5000);
  if (r.length !== 1 || r[0] !== 0x06) {
    if (r.length) r = concat(r, await link.rx(3, 300));
    let note = '';
    if (r.length && r[0] === 0x90) note = ' ※ 90 fe 98 fe は本体の拒否/時間切れの定型応答(これまでの観察)。本体の電源を入れ直して最初からやり直してください';
    throw new ProtocolError(hex6(addr) + ' への書き込み: ACK(06) が来ません (受信=' + (toHex(r) || 'なし') + ')' + note);
  }
}

async function writeSpan(link, ctx, label, start, data, hook) {
  const nblocks = Math.ceil(data.length / BLOCK);
  const t0 = Date.now();
  for (let i = 0; i < nblocks; i++) {
    await writeBlock(link, start + i * BLOCK, data.subarray(i * BLOCK, (i + 1) * BLOCK));
    if (hook) hook(i + 1, nblocks);
  }
  ctx.log('  ' + label + ' 書き込み ' + nblocks + ' ブロック  ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
}

// ---------------------------------------------------------------- パッチ(DMFP)
function parsePatch(blob) {
  if (blob.length < 4 + 2 + 32 || String.fromCharCode(blob[0], blob[1], blob[2], blob[3]) !== 'DMFP') throw new Error('パッチ形式が違います');
  if (!eq(sha256Bytes(blob.subarray(0, blob.length - 32)), blob.subarray(blob.length - 32))) throw new Error('パッチの SHA-256 が一致しません(壊れています)');
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (blob[4] !== 1) throw new Error('未対応の版です: ' + blob[4]);
  const n = blob[5];
  let p = 6;
  const regions = {};
  for (let i = 0; i < n; i++) {
    const ln = blob[p]; p += 1;
    const name = String.fromCharCode.apply(null, blob.subarray(p, p + ln)); p += ln;
    const size = dv.getUint32(p, true), nruns = dv.getUint32(p + 4, true); p += 8;
    const runs = [];
    for (let j = 0; j < nruns; j++) {
      const off = dv.getUint32(p, true), ln2 = dv.getUint32(p + 4, true); p += 8;
      runs.push({ off, data: blob.subarray(p, p + ln2) }); p += ln2;
    }
    regions[name] = { size, runs };
  }
  if (p !== blob.length - 32) throw new Error('パッチの長さが合いません');
  return regions;
}

function applyPatch(regions, name, base) {
  const { size, runs } = regions[name];
  if (name === 'HZK24T' && base.length === REGIONS.HZK24T.size) base = base.subarray(0, size);
  if (base.length !== size && base.length !== roundup(size)) throw new Error(name + ' のベースのサイズが違います: ' + base.length);
  const out = new Uint8Array(base);
  for (const r of runs) {
    if (r.off + r.data.length > size) throw new Error('run が領域外です');
    out.set(r.data, r.off);
  }
  return out;
}

// ---------------------------------------------------------------- 流れ
function blocksOf(n) { return Math.ceil(n / BLOCK); }

// 現在の 3 領域を読み出す(書き込み前のバックアップ。サイズは書き込み許可サイズの 4KiB 切り上げ)
// Radio_Y16 の「あ」の字形が ModJaFont と同じなら、適用済みの本体とみなす(目安)
function isModded(y16) {
  return toHex(y16.subarray(PROBE_OFFSET, PROBE_OFFSET + 32), 32).replace(/ /g, '') === PROBE_HEX;
}

async function backupRegions(link, ctx, names, st, unitState) {
  for (const k of names) {
    const s = REGIONS[k].start, n = roundup(WRITE_LIMIT[k]);
    ctx.log(k + ' を読み出し中 (' + hex6(s) + ', ' + n + ' バイト)');
    const old = await readSpan(link, ctx, k, s, n, (i, nb) => unitState.step('backup', k, i, nb, W_READ));
    if (isUniform(old)) {
      throw new ProtocolError(k + ' の読み出し結果が全て 0x' + h2(old[0]) + ' です(読み出し異常の疑い)。書き込みを始めずに中止します');
    }
    st.backups[k] = old;
    if (k === 'Radio_Y16') st.modded = isModded(old);
    ctx.log('  ' + k + ' バックアップ取得  ' + old.length + ' バイト  SHA-256 ' + sha(old));
    if (ctx.onBackup) ctx.onBackup(k, old, { modded: !!st.modded });
  }
}

async function backupCd(link, ctx, range, st, u) {
  ctx.log('校正データのバックアップを読み出し中(読み出しのみ)');
  const r = await readCd(link, ctx, range, (n, t) => { if (ctx.progress) ctx.progress({ phase: 'scan', label: '校正データ種別走査', i: n, n: t, units: u.done, unitsTotal: u.total }); });
  st.cd = r.cd; st.cdSha = r.cdSha; st.cdSig = r.cdSig; st.cdAddr = r.cdAddr;
  if (ctx.onBackup) ctx.onBackup('CD', r.cd, r);
}

function makeUnits(total, ctx) {
  const u = { done: 0, total };
  u.step = (phase, label, i, n, w) => {
    u.done += w;
    if (ctx.progress) ctx.progress({ phase, label, i, n, units: u.done, unitsTotal: u.total });
  };
  return u;
}

async function writeFlow(link, patch, ctx, st) {
  const names = ORDER.filter((k) => patch[k]);
  if (names.length !== ORDER.length) throw new ProtocolError('パッチに 3 領域が揃っていません');
  st.wrote = false; st.verified = null; st.backups = {}; st.newData = {}; st.diffs = {};
  let total = 0;
  for (const k of names) total += blocksOf(roundup(WRITE_LIMIT[k])) * (W_READ + W_WRITE + W_READ);
  const u = makeUnits(total, ctx);
  const range = await handshake(link, ctx, { wantCdRange: true });
  // 1) バックアップ(校正データを含む。失敗したら書かない)
  await backupCd(link, ctx, range, st, u);
  await backupRegions(link, ctx, names, st, u);
  // 2) 書き込みデータを作る(本体の現在の内容にパッチを当てる。書く前に全部作って検査)
  for (const k of names) {
    const base = st.backups[k].subarray(0, patch[k].size);
    const d = applyPatch(patch, k, base);
    if (d.length !== WRITE_LIMIT[k]) throw new ProtocolError(k + ': 書き込みデータの長さが想定外です (' + d.length + ')');
    st.newData[k] = d;
  }
  if (st.modded) ctx.log('注意: 「あ」の字形が既に ModJaFont と同じです(適用済みの本体の可能性。そのまま上書きします)');
  for (const k of names) ctx.log('  書き込み予定 ' + k + ' ' + hex6(REGIONS[k].start) + '..' + hex6(REGIONS[k].start + roundup(st.newData[k].length) - 1) + '  ' + st.newData[k].length + ' バイト  SHA-256 ' + sha(st.newData[k]));
  // 3) 書き込み
  for (const k of names) {
    ctx.log(k + ' を書き込み中 (' + hex6(REGIONS[k].start) + ')');
    st.wrote = true;
    await writeSpan(link, ctx, k, REGIONS[k].start, st.newData[k], (i, nb) => u.step('write', k, i, nb, W_WRITE));
  }
  // 4) 読み戻し照合
  let allgood = true;
  try {
    for (const k of names) {
      const back = await readSpan(link, ctx, k, REGIONS[k].start, st.newData[k].length, (i, nb) => u.step('verify', k, i, nb, W_READ));
      const d = firstDiff(back, st.newData[k]);
      st.diffs[k] = d;
      if (d === null) ctx.log('  照合 ' + k + ': 一致 (' + back.length + ' バイト)');
      else { allgood = false; ctx.log('  照合 ' + k + ': 不一致  最初の不一致 offset=0x' + d.toString(16).toUpperCase()); }
    }
    st.verified = allgood;
  } catch (e) {
    if (e instanceof AbortedError) throw e;
    ctx.log('読み戻しできませんでした(' + e.message + ')。');
    st.verified = null;
  }
  return st;
}

// バックアップ(.bin)から戻す。items: [{name, data}]
async function restoreFlow(link, items, ctx, st) {
  st.wrote = false; st.verified = null; st.diffs = {};
  let total = 0;
  for (const it of items) total += blocksOf(it.data.length) * (W_WRITE + W_READ);
  const u = makeUnits(total, ctx);
  await handshake(link, ctx);
  for (const it of items) {
    ctx.log(it.name + ' を書き戻し中 (' + hex6(REGIONS[it.name].start) + ', ' + it.data.length + ' バイト)');
    st.wrote = true;
    await writeSpan(link, ctx, it.name, REGIONS[it.name].start, it.data, (i, nb) => u.step('write', it.name, i, nb, W_WRITE));
  }
  let allgood = true;
  try {
    for (const it of items) {
      const back = await readSpan(link, ctx, it.name, REGIONS[it.name].start, it.data.length, (i, nb) => u.step('verify', it.name, i, nb, W_READ));
      const d = firstDiff(back, it.data);
      st.diffs[it.name] = d;
      if (d === null) ctx.log('  照合 ' + it.name + ': 一致 (' + back.length + ' バイト)');
      else { allgood = false; ctx.log('  照合 ' + it.name + ': 不一致  最初の不一致 offset=0x' + d.toString(16).toUpperCase()); }
    }
    st.verified = allgood;
  } catch (e) {
    if (e instanceof AbortedError) throw e;
    ctx.log('読み戻しできませんでした(' + e.message + ')。');
    st.verified = null;
  }
  return st;
}

// 読み出しのみ(現在のフォントを保存)
async function backupOnlyFlow(link, ctx, st) {
  st.backups = {};
  let total = 0;
  for (const k of ORDER) total += blocksOf(roundup(WRITE_LIMIT[k])) * W_READ;
  const u = makeUnits(total, ctx);
  const range = await handshake(link, ctx, { wantCdRange: true });
  await backupCd(link, ctx, range, st, u);
  await backupRegions(link, ctx, ORDER, st, u);
  return st;
}

// info: CPS のコードプラグ読み出しと同じ順序で V を問い合わせる(読み出し専用)
const INFO_IDX = [];
for (let i = 1; i < 0x11; i++) if (i !== 0x0C) INFO_IDX.push(i);

async function infoSession(link, ctx) {
  await link.tx(ascii('PSEARCH'));
  let r = await link.rx(8);
  if (r.length !== 8 || r[0] !== 0x06) throw new ProtocolError('PSEARCH: 想定外の応答 ' + (toHex(r) || 'なし') + '(本体の電源を入れ直して、もう一度試してください)');
  await link.tx(ascii('PASSSTA'));
  r = await link.rx(3);
  if (r.length !== 3 || r[0] !== 0x50) throw new ProtocolError('PASSSTA: 想定外の応答 ' + (toHex(r) || 'なし'));
  await link.tx(ascii('SYSINFO'));
  await expectAck(link, 'SYSINFO');
  const res = {};
  res[0x100] = await vQuery(link, ctx, Uint8Array.of(0x56, 0, 0, 0x40, 0x0D));
  for (const i of INFO_IDX) res[i] = await vQuery(link, ctx, Uint8Array.of(0x56, 0, 0, 0, i));
  await gQuery(link, ctx);
  await link.tx(Uint8Array.of(0xFF, 0xFF, 0xFF, 0xFF, 0x0C));
  await link.tx(ascii('PROGRAM'));
  await expectAck(link, 'PROGRAM');
  await link.tx(Uint8Array.of(0x02));
  r = await link.rx(8, 1000);
  if (r.length !== 8) throw new ProtocolError('0x02 の応答が 8 バイトではありません (' + r.length + ' バイト: ' + toHex(r) + ')');
  await link.tx(Uint8Array.of(0x06));
  await expectAck(link, '握手の最終ACK');
  return res;
}

function describeInfo(res, ctx) {
  ctx.log('解釈(★静的解析による推測。実機の値で確認してください):');
  for (const [idx, label] of [[0x0A, 'コードプラグ探索範囲(開始/終了)'], [0x0F, '連絡先DB領域(開始/終了)']]) {
    const b = res[idx] || new Uint8Array(0);
    if (b.length >= 8) {
      const s = le(b, 0, 4), e = le(b, 4, 4);
      ctx.log('  idx 0x' + h2(idx) + ' ' + label + ': ' + hex6(s) + ' .. ' + hex6(e) + ' (' + (e >= s ? e - s + 1 : 0) + ' バイト)');
    } else ctx.log('  idx 0x' + h2(idx) + ' ' + label + ': 本体 ' + b.length + ' バイトのため解釈できません');
  }
  const b10 = res[0x10] || new Uint8Array(0);
  if (b10.length >= 3) ctx.log('  idx 0x10 連絡先の最大件数(LE24): ' + le(b10, 0, 3));
  for (const idx of [6, 7, 8]) {
    const b = res[idx] || new Uint8Array(0);
    if (b.length >= 8) ctx.log('  idx 0x0' + idx + ' (フォント/音声の領域表と推測): ' + hex6(le(b, 0, 4)) + ' .. ' + hex6(le(b, 4, 4)));
  }
}

async function scanTypes(link, ctx, start, end, hook) {
  const out = [];
  let addr = start + 0xFFF;
  const total = end >= addr ? Math.floor((end - addr) / BLOCK) + 1 : 0;
  let n = 0;
  while (addr <= end) {
    await link.tx(concat(Uint8Array.of(0x52), addrBytes(addr), Uint8Array.of(0x01, 0x00)));
    const r = await link.rx(7, 1000);
    if (r.length !== 7 || r[0] !== 0x57) throw new ProtocolError(hex6(addr) + ' の種別読み出し: 想定外の応答 ' + (toHex(r) || 'なし'));
    out.push([addr - 0xFFF, r[6]]);
    n++;
    if (hook && (n % 8 === 0 || n === total)) hook(n, total);
    addr += BLOCK;
  }
  return out;
}

async function readCd(link, ctx, rangeBody, hook) {
  const b = rangeBody || new Uint8Array(0);
  if (b.length < 8) throw new ProtocolError('V idx 0x0A の応答が 8 バイト未満です(' + b.length + ' バイト)');
  const start = le(b, 0, 4), end = le(b, 4, 4);
  ctx.log('コードプラグ探索範囲: ' + hex6(start) + ' .. ' + hex6(end));
  const types = await scanTypes(link, ctx, start, end, hook);
  const cands = types.filter((x) => x[1] === CD_TYPE).map((x) => x[0]);
  ctx.log('  走査 ' + types.length + ' ブロック。種別 0x02: ' + cands.length + ' 個');
  if (cands.length !== 1) {
    throw new ProtocolError('校正データ(種別 0x02)のブロックが ' + cands.length + ' 個です(1 個のときだけ進みます): ' + (cands.map(hex6).join(', ') || 'なし'));
  }
  const addr = cands[0];
  ctx.log('  校正データのブロック候補: ' + hex6(addr));
  const d1 = await readBlock(link, ctx, addr);
  const d2 = await readBlock(link, ctx, addr);
  if (!eq(d1, d2)) throw new ProtocolError('校正ブロックを 2 回読んだ結果が一致しません(通信エラーの疑い)。保存しません');
  if (d1[0xFFF] !== CD_TYPE) throw new ProtocolError('読み出したブロック末尾が 0x' + h2(d1[0xFFF]) + ' です(種別走査の結果と矛盾)。保存しません');
  const sigOk = d1[0] === 0x00 && d1[1] === 0x40 && d1[2] === 0x00 && d1[3] === 0x47;
  ctx.log('  先頭シグネチャ 00 40 00 47: ' + (sigOk ? '一致' : '★不一致(別ファーム/別個体の可能性。内容は保存します)'));
  const h = sha(d1);
  ctx.log('  校正ブロック 4096 バイト  SHA-256 ' + h + '  (ブロックの物理アドレス ' + hex6(addr) + ')');
  return { cd: d1, cdAddr: addr, cdSig: sigOk, cdSha: h };
}

async function calreadFlow(link, ctx, st) {
  const res = await infoSession(link, ctx);
  const r = await readCd(link, ctx, res[0x0A], (n, t) => ctx.progress && ctx.progress({ phase: 'scan', label: '種別走査', i: n, n: t, units: n, unitsTotal: t }));
  Object.assign(st, r);
  return st;
}

// 復元用ファイルの判別(サイズで領域を決める)
function identifyBackup(name, data) {
  let region = null;
  for (const k of ORDER) {
    const lim = WRITE_LIMIT[k];
    if (data.length === lim || data.length === roundup(lim)) region = k;
  }
  let note = '';
  if (!region && data.length === REGIONS.HZK24T.size) { region = 'HZK24T'; note = '読み出しファイル(101,520 バイト)の先頭 77,824 バイトだけを使います(後ろは連絡先データのため書きません)'; data = data.subarray(0, WRITE_LIMIT.HZK24T); }
  if (!region) return { error: 'サイズ ' + data.length + ' バイトは、どの領域にも当てはまりません(許可: Radio_Y16 524288 / HZK24S 498528 または 499712 / HZK24T 77824 または 101520)' };
  const tokens = ['Radio_Y16', 'HZK24S', 'HZK24T'].filter((t) => name.indexOf(t) >= 0);
  if (tokens.length && tokens.indexOf(region) < 0) return { error: 'ファイル名は ' + tokens.join('/') + ' ですが、サイズは ' + region + ' のものです。取り違えの疑いがあるため拒否します' };
  if (isUniform(data)) return { error: '全て同じ値(0x' + h2(data[0]) + ')のデータです。書き戻しません' };
  return { region, data, note };
}

root.DM32 = {
  BLOCK, REGIONS, WRITE_LIMIT, ORDER, PROBE_OFFSET, PROBE_HEX, CD_TYPE,
  ProtocolError, AbortedError, Timer, Link, openSerial, sha, sha256Bytes, toHex, hex6, roundup, firstDiff, isUniform, eq,
  handshake, readBlock, readSpan, writeBlock, writeSpan, parsePatch, applyPatch,
  writeFlow, restoreFlow, backupOnlyFlow, readCd, infoSession, describeInfo, calreadFlow, identifyBackup,
};
if (typeof module !== 'undefined' && module.exports) module.exports = root.DM32;
})(typeof globalThis !== 'undefined' ? globalThis : this);
