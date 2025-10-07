# LINE AI Bot (秋田オンライン塾)

## アーキテクチャ概要
```
LINE App
   ↓ (Webhook)
Google Apps Script (Web App)
   ├─ Knowledge Search (Google Sheets)
   ├─ Gemini 2.5 Flash 呼び出し
   ├─ ガードレールチェック
   ├─ 信頼度判定 (80%自動応答 / 要レビュー)
   └─ ログ保存 (Sheets)
```

- Google Apps Script を Web アプリとして公開し、LINE Messaging API のWebhookに設定します。
- ナレッジは Google スプレッドシート（`key`, `title`, `content`）で管理します。
- 回答は 2段階判定：
  - ナレッジのスコア ≥ 0.80 → 即時回答
  - それ以外は Gemini 応答を生成。AI confidence ≥ 0.80 なら自動回答、未満はフォールバック文で人手レビュー。
- LINEの reply API を利用し、`replyToken` に対して1レスポンス。必要に応じて push 対応も実装（オプション）。

## 信頼度・閾値
| 判定 | 条件 | アクション |
|------|------|------------|
| ナレッジ自動応答 | knowledge.confidence ≥ 0.80 | ナレッジ回答を返信、`needsReview=false` |
| Gemini自動応答 | knowledge.confidence < 0.80 かつ aiConfidence ≥ 0.80 | Gemini回答を返信 |
| レビュー要 | aiConfidence < 0.80 またはガードレールNG | 定型メッセージ＋バックエンドにドラフト保存 |

- `CONFIG.CONFIDENCE_THRESHOLD.AUTO_REPLY = 80` (％表記)
- `CONFIG.CONFIDENCE_THRESHOLD.NEEDS_REVIEW = 80`

## 設定項目 (Script Properties 推奨)
| キー | 用途 |
|------|------|
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API のチャネルアクセストークン |
| `LINE_CHANNEL_SECRET` | Webhook署名検証に使用（任意） |
| `GEMINI_API_KEY` | Gemini 2.5 Flash 呼び出し用 |
| `SPREADSHEET_ID` | ナレッジ／ログ格納先スプレッドシート |

## フォルダ構成 (提案)
```
LINEのAIbot構築プロジェクト/
├─ line_bot/
│   ├─ main.gs (Apps Script本体)
│   └─ README.md (このファイル)
├─ line_bot_knowledge.csv (LINEボット用ナレッジ)
└─ 塾計画ナレッジ.txt (基礎資料)
```

## Webhook シーケンス
1. LINE ユーザーがメッセージ送信。
2. LINE プラットフォームが Webhook に POST。ヘッダー `X-Line-Signature`。
3. Apps Script `doPost` が署名検証 → イベントループ。
4. メッセージイベントを解析 → ナレッジ検索 → Gemini → コンプライアンス判定。
5. `replyToken` に対して Json で reply API を呼び出し、レスポンスを返却。
6. 会話ログはスプレッドシートに追記（質問/回答/ソース/信頼度/レビュー要否/ユーザーID）。

## ガードレール例
- 金融・投資勧誘禁止ワード
- 税務・法務の断言回避
- 個人情報要求ブロック

トリガー時は安全回答を返し、生成したドラフトはログに残して人間が確認できます。

## 今後のカスタマイズ
- 管理者向け通知（LINEグループやGoogle Chat）
- 画像/PDF宿題受付（Messaging APIのcontent取得）
- ログ閲覧用のダッシュボード (Looker Studio etc.)

## セットアップ手順
1. Google スプレッドシートを作成し、1行目に `key`, `title`, `content` を追加。`line_bot_knowledge.csv` を貼り付けると初期データが整います。
2. Apps Script プロジェクトを開き、`main.gs` の内容をコピー＆ペースト。
3. Script Properties に以下を設定:
   - `GEMINI_API_KEY`
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `LINE_CHANNEL_SECRET` (署名検証を行う場合)
   - `SPREADSHEET_ID`
4. 「ウェブアプリケーションとして導入」をクリックし、誰でも（匿名可）アクセスできる形でデプロイ。
5. LINE Developers コンソールでチャネルを作成し、Webhook URL に Web アプリの URL を設定。テスト送信で `OK` が返ることを確認。
6. 応答メッセージは LINE 側で無効、`Messaging API > Auto-reply` をオフに設定。
7. 実運用前に LINE で複数の想定質問を投げ、ナレッジとGeminiの信頼度判定を確認。ログシートで `confidence` と `needsReview` をチェックします。

## 運用ヒント
- レビュー対象 (`needsReview = true`) の行をフィルタし、人間が回答テンプレを整備 → シートに追記して AI 応答率を高める。
- キーワードが増えたら `GUARDRAILS.forbiddenKeywords` を更新。
- オプションで Google Chat などへの通知を加えれば、要レビュー時にチームへアラート可能。

## 禁忌ガードレール
- 金融・投資に関する助言や商品紹介の依頼（例: 「株を教えて」「必ず儲かる方法は？」）
- 税務・法務の判断依頼（例: 「確定申告はどうすれば」「違法かどうか教えて」）
- 個人情報の取得要求（住所・電話番号・カード番号・口座番号・マイナンバー・講師の個人情報など）
- 合格保証や試験の裏ワザ要求（例: 「必ず合格させて」「試験の答えを教えて」）
- 医療・診断・薬の指示といった専門的アドバイスの要求

上記キーワードを含む場合はガードレールで自動検知し、安全メッセージを返して人手対応へ切り替えます。
