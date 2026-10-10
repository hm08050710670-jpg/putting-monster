// カメラ設定画面: 映像ソース・解像度・時刻の取得方法・検出しきい値・音声、およびカメラ診断。

import { DEFAULT_SETTINGS, clearAll } from './storage.js';
import { listCameras, runDiagnostics } from './sources.js';
import { setVoiceEnabled, speak, unlock, voiceSupported } from './voice.js';

let app = null;
const el = (id) => document.getElementById(id);

function syncForm() {
  const s = app.settings;
  el('setSource').value = s.source;
  el('setPreset').value = s.preset;
  el('setTime').value = s.timeSource;
  el('setVoice').checked = !!s.voice;
  el('setBright').value = s.detect.brightMin;
  el('setDiff').value = s.detect.diffMin;
  el('setSat').value = s.detect.satMax;
  el('setBrightOut').textContent = s.detect.brightMin;
  el('setDiffOut').textContent = s.detect.diffMin;
  el('setSatOut').textContent = s.detect.satMax;
  const cam = s.source === 'camera';
  el('setDevice').disabled = !cam;
  el('setPreset').disabled = !cam;
  el('setTime').disabled = !cam;
}

async function fillDevices() {
  const sel = el('setDevice');
  const cams = await listCameras().catch(() => []);
  sel.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = '自動（背面カメラ）';
  sel.append(auto);
  for (const c of cams) {
    if (!c.deviceId) continue; // 許可前は ID が空で返る
    const o = document.createElement('option');
    o.value = c.deviceId;
    o.textContent = c.label;
    sel.append(o);
  }
  sel.value = [...sel.options].some((o) => o.value === app.settings.deviceId) ? app.settings.deviceId : '';
}

export async function enter(a) {
  app = a;
  syncForm();
  el('diagOut').hidden = true;
  await fillDevices();
}

export function leave() {}

function change(fn, restart) {
  fn(app.settings);
  app.saveSettings();
  if (restart) app.invalidateSource();
  syncForm();
}

el('setSource').addEventListener('change', (e) => change((s) => { s.source = e.target.value; }, true));
el('setDevice').addEventListener('change', (e) => change((s) => { s.deviceId = e.target.value; }, true));
el('setPreset').addEventListener('change', (e) => change((s) => { s.preset = e.target.value; }, true));
el('setTime').addEventListener('change', (e) => change((s) => { s.timeSource = e.target.value; }, true));
el('setVoice').addEventListener('change', (e) => change((s) => { s.voice = e.target.checked; setVoiceEnabled(s.voice); }));
el('setBright').addEventListener('input', (e) => change((s) => { s.detect.brightMin = Number(e.target.value); }));
el('setDiff').addEventListener('input', (e) => change((s) => { s.detect.diffMin = Number(e.target.value); }));
el('setSat').addEventListener('input', (e) => change((s) => { s.detect.satMax = Number(e.target.value); }));
el('setDetectReset').addEventListener('click', () => { change((s) => { s.detect = { ...DEFAULT_SETTINGS.detect }; }); app.toast('検出の設定を初期値に戻しました'); });

el('voiceTestBtn').addEventListener('click', () => {
  if (!voiceSupported()) { app.toast('このブラウザは読み上げに対応していません'); return; }
  if (!app.settings.voice) { app.toast('「計測結果を読み上げる」がオフになっています'); return; }
  unlock();
  speak('準備完了。秒速2点31メートル');
});

el('wipeBtn').addEventListener('click', () => {
  if (!confirm('校正・設定・計測ログをすべて消去します。元に戻せません。よろしいですか？')) return;
  clearAll();
  app.invalidateSource();
  app.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  setVoiceEnabled(app.settings.voice);
  syncForm();
  app.toast('保存データを消去しました');
});

const f1 = (v) => (typeof v === 'number' && isFinite(v) ? v.toFixed(1) : '—');
const f2 = (v) => (typeof v === 'number' && isFinite(v) ? v.toFixed(2) : '—');

function renderDiag(d) {
  const out = el('diagOut');
  out.hidden = false;
  out.className = 'diag';
  out.innerHTML = '';
  const p = (text) => { const e = document.createElement('p'); e.textContent = text; out.append(e); return e; };
  const st = (d.info && d.info.settings) || {};
  p(`受信フレーム数: ${d.frames} ／ 映像: ${st.width || '?'}×${st.height || '?'} ／ カメラが報告するフレームレート: ${st.frameRate ? f1(st.frameRate) + ' fps' : '不明'}`);
  if (d.info && d.info.requested) p(`要求した設定: ${d.info.requested.width}×${d.info.requested.height} / ${d.info.requested.frameRate}fps（試行 ${d.info.attempt + 1} 回目で開始${d.info.applyNote ? '、' + d.info.applyNote : ''}）`);

  const names = { captureTime: 'captureTime', mediaTime: 'mediaTime', presentationTime: 'presentationTime', now: '受信時刻' };
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>時刻の種類</th><th>実測fps</th><th>間隔(中央値)</th><th>ばらつき(SD)</th></tr></thead>';
  const tb = document.createElement('tbody');
  for (const key of Object.keys(names)) {
    const s = d.sources[key];
    const tr = document.createElement('tr');
    if (key === d.chosen) tr.className = 'chosen';
    const first = document.createElement('td');
    first.textContent = names[key];
    const note = document.createElement('small');
    note.textContent = s ? `${key === d.chosen ? '使用中 ・ ' : ''}${f1(s.minMs)}〜${f1(s.maxMs)} ms` : '取得不可';
    first.append(note);
    tr.append(first);
    for (const c of s ? [f1(s.fps), f2(s.medianMs) + ' ms', f2(s.sdMs) + ' ms'] : ['—', '—', '—']) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.append(td);
    }
    tb.append(tr);
  }
  table.append(tb);
  out.append(table);

  const use = d.sources[d.chosen];
  if (use) {
    const fps = use.fps;
    const verdict = fps >= 55 ? '60fps 相当で取得できています。' : fps >= 28 ? '約30fps です。計測はできますが、速い球ではフレーム数が少なくなります。部屋を明るくすると上がる場合があります。' : 'フレームレートが低すぎます。部屋を明るくするか、解像度を下げてください。';
    p(`判定: ${verdict}`);
    if (use.sdMs > 3) p('注意: フレーム間隔のばらつきが大きめです（3ms 超）。速度の誤差が増える可能性があります。');
  }
  if (typeof d.skipped === 'number') p(`処理が間に合わず飛ばしたフレーム: ${Math.max(0, d.skipped)}`);
  if (d.info && d.info.capabilities) {
    const c = d.info.capabilities;
    const pre = document.createElement('pre');
    const fr = c.frameRate ? `フレームレート ${f1(c.frameRate.min)}〜${f1(c.frameRate.max)} fps` : 'フレームレート: 不明';
    const wh = c.width && c.height ? `／ 解像度 最大 ${c.width.max}×${c.height.max}` : '';
    pre.textContent = `この端末のカメラが申告する対応範囲: ${fr} ${wh}\nrequestVideoFrameCallback: ${d.info.rvfc ? '対応' : '非対応（時刻精度が下がります）'}\nカメラ名: ${d.info.label || '不明'}`;
    out.append(pre);
  }
}

el('diagBtn').addEventListener('click', async () => {
  const btn = el('diagBtn');
  const out = el('diagOut');
  btn.disabled = true;
  out.hidden = false;
  out.className = 'diag';
  out.textContent = '診断中…（約3秒）';
  try {
    const src = await app.ensureSource();
    await fillDevices();
    const d = await runDiagnostics(src, 3000);
    renderDiag(d);
  } catch (err) {
    out.className = 'diag notice';
    app.showCameraError(out, err);
  } finally {
    btn.disabled = false;
  }
});
