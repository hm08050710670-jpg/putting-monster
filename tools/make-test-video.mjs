// 検証用: シミュレーション映像を y4m 形式の動画ファイルとして書き出す。
// PC の Chromium を「この動画をカメラ映像として使う」設定で起動し、
// カメラ取得 (getUserMedia) からの処理経路を確認するために使う。実機テストの代わりにはならない。
//
//   node tools/make-test-video.mjs out.y4m [v0=2.5] [fps=60] [seconds=4.5]
//
// 出力と一緒に、基準点の座標など（校正に使う真値）を JSON で表示する。
import fs from 'node:fs';
import { SimScene, presetCamera, makePutt, makeRng } from '../js/core/simscene.js';

const out = process.argv[2];
const v0 = Number(process.argv[3] || 2.5);
const fps = Number(process.argv[4] || 60);
const seconds = Number(process.argv[5] || 4.5);
if (!out) { console.error('usage: node tools/make-test-video.mjs out.y4m [v0] [fps] [seconds]'); process.exit(1); }

const W = 1280, H = 720;
const cam = presetCamera('side', W, H);
const scene = new SimScene(cam);
const putt = makePutt({ v0, start: [0.15, -0.6], t0: 1.0 });
const rng = makeRng(3);
const frame = new Uint8ClampedArray(W * H * 4);
const fd = fs.openSync(out, 'w');
fs.writeSync(fd, `YUV4MPEG2 W${W} H${H} F${fps}:1 Ip A1:1 C420jpeg\n`);
const Y = Buffer.alloc(W * H), U = Buffer.alloc((W / 2) * (H / 2)), V = Buffer.alloc((W / 2) * (H / 2));
const n = Math.round(seconds * fps);
for (let i = 0; i < n; i++) {
  const t = i / fps;
  scene.renderFrame(frame, { t, ballAt: (tt) => putt.at(tt), exposure: 1 / 120, noise: 2, rng });
  for (let p = 0, q = 0; p < W * H; p++, q += 4) {
    Y[p] = 0.299 * frame[q] + 0.587 * frame[q + 1] + 0.114 * frame[q + 2];
  }
  for (let j = 0; j < H / 2; j++) {
    for (let k = 0; k < W / 2; k++) {
      const q = ((2 * j) * W + 2 * k) * 4;
      const r = frame[q], g = frame[q + 1], b = frame[q + 2];
      U[j * (W / 2) + k] = Math.max(0, Math.min(255, -0.168736 * r - 0.331264 * g + 0.5 * b + 128));
      V[j * (W / 2) + k] = Math.max(0, Math.min(255, 0.5 * r - 0.418688 * g - 0.081312 * b + 128));
    }
  }
  fs.writeSync(fd, 'FRAME\n');
  fs.writeSync(fd, Y); fs.writeSync(fd, U); fs.writeSync(fd, V);
}
fs.closeSync(fd);
const sLine = 0.6 / putt.dir[1];
console.log(JSON.stringify({
  width: W, height: H, fps, frames: n,
  points: scene.markerImagePoints(true),
  widthM: scene.o.zoneW, lengthM: scene.o.zoneL, cameraHeightM: cam.pos[2],
  trueLineSpeed: putt.at(putt.timeAtS(sLine)).v, aRoll: putt.aRoll,
}));
