// 測定テスト画面（仕様書の「A：測定・検証モード」）。
// ボールの位置・速度・減速・信頼度を表示し、結果を計測ログへ保存する。

import { CONFIG, APP_VERSION } from './config.js';
import { loadCalibration, saveCalibration, addLog } from './storage.js';
import { buildCalibration, applyH } from './core/homography.js';
import { MeasurePipeline, chooseProcScale } from './core/pipeline.js';
import { speak, unlock, speedText } from './voice.js';

let app = null;
let pipeline = null;
let cal = null;
let calData = null;
let procCanvas = null, procCtx = null;
let maskCanvas = null, maskCtx = null, maskImage = null;
let armed = false;
let shots = [];
let frameNo = 0;
let fpsEma = 0, lastT = null, procMsEma = 0;
let staticCands = [];
let wakeLock = null;
let lastMetaUpdate = 0;
let active = false;
let lastSpeedText = ''; // 直前の有効な計測値（操作ドックの状態表示に出す）
let needsCalibration = false; // true の間、下のボタンは「キャリブレーションへ」として働く

const STATE_TEXT = {
  idle: '「計測開始」を押してください',
  bg: '背景を取得中…（マットの上を動かさないでください）',
  waiting: '準備完了 ― 打ってください',
  tracking: 'ボールを追跡中',
  cooldown: '計測しました。次の準備をしています…',
};

function el(id) { return document.getElementById(id); }

/** シミュレーション映像用の校正（真値から自動作成）。 */
export function defaultSimCalibration(src) {
  return {
    source: 'sim',
    nPoints: 6,
    points: src.markerImagePoints(true),
    widthM: src.scene.o.zoneW,
    lengthM: src.scene.o.zoneL,
    cameraHeightM: src.cam.pos[2],
    imageW: src.width,
    imageH: src.height,
    savedAt: new Date().toISOString(),
    auto: true,
  };
}

function showNotice(title, body, btnLabel, onClick) {
  const n = el('measureNotice');
  n.hidden = false;
  n.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = title;
  n.append(b, document.createTextNode(body));
  if (btnLabel) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-small';
    btn.textContent = btnLabel;
    btn.addEventListener('click', onClick);
    n.append(btn);
  }
}

function setState(state, textOverride) {
  const b = el('measureState');
  if (b.dataset.state === state && !textOverride && b.dataset.custom !== '1') return;
  b.dataset.state = state;
  b.dataset.custom = textOverride ? '1' : '0';
  b.textContent = textOverride || STATE_TEXT[state] || '';
}

function setArmed(v) {
  armed = v;
  const btn = el('armBtn');
  btn.textContent = v ? '計測を停止' : '計測開始';
  btn.dataset.armed = String(v);
  if (!pipeline) return;
  if (v) {
    pipeline.arm();
    setState('bg');
    requestWakeLock();
  } else {
    pipeline.disarm();
    setState('idle');
    releaseWakeLock();
  }
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* 使えない環境では何もしない（画面が自動で消える場合は端末の設定で対応） */ }
}
function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch { /* 無視 */ }
  wakeLock = null;
}

export async function enter(a) {
  app = a;
  active = true;
  const navToken = (app._navToken = (app._navToken || 0) + 1);
  pipeline = null;
  staticCands = [];
  lastSpeedText = '';
  needsCalibration = false;
  el('measureNotice').hidden = true;
  el('armBtn').disabled = true;
  setArmedButtonOnly(false);
  setState('idle', '映像を準備しています…');
  renderShots();
  el('maskBtn').setAttribute('aria-pressed', String(!!app.settings.showMask));
  app.mountStage('measure');

  let src;
  try {
    src = await app.ensureSource();
  } catch (err) {
    if (app._navToken !== navToken) return;
    app.showCameraError(el('measureNotice'), err);
    setState('idle', 'カメラを開始できません');
    return;
  }
  if (app._navToken !== navToken || !active) return;
  app.layoutStage();

  calData = loadCalibration(src.kind);
  if (src.kind === 'sim' && (!calData || calData.imageW !== src.width || calData.imageH !== src.height)) {
    calData = defaultSimCalibration(src);
    saveCalibration('sim', calData);
  }
  if (!calData) {
    showNotice('キャリブレーションが必要です', '画像上の位置を実際の距離に換算するため、最初に基準点を登録してください。', 'キャリブレーションへ', () => app.go('calibrate'));
    setState('idle', 'キャリブレーションが未設定です');
    setNeedsCalibration(true);
    src.onFrame = () => drawOverlay();
    return;
  }
  if (calData.imageW !== src.width || calData.imageH !== src.height) {
    showNotice('キャリブレーションのやり直しが必要です', `保存されている校正は ${calData.imageW}×${calData.imageH} の映像用ですが、現在の映像は ${src.width}×${src.height} です（解像度の変更、または iPhone の向きの変更）。`, 'キャリブレーションへ', () => app.go('calibrate'));
    setState('idle', '校正と映像の大きさが一致しません（やり直しが必要です）');
    setNeedsCalibration(true);
    src.onFrame = () => drawOverlay();
    return;
  }

  try {
    cal = buildCalibration({ ...calData, ballRadiusM: CONFIG.ball.radiusM });
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    Object.assign(cfg.detect, app.settings.detect);
    const procScale = chooseProcScale(src.width, src.height, CONFIG.camera.procMaxWidth);
    pipeline = new MeasurePipeline({ cal, cfg, videoW: src.width, videoH: src.height, procScale });
  } catch (err) {
    showNotice('校正データを使用できません', String(err.message || err), 'キャリブレーションへ', () => app.go('calibrate'));
    setState('idle', '校正データに問題があります');
    setNeedsCalibration(true);
    return;
  }
  const { roi } = pipeline;
  procCanvas = document.createElement('canvas');
  procCanvas.width = roi.w;
  procCanvas.height = roi.h;
  procCtx = procCanvas.getContext('2d', { willReadFrequently: true });
  maskCanvas = document.createElement('canvas');
  maskCanvas.width = roi.w;
  maskCanvas.height = roi.h;
  maskCtx = maskCanvas.getContext('2d');
  maskImage = maskCtx.createImageData(roi.w, roi.h);

  frameNo = 0; fpsEma = 0; lastT = null; procMsEma = 0;
  el('armBtn').disabled = false;
  setState('idle');
  src.onFrame = onFrame;
}

/**
 * 校正がまだ無い（または映像と合わない）とき、下の主ボタンを「キャリブレーションへ」に切り替える。
 * 映像を大きく表示すると案内文が画面の下に隠れるため、常に見えるボタンから進めるようにする。
 */
function setNeedsCalibration(v) {
  needsCalibration = v;
  const btn = el('armBtn');
  if (v) {
    btn.textContent = 'キャリブレーションへ進む';
    btn.dataset.armed = 'false';
    btn.disabled = false;
  }
}

function setArmedButtonOnly(v) {
  armed = v;
  const btn = el('armBtn');
  btn.textContent = v ? '計測を停止' : '計測開始';
  btn.dataset.armed = String(v);
}

export function leave() {
  active = false;
  if (pipeline) pipeline.disarm();
  setArmedButtonOnly(false);
  releaseWakeLock();
  if (app && app.source) app.source.onFrame = null;
  pipeline = null;
}

export function onHidden() {
  if (armed) setArmed(false);
}

export function onLayout() { /* 重ね描きは毎フレーム描き直すので、ここでは何もしない */ }

function onFrame(f) {
  if (!pipeline || !active) return;
  const src = app.source;
  if (!src) return;
  frameNo++;
  const t0 = performance.now();
  if (lastT !== null && f.t > lastT) {
    const inst = 1 / (f.t - lastT);
    fpsEma = fpsEma ? fpsEma * 0.9 + inst * 0.1 : inst;
  }
  lastT = f.t;

  const { roi, procScale } = pipeline;
  let out = null;
  const needPixels = armed || frameNo % 4 === 0;
  if (needPixels) {
    // 測定範囲の部分だけを、処理用の大きさに縮小して取り出す
    procCtx.drawImage(src.drawable, roi.x / procScale, roi.y / procScale, roi.w / procScale, roi.h / procScale, 0, 0, roi.w, roi.h);
    const img = procCtx.getImageData(0, 0, roi.w, roi.h);
    if (armed) {
      out = pipeline.processFrame(img.data, f.t);
      staticCands = [];
    } else {
      staticCands = pipeline.detectStatic(img.data);
    }
  }
  if (out) handleOutput(out, f);
  // 重ね描きは計測より優先度が低い。計測中は1フレームおきに描いて処理時間を計測に回す。
  if (!armed || frameNo % 2 === 0 || (out && out.event)) drawOverlay();

  const ms = performance.now() - t0;
  procMsEma = procMsEma ? procMsEma * 0.9 + ms * 0.1 : ms;
  if (t0 - lastMetaUpdate > 500) {
    lastMetaUpdate = t0;
    const tsLabel = src.kind === 'sim' ? 'シミュレーション' : src.timeSource;
    el('measureMeta').textContent = `${src.width}×${src.height} ・ ${fpsEma ? fpsEma.toFixed(1) : '—'} fps ・ 時刻: ${tsLabel} ・ 処理 ${procMsEma.toFixed(1)} ms`;
  }
}

function handleOutput(out, f) {
  if (out.event === 'ready') {
    setState('waiting', lastSpeedText ? `${STATE_TEXT.waiting}（前回 ${lastSpeedText}）` : undefined);
    speak('準備完了', { interrupt: false });
  } else if (out.event === 'sceneChanged') {
    setState('bg', '画面が大きく変化しました。背景を取り直しています…');
  } else if (out.event === 'result') {
    onResult(out.result, f);
  }
  if (!out.event) {
    if (out.state === 'tracking') setState('tracking');
    else if (out.state === 'bg') { /* 表示は維持 */ }
    else if (out.state === 'waiting' && el('measureState').dataset.state !== 'waiting') setState('waiting');
  }
}

function onResult(res, f) {
  const src = app.source;
  const truth = src.kind === 'sim' && src.truth ? { ...src.truth } : null;
  const entry = addLog({
    source: src.kind,
    result: res,
    timeSource: src.timeSource,
    zoneLengthM: calData.lengthM,
    zoneWidthM: calData.widthM,
    cameraHeightM: calData.cameraHeightM,
    video: { w: src.width, h: src.height },
    fps: Math.round(fpsEma * 10) / 10,
    simTruth: truth,
    appVersion: APP_VERSION,
  });
  shots.unshift({ id: entry.id, at: new Date(), res, truth });
  shots = shots.slice(0, 20);
  renderResult(res, truth);
  renderShots();
  // 映像を大きく表示しているときは結果カードが画面の下に隠れるので、常に見える状態表示にも速度を出す
  if (res.valid) lastSpeedText = `${fmt(res.speedEntry)} m/s`;
  setState('cooldown', res.valid ? `${lastSpeedText} ― 次の準備をしています…` : '計測できませんでした。次の準備をしています…');
  if (res.valid) speak(`秒速${speedText(res.speedEntry)}メートル`);
  else speak('計測失敗');
}

const fmt = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '—');

function gridItem(dt, ddHtml, cls) {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  const a = document.createElement('dt');
  a.textContent = dt;
  const b = document.createElement('dd');
  b.innerHTML = ddHtml;
  div.append(a, b);
  return div;
}

export function resultItems(res, truth) {
  const items = [];
  if (res.speedEntry !== undefined) {
    items.push(gridItem('区間中央の速度', `${fmt(res.speedMid)} <small>m/s</small>`));
    items.push(gridItem('出口速度', `${fmt(res.speedExit)} <small>m/s</small>`));
    const rough = res.decelSE > Math.max(0.1, Math.abs(res.decel) * 0.3);
    items.push(gridItem('減速度', `${fmt(res.decel)} <small>±${fmt(res.decelSE)} m/s²${rough ? '（参考値）' : ''}</small>`, rough ? 'warn' : ''));
    const dir = res.directionDeg;
    items.push(gridItem('方向', `${Math.abs(dir) < 0.05 ? 'まっすぐ' : (dir > 0 ? '右 ' : '左 ') + fmt(Math.abs(dir), 1) + '°'}`));
  }
  items.push(gridItem('信頼度', res.valid ? `${res.confidenceLabel} <small>(${res.confidence})</small>` : '無効', res.valid ? (res.confidence < 50 ? 'warn' : '') : 'bad'));
  if (res.n) items.push(gridItem('フレーム', `${res.n} <small>枚 / ${fmt(res.fpsEff, 1)} fps</small>`, res.fpsEff < 45 ? 'warn' : ''));
  if (res.travelM !== undefined) items.push(gridItem('観測できた距離', `${fmt(res.travelM)} <small>m</small>`));
  if (res.fitRmsM !== undefined) items.push(gridItem('当てはめ誤差', `${fmt(res.fitRmsM * 1000, 1)} <small>mm${res.outliers ? `（${res.outliers}枚を除外）` : ''}</small>`));
  if (res.skid) {
    items.push(gridItem('打ち出し直後の滑り', res.skid.detected
      ? `検出 <small>転がり開始 ${fmt(res.skid.speedAtRoll)} m/s（スタートから ${fmt(res.skid.yAtRoll)} m）</small>`
      : '区間内では検出なし', 'wide'));
  }
  if (res.stoppedInZone) items.push(gridItem('停止位置', `スタートラインから ${fmt(res.stopY)} <small>m</small>`, 'wide'));
  if (truth && res.valid) {
    const e = ((res.speedEntry - truth.lineSpeed) / truth.lineSpeed) * 100;
    items.push(gridItem('シミュレーションの真値', `${fmt(truth.lineSpeed, 3)} <small>m/s（誤差 ${e >= 0 ? '+' : ''}${fmt(e, 2)}%）</small>`, 'wide'));
  }
  return items;
}

function renderResult(res, truth) {
  const card = el('resultCard');
  card.dataset.valid = String(!!res.valid);
  el('resultSpeed').textContent = res.valid ? fmt(res.speedEntry) : '---';
  el('resultSpeed').dataset.empty = String(!res.valid);
  el('resultLabel').textContent = res.valid ? '入口速度（スタートライン通過時）' : '計測できませんでした';
  const reason = el('resultReason');
  reason.hidden = res.valid;
  reason.textContent = res.valid ? '' : (res.reasonText || []).join(' / ');
  const grid = el('resultGrid');
  grid.innerHTML = '';
  grid.append(...resultItems(res, truth));
}

function renderShots() {
  const list = el('shotList');
  list.innerHTML = '';
  el('shotCount').textContent = shots.length ? `（${shots.length}）` : '';
  for (const s of shots.slice(0, 8)) {
    const li = document.createElement('li');
    li.dataset.valid = String(!!s.res.valid);
    const time = s.at.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const left = document.createElement('span');
    left.textContent = time;
    const right = document.createElement('span');
    if (s.res.valid) {
      const b = document.createElement('b');
      b.textContent = `${fmt(s.res.speedEntry)} m/s`;
      right.append(b, document.createTextNode(` ・ 信頼度 ${s.res.confidenceLabel}`));
    } else {
      right.textContent = `無効: ${(s.res.reasonText || [])[0] || ''}`;
    }
    li.append(left, right);
    list.append(li);
  }
}

// ---------- 重ね描き ----------
function drawOverlay() {
  const cv = app.stage.overlay;
  const g = cv.getContext('2d');
  const k = app.viewScale;
  g.clearRect(0, 0, cv.width, cv.height);
  if (!pipeline || !cal) return;
  const dpr = cv.width / Math.max(1, app.stage.el.clientWidth);
  const P = (X, Y) => { const [u, v] = applyH(cal.plane2img, X, Y); return [u * k, v * k]; };
  const W = cal.widthM, L = cal.lengthM;

  // 検出表示（白と判定された画素）
  if (app.settings.showMask) {
    const { roi, procScale, debugMask } = pipeline;
    const d = maskImage.data;
    for (let i = 0, j = 0; i < debugMask.length; i++, j += 4) {
      if (debugMask[i]) { d[j] = 226; d[j + 1] = 255; d[j + 2] = 31; d[j + 3] = 200; }
      else { d[j + 3] = pipeline.zoneMask[i] ? 0 : 110; d[j] = d[j + 1] = d[j + 2] = 0; }
    }
    maskCtx.putImageData(maskImage, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(maskCanvas, (roi.x / procScale) * k, (roi.y / procScale) * k, (roi.w / procScale) * k, (roi.h / procScale) * k);
    g.imageSmoothingEnabled = true;
  }

  // 測定範囲
  const c = [P(0, 0), P(W, 0), P(W, L), P(0, L)];
  g.lineWidth = 1.5 * dpr;
  g.strokeStyle = 'rgba(226,255,31,0.75)';
  g.beginPath();
  c.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.stroke();
  // スタートライン（太線）と 50cm ごとの目盛り
  g.lineWidth = 3.5 * dpr;
  g.strokeStyle = '#e2ff1f';
  g.beginPath(); g.moveTo(...c[0]); g.lineTo(...c[1]); g.stroke();
  g.lineWidth = 1 * dpr;
  g.strokeStyle = 'rgba(226,255,31,0.45)';
  for (let y = 0.5; y < L - 1e-6; y += 0.5) { g.beginPath(); g.moveTo(...P(0, y)); g.lineTo(...P(W, y)); g.stroke(); }
  g.font = `700 ${11 * dpr}px -apple-system, sans-serif`;
  g.fillStyle = '#e2ff1f';
  g.textAlign = 'center';
  const lbl = (text, X, Y) => { const [x, y] = P(X, Y); g.fillText(text, x, y - 6 * dpr); };
  lbl('START', W / 2, 0);
  lbl('GOAL', W / 2, L);

  // 追跡した軌跡
  const pts = pipeline.trackPoints;
  if (pts && pts.length) {
    g.fillStyle = '#ffffff';
    for (const p of pts) { const [x, y] = P(p.X, p.Y); g.beginPath(); g.arc(x, y, 2.2 * dpr, 0, 6.3); g.fill(); }
  }
  // 現在の候補
  const cands = armed ? pipeline.lastCandidates : staticCands;
  g.lineWidth = 2 * dpr;
  g.strokeStyle = armed ? '#ffffff' : '#e2ff1f';
  for (const cd of cands || []) {
    const r = Math.max(6 * dpr, (cd.diamPx * k) / 2 + 3 * dpr);
    g.beginPath(); g.arc(cd.u * k, cd.v * k, r, 0, 6.3); g.stroke();
  }
  if (!armed && staticCands.length) {
    g.fillStyle = '#e2ff1f';
    g.textAlign = 'left';
    const cd = staticCands[0];
    g.fillText('ボール認識', cd.u * k + 10 * dpr, cd.v * k - 10 * dpr);
  }
}

// ---------- 操作 ----------
document.getElementById('armBtn').addEventListener('click', () => {
  if (needsCalibration) { app.go('calibrate'); return; }
  if (!pipeline) return;
  unlock(); // 音声の有効化（iPhone では最初のタップの中で行う必要がある）
  setArmed(!armed);
});

document.getElementById('maskBtn').addEventListener('click', (e) => {
  if (!app) return;
  app.settings.showMask = !app.settings.showMask;
  app.saveSettings();
  e.currentTarget.setAttribute('aria-pressed', String(app.settings.showMask));
});
