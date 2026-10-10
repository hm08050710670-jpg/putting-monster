// ボールの追跡。候補点（マット面上の実寸座標）を時系列でつなぎ、1打ぶんの軌跡を作る。
//
// 状態: 'waiting'（打球待ち） -> 'tracking'（追跡中） -> 'done'（終了。analysis.js で評価）
//
// 誤検出への対策:
//  - 追跡開始には「スタート側から +y 方向へ、一定以上の速さで、連続 N フレーム」動くことを要求
//  - 追跡中は、直前の速度から予測した位置の近くにある候補だけを採用（ゲート）
//  - 進行方向の急変、速度の急増は不採用
//  - 同時に複数の仮追跡を持ち、最初に条件を満たしたものを採用（止まっている白い物体に引きずられない）

const MAX_TENTATIVES = 12;

export class ShotTracker {
  /**
   * @param {{widthM:number, lengthM:number}} zone
   * @param {object} cfg CONFIG
   */
  constructor(zone, cfg) {
    this.zone = zone;
    this.cfg = cfg;
    this.reset();
  }

  reset() {
    this.state = 'waiting';
    this.tentatives = [];
    this.points = [];
    this.vel = null; // {vx, vy}
    this.misses = 0; // 追跡中に検出できなかったフレームの累計
    this.missRun = 0; // 連続して検出できていないフレーム数
    this.ambiguous = 0; // ゲート内に複数候補があったフレーム数
    this.lowSince = null;
    this.endReason = null;
    this.startT = null;
  }

  inExtendedZone(X, Y) {
    const t = this.cfg.track;
    return (
      X >= -t.marginAcrossM && X <= this.zone.widthM + t.marginAcrossM &&
      Y >= -t.marginAlongM && Y <= this.zone.lengthM + t.marginAlongM
    );
  }

  /** 1歩ぶんの動きが、打球として妥当か。prev -> cur */
  _stepOk(prev, cur, vel) {
    const T = this.cfg.track;
    const dt = cur.t - prev.t;
    if (dt <= 0) return null;
    const dx = cur.X - prev.X, dy = cur.Y - prev.Y;
    const dist = Math.hypot(dx, dy);
    const speed = dist / dt;
    if (dy <= 0) return null; // 逆方向・横方向は不可
    if (speed < T.minStartSpeed || speed > this.cfg.validity.maxSpeed) return null;
    if (Math.abs(dx) > dy) return null; // 進行方向から45度以上それている
    let err = 0;
    if (vel) {
      const px = prev.X + vel.vx * dt, py = prev.Y + vel.vy * dt;
      err = Math.hypot(cur.X - px, cur.Y - py);
      const vs = Math.hypot(vel.vx, vel.vy);
      if (err > T.gateBaseM + T.gateSpeedFactor * vs * dt) return null;
      if (speed > vs * T.maxSpeedUpRatio + 0.3) return null;
    }
    return { vx: dx / dt, vy: dy / dt, err, speed };
  }

  /**
   * @param {Array<{X:number,Y:number,score:number}>} cands その時刻の候補（形状フィルタ済み）
   * @param {number} t 秒
   * @returns {string} 現在の状態
   */
  update(cands, t) {
    if (this.state === 'done') return this.state;
    const inZone = cands.filter((c) => this.inExtendedZone(c.X, c.Y));
    if (this.state === 'waiting') this._updateWaiting(inZone, t);
    else this._updateTracking(inZone, t);
    return this.state;
  }

  _updateWaiting(cands, t) {
    const T = this.cfg.track;
    const used = new Set();
    const next = [];
    for (const tr of this.tentatives) {
      const last = tr.pts[tr.pts.length - 1];
      let best = null;
      cands.forEach((c, i) => {
        const cur = { t, X: c.X, Y: c.Y };
        const st = this._stepOk(last, cur, tr.vel);
        if (!st) return;
        // 2点目は速い方よりも「形がボールらしい」ものを、3点目以降は予測に近いものを優先
        const cost = tr.vel ? st.err : 1 - c.score;
        if (!best || cost < best.cost) best = { cost, cur, st, i };
      });
      if (best) {
        used.add(best.i);
        tr.pts.push(best.cur);
        tr.vel = { vx: best.st.vx, vy: best.st.vy };
        tr.miss = 0;
        if (tr.pts.length >= T.confirmFrames) {
          this.points = tr.pts;
          this.vel = tr.vel;
          this.tentatives = [];
          this.state = 'tracking';
          this.startT = tr.pts[0].t;
          this.missRun = 0;
          return;
        }
        next.push(tr);
      } else {
        tr.miss++;
        // 1点だけの仮追跡は、次のフレームで動きが確認できなければ捨てる
        if (tr.pts.length >= 2 && tr.miss <= 2) next.push(tr);
      }
    }
    // どの仮追跡にも使われなかった候補から、新しい仮追跡を始める（スタート側 70% まで）
    cands.forEach((c, i) => {
      if (used.has(i)) return;
      if (c.Y > this.zone.lengthM * 0.7) return;
      next.push({ pts: [{ t, X: c.X, Y: c.Y }], vel: null, miss: 0 });
    });
    this.tentatives = next.slice(-MAX_TENTATIVES);
  }

  _updateTracking(cands, t) {
    const T = this.cfg.track;
    const last = this.points[this.points.length - 1];
    const dt = t - last.t;
    if (dt <= 0) return;
    const vs = Math.hypot(this.vel.vx, this.vel.vy);
    const px = last.X + this.vel.vx * dt, py = last.Y + this.vel.vy * dt;
    const gate = T.gateBaseM + T.gateSpeedFactor * vs * dt;
    const cosMax = Math.cos((T.maxTurnDeg * Math.PI) / 180);

    let best = null, inGate = 0;
    for (const c of cands) {
      const err = Math.hypot(c.X - px, c.Y - py);
      if (err > gate) continue;
      const dx = c.X - last.X, dy = c.Y - last.Y;
      const dist = Math.hypot(dx, dy);
      const speed = dist / dt;
      if (speed > vs * T.maxSpeedUpRatio + 0.3) continue;
      // ある程度動いている間は、後戻りと急な方向転換を認めない
      if (dist > 0.01 && vs > 0.3) {
        const cos = (dx * this.vel.vx + dy * this.vel.vy) / (dist * vs);
        if (cos < cosMax) continue;
      }
      inGate++;
      if (!best || err < best.err) best = { err, c, dx, dy, speed };
    }

    if (best) {
      if (inGate > 1) this.ambiguous++;
      this.points.push({ t, X: best.c.X, Y: best.c.Y });
      // 速度は直近の値と平滑化（1フレームの検出誤差で予測が暴れないように）
      const nvx = best.dx / dt, nvy = best.dy / dt;
      this.vel = { vx: 0.5 * this.vel.vx + 0.5 * nvx, vy: 0.5 * this.vel.vy + 0.5 * nvy };
      this.missRun = 0;
      this.missSince = null;
      // 停止判定
      if (best.speed < T.stopSpeed) {
        if (this.lowSince === null) this.lowSince = t;
        else if (t - this.lowSince >= T.stopHoldSec) return this._end('stopped');
      } else {
        this.lowSince = null;
      }
      if (t - this.startT > T.maxTrackSec) return this._end('timeout');
    } else {
      this.misses++;
      this.missRun++;
      if (this.missRun > T.maxMissFrames || dt > T.maxMissSec) {
        // 予測位置が測定範囲の外なら「通過して出ていった」、内側なら「見失った」
        const W = this.zone.widthM, L = this.zone.lengthM;
        if (py >= L) return this._end('exit');
        if (px < 0 || px > W) return this._end('exitSide');
        return this._end('lost');
      }
    }
  }

  _end(reason) {
    // 末尾の「検出できなかったフレーム」は軌跡の途中の欠落ではないので数えない
    this.misses = Math.max(0, this.misses - this.missRun);
    this.endReason = reason;
    this.state = 'done';
  }

  /** 外部要因（場面の変化など）で追跡を打ち切る。 */
  abort(reason) {
    if (this.state === 'tracking') this._end(reason);
  }

  getTrack() {
    return { points: this.points, misses: this.misses, ambiguous: this.ambiguous, endReason: this.endReason };
  }
}
