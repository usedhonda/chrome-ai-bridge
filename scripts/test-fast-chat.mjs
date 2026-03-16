#!/usr/bin/env node
/**
 * fast-chat.ts 直接テストスクリプト
 *
 * MCPサーバーを介さずにfast-chat機能を直接テストする。
 * デバッグ時のフィードバックループを高速化するためのツール。
 *
 * 使い方:
 *   # ビルド後に実行（browser-globals-mockは--importで自動適用）
 *   node --import ./scripts/browser-globals-mock.mjs scripts/test-fast-chat.mjs chatgpt
 *   node --import ./scripts/browser-globals-mock.mjs scripts/test-fast-chat.mjs gemini
 *   node --import ./scripts/browser-globals-mock.mjs scripts/test-fast-chat.mjs both "質問文"
 *
 * npm scriptとして:
 *   npm run test:chatgpt
 *   npm run test:gemini
 *   npm run test:both
 */

import {
  askChatGPTFast,
  askGeminiFast,
  askChatGPTFastWithTimings,
  askGeminiFastWithTimings,
  getClient,
  getPageDom,
} from '../build/src/fast-cdp/fast-chat.js';
import {
  generateAgentId,
  setAgentId,
} from '../build/src/fast-cdp/agent-context.js';

// Initialize agent ID for Agent Teams support
const agentId = generateAgentId('test-script');
setAgentId(agentId);

const target = process.argv[2] || 'chatgpt';
const questionArg = process.argv[3];
const dumpDom = process.argv.includes('--dump-dom');
const skipRelevanceCheck = process.argv.includes('--skip-relevance');

/**
 * ユニークな質問を生成する
 * キャッシュ回避のため、タイムスタンプと乱数を質問に埋め込む
 */
function generateUniqueQuestion() {
  const now = new Date();
  const timestamp = now.toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const randomId = Math.random().toString(36).slice(2, 8).toUpperCase();

  // 質問テンプレート（技術的で自然なもの）
  const templates = [
    `ID:${randomId}の識別子を使って、JavaScriptで配列をシャッフルする関数を書いて。結果は1行で。`,
    `${timestamp}時点での回答として、Pythonのリスト内包表記の利点を1文で説明して。`,
    `セッション${randomId}: TypeScriptのOptional Chainingの使い方を20文字以内で。`,
    `テストID-${randomId}: Goのdeferの動作を1文で説明して。`,
    `${timestamp}の質問: Rustの所有権システムの目的を30字以内で。`,
    `クエリ${randomId}: Node.jsのイベントループを1文で説明して。`,
    `${randomId}番: ReactのuseEffectのクリーンアップ関数の役割は？20字以内で。`,
    `リクエスト${randomId}: SQLのINDEXが高速化する理由を1文で。`,
    `${timestamp}発: Dockerコンテナと仮想マシンの違いを1文で。`,
    `ID${randomId}: Gitのrebaseとmergeの違いを20字以内で説明して。`,
  ];

  const index = Math.floor(Math.random() * templates.length);
  return templates[index];
}

// 質問が指定されていなければ自動生成
const question = questionArg || (dumpDom ? null : generateUniqueQuestion());

/**
 * 質問からキーワードを抽出する
 * @param {string} question - 質問文
 * @returns {string[]} - キーワードの配列
 */
function extractKeywords(question) {
  const keywords = [];

  // 1. 英語の技術用語を抽出（大文字小文字を保持）
  const englishTerms =
    question.match(/[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*/g) || [];
  for (const term of englishTerms) {
    if (term.length >= 2) {
      keywords.push(term.toLowerCase());
    }
  }

  // 2. カタカナ語を抽出（技術用語に多い）
  const katakanaTerms = question.match(/[ァ-ヶー]+/g) || [];
  for (const term of katakanaTerms) {
    if (term.length >= 2) {
      keywords.push(term);
    }
  }

  // 3. 日本語の重要そうな単語（助詞で区切る）
  const japaneseWords = question
    .replace(/[A-Za-z0-9ァ-ヶー]+/g, ' ') // 英語・カタカナを除去
    .split(
      /[はをのがにでとからまでよりへやかもなだですますしたするしてされるということようについてにおいてとしてというためのことものところときようためほうほか何どうどのこのそのあのどんな教えて説明簡潔詳しく具体的例方法1つ一つひとつ]+/,
    )
    .filter(w => w.length >= 2);

  for (const word of japaneseWords) {
    if (word.length >= 2) {
      keywords.push(word);
    }
  }

  // 重複を除去
  return [...new Set(keywords)];
}

/**
 * 回答が質問に関連しているかチェック
 * @param {string} question - 質問文
 * @param {string} answer - 回答文
 * @returns {{relevant: boolean, matchedKeywords: string[], totalKeywords: number, matchRate: number}}
 */
function checkRelevance(question, answer) {
  const keywords = extractKeywords(question);
  const answerLower = answer.toLowerCase();

  const matchedKeywords = keywords.filter(kw =>
    answerLower.includes(kw.toLowerCase()),
  );

  const matchRate =
    keywords.length > 0 ? matchedKeywords.length / keywords.length : 0;

  // 最低1つのキーワードがマッチするか、マッチ率が20%以上
  const relevant = matchedKeywords.length >= 1 || matchRate >= 0.2;

  return {
    relevant,
    matchedKeywords,
    totalKeywords: keywords.length,
    matchRate: Math.round(matchRate * 100),
  };
}

/**
 * 数値をカンマ区切りでフォーマット
 * @param {number} num - 数値
 * @returns {string} - フォーマットされた文字列
 */
function formatNumber(num) {
  return num.toLocaleString('en-US');
}

/**
 * バーグラフを生成
 * @param {number} percentage - パーセンテージ (0-100)
 * @param {number} width - バーの幅 (デフォルト20)
 * @returns {string} - バーグラフ文字列
 */
function createBar(percentage, width = 20) {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * ボトルネック分析の閾値
 */
const THRESHOLDS = {
  connectMs: {expected: 2000, warning: 5000, improvable: true, label: '接続'},
  waitInputMs: {
    expected: 1000,
    warning: 3000,
    improvable: true,
    label: '入力欄待機',
  },
  inputMs: {
    expected: 500,
    warning: 2000,
    improvable: true,
    label: 'テキスト入力',
  },
  sendMs: {
    expected: 2000,
    warning: 10000,
    improvable: true,
    label: '送信ボタン待機',
  },
  waitResponseMs: {
    expected: -1,
    warning: -1,
    improvable: false,
    label: '回答待機',
  },
  navigateMs: {
    expected: 1000,
    warning: 3000,
    improvable: true,
    label: 'ナビゲーション',
  },
};

/**
 * タイミングレポートを出力
 * @param {string} provider - 'ChatGPT' or 'Gemini'
 * @param {string} questionText - 質問文
 * @param {object} timings - タイミングデータ
 */
function printTimingReport(provider, questionText, timings) {
  const phases = [
    {name: '接続確立', key: 'connectMs'},
    {name: '入力欄待機', key: 'waitInputMs'},
    {name: 'テキスト入力', key: 'inputMs'},
    {name: '送信ボタン待機', key: 'sendMs'},
    {name: '回答待機', key: 'waitResponseMs'},
  ];

  // Gemini の場合はナビゲーションを追加
  if (timings.navigateMs !== undefined) {
    phases.splice(1, 0, {name: 'ナビゲーション', key: 'navigateMs'});
  }

  const total = timings.totalMs || 0;

  // 最大値を持つフェーズを特定
  let maxPhase = phases[0];
  for (const phase of phases) {
    const ms = timings[phase.key] || 0;
    if (ms > (timings[maxPhase.key] || 0)) {
      maxPhase = phase;
    }
  }

  console.error('');
  console.error('========================================');
  console.error(`=== ${provider} パフォーマンスレポート ===`);
  console.error('========================================');
  console.error(
    `質問: "${questionText.slice(0, 60)}${questionText.length > 60 ? '...' : ''}"`,
  );

  // タイミング詳細
  console.error('');
  console.error('## タイミング詳細');
  console.error('');

  for (const phase of phases) {
    const ms = timings[phase.key] || 0;
    const pct = total > 0 ? (ms / total) * 100 : 0;
    const bar = createBar(pct);
    const marker = phase.key === maxPhase.key ? ' ← 最大' : '';
    const msStr = formatNumber(ms).padStart(6);
    const pctStr = pct.toFixed(1).padStart(5);
    console.error(
      `  ${phase.name.padEnd(14)}: ${msStr} ms (${pctStr}%) ${bar}${marker}`,
    );
  }

  console.error(`  ${'─'.repeat(37)}`);
  const totalStr = formatNumber(total).padStart(6);
  console.error(`  ${'合計'.padEnd(14)}: ${totalStr} ms (100.0%)`);

  // ボトルネック分析
  console.error('');
  console.error('## ボトルネック分析');
  console.error('');

  const bottlenecks = [];
  for (const phase of phases) {
    const ms = timings[phase.key] || 0;
    const pct = total > 0 ? (ms / total) * 100 : 0;
    const threshold = THRESHOLDS[phase.key];
    if (!threshold) continue;

    let severity = '🟢';
    let reason = '正常範囲';

    if (!threshold.improvable) {
      severity = '🔵';
      reason = 'AI応答速度（改善不可）';
    } else if (threshold.warning > 0 && ms > threshold.warning) {
      severity = '🔴';
      reason = `${threshold.expected}ms 期待 / ${threshold.warning}ms 警告閾値超過`;
    } else if (threshold.expected > 0 && ms > threshold.expected) {
      severity = '🟡';
      reason = '改善の余地あり';
    }

    bottlenecks.push({
      severity,
      name: phase.name,
      ms,
      pct,
      reason,
      improvable: threshold.improvable,
    });
  }

  // 重要度順にソート
  bottlenecks.sort((a, b) => {
    const order = {'🔴': 0, '🟡': 1, '🔵': 2, '🟢': 3};
    return (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
  });

  for (const b of bottlenecks.slice(0, 4)) {
    console.error(
      `  ${b.severity} ${b.name}: ${formatNumber(b.ms)}ms (${b.pct.toFixed(1)}%) - ${b.reason}`,
    );
  }

  // 改善提案
  console.error('');
  console.error('## 改善提案');
  console.error('');

  const suggestions = [];

  if ((timings.connectMs || 0) > 3000) {
    suggestions.push('• 接続: 既存タブ再利用が機能しているか確認');
  }
  if ((timings.sendMs || 0) > 5000) {
    suggestions.push('• 送信ボタン: 前回応答が完了してから新規質問を送信');
  }
  if ((timings.waitInputMs || 0) > 2000) {
    suggestions.push('• 入力欄: ページの初期ロード完了を待つ');
  }
  if ((timings.navigateMs || 0) > 2000) {
    suggestions.push(
      '• ナビゲーション: 既存タブを再利用してナビゲーション回避',
    );
  }

  if (suggestions.length === 0) {
    suggestions.push('• 特になし（パフォーマンスは良好です）');
  }

  for (const s of suggestions) {
    console.error(`  ${s}`);
  }

  console.error('');
  console.error('========================================');
}

// ヘルプ表示
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.error('');
  console.error('使い方:');
  console.error(
    '  npm run test:chatgpt              # ユニークな質問を自動生成',
  );
  console.error(
    '  npm run test:gemini               # ユニークな質問を自動生成',
  );
  console.error('  npm run test:both                 # 両方テスト');
  console.error('  npm run test:chatgpt -- "質問文"  # 指定した質問を使用');
  console.error('');
  console.error('オプション:');
  console.error('  --dump-dom         DOMスナップショットを取得');
  console.error('  --skip-relevance   関連性チェックをスキップ');
  console.error('');
  console.error(
    '質問を省略すると、タイムスタンプと乱数を含むユニークな質問が自動生成されます。',
  );
  console.error(
    'これにより、キャッシュされた回答ではなく新しい応答であることを確認できます。',
  );
  console.error('');
  process.exit(0);
}

async function testChatGPT(q) {
  console.error('\n========================================');
  console.error('=== ChatGPT テスト開始 ===');
  console.error('========================================');
  console.error(`質問: "${q}"`);
  console.error('');

  const startTime = Date.now();
  try {
    // 接続確立フェーズ
    console.error('[Phase 1] クライアント接続中...');
    const client = await getClient('chatgpt');
    console.error(`[Phase 1] 接続完了 (${Date.now() - startTime}ms)`);

    // 質問送信フェーズ（タイミング情報付き）
    console.error('[Phase 2] 質問送信中...');
    const result = await askChatGPTFastWithTimings(q);
    const {answer, timings} = result;
    const elapsed = timings.totalMs;

    // 関連性チェック
    const relevance = checkRelevance(q, answer);

    console.error('');
    console.error('========================================');
    console.error('=== ChatGPT 結果 ===');
    console.error('========================================');
    console.error(`回答: ${answer}`);
    console.error(`所要時間: ${elapsed}ms`);
    console.error('');
    console.error('--- 関連性チェック ---');
    console.error(`キーワード: ${extractKeywords(q).join(', ')}`);
    console.error(
      `マッチ: ${relevance.matchedKeywords.join(', ') || '(なし)'}`,
    );
    console.error(
      `マッチ率: ${relevance.matchRate}% (${relevance.matchedKeywords.length}/${relevance.totalKeywords})`,
    );
    console.error(
      `関連性: ${relevance.relevant ? '✅ あり' : '❌ なし（前の会話の可能性）'}`,
    );
    console.error('========================================');

    // パフォーマンスレポート出力
    printTimingReport('ChatGPT', q, timings);

    // 関連性がない場合は警告
    if (!relevance.relevant && !skipRelevanceCheck) {
      console.error('');
      console.error('⚠️  警告: 回答が質問と関連していない可能性があります');
      console.error('    前の会話の続きが返ってきた可能性があります');
      return {
        success: false,
        answer,
        elapsed,
        timings,
        error: 'Response not relevant to question',
        relevance,
      };
    }

    return {success: true, answer, elapsed, timings, relevance};
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error('');
    console.error('========================================');
    console.error('=== ChatGPT エラー ===');
    console.error('========================================');
    console.error(`エラー: ${err.message}`);
    console.error(`スタックトレース:\n${err.stack}`);
    console.error(`所要時間: ${elapsed}ms`);
    console.error('========================================');

    return {success: false, error: err.message, elapsed};
  }
}

async function testGemini(q) {
  console.error('\n========================================');
  console.error('=== Gemini テスト開始 ===');
  console.error('========================================');
  console.error(`質問: "${q}"`);
  console.error('');

  const startTime = Date.now();
  try {
    // 接続確立フェーズ
    console.error('[Phase 1] クライアント接続中...');
    const client = await getClient('gemini');
    console.error(`[Phase 1] 接続完了 (${Date.now() - startTime}ms)`);

    // 質問送信フェーズ（タイミング情報付き）
    console.error('[Phase 2] 質問送信中...');
    const result = await askGeminiFastWithTimings(q);
    const {answer, timings} = result;
    const elapsed = timings.totalMs;

    // 関連性チェック
    const relevance = checkRelevance(q, answer);

    console.error('');
    console.error('========================================');
    console.error('=== Gemini 結果 ===');
    console.error('========================================');
    console.error(`回答: ${answer}`);
    console.error(`所要時間: ${elapsed}ms`);
    console.error('');
    console.error('--- 関連性チェック ---');
    console.error(`キーワード: ${extractKeywords(q).join(', ')}`);
    console.error(
      `マッチ: ${relevance.matchedKeywords.join(', ') || '(なし)'}`,
    );
    console.error(
      `マッチ率: ${relevance.matchRate}% (${relevance.matchedKeywords.length}/${relevance.totalKeywords})`,
    );
    console.error(
      `関連性: ${relevance.relevant ? '✅ あり' : '❌ なし（前の会話の可能性）'}`,
    );
    console.error('========================================');

    // パフォーマンスレポート出力
    printTimingReport('Gemini', q, timings);

    // 関連性がない場合は警告
    if (!relevance.relevant && !skipRelevanceCheck) {
      console.error('');
      console.error('⚠️  警告: 回答が質問と関連していない可能性があります');
      console.error('    前の会話の続きが返ってきた可能性があります');
      return {
        success: false,
        answer,
        elapsed,
        timings,
        error: 'Response not relevant to question',
        relevance,
      };
    }

    return {success: true, answer, elapsed, timings, relevance};
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error('');
    console.error('========================================');
    console.error('=== Gemini エラー ===');
    console.error('========================================');
    console.error(`エラー: ${err.message}`);
    console.error(`スタックトレース:\n${err.stack}`);
    console.error(`所要時間: ${elapsed}ms`);
    console.error('========================================');

    return {success: false, error: err.message, elapsed};
  }
}

async function dumpDomSnapshot(kind) {
  console.error('\n========================================');
  console.error(`=== ${kind.toUpperCase()} DOM取得開始 ===`);
  console.error('========================================');

  const startTime = Date.now();
  try {
    // 接続確立フェーズ
    console.error('[Phase 1] クライアント接続中...');
    const client = await getClient(kind);
    console.error(`[Phase 1] 接続完了 (${Date.now() - startTime}ms)`);

    // DOM取得フェーズ
    console.error('[Phase 2] DOM取得中...');
    const snapshot = await getPageDom(kind);
    const elapsed = Date.now() - startTime;

    console.error('');
    console.error('========================================');
    console.error(`=== ${kind.toUpperCase()} DOM結果 ===`);
    console.error('========================================');
    console.error(`URL: ${snapshot.url}`);
    console.error(`Title: ${snapshot.title}`);
    console.error(`Connected: ${snapshot.connected}`);
    console.error('');

    // セレクター結果を出力
    console.error('## Selector Results');
    for (const [selector, result] of Object.entries(snapshot.selectors)) {
      console.error(`\n### \`${selector}\` (${result.count} elements)`);
      for (let i = 0; i < result.elements.length; i++) {
        const el = result.elements[i];
        console.error(`  Element ${i + 1}: <${el.tagName}>`);
        const attrs = Object.entries(el.attributes).slice(0, 5);
        for (const [name, value] of attrs) {
          console.error(
            `    ${name}="${value.slice(0, 50)}${value.length > 50 ? '...' : ''}"`,
          );
        }
        if (el.textContent) {
          console.error(
            `    text: "${el.textContent.slice(0, 80)}${el.textContent.length > 80 ? '...' : ''}"`,
          );
        }
      }
    }

    // メッセージ結果を出力
    if (snapshot.messages && snapshot.messages.length > 0) {
      console.error('\n## Messages');
      console.error(`  Total: ${snapshot.messages.length}`);
      const userMsgs = snapshot.messages.filter(m => m.role === 'user');
      const assistantMsgs = snapshot.messages.filter(
        m => m.role === 'assistant',
      );
      console.error(
        `  User: ${userMsgs.length}, Assistant: ${assistantMsgs.length}`,
      );

      // 最新4件を表示
      const recent = snapshot.messages.slice(-4);
      console.error('\n### Recent Messages');
      for (const msg of recent) {
        const role = msg.role === 'user' ? '👤' : '🤖';
        console.error(
          `  ${role} ${msg.text.slice(0, 100)}${msg.text.length > 100 ? '...' : ''}`,
        );
      }
    }

    console.error('');
    console.error(`所要時間: ${elapsed}ms`);
    console.error('========================================');

    return {success: true, snapshot, elapsed};
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error('');
    console.error('========================================');
    console.error(`=== ${kind.toUpperCase()} エラー ===`);
    console.error('========================================');
    console.error(`エラー: ${err.message}`);
    console.error(`スタックトレース:\n${err.stack}`);
    console.error(`所要時間: ${elapsed}ms`);
    console.error('========================================');

    return {success: false, error: err.message, elapsed};
  }
}

async function main() {
  console.error('');
  console.error('╔════════════════════════════════════════╗');
  console.error('║  fast-chat.ts 直接テストスクリプト    ║');
  console.error('╚════════════════════════════════════════╝');
  console.error('');
  console.error(`ターゲット: ${target}`);
  if (question) {
    const autoGenerated = !questionArg;
    console.error(`質問: "${question}"`);
    if (autoGenerated) {
      console.error('      ↑ 自動生成（タイムスタンプ/乱数でユニーク化）');
    }
  } else {
    console.error('質問: (なし)');
  }
  console.error(`--dump-dom: ${dumpDom}`);
  console.error('');

  // --dump-dom モードの場合
  if (dumpDom) {
    const results = {};
    if (target === 'chatgpt' || target === 'both') {
      results.chatgpt = await dumpDomSnapshot('chatgpt');
    }
    if (target === 'gemini' || target === 'both') {
      results.gemini = await dumpDomSnapshot('gemini');
    }
    const allSuccess = Object.values(results).every(r => r.success);
    process.exit(allSuccess ? 0 : 1);
  }

  const results = {};

  if (target === 'chatgpt' || target === 'both') {
    results.chatgpt = await testChatGPT(question);
  }

  if (target === 'gemini' || target === 'both') {
    results.gemini = await testGemini(question);
  }

  // サマリー出力
  console.error('\n');
  console.error('╔════════════════════════════════════════╗');
  console.error('║            テスト結果サマリー          ║');
  console.error('╚════════════════════════════════════════╝');

  if (results.chatgpt) {
    const r = results.chatgpt;
    console.error(
      `ChatGPT: ${r.success ? '✅ 成功' : '❌ 失敗'} (${formatNumber(r.elapsed)}ms)`,
    );
    if (r.answer) {
      console.error(
        `  回答: ${r.answer.slice(0, 80)}${r.answer.length > 80 ? '...' : ''}`,
      );
    }
    if (r.relevance) {
      console.error(
        `  関連性: ${r.relevance.matchRate}% (${r.relevance.matchedKeywords.join(', ') || 'なし'})`,
      );
    }
    if (r.timings) {
      const t = r.timings;
      console.error(
        `  内訳: 接続=${formatNumber(t.connectMs)}ms, 入力=${formatNumber(t.waitInputMs + t.inputMs)}ms, 送信待機=${formatNumber(t.sendMs)}ms, 応答=${formatNumber(t.waitResponseMs)}ms`,
      );
    }
    if (!r.success && r.error) {
      console.error(`  エラー: ${r.error}`);
    }
  }

  if (results.gemini) {
    const r = results.gemini;
    console.error(
      `Gemini:  ${r.success ? '✅ 成功' : '❌ 失敗'} (${formatNumber(r.elapsed)}ms)`,
    );
    if (r.answer) {
      console.error(
        `  回答: ${r.answer.slice(0, 80)}${r.answer.length > 80 ? '...' : ''}`,
      );
    }
    if (r.relevance) {
      console.error(
        `  関連性: ${r.relevance.matchRate}% (${r.relevance.matchedKeywords.join(', ') || 'なし'})`,
      );
    }
    if (r.timings) {
      const t = r.timings;
      const navPart = t.navigateMs
        ? `, ナビ=${formatNumber(t.navigateMs)}ms`
        : '';
      console.error(
        `  内訳: 接続=${formatNumber(t.connectMs)}ms${navPart}, 入力=${formatNumber(t.waitInputMs + t.inputMs)}ms, 送信待機=${formatNumber(t.sendMs)}ms, 応答=${formatNumber(t.waitResponseMs)}ms`,
      );
    }
    if (!r.success && r.error) {
      console.error(`  エラー: ${r.error}`);
    }
  }

  console.error('');

  // 終了コード
  const allSuccess = Object.values(results).every(r => r.success);
  process.exit(allSuccess ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
