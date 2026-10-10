// 計測パイプライン: 画素 -> 候補検出 -> 追跡 -> 解析 を1フレームずつ進める。
// DOM に依存しない（画素配列と時刻だけを受け取る）ため、Node のテストでそのまま動かせる。
//
// 座標系:
//   映像座標   : カメラ映像のピクセル（左上が 0,0。連続値。画素中心は 整数+0.5）
//   処理座標   : 映像を procScale 倍に縮小したもの（処理を軽くするため）
//   ROI 座標   : 処理座標のうち、測定範囲を囲む長方形を切り出したもの
//   実寸座標   : マット面上のメートル（x=横, y=打ち出し方向）

import { applyH, expectedBallDiameterPx } from './homography.js';
import { buildMask, findBlobs, ballScore, lumaOf } from './detector.js';
import { ShotTracker } from './tracker.js';
import { analyzeTrack } from './analysis.js';

export class MeasurePipeline {
  /**
   * @param {object} o
   * @param {object} o.cal       buildCalibration の戻り値
   * @param {object} o.cfg       CONFIG
   * @param {number} o.videoW    映像の幅(px)
   * @param {number} o.videoH
   * @param {number} o.procScale 処理座標 / 映像座標
   */
  constructor({ cal, cfg, videoW, videoH, procScale }) {
    this.cal = cal;
    this.cfg = cfg;
    this.videoW = videoW;
    this.videoH = videoH;
    this.procScale = procScale;
    this.procW = Math.round(videoW * procScale);
    this.procH = Math.round(videoH * procScale);
    this.tracker = new ShotTracker({ widthM: cal.widthM, lengthM: cal.lengthM }, cfg);
    this.state = 'idle'; // idle | bg | waiting | tracking | cooldown
    this.lastT = -Infinity;
    this.frameCount = 0;
    this._computeROI();
    const n = this.roi.w * this.roi.h;
    this.mask = new Uint8Array(n);
    this.weight = new Uint8Array(n);
    this.debugMask = new Uint8Array(n);
    this.stack = new Int32Array(n);
    this.bg = new Float32Array(n);
    this.bgSum = new Float32Array(n);
    this.prevLuma = new Uint8Array(n);
    this.curLuma = new Uint8Array(n);
    this.bgCount = 0;
    this.lastResult = null;
    this.lastCandidates = [];
    this.holdUntil = -Infinity;
    this.cooldownUntil = -Infinity;
  }

  /** 実寸座標 -> 処理座標 */
  planeToProc(X, Y) {
    const [u, v] = applyH(this.cal.plane2img, X, Y);
    return [u * this.procScale, v * this.procScale];
  }

  _computeROI() {
    const T = this.cfg.track;
    const W = this.cal.widthM, L = this.cal.lengthM;
    const ax = T.marginAcrossM, ay = T.marginAlongM;
    const corners = [[-ax, -ay], [W + ax, -ay], [W + ax, L + ay], [-ax, L + ay]].map(([X, Y]) => this.planeToProc(X, Y));
    this.zonePolyProc = corners;
    // ボールは面から浮いて写るので、ボール1個ぶん外側まで含める
    const dMax = Math.max(
      expectedBallDiameterPx(this.cal.plane2img, W / 2, 0, this.cfg.ball.diameterM),
      expectedBallDiameterPx(this.cal.plane2img, W / 2, L, this.cfg.ball.diameterM)
    ) * this.procScale;
    const pad = Math.ceil(dMax) + 2;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of corners) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    x0 = Math.max(0, Math.floor(x0 - pad));
    y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(this.procW, Math.ceil(x1 + pad));
    y1 = Math.min(this.procH, Math.ceil(y1 + pad));
    if (x1 - x0 < 8 || y1 - y0 < 8) throw new Error('測定範囲が画面内にありません。校正をやり直してください。');
    this.roi = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };

    // 測定範囲（余白込み）の内側だけを処理するためのマスク。
    // ボール中心は面より上に写るため、画素をそのまま面へ逆投影して判定し、余白で吸収する。
    const { w, h } = this.roi;
    this.zoneMask = new Uint8Array(w * h);
    const padM = this.cfg.ball.diameterM * 1.5;
    let cnt = 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const u = (x0 + i + 0.5) / this.procScale, v = (y0 + j + 0.5) / this.procScale;
        const [X, Y] = applyH(this.cal.img2plane, u, v);
        if (X >= -ax - padM && X <= W + ax + padM && Y >= -ay - padM && Y <= L + ay + padM) {
          this.zoneMask[j * w + i] = 1;
          cnt++;
        }
      }
    }
    this.zonePixels = cnt;
  }

  /** 計測を開始する（まず背景を取得する）。 */
  arm() {
    this.state = 'bg';
    this.bgCount = 0;
    this.bgSum.fill(0);
    this.tracker.reset();
    this.lastResult = null;
  }

  disarm() {
    this.state = 'idle';
    this.tracker.reset();
  }

  /** ROI 座標の塊 -> 候補（映像座標・実寸座標・スコア付き）。形と大きさが合わないものは捨てる。 */
  _toCandidates(blobs, strict) {
    const out = [];
    const { roi, procScale, cal, cfg } = this;
    for (const b of blobs) {
      // ROI の縁に接する塊は欠けている可能性が高いので使わない
      if (b.x0 <= 0 || b.y0 <= 0 || b.x1 >= roi.w - 1 || b.y1 >= roi.h - 1) continue;
      const u = (roi.x + b.cx) / procScale;
      const v = (roi.y + b.cy) / procScale;
      // 見かけの位置（面への投影）-> 高さ補正した実際のボール位置
      const [Xa, Ya] = applyH(cal.img2plane, u, v);
      const [X, Y] = cal.toBall(Xa, Ya);
      const exp = expectedBallDiameterPx(cal.plane2img, X, Y, cfg.ball.diameterM) * procScale;
      const score = ballScore(b, exp, cfg.detect);
      if (score <= 0) continue;
      if (strict && b.major / b.minor > 1.6) continue;
      out.push({ u, v, X, Y, score, diamPx: b.minor / procScale, majorPx: b.major / procScale, angle: b.angle });
    }
    return out;
  }

  /**
   * 静止しているボールを探す（計測開始前の「ボール認識状態」表示用。背景差分を使わない）。
   * @param {Uint8ClampedArray} rgba ROI の画素
   */
  detectStatic(rgba) {
    const { w, h } = this.roi;
    buildMask(rgba, w, h, null, this.zoneMask, this.cfg.detect, this.mask, this.weight);
    this.debugMask.set(this.mask);
    const blobs = findBlobs(this.mask, this.weight, w, h, this.cfg.detect.minAreaPx, this.stack);
    this.lastCandidates = this._toCandidates(blobs, true);
    return this.lastCandidates;
  }

  /**
   * 1フレーム処理する。
   * @param {Uint8ClampedArray} rgba ROI の画素（roi.w * roi.h * 4）
   * @param {number} t このフレームの時刻（秒）
   * @returns {{state:string, event:string|null, result:object|null, candidates:Array, maskRatio:number}}
   */
  processFrame(rgba, t) {
    const out = { state: this.state, event: null, result: null, candidates: [], maskRatio: 0 };
    if (this.state === 'idle') return out;
    if (!(t > this.lastT)) return out; // 同じフレーム、または時刻が逆行したフレームは無視
    this.lastT = t;
    this.frameCount++;
    const { w, h } = this.roi;
    const D = this.cfg.detect;

    if (this.state === 'bg') {
      lumaOf(rgba, w, h, this.curLuma);
      let stable = true;
      if (this.bgCount > 0) {
        let sum = 0, cnt = 0;
        for (let i = 0; i < this.curLuma.length; i++) {
          if (!this.zoneMask[i]) continue;
          sum += Math.abs(this.curLuma[i] - this.prevLuma[i]);
          cnt++;
        }
        stable = cnt === 0 || sum / cnt <= D.bgStableMaxDiff;
      }
      if (!stable) { this.bgCount = 0; this.bgSum.fill(0); }
      for (let i = 0; i < this.curLuma.length; i++) this.bgSum[i] += this.curLuma[i];
      this.prevLuma.set(this.curLuma);
      this.bgCount++;
      if (this.bgCount >= D.bgFrames) {
        for (let i = 0; i < this.bg.length; i++) this.bg[i] = this.bgSum[i] / this.bgCount;
        this.tracker.reset();
        if (t < this.holdUntil) {
          // 打ち切った打球の残りを拾わないよう、少し待ってから待機に戻る
          this.state = 'cooldown';
          this.cooldownUntil = this.holdUntil;
        } else {
          this.state = 'waiting';
          out.event = 'ready';
        }
      }
      out.state = this.state;
      return out;
    }

    if (this.state === 'cooldown' && t >= this.cooldownUntil) {
      this.state = 'waiting';
      this.tracker.reset();
      out.event = 'ready';
    }

    // 追跡中は背景を固定する（動いているボールを背景に取り込まないため）
    const tracking = this.tracker.state === 'tracking';
    const p = {
      brightMin: D.brightMin, satMax: D.satMax, diffMin: D.diffMin,
      bgAlpha: tracking ? 0 : D.bgAlpha,
      bgAlphaMasked: tracking ? 0 : D.bgAlphaMasked,
    };
    const count = buildMask(rgba, w, h, this.bg, this.zoneMask, p, this.mask, this.weight);
    this.debugMask.set(this.mask);
    out.maskRatio = count / Math.max(1, this.zonePixels);

    if (out.maskRatio > D.sceneChangeRatio) {
      // 照明の変化・カメラの移動・人が横切った等。追跡中なら無効として終了し、背景を取り直す。
      if (tracking) {
        this.tracker.abort('sceneChanged');
        out.result = this._finish(t);
        out.event = 'result';
        this.holdUntil = t + this.cfg.track.cooldownSec;
      } else {
        out.event = 'sceneChanged';
      }
      this.state = 'bg';
      this.bgCount = 0;
      this.bgSum.fill(0);
      out.state = this.state;
      return out;
    }

    const blobs = findBlobs(this.mask, this.weight, w, h, D.minAreaPx, this.stack);
    const cands = this._toCandidates(blobs, false);
    out.candidates = cands;
    this.lastCandidates = cands;

    if (this.state === 'waiting' || this.state === 'tracking') {
      const st = this.tracker.update(cands, t);
      if (st === 'tracking') this.state = 'tracking';
      if (st === 'done') {
        const L = this.cal.lengthM;
        const inside = this.tracker.points.filter((p) => p.Y >= 0 && p.Y <= L).length;
        if (inside < 3) {
          // スタートラインの手前の余白だけで終わった動き（パターヘッドの素振り等）は、
          // 打球として扱わない。結果を出さずに待機へ戻る。
          this.tracker.reset();
          this.state = 'waiting';
          out.event = 'discarded';
        } else {
          out.result = this._finish(t);
          out.event = 'result';
          this.state = 'cooldown';
          this.cooldownUntil = t + this.cfg.track.cooldownSec;
        }
      }
    }
    out.state = this.state;
    return out;
  }

  _finish(t) {
    const res = analyzeTrack(this.tracker.getTrack(), this.cal, this.cfg);
    res.finishedAt = t;
    this.lastResult = res;
    this.lastTrackPoints = this.tracker.points.slice();
    return res;
  }

  /** 追跡中の点列（オーバーレイ描画用） */
  get trackPoints() {
    return this.tracker.state === 'tracking' ? this.tracker.points : this.lastTrackPoints || [];
  }
}

/** 映像の大きさから、処理用の縮小率を決める。 */
export function chooseProcScale(videoW, videoH, maxWidth) {
  const longSide = Math.max(videoW, videoH);
  return Math.min(1, maxWidth / longSide);
}
