// アプリ全体の制御: 画面の切り替え、映像ソースの管理、映像表示部（ステージ）の共有。

import { APP_VERSION, CONFIG } from './config.js';
import { loadSettings, saveSettings, loadCalibration, loadLogs } from './storage.js';
import { CameraSource, SimSource, describeCameraError } from './sources.js';
import { setVoiceEnabled } from './voice.js';
import * as measure from './ui-measure.js';
import * as calibrate from './ui-calibrate.js';
import * as settingsUI from './ui-settings.js';
import * as logsUI from './ui-logs.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// 映像ソースを使う画面。これ以外へ移動したらカメラを止める（電池と発熱の節約）
const SOURCE_SCREENS = new Set(['measure', 'calibrate', 'settings']);

const app = {
  $, $$,
  settings: loadSettings(),
  source: null,
  sourceKey: '',
  screen: 'title',
  stage: {
    el: $('#stage'),
    video: $('#video'),
    sim: $('#simCanvas'),
    still: $('#stillCanvas'),
    overlay: $('#overlay'),
    loupe: $('#loupe'),
    badge: $('#stageBadge'),
  },

  saveSettings() { saveSettings(this.settings); },

  toast(msg, ms = 2400) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  },

  /** 映像表示部を、指定した画面の枠へ移す。 */
  mountStage(screenName) {
    const slot = $(`[data-screen="${screenName}"] [data-stage-slot]`);
    slot.appendChild(this.stage.el);
    this.stage.el.hidden = false;
    this.stage.still.hidden = true;
    this.stage.loupe.hidden = true;
    this.stage.el.classList.remove('editing');
    this.layoutStage();
  },

  /**
   * 映像表示部の大きさを決める。
   * 方針: 映像の縦横比を保ったまま、画面の幅いっぱいまで大きくする。ただし
   * 「上のバー」と「下の操作ドック」の間に全体が収まる高さまで（スクロールせずに映像全体が見えるように）。
   *
   * 大きさは px で直接指定する。CSS の aspect-ratio に任せると、iPhone の Safari で
   * 映像の縦横比が変わったときに高さだけ古いまま残り、映像が潰れて表示されたため。
   */
  layoutStage() {
    const src = this.source;
    const st = this.stage;
    const screenEl = st.el.closest('.screen');
    const slot = st.el.parentElement;
    if (!screenEl || !slot || st.el.hidden) return;
    const arn = src && src.width ? src.width / src.height : 16 / 9;

    // いま表示されている操作ドック（縦向きでは画面下に固定されている）
    const dock = [...screenEl.querySelectorAll('[data-dock]')].find((d) => d.getClientRects().length > 0);
    const fixed = !!dock && getComputedStyle(dock).position === 'fixed';
    const dockH = fixed ? dock.getBoundingClientRect().height : 0;
    screenEl.style.setProperty('--dock-h', `${Math.round(dockH)}px`);

    const bar = screenEl.querySelector('.bar');
    const barH = bar ? bar.getBoundingClientRect().height : 48;
    const META_H = 34; // 映像の下の 1 行（解像度や fps の表示）
    const availW = Math.max(120, slot.clientWidth);
    const maxH = Math.max(160, window.innerHeight - barH - dockH - META_H - 20);
    const w = Math.round(Math.min(availW, maxH * arn));
    const h = Math.round(w / arn);
    st.el.style.width = `${w}px`;
    st.el.style.height = `${h}px`;

    // 重ね描きの画素数（3倍密度で描いても見た目はほぼ変わらず、処理だけ重くなるので 2 倍まで）
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(w * dpr));
    const ch = Math.max(1, Math.round(h * dpr));
    if (st.overlay.width !== cw || st.overlay.height !== ch) { st.overlay.width = cw; st.overlay.height = ch; }
  },

  /** 映像座標(px) -> 重ね描きキャンバスの座標 への倍率 */
  get viewScale() {
    return this.source && this.source.width ? this.stage.overlay.width / this.source.width : 1;
  },

  /**
   * 現在の設定に合った映像ソースを開始して返す（すでに動いていれば再利用）。
   * 失敗した場合は例外を投げる（err.guide に利用者向けの案内が入る）。
   */
  async ensureSource() {
    const s = this.settings;
    const key = s.source === 'sim' ? 'sim' : `camera|${s.deviceId}|${s.preset}|${s.timeSource}`;
    if (this.source && this.source.running && this.sourceKey === key) return this.source;
    this.releaseSource();
    const st = this.stage;
    let src;
    if (s.source === 'sim') {
      const seed = new URLSearchParams(location.search).get('simseed');
      src = new SimSource(st.sim, seed != null ? { seed: Number(seed) } : {});
    } else {
      src = new CameraSource(st.video);
    }
    st.sim.hidden = s.source !== 'sim';
    st.video.hidden = s.source === 'sim';
    st.badge.hidden = s.source !== 'sim';
    try {
      await src.start(s);
    } catch (err) {
      src.stop();
      err.guide = describeCameraError(err);
      throw err;
    }
    this.source = src;
    this.sourceKey = key;
    src.onResize = () => { this.layoutStage(); this.reenter(); };
    this.layoutStage();
    return src;
  },

  releaseSource() {
    if (this.source) {
      this.source.onFrame = null;
      this.source.stop();
      this.source = null;
      this.sourceKey = '';
    }
  },

  /** 設定変更後など、次回 ensureSource で作り直させる。 */
  invalidateSource() { this.releaseSource(); },

  async go(name) {
    const from = this.screen;
    if (screens[from] && screens[from].leave) await screens[from].leave(this);
    if (!SOURCE_SCREENS.has(name)) this.releaseSource();
    $$('.screen').forEach((el) => { el.hidden = el.dataset.screen !== name; });
    this.screen = name;
    window.scrollTo(0, 0);
    if (screens[name] && screens[name].enter) await screens[name].enter(this);
  },

  /** 現在の画面を入り直す（映像の大きさが変わった、アプリが前面に戻った等）。 */
  async reenter() {
    if (this._reentering) return;
    this._reentering = true;
    try { await this.go(this.screen); } finally { this._reentering = false; }
  },

  /** カメラのエラー案内を表示する。 */
  showCameraError(el, err) {
    const g = err.guide || describeCameraError(err);
    el.hidden = false;
    el.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = g.title;
    el.append(b, document.createTextNode(g.body));
    const btn = document.createElement('button');
    btn.className = 'btn btn-small';
    btn.textContent = 'シミュレーション映像で動作を確認する';
    btn.addEventListener('click', () => {
      this.settings.source = 'sim';
      this.saveSettings();
      this.reenter();
    });
    el.append(btn);
  },
};

const titleScreen = {
  enter(app) {
    const s = app.settings;
    const cal = loadCalibration(s.source);
    const logs = loadLogs();
    const el = $('#titleStatus');
    el.innerHTML = '';
    const line = (html, warn) => { const p = document.createElement('p'); p.innerHTML = html; if (warn) p.className = 'warn'; el.append(p); };
    line(`映像ソース：<b>${s.source === 'sim' ? 'シミュレーション映像（実測ではありません）' : 'カメラ'}</b>`, s.source === 'sim');
    if (cal) {
      const d = new Date(cal.savedAt);
      line(`キャリブレーション：<b>設定済み</b>（${d.toLocaleDateString('ja-JP')} ${d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}）`);
    } else {
      line('キャリブレーション：<b>未設定</b>（測定の前に必要です）', true);
    }
    line(`計測ログ：<b>${logs.length}</b> 件`);
    $('#versionText').textContent = `v${APP_VERSION}`;
  },
};

const screens = {
  title: titleScreen,
  measure,
  calibrate,
  settings: settingsUI,
  logs: logsUI,
  howto: {},
};

// ---- 起動 ----
setVoiceEnabled(app.settings.voice);

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (b) app.go(b.dataset.go);
});

// 画面の大きさ・向き、または操作ドックの高さが変わったら、映像表示部の大きさを決め直す
function relayout() {
  app.layoutStage();
  const sc = screens[app.screen];
  if (sc && sc.onLayout) sc.onLayout(app);
}
window.addEventListener('resize', relayout);
window.addEventListener('orientationchange', () => setTimeout(relayout, 250));
const dockObserver = new ResizeObserver(relayout);
$$('[data-dock]').forEach((d) => dockObserver.observe(d));

// アプリが背面に回るとカメラは止められる。計測を止め、前面に戻ったら映像を取り直す。
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    const sc = screens[app.screen];
    if (sc && sc.onHidden) sc.onHidden(app);
  } else if (SOURCE_SCREENS.has(app.screen) && app.screen !== 'settings') {
    app.invalidateSource();
    app.reenter();
  }
});

// PWA: オフラインでも開けるようにする（https または localhost のときのみ）
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* 登録できなくてもアプリは動く */ });
}

window.__app = app; // 検証・デバッグ用
app.cfg = CONFIG;
app.go('title');
