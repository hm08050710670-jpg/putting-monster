// 端末内保存（ログ・校正・設定）のテスト。Node には localStorage がないので、メモリ上の代替で動く。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadSettings, saveSettings, DEFAULT_SETTINGS, loadCalibration, saveCalibration, clearCalibration,
  loadLogs, addLog, updateLog, deleteLog, clearLogs, clearAll, logsToCSV,
} from '../js/storage.js';

const sample = (over = {}) => ({
  source: 'camera',
  timeSource: 'captureTime',
  zoneLengthM: 1.5,
  result: {
    valid: true, reasons: [], reasonText: [], confidence: 92, confidenceLabel: '高',
    speedEntry: 2.314, speedEntrySE: 0.004, speedMid: 2.1, speedExit: 1.9, speedMean: 2.1,
    decel: 0.55, decelSE: 0.03, skid: { detected: false }, rollSpeed: 2.314, rollY: 0,
    directionDeg: 0.4, travelM: 1.46, n: 40, fpsEff: 59.9, maxGapSec: 0.0167, missRatio: 0,
    fitRmsM: 0.0003, lateralRmsM: 0.0004, stoppedInZone: false, endReason: 'exit',
    samples: [[0, 0.15, 0.01], [0.0167, 0.15, 0.05]],
  },
  ...over,
});

test('設定: 既定値が読め、保存した値が戻る。欠けた項目は既定値で補われる', () => {
  clearAll();
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
  saveSettings({ ...DEFAULT_SETTINGS, source: 'sim', detect: { brightMin: 170 } });
  const s = loadSettings();
  assert.equal(s.source, 'sim');
  assert.equal(s.detect.brightMin, 170);
  assert.equal(s.detect.diffMin, DEFAULT_SETTINGS.detect.diffMin);
});

test('校正: カメラ用とシミュレーション用は別々に保存される', () => {
  clearAll();
  assert.equal(loadCalibration('camera'), null);
  saveCalibration('camera', { widthM: 0.3, points: [[1, 2]] });
  saveCalibration('sim', { widthM: 0.31 });
  assert.equal(loadCalibration('camera').widthM, 0.3);
  assert.equal(loadCalibration('sim').widthM, 0.31);
  clearCalibration('camera');
  assert.equal(loadCalibration('camera'), null);
  assert.equal(loadCalibration('sim').widthM, 0.31);
});

test('ログ: 追加・実測距離の記録・削除', () => {
  clearAll();
  const a = addLog(sample());
  const b = addLog(sample({ source: 'sim' }));
  assert.equal(loadLogs().length, 2);
  assert.equal(a.actualDistanceM, null);
  updateLog(a.id, { actualDistanceM: 2.85, memo: 'メモ' });
  assert.equal(loadLogs()[0].actualDistanceM, 2.85);
  assert.equal(loadLogs()[0].memo, 'メモ');
  assert.equal(updateLog('none', {}), null);
  deleteLog(b.id);
  assert.equal(loadLogs().length, 1);
  clearLogs();
  assert.equal(loadLogs().length, 0);
});

test('ログ: 件数の上限を超えたら古いものから消える', () => {
  clearAll();
  for (let i = 0; i < 305; i++) addLog(sample({ memo: String(i) }));
  const logs = loadLogs();
  assert.equal(logs.length, 300);
  assert.equal(logs[0].memo, '5');
  assert.equal(logs[299].memo, '304');
});

test('CSV: 見出し＋1行/件。カンマや引用符を含むメモも壊れない。シミュレーションは明記される', () => {
  clearAll();
  addLog(sample({ memo: 'a,b "c"' }));
  addLog(sample({ source: 'sim', result: { valid: false, reasons: ['frameGap'], reasonText: ['フレームの間隔が空きすぎています（処理落ち）'] } }));
  const csv = logsToCSV(loadLogs());
  assert.ok(csv.startsWith('﻿'), 'Excel 用の BOM');
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0].split(',').length, 31);
  assert.ok(lines[1].includes('2.314'));
  assert.ok(lines[1].includes('"a,b ""c"""'));
  assert.ok(lines[2].includes('シミュレーション'));
  assert.ok(lines[2].includes('無効'));
});
