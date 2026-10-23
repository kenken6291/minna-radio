/**
 * NEON WAVE RADIO - Google Apps Script バックエンド
 * Version 1.2.0
 *   v1.1.0 パーソナリティ管理 / 台本の掛け合い（複数話者TTS） / AIとの対話（文字起こし＋声変換）
 *   v1.2.0 楽曲ライブラリ（1人20セット） / 台本の保存（1人50セット） / 読み上げに指示文を入れない
 *   v1.3.0 番組表（曲No・掛け合いNoの順番で放送）を保存
 *   v1.4.0 ポッドキャストのエピソード並び順（番組ごと・全員共通）と聞く順（1人ずつ）を保存
 *
 * スクリプトプロパティ（プロジェクトの設定 > スクリプト プロパティ）
 *   GEMINI_API_KEY      : Gemini API キー（必須）
 *   GEMINI_TEXT_MODEL   : 台本生成モデルID（例: gemini-3.8-flash）
 *   GEMINI_TTS_MODEL    : 音声合成モデルID（例: gemini-3.8-flash-tts）
 *   PEPPER              : パスワードハッシュ用の秘密文字列（必須・長めのランダム文字列）
 *   ADMIN_EMAILS        : 管理者メール（カンマ区切り、任意。未設定なら最初の登録者が管理者）
 *   SPREADSHEET_ID      : 任意。未設定ならコンテナバインドのスプレッドシートを使用
 *   DRIVE_FOLDER_ID     : 任意。未設定なら setup() で自動作成
 *   SHOW_TEMP_PASSWORD  : "true" で仮パスワードを画面にも表示（テスト用）
 */

const APP_VERSION = '1.4.0';
const APP_NAME = 'NEON WAVE RADIO';
const HASH_ROUNDS = 300;
const SESSION_DAYS = 30;
const MAX_FAIL = 5;
const LOCK_MINUTES = 15;
const ACTIVE_WINDOW_MS = 60 * 1000;      // ルーム在席判定
const TOUCH_INTERVAL_MS = 15 * 1000;     // lastSeen 更新間隔
const ROOM_IDLE_CLOSE_MS = 30 * 60 * 1000; // 無人30分で自動クローズ
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_VOICE_BYTES = 5 * 1024 * 1024;
const MAX_STT_BYTES = 12 * 1024 * 1024;        // 文字起こし用の音声（base64前）
const MAX_CUSTOM_PERSONAS = 20;                // 1人あたりのパーソナリティ上限
const PERSONA_CACHE_SEC = 120;
const MAX_LIBRARIES = 20;                      // 楽曲ライブラリ：1人あたりのセット数
const MAX_LIBRARY_TRACKS = 500;                // 1セットの曲数
const MAX_SCRIPTS = 50;                        // 台本：1人あたりのセット数
const MAX_SCRIPT_CHARS = 20000;                // 台本1セットの文字数
const MAX_SHOW_EPISODES = 1000;                // 並び順に入れられるエピソード数

const HEAD = {
  Users:        ['userId', 'email', 'nickname', 'passwordHash', 'salt', 'mustChange', 'role', 'createdAt', 'lastLogin', 'failCount', 'lockedUntil'],
  Sessions:     ['token', 'userId', 'createdAt', 'expiresAt'],
  Tracks:       ['id', 'kind', 'source', 'title', 'artist', 'showName', 'description', 'url', 'fileId', 'youtubeId', 'mimeType', 'aiGenerated', 'ownerId', 'ownerName', 'createdAt'],
  Rooms:        ['id', 'title', 'topic', 'persona', 'hostId', 'hostName', 'status', 'createdAt', 'updatedAt'],
  RoomMembers:  ['roomId', 'userId', 'nickname', 'role', 'hand', 'lastSeen'],
  RoomMessages: ['id', 'roomId', 'userId', 'nickname', 'type', 'text', 'fileId', 'mimeType', 'persona', 'createdAt'],
  Personas:     ['id', 'name', 'icon', 'color', 'gender', 'voice', 'role', 'description', 'style', 'prompt', 'ownerId', 'ownerName', 'createdAt', 'updatedAt'],
  Libraries:    ['id', 'ownerId', 'name', 'trackIds', 'createdAt', 'updatedAt'],
  Scripts:      ['id', 'ownerId', 'title', 'text', 'cast', 'createdAt', 'updatedAt'],
  Programs:     ['ownerId', 'items', 'updatedAt'],
  ShowOrders:   ['showName', 'trackIds', 'updatedBy', 'updatedAt'],
  ListenOrders: ['ownerId', 'showName', 'mode', 'trackIds', 'updatedAt']
};

/* ============================================================
 *  Gemini TTS の声（gender は目安）
 * ============================================================ */
const VOICES = [
  { name: 'Zephyr', gender: 'female', desc: '明るい' },
  { name: 'Kore', gender: 'female', desc: 'しっかり' },
  { name: 'Leda', gender: 'female', desc: '若々しい' },
  { name: 'Aoede', gender: 'female', desc: '軽やか' },
  { name: 'Callirrhoe', gender: 'female', desc: 'おおらか' },
  { name: 'Autonoe', gender: 'female', desc: 'きらきら' },
  { name: 'Despina', gender: 'female', desc: 'なめらか' },
  { name: 'Erinome', gender: 'female', desc: 'クリア' },
  { name: 'Laomedeia', gender: 'female', desc: '陽気' },
  { name: 'Achernar', gender: 'female', desc: 'やわらか' },
  { name: 'Gacrux', gender: 'female', desc: '大人っぽい' },
  { name: 'Pulcherrima', gender: 'female', desc: 'はきはき' },
  { name: 'Vindemiatrix', gender: 'female', desc: '穏やか' },
  { name: 'Sulafat', gender: 'female', desc: '温かい' },
  { name: 'Puck', gender: 'male', desc: '弾む' },
  { name: 'Charon', gender: 'male', desc: '知的' },
  { name: 'Fenrir', gender: 'male', desc: '元気' },
  { name: 'Orus', gender: 'male', desc: '落ち着き' },
  { name: 'Enceladus', gender: 'male', desc: '吐息まじり' },
  { name: 'Iapetus', gender: 'male', desc: 'クリア' },
  { name: 'Umbriel', gender: 'male', desc: 'おおらか' },
  { name: 'Algieba', gender: 'male', desc: 'なめらか' },
  { name: 'Algenib', gender: 'male', desc: 'ハスキー' },
  { name: 'Rasalgethi', gender: 'male', desc: '語り口調' },
  { name: 'Alnilam', gender: 'male', desc: '力強い' },
  { name: 'Schedar', gender: 'male', desc: '安定' },
  { name: 'Achird', gender: 'male', desc: '親しみ' },
  { name: 'Zubenelgenubi', gender: 'male', desc: 'カジュアル' },
  { name: 'Sadachbia', gender: 'male', desc: '生き生き' },
  { name: 'Sadaltager', gender: 'male', desc: '博識' }
];
const VOICE_NAMES = VOICES.map(function (v) { return v.name; });

/* ============================================================
 *  標準のAIパーソナリティ（画面から複製して自分用を作れます）
 * ============================================================ */
const BUILTIN_PERSONAS = [
  {
    id: 'midnight', name: 'ミッドナイト・クルーズ', icon: '🌙', color: '#7c6cff', gender: 'male', voice: 'Algenib',
    role: '深夜ラジオDJ', description: '低めの声で、ゆっくり語りかける夜のDJ',
    style: '低めで落ち着いたトーン。ささやくように、ゆっくり間をとって話す。文末は優しく余韻を残す',
    prompt: [
      'あなたは深夜2時の静かなスタジオからお届けするラジオDJです。',
      'リスナーの1日の疲れを包み込むように、低めで落ち着いたトーンで、穏やかにゆっくりと語りかけてください。',
      '文末には優しい余韻を残し、「〜ですね」「今夜も、良い夢を」といったフレーズを自然に織り交ぜてください。',
      '読点「、」を多めに使い、ゆったりした間を作ってください。'
    ].join('\n')
  },
  {
    id: 'morning', name: 'モーニング・ドライブ', icon: '☀️', color: '#ffb547', gender: 'male', voice: 'Puck',
    role: 'ハイテンションFM DJ', description: '明るく軽快に、朝を盛り上げる看板DJ',
    style: '明るくエネルギッシュ。軽快なテンポで弾むように話す',
    prompt: [
      'あなたは週末の朝を最高に盛り上げるFMラジオの看板DJです！',
      '明るくエネルギッシュに、軽快なテンポでリスナーをワクワクさせてください。',
      '「Hey, Listeners!」「今日も最高の一日にしていきましょう！」など、コール＆レスポンスを意識した親しみやすい口調で話してください。'
    ].join('\n')
  },
  {
    id: 'cafe', name: 'リラックス・ラウンジ', icon: '☕', color: '#3fe0c5', gender: 'male', voice: 'Achird',
    role: 'カフェ風トークパートナー', description: '隠れ家カフェのバリスタと、ゆるっと会話',
    style: '自然体で柔らかく、友人に話しかけるように丁寧に話す',
    prompt: [
      'あなたは隠れ家カフェで淹れたてのコーヒーを淹れながら会話するバリスタ兼ナビゲーターです。',
      '友人とお茶を飲んでいるような自然体で、柔らかく丁寧な語り口で話してください。',
      'ユーザーのコメントや選曲に対して「素敵ですね」「その曲、私も大好きです」と共感を示しながら会話を繋げてください。'
    ].join('\n')
  },
  {
    id: 'sunset', name: 'サンセット・ステーション', icon: '🌇', color: '#ff7a9c', gender: 'female', voice: 'Sulafat',
    role: '夕方の女性パーソナリティ', description: '温かい声で、一日の終わりに寄り添う',
    style: '温かく包み込むように、少しゆったりしたテンポで、笑顔が伝わるように話す',
    prompt: [
      'あなたは夕方の帯番組を担当する、温かい雰囲気の女性ラジオパーソナリティです。',
      '仕事や家事を終えたリスナーに「お疲れさまでした」と寄り添い、季節の話題や小さな出来事を大切に語ってください。',
      '相方の話には優しくうなずき、ときどき素朴な質問を返して会話を広げてください。'
    ].join('\n')
  },
  {
    id: 'breeze', name: 'ブリーズ・ナビ', icon: '🌿', color: '#7ee081', gender: 'female', voice: 'Leda',
    role: '元気な女性アシスタント', description: '若々しく明るい、番組の相棒',
    style: '若々しく明るく、はきはきと親しみやすく話す',
    prompt: [
      'あなたはラジオ番組の明るいアシスタントです。',
      'メインパーソナリティの話にテンポよく相づちを打ち、ときにはツッコミも入れて番組を盛り上げてください。',
      '好奇心旺盛で、「えっ、それどういうことですか？」と素直に質問するのが得意です。'
    ].join('\n')
  }
];

/* ============================================================
 *  エントリポイント
 * ============================================================ */
function doGet() {
  return json_({ ok: true, app: APP_NAME, version: APP_VERSION });
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = ROUTES[req.action];
    if (!fn) throw apiErr_('不明な操作です: ' + req.action);
    out = Object.assign({ ok: true }, fn(req) || {});
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err), code: (err && err.code) || '' };
  }
  return json_(out);
}

const ROUTES = {
  // 認証
  register: register_,
  login: login_,
  logout: logout_,
  me: me_,
  changePassword: changePassword_,
  resetPassword: resetPassword_,
  profileUpdate: profileUpdate_,
  // 楽曲・ポッドキャスト
  tracks_list: tracksList_,
  track_add: trackAdd_,
  track_delete: trackDelete_,
  audio_get: audioGet_,
  // ポッドキャストの並び順・聞く順
  show_order_save: showOrderSave_,
  listen_order_save: listenOrderSave_,
  // AI DJ
  dj_talk: djTalk_,
  // パーソナリティ
  personas_list: personasList_,
  persona_save: personaSave_,
  persona_delete: personaDelete_,
  tts_say: ttsSay_,
  // 楽曲ライブラリ（セット）
  libraries_list: librariesList_,
  library_save: librarySave_,
  library_delete: libraryDelete_,
  // 台本（セット）
  scripts_list: scriptsList_,
  script_save: scriptSave_,
  script_delete: scriptDelete_,
  // 番組表
  program_get: programGet_,
  program_save: programSave_,
  // 台本の掛け合い
  script_tts: scriptTts_,
  script_draft: scriptDraft_,
  // AIとの対話
  voice_transcribe: voiceTranscribe_,
  talk_reply: talkReply_,
  // ルーム
  rooms_list: roomsList_,
  room_create: roomCreate_,
  room_join: roomJoin_,
  room_leave: roomLeave_,
  room_state: roomState_,
  room_hand: roomHand_,
  room_invite: roomInvite_,
  room_role: roomRole_,
  room_post_text: roomPostText_,
  room_post_voice: roomPostVoice_,
  room_ai: roomAi_,
  room_close: roomClose_
};

/* ============================================================
 *  初期セットアップ（エディタから1回実行）
 * ============================================================ */
function setup() {
  Object.keys(HEAD).forEach(function (name) { sheet_(name); });
  const folder = folder_();
  if (!prop_('PEPPER')) {
    PropertiesService.getScriptProperties().setProperty('PEPPER', randStr_(40));
  }
  Logger.log('シート作成完了 / Driveフォルダ: ' + folder.getName() + ' (' + folder.getId() + ')');
}

/** TTS 動作確認用（エディタから実行） */
function testTTS() {
  const r = tts_(personaGet_('cafe'), 'こんにちは。ネオンウェーブ・ラジオの音声テストです。');
  Logger.log('mimeType=' + r.mimeType + ' sampleRate=' + r.sampleRate + ' base64長=' + r.base64.length);
}

/** 2人の掛け合い（複数話者TTS）の動作確認用（エディタから実行） */
function testMultiTTS() {
  const r = scriptTtsCore_([
    { speaker: '健', text: 'こんばんは、ネオンウェーブ・ラジオです。' },
    { speaker: '美奈', text: '今夜も素敵な曲を、たっぷりお届けしますね。' }
  ], { '健': 'midnight', '美奈': 'sunset' });
  Logger.log('segments=' + r.length + ' mimeType=' + r[0].mimeType + ' base64長=' + r[0].base64.length);
}

/* ============================================================
 *  認証
 * ============================================================ */
function register_(req) {
  const email = normEmail_(req.email);
  const nickname = String(req.nickname || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw apiErr_('メールアドレスの形式が正しくありません');
  if (!nickname || nickname.length > 20) throw apiErr_('ニックネームは1〜20文字で入力してください');

  return withLock_(function () {
    const users = readAll_('Users');
    if (users.some(function (u) { return u.email === email; })) {
      throw apiErr_('このメールアドレスは登録済みです。「パスワード再発行」をご利用ください');
    }
    const temp = randStr_(10);
    const salt = randStr_(16);
    const admins = String(prop_('ADMIN_EMAILS') || '').split(',').map(normEmail_).filter(String);
    const role = (admins.indexOf(email) >= 0 || (admins.length === 0 && users.length === 0)) ? 'admin' : 'member';

    const mailed = sendMail_(email, '【' + APP_NAME + '】仮パスワードのお知らせ',
      nickname + ' さん\n\nご登録ありがとうございます。\n仮パスワード: ' + temp +
      '\n\n初回ログイン時にパスワードの変更をお願いします。\n\n' + APP_NAME);
    const show = prop_('SHOW_TEMP_PASSWORD') === 'true';
    if (!mailed && !show) throw apiErr_('メール送信に失敗しました。時間をおいて再度お試しください');

    append_('Users', {
      userId: 'u_' + randStr_(12), email: email, nickname: nickname,
      passwordHash: hash_(temp, salt), salt: salt, mustChange: 'true', role: role,
      createdAt: now_(), lastLogin: '', failCount: 0, lockedUntil: 0
    });
    const res = { message: mailed ? '仮パスワードをメールで送信しました' : '仮パスワードを発行しました' };
    if (show) res.tempPassword = temp;
    return res;
  });
}

function login_(req) {
  const email = normEmail_(req.email);
  const password = String(req.password || '');
  return withLock_(function () {
    const user = readAll_('Users').filter(function (u) { return u.email === email; })[0];
    if (!user) throw apiErr_('メールアドレスまたはパスワードが違います');
    const t = now_();
    if (Number(user.lockedUntil) > t) {
      const min = Math.ceil((Number(user.lockedUntil) - t) / 60000);
      throw apiErr_('ログイン失敗が続いたためロック中です。約' + min + '分後にお試しください');
    }
    if (hash_(password, user.salt) !== user.passwordHash) {
      const fails = Number(user.failCount || 0) + 1;
      if (fails >= MAX_FAIL) {
        update_('Users', user, { failCount: 0, lockedUntil: t + LOCK_MINUTES * 60000 });
        throw apiErr_('ログインに' + MAX_FAIL + '回失敗したため、' + LOCK_MINUTES + '分間ロックしました');
      }
      update_('Users', user, { failCount: fails });
      throw apiErr_('メールアドレスまたはパスワードが違います（残り' + (MAX_FAIL - fails) + '回）');
    }
    update_('Users', user, { failCount: 0, lockedUntil: 0, lastLogin: t });
    cleanupSessions_();
    const token = randStr_(48);
    append_('Sessions', { token: token, userId: user.userId, createdAt: t, expiresAt: t + SESSION_DAYS * 86400000 });
    return { token: token, user: publicUser_(user) };
  });
}

function logout_(req) {
  const token = String(req.token || '');
  if (!token) return {};
  withLock_(function () {
    const rows = readAll_('Sessions').filter(function (s) { return s.token === token; });
    rows.reverse().forEach(function (r) { deleteRow_('Sessions', r); });
  });
  CacheService.getScriptCache().remove('sess_' + token);
  return {};
}

function me_(req) {
  return { user: publicUser_(auth_(req)) };
}

function changePassword_(req) {
  const user = auth_(req, { allowMustChange: true });
  const cur = String(req.currentPassword || '');
  const next = String(req.newPassword || '');
  if (hash_(cur, user.salt) !== user.passwordHash) throw apiErr_('現在のパスワードが違います');
  if (next.length < 8 || !/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) {
    throw apiErr_('新しいパスワードは英字と数字を含む8文字以上にしてください');
  }
  if (next === cur) throw apiErr_('現在と同じパスワードは使えません');
  return withLock_(function () {
    const fresh = findUser_(user.userId);
    const salt = randStr_(16);
    update_('Users', fresh, { passwordHash: hash_(next, salt), salt: salt, mustChange: 'false' });
    CacheService.getScriptCache().remove('sess_' + req.token);
    return { user: publicUser_(fresh), message: 'パスワードを変更しました' };
  });
}

function resetPassword_(req) {
  const email = normEmail_(req.email);
  const generic = { message: '登録済みのアドレスであれば、仮パスワードを送信しました' };
  return withLock_(function () {
    const user = readAll_('Users').filter(function (u) { return u.email === email; })[0];
    if (!user) return generic;
    const temp = randStr_(10);
    const salt = randStr_(16);
    const mailed = sendMail_(email, '【' + APP_NAME + '】仮パスワード再発行',
      user.nickname + ' さん\n\n仮パスワードを再発行しました。\n仮パスワード: ' + temp +
      '\n\nログイン後、新しいパスワードを設定してください。\n心当たりがない場合はこのメールを破棄してください。\n\n' + APP_NAME);
    const show = prop_('SHOW_TEMP_PASSWORD') === 'true';
    if (!mailed && !show) throw apiErr_('メール送信に失敗しました。時間をおいて再度お試しください');
    update_('Users', user, { passwordHash: hash_(temp, salt), salt: salt, mustChange: 'true', failCount: 0, lockedUntil: 0 });
    if (show) generic.tempPassword = temp;
    return generic;
  });
}

function profileUpdate_(req) {
  const user = auth_(req);
  const nickname = String(req.nickname || '').trim();
  if (!nickname || nickname.length > 20) throw apiErr_('ニックネームは1〜20文字で入力してください');
  return withLock_(function () {
    const fresh = findUser_(user.userId);
    update_('Users', fresh, { nickname: nickname });
    CacheService.getScriptCache().remove('sess_' + req.token);
    return { user: publicUser_(fresh), message: 'ニックネームを変更しました' };
  });
}

/* ---------- 認証ヘルパー ---------- */
function auth_(req, opt) {
  const token = String((req && req.token) || '');
  if (!token) throw apiErr_('ログインしてください', 'AUTH');
  const cache = CacheService.getScriptCache();
  let user = null;
  const cached = cache.get('sess_' + token);
  if (cached) {
    user = JSON.parse(cached);
  } else {
    const sess = readAll_('Sessions').filter(function (s) { return s.token === token; })[0];
    if (!sess || Number(sess.expiresAt) < now_()) throw apiErr_('セッションの有効期限が切れました。再度ログインしてください', 'AUTH');
    const u = findUser_(sess.userId);
    if (!u) throw apiErr_('ユーザーが見つかりません', 'AUTH');
    user = { userId: u.userId, email: u.email, nickname: u.nickname, role: u.role, mustChange: bool_(u.mustChange), salt: u.salt, passwordHash: u.passwordHash };
    cache.put('sess_' + token, JSON.stringify(user), 300);
  }
  if (user.mustChange && !(opt && opt.allowMustChange)) throw apiErr_('初期パスワードの変更が必要です', 'MUST_CHANGE');
  return user;
}

function findUser_(userId) {
  return readAll_('Users').filter(function (u) { return u.userId === userId; })[0];
}

function publicUser_(u) {
  return { userId: u.userId, email: u.email, nickname: u.nickname, role: u.role, mustChange: bool_(u.mustChange) };
}

function cleanupSessions_() {
  const t = now_();
  const rows = readAll_('Sessions').filter(function (s) { return Number(s.expiresAt) < t; });
  rows.reverse().forEach(function (r) { deleteRow_('Sessions', r); });
}

function hash_(password, salt) {
  const pepper = prop_('PEPPER') || '';
  const D = Utilities.DigestAlgorithm.SHA_256;
  let bytes = Utilities.computeDigest(D, salt + ':' + password + ':' + pepper, Utilities.Charset.UTF_8);
  const saltBytes = Utilities.newBlob(salt + pepper).getBytes();
  for (let i = 0; i < HASH_ROUNDS; i++) {
    bytes = Utilities.computeDigest(D, bytes.concat(saltBytes));
  }
  return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

/* ============================================================
 *  楽曲・ポッドキャスト
 * ============================================================ */
function tracksList_(req) {
  const user = auth_(req);
  const list = readAll_('Tracks').map(publicTrack_);
  list.sort(function (a, b) { return b.createdAt - a.createdAt; });
  const showOrders = {};
  readAll_('ShowOrders').forEach(function (r) { showOrders[String(r.showName)] = parseJsonArr_(r.trackIds); });
  const listenOrders = {};
  readAll_('ListenOrders').forEach(function (r) {
    if (r.ownerId !== user.userId) return;
    listenOrders[String(r.showName)] = { mode: String(r.mode || 'order'), trackIds: parseJsonArr_(r.trackIds) };
  });
  return { tracks: list, showOrders: showOrders, listenOrders: listenOrders };
}

/* ---------- ポッドキャスト：エピソードの並び順（番組ごと・全員共通） ---------- */
const LISTEN_MODES = ['order', 'reverse', 'shuffle', 'custom'];

/** 番組 showName のエピソードだけに絞った、重複なしの ID 配列 */
function showEpisodeIds_(showName, ids) {
  const eps = {};
  readAll_('Tracks').forEach(function (t) {
    if (t.kind === 'podcast' && String(t.showName || '') === showName) eps[t.id] = t;
  });
  const out = (Array.isArray(ids) ? ids : []).map(String)
    .filter(function (x, i, a) { return eps[x] && a.indexOf(x) === i; })
    .slice(0, MAX_SHOW_EPISODES);
  return { ids: out, eps: eps };
}

function showOrderSave_(req) {
  const user = auth_(req);
  const showName = String(req.showName || '').trim().slice(0, 60);
  const r = showEpisodeIds_(showName, req.trackIds);
  const mine = Object.keys(r.eps).some(function (id) { return r.eps[id].ownerId === user.userId; });
  if (!mine && user.role !== 'admin') throw apiErr_('並べ替えできるのは、この番組にエピソードを登録した人か管理者だけです');
  withLock_(function () {
    const row = readAll_('ShowOrders').filter(function (x) { return String(x.showName) === showName; })[0];
    const patch = { trackIds: JSON.stringify(r.ids), updatedBy: user.userId, updatedAt: now_() };
    if (row) update_('ShowOrders', row, patch);
    else append_('ShowOrders', Object.assign({ showName: showName }, patch));
  });
  return { showName: showName, trackIds: r.ids };
}

/* ---------- ポッドキャスト：聞く順（1人ずつ・番組ごと） ---------- */
function listenOrderSave_(req) {
  const user = auth_(req);
  const showName = String(req.showName || '').trim().slice(0, 60);
  const mode = LISTEN_MODES.indexOf(String(req.mode)) >= 0 ? String(req.mode) : 'order';
  const ids = showEpisodeIds_(showName, req.trackIds).ids;
  if (mode === 'custom' && !ids.length) throw apiErr_('聞くエピソードを1つ以上選んでください');
  withLock_(function () {
    const row = readAll_('ListenOrders').filter(function (x) { return x.ownerId === user.userId && String(x.showName) === showName; })[0];
    const patch = { mode: mode, trackIds: JSON.stringify(ids), updatedAt: now_() };
    if (row) update_('ListenOrders', row, patch);
    else append_('ListenOrders', Object.assign({ ownerId: user.userId, showName: showName }, patch));
  });
  return { showName: showName, mode: mode, trackIds: ids };
}

function trackAdd_(req) {
  const user = auth_(req);
  const kind = req.kind === 'podcast' ? 'podcast' : 'song';
  const source = String(req.source || '');
  const title = String(req.title || '').trim().slice(0, 80);
  if (!title) throw apiErr_('タイトルを入力してください');

  const rec = {
    id: 't_' + randStr_(12), kind: kind, source: source, title: title,
    artist: String(req.artist || '').trim().slice(0, 60),
    showName: String(req.showName || '').trim().slice(0, 60),
    description: String(req.description || '').trim().slice(0, 500),
    url: '', fileId: '', youtubeId: '', mimeType: '',
    aiGenerated: req.aiGenerated ? 'true' : 'false',
    ownerId: user.userId, ownerName: user.nickname, createdAt: now_()
  };

  if (source === 'youtube') {
    const id = youtubeId_(req.url);
    if (!id) throw apiErr_('YouTube の URL から動画IDを読み取れませんでした');
    rec.youtubeId = id;
    rec.url = 'https://www.youtube.com/watch?v=' + id;
  } else if (source === 'url') {
    const u = String(req.url || '').trim();
    if (!/^https:\/\//.test(u)) throw apiErr_('外部URLは https:// で始まる音声ファイルのURLを入力してください');
    rec.url = u;
  } else if (source === 'drive') {
    if (req.fileBase64) {
      const bytes = Utilities.base64Decode(req.fileBase64);
      if (bytes.length > MAX_UPLOAD_BYTES) throw apiErr_('ファイルが大きすぎます（上限20MB）');
      const mime = String(req.mimeType || 'audio/mpeg');
      if (!/^audio\//.test(mime)) throw apiErr_('音声ファイルを選択してください');
      const name = String(req.fileName || (title + '.mp3')).replace(/[\\/:*?"<>|]/g, '_');
      const file = folder_().createFile(Utilities.newBlob(bytes, mime, name));
      rec.fileId = file.getId();
      rec.mimeType = mime;
    } else {
      const fid = driveId_(req.url);
      if (!fid) throw apiErr_('Google Drive の共有リンクからファイルIDを読み取れませんでした');
      let file;
      try { file = DriveApp.getFileById(fid); } catch (e) { throw apiErr_('Drive ファイルにアクセスできません。GAS 所有者が閲覧できる共有設定にしてください'); }
      rec.fileId = fid;
      rec.mimeType = file.getMimeType();
    }
  } else {
    throw apiErr_('登録元の種類が不正です');
  }

  withLock_(function () { append_('Tracks', rec); });
  return { track: publicTrack_(rec), message: '「' + title + '」を登録しました' };
}

function trackDelete_(req) {
  const user = auth_(req);
  return withLock_(function () {
    const t = readAll_('Tracks').filter(function (r) { return r.id === req.id; })[0];
    if (!t) throw apiErr_('見つかりません');
    if (t.ownerId !== user.userId && user.role !== 'admin') throw apiErr_('削除できるのは登録者か管理者だけです');
    if (t.source === 'drive' && t.fileId && inAppFolder_(t.fileId)) {
      try { DriveApp.getFileById(t.fileId).setTrashed(true); } catch (e) { /* 既に無い */ }
    }
    deleteRow_('Tracks', t);
    return { message: '削除しました' };
  });
}

function audioGet_(req) {
  auth_(req);
  const fileId = String(req.fileId || '');
  const allowed = readAll_('Tracks').some(function (t) { return t.fileId === fileId; }) ||
                  readAll_('RoomMessages').some(function (m) { return m.fileId === fileId; });
  if (!fileId || !allowed) throw apiErr_('この音声は再生できません');
  const blob = DriveApp.getFileById(fileId).getBlob();
  return { base64: Utilities.base64Encode(blob.getBytes()), mimeType: blob.getContentType() };
}

function publicTrack_(t) {
  return {
    id: t.id, kind: t.kind, source: t.source, title: t.title, artist: t.artist, showName: t.showName,
    description: t.description, url: t.url, fileId: t.fileId, youtubeId: t.youtubeId, mimeType: t.mimeType,
    aiGenerated: bool_(t.aiGenerated), ownerId: t.ownerId, ownerName: t.ownerName, createdAt: Number(t.createdAt)
  };
}

/* ============================================================
 *  パーソナリティ
 * ============================================================ */
function personasAll_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('personas_all');
  if (hit) return JSON.parse(hit);
  const custom = readAll_('Personas').map(function (p) {
    return {
      id: p.id, name: p.name, icon: p.icon, color: p.color, gender: p.gender, voice: p.voice, role: p.role,
      description: p.description, style: p.style, prompt: p.prompt, ownerId: p.ownerId, ownerName: p.ownerName,
      createdAt: Number(p.createdAt), builtin: false
    };
  });
  const list = BUILTIN_PERSONAS.map(function (p) { return Object.assign({ builtin: true, ownerId: '', ownerName: '' }, p); }).concat(custom);
  try { cache.put('personas_all', JSON.stringify(list), PERSONA_CACHE_SEC); } catch (e) { /* 大きすぎる場合はキャッシュしない */ }
  return list;
}

function personaGet_(id, fallbackId) {
  const all = personasAll_();
  const find = function (x) { return all.filter(function (p) { return p.id === x; })[0]; };
  return find(id) || find(fallbackId) || all[0];
}

/** 台本・会話用のキャラクター指示 */
function personaInstruction_(p) {
  return 'あなたは「' + p.name + '」という名前のラジオパーソナリティです。' +
    (p.role ? '役割：' + p.role + '。' : '') +
    (p.description ? '特徴：' + p.description + '。' : '') +
    (p.style ? '\n話し方：' + p.style : '') +
    (p.prompt ? '\n' + p.prompt : '');
}

function personasList_(req) {
  auth_(req);
  return { personas: personasAll_(), voices: VOICES };
}

function personaSave_(req) {
  const user = auth_(req);
  const d = req.persona || {};
  const name = String(d.name || '').trim().slice(0, 20);
  if (!name) throw apiErr_('名前を入力してください');
  const voice = String(d.voice || '');
  if (VOICE_NAMES.indexOf(voice) < 0) throw apiErr_('声を選んでください');
  const color = /^#[0-9a-fA-F]{6}$/.test(String(d.color || '')) ? String(d.color) : '#7c6cff';
  const gender = ['male', 'female', 'other'].indexOf(d.gender) >= 0 ? d.gender : 'other';
  const icon = Array.from(String(d.icon || '🎙').trim()).slice(0, 8).join('') || '🎙';
  const rec = {
    name: name, icon: icon, color: color, gender: gender, voice: voice,
    role: String(d.role || '').trim().slice(0, 40),
    description: String(d.description || '').trim().slice(0, 120),
    style: String(d.style || '').trim().slice(0, 300),
    prompt: String(d.prompt || '').trim().slice(0, 1500),
    updatedAt: now_()
  };
  const out = withLock_(function () {
    const rows = readAll_('Personas');
    if (d.id) {
      if (BUILTIN_PERSONAS.some(function (p) { return p.id === d.id; })) throw apiErr_('標準のパーソナリティは編集できません。「複製」して使ってください');
      const row = rows.filter(function (r) { return r.id === d.id; })[0];
      if (!row) throw apiErr_('パーソナリティが見つかりません');
      if (row.ownerId !== user.userId && user.role !== 'admin') throw apiErr_('編集できるのは作成者か管理者だけです');
      update_('Personas', row, rec);
      return Object.assign({}, row, rec);
    }
    const mine = rows.filter(function (r) { return r.ownerId === user.userId; }).length;
    if (mine >= MAX_CUSTOM_PERSONAS) throw apiErr_('パーソナリティは1人' + MAX_CUSTOM_PERSONAS + '件までです');
    const full = Object.assign({ id: 'p_' + randStr_(10), ownerId: user.userId, ownerName: user.nickname, createdAt: now_() }, rec);
    append_('Personas', full);
    return full;
  });
  CacheService.getScriptCache().remove('personas_all');
  return { persona: { id: out.id }, message: '「' + name + '」を保存しました' };
}

function personaDelete_(req) {
  const user = auth_(req);
  withLock_(function () {
    const row = readAll_('Personas').filter(function (r) { return r.id === req.id; })[0];
    if (!row) throw apiErr_('見つかりません');
    if (row.ownerId !== user.userId && user.role !== 'admin') throw apiErr_('削除できるのは作成者か管理者だけです');
    deleteRow_('Personas', row);
  });
  CacheService.getScriptCache().remove('personas_all');
  return { message: '削除しました' };
}

/** 指定パーソナリティ（または声と話し方）で読み上げ。試聴・自分の声の変換に使う */
function ttsSay_(req) {
  auth_(req);
  const text = String(req.text || '').trim().slice(0, 800);
  if (!text) throw apiErr_('読み上げる文章がありません');
  if (req.voice) {
    if (VOICE_NAMES.indexOf(String(req.voice)) < 0) throw apiErr_('声の指定が正しくありません');
    return { audio: ttsVoice_(String(req.voice), text) };
  }
  return { audio: tts_(personaGet_(req.persona, 'cafe'), text) };
}

/* ============================================================
 *  AI DJ（ラジオ放送中のトーク）
 * ============================================================ */
function djTalk_(req) {
  const user = auth_(req);
  const p = personaGet_(req.persona, 'midnight');
  const c = req.context || {};
  let task;
  if (c.mode === 'between') {
    task = '今、「' + safe_(c.prevTitle) + '」' + (c.prevArtist ? '（' + safe_(c.prevArtist) + '）' : '') + 'が流れ終わりました。' +
           '次は「' + safe_(c.nextTitle) + '」' + (c.nextArtist ? '（' + safe_(c.nextArtist) + '）' : '') + 'をお届けします。' +
           (c.nextAi ? '次の曲はAIが生み出したオリジナル楽曲です。' : '') +
           '前の曲の余韻に触れつつ、次の曲を紹介するつなぎのトークをしてください。';
  } else if (c.mode === 'nowplaying') {
    task = '今「' + safe_(c.nowTitle) + '」が流れています。曲にそっと寄り添う短いコメントをしてください。';
  } else {
    task = '番組のオープニングです。リスナーの「' + safe_(user.nickname) + '」さんへの呼びかけも入れて、番組の始まりを告げてください。';
  }
  const text = generateScript_(p, task);
  const audio = tts_(p, text);
  return { text: text, persona: p.id, audio: audio };
}

function generateScript_(p, task) {
  const body = {
    systemInstruction: { parts: [{ text: personaInstruction_(p) + '\n\n【出力ルール】\n・読み上げる台本の本文だけを出力する\n・120〜200文字程度\n・絵文字、記号、ト書き、括弧書きの演出指示、Markdownは使わない\n・番組名は「ネオンウェーブ・ラジオ」' }] },
    contents: [{ role: 'user', parts: [{ text: task }] }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 1024 }
  };
  const text = cleanText_(textOf_(gemini_(textModel_(), body)));
  if (!text) throw apiErr_('AI DJ の台本を生成できませんでした');
  return text;
}

/* ============================================================
 *  台本の掛け合い
 * ============================================================ */
function scriptTts_(req) {
  auth_(req);
  const lines = (req.lines || []).map(function (l) {
    return { speaker: String((l && l.speaker) || '').trim().slice(0, 20), text: String((l && l.text) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 400) };
  }).filter(function (l) { return l.speaker && l.text; });
  if (!lines.length) throw apiErr_('台本のセリフがありません');
  if (lines.length > 60) throw apiErr_('1ブロックのセリフは60行までです。「---」でブロックを分けてください');
  const total = lines.reduce(function (n, l) { return n + l.text.length; }, 0);
  if (total > 3000) throw apiErr_('1ブロックが長すぎます（3000文字まで）。「---」でブロックを分けてください');
  return { segments: scriptTtsCore_(lines, req.cast || {}), gapMs: 250 };
}

/** 2人ずつの区間に分けて複数話者TTS（区間は並列で生成） */
function scriptTtsCore_(lines, cast) {
  const pmap = {};
  lines.forEach(function (l) { if (!pmap[l.speaker]) pmap[l.speaker] = personaGet_(cast[l.speaker], 'cafe'); });
  const segs = [];
  let cur = [], names = [];
  lines.forEach(function (l) {
    if (names.indexOf(l.speaker) < 0 && names.length === 2) { segs.push({ lines: cur, names: names }); cur = []; names = []; }
    if (names.indexOf(l.speaker) < 0) names.push(l.speaker);
    cur.push(l);
  });
  if (cur.length) segs.push({ lines: cur, names: names });

  const model = ttsModel_();
  const requests = segs.map(function (seg) {
    if (seg.names.length === 1) {
      const p = pmap[seg.names[0]];
      return geminiRequest_(model, ttsBody_(p.voice, seg.lines.map(function (l) { return l.text; }).join('\n')));
    }
    const sp = seg.names.map(function (n, i) { return { label: 'Speaker' + (i + 1), p: pmap[n] }; });
    // 指示文は入れず、セリフだけを渡す（指示文が読み上げられてしまうのを防ぐ）
    const script = seg.lines.map(function (l) { return sp[seg.names.indexOf(l.speaker)].label + ': ' + l.text; }).join('\n');
    return geminiRequest_(model, {
      contents: [{ parts: [{ text: script }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: sp.map(function (s) {
              return { speaker: s.label, voiceConfig: { prebuiltVoiceConfig: { voiceName: s.p.voice } } };
            })
          }
        }
      }
    });
  });
  const results = UrlFetchApp.fetchAll(requests);
  const out = [];
  results.forEach(function (res, i) {
    try {
      out.push(audioOf_(parseGemini_(res)));
    } catch (e) {
      // 複数話者で失敗したときは、1行ずつ単独の声で作り直す
      if (segs[i].names.length < 2 || /利用上限/.test(String(e.message))) throw e;
      const singles = UrlFetchApp.fetchAll(segs[i].lines.map(function (l) {
        const p = pmap[l.speaker];
        return geminiRequest_(model, ttsBody_(p.voice, l.text));
      }));
      singles.forEach(function (r) { out.push(audioOf_(parseGemini_(r))); });
    }
  });
  return out;
}

function scriptDraft_(req) {
  auth_(req);
  const cast = req.cast || [];
  const a = personaGet_(cast[0], 'midnight'), b = personaGet_(cast[1], 'sunset');
  const theme = safe_(req.theme) || '季節の話題と、音楽にまつわる思い出';
  const blocks = Math.max(1, Math.min(6, Number(req.blocks) || 3));
  const desc = function (p) {
    return '「' + p.name + '」（' + (p.gender === 'female' ? '女性' : p.gender === 'male' ? '男性' : '') +
      (p.role ? '・' + p.role : '') + (p.description ? '・' + p.description : '') + '）';
  };
  const task = desc(a) + 'と' + desc(b) + 'の2人が、ラジオ番組の曲と曲の間に話す掛け合いの台本を書いてください。\n' +
    'テーマ：' + theme + '\n' +
    'ブロック数：' + blocks + '（1ブロック＝曲間1回分。各ブロック4〜8行で、最初のブロックは番組のオープニング、最後のブロックはエンディング風に）\n' +
    '【形式】各行は「名前：セリフ」。名前は必ず「' + a.name + '」か「' + b.name + '」。ブロックの間は「---」だけの行で区切る。\n' +
    'セリフに絵文字、ト書き、括弧の演出指示、Markdownは入れない。前置きや説明は書かず、台本だけを出力する。';
  const body = {
    systemInstruction: { parts: [{ text: 'あなたは人気ラジオ番組のベテラン放送作家です。2人のキャラクターが生きた、テンポのよい掛け合いを書きます。\n\n' + personaInstruction_(a) + '\n\n' + personaInstruction_(b) }] },
    contents: [{ role: 'user', parts: [{ text: task }] }],
    generationConfig: { temperature: 0.95, maxOutputTokens: 4096 }
  };
  const text = textOf_(gemini_(textModel_(), body)).replace(/```[a-z]*\n?/gi, '').replace(/[*#`]/g, '').trim();
  if (!text) throw apiErr_('台本を作れませんでした。もう一度お試しください');
  return { text: text };
}

/* ============================================================
 *  楽曲ライブラリ（自分用のセット。1人20セットまで）
 * ============================================================ */
function parseJsonArr_(v) { try { const a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function parseJsonObj_(v) { try { const o = JSON.parse(String(v || '{}')); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; } }

function librariesList_(req) {
  const user = auth_(req);
  const list = readAll_('Libraries').filter(function (r) { return r.ownerId === user.userId; }).map(function (r) {
    return { id: r.id, name: r.name, trackIds: parseJsonArr_(r.trackIds), createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt) };
  });
  list.sort(function (a, b) { return a.createdAt - b.createdAt; });
  return { libraries: list, max: MAX_LIBRARIES };
}

function librarySave_(req) {
  const user = auth_(req);
  const d = req.library || {};
  const name = String(d.name || '').trim().slice(0, 30);
  if (!name) throw apiErr_('ライブラリ名を入力してください');
  const ids = (Array.isArray(d.trackIds) ? d.trackIds : []).map(String).filter(function (x, i, a) { return /^t_\w+$/.test(x) && a.indexOf(x) === i; });
  if (ids.length > MAX_LIBRARY_TRACKS) throw apiErr_('1つのライブラリに入れられる曲は' + MAX_LIBRARY_TRACKS + '曲までです');
  const t = now_();
  const out = withLock_(function () {
    const mine = readAll_('Libraries').filter(function (r) { return r.ownerId === user.userId; });
    if (d.id) {
      const row = mine.filter(function (r) { return r.id === d.id; })[0];
      if (!row) throw apiErr_('ライブラリが見つかりません');
      update_('Libraries', row, { name: name, trackIds: JSON.stringify(ids), updatedAt: t });
      return { id: row.id, createdAt: Number(row.createdAt) };
    }
    if (mine.length >= MAX_LIBRARIES) throw apiErr_('ライブラリは' + MAX_LIBRARIES + 'セットまでです');
    const rec = { id: 'l_' + randStr_(10), ownerId: user.userId, name: name, trackIds: JSON.stringify(ids), createdAt: t, updatedAt: t };
    append_('Libraries', rec);
    return { id: rec.id, createdAt: t };
  });
  return { library: { id: out.id, name: name, trackIds: ids, createdAt: out.createdAt, updatedAt: t } };
}

function libraryDelete_(req) {
  const user = auth_(req);
  withLock_(function () {
    const row = readAll_('Libraries').filter(function (r) { return r.id === req.id && r.ownerId === user.userId; })[0];
    if (!row) throw apiErr_('ライブラリが見つかりません');
    deleteRow_('Libraries', row);
  });
  return { message: 'ライブラリを削除しました（曲そのものは消えません）' };
}

/* ============================================================
 *  台本（自分用のセット。1人50セットまで）
 * ============================================================ */
function scriptsList_(req) {
  const user = auth_(req);
  const list = readAll_('Scripts').filter(function (r) { return r.ownerId === user.userId; }).map(function (r) {
    return { id: r.id, title: r.title, text: String(r.text || ''), cast: parseJsonObj_(r.cast), createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt) };
  });
  list.sort(function (a, b) { return a.createdAt - b.createdAt; });
  return { scripts: list, max: MAX_SCRIPTS };
}

function scriptSave_(req) {
  const user = auth_(req);
  const d = req.script || {};
  const title = String(d.title || '').trim().slice(0, 40) || '無題の台本';
  const text = String(d.text || '');
  if (text.length > MAX_SCRIPT_CHARS) throw apiErr_('台本が長すぎます（1セット' + MAX_SCRIPT_CHARS + '文字まで）');
  const cast = {};
  const src = d.cast && typeof d.cast === 'object' ? d.cast : {};
  Object.keys(src).slice(0, 40).forEach(function (k) { cast[String(k).slice(0, 20)] = String(src[k] || '').slice(0, 40); });
  const t = now_();
  const out = withLock_(function () {
    const mine = readAll_('Scripts').filter(function (r) { return r.ownerId === user.userId; });
    const patch = { title: title, text: text, cast: JSON.stringify(cast), updatedAt: t };
    if (d.id) {
      const row = mine.filter(function (r) { return r.id === d.id; })[0];
      if (!row) throw apiErr_('台本が見つかりません');
      update_('Scripts', row, patch);
      return { id: row.id, createdAt: Number(row.createdAt) };
    }
    if (mine.length >= MAX_SCRIPTS) throw apiErr_('台本は' + MAX_SCRIPTS + 'セットまでです');
    const rec = Object.assign({ id: 's_' + randStr_(10), ownerId: user.userId, createdAt: t }, patch);
    append_('Scripts', rec);
    return { id: rec.id, createdAt: t };
  });
  return { script: { id: out.id, title: title, text: text, cast: cast, createdAt: out.createdAt, updatedAt: t } };
}

function scriptDelete_(req) {
  const user = auth_(req);
  withLock_(function () {
    const row = readAll_('Scripts').filter(function (r) { return r.id === req.id && r.ownerId === user.userId; })[0];
    if (!row) throw apiErr_('台本が見つかりません');
    deleteRow_('Scripts', row);
  });
  return { message: '台本を削除しました' };
}

/* ============================================================
 *  番組表（曲と掛け合いの放送順。1人1つ）
 * ============================================================ */
function programGet_(req) {
  const user = auth_(req);
  const row = readAll_('Programs').filter(function (r) { return r.ownerId === user.userId; })[0];
  return { items: row ? parseJsonArr_(row.items) : [] };
}

function programSave_(req) {
  const user = auth_(req);
  const items = (Array.isArray(req.items) ? req.items : []).slice(0, 300).map(function (it) {
    if (it && it.t === 's' && /^t_\w+$/.test(String(it.id))) return { t: 's', id: String(it.id) };
    if (it && it.t === 'k' && /^s_\w+$/.test(String(it.sid))) return { t: 'k', sid: String(it.sid), b: Math.max(-1, Math.floor(Number(it.b) || 0)) };
    return null;
  }).filter(Boolean);
  withLock_(function () {
    const row = readAll_('Programs').filter(function (r) { return r.ownerId === user.userId; })[0];
    if (row) update_('Programs', row, { items: JSON.stringify(items), updatedAt: now_() });
    else append_('Programs', { ownerId: user.userId, items: JSON.stringify(items), updatedAt: now_() });
  });
  return { count: items.length };
}

/* ============================================================
 *  AIとの対話（自分の声を文字起こし → 指定の声に変換 → AIが返事）
 * ============================================================ */
function voiceTranscribe_(req) {
  auth_(req);
  const b64 = String(req.base64 || '');
  if (!b64) throw apiErr_('音声データが空です');
  if (b64.length * 0.75 > MAX_STT_BYTES) throw apiErr_('音声が長すぎます');
  const mime = /^audio\/[\w.+-]+$/.test(String(req.mimeType || '')) ? String(req.mimeType) : 'audio/wav';
  const body = {
    contents: [{
      role: 'user', parts: [
        { inlineData: { mimeType: mime, data: b64 } },
        { text: 'この音声を日本語で正確に文字起こししてください。話し言葉の雰囲気は残しつつ、「えー」「あのー」などのつなぎ言葉は省き、句読点を補ってください。文字起こしした本文だけを出力し、説明や引用符は付けないでください。人の声が入っていない場合は何も出力しないでください。' }
      ]
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 2048 }
  };
  let text = textOf_(gemini_(textModel_(), body)).replace(/^[「『"]+|[」』"]+$/g, '').trim();
  if (/^[（(]?(無音|音声なし|発話なし|なし)[）)]?。?$/.test(text)) text = '';
  return { text: text.slice(0, 800) };
}

function talkReply_(req) {
  const user = auth_(req);
  const p = personaGet_(req.persona, 'cafe');
  const partner = safe_(req.partnerName) || user.nickname;
  const theme = safe_(req.theme);
  const contents = [];
  (req.history || []).slice(-16).forEach(function (h) {
    const role = h && h.role === 'ai' ? 'model' : 'user';
    const t = String((h && h.text) || '').trim().slice(0, 600);
    if (!t) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += '\n' + t;
    else contents.push({ role: role, parts: [{ text: t }] });
  });
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: '（番組が始まりました。あなたから最初のひとことで、' + partner + 'さんに話しかけてください）' }] });
  if (contents[0].role === 'model') contents.unshift({ role: 'user', parts: [{ text: '（番組スタート）' }] });
  if (contents[contents.length - 1].role === 'model') contents.push({ role: 'user', parts: [{ text: '（続けてどうぞ）' }] });

  const sys = personaInstruction_(p) +
    '\n\n【状況】ラジオ番組の収録中です。あなたは相方の「' + partner + '」さんと2人で掛け合いトークをしています。' +
    (theme ? '今日のテーマは「' + theme + '」。' : '') +
    '\n【出力ルール】\n・相方の発言を受けて自然に返す。共感やツッコミを入れ、ときどき質問を返して会話を広げる\n・読み上げる本文だけ。40〜140文字程度\n・絵文字、記号、ト書き、括弧の演出指示、Markdownは使わない\n・番組名は「ネオンウェーブ・ラジオ」';
  const body = {
    systemInstruction: { parts: [{ text: sys }] },
    contents: contents,
    generationConfig: { temperature: 0.9, maxOutputTokens: 1024 }
  };
  const text = cleanText_(textOf_(gemini_(textModel_(), body)));
  if (!text) throw apiErr_('返事を作れませんでした。もう一度話しかけてください');
  return { text: text, persona: p.id, audio: tts_(p, text) };
}

/* ============================================================
 *  Gemini 共通
 * ============================================================ */
function textModel_() { return prop_('GEMINI_TEXT_MODEL') || 'gemini-3.8-flash'; }
function ttsModel_() { return prop_('GEMINI_TTS_MODEL') || 'gemini-3.8-flash-tts'; }

function textOf_(res) {
  const parts = (((res.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.filter(function (x) { return !x.thought; }).map(function (x) { return x.text || ''; }).join('').trim();
}

function cleanText_(t) { return String(t || '').replace(/[*#`]/g, '').trim(); }

/** 読み上げ本文だけを渡す（「〜として〜読み上げてください」などの指示文は付けない） */
function ttsBody_(voice, text) {
  return {
    contents: [{ parts: [{ text: text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  };
}

function tts_(p, text) {
  return ttsVoice_(p.voice, text);
}

function ttsVoice_(voice, text) {
  return audioOf_(gemini_(ttsModel_(), ttsBody_(voice, text)));
}

function audioOf_(res) {
  const parts = (((res.candidates || [])[0] || {}).content || {}).parts || [];
  const inline = parts.filter(function (x) { return x.inlineData && x.inlineData.data; })[0];
  if (!inline) throw apiErr_('音声データを取得できませんでした');
  const mime = inline.inlineData.mimeType || 'audio/L16;rate=24000';
  const m = mime.match(/rate=(\d+)/);
  return { base64: inline.inlineData.data, mimeType: mime, sampleRate: m ? Number(m[1]) : 24000 };
}

function geminiRequest_(model, body) {
  const key = prop_('GEMINI_API_KEY');
  if (!key) throw apiErr_('GEMINI_API_KEY が未設定です');
  return {
    url: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
    method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body), muteHttpExceptions: true
  };
}

function parseGemini_(res) {
  const code = res.getResponseCode();
  const txt = res.getContentText();
  if (code !== 200) {
    if (code === 429) throw apiErr_('Gemini API の利用上限に達しました。しばらく待ってから再度お試しください');
    throw apiErr_('Gemini API エラー(' + code + '): ' + txt.slice(0, 200));
  }
  return JSON.parse(txt);
}

function gemini_(model, body) {
  const r = geminiRequest_(model, body);
  const url = r.url;
  delete r.url;
  return parseGemini_(UrlFetchApp.fetch(url, r));
}

/** PCM(16bit/mono) を WAV に包んで Blob 化 */
function pcmToWavBlob_(pcmBytes, sampleRate, name) {
  const h = [];
  const str = function (s) { for (let i = 0; i < s.length; i++) h.push(s.charCodeAt(i)); };
  const u32 = function (v) { h.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255); };
  const u16 = function (v) { h.push(v & 255, (v >> 8) & 255); };
  const len = pcmBytes.length;
  str('RIFF'); u32(36 + len); str('WAVE');
  str('fmt '); u32(16); u16(1); u16(1); u32(sampleRate); u32(sampleRate * 2); u16(2); u16(16);
  str('data'); u32(len);
  const header = h.map(function (b) { return b > 127 ? b - 256 : b; });
  return Utilities.newBlob(header.concat(pcmBytes), 'audio/wav', name);
}

/* ============================================================
 *  ライブルーム
 * ============================================================ */
function roomsList_(req) {
  auth_(req);
  const t = now_();
  const members = readAll_('RoomMembers');
  const rooms = readAll_('Rooms').filter(function (r) { return r.status === 'open'; });
  const out = [];
  rooms.forEach(function (r) {
    const act = members.filter(function (m) { return m.roomId === r.id && t - Number(m.lastSeen) < ACTIVE_WINDOW_MS; });
    if (act.length === 0 && t - Number(r.updatedAt) > ROOM_IDLE_CLOSE_MS) {
      withLock_(function () { update_('Rooms', r, { status: 'closed' }); });
      return;
    }
    out.push({
      id: r.id, title: r.title, topic: r.topic, persona: r.persona, hostId: r.hostId, hostName: r.hostName,
      createdAt: Number(r.createdAt), activeCount: act.length,
      speakers: act.filter(function (m) { return m.role !== 'listener'; }).map(function (m) { return m.nickname; })
    });
  });
  out.sort(function (a, b) { return b.activeCount - a.activeCount || b.createdAt - a.createdAt; });
  return { rooms: out };
}

function roomCreate_(req) {
  const user = auth_(req);
  const title = String(req.title || '').trim().slice(0, 40);
  if (!title) throw apiErr_('ルーム名を入力してください');
  const persona = personaGet_(req.persona, 'cafe').id;
  const t = now_();
  const room = { id: 'r_' + randStr_(10), title: title, topic: String(req.topic || '').trim().slice(0, 120), persona: persona,
                 hostId: user.userId, hostName: user.nickname, status: 'open', createdAt: t, updatedAt: t };
  withLock_(function () {
    append_('Rooms', room);
    append_('RoomMembers', { roomId: room.id, userId: user.userId, nickname: user.nickname, role: 'host', hand: 'false', lastSeen: t });
    addMsg_(room.id, user, 'system', user.nickname + ' さんがルームを開きました');
  });
  return { room: { id: room.id } };
}

function roomJoin_(req) {
  const user = auth_(req);
  return withLock_(function () {
    const room = getOpenRoom_(req.roomId);
    const t = now_();
    const mem = readAll_('RoomMembers').filter(function (m) { return m.roomId === room.id && m.userId === user.userId; })[0];
    if (mem) {
      update_('RoomMembers', mem, { lastSeen: t, nickname: user.nickname });
    } else {
      const role = room.hostId === user.userId ? 'host' : 'listener';
      append_('RoomMembers', { roomId: room.id, userId: user.userId, nickname: user.nickname, role: role, hand: 'false', lastSeen: t });
      addMsg_(room.id, user, 'system', user.nickname + ' さんが参加しました');
    }
    update_('Rooms', room, { updatedAt: t });
    return {};
  });
}

function roomLeave_(req) {
  const user = auth_(req);
  return withLock_(function () {
    const rows = readAll_('RoomMembers').filter(function (m) { return m.roomId === req.roomId && m.userId === user.userId; });
    if (rows.length) {
      rows.reverse().forEach(function (r) { deleteRow_('RoomMembers', r); });
      addMsg_(req.roomId, user, 'system', user.nickname + ' さんが退出しました');
    }
    return {};
  });
}

function roomState_(req) {
  const user = auth_(req);
  const room = readAll_('Rooms').filter(function (r) { return r.id === req.roomId; })[0];
  if (!room) throw apiErr_('ルームが見つかりません');
  const t = now_();
  const allMem = readAll_('RoomMembers').filter(function (m) { return m.roomId === room.id; });
  const me = allMem.filter(function (m) { return m.userId === user.userId; })[0];
  if (me && t - Number(me.lastSeen) > TOUCH_INTERVAL_MS) {
    withLock_(function () {
      const freshMe = readAll_('RoomMembers').filter(function (m) { return m.roomId === room.id && m.userId === user.userId; })[0];
      if (freshMe) update_('RoomMembers', freshMe, { lastSeen: t });
      const freshRoom = readAll_('Rooms').filter(function (r) { return r.id === room.id; })[0];
      if (freshRoom) update_('Rooms', freshRoom, { updatedAt: t });
    });
  }
  const since = Number(req.since || 0);
  let msgs = readAll_('RoomMessages').filter(function (m) { return m.roomId === room.id && Number(m.createdAt) >= since; });
  msgs = msgs.slice(-100).map(function (m) {
    return { id: m.id, userId: m.userId, nickname: m.nickname, type: m.type, text: m.text, fileId: m.fileId,
             mimeType: m.mimeType, persona: m.persona, createdAt: Number(m.createdAt) };
  });
  return {
    room: { id: room.id, title: room.title, topic: room.topic, persona: room.persona, hostId: room.hostId, hostName: room.hostName, status: room.status },
    members: allMem.filter(function (m) { return t - Number(m.lastSeen) < ACTIVE_WINDOW_MS || m.userId === user.userId; })
                   .map(function (m) { return { userId: m.userId, nickname: m.nickname, role: m.role, hand: bool_(m.hand) }; }),
    me: me ? { role: me.role, hand: bool_(me.hand) } : null,
    messages: msgs,
    serverTime: t
  };
}

function roomHand_(req) {
  const user = auth_(req);
  return withLock_(function () {
    const me = member_(req.roomId, user.userId);
    if (me.role !== 'listener') throw apiErr_('挙手はリスナーのみです');
    update_('RoomMembers', me, { hand: req.raise ? 'true' : 'false', lastSeen: now_() });
    if (req.raise) addMsg_(req.roomId, user, 'system', user.nickname + ' さんが手を挙げました ✋');
    return {};
  });
}

function roomInvite_(req) {
  const user = auth_(req);
  return withLock_(function () {
    const room = getOpenRoom_(req.roomId);
    if (room.hostId !== user.userId && user.role !== 'admin') throw apiErr_('招待できるのはホストだけです');
    const target = member_(req.roomId, req.targetUserId);
    update_('RoomMembers', target, { role: 'speaker', hand: 'false' });
    addMsg_(req.roomId, user, 'system', target.nickname + ' さんがステージに上がりました 🎤');
    return {};
  });
}

function roomRole_(req) {
  const user = auth_(req);
  const role = req.role === 'speaker' ? 'speaker' : 'listener';
  return withLock_(function () {
    const room = getOpenRoom_(req.roomId);
    const isHost = room.hostId === user.userId || user.role === 'admin';
    const self = req.targetUserId === user.userId;
    if (!isHost && !(self && role === 'listener')) throw apiErr_('この操作はできません');
    const target = member_(req.roomId, req.targetUserId);
    if (target.role === 'host') throw apiErr_('ホストの役割は変更できません');
    update_('RoomMembers', target, { role: role, hand: 'false' });
    addMsg_(req.roomId, user, 'system', target.nickname + (role === 'speaker' ? ' さんがステージに上がりました 🎤' : ' さんがリスナー席に戻りました'));
    return {};
  });
}

function roomPostText_(req) {
  const user = auth_(req);
  const text = String(req.text || '').trim().slice(0, 200);
  if (!text) throw apiErr_('メッセージを入力してください');
  return withLock_(function () {
    getOpenRoom_(req.roomId);
    member_(req.roomId, user.userId);
    return { message: addMsg_(req.roomId, user, 'text', text) };
  });
}

function roomPostVoice_(req) {
  const user = auth_(req);
  const room = getOpenRoom_(req.roomId);
  const me = member_(req.roomId, user.userId);
  if (me.role === 'listener') throw apiErr_('音声を投稿できるのはステージ上のメンバーだけです');
  const bytes = Utilities.base64Decode(String(req.base64 || ''));
  if (!bytes.length) throw apiErr_('音声データが空です');
  if (bytes.length > MAX_VOICE_BYTES) throw apiErr_('音声が長すぎます');
  const mime = String(req.mimeType || 'audio/webm').split(';')[0];
  const ext = mime.indexOf('mp4') >= 0 ? 'm4a' : (mime.indexOf('ogg') >= 0 ? 'ogg' : 'webm');
  const file = folder_().createFile(Utilities.newBlob(bytes, mime, 'voice_' + room.id + '_' + now_() + '.' + ext));
  return withLock_(function () {
    return { message: addMsg_(req.roomId, user, 'voice', '', file.getId(), mime) };
  });
}

function roomAi_(req) {
  const user = auth_(req);
  const room = getOpenRoom_(req.roomId);
  const me = member_(req.roomId, user.userId);
  if (me.role === 'listener') throw apiErr_('AI DJ を呼べるのはステージ上のメンバーだけです');
  const p = personaGet_(req.persona, room.persona || 'cafe');
  const recent = readAll_('RoomMessages')
    .filter(function (m) { return m.roomId === room.id && (m.type === 'text' || m.type === 'ai'); })
    .slice(-10)
    .map(function (m) { return (m.type === 'ai' ? 'AI DJ' : m.nickname) + '：' + m.text; })
    .join('\n');
  const task = 'ここはトークルーム「' + safe_(room.title) + '」です。' +
    (room.topic ? 'テーマは「' + safe_(room.topic) + '」。' : '') +
    '\n最近のやりとり:\n' + (recent || '（まだ会話はありません）') +
    '\n\n' + safe_(user.nickname) + ' さんに呼ばれました。流れを汲んで、場を和ませるコメントや、参加者への問いかけをしてください。';
  const text = generateScript_(p, task);
  const audio = tts_(p, text);
  const blob = pcmToWavBlob_(Utilities.base64Decode(audio.base64), audio.sampleRate, 'ai_' + room.id + '_' + now_() + '.wav');
  const file = folder_().createFile(blob);
  return withLock_(function () {
    const msg = addMsg_(room.id, user, 'ai', text, file.getId(), 'audio/wav', p.id);
    return { message: msg };
  });
}

function roomClose_(req) {
  const user = auth_(req);
  return withLock_(function () {
    const room = getOpenRoom_(req.roomId);
    if (room.hostId !== user.userId && user.role !== 'admin') throw apiErr_('ルームを終了できるのはホストだけです');
    update_('Rooms', room, { status: 'closed', updatedAt: now_() });
    addMsg_(room.id, user, 'system', 'ルームは終了しました');
    return {};
  });
}

/* ---------- ルームヘルパー ---------- */
function getOpenRoom_(roomId) {
  const room = readAll_('Rooms').filter(function (r) { return r.id === roomId; })[0];
  if (!room) throw apiErr_('ルームが見つかりません');
  if (room.status !== 'open') throw apiErr_('このルームは終了しています', 'ROOM_CLOSED');
  return room;
}

function member_(roomId, userId) {
  const m = readAll_('RoomMembers').filter(function (x) { return x.roomId === roomId && x.userId === userId; })[0];
  if (!m) throw apiErr_('ルームに参加していません', 'NOT_MEMBER');
  return m;
}

function addMsg_(roomId, user, type, text, fileId, mimeType, persona) {
  const msg = {
    id: 'm_' + randStr_(12), roomId: roomId, userId: user.userId, nickname: user.nickname, type: type,
    text: text || '', fileId: fileId || '', mimeType: mimeType || '', persona: persona || '', createdAt: now_()
  };
  append_('RoomMessages', msg);
  return msg;
}

/* ============================================================
 *  共通ユーティリティ
 * ============================================================ */
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function apiErr_(msg, code) {
  const e = new Error(msg);
  e.code = code || '';
  return e;
}

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function now_() { return Date.now(); }
function bool_(v) { return v === true || String(v).toLowerCase() === 'true'; }
function normEmail_(s) { return String(s || '').trim().toLowerCase(); }
function safe_(s) { return String(s || '').replace(/[\r\n]+/g, ' ').slice(0, 120); }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw apiErr_('混み合っています。少し待って再度お試しください');
  try { return fn(); } finally { lock.releaseLock(); }
}

function randStr_(n) {
  const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pool = '';
  while (pool.length < n * 2) pool += Utilities.getUuid().replace(/-/g, '');
  let s = '';
  for (let i = 0; i < n; i++) s += CH[parseInt(pool.substr(i * 2, 2), 16) % CH.length];
  return s;
}

function sendMail_(to, subject, body) {
  try { MailApp.sendEmail({ to: to, subject: subject, body: body, name: APP_NAME }); return true; }
  catch (e) { console.error(e); return false; }
}

function youtubeId_(url) {
  const s = String(url || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtu\.be\/|v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : '';
}

function driveId_(url) {
  const s = String(url || '').trim();
  const m = s.match(/\/d\/([\w-]{20,})/) || s.match(/[?&]id=([\w-]{20,})/);
  if (m) return m[1];
  return /^[\w-]{20,}$/.test(s) ? s : '';
}

function folder_() {
  const id = prop_('DRIVE_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* 作り直す */ } }
  const f = DriveApp.createFolder('NEON_WAVE_RADIO_DATA');
  PropertiesService.getScriptProperties().setProperty('DRIVE_FOLDER_ID', f.getId());
  return f;
}

function inAppFolder_(fileId) {
  try {
    const target = folder_().getId();
    const it = DriveApp.getFileById(fileId).getParents();
    while (it.hasNext()) if (it.next().getId() === target) return true;
  } catch (e) { /* noop */ }
  return false;
}

/* ---------- シート操作 ---------- */
function ss_() {
  const id = prop_('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, sh.getMaxRows(), HEAD[name].length).setNumberFormat('@'); // 全セル書式なしテキスト
    sh.getRange(1, 1, 1, HEAD[name].length).setValues([HEAD[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readAll_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const h = HEAD[name];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i].join('') === '') continue;
    const o = { _row: i + 1 };
    h.forEach(function (k, j) { o[k] = values[i][j]; });
    rows.push(o);
  }
  return rows;
}

function append_(name, obj) {
  const sh = sheet_(name);
  const row = HEAD[name].map(function (k) { return obj[k] === undefined || obj[k] === null ? '' : String(obj[k]); });
  const r = sh.getLastRow() + 1;
  const range = sh.getRange(r, 1, 1, row.length);
  range.setNumberFormat('@');
  range.setValues([row]);
}

function update_(name, rowObj, patch) {
  const sh = sheet_(name);
  const h = HEAD[name];
  Object.keys(patch).forEach(function (k) {
    const c = h.indexOf(k);
    if (c >= 0) {
      sh.getRange(rowObj._row, c + 1).setNumberFormat('@').setValue(String(patch[k]));
      rowObj[k] = patch[k];
    }
  });
}

function deleteRow_(name, rowObj) {
  sheet_(name).deleteRow(rowObj._row);
}
