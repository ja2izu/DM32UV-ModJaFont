(function () {
'use strict';
const D = window.DM32;
const $ = (id) => document.getElementById(id);
const TEST = window.__DM32_TEST__ || {};
const VERSION = 'Ver 0.1.1  JA2IZU';

const S = { running: false, link: null, patch: null, restore: [], wl: null };
const logLines = [];

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function stamp() { const d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()); }
function clock() { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3); }
// 画面のログには通信(TX/RX)を出さない。保存するログには全て入る
function log(s) {
  const line = clock() + ' ' + s;
  logLines.push(line);
  const pre = $('log');
  pre.appendChild(document.createTextNode(line + '\n'));
  pre.scrollTop = pre.scrollHeight;
}
function onRaw(tag, data) { logLines.push(clock() + ' ' + tag + ' ' + data.length + '  ' + D.toHex(data)); }
function download(name, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function setResult(kind, html) { $('result').innerHTML = html ? '<div class="note ' + kind + '">' + html + '</div>' : ''; }

// ---------------------------------------------------------------- 進捗
let t0 = 0, timer = null, lastUnits = 0, lastTotal = 0;
const fmt = (sec) => { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + '分' + pad(sec % 60) + '秒'; };
function tick() {
  const el = (Date.now() - t0) / 1000;
  $('elapsed').textContent = '経過 ' + fmt(el);
  if (lastTotal > 0 && lastUnits / lastTotal > 0.03) $('eta').textContent = '残り約 ' + fmt(el * (lastTotal - lastUnits) / lastUnits);
}
function progress(p) {
  const names = { backup: 'バックアップ', write: '書き込み', verify: '確認', scan: '校正データ' };
  $('phase').textContent = (names[p.phase] || p.phase) + ' ' + p.label + '  ' + p.i + '/' + p.n;
  lastUnits = p.units; lastTotal = p.unitsTotal;
  $('barFill').style.width = Math.min(100, p.units / p.unitsTotal * 100).toFixed(1) + '%';
}
// 適用済み(ModJaFont)の本体から読んだフォントは、オリジナルではないので、ファイル名に Modded を付ける
function onBackup(k, data, info) {
  const ts = stamp();
  const nm = k === 'CD' ? 'DM32_calibration_' + D.sha(data).slice(0, 8) + '_' + ts + '.bin'
    : 'backup_' + (info && info.modded ? 'Modded_' : '') + k + '_' + ts + '.bin';
  try { download(nm, data); log('バックアップを保存: ' + nm); } catch (e) { log('バックアップの保存に失敗: ' + e.message); }
}

// ---------------------------------------------------------------- 接続セッション
function setRunning(v) {
  S.running = v;
  $('btnAbort').classList.toggle('hidden', !v);
  if (v) { t0 = Date.now(); timer = setInterval(tick, 500); window.onbeforeunload = (e) => { e.preventDefault(); e.returnValue = ''; }; }
  else { clearInterval(timer); timer = null; window.onbeforeunload = null; tick(); }
  updateButtons();
}

async function session(job) {
  if (S.running) return;
  if (!('serial' in navigator)) { setResult('bad', 'このブラウザは対応していません。PC版の Chrome / Edge で開いてください。'); return; }
  let port;
  try { port = await navigator.serial.requestPort(); }
  catch (e) { return; }
  $('barFill').style.width = '0'; $('phase').textContent = '接続中'; $('eta').textContent = ''; $('elapsed').textContent = '';
  lastUnits = 0; lastTotal = 0; setResult('', '');
  setRunning(true);
  try { if (navigator.wakeLock) S.wl = await navigator.wakeLock.request('screen'); } catch (e) { log('画面消灯の抑止なし(' + (e && e.name) + ')'); }
  const link = new D.Link(null, { gap: TEST.gap, delay: TEST.delay, timeoutScale: TEST.timeoutScale, onLog: onRaw });
  S.link = link;
  let conn = null;
  try {
    conn = await D.openSerial(port, link);
    log('ポートを開きました');
    await job(link, { log, progress, onBackup });
  } catch (e) {
    log('中断: ' + (e && e.message ? e.message : e));
  } finally {
    if (conn) await conn.close();
    log('ポートを閉じました');
    try { if (S.wl) await S.wl.release(); } catch (e) { /* ignore */ }
    S.wl = null; S.link = null;
    $('phase').textContent = '終了';
    $('cOk').checked = false;
    setRunning(false);
  }
}

// ---------------------------------------------------------------- 操作
async function writeJob(link, ctx) {
  const st = {};
  try {
    await D.writeFlow(link, S.patch, ctx, st);
    if (st.verified === true) setResult('good', '<b>完了しました。</b>本体の電源を入れ直してください。');
    else if (st.verified === false) setResult('bad', '<b>書き込み後の確認で差が出ました。</b>本体の電源を入れ直して、やり直してください。');
    else setResult('warn', '<b>書き込みは完了しましたが、確認ができませんでした。</b>本体の電源を入れ直して、表示を確認してください。');
  } catch (e) {
    if (st.wrote) { $('secTools').open = true; setResult('bad', '<b>途中で止まりました。</b>' + esc(e.message) + '<br>本体の電源を入れ直して、やり直してください。'); }
    else setResult('warn', '<b>書き込み前に止まりました(本体は変更されていません)。</b>' + esc(e.message));
    throw e;
  }
}

function restoreJob(items) {
  return async (link, ctx) => {
    const st = {};
    try {
      await D.restoreFlow(link, items, ctx, st);
      if (st.verified === true) setResult('good', '<b>書き戻しが完了しました。</b>本体の電源を入れ直してください。');
      else if (st.verified === false) setResult('bad', '<b>書き戻し後の確認で差が出ました。</b>本体の電源を入れ直して、やり直してください。');
      else setResult('warn', '<b>書き戻しは完了しましたが、確認ができませんでした。</b>');
    } catch (e) {
      setResult('bad', '<b>' + (st.wrote ? '途中で止まりました。' : '書き込み前に止まりました。') + '</b>' + esc(e.message) + '<br>本体の電源を入れ直して、やり直してください。');
      throw e;
    }
  };
}

function updateButtons() {
  const idle = !S.running && !!S.patch && 'serial' in navigator;
  const ok = $('cOk').checked;
  $('btnWrite').disabled = !(idle && ok);
  $('btnRestore').disabled = !(idle && ok && S.restore.length > 0 && S.restore.every((x) => !x.error));
  $('restoreFiles').disabled = S.running;
}

async function loadRestoreFiles() {
  const out = [];
  for (const f of Array.from($('restoreFiles').files)) {
    const id = D.identifyBackup(f.name, new Uint8Array(await f.arrayBuffer()));
    out.push(id.error ? { name: f.name, error: id.error } : { name: f.name, region: id.region, data: id.data });
  }
  const seen = {};
  for (const x of out) { if (x.region) { if (seen[x.region]) x.error = x.region + ' が重複しています'; seen[x.region] = true; } }
  S.restore = out;
  $('restorePlan').innerHTML = out.map((x) => esc(x.name) + ' → ' + (x.error ? '<span style="color:var(--ng)">× ' + esc(x.error) + '</span>' : '<b>' + x.region + '</b>')).join('<br>');
  updateButtons();
}

// ---------------------------------------------------------------- 起動
function init() {
  $('ver').textContent = VERSION;
  if (!('serial' in navigator)) {
    const n = $('envNote'); n.classList.remove('hidden');
    n.textContent = 'このブラウザは対応していません。PC版の Chrome / Edge で開いてください。';
  }
  try {
    const bin = atob($('patchB64').textContent.trim());
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const h = D.sha(u8);
    if (h !== PATCH_SHA256) throw new Error('パッチの SHA-256 が想定と違います');
    S.patch = D.parsePatch(u8);
    log(VERSION + '  パッチ OK  SHA-256 ' + h);
  } catch (e) {
    setResult('bad', '<b>このファイルが壊れています。</b>入手し直してください。(' + esc(e.message) + ')');
  }
  log('ブラウザ: ' + navigator.userAgent);
  $('cOk').addEventListener('change', updateButtons);
  $('btnWrite').onclick = () => session(writeJob);
  $('btnRestore').onclick = () => session(restoreJob(S.restore.map((x) => ({ name: x.region, data: x.data }))));
  $('restoreFiles').addEventListener('change', loadRestoreFiles);
  $('btnAbort').onclick = () => { if (S.link) { S.link.abort(); log('中断を要求しました'); } };
  $('btnSaveLog').onclick = () => download('dm32_modjafont_' + stamp() + '.log.txt', new TextEncoder().encode(['DM32 ModJaFont Web writer ' + VERSION].concat(logLines).join('\n') + '\n'), 'text/plain');
  document.addEventListener('visibilitychange', async () => {
    if (S.running && document.visibilityState === 'visible' && navigator.wakeLock && (!S.wl || S.wl.released)) {
      try { S.wl = await navigator.wakeLock.request('screen'); } catch (e) { /* ignore */ }
    }
  });
  updateButtons();
  window.__dm32 = { S, D };
}
init();
})();
