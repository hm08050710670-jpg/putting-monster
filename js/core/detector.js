// ボール候補の検出（画像処理）。DOM に依存しないので Node でもテストできる。
//
// 方針: 白色判定だけでは白い床や反射を拾うため、次を組み合わせる。
//   1. 明るさ      : 輝度が brightMin 以上
//   2. 無彩色       : max(R,G,B)-min(R,G,B) が satMax 以下（緑のマットや肌色を除外）
//   3. 動き         : 背景より diffMin 以上「明るくなった」画素のみ
//                     （暗くなる変化＝影や暗いパターヘッドは除外される）
//   4. 形と大きさ   : 連結成分の短軸・長軸・面積が、その位置で期待されるボールの大きさに合う
//   5. 移動の連続性 : tracker.js で判定
//   6. 測定範囲     : zoneMask の内側だけを見る

/**
 * 候補画素マスクを作る。同時に背景を更新する。
 * @param {Uint8ClampedArray} rgba   ROI の RGBA 画素（w*h*4）
 * @param {number} w
 * @param {number} h
 * @param {Float32Array|null} bg     背景の輝度（null なら「動き」条件を使わない＝静止ボール検出用）
 * @param {Uint8Array|null} zoneMask 1 の画素だけ処理する
 * @param {object} p   { brightMin, satMax, diffMin, bgAlpha, bgAlphaMasked }（bgAlpha=0 で背景固定）
 * @param {Uint8Array} mask    出力: 候補画素=1
 * @param {Uint8Array} weight  出力: 重み（重心計算用）
 * @returns {number} 候補画素の数
 */
export function buildMask(rgba, w, h, bg, zoneMask, p, mask, weight) {
  const n = w * h;
  const { brightMin, satMax, diffMin } = p;
  const aN = p.bgAlpha || 0;
  const aM = p.bgAlphaMasked || 0;
  let count = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (zoneMask && !zoneMask[i]) { mask[i] = 0; continue; }
    const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
    const y = (77 * r + 150 * g + 29 * b) >> 8;
    let m = 0;
    if (y >= brightMin) {
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (mx - mn <= satMax) {
        if (bg) {
          const d = y - bg[i];
          if (d >= diffMin) { m = 1; weight[i] = d > 255 ? 255 : d; }
        } else {
          m = 1; weight[i] = y - brightMin + 1;
        }
      }
    }
    mask[i] = m;
    if (m) count++;
    if (bg) {
      const a = m ? aM : aN;
      if (a) bg[i] += (y - bg[i]) * a;
    }
  }
  return count;
}

/** ROI の輝度を計算する（背景取得用）。 */
export function lumaOf(rgba, w, h, out) {
  const n = w * h;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2]) >> 8;
  }
  return out;
}

/**
 * マスクの連結成分（8近傍）を取り出し、重心と形状を計算する。
 * mask は破壊される（処理済み画素を 0 にする）。
 * @returns {Array<{cx,cy,area,major,minor,angle,fill,x0,y0,x1,y1}>}  座標は ROI 内の画素単位（画素中心 = 整数+0.5）
 */
export function findBlobs(mask, weight, w, h, minArea, stack) {
  const blobs = [];
  const n = w * h;
  if (!stack || stack.length < n) stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (!mask[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    mask[start] = 0;
    let area = 0, sw = 0, swx = 0, swy = 0;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % w;
      const y = (idx - x) / w;
      const wt = weight[idx];
      area++;
      sw += wt; swx += wt * x; swy += wt * y;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const xa = x > 0 ? x - 1 : x, xb = x < w - 1 ? x + 1 : x;
      const ya = y > 0 ? y - 1 : y, yb = y < h - 1 ? y + 1 : y;
      for (let yy = ya; yy <= yb; yy++) {
        const row = yy * w;
        for (let xx = xa; xx <= xb; xx++) {
          const k = row + xx;
          if (mask[k]) { mask[k] = 0; stack[sp++] = k; }
        }
      }
    }
    if (area < minArea) continue;
    const mx = sx / area, my = sy / area;
    // 画素1個ぶんの広がり(1/12)を加えて、小さい塊でも 0 にならないようにする
    const vxx = sxx / area - mx * mx + 1 / 12;
    const vyy = syy / area - my * my + 1 / 12;
    const vxy = sxy / area - mx * my;
    const tr = vxx + vyy;
    const det = vxx * vyy - vxy * vxy;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l1 = tr / 2 + disc;
    const l2 = Math.max(1e-6, tr / 2 - disc);
    // 一様な楕円では、軸方向の分散 = (半径)^2 / 4 なので 直径 = 4*sqrt(分散)
    const major = 4 * Math.sqrt(l1);
    const minor = 4 * Math.sqrt(l2);
    blobs.push({
      cx: (sw > 0 ? swx / sw : mx) + 0.5,
      cy: (sw > 0 ? swy / sw : my) + 0.5,
      area,
      major,
      minor,
      angle: 0.5 * Math.atan2(2 * vxy, vxx - vyy),
      fill: area / ((Math.PI / 4) * major * minor),
      x0, y0, x1, y1,
    });
  }
  return blobs;
}

/**
 * 形と大きさでボールらしい塊だけを残す。
 * @param {object} blob          findBlobs の要素
 * @param {number} expectedDiam  その位置で期待されるボール直径（同じ画素単位）
 * @param {object} d             CONFIG.detect
 * @returns {number} スコア（0以下は不採用。1に近いほどボールらしい）
 */
export function ballScore(blob, expectedDiam, d) {
  const rMinor = blob.minor / expectedDiam;
  const rMajor = blob.major / expectedDiam;
  const expArea = (Math.PI / 4) * expectedDiam * expectedDiam;
  const rArea = blob.area / expArea;
  if (rMinor < d.minorMinRatio || rMinor > d.minorMaxRatio) return 0;
  if (rMajor > d.majorMaxRatio) return 0;
  if (rArea < d.areaMinRatio || rArea > d.areaMaxRatio) return 0;
  if (blob.fill < d.fillMin || blob.fill > d.fillMax) return 0;
  const sizeErr = Math.abs(Math.log(rMinor));
  const fillErr = Math.abs(blob.fill - 1);
  return Math.max(0.01, 1 - sizeErr - fillErr);
}
