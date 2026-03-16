#!/usr/bin/env node
/**
 * 待ち時間計測スクリプト
 *
 * 複数回の質問送信で統計を取得し、ボトルネックを特定する。
 *
 * 使い方:
 *   npm run measure:chatgpt          # ChatGPT 5回計測
 *   npm run measure:gemini           # Gemini 5回計測
 *   npm run measure:chatgpt -- -n 10 # 10回計測
 *   npm run measure:gemini -- --question "..." # 指定した質問で計測
 */

import {
  askChatGPTFastWithTimings,
  askGeminiFastWithTimings,
} from '../build/src/fast-cdp/fast-chat.js';

// --- コマンドライン引数解析 ---
const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('-')) || 'chatgpt';
const numRuns = parseInt(
  args.find(a => a === '-n' || a === '--runs')
    ? args[args.findIndex(a => a === '-n' || a === '--runs') + 1]
    : '5',
  10,
);
const customQuestion = args.find(a => a === '-q' || a === '--question')
  ? args[args.findIndex(a => a === '-q' || a === '--question') + 1]
  : null;

if (args.includes('--help') || args.includes('-h')) {
  console.error(`
計測スクリプト - 待ち時間の統計を取得

使い方:
  npm run measure:chatgpt              # ChatGPT 5回計測 (デフォルト)
  npm run measure:gemini               # Gemini 5回計測
  npm run measure:chatgpt -- -n 10     # 10回計測
  npm run measure:gemini -- -q "質問"  # 指定した質問で計測

オプション:
  -n, --runs <number>       計測回数 (デフォルト: 5)
  -q, --question <string>   質問文を指定 (省略時は自動生成)
  -h, --help                ヘルプを表示
`);
  process.exit(0);
}

// --- 質問生成 ---
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

// --- 統計計算 ---
function calcStats(values) {
  if (values.length === 0)
    return {min: 0, max: 0, avg: 0, median: 0, stdDev: 0};

  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const sum = values.reduce((a, b) => a + b, 0);
  const avg = sum / values.length;

  // 中央値
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  // 標準偏差
  const variance =
    values.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) /
    values.length;
  const stdDev = Math.sqrt(variance);

  return {min, max, avg, median, stdDev};
}

// --- フォーマッタ ---
function formatMs(ms) {
  return ms.toLocaleString('en-US', {maximumFractionDigits: 0}).padStart(6);
}

function formatPct(pct) {
  return pct.toFixed(1).padStart(5) + '%';
}

function createBar(percentage, width = 20) {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// --- メイン計測ロジック ---
async function measureTimings(provider, askFn, runs) {
  console.error(`\n${'='.repeat(60)}`);
  console.error(`=== ${provider} 待ち時間計測 (${runs}回) ===`);
  console.error(`${'='.repeat(60)}\n`);

  const allTimings = [];
  const errors = [];

  for (let i = 0; i < runs; i++) {
    const question = customQuestion || generateUniqueQuestion();
    console.error(`[Run ${i + 1}/${runs}] 質問: "${question.slice(0, 50)}..."`);

    const runStart = Date.now();
    try {
      const result = await askFn(question);
      const {timings} = result;
      allTimings.push(timings);

      // 簡易結果表示
      console.error(
        `  -> OK: total=${formatMs(timings.totalMs)}ms (connect=${formatMs(timings.connectMs)}ms, response=${formatMs(timings.waitResponseMs)}ms)`,
      );
    } catch (err) {
      console.error(`  -> ERROR: ${err.message}`);
      errors.push({run: i + 1, error: err.message});
    }

    // 連続質問のインターバル（BAN回避）
    if (i < runs - 1) {
      console.error(`  (3秒待機...)`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  return {allTimings, errors};
}

// --- レポート出力 ---
function printReport(provider, allTimings, errors) {
  console.error(`\n${'='.repeat(60)}`);
  console.error(`=== ${provider} 計測結果レポート ===`);
  console.error(`${'='.repeat(60)}\n`);

  if (allTimings.length === 0) {
    console.error('計測成功なし');
    return;
  }

  console.error(`成功: ${allTimings.length}回 / エラー: ${errors.length}回\n`);

  // フェーズ定義
  const phases = [
    {name: '接続確立', key: 'connectMs'},
    {name: '入力欄待機', key: 'waitInputMs'},
    {name: 'テキスト入力', key: 'inputMs'},
    {name: '送信ボタン待機', key: 'sendMs'},
    {name: '回答待機', key: 'waitResponseMs'},
  ];

  // Geminiの場合はナビゲーションを追加
  if (allTimings[0].navigateMs !== undefined) {
    phases.splice(1, 0, {name: 'ナビゲーション', key: 'navigateMs'});
  }

  // 各フェーズの統計を計算
  const stats = {};
  for (const phase of phases) {
    const values = allTimings.map(t => t[phase.key] || 0);
    stats[phase.key] = calcStats(values);
  }

  // 合計の統計
  const totals = allTimings.map(t => t.totalMs || 0);
  const totalStats = calcStats(totals);

  // --- 統計テーブル ---
  console.error('## 統計サマリー\n');
  console.error(
    '| フェーズ         |    最小 |    最大 |    平均 |   中央値 |   標準偏差 |',
  );
  console.error(
    '|------------------|---------|---------|---------|----------|------------|',
  );

  for (const phase of phases) {
    const s = stats[phase.key];
    console.error(
      `| ${phase.name.padEnd(16)} | ${formatMs(s.min)} | ${formatMs(s.max)} | ${formatMs(s.avg)} | ${formatMs(s.median)} | ${formatMs(s.stdDev)} |`,
    );
  }
  console.error(
    '|------------------|---------|---------|---------|----------|------------|',
  );
  console.error(
    `| ${'合計'.padEnd(16)} | ${formatMs(totalStats.min)} | ${formatMs(totalStats.max)} | ${formatMs(totalStats.avg)} | ${formatMs(totalStats.median)} | ${formatMs(totalStats.stdDev)} |`,
  );

  // --- 時間比率分析 ---
  console.error('\n## 平均時間の内訳\n');

  const avgTotal = totalStats.avg || 1;
  for (const phase of phases) {
    const s = stats[phase.key];
    const pct = (s.avg / avgTotal) * 100;
    const bar = createBar(pct);
    console.error(
      `  ${phase.name.padEnd(14)}: ${formatMs(s.avg)} ms (${formatPct(pct)}) ${bar}`,
    );
  }
  console.error(`  ${'─'.repeat(50)}`);
  console.error(`  ${'合計'.padEnd(14)}: ${formatMs(avgTotal)} ms (100.0%)`);

  // --- ボトルネック分析 ---
  console.error('\n## ボトルネック分析\n');

  // 回答待機を除いた「改善可能な」フェーズを分析
  const improvablePhases = phases.filter(p => p.key !== 'waitResponseMs');
  const improvableTotal = improvablePhases.reduce(
    (sum, p) => sum + (stats[p.key]?.avg || 0),
    0,
  );

  const bottlenecks = improvablePhases
    .map(phase => {
      const s = stats[phase.key];
      const pct = (s.avg / avgTotal) * 100;
      const improvablePct =
        improvableTotal > 0 ? (s.avg / improvableTotal) * 100 : 0;
      return {
        name: phase.name,
        key: phase.key,
        avg: s.avg,
        stdDev: s.stdDev,
        pct,
        improvablePct,
      };
    })
    .sort((a, b) => b.avg - a.avg);

  console.error('改善可能なフェーズ（回答待機を除く）:\n');
  for (const b of bottlenecks) {
    const severity = b.avg > 2000 ? '🔴' : b.avg > 1000 ? '🟡' : '🟢';
    const variability = b.stdDev > b.avg * 0.5 ? ' (ばらつき大)' : '';
    console.error(
      `  ${severity} ${b.name}: 平均 ${formatMs(b.avg)}ms (全体の${formatPct(b.pct)})${variability}`,
    );
  }

  // --- 改善提案 ---
  console.error('\n## 改善提案\n');

  const suggestions = [];

  const connectStats = stats['connectMs'];
  if (connectStats && connectStats.avg > 2000) {
    suggestions.push({
      severity: connectStats.avg > 5000 ? '🔴' : '🟡',
      text: `接続時間が長い (${formatMs(connectStats.avg)}ms): 既存タブ再利用の確認`,
    });
  }

  const sendStats = stats['sendMs'];
  if (sendStats && sendStats.avg > 3000) {
    suggestions.push({
      severity: sendStats.avg > 10000 ? '🔴' : '🟡',
      text: `送信待機が長い (${formatMs(sendStats.avg)}ms): 前回応答完了を待つ`,
    });
  }

  const waitInputStats = stats['waitInputMs'];
  if (waitInputStats && waitInputStats.avg > 2000) {
    suggestions.push({
      severity: waitInputStats.avg > 5000 ? '🔴' : '🟡',
      text: `入力欄待機が長い (${formatMs(waitInputStats.avg)}ms): ページ初期ロード待機の確認`,
    });
  }

  const navStats = stats['navigateMs'];
  if (navStats && navStats.avg > 1000) {
    suggestions.push({
      severity: navStats.avg > 3000 ? '🔴' : '🟡',
      text: `ナビゲーション時間 (${formatMs(navStats.avg)}ms): 既存タブ再利用でスキップ可能`,
    });
  }

  // 回答待機の割合が高い場合（これは正常）
  const responseStats = stats['waitResponseMs'];
  const responsePct = responseStats ? (responseStats.avg / avgTotal) * 100 : 0;
  if (responsePct > 80) {
    suggestions.push({
      severity: '🟢',
      text: `回答待機が${formatPct(responsePct)}を占めています（正常: AI応答速度）`,
    });
  }

  if (suggestions.length === 0) {
    suggestions.push({
      severity: '🟢',
      text: '特になし（パフォーマンスは良好です）',
    });
  }

  for (const s of suggestions) {
    console.error(`  ${s.severity} ${s.text}`);
  }

  // --- 詳細データ（JSON形式） ---
  console.error('\n## 詳細データ (JSON)\n');

  const reportData = {
    provider,
    runs: allTimings.length,
    errors: errors.length,
    stats: {},
    total: totalStats,
  };

  for (const phase of phases) {
    reportData.stats[phase.key] = stats[phase.key];
  }

  console.error(JSON.stringify(reportData, null, 2));
}

// --- エントリポイント ---
async function main() {
  console.error(`
╔════════════════════════════════════════════╗
║    待ち時間計測スクリプト                  ║
╚════════════════════════════════════════════╝
`);
  console.error(`ターゲット: ${target}`);
  console.error(`計測回数: ${numRuns}回`);
  console.error(`質問: ${customQuestion ? customQuestion : '(自動生成)'}`);

  if (target === 'chatgpt') {
    const {allTimings, errors} = await measureTimings(
      'ChatGPT',
      askChatGPTFastWithTimings,
      numRuns,
    );
    printReport('ChatGPT', allTimings, errors);
  } else if (target === 'gemini') {
    const {allTimings, errors} = await measureTimings(
      'Gemini',
      askGeminiFastWithTimings,
      numRuns,
    );
    printReport('Gemini', allTimings, errors);
  } else {
    console.error(`\n不明なターゲット: ${target}`);
    console.error('使用可能: chatgpt, gemini');
    process.exit(1);
  }

  console.error('\n計測完了');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
