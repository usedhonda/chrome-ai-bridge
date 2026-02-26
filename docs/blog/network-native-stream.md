# なぜ我々はDOMを捨てたのか — Network-Native Stream の話

> chrome-ai-bridge v2.1 の技術的背景と、DOMセレクターからネットワーク傍受への移行について。

---

## これまでの問題

chrome-ai-bridge は、Chrome拡張機能を通じてChatGPTやGeminiのWebブラウザ版に質問を送り、回答を取得するMCPサーバーです。

v2.0 までの仕組みはシンプルでした:

```
CDP → document.querySelector('.response-class') → element.innerText
```

ブラウザのDOM（HTML要素）からCSSセレクターで回答テキストを取得する。直感的で、実装も簡単。

**しかし、この方式には致命的な弱点がありました。**

### 壊れる

ChatGPTやGeminiは頻繁にUIを更新します。クラス名が変わる、要素の構造が変わる、新しいモード（Thinkingなど）が追加される — そのたびにセレクターが壊れ、回答が取得できなくなります。

### 取りこぼす

DOMから取得できるのはプレーンテキストだけ。Markdownの太字（`**O(log n)**`）やLaTeXの数式（`$O(\log n)$`）は、レンダリング後のテキストに変換されてしまい、元のフォーマット情報が失われます。

### ストリーミングできない

DOMポーリング（定期的にテキストを確認する方式）では、回答の生成完了を待つしかありません。リアルタイムにトークンが届いていても、それを活用できません。

---

## 発想の転換

ChatGPTやGeminiがブラウザに回答を表示するとき、その裏側では **APIレスポンス** がネットワーク経由で届いています。DOMはそのレスポンスを「表示」しているに過ぎません。

**ならば、表示結果ではなく、通信そのものを読めばいい。**

```
v2.0:  CDP → DOM（表示結果を読む）
v2.1:  CDP → Network（通信そのものを読む）
```

Chrome DevTools Protocol (CDP) には `Network` ドメインがあり、ブラウザの通信をリアルタイムに傍受できます。これを使えば、ChatGPT/Geminiの内部プロトコルを直接読み取れるはずです。

---

## プロトコル解析

### ChatGPT (2026年2月時点)

ChatGPTは `/backend-api/f/conversation` エンドポイントに SSE (Server-Sent Events) 形式でレスポンスを返します。

```
event: delta_encoding
data: "v1"

event: delta
data: {"p": "/message/content/parts/0", "o": "append", "v": "Binary search"}

event: delta
data: {"v": " runs in **O(log n)** time"}
```

`delta_encoding v1` と呼ばれるフォーマットで、JSONパッチ操作としてテキストが差分で届きます。Thinkingモードの思考プロセスは `content_type: "thoughts"` として別パスに送られるため、パーサーが自然にフィルタリングします。

### Gemini (2026年2月時点)

Geminiは `StreamGenerate` エンドポイントに独自のチャンク形式で応答します。

```
)]}'
<byte_count>
[["wrb.fr", null, "<double-encoded JSON>"]]
```

`)]}'` プレフィックスに続いて、バイト数とJSON配列が交互に現れます。内部のJSONは二重エンコードされており、`inner[4][0][1][0]` にテキスト全文が格納されています（デルタではなく、毎回累積テキスト）。

---

## 実装: ハイブリッドアーキテクチャ

```
質問送信
  │
  ├─── Network傍受 ──→ プロトコルパーサー ──→ テキスト抽出 ──┐
  │    (loadingFinished + getResponseBody)                    │
  │                                                          ├─→ 回答テキスト
  └─── DOM抽出 ──→ querySelector + innerText ──→ テキスト ──┘
       (自動フォールバック)                    (Network失敗時のみ)
```

Network傍受がプライマリ。DOM抽出はフォールバックとして残しています。ユーザー側の設定は不要 — 自動で最適な方が選ばれます。

---

## 結果

実際のテスト結果:

| 指標 | ChatGPT | Gemini |
|------|---------|--------|
| Network vs DOM の単語一致率 | 100% | 100% |
| Markdown/LaTeX の保持 | あり | あり |
| Thinkingモードの自動フィルタ | あり | N/A |
| UI変更への耐性 | あり | あり |

**100% の単語一致** — Networkから抽出したテキストとDOMから抽出したテキストが完全に一致することを確認しています。

---

## プライバシーについて

- 通信傍受はすべてローカルのブラウザ内で行われます（CDP経由）
- 外部サーバーへのデータ送信はありません
- 傍受したデータはメモリ上で処理され、ディスクに保存されません
- chrome-ai-bridge はオープンソース (Apache-2.0) です

---

## 今後の展望

Network-Native Streamは第一歩です。この基盤の上に:

- **Phase 1.5**: リアルタイムトークンストリーミング（`Network.dataReceived` による逐次配信）
- **Phase 2**: AIによる適応的セレクター検出（DOM側のさらなる強化）
- **Phase 3**: マルチプロバイダー・プラグインアーキテクチャ

---

## まとめ

> **UIが変わっても、もう壊れない。**

DOMセレクターからネットワーク傍受へ。表示結果を読むのではなく、通信そのものを読む。この発想の転換が、chrome-ai-bridge の信頼性を根本から変えました。

ChatGPTやGeminiがどれだけUIを更新しても、内部の通信プロトコルは変わりません。chrome-ai-bridge v2.1 は、その安定した土台の上に立っています。
