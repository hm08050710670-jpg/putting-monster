// 遠近補正（ホモグラフィ）: 画像上のピクセル座標 <-> マット面上の実寸座標(m)
//
// 前提と仮定:
//  - カメラはピンホールカメラとして近似する（レンズ歪みは補正しない）。
//    Safari からはレンズの内部パラメータを取得できないため。
//    歪みの影響は「6点校正の残差」で見える化する（reprojectionErrors）。
//  - 基準点はすべてマット面（同一平面）上にあるとする。
//
// 行列は長さ9の配列（行優先）で表す: [h11,h12,h13, h21,h22,h23, h31,h32,h33]

/** 連立一次方程式 A x = b を部分ピボット付きガウス消去で解く。A は n×n（行の配列）。 */
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('singular');
    if (p !== c) [M[p], M[c]] = [M[c], M[p]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

export function mul3(A, B) {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
}

export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) throw new Error('singular');
  const s = 1 / det;
  return [
    A * s, (c * h - b * i) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, (c * d - a * f) * s,
    C * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
}

/** 点 (x, y) をホモグラフィ H で写す。 */
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

// Hartley 正規化: 重心を原点、平均距離を sqrt(2) にする（数値的に安定させるため）
function normalization(pts) {
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= pts.length; cy /= pts.length;
  let d = 0;
  for (const [x, y] of pts) d += Math.hypot(x - cx, y - cy);
  d /= pts.length;
  if (d < 1e-12) throw new Error('degenerate');
  const s = Math.SQRT2 / d;
  return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
}

/**
 * src[i] -> dst[i] を満たすホモグラフィを求める（4点以上、最小二乗）。
 * 4点なら厳密解、5点以上なら誤差を最小にする解になる。
 * @param {number[][]} src [[x,y],...]
 * @param {number[][]} dst [[X,Y],...]
 * @returns {number[]} 3x3 行列（行優先）
 */
export function computeHomography(src, dst) {
  if (src.length !== dst.length || src.length < 4) throw new Error('need >= 4 point pairs');
  const Ts = normalization(src);
  const Td = normalization(dst);
  const s = src.map(([x, y]) => applyH(Ts, x, y));
  const d = dst.map(([x, y]) => applyH(Td, x, y));
  // h33 = 1 と置いた 8 未知数の線形最小二乗（正規方程式）
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const add = (row, rhs) => {
    for (let i = 0; i < 8; i++) {
      if (row[i] === 0) continue;
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let k = 0; k < s.length; k++) {
    const [x, y] = s[k];
    const [X, Y] = d[k];
    add([x, y, 1, 0, 0, 0, -X * x, -X * y], X);
    add([0, 0, 0, x, y, 1, -Y * x, -Y * y], Y);
  }
  const h = solveLinear(AtA, Atb);
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const H = mul3(invert3(Td), mul3(Hn, Ts));
  const k = H[8];
  return H.map((v) => v / k);
}

/** 校正点を H で写したときの実寸上の誤差（m）。 */
export function reprojectionErrors(H, src, dst) {
  const each = src.map(([x, y], i) => {
    const [X, Y] = applyH(H, x, y);
    return Math.hypot(X - dst[i][0], Y - dst[i][1]);
  });
  const rms = Math.sqrt(each.reduce((a, e) => a + e * e, 0) / each.length);
  return { each, rms, max: Math.max(...each) };
}

/** 4点が（自己交差のない）凸四角形を成すか。順番は周回順。 */
export function isConvexQuad(p) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = p[i];
    const [bx, by] = p[(i + 1) % 4];
    const [cx, cy] = p[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * ボール中心の高さによる誤差の補正係数。
 *
 * 校正はマット面（高さ0）で行うが、画像に写るボールの中心は高さ r（半径）にある。
 * 高さ h のカメラから見ると、高さ r の点はマット面上では
 *   P' = N + (P - N) * h / (h - r)   （N はカメラ真下の点）
 * の位置に見える。これは N を中心とする倍率 h/(h-r) の相似拡大なので、
 * カメラの向きや N の位置に関係なく、距離と速度は一律に h/(h-r) 倍に見える。
 * したがって「見かけの距離・速度」に (h - r)/h を掛ければ補正できる。
 *
 * 例: カメラ高さ 1.0m, r=21.3mm -> 0.9787（約2.1%の補正）
 */
export function heightScale(cameraHeightM, ballRadiusM) {
  if (!(cameraHeightM > ballRadiusM * 2)) throw new Error('camera height too low');
  return (cameraHeightM - ballRadiusM) / cameraHeightM;
}

/**
 * ホモグラフィ（マット面 -> 画像）から、カメラの位置と焦点距離を推定する。
 *
 * 仮定: 画素は正方形、光軸は画像の中心を通る（スマートフォンの通常の映像ではほぼ成り立つ）。
 * このとき H = K [r1 r2 t]（r1, r2 は直交する単位ベクトル）と書けるので、
 *   r1・r2 = 0,  |r1| = |r2|
 * の2条件から焦点距離 f が決まり、続いてカメラ位置 C = -R^T t が求まる。
 * カメラが面を真上から見ている場合などは f が決まらない（null を返す）。
 *
 * @returns {null | {f:number, x:number, y:number, height:number}}
 *   x, y = カメラ真下の点（マット面上の実寸座標）、height = マット面からの高さ
 */
export function estimateCameraPose(plane2img, imageW, imageH) {
  const cx = imageW / 2, cy = imageH / 2;
  const H = plane2img;
  // 画像中心を原点にした列ベクトル
  const col = (j) => [H[j] - cx * H[6 + j], H[3 + j] - cy * H[6 + j], H[6 + j]];
  const h1 = col(0), h2 = col(1), h3 = col(2);
  const a1 = h1[0] * h2[0] + h1[1] * h2[1], b1 = -h1[2] * h2[2];
  const a2 = h1[0] ** 2 + h1[1] ** 2 - h2[0] ** 2 - h2[1] ** 2, b2 = h2[2] ** 2 - h1[2] ** 2;
  // 2式を、係数の大きさをそろえたうえで最小二乗的に解く（x = 1/f^2）
  const n1 = Math.hypot(h1[0], h1[1]) * Math.hypot(h2[0], h2[1]) || 1;
  const n2 = h1[0] ** 2 + h1[1] ** 2 + h2[0] ** 2 + h2[1] ** 2 || 1;
  const A1 = a1 / n1, B1 = b1 / n1, A2 = a2 / n2, B2 = b2 / n2;
  const den = A1 * A1 + A2 * A2;
  if (den < 1e-12) return null;
  const x = (A1 * B1 + A2 * B2) / den;
  if (!(x > 0) || !isFinite(x)) return null;
  const f = 1 / Math.sqrt(x);
  if (!(f > 0.2 * Math.max(imageW, imageH) && f < 20 * Math.max(imageW, imageH))) return null;
  const k = (h) => [h[0] / f, h[1] / f, h[2]];
  let r1 = k(h1), r2 = k(h2), t = k(h3);
  const len = (v) => Math.hypot(v[0], v[1], v[2]);
  let lam = 2 / (len(r1) + len(r2));
  if (t[2] * lam < 0) lam = -lam; // 面がカメラの前方にあるように符号を決める
  r1 = r1.map((v) => v * lam); r2 = r2.map((v) => v * lam); t = t.map((v) => v * lam);
  // 直交化
  const l1 = len(r1); r1 = r1.map((v) => v / l1);
  const d = r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2];
  r2 = r2.map((v, i) => v - d * r1[i]);
  const l2 = len(r2); r2 = r2.map((v) => v / l2);
  const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const pos = { x: -dot(r1, t), y: -dot(r2, t), height: Math.abs(dot(r3, t)), f };
  if (!isFinite(pos.x) || !isFinite(pos.y) || !(pos.height > 0)) return null;
  return pos;
}

/**
 * 校正データから計算用オブジェクトを作る。
 * 実寸座標系: x = 横方向（左の目印が 0、右が W）、y = 打ち出し方向（スタート 0、ゴール L）
 *
 * @param {object} cal { points:[[u,v]...] (映像px), widthM, lengthM, cameraHeightM, ballRadiusM, imageW, imageH }
 *   points の順番: 0=スタート左, 1=スタート右, 2=ゴール右, 3=ゴール左, (4=中間左, 5=中間右)
 */
export function buildCalibration(cal) {
  const { points, widthM: W, lengthM: L } = cal;
  if (!points || (points.length !== 4 && points.length !== 6)) throw new Error('基準点は4点または6点が必要です');
  const dst = [[0, 0], [W, 0], [W, L], [0, L]];
  if (points.length === 6) dst.push([0, L / 2], [W, L / 2]);
  if (!isConvexQuad(points.slice(0, 4))) throw new Error('基準点の並びが正しくありません（四隅が交差しています）');
  let img2plane, plane2img;
  try {
    img2plane = computeHomography(points, dst);
    plane2img = invert3(img2plane);
  } catch {
    throw new Error('基準点の配置から換算式を求められません（点が一直線に並んでいる等）');
  }
  const err = reprojectionErrors(img2plane, points, dst);
  // 観測区間の中心線上で、進行方向 1m が画像上で何pxになるか（分解能の目安）
  const pxPerM = (y) => {
    const a = applyH(plane2img, W / 2, y - 0.05);
    const b = applyH(plane2img, W / 2, y + 0.05);
    return Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.1;
  };
  const kHeight = heightScale(cal.cameraHeightM, cal.ballRadiusM);
  // カメラ真下の点が分かれば、ボール中心の「見かけの位置」を「実際の位置」に直せる（位置そのものの補正）。
  // 分からない場合は、距離・速度だけを kHeight 倍する（位置には最大で数cmのずれが残る）。
  const pose = cal.imageW && cal.imageH ? estimateCameraPose(plane2img, cal.imageW, cal.imageH) : null;
  // 入力されたカメラ高さと推定値が大きく食い違う場合は、推定を信用しない
  const poseOk = !!pose && Math.abs(pose.height - cal.cameraHeightM) / cal.cameraHeightM < 0.35;
  const nadir = poseOk ? [pose.x, pose.y] : null;
  return {
    img2plane,
    plane2img,
    widthM: W,
    lengthM: L,
    kHeight,
    pose,
    nadir,
    /** 見かけの位置（ボール中心を面に投影した点）-> 実際のボール位置 */
    toBall: nadir
      ? (X, Y) => [nadir[0] + (X - nadir[0]) * kHeight, nadir[1] + (Y - nadir[1]) * kHeight]
      : (X, Y) => [X, Y],
    /** 距離・速度に掛ける係数（位置を補正済みなら 1） */
    kDist: nadir ? 1 : kHeight,
    residual: err,
    pxPerMStart: pxPerM(0.05),
    pxPerMEnd: pxPerM(L - 0.05),
  };
}

/** マット面上の点 P 付近で、ボール直径が画像上で約何pxに見えるか。 */
export function expectedBallDiameterPx(plane2img, X, Y, diameterM) {
  const r = diameterM / 2;
  const a = applyH(plane2img, X - r, Y);
  const b = applyH(plane2img, X + r, Y);
  const c = applyH(plane2img, X, Y - r);
  const d = applyH(plane2img, X, Y + r);
  // 球はほぼ円に写る。面の傾きで縮んで見える方向があるため、大きい方を採用する。
  return Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(d[0] - c[0], d[1] - c[1]));
}
