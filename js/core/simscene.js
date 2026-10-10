// シミュレーション映像の生成（合成画像）。
// 目的: 実機カメラなしで、検出・追跡・速度計算の一連の処理を「真値のわかる映像」で検証する。
// ここで作る映像は実測ではない。アプリ上では必ず「シミュレーション」と表示する。
//
// DOM に依存しない（RGBA 配列に描く）ので、Node のテストとブラウザの両方で同じものを使う。

import { computeHomography, invert3, applyH } from './homography.js';
import { G } from '../config.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

/** ピンホールカメラ。世界座標: x=横, y=打ち出し方向, z=上（単位 m）。 */
export function makeCamera({ pos, lookAt, f, width, height }) {
  const F = norm(sub(lookAt, pos));
  const R = norm(cross(F, [0, 0, 1]));
  const U = cross(R, F);
  const cx = width / 2, cy = height / 2;
  const project = (P) => {
    const d = sub(P, pos);
    const depth = dot(d, F);
    return { u: cx + (f * dot(d, R)) / depth, v: cy - (f * dot(d, U)) / depth, depth };
  };
  // マット面(z=0) -> 画像 のホモグラフィ（4点から厳密に求まる）
  const ref = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const img = ref.map(([x, y]) => { const p = project([x, y, 0]); return [p.u, p.v]; });
  const plane2img = computeHomography(ref, img);
  return { pos, f, width, height, project, plane2img, img2plane: invert3(plane2img) };
}

/**
 * パットの運動モデル（真値）。
 *  - t0 に初速 v0・回転なしで打ち出される
 *  - 滑りながら減速（減速度 muK*g）し、速度が 5/7*v0 になった時点で純転がりへ移行
 *    （一様な球が回転なしで滑り始めた場合の力学的な結果）
 *  - その後は一定の減速度 aRoll で停止まで転がる
 */
export function makePutt({ v0, angleDeg = 0, start = [0.15, -0.35], muK = 0.4, aRoll = 0.55, t0 = 0, skid = true }) {
  const a1 = muK * G;
  const ts = skid ? ((2 / 7) * v0) / a1 : 0;
  const vr = skid ? (5 / 7) * v0 : v0;
  const ss = v0 * ts - 0.5 * a1 * ts * ts;
  const tr = vr / aRoll;
  const th = (angleDeg * Math.PI) / 180;
  const dir = [Math.sin(th), Math.cos(th)];
  const at = (t) => {
    const tau = t - t0;
    let s, v, phase;
    if (tau <= 0) { s = 0; v = 0; phase = 'rest'; }
    else if (tau < ts) { s = v0 * tau - 0.5 * a1 * tau * tau; v = v0 - a1 * tau; phase = 'skid'; }
    else if (tau < ts + tr) { const u = tau - ts; s = ss + vr * u - 0.5 * aRoll * u * u; v = vr - aRoll * u; phase = 'roll'; }
    else { s = ss + (vr * vr) / (2 * aRoll); v = 0; phase = 'stopped'; }
    return { x: start[0] + dir[0] * s, y: start[1] + dir[1] * s, s, v, phase };
  };
  /** 進行距離 s に達する時刻（到達しなければ null） */
  const timeAtS = (s) => {
    if (s <= 0) return t0;
    if (s < ss) return t0 + (v0 - Math.sqrt(v0 * v0 - 2 * a1 * s)) / a1;
    const d = s - ss;
    const disc = vr * vr - 2 * aRoll * d;
    if (disc < 0) return null;
    return t0 + ts + (vr - Math.sqrt(disc)) / aRoll;
  };
  return { at, timeAtS, v0, vRoll: vr, skidTime: ts, skidDist: ss, aSkid: a1, aRoll, dir, start, totalDist: ss + (vr * vr) / (2 * aRoll) };
}

// 再現性のある乱数（テスト用）
export function makeRng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export const SCENE_DEFAULT = {
  zoneW: 0.30,
  zoneL: 1.50,
  mat: { x0: 0.03, x1: 0.27, y0: -0.7, y1: 2.3, color: [38, 118, 62] },
  floor: [150, 122, 92],
  wall: [70, 70, 78],
  markerRadius: 0.012,
  markerColor: [235, 215, 40],
  ballRadius: 0.021335,
  ballColor: [248, 248, 244],
  whitePatches: [], // [{x0,x1,y0,y1}] 静止した白い物体（誤検出テスト用）
};

export class SimScene {
  constructor(camera, opts = {}) {
    this.cam = camera;
    this.o = { ...SCENE_DEFAULT, ...opts };
    this.w = camera.width;
    this.h = camera.height;
    this.bg = new Uint8ClampedArray(this.w * this.h * 4);
    this._renderBackground();
  }

  /** 基準点（目印）の実寸座標。順番は校正と同じ。 */
  markerPlanePoints(six = false) {
    const W = this.o.zoneW, L = this.o.zoneL;
    const p = [[0, 0], [W, 0], [W, L], [0, L]];
    if (six) p.push([0, L / 2], [W, L / 2]);
    return p;
  }

  /** 基準点の映像座標（真値）。 */
  markerImagePoints(six = false) {
    return this.markerPlanePoints(six).map(([x, y]) => applyH(this.cam.plane2img, x, y));
  }

  _renderBackground() {
    const { w, h, o } = this;
    const H = this.cam.img2plane;
    const marks = this.markerPlanePoints(true);
    const mr2 = o.markerRadius ** 2;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const u = i + 0.5, v = j + 0.5;
        const wq = H[6] * u + H[7] * v + H[8];
        const X = (H[0] * u + H[1] * v + H[2]) / wq;
        const Y = (H[3] * u + H[4] * v + H[5]) / wq;
        // 画像の点が面の手前側（カメラ前方）にあるか: 面上の点を再投影して奥行きを確認
        let c;
        const depth = this.cam.project([X, Y, 0]).depth;
        if (!(depth > 0) || !isFinite(X) || Math.abs(X) > 50 || Math.abs(Y) > 50) c = o.wall;
        else {
          c = o.floor;
          if (X >= o.mat.x0 && X <= o.mat.x1 && Y >= o.mat.y0 && Y <= o.mat.y1) {
            // 芝目風のわずかな濃淡
            const k = 1 + 0.06 * Math.sin(Y * 90) + 0.04 * Math.sin(X * 140 + Y * 25);
            c = [o.mat.color[0] * k, o.mat.color[1] * k, o.mat.color[2] * k];
          }
          for (const p of o.whitePatches) {
            if (X >= p.x0 && X <= p.x1 && Y >= p.y0 && Y <= p.y1) c = p.color || [238, 238, 236];
          }
          for (const [mx, my] of marks) {
            if ((X - mx) ** 2 + (Y - my) ** 2 <= mr2) c = o.markerColor;
          }
        }
        const k4 = (j * w + i) * 4;
        this.bg[k4] = c[0]; this.bg[k4 + 1] = c[1]; this.bg[k4 + 2] = c[2]; this.bg[k4 + 3] = 255;
      }
    }
  }

  /**
   * 1フレーム描く。
   * @param {Uint8ClampedArray} out  w*h*4
   * @param {object} f
   * @param {(t:number)=>{x:number,y:number}} [f.ballAt] ボール位置（面上の座標）を返す関数
   * @param {number} f.t          フレーム時刻（露光の中央）
   * @param {number} [f.exposure] 露光時間（秒）。モーションブラーの長さを決める
   * @param {number} [f.noise]    画素ノイズの振幅（0 でなし）
   * @param {()=>number} [f.rng]
   * @param {Array} [f.boxes]     動く長方形（パターヘッド等）[{x,y,w,l,color}]（面上の中心と大きさ）
   * @param {number} [f.gain]     全体の明るさ倍率（照明変化テスト用）
   */
  renderFrame(out, f) {
    out.set(this.bg);
    const { w, h } = this;
    if (f.gain && f.gain !== 1) {
      for (let i = 0; i < out.length; i += 4) { out[i] *= f.gain; out[i + 1] *= f.gain; out[i + 2] *= f.gain; }
    }
    for (const b of f.boxes || []) this._drawBox(out, b);
    if (f.ballAt) this._drawBall(out, f.ballAt, f.t, f.exposure || 0);
    if (f.noise) {
      const rng = f.rng || Math.random;
      const a = f.noise;
      for (let i = 0; i < w * h * 4; i += 4) {
        const n = (rng() + rng() - 1) * a;
        out[i] += n; out[i + 1] += n; out[i + 2] += n;
      }
    }
    return out;
  }

  _drawBox(out, b) {
    const { w, h } = this;
    const P = this.cam.plane2img, Hi = this.cam.img2plane;
    const cs = [[b.x - b.w / 2, b.y - b.l / 2], [b.x + b.w / 2, b.y - b.l / 2], [b.x + b.w / 2, b.y + b.l / 2], [b.x - b.w / 2, b.y + b.l / 2]].map(([x, y]) => applyH(P, x, y));
    const x0 = Math.max(0, Math.floor(Math.min(...cs.map((c) => c[0]))));
    const x1 = Math.min(w - 1, Math.ceil(Math.max(...cs.map((c) => c[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...cs.map((c) => c[1]))));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(...cs.map((c) => c[1]))));
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const [X, Y] = applyH(Hi, i + 0.5, j + 0.5);
        if (Math.abs(X - b.x) <= b.w / 2 && Math.abs(Y - b.y) <= b.l / 2) {
          const k = (j * w + i) * 4;
          out[k] = b.color[0]; out[k + 1] = b.color[1]; out[k + 2] = b.color[2];
        }
      }
    }
  }

  _drawBall(out, ballAt, t, exposure) {
    const { w, h, o } = this;
    const K = exposure > 0 ? 9 : 1;
    const centers = [];
    for (let k = 0; k < K; k++) {
      const tk = K === 1 ? t : t + (k / (K - 1) - 0.5) * exposure;
      const p = ballAt(tk);
      // ボールの中心は面から半径ぶん浮いている
      const q = this.cam.project([p.x, p.y, o.ballRadius]);
      if (!(q.depth > 0)) return;
      centers.push({ u: q.u, v: q.v, r: (this.cam.f * o.ballRadius) / q.depth });
    }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const c of centers) {
      x0 = Math.min(x0, c.u - c.r - 1); x1 = Math.max(x1, c.u + c.r + 1);
      y0 = Math.min(y0, c.v - c.r - 1); y1 = Math.max(y1, c.v + c.r + 1);
    }
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(w - 1, Math.ceil(x1)); y1 = Math.min(h - 1, Math.ceil(y1));
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        let alpha = 0, shade = 0;
        for (const c of centers) {
          const d = Math.hypot(i + 0.5 - c.u, j + 0.5 - c.v);
          const cov = Math.min(1, Math.max(0, c.r - d + 0.5)); // 縁を滑らかに
          alpha += cov;
          // 下側をわずかに暗く（立体感）
          shade += cov * (1 - 0.12 * Math.max(0, (j + 0.5 - c.v) / c.r));
        }
        if (alpha <= 0) continue;
        const s = shade / alpha;
        alpha /= K;
        const k = (j * w + i) * 4;
        out[k] = out[k] * (1 - alpha) + o.ballColor[0] * s * alpha;
        out[k + 1] = out[k + 1] * (1 - alpha) + o.ballColor[1] * s * alpha;
        out[k + 2] = out[k + 2] * (1 - alpha) + o.ballColor[2] * s * alpha;
      }
    }
  }
}

/** フレーム全体から ROI を切り出す（scale=1 のとき）。 */
export function cropRGBA(frame, frameW, roi, out) {
  const n = roi.w * 4;
  for (let j = 0; j < roi.h; j++) {
    const src = ((roi.y + j) * frameW + roi.x) * 4;
    out.set(frame.subarray(src, src + n), j * n);
  }
  return out;
}

/** 2x2 の平均で半分に縮小する（処理用縮小のテスト用）。 */
export function downscale2(frame, w, h) {
  const W = w >> 1, H = h >> 1;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const a = ((2 * j) * w + 2 * i) * 4, b = a + 4, c = a + w * 4, d = c + 4;
      const k = (j * W + i) * 4;
      for (let ch = 0; ch < 3; ch++) out[k + ch] = (frame[a + ch] + frame[b + ch] + frame[c + ch] + frame[d + ch]) / 4;
      out[k + 3] = 255;
    }
  }
  return out;
}

/** 標準のシミュレーション用カメラ配置。 */
export function presetCamera(name, width, height) {
  if (name === 'side') {
    // マットの右横 1.6m、高さ 1.1m から見下ろす（推奨配置に近い）
    return makeCamera({ pos: [1.75, 0.75, 1.1], lookAt: [0.15, 0.75, 0], f: 0.727 * width, width, height });
  }
  if (name === 'behind') {
    // 打つ人の後方上から、打ち出し方向を見る（遠近が強い配置）
    return makeCamera({ pos: [0.5, -1.3, 1.5], lookAt: [0.15, 0.8, 0], f: 1.29 * width, width, height });
  }
  throw new Error('unknown preset');
}
