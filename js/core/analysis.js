// 追跡した点列から、速度・減速・信頼度を算出し、結果の有効/無効を判定する。
// ここでは「マット上で実際に測った値」だけを扱う。9フィート換算（推定停止距離）は Phase 2。

import { fitLinePCA, fitQuadratic, fitTwoPhase, robustFit, bic, median } from './kinematics.js';

export const REASON_TEXT = {
  tooFewFrames: 'フレーム数が不足しています',
  shortTravel: '観測できた移動距離が短すぎます',
  lostEarly: '途中でボールを見失いました',
  missRatio: '検出できなかったフレームが多すぎます',
  frameGap: 'フレームの間隔が空きすぎています（処理落ち）',
  lowFps: 'フレームレートが低すぎます',
  notStraight: '軌道が直線から外れています（誤検出の可能性）',
  poorFit: '動きが一定の減速に合いません（誤検出、時刻のずれ、または滑りの可能性）',
  speedRange: '速度が想定範囲外です',
  decelRange: '減速の値が物理的に不自然です（誤検出の可能性）',
  speedUncertain: '速度の推定誤差が大きすぎます',
  backward: '逆方向の動きです',
  sceneChanged: '計測中に画面全体が変化しました',
  unstableEntry: 'スタートライン付近の動きを確定できません（滑りと時刻のずれを区別できない）',
  unstableTiming: 'フレームの時刻または検出位置が不安定です（外れ値が多すぎます）',
  lateEntry: 'スタートライン付近でボールを検出できませんでした（ボールが範囲の内側から動き出した可能性）',
  noData: 'データがありません',
};

/**
 * @param {object} track  { points:[{t,X,Y}], misses:number, ambiguous:number, endReason:string }
 * @param {object} cal    buildCalibration の戻り値
 * @param {object} cfg    CONFIG
 * @returns {object} 測定結果
 */
export function analyzeTrack(track, cal, cfg) {
  const V = cfg.validity;
  const L = cal.lengthM;
  // 位置が補正済み（cal.toBall 適用済み）なら 1、そうでなければ高さ補正係数
  const k = cal.kDist;
  const res = {
    valid: false,
    reasons: [],
    confidence: 0,
    endReason: track.endReason,
    kHeight: cal.kHeight,
    positionCorrected: cal.kDist === 1 && cal.kHeight !== 1,
    stoppedInZone: false,
  };
  const fail = (code) => { if (!res.reasons.includes(code)) res.reasons.push(code); };

  // 校正した長方形の内側（進行方向 0〜L）の点だけを使う。外側は外挿になり精度が落ちるため。
  let pts = track.points.filter((p) => p.Y >= 0 && p.Y <= L);

  // 区間内で停止した場合、停止後の点を取り除く（一定減速モデルは停止後には成り立たない）
  if (track.endReason === 'stopped' && pts.length > 2) {
    const last = pts[pts.length - 1];
    let cut = pts.length;
    for (let i = 0; i < pts.length; i++) {
      if (Math.hypot(pts[i].X - last.X, pts[i].Y - last.Y) < 0.005) { cut = i + 1; break; }
    }
    res.stoppedInZone = true;
    // スタートラインから停止位置まで。位置補正なしの場合は最大で数cmのずれがありうる
    res.stopY = last.Y;
    pts = pts.slice(0, cut);
  }

  res.n = pts.length;
  if (pts.length < 3) {
    fail(pts.length === 0 ? 'noData' : 'tooFewFrames');
    res.reasonText = res.reasons.map((r) => REASON_TEXT[r]);
    return res;
  }

  const nAll = pts.length;
  const line = fitLinePCA(pts.map((p) => [p.X, p.Y]));
  const t = pts.map((p) => p.t);
  // 進行方向への射影距離（高さ補正込み）
  const s = pts.map((p) => ((p.X - pts[0].X) * line.dx + (p.Y - pts[0].Y) * line.dy) * k);
  const dts = [];
  for (let i = 1; i < t.length; i++) dts.push(t[i] - t[i - 1]);

  res.dtMedian = median(dts);
  res.fpsEff = 1 / res.dtMedian;
  res.maxGapSec = Math.max(...dts);
  res.missRatio = track.misses / (track.misses + track.points.length);
  res.ambiguous = track.ambiguous || 0;
  res.lateralRmsM = line.lateralRms * k;
  res.directionDeg = (Math.atan2(line.dx, line.dy) * 180) / Math.PI; // +: 右へ
  res.entryY = pts[0].Y;
  res.exitY = pts[pts.length - 1].Y;
  res.durationSec = t[t.length - 1] - t[0];
  res.travelM = s[s.length - 1] - s[0];
  res.speedMean = res.travelM / res.durationSec;

  if (line.dy <= 0) fail('backward');
  if (nAll < V.minFrames) fail('tooFewFrames');

  if (nAll >= 4) {
    const t0 = t[0];
    const S = cfg.skid;

    // ---- 1区間モデル（一定減速）----
    // カメラ映像では、ときどき 1 フレームだけ時刻と画像が数 ms 食い違う。そうした突発的な
    // 外れ値は取り除いて当てはめる（robustFit）。
    const rq = robustFit((tt, ss) => fitQuadratic(tt, ss, t0), t, s, t0, cfg.robust);
    const q = rq.fit;
    let model = q;
    let used = rq.keep;
    let rms = rq.rmsIn;
    let aEntry = q.a;
    res.decel = q.a;
    res.decelSE = q.seA;

    // ---- 2区間モデル（打ち出し直後の滑り -> 転がり）----
    // 注意点: 最初の 1〜2 点の時刻がずれているだけでも、2区間モデルは「強い減速のあと
    // 緩やかになった」と解釈して当てはまってしまい、入口速度を 10% 以上誤る。
    // そこで、採用前に「先頭の点を 1〜2 個抜いても同じ結論になるか」を確かめる。
    //   ・抜くと滑りの証拠が消える   -> 外れ値による見かけの滑り。1区間モデルを使う
    //   ・抜いても同じ入口速度になる -> 本物の滑り。2区間モデルを使う
    //   ・証拠は残るが値が食い違う   -> 判別できないので無効にする
    res.skid = { detected: false };
    const evalTwo = (idx, minFirst) => {
      const tt = idx.map((i) => t[i]), ss = idx.map((i) => s[i]);
      const two = fitTwoPhase(tt, ss, Math.max(2, minFirst), S.minPointsSecond, t0);
      if (!two) return { two: null, gain: -Infinity, ok: false };
      const qs = fitQuadratic(tt, ss, t0);
      const gain = bic(qs.rss, qs.n, 3) - bic(two.rss, two.n, 5);
      const n1 = tt.filter((x) => x - t0 <= two.tc).length;
      const ok =
        gain >= S.minBicGain && n1 >= minFirst &&
        two.a1 >= S.minFirstDecel && two.a1 <= S.maxFirstDecel &&
        two.a1 - two.a2 >= S.minDecelDrop &&
        two.vc > 0 && two.vc / two.v0 >= S.minSpeedRatio;
      return { two, gain, ok };
    };
    const rt = robustFit((tt, ss) => fitTwoPhase(tt, ss, S.minPointsFirst, S.minPointsSecond, t0), t, s, t0, cfg.robust);
    if (rt && rt.fit) {
      const idx = [];
      for (let i = 0; i < nAll; i++) if (rt.keep[i]) idx.push(i);
      const base = evalTwo(idx, S.minPointsFirst);
      if (base.ok) {
        let artefact = false, inconsistent = false;
        for (const D of [[0], [1], [2], [0, 1], [0, 2], [1, 2]]) {
          const v = evalTwo(idx.filter((_, j) => !D.includes(j)), S.minPointsFirst - D.length);
          if (!v.two || v.gain < S.minBicGain || v.two.a1 < S.minFirstDecel) { artefact = true; break; }
          if (Math.abs(v.two.speedAt(0) - base.two.v0) / base.two.v0 > S.looTolerance) inconsistent = true;
        }
        if (!artefact) {
          const two = base.two;
          res.skid = {
            detected: true,
            tc: two.tc,
            distFromFirstM: two.sc - two.s0,
            yAtRoll: pts[0].Y + ((two.sc - two.s0) / k) * line.dy,
            speedAtRoll: two.vc,
            decelSkid: two.a1,
            decelRoll: two.a2,
            bicGain: base.gain,
          };
          model = two;
          used = rt.keep;
          rms = two.rms;
          res.decel = two.a2;
          aEntry = two.a1;
          if (inconsistent) fail('unstableEntry');
        }
      }
    }

    // 採用した点のうち最初と最後（外れ値として除いた点は基準にしない）
    const first = used.indexOf(true);
    const last = used.lastIndexOf(true);
    const tauA = t[first] - t0, tauB = t[last] - t0;
    const nOut = used.filter((u) => !u).length;
    res.fitRmsM = rms;
    // 残差の並びが滑らかに偏っていないか（隣り合う残差の相関）。
    // 雑音だけなら 0 付近、モデルが合っていない（例: 見逃した滑り）と 1 に近づく。
    {
      let num = 0, den = 0, prev = null;
      for (let i = 0; i < nAll; i++) {
        if (!used[i]) continue;
        const r = s[i] - model.predict(t[i] - t0);
        den += r * r;
        if (prev !== null) num += r * prev;
        prev = r;
      }
      res.residualAutocorr = den > 0 ? num / den : 0;
    }
    res.outliers = nOut;
    res.outlierRatio = nOut / nAll;
    res.speedFirst = model.speedAt(tauA);
    res.speedMid = model.speedAt((tauA + tauB) / 2);
    res.speedExit = model.speedAt(tauB);
    // 出口速度を求めた時刻と位置（最初のサンプルからの経過秒 / スタートラインからの距離）
    res.exitTau = tauB;
    res.exitYUsed = pts[last].Y;
    res.speedMidSE = q.speedSEAt((tauA + tauB) / 2);
    res.speedEntrySE = q.speedSEAt(tauA);

    // スタートライン通過時の速度。最初の採用点（ラインから数フレーム以内）から
    // 等加速度の式 v^2 = v1^2 + 2*a*d でごく短く外挿する。打球ごとに基準位置を揃えるため。
    const d0 = Math.max(0, (pts[first].Y / Math.max(line.dy, 0.5)) * k);
    res.entryLagM = d0;
    res.speedEntry = Math.sqrt(Math.max(0, res.speedFirst ** 2 + 2 * aEntry * d0));
    const lagLimit = V.maxEntryLagFrames * res.speedFirst * res.dtMedian + V.maxEntryLagM;
    if (d0 > lagLimit) fail('lateEntry');
    if (res.outlierRatio > V.maxOutlierRatio) fail('unstableTiming');
    // Phase 2（距離換算）で使う予定の値: 純転がりに入った時点の速度と位置。
    // スキッドが検出されなければ、スタートライン通過時の値をそのまま使う。
    res.rollSpeed = res.skid.detected ? res.skid.speedAtRoll : res.speedEntry;
    res.rollY = res.skid.detected ? res.skid.yAtRoll : 0;
  }

  // ---- 有効性の判定 ----
  const minTravel = res.stoppedInZone ? V.minTravelM : Math.max(V.minTravelM, V.minTravelRatio * L * k);
  if (res.travelM < minTravel) fail(track.endReason === 'lost' ? 'lostEarly' : 'shortTravel');
  if (track.endReason === 'sceneChanged') fail('sceneChanged');
  if (res.missRatio > V.maxMissRatio) fail('missRatio');
  if (res.maxGapSec > V.maxGapSec) fail('frameGap');
  if (res.fpsEff < V.minFps) fail('lowFps');
  if (res.lateralRmsM > V.maxLateralRmsM) fail('notStraight');
  if (res.fitRmsM !== undefined) {
    res.fitRmsLimitM = Math.max(V.maxFitRmsM, V.maxFitRmsSec * (res.speedMid || 0));
    if (res.fitRmsM > res.fitRmsLimitM) fail('poorFit');
    if (res.residualAutocorr > V.maxResidualAutocorr && res.fitRmsM > V.minRmsForAutocorrM) fail('poorFit');
    if (!(res.speedEntry >= V.minSpeed && res.speedEntry <= V.maxSpeed)) fail('speedRange');
    if (!(res.decel >= V.minDecel && res.decel <= V.maxDecel)) fail('decelRange');
    if (!(res.speedMidSE / Math.max(res.speedMid, 1e-6) <= V.maxSpeedRelSE)) fail('speedUncertain');
  }

  res.valid = res.reasons.length === 0;
  res.reasonText = res.reasons.map((r) => REASON_TEXT[r]);

  // ---- 信頼度（0〜100）: 有効な結果の中での相対的な品質の目安 ----
  if (res.valid) {
    let c = 100;
    c -= Math.min(25, (res.fitRmsM / res.fitRmsLimitM) * 25);
    c -= Math.min(15, (res.lateralRmsM / V.maxLateralRmsM) * 15);
    c -= Math.min(20, (res.missRatio / V.maxMissRatio) * 20);
    c -= Math.min(15, ((res.speedMidSE / res.speedMid) / V.maxSpeedRelSE) * 15);
    if (nAll < 16) c -= (16 - nAll) * 1.5;
    if (res.fpsEff < 45) c -= 8;
    if (track.endReason === 'lost') c -= 20;
    c -= Math.min(10, res.ambiguous * 2);
    c -= Math.min(20, res.outlierRatio * 150);
    res.confidence = Math.max(0, Math.round(c));
  }
  res.confidenceLabel = !res.valid ? '無効' : res.confidence >= 75 ? '高' : res.confidence >= 50 ? '中' : '低';

  // ログ保存用（後で Phase 2 の検証に使えるよう、生の点列を残す）
  res.samples = pts.map((p) => [Math.round(p.t * 1e4) / 1e4, Math.round(p.X * 1e4) / 1e4, Math.round(p.Y * 1e4) / 1e4]);
  return res;
}
