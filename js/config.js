// GOLF GUTS PUTTING MONSTERS - 設定ファイル
// 数値を後から調整しやすいよう、しきい値・既定値はすべてここに集約する。
// （ゲーム用の HP・ダメージ・ステージ設定は Phase 3 でこのファイルに追加する）

export const APP_VERSION = '0.1.0-phase1';

export const CONFIG = {
  ball: {
    // ゴルフ規則上の最小直径 42.67mm を使用
    diameterM: 0.04267,
    radiusM: 0.021335,
  },

  // 校正（キャリブレーション）の初期値。実寸は校正画面で入力し直す。
  calibration: {
    defaultWidthCm: 30, // 左右の目印の間隔
    defaultLengthCm: 150, // スタート側とゴール側の目印の間隔（観測区間）
    defaultCameraHeightCm: 100, // レンズのマット面からの高さ
    minLengthCm: 30,
    maxLengthCm: 400,
    minWidthCm: 10,
    maxWidthCm: 200,
    minCameraHeightCm: 20,
    maxCameraHeightCm: 400,
  },

  camera: {
    // 上から順に試す。60fps を第一候補にするが、取得できる保証はない。
    presets: {
      '720p60': { width: 1280, height: 720, frameRate: 60 },
      '720p30': { width: 1280, height: 720, frameRate: 30 },
      '1080p60': { width: 1920, height: 1080, frameRate: 60 },
      '1080p30': { width: 1920, height: 1080, frameRate: 30 },
      '480p60': { width: 640, height: 480, frameRate: 60 },
    },
    defaultPreset: '720p60',
    // 画像処理用に縮小する際の最大幅（px）。大きいほど精密だが重い。
    procMaxWidth: 640,
  },

  detect: {
    // 輝度(0-255)がこの値以上を「白っぽい」とみなす（設定画面で変更可）
    brightMin: 150,
    // max(R,G,B)-min(R,G,B) がこの値以下を「無彩色に近い」とみなす
    satMax: 80,
    // 背景より この値以上 明るくなった画素だけを「動いたボール候補」とする
    diffMin: 28,
    // 背景取得に使うフレーム数
    bgFrames: 8,
    // 背景取得中に許容するフレーム間の平均輝度差（これ以上は「画面が動いている」）
    bgStableMaxDiff: 4.0,
    // 待機中の背景追従率（照明のゆっくりした変化に追従）
    bgAlpha: 0.02,
    // 待機中、候補画素も背景へ取り込む率（止まった白い物体を約1秒で背景化）
    bgAlphaMasked: 0.05,
    // マスク面積が測定範囲のこの割合を超えたら「場面が変わった」として無効
    sceneChangeRatio: 0.3,
    // 形状フィルタ（期待されるボール直径に対する比）
    minorMinRatio: 0.45,
    minorMaxRatio: 1.9,
    majorMaxRatio: 5.0, // 進行方向のブレ（モーションブラー）を許容
    areaMinRatio: 0.25,
    areaMaxRatio: 6.0,
    fillMin: 0.55, // 面積 / (楕円とみなした面積)
    fillMax: 1.45,
    minAreaPx: 6,
  },

  track: {
    // 測定範囲の外側にどこまで追跡を広げるか（m）
    marginAlongM: 0.10,
    marginAcrossM: 0.08,
    // 追跡開始とみなす最低速度（m/s）
    minStartSpeed: 0.20,
    // 追跡確定に必要な連続フレーム数
    confirmFrames: 3,
    // 予測位置からの許容ずれ
    gateBaseM: 0.04,
    gateSpeedFactor: 0.35,
    // 進行方向の急変を許容する角度（度）
    maxTurnDeg: 30,
    // フレーム間で許容する速度増加率（ボールは加速しないはず）
    maxSpeedUpRatio: 1.35,
    // 見失い許容
    maxMissFrames: 6,
    maxMissSec: 0.15,
    // 停止判定
    stopSpeed: 0.05,
    stopHoldSec: 0.30,
    maxTrackSec: 8.0,
    // 計測後、次の待機に戻るまでの時間
    cooldownSec: 1.5,
  },

  // 測定結果を有効とみなす条件
  validity: {
    minFrames: 8,
    minTravelM: 0.40,
    minTravelRatio: 0.5, // 観測区間長に対する最低移動割合（停止した場合は除く）
    maxMissRatio: 0.30,
    maxGapSec: 0.10,
    maxLateralRmsM: 0.012,
    // 当てはめ誤差の上限。距離での上限と、時間に換算した上限（× 速度）の大きい方を使う。
    // 速い球ほど、同じ時刻誤差でも位置の誤差は大きくなるため。
    maxFitRmsM: 0.003,
    maxFitRmsSec: 0.0015,
    // 残差が滑らかに偏っている（＝動きが想定したモデルに合っていない）とみなす条件
    maxResidualAutocorr: 0.7,
    minRmsForAutocorrM: 0.0015,
    minSpeed: 0.20,
    maxSpeed: 8.0,
    minDecel: -0.6, // これより強く「加速」していたら異常
    maxDecel: 9.0,
    maxSpeedRelSE: 0.04, // 速度の推定標準誤差がこれを超えたら無効
    minFps: 20,
    maxOutlierRatio: 0.15, // 外れ値として取り除いた点がこの割合を超えたら無効
    // 最初のサンプルがスタートラインからこれ以上離れていたら無効（フレーム数換算 + 固定分 m）
    maxEntryLagFrames: 2.5,
    maxEntryLagM: 0.03,
  },

  // 外れ値に強い当てはめ（1フレームだけ時刻がずれる、といった突発的な誤差への対策）
  robust: {
    k: 5, // ばらつきの何倍を外れ値とみなすか
    minThrM: 0.0012, // これ未満の残差は外れ値とみなさない (m)
    maxFrac: 0.2, // 外れ値として取り除ける点の最大割合
    maxIter: 8,
  },

  // スキッド（滑り）→ 純転がりの切り替わり検出
  skid: {
    minPointsFirst: 5, // スキッド区間に必要な最低サンプル数（少ないと外れ値を滑りと誤認する）
    minPointsSecond: 6, // 転がり区間に必要な最低サンプル数
    minDecelDrop: 1.0, // 前半の減速が後半より この値(m/s^2)以上大きいこと
    minFirstDecel: 1.5,
    maxFirstDecel: 7.0, // 滑り摩擦として物理的にありうる上限（摩擦係数 約0.7 相当）
    minSpeedRatio: 0.6, // 転がり開始速度 / 入口速度 の下限（回転なしで打ち出しても 5/7=0.71）
    minBicGain: 10.0, // 1区間モデルに対する BIC の改善量
    // 滑りの検出が、先頭の 1〜2 点だけに依存していないかを確かめる（その点を抜いて再計算）。
    // 抜いても入口速度がこの割合以内で一致すれば本物の滑りとみなす。
    looTolerance: 0.02,
  },

  log: {
    maxEntries: 300,
  },
};

export const G = 9.80665;
