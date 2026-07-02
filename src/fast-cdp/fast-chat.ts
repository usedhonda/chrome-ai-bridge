/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import {CHATGPT_CONFIG, GEMINI_CONFIG} from '../config.js';
import type {RelayServer} from '../extension/relay-server.js';

import {
  getAgentConnection,
  getAllAgentConnections,
  clearAllAgentConnections,
  hasAgentId,
} from './agent-context.js';
import {CdpClient} from './cdp-client.js';
import {
  logConnectionState,
  logInfo,
  logError,
  logWarn,
} from './debug-logger.js';
import {getDriver} from './drivers/index.js';
import {connectViaExtensionRaw} from './extension-raw.js';
import {NetworkInterceptor} from './network-interceptor.js';
import {
  saveAgentSession,
  getPreferredSessionV2,
  clearAgentSession,
  dropAgentSessionUrl,
} from './session-manager.js';
import {DOM_UTILS_CODE} from './utils/index.js';

/**
 * Get current agent's client for the specified kind.
 * Returns null if not connected.
 */
function getClientFromAgent(kind: 'chatgpt' | 'gemini'): CdpClient | null {
  if (!hasAgentId()) {
    // Fallback for backward compatibility (no agent ID set)
    return null;
  }
  const conn = getAgentConnection();
  return kind === 'chatgpt' ? conn.chatgptClient : conn.geminiClient;
}

/**
 * Get current agent's relay for the specified kind.
 * Returns null if not connected.
 */
function getRelayFromAgent(kind: 'chatgpt' | 'gemini'): RelayServer | null {
  if (!hasAgentId()) {
    return null;
  }
  const conn = getAgentConnection();
  return kind === 'chatgpt' ? conn.chatgptRelay : conn.geminiRelay;
}

/**
 * Set client and relay for the current agent.
 */
function setClientForAgent(
  kind: 'chatgpt' | 'gemini',
  client: CdpClient | null,
  relay: RelayServer | null,
): void {
  if (!hasAgentId()) {
    console.error(
      '[fast-chat] Warning: setClientForAgent called without agent ID',
    );
    return;
  }
  const conn = getAgentConnection();
  if (kind === 'chatgpt') {
    conn.chatgptClient = client;
    conn.chatgptRelay = relay;
  } else {
    conn.geminiClient = client;
    conn.geminiRelay = relay;
  }
}

// Env var deprecation helpers
function envWithFallback(
  newName: string,
  oldName: string,
  defaultVal: string,
): string {
  if (process.env[newName]) return process.env[newName]!;
  if (process.env[oldName]) {
    console.error(
      `[deprecation] ${oldName} is deprecated, use ${newName} instead`,
    );
    return process.env[oldName]!;
  }
  return defaultVal;
}

const CONNECT_REUSE_TIMEOUT_MS = Number(
  envWithFallback(
    'CAI_CONNECT_REUSE_TIMEOUT_MS',
    'MCP_CONNECT_REUSE_TIMEOUT_MS',
    '12000',
  ),
);
const CONNECT_NEWTAB_TIMEOUT_MS = Number(
  envWithFallback(
    'CAI_CONNECT_NEWTAB_TIMEOUT_MS',
    'MCP_CONNECT_NEWTAB_TIMEOUT_MS',
    '20000',
  ),
);
const TOOL_BUDGET_MS = Number(
  envWithFallback('CAI_TOOL_BUDGET_MS', 'CAI_MCP_TOOL_BUDGET_MS', '900000'),
);
const RESPONSE_WAIT_MAX_MS = Number(
  process.env.CAI_RESPONSE_WAIT_MAX_MS || '900000',
);
const CHATGPT_PRO_TOOL_BUDGET_MS = Number(
  process.env.CAI_CHATGPT_PRO_TOOL_BUDGET_MS ||
    process.env.CAI_TOOL_BUDGET_MS ||
    process.env.CAI_MCP_TOOL_BUDGET_MS ||
    '1800000',
);
const CHATGPT_PRO_RESPONSE_WAIT_MAX_MS = Number(
  process.env.CAI_RESPONSE_WAIT_MAX_MS ||
    process.env.CAI_CHATGPT_PRO_RESPONSE_WAIT_MAX_MS ||
    '1800000',
);
const CHATGPT_PRO_IDLE_TIMEOUT_MS = Number(
  process.env.CAI_CHATGPT_PRO_IDLE_TIMEOUT_MS || '180000',
);
const CHATGPT_PRO_FINALIZE_WAIT_MS = Number(
  process.env.CAI_CHATGPT_PRO_FINALIZE_WAIT_MS || '120000',
);
const BUDGET_RESERVE_MS = Number(
  envWithFallback('CAI_BUDGET_RESERVE_MS', 'CAI_MCP_BUDGET_RESERVE_MS', '3000'),
);

function getRemainingBudgetMs(
  startMs: number,
  overrideBudgetMs?: number,
): number {
  return (
    (overrideBudgetMs ?? TOOL_BUDGET_MS) -
    (nowMs() - startMs) -
    BUDGET_RESERVE_MS
  );
}

function getResponseWaitBudgetMs(
  startMs: number,
  ceilingMs: number,
  stage: string,
  overrideBudgetMs?: number,
): number {
  const effectiveBudget = overrideBudgetMs ?? TOOL_BUDGET_MS;
  const remaining = getRemainingBudgetMs(startMs, overrideBudgetMs);
  if (remaining <= 1000) {
    throw new Error(
      `TOOL_BUDGET_EXCEEDED: stage=${stage} budgetMs=${effectiveBudget} reserveMs=${BUDGET_RESERVE_MS}`,
    );
  }
  return Math.max(1000, Math.min(ceilingMs, remaining));
}

/**
 * チャット結果の型（タイミング情報付き）
 */
export interface ChatTimings {
  connectMs: number;
  waitInputMs: number;
  inputMs: number;
  sendMs: number;
  waitResponseMs: number;
  totalMs: number;
  navigateMs?: number; // Gemini only
}

/**
 * デバッグ情報: DOM構造、抽出試行、タイミング等
 */
export interface ChatDebugInfo {
  // DOM構造
  dom: {
    articleCount: number;
    markdowns: Array<{
      className: string;
      innerTextLength: number;
      innerText: string;
      isResultThinking: boolean;
    }>;
    lastArticleHtml: string;
    lastArticleInnerText: string;
  };
  // 抽出試行
  extraction: {
    selectorsTried: Array<{
      selector: string;
      found: boolean;
      textLength: number;
    }>;
    finalSelector?: string;
    fallbackUsed?: string;
  };
  // タイミング
  timings: ChatTimings;
  // URL・タイトル
  url: string;
  documentTitle: string;
}

export interface ChatResult {
  answer: string;
  timings: ChatTimings;
  debug?: ChatDebugInfo;
}

function nowMs(): number {
  return Date.now();
}

/**
 * 接続の健全性を確認する
 * 軽量なevaluateコマンドで接続が生きているかチェック
 */
async function isConnectionHealthy(
  client: CdpClient,
  kind?: 'chatgpt' | 'gemini',
): Promise<boolean> {
  // Fast-path: if relay is already disconnected, skip the expensive evaluate call
  if (kind) {
    const relay = getRelayFromAgent(kind);
    if (relay && !relay.isReady()) {
      logConnectionState(kind, 'unhealthy', {
        elapsed: 0,
        error: 'relay not ready (fast-path)',
      });
      return false;
    }
  }

  const startTime = Date.now();
  try {
    // 4秒タイムアウトで簡単なコマンドを実行（2秒では不十分な場合があった）
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Health check timeout')), 4000),
    );
    await Promise.race([client.evaluate('1'), timeoutPromise]);
    const elapsed = Date.now() - startTime;
    if (kind) {
      logConnectionState(kind, 'healthy', {elapsed});
    }
    return true;
  } catch (error) {
    const elapsed = Date.now() - startTime;
    if (kind) {
      logConnectionState(kind, 'unhealthy', {
        elapsed,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    console.error('[fast-cdp] Connection health check failed:', error);
    return false;
  }
}

/**
 * メッセージカウントが安定するまで待機
 * ページ読み込み完了を確認するため、カウントが2回連続で同じ値になるまで待機
 * @param client CDPクライアント
 * @param countExpr カウントを取得するJavaScript式
 * @param maxWaitMs 最大待機時間（デフォルト3000ms）
 * @param pollIntervalMs ポーリング間隔（デフォルト300ms）
 * @returns 安定したカウント値
 */
async function waitForStableCount(
  client: CdpClient,
  countExpr: string,
  maxWaitMs = 3000,
  pollIntervalMs = 300,
): Promise<number> {
  const startTime = Date.now();
  let lastCount = -1;
  let stableCount = 0;

  while (Date.now() - startTime < maxWaitMs) {
    const currentCount = await client.evaluate<number>(countExpr);

    if (currentCount === lastCount) {
      stableCount++;
      if (stableCount >= 2) {
        // 2回連続で同じ値なら安定したとみなす
        return currentCount;
      }
    } else {
      stableCount = 0;
      lastCount = currentCount;
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  // タイムアウト時は最後のカウントを返す
  return lastCount >= 0 ? lastCount : 0;
}

function getProjectName(): string {
  return path.basename(process.cwd()) || 'default';
}

function getHistoryPath(): string {
  return path.join(
    process.cwd(),
    '.local',
    'chrome-ai-bridge',
    'history.jsonl',
  );
}

function getLocalTimestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

async function rotateHistoryIfNeeded(): Promise<void> {
  const historyPath = getHistoryPath();

  try {
    const content = await fs.readFile(historyPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    // 1000件以下なら何もしない
    if (lines.length <= 1000) return;

    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    // 30日以上古いエントリを除外
    const filtered = lines.filter(line => {
      try {
        const entry = JSON.parse(line);
        // ローカル時刻形式 "2026-02-01 00:36:02" または ISO形式 "2026-01-31T15:36:02.273Z" 両対応
        const ts = new Date(entry.ts).getTime();
        return ts > thirtyDaysAgo; // 30日以内は保持
      } catch {
        return true; // パース失敗は保持
      }
    });

    // 削除対象があれば書き換え
    if (filtered.length < lines.length) {
      await fs.writeFile(historyPath, filtered.join('\n') + '\n', 'utf-8');
      console.error(
        `[history] Rotated: ${lines.length} -> ${filtered.length} entries`,
      );
    }
  } catch (err) {
    // ファイルがない場合は無視
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[history] Rotation error:', err);
    }
  }
}

/**
 * キャッシュされたGeminiクライアントをクリア（リトライ用）
 * @deprecated Use resetConnection('gemini') instead
 */
export async function clearGeminiClient(): Promise<void> {
  await resetConnection('gemini');
}

/**
 * 指定 kind の接続を協調的にクリーンアップする。
 * RelayServer・CdpClient・SessionManager・CDP リスナーを一括リセット。
 * 接続失敗時のリトライ前に呼ぶことで「スティッキーな障害状態」を防ぐ。
 */
export async function resetConnection(
  kind: 'chatgpt' | 'gemini',
): Promise<void> {
  const label = kind === 'chatgpt' ? 'ChatGPT' : 'Gemini';
  console.error(
    `[fast-cdp] resetConnection(${kind}) — coordinated cleanup start`,
  );

  // 1. CdpClient: all CDP event listeners removed
  const client = getClientFromAgent(kind);
  if (client) {
    try {
      client.removeAllCdpListeners();
    } catch {
      // ignore
    }
    console.error(`[${label}] CdpClient listeners removed`);
  }

  // 2. RelayServer: stop + reference clear (await to ensure port is released)
  const relay = getRelayFromAgent(kind);
  if (relay) {
    try {
      await relay.stop();
    } catch {
      // ignore stop errors
    }
    console.error(`[${label}] RelayServer stopped`);
  }

  // 3. Agent connection reference clear
  setClientForAgent(kind, null, null);
  console.error(`[${label}] Agent connection references cleared`);

  // 4. Session info clear (await to prevent write race on retry)
  try {
    await clearAgentSession(kind);
  } catch {
    // ignore session clear errors
  }
  console.error(`[fast-cdp] resetConnection(${kind}) — cleanup complete`);
}

/**
 * 全接続をクリーンアップ（プロセス終了時用）
 * サーバー終了時にゾンビプロセスを防ぐために使用
 */
export async function cleanupAllConnections(): Promise<void> {
  // Snapshot entries before clearing to avoid mutation during iteration
  const entries = Array.from(getAllAgentConnections().entries());

  for (const [, conn] of entries) {
    if (conn.chatgptRelay) {
      try {
        await conn.chatgptRelay.stop();
      } catch {
        // ignore stop errors
      }
    }

    if (conn.geminiRelay) {
      try {
        await conn.geminiRelay.stop();
      } catch {
        // ignore stop errors
      }
    }
  }

  // Clear all at once after iteration
  clearAllAgentConnections();
  console.error('[fast-cdp] All connections cleaned up');
}

/**
 * 既存Geminiチャットがスタック状態（停止ボタンが消えない）かチェック
 * 最大5秒間待機して停止ボタンが消えるか確認
 */
async function _checkGeminiStuckState(
  client: CdpClient,
): Promise<{isStuck: boolean; waitedMs: number}> {
  const maxWaitMs = 5000;
  const pollIntervalMs = 500;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const hasStopButton = await client.evaluate<boolean>(`
      (() => {
        ${DOM_UTILS_CODE}
        const buttons = __collectDeep(['button', '[role="button"]']).nodes.filter(__isVisible).filter(el => !__isDisabled(el));

        // 方法1: aria-labelベースの検索
        const stopByLabel = buttons.some(b => {
          const label = (b.getAttribute('aria-label') || '').trim();
          return label.includes('回答を停止') || label.includes('Stop generating') ||
                 label.includes('Stop streaming') || label === 'Stop';
        });
        if (stopByLabel) return true;

        // 方法2: mat-icon要素での検出
        const stopIcons = __collectDeep(['mat-icon[data-mat-icon-name="stop"]']).nodes;
        for (const stopIcon of stopIcons) {
          const btn = stopIcon.closest('button');
          if (btn && __isVisible(btn) && !__isDisabled(btn)) return true;
        }

        return false;
      })()
    `);

    if (!hasStopButton) {
      // 停止ボタンが消えた - スタックしていない
      return {isStuck: false, waitedMs: Date.now() - startTime};
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  // 5秒間停止ボタンが消えなかった - スタック状態
  return {isStuck: true, waitedMs: Date.now() - startTime};
}

async function appendHistory(entry: {
  provider: 'chatgpt' | 'gemini';
  question: string;
  answer: string;
  url?: string;
  timings?: Record<string, number>;
}): Promise<void> {
  const project = getProjectName();
  const payload = {
    ts: getLocalTimestamp(),
    project,
    ...entry,
  };
  const targetPath = getHistoryPath();
  await fs.mkdir(path.dirname(targetPath), {recursive: true});
  await fs.appendFile(targetPath, `${JSON.stringify(payload)}\n`, 'utf-8');

  // ローテーション実行（非同期、エラーは無視）
  rotateHistoryIfNeeded().catch(() => {
    /* no-op: rotation is best-effort */
  });
}

async function saveDebug(
  kind: 'chatgpt' | 'gemini',
  payload: Record<string, unknown>,
) {
  const targetDir = path.join(
    process.cwd(),
    '.local',
    'chrome-ai-bridge',
    'debug',
  );
  await fs.mkdir(targetDir, {recursive: true});
  const file = path.join(targetDir, `${kind}-${Date.now()}.json`);
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8');
}

function normalizeGeminiResponse(text: string, question?: string): string {
  if (!text) return '';
  const filtered = text
    .split('\n')
    .map(line => line.trim())
    .filter(
      line =>
        line &&
        !/^思考プロセスを表示/.test(line) &&
        !/^次へのステップ/.test(line) &&
        !/^Show thinking/i.test(line) &&
        !/^Next steps/i.test(line) &&
        !/^(Gemini|PRO|作成したもの|Gemini との会話|ツール|思考モード|今すぐ回答)$/i.test(
          line,
        ) &&
        !/^Initiating Connection Check/i.test(line) &&
        !/^Acknowledging Connection Test/i.test(line) &&
        !/^Confirming Connection Integrity/i.test(line),
    );
  const cleaned = filtered
    .filter(line => (question ? line !== question.trim() : true))
    .join('\n')
    .trim();
  return cleaned;
}

// isSuspiciousAnswer 関数は削除済み（2回送信バグの原因）

function isChatGPTConversationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.endsWith('chatgpt.com') &&
      parsed.pathname.startsWith('/c/')
    );
  } catch {
    return url.includes('chatgpt.com/c/');
  }
}

function isChatGPTConfiguredModelUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.endsWith('chatgpt.com') &&
      parsed.searchParams.get('model') === CHATGPT_CONFIG.DEFAULT_MODEL
    );
  } catch {
    return false;
  }
}

interface ChatGPTModelSelection {
  prefersPro: boolean;
  selectedPro: boolean;
  selectedModelLabel?: string;
  selectionSource: 'url' | 'picker' | 'slug' | 'fallback';
  fallbackReason?: string;
}

interface ChatGPTModelState {
  url: string;
  urlModel: string | null;
  selectedLabel: string;
  modelSlugs: string[];
  proVisible: boolean;
  proUnavailable: boolean;
  warningText: string;
}

interface ChatGPTModelEnsureOptions {
  preserveConversation?: boolean;
}

function isChatGPTProText(text: string | null | undefined): boolean {
  return /(?:^|[^a-z])pro(?:[^a-z]|$)/i.test(text || '');
}

function getChatGPTConversationId(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('chatgpt.com')) return null;
    const match = parsed.pathname.match(/^\/c\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]).toLowerCase() : null;
  } catch {
    const match = url.match(/chatgpt\.com\/c\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]).toLowerCase() : null;
  }
}

function isSameChatGPTConversation(
  a: string | null,
  b: string | null,
): boolean {
  const left = getChatGPTConversationId(a);
  const right = getChatGPTConversationId(b);
  return Boolean(left && right && left === right);
}

function getChatGPTProStateSource(
  state: ChatGPTModelState,
): 'url' | 'picker' | 'slug' | null {
  if (isChatGPTProText(state.urlModel)) return 'url';
  if (isChatGPTProText(state.selectedLabel)) return 'picker';
  if (state.modelSlugs.some(slug => isChatGPTProText(slug))) return 'slug';
  return null;
}

async function getChatGPTModelState(
  client: CdpClient,
): Promise<ChatGPTModelState> {
  return await client.evaluate<ChatGPTModelState>(`
    (() => {
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect?.();
        if (!rect || rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };
      const labelOf = (el) => [
        el.getAttribute?.('aria-label') || '',
        el.getAttribute?.('data-testid') || '',
        el.innerText || el.textContent || '',
      ].join(' ').replace(/\\s+/g, ' ').trim();
      const buttonLabels = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(isVisible)
        .map(labelOf)
        .filter(Boolean);
      const selectedLabel =
        buttonLabels.find(label => /gpt|chatgpt|model|モデル|pro/i.test(label)) || '';
      const allText = document.body?.innerText || '';
      const proVisible = /(?:^|[^a-z])pro(?:[^a-z]|$)/i.test(allText);
      const warningLines = allText
        .split('\\n')
        .filter(line =>
          /(?:^|[^a-z])pro(?:[^a-z]|$)/i.test(line) &&
          /unavailable|not available|limit reached|upgrade|subscribe|上限|利用できません|使えません|アップグレード/i.test(line)
        )
        .slice(0, 3);
      const proUnavailable = warningLines.length > 0;
      const modelSlugs = Array.from(document.querySelectorAll('[data-message-model-slug]'))
        .map(el => el.getAttribute('data-message-model-slug') || '')
        .filter(Boolean)
        .slice(-5);
      const url = location.href;
      let urlModel = null;
      try {
        urlModel = new URL(url).searchParams.get('model');
      } catch {}
      return {
        url,
        urlModel,
        selectedLabel,
        modelSlugs,
        proVisible,
        proUnavailable,
        warningText: warningLines.join(' | '),
      };
    })()
  `);
}

async function trySelectChatGPTProFromPicker(client: CdpClient): Promise<{
  attempted: boolean;
  clicked: boolean;
  label?: string;
  reason?: string;
}> {
  return await client.evaluate<{
    attempted: boolean;
    clicked: boolean;
    label?: string;
    reason?: string;
  }>(`
    (async () => {
      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect?.();
        if (!rect || rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };
      const labelOf = (el) => [
        el.getAttribute?.('aria-label') || '',
        el.getAttribute?.('data-testid') || '',
        el.innerText || el.textContent || '',
      ].join(' ').replace(/\\s+/g, ' ').trim();
      const isDisabled = (el) =>
        el.disabled ||
        el.getAttribute?.('aria-disabled') === 'true' ||
        el.getAttribute?.('disabled') === 'true';
      const priorityOf = (label) => {
        const normalized = label.replace(/\\s+/g, ' ').trim().toLowerCase();
        if (/pro extended/.test(normalized)) return 0;
        if (/pro standard/.test(normalized)) return 1;
        if (/gpt[-\\s]?5\\.5[^\\n]*pro|chatgpt[-\\s]?5\\.5[^\\n]*pro/.test(normalized)) return 2;
        if (/gpt[-\\s]?5[^\\n]*pro|chatgpt[-\\s]?5[^\\n]*pro/.test(normalized)) return 3;
        if (/(?:^|[^a-z])pro(?:[^a-z]|$)/i.test(label)) return 4;
        return 99;
      };
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(isVisible);
      const picker = buttons.find(btn => {
        const label = labelOf(btn);
        return /gpt|chatgpt|model|モデル/i.test(label) &&
          !/send|stop|送信|停止/i.test(label);
      });
      if (!picker) return {attempted: false, clicked: false, reason: 'model picker not found'};

      picker.click();
      await sleep(600);

      const candidates = Array.from(document.querySelectorAll(
        'button, [role="button"], [role="menuitem"], [role="option"]'
      ))
        .filter(isVisible)
        .map(el => ({el, label: labelOf(el)}))
        .filter(item => /(?:^|[^a-z])pro(?:[^a-z]|$)/i.test(item.label))
        .filter(item => !/unavailable|not available|limit reached|upgrade|subscribe|上限|利用できません|使えません|アップグレード/i.test(item.label))
        .filter(item => !isDisabled(item.el));

      if (candidates.length === 0) {
        document.body.click();
        return {attempted: true, clicked: false, reason: 'available Pro option not found'};
      }

      const preferred = candidates
        .map((item, index) => ({...item, priority: priorityOf(item.label), index}))
        .sort((a, b) => a.priority - b.priority || a.index - b.index)[0];
      preferred.el.click();
      await sleep(1000);
      return {attempted: true, clicked: true, label: preferred.label};
    })()
  `);
}

async function ensureChatGPTPreferredModel(
  client: CdpClient,
  options: ChatGPTModelEnsureOptions = {},
): Promise<ChatGPTModelSelection> {
  const currentUrl = await client.evaluate<string>('location.href');
  const currentIsConversation = isChatGPTConversationUrl(currentUrl);
  if (
    (currentIsConversation && !options.preserveConversation) ||
    !isChatGPTConfiguredModelUrl(currentUrl)
  ) {
    if (currentIsConversation && options.preserveConversation) {
      console.error(
        `[ChatGPT] Preserving reused conversation while verifying ${CHATGPT_CONFIG.DEFAULT_MODEL} in place: ${currentUrl}`,
      );
    } else {
      console.error(
        `[ChatGPT] Selecting configured model ${CHATGPT_CONFIG.DEFAULT_MODEL} before query...`,
      );
      await navigate(client, CHATGPT_CONFIG.DEFAULT_URL);
      await new Promise(r => setTimeout(r, 500));
      console.error('[ChatGPT] Configured model page loaded');
    }
  }

  let state = await getChatGPTModelState(client);
  let source = getChatGPTProStateSource(state);
  if (!source && !state.proUnavailable) {
    const pickerResult = await trySelectChatGPTProFromPicker(client);
    if (pickerResult.clicked) {
      console.error(
        `[ChatGPT] Selected Pro model from picker: ${pickerResult.label || 'unknown'}`,
      );
      await new Promise(r => setTimeout(r, 700));
      state = await getChatGPTModelState(client);
      source = getChatGPTProStateSource(state) || 'picker';
    } else {
      console.error(
        `[ChatGPT] Pro picker selection skipped: ${pickerResult.reason || 'unknown reason'}`,
      );
    }
  }

  if (source) {
    const selectedModelLabel =
      source === 'url'
        ? state.urlModel || 'Pro'
        : source === 'slug'
          ? state.modelSlugs.find(slug => isChatGPTProText(slug)) ||
            state.modelSlugs.at(-1) ||
            'Pro'
          : state.selectedLabel || state.urlModel || 'Pro';
    console.error(
      `[ChatGPT] Pro model active (${source}): ${selectedModelLabel}`,
    );
    return {
      prefersPro: true,
      selectedPro: true,
      selectedModelLabel,
      selectionSource: source,
    };
  }

  const fallbackReason =
    state.proUnavailable && state.warningText
      ? state.warningText
      : state.proVisible
        ? 'Pro option visible but not selectable'
        : 'Pro option not detected';
  console.error(
    `[ChatGPT] MODEL_UNAVAILABLE selectedPro=false: ${fallbackReason}`,
  );
  throw new Error(
    `MODEL_UNAVAILABLE: ChatGPT Pro model required before send; selectedPro=false; reason=${fallbackReason}`,
  );
}

async function getChatGPTConversationReuseContext(client: CdpClient): Promise<{
  currentUrl: string;
  preferredUrl: string | null;
  preserveConversation: boolean;
}> {
  const currentUrl = await client.evaluate<string>('location.href');
  const preferredUrl = (await getPreferredSessionV2('chatgpt')).url;
  const preserveConversation = isSameChatGPTConversation(
    currentUrl,
    preferredUrl,
  );
  if (preserveConversation) {
    console.error(
      `[ChatGPT] Reusing saved conversation in place: ${preferredUrl}`,
    );
  }
  return {currentUrl, preferredUrl, preserveConversation};
}

function logChatGPTForkIfNeeded(
  preserveConversation: boolean,
  preferredUrl: string | null,
  finalUrl: string,
): void {
  if (
    preserveConversation &&
    isChatGPTConversationUrl(finalUrl) &&
    !isSameChatGPTConversation(preferredUrl, finalUrl)
  ) {
    console.error(
      `[ChatGPT] WARNING: conversation fork detected; preferred=${preferredUrl} final=${finalUrl}`,
    );
  }
}

/**
 * 新しい接続を作成する（リトライ機構付き）
 * 戦略:
 * - ChatGPT: 常に新規タブ（URLが /c/xxx に変わるため再利用困難）
 * - Gemini: 既存タブを再利用、失敗したら新規タブ
 */
async function createConnection(
  kind: 'chatgpt' | 'gemini',
): Promise<CdpClient> {
  const startTime = Date.now();
  logConnectionState(kind, 'connecting');

  const preferredSession = await getPreferredSessionV2(kind);
  const preferred = preferredSession.url;
  const preferredTabId = preferredSession.tabId;
  const defaultUrl =
    kind === 'chatgpt' ? CHATGPT_CONFIG.DEFAULT_URL : GEMINI_CONFIG.DEFAULT_URL;

  logInfo('fast-chat', `createConnection: ${kind}`, {
    preferred,
    preferredTabId,
    defaultUrl,
    strategy: preferred ? 'reuse-existing' : 'new-tab',
  });

  // まず既存タブを探す（ChatGPT/Gemini共通）
  // 既存タブがあればそれを使う、なければ新規作成
  if (preferred) {
    logInfo('fast-chat', `Trying to reuse existing ${kind} tab`, {
      url: preferred,
      tabId: preferredTabId,
      timeoutMs: CONNECT_REUSE_TIMEOUT_MS,
    });
    console.error(
      `[fast-cdp] Trying to reuse existing ${kind} tab: ${preferred} (tabId: ${preferredTabId}, ${CONNECT_REUSE_TIMEOUT_MS}ms timeout)`,
    );
    try {
      const relayResult = await connectViaExtensionRaw({
        tabUrl: preferred,
        tabId: preferredTabId,
        newTab: false,
        allowTabTakeover: true,
        timeoutMs: CONNECT_REUSE_TIMEOUT_MS,
      });

      const client = new CdpClient(relayResult.relay);
      await Promise.all([
        client.send('Runtime.enable'),
        client.send('DOM.enable'),
        client.send('Page.enable'),
        client.send('Network.enable', {}),
      ]);

      // フォーカスエミュレーション有効化（バックグラウンドタブ対策）
      // Chrome DevTools: "Emulate a focused page" と同等
      // visibilityState を 'visible' に固定し、DOM更新の継続を促す
      try {
        await client.send('Emulation.setFocusEmulationEnabled', {
          enabled: true,
        });
        console.error(`[fast-cdp] ${kind} focus emulation enabled`);
      } catch (e) {
        // 非クリティカル: 失敗しても続行
        console.error(
          `[fast-cdp] ${kind} setFocusEmulationEnabled failed (non-critical):`,
          e instanceof Error ? e.message : String(e),
        );
      }

      // デバッグ: 接続直後のURLを確認
      const debugUrl = await client.evaluate<string>('location.href');
      console.error(`[fast-cdp] DEBUG: Connected tab URL = ${debugUrl}`);
      console.error(
        `[fast-cdp] DEBUG: targetInfo URL = ${relayResult.targetInfo?.url}`,
      );

      // ページが読み込まれるまで待機（about:blank でなくなるまで）
      // タイムアウトは3秒で十分（通常は数百ms以内に完了）
      if (debugUrl === 'about:blank') {
        console.error(
          `[fast-cdp] WARNING: evaluate returns about:blank, waiting for navigation...`,
        );
        await client.waitForFunction(
          `location.href !== 'about:blank' && document.readyState === 'complete'`,
          3000,
        );
      }

      const pageStatus = await getPageLoadStatus(client);
      if (isDeletedChatSignal(kind, preferred, pageStatus)) {
        console.error(
          `[fast-cdp] ${kind} saved chat URL is gone (status=${pageStatus.status ?? 'unknown'}, finalUrl=${pageStatus.url}); opening a new chat`,
        );
        await dropAgentSessionUrl(kind);
        await relayResult.relay.stop().catch(() => {
          // ignore cleanup errors before new-tab fallback
        });
      } else {
        // クライアントとRelay参照を保存
        setClientForAgent(kind, client, relayResult.relay);
        const elapsed = Date.now() - startTime;
        logConnectionState(kind, 'connected', {elapsed, reused: true});
        console.error(`[fast-cdp] ${kind} reused existing tab successfully`);
        return client;
      }
    } catch (error) {
      logWarn('fast-chat', `${kind} existing tab not found`, {
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(
        `[fast-cdp] ${kind} existing tab not found, resetting before new tab`,
      );
      // 再利用失敗 → stale 参照をクリアしてから新規タブへ
      await resetConnection(kind);
    }
  }

  // 新しいタブを作成
  logInfo('fast-chat', `Creating new ${kind} tab`, {url: defaultUrl});
  console.error(`[fast-cdp] Creating new ${kind} tab: ${defaultUrl}`);
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    logInfo('fast-chat', `${kind} connection attempt`, {
      attempt: attempt + 1,
      maxAttempts: 2,
    });
    try {
      const relayResult = await connectViaExtensionRaw({
        tabUrl: defaultUrl,
        newTab: true,
        timeoutMs: CONNECT_NEWTAB_TIMEOUT_MS,
      });

      const client = new CdpClient(relayResult.relay);
      await Promise.all([
        client.send('Runtime.enable'),
        client.send('DOM.enable'),
        client.send('Page.enable'),
        client.send('Network.enable', {}),
      ]);

      // フォーカスエミュレーション有効化（バックグラウンドタブ対策）
      // Chrome DevTools: "Emulate a focused page" と同等
      // visibilityState を 'visible' に固定し、DOM更新の継続を促す
      try {
        await client.send('Emulation.setFocusEmulationEnabled', {
          enabled: true,
        });
        console.error(`[fast-cdp] ${kind} focus emulation enabled (new tab)`);
      } catch (e) {
        // 非クリティカル: 失敗しても続行
        console.error(
          `[fast-cdp] ${kind} setFocusEmulationEnabled failed (non-critical):`,
          e instanceof Error ? e.message : String(e),
        );
      }

      // クライアントとRelay参照を保存
      setClientForAgent(kind, client, relayResult.relay);

      // 新規タブ作成後、ページが読み込まれるまで待機（about:blank でなくなるまで）
      const debugUrl = await client.evaluate<string>('location.href');
      if (debugUrl === 'about:blank') {
        console.error(
          `[fast-cdp] Waiting for new tab to navigate from about:blank...`,
        );
        await client.waitForFunction(
          `location.href !== 'about:blank' && document.readyState === 'complete'`,
          10000, // 新規タブは読み込みに時間がかかる可能性があるので10秒
        );
        console.error(`[fast-cdp] New tab navigation complete`);
      }

      const elapsed = Date.now() - startTime;
      logConnectionState(kind, 'connected', {
        elapsed,
        attempt: attempt + 1,
        reused: false,
      });
      console.error(
        `[fast-cdp] ${kind} new tab created successfully (attempt ${attempt + 1})`,
      );
      return client;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logError('fast-chat', `${kind} connection attempt failed`, {
        attempt: attempt + 1,
        error: lastError.message,
      });
      console.error(
        `[fast-cdp] ${kind} new tab attempt ${attempt + 1} failed:`,
        lastError.message,
      );

      if (attempt < 1) {
        // リトライ前に協調クリーンアップして stale 状態を排除
        console.error(
          `[fast-cdp] Resetting ${kind} connection before retry...`,
        );
        await resetConnection(kind);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  throw lastError || new Error(`Failed to connect to ${kind}`);
}

/**
 * クライアントを取得する（健全性チェック付き）
 * 既存の接続が切れている場合は自動的に再接続する
 * @public 外部から接続を事前確立するためにエクスポート
 */
export async function getClient(
  kind: 'chatgpt' | 'gemini',
): Promise<CdpClient> {
  const existing = getClientFromAgent(kind);
  logInfo('fast-chat', `getClient called`, {kind, hasExisting: !!existing});

  // 既存接続がある場合、健全性をチェック
  if (existing) {
    logInfo('fast-chat', `Checking health of existing ${kind} connection`);
    const healthy = await isConnectionHealthy(existing, kind);
    if (healthy) {
      logInfo('fast-chat', `Reusing healthy ${kind} connection`);
      console.error(`[fast-cdp] Reusing healthy ${kind} connection`);
      return existing;
    }

    // 接続が切れている → 協調クリーンアップして再接続
    logConnectionState(kind, 'reconnecting');
    console.error(
      `[fast-cdp] ${kind} connection lost, performing coordinated reset...`,
    );
    await resetConnection(kind);
  }

  // 新しい接続を作成
  return await createConnection(kind);
}

async function navigate(client: CdpClient, url: string) {
  await client.send('Page.navigate', {url});
  await client.waitForFunction(`document.readyState === 'complete'`, 30000);
}

async function getPageLoadStatus(client: CdpClient): Promise<PageLoadStatus> {
  return await client.evaluate<PageLoadStatus>(`
    (() => {
      const nav = performance.getEntriesByType('navigation').at(-1);
      const status = typeof nav?.responseStatus === 'number'
        ? nav.responseStatus
        : undefined;
      return {url: location.href, status};
    })()
  `);
}

/** Strip conversation-specific paths (/c/<id>, /app/<id>) to prevent chat pollution on reuse */
function getBaseUrl(_kind: 'chatgpt' | 'gemini', url: string): string {
  // 会話URLをそのまま保存（/c/xxx, /app/xxx を維持）
  // 同一エージェントセッション内で同じチャットに連続投稿できるようにする
  try {
    const u = new URL(url);
    return u.origin + u.pathname; // query/hash を除去、パスは保持
  } catch {
    return url;
  }
}

/**
 * Driver経由でChatGPTに質問
 */
async function askChatGPTViaDriver(
  question: string,
  debug?: boolean,
  budgetMs?: number,
): Promise<ChatResult> {
  const t0 = nowMs();
  const timings: Partial<ChatTimings> = {};

  // 接続
  const client = await getClient('chatgpt');
  timings.connectMs = nowMs() - t0;
  logInfo('chatgpt', '[Driver] getClient completed', {
    connectMs: timings.connectMs,
  });

  await client.waitForFunction(`document.readyState === 'complete'`, 30000);
  const reuseContext = await getChatGPTConversationReuseContext(client);
  const modelSelection = await ensureChatGPTPreferredModel(client, {
    preserveConversation: reuseContext.preserveConversation,
  });

  // Driver取得・設定
  const driver = getDriver('chatgpt');
  if (!driver) {
    throw new Error('ChatGPT driver not found');
  }
  driver.setClient(client);

  // 入力欄待機
  const tWaitInput = nowMs();
  await client.waitForFunction(
    `!!document.querySelector('textarea#prompt-textarea') ||
     !!document.querySelector('.ProseMirror[contenteditable="true"]')`,
    30000,
  );
  timings.waitInputMs = nowMs() - tWaitInput;

  const interceptor = new NetworkInterceptor(client);
  interceptor.startCapture();

  let answer: string;
  try {
    // 送信
    const tInput = nowMs();
    const sendResult = await driver.sendPrompt(question);
    if (!sendResult.success) {
      throw new Error(`Failed to send prompt: ${sendResult.error}`);
    }
    timings.inputMs = nowMs() - tInput;

    const tSend = nowMs();
    timings.sendMs = nowMs() - tSend;

    // 応答待機
    const tWaitResp = nowMs();
    const driverWaitBudgetMs = getResponseWaitBudgetMs(
      t0,
      modelSelection.selectedPro
        ? CHATGPT_PRO_RESPONSE_WAIT_MAX_MS
        : RESPONSE_WAIT_MAX_MS,
      'chatgpt-driver-response',
      budgetMs ??
        (modelSelection.selectedPro ? CHATGPT_PRO_TOOL_BUDGET_MS : undefined),
    );
    await driver.waitForResponse({maxWaitMs: driverWaitBudgetMs});
    timings.waitResponseMs = nowMs() - tWaitResp;

    // 応答抽出
    const extractResult = await driver.extractResponse({debug});
    answer = extractResult.text;
    logInfo('chatgpt', '[Driver] Response extracted', {
      length: answer.length,
      evidence: extractResult.evidence,
      confidence: extractResult.confidence,
    });
  } catch (error) {
    await interceptor.stopCaptureAndWait().catch(() => undefined);
    throw error;
  }

  await interceptor.stopCaptureAndWait();
  const networkResult = interceptor.getResult();
  logInfo('chatgpt', '[Driver] Network capture result', {
    frames: networkResult.frames.length,
    textLength: networkResult.text.length,
    rawDataSize: networkResult.rawDataSize,
    captureTimeMs: networkResult.captureTimeMs,
    summary: interceptor.getSummary(),
  });

  let hybridAnswer = answer;
  let answerSource = 'dom';
  const netLen = networkResult.text.length;
  const domLen = answer.length;
  if (netLen > 0 && (domLen === 0 || netLen >= domLen * 0.5)) {
    hybridAnswer = networkResult.text;
    answerSource = 'network';
  }
  logInfo('chatgpt', '[Driver] Answer source selected', {
    source: answerSource,
    networkLen: netLen,
    domLen,
  });

  // セッション保存
  const finalUrl = await driver.getCurrentUrl();
  if (isChatGPTConversationUrl(finalUrl)) {
    logChatGPTForkIfNeeded(
      reuseContext.preserveConversation,
      reuseContext.preferredUrl,
      finalUrl,
    );
    await saveAgentSession('chatgpt', getBaseUrl('chatgpt', finalUrl));
  }

  timings.totalMs = nowMs() - t0;

  // 履歴保存
  await appendHistory({
    provider: 'chatgpt',
    question,
    answer: hybridAnswer,
    url: finalUrl,
    timings,
  });

  const fullTimings: ChatTimings = {
    connectMs: timings.connectMs ?? 0,
    waitInputMs: timings.waitInputMs ?? 0,
    inputMs: timings.inputMs ?? 0,
    sendMs: timings.sendMs ?? 0,
    waitResponseMs: timings.waitResponseMs ?? 0,
    totalMs: timings.totalMs ?? 0,
  };

  return {answer: hybridAnswer, timings: fullTimings};
}

/**
 * Driver経由でGeminiに質問（実験的）
 */
async function askGeminiViaDriver(
  question: string,
  debug?: boolean,
  budgetMs?: number,
): Promise<ChatResult> {
  const t0 = nowMs();
  const timings: Partial<ChatTimings> = {};

  // 接続
  const client = await getClient('gemini');
  timings.connectMs = nowMs() - t0;
  logInfo('gemini', '[Driver] getClient completed', {
    connectMs: timings.connectMs,
  });

  // Driver取得・設定
  const driver = getDriver('gemini');
  if (!driver) {
    throw new Error('Gemini driver not found');
  }
  driver.setClient(client);

  const needsLogin = await driver.needsLogin();
  logInfo('gemini', '[Driver] Login status', {needsLogin});

  const tUrl = nowMs();
  const currentUrl = await driver.getCurrentUrl();
  const preferred = (await getPreferredSessionV2('gemini')).url;
  if (!currentUrl || !currentUrl.includes('gemini.google.com')) {
    await navigate(client, preferred || 'https://gemini.google.com/');
  } else if (preferred && !currentUrl.startsWith(preferred)) {
    await navigate(client, preferred);
  }
  timings.navigateMs = nowMs() - tUrl;

  // 入力欄待機
  const tWaitInput = nowMs();
  await client.waitForFunction(
    `!!document.querySelector('[role="textbox"]') ||
     !!document.querySelector('div[contenteditable="true"]') ||
     !!document.querySelector('textarea')`,
    15000,
  );
  timings.waitInputMs = nowMs() - tWaitInput;

  const interceptor = new NetworkInterceptor(client);
  interceptor.startCapture();

  let answer: string;
  let extractEvidence = 'unknown';
  try {
    const initialModelResponseCount = await client.evaluate<number>(`
      (() => {
        ${DOM_UTILS_CODE}
        return __collectDeep(['model-response', '[data-test-id*="response"]', '.response', '.model-response']).nodes.length;
      })()
    `);

    // 送信
    const tInput = nowMs();
    const sendResult = await driver.sendPrompt(question);
    if (!sendResult.success) {
      throw new Error(`Failed to send prompt: ${sendResult.error}`);
    }
    timings.inputMs = nowMs() - tInput;

    const tSend = nowMs();
    timings.sendMs = nowMs() - tSend;

    // 応答待機
    const tWaitResp = nowMs();
    const driverWaitBudgetMs = getResponseWaitBudgetMs(
      t0,
      RESPONSE_WAIT_MAX_MS,
      'gemini-driver-response',
      budgetMs,
    );
    await driver.waitForResponse({
      maxWaitMs: driverWaitBudgetMs,
      initialModelResponseCount,
    } as {maxWaitMs: number; initialModelResponseCount: number});
    timings.waitResponseMs = nowMs() - tWaitResp;

    // 応答抽出
    const extractResult = await driver.extractResponse({debug});
    extractEvidence = extractResult.evidence;
    answer = normalizeGeminiResponse(extractResult.text, question);
    logInfo('gemini', '[Driver] Response extracted', {
      length: answer.length,
      evidence: extractResult.evidence,
      confidence: extractResult.confidence,
    });
  } catch (error) {
    await interceptor.stopCaptureAndWait().catch(() => undefined);
    throw error;
  }

  await interceptor.stopCaptureAndWait();
  const networkResult = interceptor.getResult();
  logInfo('gemini', '[Driver] Network capture result', {
    frames: networkResult.frames.length,
    textLength: networkResult.text.length,
    rawDataSize: networkResult.rawDataSize,
    captureTimeMs: networkResult.captureTimeMs,
    summary: interceptor.getSummary(),
  });

  const networkNormalized = normalizeGeminiResponse(
    networkResult.text,
    question,
  );
  let hybridAnswer = answer;
  let answerSource = 'dom';
  const netLen = networkNormalized.length;
  const domLen = answer.length;
  if (netLen > 0 && (domLen === 0 || netLen >= domLen * 0.5)) {
    hybridAnswer = networkNormalized;
    answerSource = 'network';
  }
  logInfo('gemini', '[Driver] Answer source selected', {
    source: answerSource,
    networkLen: netLen,
    domLen,
  });

  // セッション保存
  const finalUrl = await driver.getCurrentUrl();
  if (finalUrl.includes('gemini.google.com')) {
    await saveAgentSession('gemini', getBaseUrl('gemini', finalUrl));
  }

  timings.totalMs = nowMs() - t0;

  // 履歴保存
  await appendHistory({
    provider: 'gemini',
    question,
    answer: hybridAnswer,
    url: finalUrl,
    timings,
  });

  const fullTimings: ChatTimings = {
    connectMs: timings.connectMs ?? 0,
    waitInputMs: timings.waitInputMs ?? 0,
    inputMs: timings.inputMs ?? 0,
    sendMs: timings.sendMs ?? 0,
    waitResponseMs: timings.waitResponseMs ?? 0,
    totalMs: timings.totalMs ?? 0,
    navigateMs: timings.navigateMs,
  };

  let debugInfo: ChatDebugInfo | undefined;
  if (debug) {
    const domDebug = await client.evaluate<{
      articleCount: number;
      markdowns: Array<{
        className: string;
        innerTextLength: number;
        innerText: string;
        isResultThinking: boolean;
      }>;
      lastArticleHtml: string;
      lastArticleInnerText: string;
      url: string;
      documentTitle: string;
    }>(`
      (() => {
        ${DOM_UTILS_CODE}

        const allResponses = __collectDeep(['model-response', '[data-test-id*="response"]', '.response', '.model-response']).nodes;
        const lastResponse = allResponses.length > 0 ? allResponses[allResponses.length - 1] : null;

        const markdownElements = lastResponse ? Array.from(lastResponse.querySelectorAll('.markdown')) : [];

        return {
          articleCount: allResponses.length,
          markdowns: markdownElements.map(md => ({
            className: md.className,
            innerTextLength: (md.innerText || '').length,
            innerText: md.innerText || '',
            isResultThinking: false
          })),
          lastArticleHtml: lastResponse ? lastResponse.innerHTML : '',
          lastArticleInnerText: lastResponse ? (lastResponse.innerText || '') : '',
          url: window.location.href,
          documentTitle: document.title
        };
      })()
    `);

    debugInfo = {
      dom: {
        articleCount: domDebug.articleCount,
        markdowns: domDebug.markdowns,
        lastArticleHtml: domDebug.lastArticleHtml,
        lastArticleInnerText: domDebug.lastArticleInnerText,
      },
      extraction: {
        selectorsTried: [
          {
            selector: 'model-response',
            found: domDebug.articleCount > 0,
            textLength: domDebug.lastArticleInnerText.length,
          },
          {
            selector: '.markdown',
            found: domDebug.markdowns.length > 0,
            textLength: domDebug.markdowns.reduce(
              (sum, m) => sum + m.innerTextLength,
              0,
            ),
          },
          {
            selector: extractEvidence,
            found: !!answer,
            textLength: answer.length,
          },
        ],
        finalSelector: hybridAnswer ? extractEvidence : undefined,
        fallbackUsed:
          answerSource === 'network' ? 'network-interceptor' : undefined,
      },
      timings: fullTimings,
      url: domDebug.url,
      documentTitle: domDebug.documentTitle,
    };
  }

  return {answer: hybridAnswer, timings: fullTimings, debug: debugInfo};
}

interface PageLoadStatus {
  url: string;
  status?: number;
}

function isConversationUrl(kind: 'chatgpt' | 'gemini', url: string): boolean {
  try {
    const parsed = new URL(url);
    return kind === 'chatgpt'
      ? parsed.hostname.includes('chatgpt.com') &&
          /^\/c\/[^/]+/.test(parsed.pathname)
      : parsed.hostname.includes('gemini.google.com') &&
          /^\/app\/[^/]+/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function sameConversationUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return false;
  }
}

function isAuthOrOnboardingUrl(
  kind: 'chatgpt' | 'gemini',
  url: string,
): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (kind === 'chatgpt' && parsed.hostname.includes('chatgpt.com')) {
      return /^\/(auth|login|log-in|signin|sign-in|signup|sign-up|onboarding|account|accounts)(\/|$)/.test(
        path,
      );
    }
    if (kind === 'gemini' && parsed.hostname.includes('gemini.google.com')) {
      return /^\/(auth|login|signin|sign-in|onboarding|account|accounts)(\/|$)/.test(
        path,
      );
    }
    return parsed.hostname.includes('accounts.google.com');
  } catch {
    return false;
  }
}

function isDeletedChatSignal(
  kind: 'chatgpt' | 'gemini',
  requestedUrl: string,
  page: PageLoadStatus,
): boolean {
  if (!isConversationUrl(kind, requestedUrl)) {
    return false;
  }
  if (page.status === 404 || page.status === 410) {
    return true;
  }
  if (!page.url || sameConversationUrl(page.url, requestedUrl)) {
    return false;
  }
  try {
    const finalUrl = new URL(page.url);
    const requested = new URL(requestedUrl);
    if (isAuthOrOnboardingUrl(kind, page.url)) {
      return false;
    }
    const finalIsProvider = finalUrl.origin === requested.origin;
    return finalIsProvider && !isConversationUrl(kind, page.url);
  } catch {
    return false;
  }
}

/**
 * ChatGPTに質問して回答を取得（後方互換用）
 */
export async function askChatGPTFast(
  question: string,
  debug?: boolean,
  budgetMs?: number,
): Promise<string> {
  const result = await askChatGPTViaDriver(question, debug, budgetMs);
  return result.answer;
}

/**
 * ChatGPTに質問して回答とタイミング情報を取得
 */
export async function askChatGPTFastWithTimings(
  question: string,
  debug?: boolean,
  budgetMs?: number,
): Promise<ChatResult> {
  return askChatGPTViaDriver(question, debug, budgetMs);
}

/**
 * Geminiに質問して回答を取得（後方互換用）
 */
export async function askGeminiFast(
  question: string,
  debug?: boolean,
  budgetMs?: number,
): Promise<string> {
  const result = await askGeminiViaDriver(question, debug, budgetMs);
  return result.answer;
}

/**
 * Geminiに質問して回答とタイミング情報を取得
 */
export async function askGeminiFastWithTimings(
  question: string,
  debug?: boolean,
  budgetMs?: number,
): Promise<ChatResult> {
  return askGeminiViaDriver(question, debug, budgetMs);
}

/**
 * CDPが見ているページのスナップショットを取得
 * デバッグ用：実際にCDPが何を見ているか確認できる
 */
export interface CdpSnapshot {
  kind: 'chatgpt' | 'gemini';
  connected: boolean;
  // ページ基本情報
  url?: string;
  title?: string;
  readyState?: string;
  // DOM情報
  bodyText?: string;
  elementCount?: number;
  // 入力欄
  hasInputField?: boolean;
  inputFieldValue?: string;
  inputFieldSelector?: string;
  // 送信ボタン
  hasSendButton?: boolean;
  sendButtonDisabled?: boolean;
  sendButtonSelector?: string;
  // メッセージカウント
  userMessageCount?: number;
  assistantMessageCount?: number;
  // その他のUI状態
  hasStopButton?: boolean;
  hasLoginPrompt?: boolean;
  visibleDialogs?: string[];
  // スクリーンショット
  screenshotPath?: string;
  // エラー
  error?: string;
  // タイムスタンプ
  timestamp?: string;
}

export async function takeCdpSnapshot(
  kind: 'chatgpt' | 'gemini',
  options?: {
    includeScreenshot?: boolean;
    bodyTextLimit?: number;
  },
): Promise<CdpSnapshot> {
  const result: CdpSnapshot = {
    kind,
    connected: false,
    timestamp: new Date().toISOString(),
  };

  const existing = getClientFromAgent(kind);

  if (!existing) {
    result.error = `No ${kind} connection exists. Use ask_${kind}_web first to establish a connection.`;
    return result;
  }

  // 接続の健全性チェック
  const healthy = await isConnectionHealthy(existing, kind);
  if (!healthy) {
    result.error = `${kind} connection is not healthy (disconnected or unresponsive).`;
    return result;
  }

  result.connected = true;

  try {
    // ページ基本情報
    const basicInfo = await existing.evaluate<{
      url: string;
      title: string;
      readyState: string;
      elementCount: number;
    }>(`
      ({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        elementCount: document.querySelectorAll('*').length,
      })
    `);
    result.url = basicInfo.url;
    result.title = basicInfo.title;
    result.readyState = basicInfo.readyState;
    result.elementCount = basicInfo.elementCount;

    // Body テキスト（指定文字数まで）
    const limit = options?.bodyTextLimit ?? 1000;
    result.bodyText = await existing.evaluate<string>(`
      document.body?.innerText?.slice(0, ${limit}) || "(empty body)"
    `);

    if (kind === 'chatgpt') {
      // ChatGPT用の詳細情報取得
      const chatgptState = await existing.evaluate<{
        inputFound: boolean;
        inputValue: string;
        inputSelector: string;
        sendButtonFound: boolean;
        sendButtonDisabled: boolean;
        sendButtonSelector: string;
        stopButtonFound: boolean;
        userMsgCount: number;
        assistantMsgCount: number;
        hasLoginPrompt: boolean;
        dialogs: string[];
      }>(`
        (() => {
          // 入力欄
          const textarea = document.querySelector('textarea#prompt-textarea') ||
                          document.querySelector('textarea[data-testid="prompt-textarea"]');
          const prosemirror = document.querySelector('.ProseMirror[contenteditable="true"]');
          let inputFound = false;
          let inputValue = '';
          let inputSelector = '';
          if (textarea) {
            inputFound = true;
            inputValue = textarea.value || '';
            inputSelector = textarea.id ? '#' + textarea.id : 'textarea[data-testid="prompt-textarea"]';
          } else if (prosemirror) {
            inputFound = true;
            inputValue = prosemirror.textContent || '';
            inputSelector = '.ProseMirror[contenteditable="true"]';
          }

          // 送信ボタン
          const sendBtn = document.querySelector('button[data-testid="send-button"]');
          const sendButtonFound = !!sendBtn;
          const sendButtonDisabled = sendBtn ? (
            sendBtn.disabled ||
            sendBtn.getAttribute('aria-disabled') === 'true' ||
            sendBtn.getAttribute('disabled') === 'true'
          ) : false;

          // 停止ボタン
          const stopBtn = document.querySelector('button[data-testid="stop-button"]');

          // メッセージカウント
          const userMsgs = document.querySelectorAll('[data-message-author-role="user"]');
          const assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');

          // ログインプロンプト
          const hasLoginPrompt = !!document.querySelector('button[data-testid="login-button"]') ||
                                !!document.querySelector('[data-testid="login-modal"]') ||
                                document.body?.innerText?.includes('ログイン') && !inputFound;

          // ダイアログ
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
            .map(d => d.getAttribute('aria-label') || d.textContent?.slice(0, 50) || 'unknown dialog');

          return {
            inputFound,
            inputValue,
            inputSelector,
            sendButtonFound,
            sendButtonDisabled,
            sendButtonSelector: sendButtonFound ? 'button[data-testid="send-button"]' : '',
            stopButtonFound: !!stopBtn,
            userMsgCount: userMsgs.length,
            assistantMsgCount: assistantMsgs.length,
            hasLoginPrompt,
            dialogs,
          };
        })()
      `);

      result.hasInputField = chatgptState.inputFound;
      result.inputFieldValue = chatgptState.inputValue;
      result.inputFieldSelector = chatgptState.inputSelector;
      result.hasSendButton = chatgptState.sendButtonFound;
      result.sendButtonDisabled = chatgptState.sendButtonDisabled;
      result.sendButtonSelector = chatgptState.sendButtonSelector;
      result.hasStopButton = chatgptState.stopButtonFound;
      result.userMessageCount = chatgptState.userMsgCount;
      result.assistantMessageCount = chatgptState.assistantMsgCount;
      result.hasLoginPrompt = chatgptState.hasLoginPrompt;
      result.visibleDialogs = chatgptState.dialogs;
    } else {
      // Gemini用の詳細情報取得
      const geminiState = await existing.evaluate<{
        inputFound: boolean;
        inputValue: string;
        sendButtonFound: boolean;
        userMsgCount: number;
        assistantMsgCount: number;
        hasLoginPrompt: boolean;
        dialogs: string[];
      }>(`
        (() => {
          ${DOM_UTILS_CODE}

          // 入力欄
          const textbox = __collectDeep(['[role="textbox"]', 'div[contenteditable="true"]', 'textarea']).nodes[0];
          const inputFound = !!textbox;
          const inputValue = textbox ?
            (textbox.isContentEditable ? textbox.innerText : (textbox.value || textbox.textContent || '')) : '';

          // 送信ボタン
          const buttons = __collectDeep(['button[aria-label*="Send"]', 'button[aria-label*="送信"]', 'button.send-button', '[data-test-id*="send"]']).nodes;
          const sendButtonFound = buttons.length > 0;

          // メッセージカウント
          const userSelectors = ['user-query', '.user-query', '[data-message-author-role="user"]', 'message[author="user"]'];
          const userMsgs = __collectDeep(userSelectors).nodes;
          const assistantSelectors = ['model-response', '.model-response', '[data-message-author-role="assistant"]', 'message[author="model"]'];
          const assistantMsgs = __collectDeep(assistantSelectors).nodes;

          // ログインプロンプト
          const hasLoginPrompt = document.body?.innerText?.includes('Sign in') ||
                                document.body?.innerText?.includes('ログイン');

          // ダイアログ
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
            .map(d => d.getAttribute('aria-label') || d.textContent?.slice(0, 50) || 'unknown dialog');

          return {
            inputFound,
            inputValue,
            sendButtonFound,
            userMsgCount: userMsgs.length,
            assistantMsgCount: assistantMsgs.length,
            hasLoginPrompt,
            dialogs,
          };
        })()
      `);

      result.hasInputField = geminiState.inputFound;
      result.inputFieldValue = geminiState.inputValue;
      result.hasSendButton = geminiState.sendButtonFound;
      result.userMessageCount = geminiState.userMsgCount;
      result.assistantMessageCount = geminiState.assistantMsgCount;
      result.hasLoginPrompt = geminiState.hasLoginPrompt;
      result.visibleDialogs = geminiState.dialogs;
    }

    // スクリーンショット（オプション）
    if (options?.includeScreenshot) {
      try {
        const screenshot = await existing.send('Page.captureScreenshot', {
          format: 'png',
        });
        const screenshotData = screenshot?.data as string | undefined;
        if (screenshotData) {
          const timestamp = Date.now();
          const screenshotPath = `/tmp/cdp-snapshot-${kind}-${timestamp}.png`;
          const {writeFile} = await import('node:fs/promises');
          await writeFile(
            screenshotPath,
            Buffer.from(screenshotData, 'base64'),
          );
          result.screenshotPath = screenshotPath;
        }
      } catch (ssError) {
        // スクリーンショット失敗は致命的ではない
        console.error(`[fast-cdp] Screenshot failed for ${kind}:`, ssError);
      }
    }
  } catch (error) {
    result.error = `Failed to get snapshot: ${error instanceof Error ? error.message : String(error)}`;
  }

  return result;
}

/**
 * DOM取得用インターフェース
 */
export interface DomSnapshot {
  kind: 'chatgpt' | 'gemini';
  url: string;
  title: string;
  timestamp: string;
  connected: boolean;
  error?: string;
  selectors: Record<
    string,
    {
      count: number;
      elements: Array<{
        tagName: string;
        attributes: Record<string, string>;
        textContent: string;
        outerHTML: string;
      }>;
    }
  >;
  messages?: Array<{
    role: 'user' | 'assistant' | 'unknown';
    text: string;
    attributes: Record<string, string>;
  }>;
}

/**
 * 指定したセレクターでDOM要素を取得
 * デバッグ用：UIが変わった時にセレクターを特定するために使用
 */
export async function getPageDom(
  kind: 'chatgpt' | 'gemini',
  selectors: string[] = [],
): Promise<DomSnapshot> {
  const result: DomSnapshot = {
    kind,
    url: '',
    title: '',
    timestamp: new Date().toISOString(),
    connected: false,
    selectors: {},
  };

  const existing = getClientFromAgent(kind);

  if (!existing) {
    result.error = `No ${kind} connection exists. Use ask_${kind}_web first to establish a connection.`;
    return result;
  }

  // 接続の健全性チェック
  const healthy = await isConnectionHealthy(existing, kind);
  if (!healthy) {
    result.error = `${kind} connection is not healthy (disconnected or unresponsive).`;
    return result;
  }

  result.connected = true;

  try {
    // 基本情報取得
    const basicInfo = await existing.evaluate<{url: string; title: string}>(`
      ({url: location.href, title: document.title})
    `);
    result.url = basicInfo.url;
    result.title = basicInfo.title;

    // デフォルトセレクター（指定がない場合）
    const defaultSelectors =
      kind === 'chatgpt'
        ? [
            '[data-message-author-role]',
            '[data-testid]',
            '.ProseMirror',
            'textarea',
            'button[data-testid="send-button"]',
            'button[data-testid="stop-button"]',
          ]
        : [
            'model-response',
            'user-query',
            '[role="textbox"]',
            'div[contenteditable="true"]',
            'button[aria-label*="Send"]',
            'button[aria-label*="送信"]',
          ];

    const targetSelectors = selectors.length > 0 ? selectors : defaultSelectors;

    // 各セレクターで要素を取得
    for (const selector of targetSelectors) {
      const selectorResult = await existing.evaluate<{
        count: number;
        elements: Array<{
          tagName: string;
          attributes: Record<string, string>;
          textContent: string;
          outerHTML: string;
        }>;
      }>(`
        (() => {
          ${DOM_UTILS_CODE}

          const elements = __collectDeep([${JSON.stringify(selector)}]).nodes;
          return {
            count: elements.length,
            elements: elements.slice(0, 10).map(el => {
              const attrs = {};
              for (const attr of el.attributes) {
                attrs[attr.name] = attr.value;
              }
              return {
                tagName: el.tagName.toLowerCase(),
                attributes: attrs,
                textContent: (el.textContent || '').slice(0, 200),
                outerHTML: (el.outerHTML || '').slice(0, 500),
              };
            }),
          };
        })()
      `);

      result.selectors[selector] = selectorResult;
    }

    // メッセージ要素を特別に取得
    const messageSelectors =
      kind === 'chatgpt'
        ? {
            user: '[data-message-author-role="user"]',
            assistant: '[data-message-author-role="assistant"]',
          }
        : {
            user: 'user-query, .user-query, [data-message-author-role="user"]',
            assistant:
              'model-response, .model-response, [data-message-author-role="assistant"]',
          };

    const messages = await existing.evaluate<
      Array<{
        role: 'user' | 'assistant' | 'unknown';
        text: string;
        attributes: Record<string, string>;
      }>
    >(`
      (() => {
        ${DOM_UTILS_CODE}

        const messages = [];

        // User messages
        const userEls = __collectDeep([${JSON.stringify(messageSelectors.user)}]).nodes;
        for (const el of userEls) {
          const attrs = {};
          for (const attr of el.attributes) {
            attrs[attr.name] = attr.value;
          }
          messages.push({
            role: 'user',
            text: (el.textContent || '').slice(0, 500),
            attributes: attrs,
          });
        }

        // Assistant messages
        const assistantEls = __collectDeep([${JSON.stringify(messageSelectors.assistant)}]).nodes;
        for (const el of assistantEls) {
          const attrs = {};
          for (const attr of el.attributes) {
            attrs[attr.name] = attr.value;
          }
          messages.push({
            role: 'assistant',
            text: (el.textContent || '').slice(0, 500),
            attributes: attrs,
          });
        }

        return messages;
      })()
    `);

    result.messages = messages;
  } catch (error) {
    result.error = `Failed to get DOM: ${error instanceof Error ? error.message : String(error)}`;
  }

  return result;
}
