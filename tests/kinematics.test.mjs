// 時刻差からの速度計算・フレーム欠落時の処理のテスト（数値のみ。画像は使わない）
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitQuadratic, fitTwoPhase, fitLinePCA, lsq, bic, median } from '../js/core/kinematics.js';
import { makePutt, makeRng } from '../js/core/simscene.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a} (tol ${tol})`);

function series({ v0, a, fps = 60, n = 40, drop = [], jitter = 0, noise = 0, seed = 3 }) {
  const rng = makeRng(seed);
  const t = [], s = [];
  for (let i = 0; i < n; i++) {
    if (drop.includes(i)) continue;
    const ti = i / fps + (rng() * 2 - 1) * jitter;
    t.push(ti);
    s.push(v0 * ti - 0.5 * a * ti * ti + (rng() * 2 - 1) * noise);
  }
  return { t, s };
}

test('等速: 速度が正しく、減速は 0', () => {
  const { t, s } = series({ v0: 2.0, a: 0 });
  const q = fitQuadratic(t, s);
  near(q.v0, 2.0, 1e-9);
  near(q.a, 0, 1e-9);
});

test('一定減速: 初速・減速度を復元できる', () => {
  const { t, s } = series({ v0: 2.4, a: 0.6 });
  const q = fitQuadratic(t, s);
  near(q.v0, 2.4, 1e-9);
  near(q.a, 0.6, 1e-8);
  near(q.speedAt(0.5), 2.4 - 0.3, 1e-9);
});

test('フレーム欠落: 欠けたフレームがあっても、時刻が正しければ速度は変わらない', () => {
  const { t, s } = series({ v0: 2.4, a: 0.6, drop: [3, 4, 5, 11, 20, 21, 30] });
  assert.equal(t.length, 33);
  const q = fitQuadratic(t, s);
  near(q.v0, 2.4, 1e-9);
  near(q.a, 0.6, 1e-8);
});

test('不等間隔フレーム: 撮影間隔がゆらいでも、実時刻を使えば正しい', () => {
  const { t, s } = series({ v0: 1.7, a: 0.5, jitter: 0.004 });
  const q = fitQuadratic(t, s);
  // v0 は「最初のサンプル時刻 t[0]」での速度。ゆらぎで t[0] は 0 からずれるので、その時刻の真値と比べる
  near(q.v0, 1.7 - 0.5 * t[0], 1e-9);
  near(q.a, 0.5, 1e-8);
});

test('時刻の基準（オフセット）に依存しない', () => {
  const { t, s } = series({ v0: 2.0, a: 0.5 });
  const q1 = fitQuadratic(t, s);
  const q2 = fitQuadratic(t.map((x) => x + 12345.678), s);
  near(q1.v0, q2.v0, 1e-7);
  near(q1.a, q2.a, 1e-6);
});

test('位置ノイズ±1mm・60fps・0.6秒: 速度誤差は1%未満、推定誤差(SE)も妥当', () => {
  let worst = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const { t, s } = series({ v0: 2.5, a: 0.55, n: 36, noise: 0.001, seed });
    const q = fitQuadratic(t, s);
    worst = Math.max(worst, Math.abs(q.v0 - 2.5) / 2.5);
    assert.ok(q.seV0 > 0 && q.seV0 < 0.02);
  }
  assert.ok(worst < 0.01, `worst=${worst}`);
});

test('30fps でも速度は求まる（点数が減るぶん誤差は増える）', () => {
  const { t, s } = series({ v0: 2.5, a: 0.55, fps: 30, n: 18, noise: 0.001 });
  const q = fitQuadratic(t, s);
  near(q.v0, 2.5, 0.03);
});

test('2区間モデル: スキッド -> 転がりの切り替わりを見つける', () => {
  const putt = makePutt({ v0: 3.0, start: [0.15, 0], muK: 0.4, aRoll: 0.55, t0: 0 });
  const rng = makeRng(5);
  const t = [], s = [];
  for (let i = 1; i < 36; i++) { const ti = i / 60; t.push(ti); s.push(putt.at(ti).s + (rng() * 2 - 1) * 0.0005); }
  const two = fitTwoPhase(t, s, 5, 6);
  const q = fitQuadratic(t, s);
  assert.ok(two, '2区間モデルが返る');
  near(two.tc + t[0], putt.skidTime, 0.03, '切り替わり時刻');
  near(two.vc, putt.vRoll, 0.03, '転がり開始速度');
  near(two.a1, putt.aSkid, 0.4, 'スキッド中の減速');
  assert.ok(bic(q.rss, q.n, 3) - bic(two.rss, two.n, 5) > 10, '1区間より明確に良い');
});

test('2区間モデル: 純転がりだけのデータでは、明確な改善にならない', () => {
  let falseHits = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const { t, s } = series({ v0: 2.2, a: 0.55, n: 40, noise: 0.001, seed });
    const q = fitQuadratic(t, s);
    const two = fitTwoPhase(t, s, 5, 6);
    const gain = bic(q.rss, q.n, 3) - bic(two.rss, two.n, 5);
    if (gain >= 10 && two.a1 - two.a2 >= 1.0 && two.a1 >= 1.5) falseHits++;
  }
  assert.ok(falseHits <= 1, `誤検出 ${falseHits}/40`);
});

test('直線当てはめ: 進行方向と横ずれ', () => {
  const pts = [];
  for (let i = 0; i < 20; i++) pts.push([0.15 + 0.02 * i * 0.05, 0.05 * i]);
  const l = fitLinePCA(pts);
  near(Math.atan2(l.dx, l.dy), Math.atan2(0.02, 1), 1e-9);
  near(l.lateralRms, 0, 1e-9);
  const bent = pts.map(([x, y], i) => [x + (i % 2 ? 0.01 : -0.01), y]);
  assert.ok(fitLinePCA(bent).lateralRms > 0.009);
});

test('補助関数', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const f = lsq([[1, 0], [1, 1], [1, 2]], [1, 3, 5]);
  near(f.beta[0], 1, 1e-12);
  near(f.beta[1], 2, 1e-12);
});
