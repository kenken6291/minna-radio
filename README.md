# NEON WAVE RADIO（minna-radio）v1.0.0

AI DJ がしゃべるラジオ／ポッドキャスト／音声SNS。
GitHub Pages + Google Apps Script + スプレッドシート + Google Drive + Gemini API。

## ディレクトリ構成

```
minna-radio/
├── index.html      … 画面（ログイン、ラジオ、ポッドキャスト、ライブルーム、全モーダル）
├── style.css       … デザイン
├── app.js          … 認証・プレイヤー・AI DJ・エフェクト・ルーム
├── config.js       … GAS_URL / バージョン / 各種設定（ここだけ書き換え）
├── README.md
└── gas/
    └── Code.gs     … GAS バックエンド（GitHub には参考として置くだけ。実行は GAS 側）
```

## 1. スプレッドシートと GAS

1. Google スプレッドシートを新規作成（名前例：`minna-radio-db`）
2. メニュー「拡張機能 → Apps Script」を開き、`Code.gs` の中身を全部貼り付けて保存
3. 「プロジェクトの設定 → スクリプト プロパティ」に以下を登録

| キー | 値 | 必須 |
|---|---|---|
| GEMINI_API_KEY | Gemini API キー | ✔ |
| GEMINI_TEXT_MODEL | 台本生成モデルID（例 `gemini-3.8-flash`） | 推奨 |
| GEMINI_TTS_MODEL | 音声合成モデルID（例 `gemini-3.8-flash-tts`） | 推奨 |
| ADMIN_EMAILS | 管理者メール（カンマ区切り） | 任意 |
| SHOW_TEMP_PASSWORD | `true` で仮パスワードを画面にも表示（テスト時のみ） | 任意 |

   ※ モデルIDは Google AI Studio の表記と完全一致させてください。
   ※ PEPPER と DRIVE_FOLDER_ID は手順4で自動作成されます。

4. エディタ上部の関数選択で `setup` を選んで実行 → 権限を承認
   （シート6枚と Drive フォルダ `NEON_WAVE_RADIO_DATA` が作られます）
5. `testTTS` を実行し、ログに `sampleRate=24000` などが出れば TTS 接続OK

### シート定義（setup で自動作成）

| シート | カラム |
|---|---|
| Users | userId, email, nickname, passwordHash, salt, mustChange, role, createdAt, lastLogin, failCount, lockedUntil |
| Sessions | token, userId, createdAt, expiresAt |
| Tracks | id, kind(song/podcast), source(drive/youtube/url), title, artist, showName, description, url, fileId, youtubeId, mimeType, aiGenerated, ownerId, ownerName, createdAt |
| Rooms | id, title, topic, persona, hostId, hostName, status(open/closed), createdAt, updatedAt |
| RoomMembers | roomId, userId, nickname, role(host/speaker/listener), hand, lastSeen |
| RoomMessages | id, roomId, userId, nickname, type(text/voice/ai/system), text, fileId, mimeType, persona, createdAt |

日時はすべてミリ秒の数値（テキスト書式）で保存しています。

## 2. GAS のデプロイ

1. 「デプロイ → 新しいデプロイ → 種類：ウェブアプリ」
2. 実行ユーザー：**自分** ／ アクセスできるユーザー：**全員**
3. 発行された `https://script.google.com/macros/s/…/exec` を控える

> ⚠ Code.gs を修正したら「デプロイを管理 → 編集 → バージョン：新バージョン」で再デプロイしないと反映されません。

## 3. GitHub Pages

1. リポジトリ `minna-radio` を作成し、`index.html / style.css / app.js / config.js`（と gas フォルダ）を置く
2. `config.js` の `GAS_URL` を手順2のURLに書き換え
3. Settings → Pages → Branch: `main` / `/ (root)` で公開
4. `https://kenken6291.github.io/minna-radio/` にアクセス

最初に登録した人が管理者になります（ADMIN_EMAILS 未設定時）。

## 仕様メモ・制約

- **ライブルームの「声」は録音投稿方式**（最大60秒）。GAS は常時接続ができないため、Clubhouse のような同時通話ではなく、3秒ごとのポーリングで新しい音声を自動再生します。
- **AI DJ**：Gemini で台本生成 → Gemini TTS で音声化。ラジオでは毎回生成して即再生、ルームでは WAV にして Drive に保存し全員で聞けます。曲間DJは1曲前から先読み生成するので待ち時間が短くなります。
- **ラジオエフェクト**（ローファイ・エコー・リバーブ・レコードノイズ・ジングル）は AI DJ とルーム音声にかかります。
- **Drive の楽曲**は GAS 経由で取得して再生します（ビジュアライザーが実音に反応）。1曲20MBまで。
- **外部URL・YouTube** はブラウザの制約で波形が取れないため、ビジュアライザーは演出表示になります。
- スマホで画面を消すと YouTube は止まります（YouTube側の仕様）。Drive／外部URLの曲はロック画面の操作に対応。
- iPhone では音量スライダーが外部URL・YouTube に効かない場合があります（端末の音量ボタンで調整）。
- AI DJ のキャラクター（プロンプト・声）は `Code.gs` の `PERSONAS` で、画面表示は `config.js` の `PERSONAS` で変更できます（id を揃えること）。
