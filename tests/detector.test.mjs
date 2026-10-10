// ボール検出（画像処理）のテスト。合成画像を使用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMask, findBlobs, ballScore, lumaOf } from '../js/core/detector.js';
import { CONFIG } from '../js/config.js';
import { SimScene, presetCamera } from '../js/core/simscene.js';

const D = CONFIG.detect;

function detect(frame, bgFrame, w, h, params = D) {
  const n = w * h;
  const mask = new Uint8Array(n), weight = new Uint8Array(n);
  let bg = null;
  if (bgFrame) { bg = new Float32Array(n); const l = lumaOf(bgFrame, w, h, new Uint8Array(n)); bg.set(l); }
  const count = buildMask(frame, w, h, bg, null, { ...params, bgAlpha: 0, bgAlphaMasked: 0 }, mask, weight);
  return { count, blobs: findBlobs(mask, weight, w, h, D.minAreaPx) };
}

test('静止したボールの中心を 0.5px 以内で検出する', () => {
  const cam = presetCamera('side', 640, 360);
  const scene = new SimScene(cam);
  const bg = scene.renderFrame(new Uint8ClampedArray(640 * 360 * 4), { t: 0 });
  for (const [x, y] of [[0.15, 0.1], [0.12, 0.75], [0.2, 1.4]]) {
    const fr = scene.renderFrame(new Uint8ClampedArray(640 * 360 * 4), { t: 0, ballAt: () => ({ x, y }) });
    const { blobs } = detect(fr, bg, 640, 360);
    assert.equal(blobs.length, 1, 'ボールだけが検出される');
    const q = cam.project([x, y, 0.021335]);
    const err = Math.hypot(blobs[0].cx - q.u, blobs[0].cy - q.v);
    assert.ok(err < 0.5, `中心誤差 ${err.toFixed(3)}px`);
    const expDiam = (2 * cam.f * 0.021335) / q.depth;
    assert.ok(ballScore(blobs[0], expDiam, D) > 0.5, `形状スコア ${ballScore(blobs[0], expDiam, D)}`);
    assert.ok(Math.abs(blobs[0].minor - expDiam) / expDiam < 0.25, `直径 ${blobs[0].minor} vs ${expDiam}`);
  }
});

test('動いてブレたボール: 重心は露光中央の位置に一致する', () => {
  const cam = presetCamera('side', 640, 360);
  const scene = new SimScene(cam);
  const bg = scene.renderFrame(new Uint8ClampedArray(640 * 360 * 4), { t: 0 });
  const ballAt = (t) => ({ x: 0.15, y: 0.5 + 3.0 * t }); // 3 m/s
  const fr = scene.renderFrame(new Uint8ClampedArray(640 * 360 * 4), { t: 0, ballAt, exposure: 1 / 60 });
  const { blobs } = detect(fr, bg, 640, 360);
  assert.equal(blobs.length, 1);
  const q = cam.project([0.15, 0.5, 0.021335]);
  const err = Math.hypot(blobs[0].cx - q.u, blobs[0].cy - q.v);
  assert.ok(err < 0.6, `中心誤差 ${err.toFixed(3)}px`);
  assert.ok(blobs[0].major > blobs[0].minor * 1.3, 'ブレで細長くなる');
  const expDiam = (2 * cam.f * 0.021335) / q.depth;
  assert.ok(ballScore(blobs[0], expDiam, D) > 0, 'ブレていても採用される');
});

test('背景にある静止した白い物体は検出しない（背景差分）', () => {
  const cam = presetCamera('side', 640, 360);
  const scene = new SimScene(cam, { whitePatches: [{ x0: 0.08, x1: 0.13, y0: 0.6, y1: 0.65 }] });
  const bg = scene.renderFrame(new Uint8ClampedArray(640 * 360 * 4), { t: 0 });
  const fr = scene.renderFrame(new Uint8ClampedArray(640 * 360 * 4), { t: 0, ballAt: () => ({ x: 0.2, y: 1.0 }) });
  const { blobs } = detect(fr, bg, 640, 360);
  assert.equal(blobs.length, 1, 'ボールのみ');
  // 背景差分なし（静止検出モード）では白い物体も拾うが、それは別の塊になる
  const noBg = detect(fr, null, 640, 360);
  assert.ok(noBg.blobs.length >= 2);
});

test('暗い物体（パターヘッド）・影は候補にならない', () => {
  const cam = presetCamera('side', 640, 360);
  const scene = new SimScene(cam);
  const bg = scene.renderFrame(new Uint8ClampedArray(640 * 360 * 4), { t: 0 });
  const fr = scene.renderFrame(new Uint8ClampedArray(640 * 360 * 4), { t: 0, boxes: [{ x: 0.15, y: 0.3, w: 0.1, l: 0.03, color: [55, 55, 60] }] });
  assert.equal(detect(fr, bg, 640, 360).blobs.length, 0);
});

test('色の付いた明るい物体（黄色い目印など）は候補にならない', () => {
  const cam = presetCamera('side', 640, 360);
  const scene = new SimScene(cam);
  const fr = scene.renderFrame(new Uint8ClampedArray(640 * 360 * 4), { t: 0 });
  // 背景差分なしでも、黄色の目印・緑のマット・木目の床は白とみなされない
  assert.equal(detect(fr, null, 640, 360).blobs.length, 0);
});

test('大きさ・形の合わない塊は不採用', () => {
  const blob = (minor, major, area) => ({ minor, major, area, fill: area / ((Math.PI / 4) * major * minor) });
  const d = 10;
  assert.ok(ballScore(blob(10, 10, 78.5), d, D) > 0.9, '丸くて大きさが合う');
  assert.equal(ballScore(blob(3, 3, 7), d, D), 0, '小さすぎる');
  assert.equal(ballScore(blob(30, 30, 707), d, D), 0, '大きすぎる');
  assert.equal(ballScore(blob(10, 80, 628), d, D), 0, '長すぎる（線状の反射など）');
  assert.equal(ballScore(blob(10, 10, 30), d, D), 0, '中身がスカスカ');
});

test('連結成分: 離れた2つは別々、斜めに接する画素は同じ塊', () => {
  const w = 8, h = 6;
  const mask = new Uint8Array(w * h), weight = new Uint8Array(w * h).fill(1);
  const set = (x, y) => { mask[y * w + x] = 1; };
  set(1, 1); set(2, 2); set(3, 3); // 斜め
  set(6, 1); set(6, 2);
  const blobs = findBlobs(mask, weight, w, h, 1);
  assert.equal(blobs.length, 2);
  assert.deepEqual(blobs.map((b) => b.area).sort(), [2, 3]);
  const b3 = blobs.find((b) => b.area === 3);
  assert.ok(Math.abs(b3.cx - 2.5) < 1e-9 && Math.abs(b3.cy - 2.5) < 1e-9, '画素中心基準の重心');
});

test('白い床の上では背景との差が小さく、検出できない（既知の制約）', () => {
  const cam = presetCamera('side', 640, 360);
  // マット全体を無地の白い面で覆う
  const scene = new SimScene(cam, { whitePatches: [{ x0: 0.03, x1: 0.27, y0: -0.7, y1: 2.3 }] });
  const bg = scene.renderFrame(new Uint8ClampedArray(640 * 360 * 4), { t: 0 });
  const fr = scene.renderFrame(new Uint8ClampedArray(640 * 360 * 4), { t: 0, ballAt: () => ({ x: 0.15, y: 0.75 }) });
  assert.equal(detect(fr, bg, 640, 360).blobs.length, 0, '白いマット上の白球は検出されない');
});
