/**
 * NEON WAVE RADIO - 設定ファイル
 * GASのURLやバージョンはここだけ書き換えればOK
 */
const CONFIG = {
  APP_NAME: "NEON WAVE RADIO",
  VERSION: "1.0.0",

  // GAS Web アプリの URL（デプロイ後に貼り替え）
  GAS_URL: "https://script.google.com/macros/s/AKfycbw_aR-6dDuVc0mjwSHuHzynUnNM27i1CqOy2ayHE_VEpCIb1sYNQGndBLf9yQM4zu65/exec",

  // ライブルームのポーリング間隔（ミリ秒）
  ROOM_POLL_INTERVAL_MS: 3000,

  // アップロード上限（GAS の制約上 20MB 程度まで推奨）
  MAX_UPLOAD_MB: 20,

  // ルームでの音声投稿の最大秒数
  MAX_VOICE_SEC: 60,

  // 曲間AI DJ：何曲ごとにトークを挟むか
  DJ_EVERY_N_TRACKS: 3,

  // LocalStorage キー
  SESSION_KEY: "nwr_session",
  PREFS_KEY: "nwr_prefs",

  // ラジオの周波数表示（演出用）
  FREQUENCY: "FM 76.3",

  // AIパーソナリティの表示情報（プロンプト本体は Code.gs 側で管理）
  PERSONAS: [
    {
      id: "midnight",
      name: "ミッドナイト・クルーズ",
      role: "深夜ラジオDJ",
      desc: "低めの声で、ゆっくり語りかける夜のDJ",
      icon: "🌙",
      color: "#7c6cff"
    },
    {
      id: "morning",
      name: "モーニング・ドライブ",
      role: "ハイテンションFM DJ",
      desc: "明るく軽快に、朝を盛り上げる看板DJ",
      icon: "☀️",
      color: "#ffb547"
    },
    {
      id: "cafe",
      name: "リラックス・ラウンジ",
      role: "カフェ風トークパートナー",
      desc: "隠れ家カフェのバリスタと、ゆるっと会話",
      icon: "☕",
      color: "#3fe0c5"
    }
  ]
};
