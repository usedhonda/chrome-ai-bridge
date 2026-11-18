---
name: ask-ai
description: ChatGPT ProやGemini思考モードを、Claude CodeまたはCodexのブラウザ操作で利用する。「ChatGPTに依頼」「Geminiに聞いて」「AIに聞いて」「両方に聞いて」、リポジトリの実装・レビュー依頼、既存のAI会話の継続で使う。プロジェクト別のチャットURLと進捗をCABに保存し、ChatGPTは実際のPR、Geminiはチャット回答まで取得する。
---

# ask-ai

呼び出し元のブラウザ機能で操作し、CABで会話と実行状態を保存する。`prepare`が返すのは作業指示であり、AIの回答ではない。ブラウザ操作と完了記録まで進める。

## 準備

- このスキルに同梱された `scripts/ask-ai` の絶対パスを一度解決し、全工程で同じ実行ファイルを使う。以下の `cab` はその実行ファイルの略記として読み替える。返された `commandPrefix` がある場合はその引数列を使う。途中でPATH上の古い `cab` に切り替えない。Claude専用のインストール先を決め打ちしない。
- 現在のセッションで提供されるブラウザ機能とその利用指示を確認する。ClaudeのChrome連携、CodexのBrowser、設定済みのブラウザMCPを利用できる。ツール名を推測しない。
- ユーザーが使っているログイン済みブラウザを優先する。新しいブラウザプロファイルや旧CABデーモンを自動で起動しない。
- 安定したプロジェクト名、GitHub URL、public/private、依頼内容を決める。既知の情報を使い、不明点が実行を妨げる場合だけ確認する。プロジェクト名は呼び出しやエージェントの切り替えで変えない。
- プロバイダー指定を優先する。指定がなければ[ルーティング規則](references/routing-rules.md)を読む。

## プロバイダー別契約

| 対象    | モード                                                | コードの渡し方                                           | 完了条件                               |
| ------- | ----------------------------------------------------- | -------------------------------------------------------- | -------------------------------------- |
| ChatGPT | Pro                                                   | public/privateともGitHub URL。接続済みを前提に依頼       | 最終回答と、ブランチを作成した実際のPR |
| Gemini  | Thinking / 思考。思考レベルのUIなら明示的にHighを選択 | publicはURL。privateは選択したコードをプロンプトに含める | コードや差分を含む最終チャット回答     |

モデル番号を固定しない。ChatGPTの契約プラン表示をPro選択の証拠にしない。GeminiのHighは思考レベルのコントロールであることを確認し、`Thinking: High`など実際に確認した意味を記録する。単なる`High`は使わない。必要なモードが使えなければブロッカーを保存し、勝手に格下げしない。

## 実行

1. 依頼をUTF-8ファイルに保存し、準備する。必要なら[依頼テンプレート](assets/prompt-template.md)を使う。

   ```bash
   cab prepare chatgpt --project NAME --repo URL --visibility private --prompt-file task.txt
   ```

   Geminiのprivate依頼は、続きの質問でも最新の関連コードを明示する。

   ```bash
   cab prepare gemini --project NAME --repo URL --visibility private --root /absolute/repo --context src/service.ts --context src/types.ts:20:100 --prompt-file task.txt
   ```

   `--context`は必要なファイルか1始まり・終端を含む行範囲だけを選ぶ。全リポジトリを自動で詰めない。`both`は別々のrunを返し、privateコードはGemini側だけに含まれる。必要なら安定した`--request-id`を付け、同じ準備の再実行を識別する。

2. 返されたrunとブラウザ指示を読む。初回は**新規ページ**を開く。続きは保存されたチャットURLを使う。他プロジェクトの既存チャットに入力しない。タブが消えていれば保存URLを開く。

3. 画面で対象会話と必要なモードを確認する。Temporary chat / 一時チャット / 履歴を残さないモードが無効で、保存される会話であることも確認してから記録する。永続化できない場合は送信前にブロックし、アカウント全体のプライバシー設定を黙って変更しない。初回の新規会話には`--new-page`が必須。観察したタブ識別子があれば保存する。

   ```bash
   cab ready RUN --url OBSERVED_URL --mode 'Pro' --tab TAB_HANDLE --new-page
   cab prompt RUN
   ```

   継続会話では実際のチャットURLを渡し、`--new-page`を付けない。`prompt`出力をそのまま入力し、コードの改行と書式を保つ。

4. 入力を確認し、送信クリックの直前に送信開始を保存する。

   ```bash
   cab begin-send RUN
   ```

   **成功した一度だけ**ブラウザで送信を押す。コマンドの再実行やタイムアウトを二度目の送信許可と解釈しない。

5. 新しいユーザーメッセージの受理を確認し、会話URLが付いた時点ですぐに保存する。回答完了を待ってから保存しない。

   ```bash
   cab sent RUN --url OBSERVED_CONVERSATION_URL
   ```

6. 同じ会話で最終回答まで待つ。途中の思考や過去の回答を今回の結果にしない。最終回答をUTF-8ファイルに保存し、コード・差分・リンクを保持する。

   ```bash
   cab complete RUN --answer-file answer.md --pr ACTUAL_PR_URL
   ```

   ChatGPTは実際のGitHub PRを検証して完了する。PRの約束やURLらしい文字列だけで終了しない。private PRの検証にはローカル`gh`認証または`GH_TOKEN` / `GITHUB_TOKEN`が必要で、ChatGPTのGitHub接続とは別。検証だけが失敗した場合は完了処理を再試行し、依頼を再送しない。プロバイダーが接続不可などの最終失敗回答を返した場合は、後述の`fail`で保存する。

   Geminiは`--pr`を付けずに完了する。Geminiの提案を勝手に適用・コミット・pushしない。

7. チャットURLと成果物を返す。ChatGPTは検証済みPRと要点、Geminiは回答とコードを伝える。両方を使った場合はそれぞれの結果・未完了状態を明示する。

## 中断からの継続

```bash
cab status RUN
cab resume RUN
```

`resume`は状態を読むだけ。`sending`なら送信が済んでいる可能性があるため、元のタブか会話を確認する。受理済みなら`sent`を記録し、同じ回答を待つ。送信済みか不明なら再送せず、`cab block RUN --reason TEXT`で観察した問題を保存する。

`sending`でも、実際には送信されていないと画面から確実に確認できた場合だけ、観察したURLと根拠を保存する。

```bash
cab reconcile-not-sent RUN --url OBSERVED_URL --reason EVIDENCE
```

これで`ready`に戻るが、送信許可にはならない。改めて画面とモードを確認し、`ready`と`begin-send`を実行してから送信する。タイムアウト、タブ消失、回答がないことだけでは未送信と判断しない。

`submitted`なら保存URLを開いて既存の回答を取得する。プロバイダーが最終的な失敗・機能不足を回答した場合だけ、その回答を保存して記録する。

```bash
cab fail RUN --answer-file answer.md --reason REASON
```

`failed`としてURLと回答を残し、同じ会話への修正依頼を可能にする。成功とは報告しない。まだ処理中の回答や一時的な切断には`block`を使う。

`completed`なら保存された結果を返す。ブロッカーは元の段階と証拠を保持する。キャンセルは送信前だけ。遅い回答、切断、ツール失敗を理由に`--new-chat`や状態削除でやり直さない。

ブラウザがない、ログインが必要、モードが使えないなどの場合は、できた作業と具体的な阻害要因を報告する。ユーザーが既に許可した作業の確認を繰り返さず、続行できる工程は完了させる。
