// 音声案内（Phase 1 では計測結果の読み上げのみ。ゲーム用の効果音は Phase 4）。
// iPhone では、ユーザーの操作（タップ）の中で一度発声しないと音が出ない。
// そのため「計測開始」ボタンを押したときに unlock() を呼ぶ。

let enabled = true;
let unlocked = false;

export function setVoiceEnabled(v) {
  enabled = !!v;
  if (!enabled && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

export function voiceSupported() {
  return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

function pickVoice() {
  const vs = window.speechSynthesis.getVoices() || [];
  return vs.find((v) => v.lang === 'ja-JP') || vs.find((v) => v.lang && v.lang.startsWith('ja')) || null;
}

/** ユーザー操作の中で呼ぶ。以後、操作なしでも読み上げできるようにする。 */
export function unlock() {
  if (!voiceSupported() || unlocked) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
    unlocked = true;
  } catch { /* 無視 */ }
}

export function speak(text, { interrupt = true } = {}) {
  if (!enabled || !voiceSupported()) return;
  try {
    const synth = window.speechSynthesis;
    if (interrupt) synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.1;
    synth.speak(u);
  } catch { /* 無視 */ }
}

/** 2.31 -> 「2.31」を自然に読ませるための整形 */
export function speedText(v) {
  return v.toFixed(2).replace('.', '点');
}
