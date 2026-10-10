// キャリブレーション画面: 画像上の基準点（目印）と実寸を登録し、ピクセル -> メートルの換算を作る。

import { CONFIG } from './config.js';
import { loadCalibration, saveCalibration } from './storage.js';
import { buildCalibration, applyH, expectedBallDiameterPx } from './core/homography.js';
import { chooseProcScale } from './core/pipeline.js';
import { defaultSimCalibration } from './ui-measure.js';

const NAMES = ['① スタート左', '② スタート右', '③ ゴール右', '④ ゴール左', '⑤ 中間左', '⑥ 中間右'];
const COLORS = ['#e2ff1f', '#e2ff1f', '#4fd8ff', '#4fd8ff', '#ffffff', '#ffffff'];

let app = null;
let active = false;
let mode = 'live'; // 'live' | 'edit'
let points = []; // 映像座標
let selected = 0;
let saved = null; // 保存済みの校正データ
let drag = null;

const el = (id) => document.getElementById(id);
const C = CONFIG.calibration;

function defaultPoints(w, h, n) {
  // 画面中央に、横長（または縦長）の四角形を置く
  const land = w >= h;
  const p = land
    ? [[0.15, 0.62], [0.15, 0.42], [0.85, 0.42], [0.85, 0.62]]
    : [[0.38, 0.85], [0.62, 0.85], [0.62, 0.15], [0.38, 0.15]];
  const pts = p.map(([a, b]) => [a * w, b * h]);
  if (n === 6) pts.push(mid(pts[0], pts[3]), mid(pts[1], pts[2]));
  return pts;
}
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

function readInputs() {
  return {
    nPoints: Number(el('calNPoints').value),
    widthM: Number(el('calWidth').value) / 100,
    lengthM: Number(el('calLength').value) / 100,
    cameraHeightM: Number(el('calHeight').value) / 100,
  };
}

function validateInputs(v) {
  if (!(v.widthM * 100 >= C.minWidthCm && v.widthM * 100 <= C.maxWidthCm)) return `左右の間隔は ${C.minWidthCm}〜${C.maxWidthCm}cm で入力してください`;
  if (!(v.lengthM * 100 >= C.minLengthCm && v.lengthM * 100 <= C.maxLengthCm)) return `スタート〜ゴールの間隔は ${C.minLengthCm}〜${C.maxLengthCm}cm で入力してください`;
  if (!(v.cameraHeightM * 100 >= C.minCameraHeightCm && v.cameraHeightM * 100 <= C.maxCameraHeightCm)) return `カメラの高さは ${C.minCameraHeightCm}〜${C.maxCameraHeightCm}cm で入力してください`;
  return null;
}

/** 現在の入力内容で換算を試算する。失敗時は { error }。 */
function tryBuild() {
  const v = readInputs();
  const err = validateInputs(v);
  if (err) return { error: err };
  const src = app.source;
  try {
    const data = {
      points: points.slice(0, v.nPoints).map((p) => [p[0], p[1]]),
      widthM: v.widthM, lengthM: v.lengthM, cameraHeightM: v.cameraHeightM,
      imageW: src.width, imageH: src.height,
    };
    return { data, cal: buildCalibration({ ...data, ballRadiusM: CONFIG.ball.radiusM }), v };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function item(dt, dd, cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  const a = document.createElement('dt'); a.textContent = dt;
  const b = document.createElement('dd'); b.innerHTML = dd;
  d.append(a, b);
  return d;
}

function renderCheck() {
  const box = el('calCheck');
  box.innerHTML = '';
  const r = tryBuild();
  const notice = el('calNotice');
  if (r.error) {
    notice.hidden = false;
    notice.innerHTML = '';
    const b = document.createElement('b'); b.textContent = '保存できない状態です';
    notice.append(b, document.createTextNode(r.error));
    return r;
  }
  notice.hidden = true;
  const { cal, v } = r;
  const src = app.source;
  const scale = chooseProcScale(src.width, src.height, CONFIG.camera.procMaxWidth);
  const dStart = expectedBallDiameterPx(cal.plane2img, v.widthM / 2, 0, CONFIG.ball.diameterM);
  const dEnd = expectedBallDiameterPx(cal.plane2img, v.widthM / 2, v.lengthM, CONFIG.ball.diameterM);
  const dMin = Math.min(dStart, dEnd) * scale;
  box.append(item('分解能（スタート側 / ゴール側）', `${cal.pxPerMStart.toFixed(0)} / ${cal.pxPerMEnd.toFixed(0)} <small>px/m</small>`));
  box.append(item('ボールの見かけの直径', `${Math.min(dStart, dEnd).toFixed(0)}〜${Math.max(dStart, dEnd).toFixed(0)} <small>px（処理時 最小${dMin.toFixed(1)}px）${dMin < 6 ? ' 小さすぎます。カメラを近づけてください' : ''}</small>`, dMin < 6 ? 'bad' : ''));
  if (v.nPoints === 6) {
    const mm = cal.residual.rms * 1000, mx = cal.residual.max * 1000;
    const bad = mx > 8, warn = mx > 4;
    box.append(item('6点の食い違い（校正の誤差）', `${mm.toFixed(1)} <small>mm（最大 ${mx.toFixed(1)}mm）${bad ? ' 大きすぎます。点の位置・寸法・目印の配置を確認してください' : ''}</small>`, bad ? 'bad' : warn ? 'warn' : ''));
  } else {
    box.append(item('校正の誤差', '<small>4点では確認できません（6点を推奨）</small>', 'warn'));
  }
  if (cal.pose) {
    const diff = Math.abs(cal.pose.height - v.cameraHeightM) / v.cameraHeightM;
    box.append(item('映像から推定したカメラの高さ', `${(cal.pose.height * 100).toFixed(0)} <small>cm（入力 ${(v.cameraHeightM * 100).toFixed(0)}cm）${diff > 0.2 ? ' 差が大きいです。寸法か点の位置を確認してください' : ''}</small>`, diff > 0.35 ? 'bad' : diff > 0.2 ? 'warn' : ''));
  } else {
    box.append(item('映像から推定したカメラの高さ', '<small>この配置では推定できません</small>'));
  }
  box.append(item('ボール高さの補正', `${((cal.kHeight - 1) * 100).toFixed(2)} <small>%（${cal.nadir ? '位置ごと補正' : '距離のみ補正'}）</small>`));
  return r;
}

function setMode(m) {
  mode = m;
  el('calLive').hidden = m !== 'live';
  el('calEdit').hidden = m !== 'edit';
  app.stage.still.hidden = m !== 'edit';
  app.stage.el.classList.toggle('editing', m === 'edit');
  app.stage.loupe.hidden = m !== 'edit';
  // 表示する操作ドックが変わる（高さが変わる）ので、映像の大きさを決め直す
  app.layoutStage();
  if (m === 'live') el('calNotice').hidden = true;
  draw();
}

function updateSavedInfo() {
  const info = el('calSavedInfo');
  const src = app.source;
  if (!saved) { info.textContent = 'まだ校正は保存されていません。'; return; }
  const d = new Date(saved.savedAt);
  const match = src && saved.imageW === src.width && saved.imageH === src.height;
  info.textContent = `保存済み: ${d.toLocaleDateString('ja-JP')} ${d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} ・ ${saved.nPoints}点 ・ ${(saved.widthM * 100).toFixed(1)}×${(saved.lengthM * 100).toFixed(1)}cm${saved.auto ? '（シミュレーション用に自動設定）' : ''}。` +
    (match ? '映像に重ねた枠が目印からずれていたら、カメラが動いています。撮り直してください。' : '現在の映像と大きさが違うため、撮り直しが必要です。');
}

export async function enter(a) {
  app = a;
  active = true;
  const navToken = (app._navToken = (app._navToken || 0) + 1);
  el('calNotice').hidden = true;
  app.mountStage('calibrate');
  el('calLive').hidden = false;
  el('calEdit').hidden = true;
  el('calFreezeBtn').disabled = true;
  mode = 'live';

  let src;
  try {
    src = await app.ensureSource();
  } catch (err) {
    if (app._navToken !== navToken) return;
    app.showCameraError(el('calNotice'), err);
    return;
  }
  if (app._navToken !== navToken || !active) return;
  app.layoutStage();

  saved = loadCalibration(src.kind);
  if (src.kind === 'sim' && !saved) { saved = defaultSimCalibration(src); saveCalibration('sim', saved); }
  const usable = saved && saved.imageW === src.width && saved.imageH === src.height;
  const n = saved ? saved.nPoints : 6;
  el('calNPoints').value = String(n);
  el('calWidth').value = saved ? +(saved.widthM * 100).toFixed(1) : C.defaultWidthCm;
  el('calLength').value = saved ? +(saved.lengthM * 100).toFixed(1) : C.defaultLengthCm;
  el('calHeight').value = saved ? +(saved.cameraHeightM * 100).toFixed(0) : C.defaultCameraHeightCm;
  points = usable ? saved.points.map((p) => [p[0], p[1]]) : defaultPoints(src.width, src.height, 6);
  if (points.length < 6) points.push(mid(points[0], points[3]), mid(points[1], points[2]));
  selected = 0;
  el('calFreezeBtn').disabled = false;
  el('calMeta').textContent = `${src.width}×${src.height} ・ ${src.kind === 'sim' ? 'シミュレーション映像' : (src.info.label || 'カメラ')}`;
  updateSavedInfo();
  src.onFrame = () => { if (mode === 'live') draw(); };
  draw();
}

export function leave() {
  active = false;
  if (app && app.source) app.source.onFrame = null;
  if (app) { app.stage.still.hidden = true; app.stage.loupe.hidden = true; app.stage.el.classList.remove('editing'); }
}

export function onLayout() { if (active) draw(); }

// ---------- 描画 ----------
function draw() {
  if (!app || !app.source) return;
  const cv = app.stage.overlay;
  const g = cv.getContext('2d');
  const k = app.viewScale;
  const dpr = cv.width / Math.max(1, app.stage.el.clientWidth);
  g.clearRect(0, 0, cv.width, cv.height);

  if (mode === 'live') {
    const src = app.source;
    if (!saved || saved.imageW !== src.width || saved.imageH !== src.height) return;
    drawFrame(g, saved.points, saved.nPoints, k, dpr, false);
    return;
  }
  const n = Number(el('calNPoints').value);
  drawFrame(g, points, n, k, dpr, true);
}

function drawFrame(g, pts, n, k, dpr, edit) {
  // 四角形
  g.lineWidth = 1.5 * dpr;
  g.strokeStyle = 'rgba(226,255,31,0.85)';
  g.beginPath();
  [0, 1, 2, 3].forEach((i, j) => (j ? g.lineTo(pts[i][0] * k, pts[i][1] * k) : g.moveTo(pts[i][0] * k, pts[i][1] * k)));
  g.closePath();
  g.stroke();
  g.lineWidth = 3.5 * dpr;
  g.strokeStyle = '#e2ff1f';
  g.beginPath(); g.moveTo(pts[0][0] * k, pts[0][1] * k); g.lineTo(pts[1][0] * k, pts[1][1] * k); g.stroke();

  // 編集中は、現在の入力で換算した 10cm 間隔の線を重ねる（メジャーと見比べて確認できる）
  if (edit) {
    const r = tryBuild();
    if (!r.error) {
      const P = (X, Y) => { const [u, v] = applyH(r.cal.plane2img, X, Y); return [u * k, v * k]; };
      g.lineWidth = 1 * dpr;
      for (let y = 0.1; y < r.v.lengthM - 1e-6; y += 0.1) {
        const major = Math.abs(y * 2 - Math.round(y * 2)) < 1e-6;
        g.strokeStyle = major ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.28)';
        g.beginPath(); g.moveTo(...P(0, y)); g.lineTo(...P(r.v.widthM, y)); g.stroke();
      }
    }
  }

  // 基準点
  g.font = `700 ${12 * dpr}px -apple-system, sans-serif`;
  g.textAlign = 'center';
  for (let i = 0; i < n; i++) {
    const x = pts[i][0] * k, y = pts[i][1] * k;
    const sel = edit && i === selected;
    g.lineWidth = (sel ? 3 : 2) * dpr;
    g.strokeStyle = COLORS[i];
    g.beginPath(); g.arc(x, y, (edit ? (sel ? 12 : 9) : 5) * dpr, 0, 6.3); g.stroke();
    if (edit) {
      g.beginPath();
      g.moveTo(x - 5 * dpr, y); g.lineTo(x + 5 * dpr, y);
      g.moveTo(x, y - 5 * dpr); g.lineTo(x, y + 5 * dpr);
      g.lineWidth = 1 * dpr;
      g.stroke();
      // 番号は、左側の点（①④⑤）は上、右側の点（②③⑥）は下に出して重なりを避ける
      const ly = y + (i === 0 || i === 3 || i === 4 ? -22 : 30) * dpr;
      if (sel) { g.fillStyle = COLORS[i]; g.fillRect(x - 9 * dpr, ly - 12.5 * dpr, 18 * dpr, 16 * dpr); g.fillStyle = '#0a0a0a'; }
      else g.fillStyle = COLORS[i];
      g.fillText(String(i + 1), x, ly);
    }
  }
}

function drawLoupe() {
  const lp = app.stage.loupe;
  const still = app.stage.still;
  const [u, v] = points[selected];
  const g = lp.getContext('2d');
  const size = lp.width;
  const zoom = 4;
  const span = size / zoom;
  g.imageSmoothingEnabled = false;
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  g.drawImage(still, u - span / 2, v - span / 2, span, span, 0, 0, size, size);
  g.strokeStyle = '#e2ff1f';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(size / 2, 0); g.lineTo(size / 2, size / 2 - 5);
  g.moveTo(size / 2, size / 2 + 5); g.lineTo(size / 2, size);
  g.moveTo(0, size / 2); g.lineTo(size / 2 - 5, size / 2);
  g.moveTo(size / 2 + 5, size / 2); g.lineTo(size, size / 2);
  g.stroke();
  // 選択中の点（＝指のある場所）から遠い隅に出す。拡大表示はタッチを素通しするので、
  // 下に隠れた点もそのままつかめる。
  const left = u < app.source.width / 2, top = v < app.source.height / 2;
  lp.dataset.pos = (top ? 'b' : 't') + (left ? 'r' : 'l');
  lp.hidden = false;
}

function select(i) {
  selected = i;
  el('calSelName').textContent = `選択中: ${NAMES[i]}`;
  drawLoupe();
  draw();
}

function movePoint(i, u, v) {
  const src = app.source;
  points[i] = [Math.max(0, Math.min(src.width, u)), Math.max(0, Math.min(src.height, v))];
}

function refresh() {
  drawLoupe();
  draw();
  renderCheck();
}

// ---------- 操作 ----------
function stagePos(e) {
  const r = app.stage.overlay.getBoundingClientRect();
  const src = app.source;
  return [((e.clientX - r.left) / r.width) * src.width, ((e.clientY - r.top) / r.height) * src.height, r.width / src.width];
}

const overlay = document.getElementById('overlay');
overlay.addEventListener('pointerdown', (e) => {
  if (!active || mode !== 'edit') return;
  const [u, v, cssPerPx] = stagePos(e);
  const n = Number(el('calNPoints').value);
  let best = -1, bd = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(points[i][0] - u, points[i][1] - v) * cssPerPx;
    if (d < bd) { bd = d; best = i; }
  }
  if (best < 0 || bd > 64) return;
  e.preventDefault();
  overlay.setPointerCapture(e.pointerId);
  // 指の位置へ点を飛ばさず、指の動いた量だけ点を動かす（指で隠れていても合わせられる）
  drag = { id: e.pointerId, i: best, u0: u, v0: v, p0: [...points[best]] };
  select(best);
});
overlay.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  e.preventDefault();
  const [u, v] = stagePos(e);
  movePoint(drag.i, drag.p0[0] + (u - drag.u0), drag.p0[1] + (v - drag.v0));
  drawLoupe();
  draw();
});
const endDrag = (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag = null;
  renderCheck();
};
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);

document.querySelectorAll('[data-nudge]').forEach((b) => {
  b.addEventListener('click', () => {
    if (mode !== 'edit') return;
    const [dx, dy] = b.dataset.nudge.split(',').map(Number);
    movePoint(selected, points[selected][0] + dx, points[selected][1] + dy);
    refresh();
  });
});

el('calNextPt').addEventListener('click', () => {
  const n = Number(el('calNPoints').value);
  select((selected + 1) % n);
});

el('calFreezeBtn').addEventListener('click', () => {
  const src = app.source;
  if (!src) return;
  const still = app.stage.still;
  still.width = src.width;
  still.height = src.height;
  still.getContext('2d').drawImage(src.drawable, 0, 0, src.width, src.height);
  setMode('edit');
  select(0);
  renderCheck();
});

el('calRetakeBtn').addEventListener('click', () => setMode('live'));

['calNPoints', 'calWidth', 'calLength', 'calHeight'].forEach((id) => {
  el(id).addEventListener('input', () => {
    if (mode !== 'edit') return;
    const n = Number(el('calNPoints').value);
    if (selected >= n) selected = 0;
    refresh();
  });
});

el('calSaveBtn').addEventListener('click', () => {
  const r = renderCheck();
  if (r.error) { app.toast('保存できません: ' + r.error, 3500); return; }
  const src = app.source;
  saved = {
    source: src.kind,
    nPoints: r.v.nPoints,
    ...r.data,
    savedAt: new Date().toISOString(),
    deviceLabel: (src.info && src.info.label) || '',
  };
  if (!saveCalibration(src.kind, saved)) { app.toast('保存に失敗しました（端末の保存領域を確認してください）', 3500); return; }
  app.toast('キャリブレーションを保存しました');
  updateSavedInfo();
  setMode('live');
});
