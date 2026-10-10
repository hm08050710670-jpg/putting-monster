// 映像ソース。カメラ（実測）と、シミュレーション映像（合成）を同じ形で扱う。
//
// どちらも:
//   start()  -> { width, height }   映像の大きさ（px）
//   onFrame  = ({ t, timeSource, meta }) => {}   新しいフレームごとに呼ばれる。t は秒
//   drawable -> drawImage() に渡せる要素
//   stop()

import { CONFIG } from './config.js';
import { SimScene, presetCamera, makePutt, makeRng } from './core/simscene.js';

const TIME_SOURCES = ['captureTime', 'mediaTime', 'presentationTime', 'now'];

/** カメラのエラーを、利用者向けの案内文にする。 */
export function describeCameraError(err) {
  const name = err && err.name;
  if (!window.isSecureContext) {
    return { title: 'HTTPS が必要です', body: 'カメラは https:// で始まるアドレスでのみ使えます。GitHub Pages の公開アドレス（https://〜.github.io/〜）から開いてください。' };
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return { title: 'このブラウザではカメラを使えません', body: 'iPhone では Safari で開いてください。LINE や X などのアプリ内ブラウザでは動かないことがあります。' };
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return {
      title: 'カメラの使用が許可されていません',
      body: '次のいずれかで許可してください。\n① アドレスバー左の「ぁあ」（または ⋯）→「Webサイトの設定」→ カメラ →「許可」\n② iPhone の「設定」→「アプリ」→「Safari」→「カメラ」→「確認」または「許可」\n③ ホーム画面に追加したアプリの場合は、一度アプリを閉じて開き直し、表示される確認で「許可」\nその後、このページを再読み込みしてください。',
    };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return { title: 'カメラが見つかりません', body: 'この端末で使えるカメラが見つかりませんでした。カメラ設定で別のカメラを選ぶか、設定を「自動」に戻してください。' };
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return { title: 'カメラを開始できません', body: '他のアプリがカメラを使用中の可能性があります。他のアプリを閉じてから、もう一度お試しください。' };
  }
  return { title: 'カメラを開始できません', body: String((err && err.message) || err || '不明なエラー') };
}

export async function listCameras() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  const ds = await navigator.mediaDevices.enumerateDevices();
  return ds.filter((d) => d.kind === 'videoinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `カメラ ${i + 1}` }));
}

export class CameraSource {
  constructor(video) {
    this.kind = 'camera';
    this.video = video;
    this.stream = null;
    this.track = null;
    this.onFrame = null;
    this.onResize = null;
    this.running = false;
    this.timeSource = 'now';
    this.info = {};
    this._warm = [];
    this._resizeHandler = () => {
      const w = this.video.videoWidth, h = this.video.videoHeight;
      if (w && h && (w !== this.width || h !== this.height)) {
        this.width = w; this.height = h;
        if (this.onResize) this.onResize(w, h);
      }
    };
  }

  get drawable() { return this.video; }

  /**
   * @param {object} settings { deviceId, preset, timeSource }
   */
  async start(settings) {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const e = new Error('camera unavailable');
      e.name = 'Unavailable';
      throw e;
    }
    const p = CONFIG.camera.presets[settings.preset] || CONFIG.camera.presets[CONFIG.camera.defaultPreset];
    const base = settings.deviceId ? { deviceId: { exact: settings.deviceId } } : { facingMode: { ideal: 'environment' } };
    // 条件の厳しい順に試す。ideal 指定なので、端末が対応していなければ近い値に落ちる。
    const attempts = [
      { ...base, width: { ideal: p.width }, height: { ideal: p.height }, frameRate: { ideal: p.frameRate } },
      { ...base, width: { ideal: p.width }, height: { ideal: p.height } },
      { facingMode: { ideal: 'environment' } },
      true,
    ];
    let stream = null, lastErr = null, used = -1;
    for (let i = 0; i < attempts.length; i++) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: attempts[i], audio: false });
        used = i;
        break;
      } catch (e) {
        lastErr = e;
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) break;
      }
    }
    if (!stream) throw lastErr || new Error('getUserMedia failed');
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];

    // 60fps など、要求したフレームレートになっていなければ、もう一度だけ明示的に要求してみる
    let applyNote = '';
    try {
      const st = this.track.getSettings ? this.track.getSettings() : {};
      const caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
      if (st.frameRate && st.frameRate < p.frameRate - 1 && caps.frameRate && caps.frameRate.max >= p.frameRate) {
        await this.track.applyConstraints({ frameRate: p.frameRate, width: p.width, height: p.height });
        applyNote = 'applyConstraints でフレームレートを再要求';
      }
    } catch (e) {
      applyNote = 'フレームレートの再要求に失敗: ' + (e && e.name);
    }

    const v = this.video;
    v.setAttribute('playsinline', '');
    v.muted = true;
    v.srcObject = stream;
    await new Promise((resolve, reject) => {
      const ok = () => { v.removeEventListener('loadedmetadata', ok); resolve(); };
      if (v.readyState >= 1 && v.videoWidth) resolve();
      else v.addEventListener('loadedmetadata', ok);
      setTimeout(() => reject(new Error('映像の開始がタイムアウトしました')), 8000);
    });
    try { await v.play(); } catch { /* autoplay 制限。muted + playsinline なので通常は通る */ }
    this.width = v.videoWidth;
    this.height = v.videoHeight;
    v.addEventListener('resize', this._resizeHandler);

    this.info = {
      attempt: used,
      requested: p,
      settings: this.track.getSettings ? this.track.getSettings() : {},
      capabilities: this.track.getCapabilities ? this.track.getCapabilities() : null,
      label: this.track.label,
      applyNote,
      rvfc: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    };
    this.requestedTimeSource = settings.timeSource || 'auto';
    this._startLoop();
    return { width: this.width, height: this.height };
  }

  _startLoop() {
    this.running = true;
    this._warm = [];
    this._decided = false;
    const v = this.video;
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const step = (now, meta) => {
        if (!this.running) return;
        this._handle(now, meta || {});
        this._rvfcId = v.requestVideoFrameCallback(step);
      };
      this._rvfcId = v.requestVideoFrameCallback(step);
    } else {
      // 古い Safari 用。新しいフレームかどうかを currentTime の変化で判断する（時刻精度は低い）
      let last = -1;
      const step = (now) => {
        if (!this.running) return;
        if (v.currentTime !== last) {
          last = v.currentTime;
          this._handle(now, { mediaTime: v.currentTime });
        }
        this._rafId = requestAnimationFrame(step);
      };
      this._rafId = requestAnimationFrame(step);
    }
  }

  /** フレームの時刻候補（秒）。取得できないものは NaN。 */
  static times(now, meta) {
    return {
      captureTime: typeof meta.captureTime === 'number' ? meta.captureTime / 1000 : NaN,
      mediaTime: typeof meta.mediaTime === 'number' ? meta.mediaTime : NaN,
      presentationTime: typeof meta.presentationTime === 'number' ? meta.presentationTime / 1000 : NaN,
      now: now / 1000,
    };
  }

  /**
   * 最初の数フレームで、どの時刻情報を使うかを決める。
   * 優先順位: captureTime（カメラが撮影した時刻）> mediaTime > presentationTime > 受信時刻
   * Safari がどれを正しく返すかは実機でしか確認できないため、値が実際に進んでいるものを選ぶ。
   */
  _decide() {
    const req = this.requestedTimeSource;
    const advancing = (key) => {
      const a = this._warm.map((w) => w[key]);
      if (a.some((x) => !isFinite(x))) return false;
      let inc = 0;
      for (let i = 1; i < a.length; i++) if (a[i] - a[i - 1] > 0.001) inc++;
      return inc >= (a.length - 1) * 0.8;
    };
    this.availableTimeSources = TIME_SOURCES.filter(advancing);
    if (req !== 'auto' && this.availableTimeSources.includes(req)) this.timeSource = req;
    else this.timeSource = this.availableTimeSources[0] || 'now';
    this._decided = true;
  }

  _handle(now, meta) {
    const ts = CameraSource.times(now, meta);
    if (!this._decided) {
      this._warm.push(ts);
      if (this._warm.length >= 12) this._decide();
      return;
    }
    if (this.onFrame) this.onFrame({ t: ts[this.timeSource], timeSource: this.timeSource, times: ts, meta, now });
  }

  stop() {
    this.running = false;
    const v = this.video;
    if (this._rvfcId && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this._rvfcId);
    if (this._rafId) cancelAnimationFrame(this._rafId);
    v.removeEventListener('resize', this._resizeHandler);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    try { v.srcObject = null; } catch { /* 無視 */ }
  }
}

/** シミュレーション映像。実測ではない。 */
export class SimSource {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opt] { seed, width, height }
   */
  constructor(canvas, opt = {}) {
    this.kind = 'sim';
    this.canvas = canvas;
    this.width = opt.width || 960;
    this.height = opt.height || 540;
    this.rng = opt.seed != null ? makeRng(opt.seed) : Math.random;
    this.onFrame = null;
    this.running = false;
    this.timeSource = 'sim';
    this.truth = null; // 現在（直近）の打球の真値
  }

  get drawable() { return this.canvas; }

  async start() {
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d');
    this.cam = presetCamera('side', this.width, this.height);
    this.scene = new SimScene(this.cam);
    this.image = this.ctx.createImageData(this.width, this.height);
    this.info = { label: 'シミュレーション映像', settings: { width: this.width, height: this.height } };
    this.running = true;
    this._nextPutt(performance.now() / 1000 + 2.5);
    const step = (now) => {
      if (!this.running) return;
      const t = now / 1000;
      this._render(t);
      if (this.onFrame) this.onFrame({ t, timeSource: 'sim', meta: {}, now });
      this._rafId = requestAnimationFrame(step);
    };
    this._rafId = requestAnimationFrame(step);
    return { width: this.width, height: this.height };
  }

  _nextPutt(t0) {
    const r = this.rng;
    const v0 = 1.9 + r() * 2.3;
    const putt = makePutt({ v0, angleDeg: (r() * 2 - 1) * 1.5, start: [0.15 + (r() * 2 - 1) * 0.02, -0.5], t0 });
    this.putt = putt;
    const sLine = 0.5 / putt.dir[1];
    this.truth = { v0, lineSpeed: putt.at(putt.timeAtS(sLine)).v, aRoll: putt.aRoll, t0 };
  }

  _render(t) {
    const p = this.putt.at(t);
    // ボールが画面外へ出た、または止まってから 3 秒たったら、次の打球を用意する
    const gone = p.y > this.scene.o.zoneL + 0.9;
    if ((gone || p.phase === 'stopped') && !this._resetAt) this._resetAt = t + (gone ? 2.0 : 3.0);
    if (this._resetAt && t >= this._resetAt) {
      this._resetAt = null;
      this._nextPutt(t + 2.5);
    }
    this.scene.renderFrame(this.image.data, { t, ballAt: (tt) => this.putt.at(tt), exposure: 1 / 120 });
    this.ctx.putImageData(this.image, 0, 0);
  }

  /** シミュレーション映像の基準点（真値）。校正の初期値に使う。 */
  markerImagePoints(six) {
    return this.scene.markerImagePoints(six);
  }

  stop() {
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
  }
}

/**
 * カメラ診断: 一定時間フレームを受け取り、実際のフレームレートと、時刻情報ごとの間隔のばらつきを測る。
 * @returns {Promise<object>}
 */
export function runDiagnostics(source, durationMs = 3000) {
  return new Promise((resolve) => {
    const rec = [];
    const prev = source.onFrame;
    const t0 = performance.now();
    source.onFrame = (f) => {
      rec.push({ times: f.times || { now: f.now / 1000 }, presented: f.meta && f.meta.presentedFrames, now: f.now });
      if (performance.now() - t0 >= durationMs) {
        source.onFrame = prev;
        resolve(summarize(rec, source));
      }
    };
    setTimeout(() => {
      if (source.onFrame !== prev) {
        source.onFrame = prev;
        resolve(summarize(rec, source));
      }
    }, durationMs + 1500);
  });
}

function summarize(rec, source) {
  const out = { frames: rec.length, sources: {}, chosen: source.timeSource, info: source.info };
  if (rec.length < 3) return out;
  for (const key of TIME_SOURCES) {
    const a = rec.map((r) => r.times[key]).filter((x) => isFinite(x));
    if (a.length < rec.length) { out.sources[key] = null; continue; }
    const d = [];
    for (let i = 1; i < a.length; i++) d.push(a[i] - a[i - 1]);
    const mean = d.reduce((s, x) => s + x, 0) / d.length;
    const sd = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / d.length);
    const sorted = [...d].sort((x, y) => x - y);
    out.sources[key] = {
      fps: mean > 0 ? 1 / mean : 0,
      meanMs: mean * 1000,
      sdMs: sd * 1000,
      minMs: sorted[0] * 1000,
      maxMs: sorted[sorted.length - 1] * 1000,
      medianMs: sorted[sorted.length >> 1] * 1000,
      nonIncreasing: d.filter((x) => x <= 0).length,
    };
  }
  const pf = rec.map((r) => r.presented).filter((x) => typeof x === 'number');
  if (pf.length === rec.length) {
    out.presentedDelta = pf[pf.length - 1] - pf[0];
    out.skipped = out.presentedDelta - (rec.length - 1);
  }
  return out;
}
