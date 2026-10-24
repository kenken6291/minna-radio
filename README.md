# NEON WAVE RADIO（minna-radio）v1.5.0

AI DJ がしゃべるラジオ／ポッドキャスト／音声SNS。
GitHub Pages + Google Apps Script + スプレッドシート + Google Drive + Gemini API。

## ディレクトリ構成

```
minna-radio/
├── index.html      … 画面（ログイン、ラジオ、ポッドキャスト、ライブルーム、全モーダル）
├── style.css       … デザイン
├── app.js          … 認証・プレイヤー・AI DJ・エフェクト・ルーム・スタジオ
├── encoder.js      … 音声ファイル書き出し（MP3 / WAV / FLAC / ALAC / AIFF）※v1.1.0 で追加
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
6. `testMultiTTS` を実行し、ログに `segments=1` などが出れば 2人の掛け合い（複数話者TTS）もOK

### シート定義（setup で自動作成）

| シート | カラム |
|---|---|
| Users | userId, email, nickname, passwordHash, salt, mustChange, role, createdAt, lastLogin, failCount, lockedUntil |
| Sessions | token, userId, createdAt, expiresAt |
| Tracks | id, kind(song/podcast), source(drive/youtube/url), title, artist, showName, description, url, fileId, youtubeId, mimeType, aiGenerated, ownerId, ownerName, createdAt |
| Rooms | id, title, topic, persona, hostId, hostName, status(open/closed), createdAt, updatedAt |
| RoomMembers | roomId, userId, nickname, role(host/speaker/listener), hand, lastSeen |
| RoomMessages | id, roomId, userId, nickname, type(text/voice/ai/system), text, fileId, mimeType, persona, createdAt |
| Personas | id, name, icon, color, gender, voice, role, description, style, prompt, ownerId, ownerName, createdAt, updatedAt |
| Libraries | id, ownerId, name, trackIds(JSON), createdAt, updatedAt |
| Scripts | id, ownerId, title, text, cast(JSON), createdAt, updatedAt |
| Programs | ownerId, items(JSON), updatedAt |
| ShowOrders | showName, trackIds(JSON), updatedBy, updatedAt |
| ListenOrders | ownerId, showName, mode(order/reverse/shuffle/custom), trackIds(JSON), updatedAt |
| PodLists | id, ownerId, name, trackIds(JSON), createdAt, updatedAt |

※ Personas / Libraries / Scripts / Programs / ShowOrders / ListenOrders / PodLists シートは初回アクセス時に自動で作られます（setup の再実行は不要）。

日時はすべてミリ秒の数値（テキスト書式）で保存しています。

## 2. GAS のデプロイ

1. 「デプロイ → 新しいデプロイ → 種類：ウェブアプリ」
2. 実行ユーザー：**自分** ／ アクセスできるユーザー：**全員**
3. 発行された `https://script.google.com/macros/s/…/exec` を控える

> ⚠ Code.gs を修正したら「デプロイを管理 → 編集 → バージョン：新バージョン」で再デプロイしないと反映されません。

## 3. GitHub Pages

1. リポジトリ `minna-radio` を作成し、`index.html / style.css / app.js / config.js`（と gas フォルダ）を置く
2. `config.js` の `GAS_URL` を手順2のURLに書き換え
3. Settings → Pages → Branch: `main` / `/ (root)` で公開（`encoder.js` も忘れずに置く）
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
- **AIパーソナリティ**は「スタジオ → パーソナリティ」で作成・編集・複製・削除できます（声30種類から選択、話し方・キャラクター設定も自由）。標準の5人は `Code.gs` の `BUILTIN_PERSONAS` にあり、画面からは編集できません（複製して使う）。

## v1.5.0 の変更点

- **ポッドキャスト再生リスト**（ポッドキャスト画面の上）：1人20セット、1セット100話まで。番組をまたいで好きな話を選び、好きな順番で連続再生。
  - 「✎ 選んで並べる」：左で選ぶ（絞り込み検索・番組ごとに全部入れる）→ 右で並べる（⤒ ↑ ↓ ⤓ ✕、番号指定で移動、番組の並び順／タイトル順／逆順／シャッフルで一括整列）。
  - 各エピソードの 📃 で、選んでいる再生リストに入れる・外す。リストの行を押すとその話から再生。
  - サーバー（PodLists）に保存。スマホと PC で共通。
- **まとめて登録（最大100件）**：ファイルは複数選択、URL は1行に1つ。ファイル名順に1件ずつ登録し、進み具合を表示。キャンセルで残りを中止。ポッドキャストは「再生リストにも入れる」で登録と同時にリストへ追加。
- Code.gs を更新しています。**GAS を新バージョンで再デプロイ**してください（setup の再実行は不要）。

## v1.4.0 の変更点

- **使い方ガイド**：右上の「❓ 使い方」（ポッドキャスト画面にも「❓ 使い方」）で、はじめに／ラジオ／ポッドキャスト／ライブルーム／スタジオ／困ったとき を表示。初回ログイン時は自動で1回開きます。
- **エピソードの並べ替え**（全員共通）：番組の「↕ 並べ替え」で ⤒ ↑ ↓ ⤓、「EP番号」を押して番号指定、「🔤 タイトル順にそろえる」で第01章…の番号順に一括整列。並べ替えできるのはその番組にエピソードを登録した人と管理者。サーバー（ShowOrders）に保存。
- **聞く順の設定**（1人ずつ）：番組ごとに「並び順どおり／逆順／シャッフル／自分で決めた順」。自分で決めた順は「✎ 聞く順を決める」でチェックした話だけを好きな順に。サーバー（ListenOrders）に保存するのでスマホと PC で共通。
- 「▶ 聞く順に再生」で番組を最後まで連続再生。エピソードの再生ボタンからは、その話から聞く順に続けて再生。ポッドキャスト連続再生中は DJ トークとシャッフルを挟みません。
- 不具合修正：一覧の「＋（次に再生）」ボタンが反応しなかった問題。
- Code.gs を更新しています。**GAS を新バージョンで再デプロイ**してください（シートは自動作成されるので setup の再実行は不要）。

## v1.3.1 の変更点

- 楽曲ライブラリ（セット）を選んで「↕ 並べ替え」を押すと、各曲に ⤒（一番上）↑（1つ上）↓（1つ下）⤓（一番下）が出ます。「曲No」を押すと番号を指定して移動。並び順は自動で保存され、番組表の「曲No」にもそのまま反映されます。
- 「すべての曲」は全員共通の一覧のため並べ替えできません（ライブラリを作って並べてください）。

## v1.3.0 の変更点

- **番組表**（スタジオ →「📋 番組表」）：曲と掛け合いを好きな順番で並べて放送できます。
  - 番号で入力：`掛1-1, 曲1, 曲2, 掛1-2, 曲3, 掛2` のように書いて「この順番で作る」。
  - 「曲3」＝楽曲ライブラリ（選んでいるセット）の3番目、「掛2-1」＝2番目の台本の1ブロック目、「掛2」＝台本まるごと。
  - 右側の番号一覧の「＋」でも追加でき、↑↓ で並べ替え、⏵ でその行から放送。「交互に自動で並べる」も使えます。
  - ラジオ画面の「📋 番組表で放送」でも開始できます。番組表はサーバーに保存されます。
- 楽曲ライブラリの各曲に「曲No」を表示。
- **台本一覧**（スタジオ →「📚 台本一覧」）：全台本の番号・ブロック数・セリフ数・目安の長さ・話し手・冒頭・ブロック一覧を一覧表示。

## v1.2.0 の変更点

- **楽曲ライブラリを 1人 20 セット**まで作って切り替えられます（ラジオ画面「楽曲ライブラリ」の選択欄）。各曲の 📁 でライブラリに入れる・外す、選択中のライブラリで「＋ 曲を追加」すると自動でそのライブラリにも入ります。「放送をはじめる」は選んでいるライブラリの曲を流します。
- **掛け合いの台本を 1人 50 セット**までサーバーに保存できます（スマホと PC で共通）。v1.1 でブラウザに残っていた台本は「台本1」として自動で引き継ぎます。
- **放送順**：台本ごと、またはブロックごとに「＋」で放送順に追加し、↑↓ で並べ替え、⏵ で「次はここから」を指定できます。放送順が空のときは、開いている台本を最初から流します。
- **読み上げに指示文を入れない**：「〜として、〜読み上げてください」という文が声に出てしまう問題を解消。TTS にはセリフだけを渡します。パーソナリティの「話し方」はトークの文章を作るときの口調として使います。
- 台本の音声キャッシュは作り直されます（初回だけ再生成）。

## v1.1.0 の新機能

### 音声ファイルの書き出し
- 楽曲・ポッドキャスト（Drive／外部URL）、AI DJ のトーク、台本の掛け合い、AI との対話を **MP3 / WAV / FLAC / ALAC(.m4a) / AIFF** で書き出せます。
- 変換はすべてブラウザ内で行うので、GAS の負荷はかかりません。MP3 は初回だけ cdnjs から lamejs を読み込みます。
- ALAC は非圧縮フレームで格納したロスレス形式（音質そのまま、サイズは WAV 程度）。iPhone・Mac で再生できます。
- YouTube の曲は書き出せません。外部URLの曲は、配信元が許可している場合だけ書き出せます。

### 台本の掛け合い（曲間トーク）
- 「スタジオ → 掛け合い台本」に「名前：セリフ」形式で書くか、.txt ファイルを取り込みます（Shift_JIS のメモ帳ファイルも可）。
- 「---」の行でブロックに区切り、1ブロック＝曲間1回分。話す人ごとに声（パーソナリティ）を割り当てます。
- 2人までの区間は Gemini の複数話者TTSで自然な掛け合いに、3人以上は区間を分けて生成してつなぎます。
- 作った音声はブラウザ（IndexedDB）に保存されるので、同じ台本を何度流しても API を使いません。
- ラジオ画面の「曲間に入れる」で「台本の掛け合い」または「台本 → 終わったら AI トーク」を選びます。

### AI との対話（声の変換）
- 「スタジオ → AIと対話」でマイクを押して話すと、文字起こし → 選んだパーソナリティの声に変換して再生 → AI パーソナリティが返事、の順で掛け合いになります。
- 「話し終わりの間」で決めた秒数（1〜5秒）黙るまでは聞き続けるので、考えながら話しても途切れません。マイクを押せばすぐ送信。
- 会話はまとめて書き出したり、ポッドキャストとしてライブラリに保存したりできます。
- マイクは https のページ（GitHub Pages）でのみ使えます。
