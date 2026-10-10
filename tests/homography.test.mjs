// ピクセル -> メートル換算（遠近補正）のテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeHomography, applyH, invert3, mul3, reprojectionErrors, isConvexQuad,
  heightScale, buildCalibration, expectedBallDiameterPx,
} from '../js/core/homography.js';
import { presetCamera, makeCamera } from '../js/core/simscene.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a} (tol ${tol})`);

test('4点から求めたホモグラフィは、基準点を厳密に写す', () => {
  const src = [[100, 600], [520, 610], [430, 200], [180, 190]];
  const dst = [[0, 0], [0.3, 0], [0.3, 1.5], [0, 1.5]];
  const H = computeHomography(src, dst);
  src.forEach(([x, y], i) => {
    const [X, Y] = applyH(H, x, y);
    near(X, dst[i][0], 1e-9);
    near(Y, dst[i][1], 1e-9);
  });
});

test('既知のホモグラフィを復元できる（任意の点で一致）', () => {
  const Htrue = [1.2, 0.3, -40, -0.2, 0.9, 12, 0.0004, -0.0007, 1];
  const src = [[10, 20], [600, 40], [580, 330], [30, 300], [300, 200]];
  const dst = src.map(([x, y]) => applyH(Htrue, x, y));
  const H = computeHomography(src, dst);
  for (const [x, y] of [[123, 45], [400, 250], [50, 310], [620, 10]]) {
    const a = applyH(H, x, y), b = applyH(Htrue, x, y);
    near(a[0], b[0], 1e-7);
    near(a[1], b[1], 1e-7);
  }
});

test('逆行列で往復すると元に戻る', () => {
  const H = [1.2, 0.3, -40, -0.2, 0.9, 12, 0.0004, -0.0007, 1];
  const I = mul3(H, invert3(H));
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => near(I[i], v, 1e-9));
});

test('合成カメラ: 画像上の点をマット上のメートルに正しく換算できる（横から・後方から）', () => {
  for (const preset of ['side', 'behind']) {
    const cam = presetCamera(preset, 1280, 720);
    const plane = [[0, 0], [0.3, 0], [0.3, 1.5], [0, 1.5]];
    const img = plane.map(([x, y]) => { const p = cam.project([x, y, 0]); return [p.u, p.v]; });
    const cal = buildCalibration({ points: img, widthM: 0.3, lengthM: 1.5, cameraHeightM: cam.pos[2], ballRadiusM: 0.021335 });
    for (const [x, y] of [[0.15, 0.1], [0.05, 0.75], [0.28, 1.4], [0.15, 1.0]]) {
      const p = cam.project([x, y, 0]);
      const [X, Y] = applyH(cal.img2plane, p.u, p.v);
      near(X, x, 1e-7, preset);
      near(Y, y, 1e-7, preset);
    }
  }
});

test('ボール中心の高さ補正: 面から浮いた点どうしの距離は h/(h-r) 倍に見え、補正で実距離に戻る', () => {
  const r = 0.021335;
  for (const preset of ['side', 'behind']) {
    const cam = presetCamera(preset, 1280, 720);
    const plane = [[0, 0], [0.3, 0], [0.3, 1.5], [0, 1.5]];
    const img = plane.map(([x, y]) => { const p = cam.project([x, y, 0]); return [p.u, p.v]; });
    const H = computeHomography(img, plane);
    const A = [0.15, 0.2], B = [0.17, 1.3];
    const a = cam.project([A[0], A[1], r]), b = cam.project([B[0], B[1], r]);
    const pa = applyH(H, a.u, a.v), pb = applyH(H, b.u, b.v);
    const apparent = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    const real = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const h = cam.pos[2];
    near(apparent / real, h / (h - r), 1e-6, `${preset} 見かけの倍率`);
    near(apparent * heightScale(h, r), real, 1e-6, `${preset} 補正後`);
  }
});

test('高さ補正係数の値（カメラ高さ1.0mで約2.1%）', () => {
  near(heightScale(1.0, 0.021335), 0.978665, 1e-9);
  assert.throws(() => heightScale(0.03, 0.021335));
});

test('6点校正: タップ誤差があっても解け、残差が報告される', () => {
  const cam = presetCamera('side', 1280, 720);
  const plane = [[0, 0], [0.3, 0], [0.3, 1.5], [0, 1.5], [0, 0.75], [0.3, 0.75]];
  const exact = plane.map(([x, y]) => { const p = cam.project([x, y, 0]); return [p.u, p.v]; });
  const calExact = buildCalibration({ points: exact, widthM: 0.3, lengthM: 1.5, cameraHeightM: 1.1, ballRadiusM: 0.021335 });
  assert.ok(calExact.residual.rms < 1e-8, '誤差なしなら残差はほぼ0');
  const offs = [[2, -1], [-2, 1], [1, 2], [-1, -2], [2, 2], [-2, -1]];
  const noisy = exact.map(([u, v], i) => [u + offs[i][0], v + offs[i][1]]);
  const cal = buildCalibration({ points: noisy, widthM: 0.3, lengthM: 1.5, cameraHeightM: 1.1, ballRadiusM: 0.021335 });
  assert.ok(cal.residual.rms > 1e-4 && cal.residual.rms < 0.01, `残差が見える: ${cal.residual.rms}`);
});

test('レンズ歪みがある場合、6点校正の残差として検出できる', () => {
  // 樽型歪み（k1=-0.08）を加えた画像点で校正する
  const cam = presetCamera('side', 1280, 720);
  const distort = ([u, v]) => {
    const x = (u - 640) / 640, y = (v - 360) / 640;
    const k = 1 - 0.08 * (x * x + y * y);
    return [640 + x * k * 640, 360 + y * k * 640];
  };
  const plane = [[0, 0], [0.3, 0], [0.3, 1.5], [0, 1.5], [0, 0.75], [0.3, 0.75]];
  const pts = plane.map(([x, y]) => { const p = cam.project([x, y, 0]); return distort([p.u, p.v]); });
  const cal = buildCalibration({ points: pts, widthM: 0.3, lengthM: 1.5, cameraHeightM: 1.1, ballRadiusM: 0.021335 });
  assert.ok(cal.residual.max > 0.001, `歪みが残差に現れる: max=${cal.residual.max}`);
});

test('不正な基準点（交差・一直線）はエラーにする', () => {
  assert.equal(isConvexQuad([[0, 0], [1, 0], [1, 1], [0, 1]]), true);
  assert.equal(isConvexQuad([[0, 0], [1, 1], [1, 0], [0, 1]]), false);
  assert.throws(() => buildCalibration({ points: [[0, 0], [1, 1], [1, 0], [0, 1]], widthM: 0.3, lengthM: 1.5, cameraHeightM: 1, ballRadiusM: 0.021 }));
  assert.throws(() => computeHomography([[0, 0], [1, 1], [2, 2], [3, 3]], [[0, 0], [1, 0], [1, 1], [0, 1]]));
});

test('その位置で期待されるボールの見かけの直径', () => {
  const cam = makeCamera({ pos: [0.15, 0.75, 2.0], lookAt: [0.15, 0.7501, 0], f: 1000, width: 1280, height: 720 });
  // 真上 2.0m から見ると、面上の 42.67mm は 1000*0.04267/2.0 = 21.3px
  const d = expectedBallDiameterPx(cam.plane2img, 0.15, 0.75, 0.04267);
  near(d, 21.335, 0.05);
});

test('カメラ位置の推定: ホモグラフィだけからカメラの真下の点・高さ・焦点距離を復元できる', async () => {
  const { estimateCameraPose } = await import('../js/core/homography.js');
  const cams = [
    presetCamera('side', 1280, 720),
    presetCamera('behind', 1280, 720),
    presetCamera('behind', 720, 1280),
    makeCamera({ pos: [-1.2, 0.3, 1.6], lookAt: [0.15, 0.9, 0], f: 900, width: 1280, height: 720 }),
  ];
  for (const cam of cams) {
    const pose = estimateCameraPose(cam.plane2img, cam.width, cam.height);
    assert.ok(pose, '推定できる');
    near(pose.x, cam.pos[0], 1e-6, 'x');
    near(pose.y, cam.pos[1], 1e-6, 'y');
    near(pose.height, cam.pos[2], 1e-6, 'height');
    near(pose.f, cam.f, 1e-4, 'f');
  }
});

test('カメラ位置の推定: 左右の目印を逆に登録（鏡像）しても、高さは正の値で求まる', async () => {
  const { estimateCameraPose } = await import('../js/core/homography.js');
  const cam = presetCamera('side', 1280, 720);
  // 実寸座標の x を反転させた座標系で校正した場合
  const plane = [[0, 0], [0.3, 0], [0.3, 1.5], [0, 1.5]];
  const img = plane.map(([x, y]) => { const p = cam.project([0.3 - x, y, 0]); return [p.u, p.v]; });
  const cal = buildCalibration({ points: img, widthM: 0.3, lengthM: 1.5, cameraHeightM: cam.pos[2], ballRadiusM: 0.021335, imageW: 1280, imageH: 720 });
  near(cal.pose.height, cam.pos[2], 1e-6);
  near(cal.pose.x, 0.3 - cam.pos[0], 1e-6);
  assert.ok(cal.nadir);
});

test('位置の補正: 面から浮いたボール中心の見かけの位置を、実際の位置に戻せる', () => {
  const r = 0.021335;
  for (const preset of ['side', 'behind']) {
    const cam = presetCamera(preset, 1280, 720);
    const plane = [[0, 0], [0.3, 0], [0.3, 1.5], [0, 1.5]];
    const img = plane.map(([x, y]) => { const p = cam.project([x, y, 0]); return [p.u, p.v]; });
    const cal = buildCalibration({ points: img, widthM: 0.3, lengthM: 1.5, cameraHeightM: cam.pos[2], ballRadiusM: r, imageW: 1280, imageH: 720 });
    assert.equal(cal.kDist, 1);
    for (const [x, y] of [[0.15, 0.0], [0.1, 0.8], [0.2, 1.5]]) {
      const q = cam.project([x, y, r]);
      const [Xa, Ya] = applyH(cal.img2plane, q.u, q.v);
      const [X, Y] = cal.toBall(Xa, Ya);
      near(X, x, 1e-6, preset);
      near(Y, y, 1e-6, preset);
      assert.ok(Math.hypot(Xa - x, Ya - y) > 0.003, '補正前は数mm以上ずれている');
    }
  }
});

test('入力したカメラ高さと推定値が大きく違う場合、位置補正は使わず距離補正に切り替える', () => {
  const cam = presetCamera('side', 1280, 720);
  const plane = [[0, 0], [0.3, 0], [0.3, 1.5], [0, 1.5]];
  const img = plane.map(([x, y]) => { const p = cam.project([x, y, 0]); return [p.u, p.v]; });
  const cal = buildCalibration({ points: img, widthM: 0.3, lengthM: 1.5, cameraHeightM: 2.5, ballRadiusM: 0.021335, imageW: 1280, imageH: 720 });
  assert.equal(cal.nadir, null);
  assert.ok(cal.kDist < 1);
  assert.ok(Math.abs(cal.pose.height - 1.1) < 1e-6, '推定値そのものは返す（画面に表示して食い違いを知らせるため）');
});
