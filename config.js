/**
 * NEON WAVE RADIO - 設定ファイル
 * GAS の URL やバージョンはここだけ書き換えれば OK
 *  ・GAS を「新しいデプロイ」で作り直して URL が変わったら GAS_URL を貼り替えてください
 *  ・画面の「設定 → 接続先（GAS URL）」から、この端末だけ一時的に別の URL に切り替えることもできます
 */
const CONFIG = {
  APP_NAME: "NEON WAVE RADIO",
  VERSION: "1.7.0",

  // GAS Web アプリの URL（デプロイ後に貼り替え）
  GAS_URL: "https://script.google.com/macros/s/AKfycbw_aR-6dDuVc0mjwSHuHzynUnNM27i1CqOy2ayHE_VEpCIb1sYNQGndBLf9yQM4zu65/exec",
  // 画面から切り替えた接続先を保存するキー（この端末だけ）
  GAS_URL_KEY: "nwr_gas_url",

  // 共有リンク（LINE などで送るリンク）の行き先。空なら今開いているページの URL を使います
  APP_URL: "https://kenken6291.github.io/minna-radio/",

  // ライブルームのポーリング間隔（ミリ秒）
  ROOM_POLL_INTERVAL_MS: 3000,

  // アップロード上限（GAS の制約上 20MB 程度まで推奨）
  MAX_UPLOAD_MB: 20,

  // ルームでの音声投稿の最大秒数
  MAX_VOICE_SEC: 60,

  // 曲間トーク：何曲ごとに挟むか（初期値。画面で変更できます）
  DJ_EVERY_N_TRACKS: 3,

  // AIとの対話：話し終わりとみなす無音の秒数（初期値。画面で 1〜10 秒に変更できます）
  CONVO_SILENCE_SEC: 3,
  CONVO_SILENCE_MAX: 10,
  // AIとの対話：1回の発言の最大秒数
  CONVO_MAX_SEC: 180,
  // AIとの対話：話し始めを待つ秒数（これを過ぎて無言なら聞き取りを終了）
  CONVO_WAIT_SEC: 30,

  // 音声の書き出し（初期値。書き出し画面で変更できます）
  EXPORT_DEFAULT: { format: "mp3", bitDepth: 16, bitrate: 192, sampleRate: 44100, channels: 2 },

  // LocalStorage キー
  SESSION_KEY: "nwr_session",
  PREFS_KEY: "nwr_prefs",
  PENDING_KEY: "nwr_pending",   // 共有リンク・招待リンクを、ログインが終わるまで覚えておく

  // ラジオの周波数表示（演出用）
  FREQUENCY: "FM 76.3"

  // ※ AIパーソナリティは v1.1.0 から GAS 側（標準5人＋画面で作成したもの）で管理します
  // ※ 利用規約の版は GAS 側（TERMS_VERSION）で管理します
};
