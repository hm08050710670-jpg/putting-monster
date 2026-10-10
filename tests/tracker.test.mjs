// 追跡と結果判定のテスト（候補点を直接与える。画像は使わない）
import test from 'node:test';
import assert from 'node:assert/strict';
import { ShotTracker } from '../js/core/tracker.js';
import { analyzeTrack } from '../js/core/analysis.js';
import { makePutt, makeRng } from '../js/core/simscene.js';
import { cloneConfig, trueLineSpeed, relErr } from './helpers.mjs';

const zone = { widthM: 0.3, lengthM: 1.5 };
const cal = { ...zone, kHeight: 1, kDist: 1 };

/** 真の軌道から候補点列を作って追跡器に流す。 */
function run({ putt, fps = 60, dur = 3, extra = () => [], drop = [], hide = () => false, noise = 0.0005, cfg = cloneConfig(), seed = 2, lag = null }) {
  const rng = makeRng(seed);
  const tr = new ShotTracker(zone, cfg);
  const n = Math.round(dur * fps);
  let inZone = 0;
  for (let i = 0; i < n; i++) {
    if (drop.includes(i)) continue;
    const t = i / fps;
    let p = putt.at(t);
    // lag: そのフレームの画像が、記録された時刻より何秒古いか（時刻と画像の食い違いの再現）
    if (lag && p.phase !== 'rest') {
      if (p.y >= 0) inZone++;
      const d = lag(inZone, rng);
      if (d) p = putt.at(t - d);
    }
    const cands = [];
    if (p.phase !== 'rest' && !hide(t, p)) {
      cands.push({ X: p.x + (rng() * 2 - 1) * noise, Y: p.y + (rng() * 2 - 1) * noise, score: 0.9 });
    }
    cands.push(...extra(t, p));
    if (tr.update(cands, t) === 'done') break;
  }
  return { tr, res: tr.state === 'done' ? analyzeTrack(tr.getTrack(), cal, cfg) : null, cfg };
}

test('通常の打球: 追跡して通過(exit)で終了し、有効な結果になる', () => {
  const putt = makePutt({ v0: 2.5, start: [0.15, -0.6], t0: 0.5 }); // スキッドは範囲の手前で終わる
  const { tr, res } = run({ putt });
  assert.equal(tr.endReason, 'exit');
  assert.equal(res.valid, true, res.reasonText.join());
  const vTrue = trueLineSpeed(putt);
  assert.ok(relErr(res.speedEntry, vTrue) < 0.01, `速度 ${res.speedEntry} vs ${vTrue}`);
  assert.ok(Math.abs(res.decel - 0.55) < 0.15, `減速 ${res.decel}`);
  assert.equal(res.skid.detected, false);
  assert.ok(res.confidence >= 75, `信頼度 ${res.confidence}`);
});

test('フレーム欠落があっても速度は正しい（欠落は時刻で吸収される）', () => {
  const putt = makePutt({ v0: 2.5, start: [0.15, -0.6], t0: 0.5 });
  const { res } = run({ putt, drop: [55, 56, 62, 70] });
  assert.equal(res.valid, true, res.reasonText.join());
  assert.ok(relErr(res.speedEntry, trueLineSpeed(putt)) < 0.01);
  assert.ok(res.maxGapSec > 0.04, '欠落が記録される');
});

test('長いフレーム欠落（0.1秒超）は無効にする', () => {
  const putt = makePutt({ v0: 2.2, start: [0.15, -0.6], t0: 0.5 });
  const drop = [60, 61, 62, 63, 64, 65, 66]; // 約0.13秒の空白
  const { res } = run({ putt, drop, dur: 5 });
  assert.ok(res, '結果は出る');
  assert.equal(res.valid, false);
});

test('途中でボールを見失った場合: 早い段階なら無効', () => {
  const putt = makePutt({ v0: 2.5, start: [0.15, -0.35], t0: 0.5 });
  const { tr, res } = run({ putt, hide: (t, p) => p.y > 0.45 });
  assert.equal(tr.endReason, 'lost');
  assert.equal(res.valid, false);
  assert.ok(res.reasons.includes('lostEarly') || res.reasons.includes('tooFewFrames'), res.reasons.join());
});

test('短い見失い（数フレーム）は追跡を継続できる', () => {
  const putt = makePutt({ v0: 2.5, start: [0.15, -0.35], t0: 0.5 });
  const { tr, res } = run({ putt, hide: (t, p) => p.y > 0.6 && p.y < 0.68 });
  assert.equal(tr.endReason, 'exit');
  assert.equal(res.valid, true, res.reasonText.join());
  assert.ok(res.missRatio > 0, '見失ったフレームが記録される');
});

test('測定範囲の外の動きは追跡しない', () => {
  const putt = makePutt({ v0: 2.5, start: [0.6, -0.35], t0: 0.5 }); // 範囲の右外を通過
  const { tr } = run({ putt });
  assert.equal(tr.state, 'waiting');
});

test('横へ出ていく打球は exitSide で終了し、無効になる', () => {
  const putt = makePutt({ v0: 2.5, start: [0.15, -0.2], angleDeg: 25, t0: 0.5 });
  const { tr, res } = run({ putt });
  assert.equal(tr.endReason, 'exitSide');
  assert.equal(res.valid, false);
});

test('逆方向（戻ってくるボール）は追跡を開始しない', () => {
  const putt = makePutt({ v0: 2.0, start: [0.15, 1.8], angleDeg: 180, t0: 0.5 });
  const { tr } = run({ putt });
  assert.equal(tr.state, 'waiting');
});

test('静止した誤検出点が混ざっていても、打球を正しく追跡する', () => {
  const putt = makePutt({ v0: 2.5, start: [0.15, -0.6], t0: 0.5 });
  const extra = () => [{ X: 0.08, Y: 0.4, score: 0.95 }, { X: 0.22, Y: 0.9, score: 0.95 }];
  const { res } = run({ putt, extra });
  assert.equal(res.valid, true, res.reasonText.join());
  assert.ok(relErr(res.speedEntry, trueLineSpeed(putt)) < 0.01);
});

test('ランダムに飛び回る誤検出だけでは、有効な結果にならない', () => {
  const rng = makeRng(11);
  const putt = makePutt({ v0: 2.5, start: [5, 5], t0: 99 }); // ボールは来ない
  let valid = 0;
  for (let k = 0; k < 20; k++) {
    const extra = () => [{ X: rng() * 0.3, Y: rng() * 1.5, score: 0.9 }, { X: rng() * 0.3, Y: rng() * 1.5, score: 0.9 }];
    const { res } = run({ putt, extra, dur: 4 });
    if (res && res.valid) valid++;
  }
  assert.equal(valid, 0);
});

test('後ろから付いてくる遅い物体（フォロースルーのパターヘッド）に乗り移らない', () => {
  const putt = makePutt({ v0: 2.5, start: [0.15, -0.6], t0: 0.5 });
  const head = makePutt({ v0: 1.8, start: [0.15, -0.66], t0: 0.5, skid: false, aRoll: 2.2 }); // 範囲内まで入って止まる
  const extra = (t) => { const h = head.at(t); return h.phase === 'rest' ? [] : [{ X: h.x, Y: h.y, score: 0.7 }]; };
  const { res } = run({ putt, extra });
  assert.equal(res.valid, true, res.reasonText.join());
  const vTrue = trueLineSpeed(putt);
  assert.ok(relErr(res.speedEntry, vTrue) < 0.01, `${res.speedEntry} vs ${vTrue}`);
});

test('区間内で止まる打球: stopped で終了し、停止位置が記録される', () => {
  const putt = makePutt({ v0: 1.3, start: [0.15, -0.3], t0: 0.5, aRoll: 0.55 });
  const stopY = putt.start[1] + putt.totalDist;
  assert.ok(stopY > 0.5 && stopY < 1.4, `前提: 区間内で停止 (${stopY})`);
  const { tr, res } = run({ putt, dur: 6 });
  assert.equal(tr.endReason, 'stopped');
  assert.equal(res.stoppedInZone, true);
  assert.ok(Math.abs(res.stopY - stopY) < 0.01, `停止位置 ${res.stopY} vs ${stopY}`);
  assert.equal(res.valid, true, res.reasonText.join());
  assert.ok(Math.abs(res.decel - 0.55) < 0.06, `減速 ${res.decel}`);
});

test('スキッドが区間内にある打球: 切り替わりを検出し、転がり開始速度を返す', () => {
  const putt = makePutt({ v0: 3.2, start: [0.15, -0.05], t0: 0.5, muK: 0.4, aRoll: 0.55 });
  const { res } = run({ putt, noise: 0.0004 });
  assert.equal(res.valid, true, res.reasonText.join());
  assert.equal(res.skid.detected, true);
  assert.ok(Math.abs(res.skid.speedAtRoll - putt.vRoll) / putt.vRoll < 0.02, `転がり開始速度 ${res.skid.speedAtRoll} vs ${putt.vRoll}`);
  assert.equal(res.rollSpeed, res.skid.speedAtRoll);
});

test('30fps でも有効な結果になる（点数は半分）', () => {
  const putt = makePutt({ v0: 2.4, start: [0.15, -0.6], t0: 0.5 });
  const { res } = run({ putt, fps: 30 });
  assert.equal(res.valid, true, res.reasonText.join());
  assert.ok(relErr(res.speedEntry, trueLineSpeed(putt)) < 0.015);
});

test('ガタガタの軌跡（直線に乗らない）は無効', () => {
  const cfg = cloneConfig();
  const pts = [];
  for (let i = 0; i < 30; i++) pts.push({ t: i / 60, X: 0.15 + (i % 2 ? 0.03 : -0.03), Y: 0.05 + i * 0.04 });
  const res = analyzeTrack({ points: pts, misses: 0, ambiguous: 0, endReason: 'exit' }, cal, cfg);
  assert.equal(res.valid, false);
  assert.ok(res.reasons.includes('notStraight'));
});

test('加速している軌跡（物理的に不自然）は無効', () => {
  const cfg = cloneConfig();
  const pts = [];
  for (let i = 0; i < 30; i++) { const t = i / 60; pts.push({ t, X: 0.15, Y: 0.02 + 1.0 * t + 0.5 * 3.0 * t * t }); }
  const res = analyzeTrack({ points: pts, misses: 0, ambiguous: 0, endReason: 'exit' }, cal, cfg);
  assert.equal(res.valid, false);
  assert.ok(res.reasons.includes('decelRange'), res.reasons.join());
});

test('点が少なすぎる・データなしは無効', () => {
  const cfg = cloneConfig();
  const r0 = analyzeTrack({ points: [], misses: 0, ambiguous: 0, endReason: 'lost' }, cal, cfg);
  assert.equal(r0.valid, false);
  assert.deepEqual(r0.reasons, ['noData']);
  const pts = [0, 1, 2, 3, 4].map((i) => ({ t: i / 60, X: 0.15, Y: 0.1 + i * 0.04 }));
  const r1 = analyzeTrack({ points: pts, misses: 0, ambiguous: 0, endReason: 'lost' }, cal, cfg);
  assert.equal(r1.valid, false);
  assert.ok(r1.reasons.includes('tooFewFrames'));
});

test('高さ補正係数が速度に反映される', () => {
  const cfg = cloneConfig();
  const pts = [];
  for (let i = 0; i < 30; i++) { const t = i / 60; pts.push({ t, X: 0.15, Y: 0.02 + 2.0 * t }); }
  const a = analyzeTrack({ points: pts, misses: 0, ambiguous: 0, endReason: 'exit' }, { ...zone, kHeight: 1, kDist: 1 }, cfg);
  const b = analyzeTrack({ points: pts, misses: 0, ambiguous: 0, endReason: 'exit' }, { ...zone, kHeight: 0.98, kDist: 0.98 }, cfg);
  assert.ok(Math.abs(a.speedEntry - 2.0) < 1e-6);
  assert.ok(Math.abs(b.speedEntry - 1.96) < 1e-6);
});

test('スキッドが入口付近で終わる打球: 入口速度は数%ずれうるが、区間中央の速度は正確（既知の制約）', () => {
  // スキッド終了が y=+0.04 付近。入口の1〜2フレームだけが滑り区間に入る。
  const putt = makePutt({ v0: 2.5, start: [0.15, -0.35], t0: 0.5 });
  const { res } = run({ putt });
  assert.equal(res.valid, true, res.reasonText.join());
  const tMid = res.samples[0][0] + res.durationSec / 2;
  assert.ok(relErr(res.speedMid, putt.at(tMid).v) < 0.01, `中央 ${res.speedMid} vs ${putt.at(tMid).v}`);
  assert.ok(relErr(res.speedEntry, trueLineSpeed(putt)) < 0.05, `入口 ${res.speedEntry} vs ${trueLineSpeed(putt)}`);
});

test('ボールが範囲の内側から動き出した場合は無効（lateEntry）', () => {
  const putt = makePutt({ v0: 2.5, start: [0.15, 0.3], t0: 0.5 });
  const { res } = run({ putt });
  assert.equal(res.valid, false);
  assert.ok(res.reasons.includes('lateEntry'), res.reasons.join());
});

// ---- 時刻と画像の食い違い（1フレームだけ数msずれる）への耐性 ----
// PC ブラウザでの検証中に、最初のフレームのずれを「打ち出し直後の滑り」と誤認して
// 入口速度を 27% 誤る不具合が見つかった。その再発防止テスト。

test('最初のフレームだけ時刻が5msずれていても、滑りと誤認せず、入口速度は1%以内', () => {
  const putt = makePutt({ v0: 2.5, start: [0.15, -0.6], t0: 0.5 });
  const { res } = run({ putt, lag: (k) => (k === 1 ? 0.005 : 0) });
  assert.equal(res.valid, true, res.reasonText.join());
  assert.equal(res.skid.detected, false);
  assert.ok(relErr(res.speedEntry, trueLineSpeed(putt)) < 0.01, `${res.speedEntry} vs ${trueLineSpeed(putt)}`);
  assert.equal(res.outliers, 1, 'ずれた1点は外れ値として除かれる');
});

test('8%のフレームが5msずれる（＋1点目と3点目もずれる）: 滑りの誤認なし。有効な結果はすべて1.5%以内', () => {
  let valid = 0, skid = 0, worst = 0;
  const N = 200;
  for (let seed = 1; seed <= N; seed++) {
    const putt = makePutt({ v0: 2.5, start: [0.15, -0.6], t0: 0.5 });
    const { res } = run({ putt, seed, noise: 0.0004, lag: (k, rng) => (k === 1 || k === 3 || rng() < 0.08 ? 0.005 : 0) });
    if (!res) continue;
    if (res.skid && res.skid.detected) skid++;
    if (res.valid) { valid++; worst = Math.max(worst, relErr(res.speedEntry, trueLineSpeed(putt))); }
  }
  assert.equal(skid, 0, '滑りの誤認');
  assert.ok(worst < 0.015, `最大誤差 ${(worst * 100).toFixed(2)}%`);
  assert.ok(valid >= N * 0.85, `有効 ${valid}/${N}`);
});

test('ずれが多すぎる場合（15%のフレームが8ms）: 大きく誤った値を有効として返さない', () => {
  let worst = 0, valid = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const putt = makePutt({ v0: 2.5, start: [0.15, -0.6], t0: 0.5 });
    const { res } = run({ putt, seed, noise: 0.0004, lag: (k, rng) => (k === 1 || k === 3 || rng() < 0.15 ? 0.008 : 0) });
    if (res && res.valid) { valid++; worst = Math.max(worst, relErr(res.speedEntry, trueLineSpeed(putt))); }
  }
  assert.ok(worst < 0.03, `最大誤差 ${(worst * 100).toFixed(2)}%（有効 ${valid}/200）`);
  assert.ok(valid < 100, '大半は無効と判定される');
});

test('本物の滑り＋8%のフレームのずれ（悪条件の重なり）: 滑りを検出でき、有効な結果は入口速度3%以内・出口速度2.5%以内', () => {
  // 滑りと転がりの切り替わり付近にずれたフレームが重なると、切り替わり時刻の推定が1フレームぶん動き、
  // 入口速度（滑っている最中の速度）と「転がり開始時の速度」に最大で数%の誤差が出る（既知の限界）。
  // 実測値: 入口速度で最大 約2.3%、出口速度で最大 約1.8%（200回中の最悪値）。
  // 滑りが測定範囲に入らない設置（スタートラインをボールから離す）なら、この誤差は生じない。
  let valid = 0, skid = 0, worst = 0, worstExit = 0;
  const N = 200;
  for (let seed = 1; seed <= N; seed++) {
    const putt = makePutt({ v0: 3.2, start: [0.15, -0.05], t0: 0.5 });
    const { res } = run({ putt, seed, noise: 0.0004, lag: (k, rng) => (rng() < 0.08 ? 0.005 : 0) });
    if (!res) continue;
    if (res.skid && res.skid.detected) skid++;
    if (res.valid) {
      valid++;
      worst = Math.max(worst, relErr(res.speedEntry, trueLineSpeed(putt)));
      const tEnd = res.samples[0][0] + res.exitTau;
      worstExit = Math.max(worstExit, relErr(res.speedExit, putt.at(tEnd).v));
    }
  }
  assert.ok(skid >= N * 0.9, `滑りの検出 ${skid}/${N}`);
  assert.ok(worst < 0.03, `入口速度の最大誤差 ${(worst * 100).toFixed(2)}%`);
  assert.ok(worstExit < 0.025, `出口速度の最大誤差 ${(worstExit * 100).toFixed(2)}%`);
  assert.ok(valid >= N * 0.6, `有効 ${valid}/${N}`);
});

test('滑りを含む動きを一定減速で当てはめた場合（滑りを検出できなかった場合）は無効になる', () => {
  // 滑り検出を事実上オフにして、1区間モデルだけで評価させる
  const cfg = cloneConfig();
  cfg.skid.minBicGain = 1e9;
  const putt = makePutt({ v0: 3.2, start: [0.15, -0.05], t0: 0.5 });
  const { res } = run({ putt, cfg });
  assert.equal(res.skid.detected, false);
  assert.equal(res.valid, false, `入口速度 ${res.speedEntry}（真値 ${trueLineSpeed(putt)}）が有効として通ってはいけない`);
  assert.ok(res.reasons.includes('poorFit') || res.reasons.includes('unstableTiming') || res.reasons.includes('lateEntry'), res.reasons.join());
});
