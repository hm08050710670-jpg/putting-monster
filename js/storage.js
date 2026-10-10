// 端末内保存（localStorage）。
// 画面表示から分離してある。将来オンライン保存（ランキング等）を足す場合は、
// このファイルと同じ関数を持つ別実装に差し替えればよい。

import { CONFIG } from './config.js';

const PREFIX = 'ggpm.';
const SCHEMA = 1;

// localStorage が使えない環境（プライベートブラウズの一部など）ではメモリ上に保持する
const memory = new Map();
function backend() {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    ls.setItem(PREFIX + 'probe', '1');
    ls.removeItem(PREFIX + 'probe');
    return ls;
  } catch {
    return null;
  }
}

function read(key, fallback) {
  try {
    const ls = backend();
    const raw = ls ? ls.getItem(PREFIX + key) : memory.get(key);
    if (raw == null) return fallback;
    const obj = JSON.parse(raw);
    if (!obj || obj.schema !== SCHEMA) return fallback;
    return obj.data;
  } catch {
    return fallback;
  }
}

function write(key, data) {
  const raw = JSON.stringify({ schema: SCHEMA, data });
  const ls = backend();
  try {
    if (ls) ls.setItem(PREFIX + key, raw);
    else memory.set(key, raw);
    return true;
  } catch {
    // 容量超過など
    return false;
  }
}

export const DEFAULT_SETTINGS = {
  source: 'camera', // 'camera' | 'sim'
  deviceId: '',
  preset: CONFIG.camera.defaultPreset,
  timeSource: 'auto', // 'auto' | 'captureTime' | 'mediaTime' | 'presentationTime' | 'now'
  voice: true,
  showMask: false,
  detect: {
    brightMin: CONFIG.detect.brightMin,
    diffMin: CONFIG.detect.diffMin,
    satMax: CONFIG.detect.satMax,
  },
};

export function loadSettings() {
  const s = read('settings', {});
  return { ...DEFAULT_SETTINGS, ...s, detect: { ...DEFAULT_SETTINGS.detect, ...(s.detect || {}) } };
}

export function saveSettings(s) {
  return write('settings', s);
}

/** 校正情報。映像ソース（カメラ / シミュレーション）ごとに別々に保存する。 */
export function loadCalibration(source) {
  return read('cal.' + source, null);
}

export function saveCalibration(source, cal) {
  return write('cal.' + source, cal);
}

export function clearCalibration(source) {
  const ls = backend();
  if (ls) ls.removeItem(PREFIX + 'cal.' + source);
  memory.delete('cal.' + source);
}

// ---- 計測ログ ----

export function loadLogs() {
  return read('logs', []);
}

function saveLogs(logs) {
  let list = logs.slice(-CONFIG.log.maxEntries);
  // 容量超過時は、古いログの生データ（点列）から削っていく
  while (!write('logs', list)) {
    const i = list.findIndex((e) => e.result && e.result.samples);
    if (i >= 0) list[i] = { ...list[i], result: { ...list[i].result, samples: undefined } };
    else if (list.length > 1) list = list.slice(1);
    else return false;
  }
  return true;
}

export function addLog(entry) {
  const logs = loadLogs();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const e = { id, at: new Date().toISOString(), actualDistanceM: null, memo: '', ...entry };
  logs.push(e);
  saveLogs(logs);
  return e;
}

export function updateLog(id, patch) {
  const logs = loadLogs();
  const i = logs.findIndex((e) => e.id === id);
  if (i < 0) return null;
  logs[i] = { ...logs[i], ...patch };
  saveLogs(logs);
  return logs[i];
}

export function deleteLog(id) {
  saveLogs(loadLogs().filter((e) => e.id !== id));
}

export function clearLogs() {
  write('logs', []);
}

/** すべての保存データを消す。 */
export function clearAll() {
  const ls = backend();
  if (ls) {
    const keys = [];
    for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.startsWith(PREFIX)) keys.push(k); }
    keys.forEach((k) => ls.removeItem(k));
  }
  memory.clear();
}

const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '');

/** ログを CSV にする（表計算ソフトでの検証用）。 */
export function logsToCSV(logs) {
  const head = [
    'id', '日時', '映像ソース', '有効', '無効理由', '信頼度',
    '入口速度(m/s)', '入口速度の推定誤差(m/s)', '区間中央速度(m/s)', '出口速度(m/s)', '平均速度(m/s)',
    '減速度(m/s^2)', '減速度の推定誤差', 'スキッド検出', '転がり開始速度(m/s)', '転がり開始位置(m)',
    '方向(度)', '観測距離(m)', 'フレーム数', '実効fps', '最大フレーム間隔(ms)', '見失い率',
    '当てはめ誤差(mm)', '横ずれ(mm)', '区間内で停止', '停止位置(m)', '終了理由',
    '時刻の取得方法', '観測区間長(m)', '実際に転がった距離(m)', 'メモ',
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = logs.map((e) => {
    const r = e.result || {};
    return [
      e.id, e.at, e.source === 'sim' ? 'シミュレーション' : 'カメラ', r.valid ? '有効' : '無効', (r.reasonText || []).join(' / '), r.valid ? r.confidence : '',
      num(r.speedEntry, 3), num(r.speedEntrySE, 3), num(r.speedMid, 3), num(r.speedExit, 3), num(r.speedMean, 3),
      num(r.decel, 3), num(r.decelSE, 3), r.skid && r.skid.detected ? 'あり' : 'なし', num(r.rollSpeed, 3), num(r.rollY, 3),
      num(r.directionDeg, 2), num(r.travelM, 3), r.n ?? '', num(r.fpsEff, 1), num(r.maxGapSec * 1000, 1), num(r.missRatio, 3),
      num(r.fitRmsM * 1000, 2), num(r.lateralRmsM * 1000, 2), r.stoppedInZone ? 'はい' : 'いいえ', num(r.stopY, 3), r.endReason || '',
      e.timeSource || '', num(e.zoneLengthM, 3), e.actualDistanceM ?? '', e.memo || '',
    ].map(esc).join(',');
  });
  // Excel で文字化けしないよう BOM を付ける
  return '﻿' + [head.map(esc).join(','), ...rows].join('\r\n');
}
