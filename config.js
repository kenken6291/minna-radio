/**
 * NEON WAVE RADIO - 設定ファイル
 * GASのURLやバージョンはここだけ書き換えればOK
 */
const CONFIG = {
  APP_NAME: "NEON WAVE RADIO",
  VERSION: "1.2.0",

  // GAS Web アプリの URL（デプロイ後に貼り替え）
  GAS_URL: "https://script.google.com/macros/s/AKfycbw_aR-6dDuVc0mjwSHuHzynUnNM27i1CqOy2ayHE_VEpCIb1sYNQGndBLf9yQM4zu65/exec",

  // ライブルームのポーリング間隔（ミリ秒）
  ROOM_POLL_INTERVAL_MS: 3000,

  // アップロード上限（GAS の制約上 20MB 程度まで推奨）
  MAX_UPLOAD_MB: 20,

  // ルームでの音声投稿の最大秒数
  MAX_VOICE_SEC: 60,

  // 曲間トーク：何曲ごとに挟むか（初期値。画面で変更できます）
  DJ_EVERY_N_TRACKS: 3,

  // AIとの対話：話し終わりとみなす無音の秒数（初期値。画面で 1〜5 秒に変更できます）
  CONVO_SILENCE_SEC: 2,
  // AIとの対話：1回の発言の最大秒数
  CONVO_MAX_SEC: 120,
  // AIとの対話：話し始めを待つ秒数（これを過ぎて無言なら聞き取りを終了）
  CONVO_WAIT_SEC: 15,

  // 音声の書き出し（初期値。書き出し画面で変更できます）
  EXPORT_DEFAULT: { format: "mp3", bitDepth: 16, bitrate: 192, sampleRate: 44100, channels: 2 },

  // LocalStorage キー
  SESSION_KEY: "nwr_session",
  PREFS_KEY: "nwr_prefs",

  // ラジオの周波数表示（演出用）
  FREQUENCY: "FM 76.3"

  // ※ AIパーソナリティは v1.1.0 から GAS 側（標準5人＋画面で作成したもの）で管理します
};
