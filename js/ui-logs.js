// 計測ログ画面: 測定値の一覧、実際に転がった距離の記録、CSV 書き出し。

import { loadLogs, updateLog, deleteLog, clearLogs, logsToCSV } from './storage.js';
import { resultItems } from './ui-measure.js';

let app = null;
const el = (id) => document.getElementById(id);
const fmt = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '—');

function render() {
  const logs = loadLogs().slice().reverse();
  const valid = logs.filter((e) => e.result && e.result.valid).length;
  el('logSummary').textContent = logs.length ? `全 ${logs.length} 件（有効 ${valid} 件 / 無効 ${logs.length - valid} 件）。タップで詳細を開き、実際に転がった距離を記録できます。` : '';
  const list = el('logList');
  list.innerHTML = '';
  for (const e of logs) {
    const r = e.result || {};
    const li = document.createElement('li');
    const det = document.createElement('details');
    det.className = 'log-item';
    det.dataset.valid = String(!!r.valid);
    const sum = document.createElement('summary');
    const when = document.createElement('span');
    when.className = 'when';
    const d = new Date(e.at);
    when.textContent = `${d.toLocaleDateString('ja-JP')} ${d.toLocaleTimeString('ja-JP')}`;
    const speed = document.createElement('span');
    speed.className = 'speed';
    speed.textContent = r.valid ? `${fmt(r.speedEntry)} m/s` : `無効: ${(r.reasonText || [])[0] || ''}`;
    const tag = document.createElement('span');
    tag.className = 'tag' + (e.source === 'sim' ? ' sim' : '');
    tag.textContent = e.source === 'sim' ? 'シミュレーション' : r.valid ? `信頼度 ${r.confidenceLabel}` : 'カメラ';
    sum.append(when, speed, tag);
    det.append(sum);

    // 中身は開いたときに作る（件数が多くても軽くするため）
    det.addEventListener('toggle', () => {
      if (!det.open || det.querySelector('.log-body')) return;
      det.append(body(e));
    });
    li.append(det);
    list.append(li);
  }
}

function body(e) {
  const r = e.result || {};
  const box = document.createElement('div');
  box.className = 'log-body';
  if (!r.valid && r.reasonText && r.reasonText.length) {
    const p = document.createElement('p');
    p.className = 'result-reason';
    p.textContent = r.reasonText.join(' / ');
    box.append(p);
  }
  const grid = document.createElement('dl');
  grid.className = 'result-grid';
  grid.append(...resultItems(r, e.simTruth));
  box.append(grid);

  const form = document.createElement('div');
  form.className = 'form';
  const l1 = document.createElement('label');
  l1.textContent = '実際に転がった距離 (m)　スタートラインから停止位置まで';
  const dist = document.createElement('input');
  dist.type = 'number';
  dist.inputMode = 'decimal';
  dist.step = '0.01';
  dist.min = '0';
  dist.value = e.actualDistanceM ?? '';
  l1.append(dist);
  const l2 = document.createElement('label');
  l2.textContent = 'メモ';
  const memo = document.createElement('input');
  memo.type = 'text';
  memo.maxLength = 200;
  memo.value = e.memo || '';
  l2.append(memo);
  form.append(l1, l2);
  box.append(form);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const save = document.createElement('button');
  save.className = 'btn btn-small';
  save.textContent = '記録を保存';
  save.addEventListener('click', () => {
    const v = dist.value === '' ? null : Number(dist.value);
    if (v !== null && !(v >= 0 && v < 100)) { app.toast('距離は 0〜100m の数値で入力してください'); return; }
    updateLog(e.id, { actualDistanceM: v, memo: memo.value.trim() });
    e.actualDistanceM = v;
    e.memo = memo.value.trim();
    app.toast('保存しました');
  });
  const del = document.createElement('button');
  del.className = 'btn btn-small btn-danger';
  del.textContent = 'このログを削除';
  del.addEventListener('click', () => {
    if (!confirm('このログを削除しますか？')) return;
    deleteLog(e.id);
    render();
  });
  actions.append(save, del);
  box.append(actions);
  return box;
}

export function enter(a) {
  app = a;
  render();
}

export function leave() {}

el('logExportBtn').addEventListener('click', async () => {
  const logs = loadLogs();
  if (!logs.length) { app.toast('書き出すログがありません'); return; }
  const csv = logsToCSV(logs);
  const name = `putting-log-${new Date().toISOString().slice(0, 10)}.csv`;
  const file = new File([csv], name, { type: 'text/csv' });
  // iPhone では共有シート（ファイルに保存・メール等）を使う。使えない環境ではダウンロード。
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return; // 利用者がキャンセルした
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

el('logClearBtn').addEventListener('click', () => {
  if (!loadLogs().length) return;
  if (!confirm('すべての計測ログを削除します。元に戻せません。よろしいですか？')) return;
  clearLogs();
  render();
  app.toast('計測ログを削除しました');
});
