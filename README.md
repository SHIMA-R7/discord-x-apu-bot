# APU Discord to X Bot

Discordの共有Xアカウント運用Botです。

- `#制限なし投稿`: 投稿文を即時Xへ投稿します。
- `#投稿`: 140字以内か確認し、Geminiでルール違反を判定して、問題なければキューに追加します。
- キューは約 `10±1分` ごとにXへ投稿されます。
- Discordの画像添付をXの画像付き投稿として扱います。
- 毎日1回、`#システム` とXへ日次レポートを送ります。

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

`.env` に `DISCORD_TOKEN` と `GEMINI_API_KEY` を設定してください。

Xへ投稿する前に、APU専用のブラウザプロファイルで初回ログインします。

```powershell
npm run x:login
```

ブラウザでXにログインしたら、ターミナルでEnterを押して閉じます。ログイン状態は `.x-profile-apu` に保存されます。

## kyohi-chanとの同時運用

kyohi-chanがVSCodeとFirefoxで動いている場合でも、このBotはChromeの専用プロファイル `.x-profile-apu` を使うため、別アカウントとして同時運用できます。

APU Botは毎回Xにログインしません。初回ログイン済みのプロファイルを使い、Bot起動中はそのブラウザを開いたまま投稿します。ヘッドレスモードでは起動しません。

重要なのは、APU側の `.env` で `X_PROFILE_DIR` をkyohi-chan側のプロファイルやFirefoxプロファイルにしないことです。

```env
X_PROFILE_DIR=.x-profile-apu
X_BROWSER_CHANNEL=chrome
```

ChromeではなくEdgeを使う場合は、次のようにします。

```env
X_BROWSER_CHANNEL=msedge
X_PROFILE_DIR=.x-profile-apu-edge
```

APU用アカウントの初回ログインだけ、次を実行してください。

```powershell
npm.cmd run x:login
```

kyohi-chan側はそのままFirefoxで起動し、APU側はこのフォルダで `npm.cmd start` すれば並行して動かせます。

Botを起動します。

```powershell
npm.cmd start
```

## Slash Commands

Bot起動時にDiscordサーバーへスラッシュコマンドを登録します。

キュー内の投稿を削除するには:

```text
/delete index:1
```

`index` はBotが返す「リストn番目」の n です。画像付き投稿を削除した場合、保存済みの一時画像も削除されます。

## Daily Report

デフォルトでは毎日23:59に、次の内容を `#システム` とXへ送ります。

- 総メンバー数
- アクティブメンバー数
- 本日の投稿件数
- 累計投稿件数

投稿件数は、実際にX投稿が成功したものだけを数えます。アクティブメンバー数は、その日にX投稿が通ったユーザー数です。

時刻やチャンネル名は `.env` で変更できます。

```env
SYSTEM_CHANNEL_NAME=システム
DAILY_REPORT_HOUR=23
DAILY_REPORT_MINUTE=59
```

## Image Posts

Discordで投稿するときに画像を添付すると、Xにも画像付きで投稿されます。

- 対応形式: JPG, PNG, GIF, WebP
- 最大4枚まで
- `#制限なし投稿`: 即時投稿
- `#投稿`: 本文だけGemini判定し、問題なければ画像付きでキューに追加

本文なしで画像だけ投稿することもできます。ただし、現時点ではGeminiは画像の中身を審査しません。

## Gemini判定コード

- `0`: 問題なし
- `1`: 誹謗中傷、個人攻撃、差別的表現
- `2`: 個人情報、住所、電話番号、メールアドレス、アカウント晒し
- `3`: 違法行為、犯罪予告、自傷他害の助長
- `4`: スパム、宣伝、意味不明な連投
- `5`: 性的・過度に暴力的・公序良俗に反する内容
- `6`: その他、共有アカウントで投稿すべきでない内容
- `7`: 140字を超えている

140字超過はAPI費用削減のため、Geminiへ送る前にBot側でも拒否します。
