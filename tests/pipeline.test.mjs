// 計測パイプライン全体のシミュレーションテスト。
// 合成映像（真値のわかる映像）を 画素 -> 検出 -> 追跡 -> 速度計算 まで通し、真値と比較する。
// 注意: 実機カメラのテストではない。実機での精度はここでは分からない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSim, trueLineSpeed, relErr, cloneConfig } from './helpers.mjs';
import { makePutt } from '../js/core/simscene.js';

const P = { v0: 2.5, start: [0.15, -0.6] }; // スキッドは範囲の手前で終わる

function one(sim) {
  assert.equal(sim.results.length, 1, `結果は1件のはず（実際 ${sim.results.length} 件, events=${sim.events.map((e) => e.event).join()}）`);
  return sim.results[0];
}

test('横からの映像: 入口速度が真値の1%以内、減速度も復元できる', () => {
  const sim = runSim({ putt: P });
  const r = one(sim);
  assert.equal(r.valid, true, r.reasonText.join());
  assert.ok(relErr(r.speedEntry, trueLineSpeed(sim.putt)) < 0.01, `${r.speedEntry} vs ${trueLineSpeed(sim.putt)}`);
  assert.ok(Math.abs(r.decel - 0.55) < 0.05, `減速 ${r.decel}`);
  assert.equal(r.endReason, 'exit');
  assert.ok(r.confidence >= 75);
  assert.equal(sim.events[0].event, 'ready', '最初に背景取得が完了する');
  assert.ok(sim.events[0].t < 0.5, '打つ前に準備完了になる');
});

test('後方からの映像（遠近が強い・縦長）でも1%以内', () => {
  const sim = runSim({ putt: P, preset: 'behind', width: 360, height: 640 });
  const r = one(sim);
  assert.equal(r.valid, true, r.reasonText.join());
  assert.ok(relErr(r.speedEntry, trueLineSpeed(sim.putt)) < 0.01, `${r.speedEntry} vs ${trueLineSpeed(sim.putt)}`);
});

test('1280x720 を半分に縮小して処理する経路（実機と同じ構成）でも1%以内', () => {
  const sim = runSim({ putt: P, halfScale: true });
  const r = one(sim);
  assert.equal(r.valid, true, r.reasonText.join());
  assert.ok(relErr(r.speedEntry, trueLineSpeed(sim.putt)) < 0.01);
});

test('ボール中心の高さ補正: 補正なしでは約2%速く出る。補正ありで1%以内になる', () => {
  const raw = one(runSim({ putt: P, noHeightCorrection: true }));
  const sim = runSim({ putt: P });
  const cor = one(sim);
  const vt = trueLineSpeed(sim.putt);
  assert.ok((raw.speedEntry - vt) / vt > 0.012, `補正なしの誤差 ${(((raw.speedEntry - vt) / vt) * 100).toFixed(2)}%`);
  assert.ok(relErr(cor.speedEntry, vt) < 0.01);
});

test('カメラ高さの入力が10cmずれても、速度への影響は0.5%未満', () => {
  const sim = runSim({ putt: P, cameraHeightError: 0.10 });
  const r = one(sim);
  assert.ok(relErr(r.speedEntry, trueLineSpeed(sim.putt)) < 0.01);
});

test('フレーム欠落＋撮影間隔のゆらぎがあっても1%以内（時刻が正しい場合）', () => {
  const sim = runSim({ putt: P, dropFrames: [62, 63, 70, 75, 81], intervalJitter: 0.004 });
  const r = one(sim);
  assert.equal(r.valid, true, r.reasonText.join());
  assert.ok(relErr(r.speedEntry, trueLineSpeed(sim.putt)) < 0.01);
});

test('記録される時刻に±3msの誤差がある場合: 1.5%以内だが当てはめ誤差が増える', () => {
  const clean = one(runSim({ putt: P }));
  const sim = runSim({ putt: P, stampNoise: 0.003 });
  const r = one(sim);
  assert.equal(r.valid, true, r.reasonText.join());
  assert.ok(relErr(r.speedEntry, trueLineSpeed(sim.putt)) < 0.015, `${r.speedEntry}`);
  assert.ok(r.fitRmsM > clean.fitRmsM * 3, '時刻の誤差は当てはめ誤差として見える');
  assert.ok(r.confidence < clean.confidence);
});

test('30fps でも1%以内', () => {
  const sim = runSim({ putt: P, fps: 30, exposure: 1 / 60 });
  const r = one(sim);
  assert.equal(r.valid, true, r.reasonText.join());
  assert.ok(relErr(r.speedEntry, trueLineSpeed(sim.putt)) < 0.01);
});

test('速い打球(4.5m/s)・遅い打球(1.6m/s)', () => {
  const fast = runSim({ putt: { v0: 4.5, start: [0.15, -0.9] } });
  const rf = one(fast);
  assert.equal(rf.valid, true, rf.reasonText.join());
  assert.ok(relErr(rf.speedEntry, trueLineSpeed(fast.putt)) < 0.015, `fast ${rf.speedEntry} vs ${trueLineSpeed(fast.putt)}`);
  const slow = runSim({ putt: { v0: 1.6, start: [0.15, -0.6] }, duration: 5 });
  const rs = one(slow);
  assert.equal(rs.valid, true, rs.reasonText.join());
  assert.ok(relErr(rs.speedEntry, trueLineSpeed(slow.putt)) < 0.015, `slow ${rs.speedEntry} vs ${trueLineSpeed(slow.putt)}`);
});

test('区間内で停止する打球: 停止位置が1cm以内で求まる', () => {
  const sim = runSim({ putt: { v0: 1.6, start: [0.15, -0.6] }, duration: 5 });
  const r = one(sim);
  assert.equal(r.stoppedInZone, true);
  const stopY = sim.putt.start[1] + sim.putt.totalDist;
  assert.ok(Math.abs(r.stopY - stopY) < 0.01, `${r.stopY} vs ${stopY}`);
});

test('校正のタップ誤差（6点・±1px）: 1.5%以内', () => {
  const sim = runSim({ putt: P, sixPoints: true, tapNoisePx: 1 });
  const r = one(sim);
  assert.equal(r.valid, true, r.reasonText.join());
  assert.ok(relErr(r.speedEntry, trueLineSpeed(sim.putt)) < 0.015, `${r.speedEntry} vs ${trueLineSpeed(sim.putt)}`);
});

test('最初から置いてある白い物体があっても、誤検出せず計測できる', () => {
  const sim = runSim({ putt: P, scene: { whitePatches: [{ x0: 0.04, x1: 0.09, y0: 0.5, y1: 0.55 }] } });
  const r = one(sim);
  assert.equal(r.valid, true, r.reasonText.join());
  assert.ok(relErr(r.speedEntry, trueLineSpeed(sim.putt)) < 0.01);
});

test('計測開始後に白い物体が置かれても、結果を出さず、その後の打球は計測できる', () => {
  // 0.3秒後からボール大の白い物体が範囲内に静止。打球は2.2秒後。
  const boxesAt = (t) => (t >= 0.3 ? [{ x: 0.2, y: 0.9, w: 0.04, l: 0.04, color: [245, 245, 242] }] : []);
  const sim = runSim({ putt: P, tStrike: 2.2, duration: 4.5, boxesAt });
  const r = one(sim);
  assert.equal(r.valid, true, r.reasonText.join());
  assert.ok(relErr(r.speedEntry, trueLineSpeed(sim.putt)) < 0.01);
});

test('暗いパターヘッドが範囲内まで追ってきても、ボールを計測できる', () => {
  const head = makePutt({ v0: 1.8, start: [0.15, -0.68], t0: 0.6, skid: false, aRoll: 2.2 });
  const boxesAt = (t) => { const h = head.at(t); return [{ x: h.x, y: h.y, w: 0.1, l: 0.03, color: [55, 55, 60] }]; };
  const sim = runSim({ putt: P, boxesAt });
  const r = one(sim);
  assert.equal(r.valid, true, r.reasonText.join());
  assert.ok(relErr(r.speedEntry, trueLineSpeed(sim.putt)) < 0.01);
});

test('白いパターヘッドが範囲内まで追ってきても、ボールの速度を返す', () => {
  const head = makePutt({ v0: 1.8, start: [0.15, -0.68], t0: 0.6, skid: false, aRoll: 2.2 });
  const boxesAt = (t) => { const h = head.at(t); return [{ x: h.x, y: h.y, w: 0.1, l: 0.03, color: [242, 242, 240] }]; };
  const sim = runSim({ putt: P, boxesAt });
  const valid = sim.results.filter((r) => r.valid);
  assert.equal(valid.length, 1, `有効な結果は1件: ${sim.results.map((r) => r.reasons.join('|')).join(' / ')}`);
  assert.ok(relErr(valid[0].speedEntry, trueLineSpeed(sim.putt)) < 0.01, `${valid[0].speedEntry}`);
});

test('ボールが来ない場合（ノイズのみ）: 結果は出ない', () => {
  const sim = runSim({ ballAt: () => null, noise: 8, duration: 3 });
  assert.equal(sim.results.length, 0);
});

test('照明が急に変わった場合: 結果を出さずに背景を取り直し、その後の打球は計測できる', () => {
  const sim = runSim({ putt: P, tStrike: 2.0, duration: 4.5, gainAt: (t) => (t > 0.5 ? 1.25 : 1) });
  assert.ok(sim.events.some((e) => e.event === 'sceneChanged'), `events: ${sim.events.map((e) => e.event).join()}`);
  assert.ok(sim.events.filter((e) => e.event === 'ready').length >= 2, '背景を取り直して再び準備完了になる');
  const r = one(sim);
  assert.equal(r.valid, true, r.reasonText.join());
});

test('追跡中に画面全体が変化した場合: その打球は無効', () => {
  const sim = runSim({ putt: P, gainAt: (t) => (t > 1.25 ? 1.3 : 1) });
  const r = one(sim);
  assert.equal(r.valid, false);
  assert.ok(r.reasons.includes('sceneChanged'), r.reasons.join());
});

test('2球続けて打つ: クールダウン後に再び準備完了になり、2件とも計測される', () => {
  const p1 = makePutt({ v0: 2.5, start: [0.15, -0.6], t0: 0.6 });
  const p2 = makePutt({ v0: 3.0, start: [0.15, -0.6], t0: 4.6 });
  const ballAt = (t) => (t < 3.5 ? p1.at(t) : p2.at(t));
  const sim = runSim({ ballAt, duration: 7 });
  assert.equal(sim.results.length, 2, `events: ${sim.events.map((e) => e.event).join()}`);
  assert.ok(relErr(sim.results[0].speedEntry, trueLineSpeed(p1)) < 0.01);
  assert.ok(relErr(sim.results[1].speedEntry, trueLineSpeed(p2)) < 0.01);
});

test('スキッドが範囲内にある打球: 転がり開始速度が2%以内', () => {
  const sim = runSim({ putt: { v0: 3.2, start: [0.15, -0.15] } });
  const r = one(sim);
  assert.equal(r.valid, true, r.reasonText.join());
  assert.equal(r.skid.detected, true);
  assert.ok(relErr(r.skid.speedAtRoll, sim.putt.vRoll) < 0.02, `${r.skid.speedAtRoll} vs ${sim.putt.vRoll}`);
});

test('測定範囲の外（マットの横の床）を転がる白いボールは計測しない', () => {
  const sim = runSim({ putt: { v0: 2.5, start: [0.75, -0.6] } });
  assert.equal(sim.results.length, 0);
});

test('検出しきい値を変えても（設定の変更が）反映される: 明るさしきい値を上げすぎると検出できない', () => {
  const cfg = cloneConfig();
  cfg.detect.brightMin = 254;
  const sim = runSim({ putt: P, cfg });
  assert.equal(sim.results.filter((r) => r.valid).length, 0);
});

test('スタートラインの手前だけで終わる動き（素振り・短すぎる打球）は、結果を出さない', () => {
  // ボールは範囲の余白（y=-0.08 付近）まで来て止まる
  const sim = runSim({ putt: { v0: 1.05, start: [0.15, -0.6], aRoll: 0.55 }, duration: 5 });
  const stopY = sim.putt.start[1] + sim.putt.totalDist;
  assert.ok(stopY > -0.1 && stopY < 0, `前提: 余白内で停止 (${stopY})`);
  assert.equal(sim.results.length, 0, '結果（計測失敗の通知を含む）は出ない');
});

test('映像で確認: 一部のフレームの時刻が5msずれても（1点目を含む）、滑りと誤認せず1%以内', () => {
  // PC ブラウザでの検証中に見つかった不具合（最初のフレームのずれで入口速度を27%誤る）の再発防止
  const sim = runSim({ putt: P, stampLagAt: (i) => (i % 13 === 0 || i === 55 || i === 57 ? 0.005 : 0) });
  const r = one(sim);
  assert.equal(r.valid, true, r.reasonText.join());
  assert.equal(r.skid.detected, false);
  assert.ok(r.outliers >= 2, `外れ値として除かれた点 ${r.outliers}`);
  assert.ok(relErr(r.speedEntry, trueLineSpeed(sim.putt)) < 0.01, `${r.speedEntry} vs ${trueLineSpeed(sim.putt)}`);
});
