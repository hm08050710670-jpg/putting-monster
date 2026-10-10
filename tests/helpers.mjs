// シミュレーションテスト用の共通処理。
// 合成映像（真値のわかる映像）を1フレームずつ計測パイプラインに流し、結果と真値を返す。
// 注意: これは実機カメラのテストではない。

import { CONFIG } from '../js/config.js';
import { buildCalibration } from '../js/core/homography.js';
import { MeasurePipeline } from '../js/core/pipeline.js';
import { SimScene, presetCamera, makePutt, makeRng, cropRGBA, downscale2 } from '../js/core/simscene.js';

export function cloneConfig() {
  return JSON.parse(JSON.stringify(CONFIG));
}

/**
 * @param {object} o
 * @returns {{results:Array, events:Array, putt:object, pipeline:object, scene:object, cal:object, frames:number}}
 */
export function runSim(o = {}) {
  const {
    preset = 'side',
    width = 640,
    height = 360,
    halfScale = false, // true: 2倍の解像度で描いて半分に縮小してから処理（実機の処理経路に近い）
    fps = 60,
    exposure = 1 / 120,
    noise = 3,
    seed = 7,
    putt: puttOpt = { v0: 2.5 },
    tStrike = 0.6,
    duration = 3.0,
    dropFrames = [], // 欠落させるフレーム番号
    intervalJitter = 0, // 実際の撮影間隔のゆらぎ（秒, 一様 ±）。時刻は正しく記録される
    stampNoise = 0, // 記録される時刻の誤差（秒, 一様 ±）
    stampLagAt = null, // (フレーム番号) => 秒。そのフレームだけ、記録される時刻を遅らせる（画像は古いまま）
    tapNoisePx = 0, // 校正時のタップ位置の誤差
    sixPoints = false,
    scene: sceneOpt = {},
    boxesAt = null, // (t) => [{x,y,w,l,color}]
    ballAt = undefined, // (t) => {x,y} | null。指定するとパットの代わりに使う（null を返すとボールなし）
    gainAt = null, // (t) => 明るさ倍率
    cameraHeightError = 0,
    cfg = cloneConfig(),
    noHeightCorrection = false,
    noPose = false, // true: カメラ位置の推定を使わない（距離だけを補正する旧方式）
  } = o;

  const rw = halfScale ? width * 2 : width;
  const rh = halfScale ? height * 2 : height;
  const cam = presetCamera(preset, rw, rh);
  const scene = new SimScene(cam, sceneOpt);
  const rng = makeRng(seed);
  const putt = makePutt({ t0: tStrike, ...puttOpt });

  const points = scene.markerImagePoints(sixPoints).map(([u, v]) => [
    u + (rng() * 2 - 1) * tapNoisePx,
    v + (rng() * 2 - 1) * tapNoisePx,
  ]);
  const cal = buildCalibration({
    points,
    widthM: scene.o.zoneW,
    lengthM: scene.o.zoneL,
    cameraHeightM: noHeightCorrection ? 1e6 : cam.pos[2] + cameraHeightError,
    ballRadiusM: CONFIG.ball.radiusM,
    imageW: noPose ? undefined : rw,
    imageH: noPose ? undefined : rh,
  });
  const procScale = halfScale ? 0.5 : 1;
  const pipeline = new MeasurePipeline({ cal, cfg, videoW: rw, videoH: rh, procScale });
  const frame = new Uint8ClampedArray(rw * rh * 4);
  const roiBuf = new Uint8ClampedArray(pipeline.roi.w * pipeline.roi.h * 4);
  const results = [];
  const events = [];
  pipeline.arm();
  const nFrames = Math.round(duration * fps);
  let tTrue = 0;
  for (let i = 0; i < nFrames; i++) {
    tTrue = i / fps + (intervalJitter ? (rng() * 2 - 1) * intervalJitter : 0);
    if (dropFrames.includes(i)) continue;
    const hasBall = ballAt === undefined ? true : ballAt(tTrue) !== null;
    scene.renderFrame(frame, {
      t: tTrue,
      ballAt: !hasBall ? null : ballAt === undefined ? (t) => putt.at(t) : (t) => ballAt(t) || ballAt(tTrue),
      exposure,
      noise,
      rng,
      boxes: boxesAt ? boxesAt(tTrue) : [],
      gain: gainAt ? gainAt(tTrue) : 1,
    });
    const src = halfScale ? downscale2(frame, rw, rh) : frame;
    cropRGBA(src, halfScale ? width : rw, pipeline.roi, roiBuf);
    const stamp = tTrue + (stampNoise ? (rng() * 2 - 1) * stampNoise : 0) + (stampLagAt ? stampLagAt(i) : 0);
    const out = pipeline.processFrame(roiBuf, stamp);
    if (out.event) events.push({ i, t: stamp, event: out.event });
    if (out.result) results.push(out.result);
  }
  return { results, events, putt, pipeline, scene, cal, cam };
}

/** ボールがスタートライン（y=0）を通過する瞬間の、真の速度。 */
export function trueLineSpeed(putt) {
  const s = (0 - putt.start[1]) / putt.dir[1];
  return putt.at(putt.timeAtS(s)).v;
}

/** 相対誤差 |a-b|/b */
export function relErr(a, b) {
  return Math.abs(a - b) / b;
}

export function pct(a, b) {
  return ((a - b) / b) * 100;
}
