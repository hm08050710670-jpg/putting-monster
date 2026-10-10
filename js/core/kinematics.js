// 位置と時刻の列から、速度と減速度を最小二乗で推定する。
//
// 物理モデルと仮定:
//  - 平坦な面を直進するボールは、短い区間では一定の減速度 a で減速するとみなす:
//        s(t) = s0 + v0*t - (1/2)*a*t^2      （a > 0 が減速）
//    実際の芝・マットでは減速度が速度にわずかに依存するが、1.5〜2m の観測区間では
//    一定とみなす近似を使う（この近似の妥当性は実測で検証する項目）。
//  - 打ち出し直後、ボールは滑りながら回転を得る（スキッド）。この間の減速度は
//    純転がりより数倍大きい。fitTwoPhase は「途中で減速度が変わる」モデルを当てはめ、
//    切り替わり点を探す。
//  - 時刻はフレームごとの実測タイムスタンプを使う。フレーム間隔が一定である必要はない
//    （フレーム欠落があっても、時刻が正しければ推定は偏らない）。

import { solveLinear } from './homography.js';

/**
 * 線形最小二乗。X は n×p（行の配列）、y は長さ n。
 * @returns {{beta:number[], rss:number, cov:number[][]|null, n:number, p:number}}
 */
export function lsq(X, y) {
  const n = X.length;
  const p = X[0].length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const r = X[i];
    for (let a = 0; a < p; a++) {
      Xty[a] += r[a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += r[a] * r[b];
    }
  }
  const beta = solveLinear(XtX, Xty);
  let rss = 0;
  for (let i = 0; i < n; i++) {
    let f = 0;
    for (let a = 0; a < p; a++) f += X[i][a] * beta[a];
    rss += (y[i] - f) ** 2;
  }
  let cov = null;
  if (n > p) {
    const s2 = rss / (n - p);
    cov = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let c = 0; c < p; c++) {
      const e = new Array(p).fill(0);
      e[c] = 1;
      const col = solveLinear(XtX, e);
      for (let r = 0; r < p; r++) cov[r][c] = col[r] * s2;
    }
  }
  return { beta, rss, cov, n, p };
}

/** 点列に直線を当てはめる（主成分）。進行方向の単位ベクトルと、直線からの横ずれRMSを返す。 */
export function fitLinePCA(pts) {
  const n = pts.length;
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= n; cy /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) {
    sxx += (x - cx) ** 2; sxy += (x - cx) * (y - cy); syy += (y - cy) ** 2;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let dx = Math.cos(theta), dy = Math.sin(theta);
  // 最初の点から最後の点へ向かう向きに揃える
  const [x0, y0] = pts[0];
  const [x1, y1] = pts[n - 1];
  if ((x1 - x0) * dx + (y1 - y0) * dy < 0) { dx = -dx; dy = -dy; }
  let lat = 0;
  for (const [x, y] of pts) lat += (-(x - cx) * dy + (y - cy) * dx) ** 2;
  return { cx, cy, dx, dy, lateralRms: Math.sqrt(lat / n) };
}

/**
 * 一定減速モデルの当てはめ。t は秒、s は m。
 * @param {number[]} t
 * @param {number[]} s
 * @param {number} [t0] 時刻の原点（省略時は t[0]）。v0 はこの時刻での速度になる
 * @returns {{s0,v0,a,rms,seV0,seA,cov,n, predict:(tau:number)=>number, speedAt:(tau:number)=>number, speedSEAt:(tau:number)=>number}}
 */
export function fitQuadratic(t, s, t0 = t[0]) {
  const X = t.map((ti) => { const tau = ti - t0; return [1, tau, -0.5 * tau * tau]; });
  const f = lsq(X, s);
  const [s0, v0, a] = f.beta;
  const cov = f.cov;
  return {
    s0, v0, a,
    k: 3,
    rss: f.rss,
    rms: Math.sqrt(f.rss / f.n),
    n: f.n,
    cov,
    seV0: cov ? Math.sqrt(Math.max(0, cov[1][1])) : NaN,
    seA: cov ? Math.sqrt(Math.max(0, cov[2][2])) : NaN,
    predict: (tau) => s0 + v0 * tau - 0.5 * a * tau * tau,
    speedAt: (tau) => v0 - a * tau,
    speedSEAt: (tau) => (cov ? Math.sqrt(Math.max(0, cov[1][1] + tau * tau * cov[2][2] - 2 * tau * cov[1][2])) : NaN),
  };
}

/**
 * 2区間モデル（スキッド -> 転がり）。時刻 tc で減速度が a1 から a2 に変わる。
 * 位置と速度は tc で連続とする。
 *   tau <= tc: s = s0 + v0*tau - a1*tau^2/2
 *   tau >  tc: s = s0 + v0*tau - a1*(tc*tau - tc^2/2) - a2*(tau-tc)^2/2
 * tc を各サンプル時刻で総当たりし、残差が最小のものを選ぶ。
 * @param {number} [minFirst]  前半（スキッド）に必要な点数
 * @param {number} [minSecond] 後半（転がり）に必要な点数
 * @param {number} [t0]        時刻の原点（省略時は t[0]）
 * @returns {null | {tc, s0, v0, a1, a2, vc, sc, rss, rms, n, nFirst, predict, speedAt}}
 */
export function fitTwoPhase(t, s, minFirst = 5, minSecond = 6, t0 = t[0]) {
  const n = t.length;
  if (n < minFirst + minSecond + 1) return null;
  const tau = t.map((ti) => ti - t0);
  let best = null;
  for (let k = minFirst; k <= n - minSecond - 1; k++) {
    const tc = tau[k];
    const X = tau.map((u) =>
      u <= tc
        ? [1, u, -0.5 * u * u, 0]
        : [1, u, -(tc * u - 0.5 * tc * tc), -0.5 * (u - tc) ** 2]
    );
    let f;
    try { f = lsq(X, s); } catch { continue; }
    if (!best || f.rss < best.rss) {
      const [s0, v0, a1, a2] = f.beta;
      best = { tc, s0, v0, a1, a2, rss: f.rss, nFirst: k + 1 };
    }
  }
  if (!best) return null;
  const { tc, s0, v0, a1, a2 } = best;
  const vc = v0 - a1 * tc;
  const sc = s0 + v0 * tc - 0.5 * a1 * tc * tc;
  return {
    ...best,
    k: 5,
    vc, sc, n,
    rms: Math.sqrt(best.rss / n),
    predict: (u) => (u <= tc ? s0 + v0 * u - 0.5 * a1 * u * u : sc + vc * (u - tc) - 0.5 * a2 * (u - tc) ** 2),
    speedAt: (u) => (u <= tc ? v0 - a1 * u : vc - a2 * (u - tc)),
  };
}

/**
 * 外れ値に強い当てはめ。
 *
 * カメラ映像では、ときどき 1 フレームだけ時刻が数 ms ずれることがある
 * （処理の遅れで、時刻情報と実際の画像が 1 回ぶん食い違う等）。
 * 速度 2 m/s なら 5ms のずれは位置 1cm の誤差に相当し、そのまま当てはめると
 * 速度や「滑りの検出」を誤る。そこで、残差が突出した点を取り除いて当てはめ直す。
 *
 *  1. 全点で当てはめる
 *  2. 残差の中央絶対偏差（MAD）からばらつき σ を見積もる
 *  3. |残差| > max(k·σ, minThr) の点を外して当てはめ直す（変化がなくなるまで）
 *  4. 外す点が maxFrac を超える場合は、それ以上は外さない（データ全体が悪い）
 *
 * @param {(t:number[], s:number[]) => object|null} fitFn  predict(tau) を持つ当てはめ結果を返す関数（時刻の原点は固定すること）
 * @param {number[]} t
 * @param {number[]} s
 * @param {number} t0   predict に渡す tau の原点
 * @param {{k:number, minThrM:number, maxFrac:number, maxIter:number}} o
 * @returns {null | {fit:object, keep:boolean[], capped:boolean, nOut:number, rmsIn:number, rssIn:number, nIn:number}}
 */
export function robustFit(fitFn, t, s, t0, o) {
  const n = t.length;
  let keep = new Array(n).fill(true);
  let fit = null;
  let capped = false;
  for (let iter = 0; iter <= o.maxIter; iter++) {
    const ti = t.filter((_, i) => keep[i]);
    const si = s.filter((_, i) => keep[i]);
    let f;
    try { f = fitFn(ti, si); } catch { f = null; }
    if (!f) break;
    fit = f;
    if (iter === o.maxIter) break;
    const r = t.map((x, i) => Math.abs(s[i] - f.predict(x - t0)));
    const sigma = 1.4826 * median(r.filter((_, i) => keep[i]));
    const thr = Math.max(o.k * sigma, o.minThrM);
    const next = r.map((x) => x <= thr);
    // 取り除く点が多すぎる = データ全体がこのモデルに合っていない。これ以上は外さない。
    if (next.filter(Boolean).length < n * (1 - o.maxFrac)) { capped = true; break; }
    if (next.every((v, i) => v === keep[i])) break;
    keep = next;
  }
  if (!fit) return null;
  let rss = 0, nIn = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    rss += (s[i] - fit.predict(t[i] - t0)) ** 2;
    nIn++;
  }
  return { fit, keep, capped, nOut: n - nIn, nIn, rssIn: rss, rmsIn: Math.sqrt(rss / Math.max(1, nIn)) };
}

/** BIC（小さいほど良い）。残差が 0 に近いときの発散を避けるため下限を置く。 */
export function bic(rss, n, k) {
  const floor = n * 1e-5 ** 2; // 位置誤差 10μm 相当
  return n * Math.log(Math.max(rss, floor) / n) + k * Math.log(n);
}

export function median(arr) {
  if (!arr.length) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
