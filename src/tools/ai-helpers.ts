/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {askChatGPTFastWithTimings, askGeminiFastWithTimings, getClient, resetConnection, ChatDebugInfo} from '../fast-cdp/fast-chat.js';

export type AIKind = 'chatgpt' | 'gemini';

export interface AIResult {
  provider: string;
  success: boolean;
  answer: string;
  error?: string;
  debug?: ChatDebugInfo;
}

export interface ConnectionResult {
  success: boolean;
  error?: string;
}

/**
 * GEMINI_STUCK_* エラーかどうかを判定
 */
function isGeminiStuckError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes('GEMINI_STUCK_');
  }
  return false;
}

/**
 * 接続系エラー（リトライ対象）かどうかを判定。
 * これらのエラーは resetConnection → 再接続で回復する可能性がある。
 */
function isRetryableConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  const patterns = [
    'RELAY_DISCONNECTED',
    'RELAY_STOPPED',
    'RELAY_REQUEST_TIMEOUT',
    'EXT_READY_TIMEOUT',
    'EXT_DISCONNECTED',
    'Extension not connected',
    'WebSocket not open',
  ];
  return patterns.some(p => msg.includes(p));
}

/**
 * リトライすべきでないエラーかどうかを判定。
 * 質問送信済みの場合やバジェット超過は再試行しても無意味または有害。
 */
function isNonRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  return msg.includes('MCP_TOOL_BUDGET_EXCEEDED') ||
         msg.includes('Timed out waiting for function');
}

/**
 * AIに質問を送信し、結果を返す
 * 接続確立からクエリ送信までを一括で行う
 * 接続エラー・Geminiスタックエラーの場合は自動リトライ（resetConnection → 再接続）
 */
export async function askAI(kind: AIKind, question: string, debug?: boolean, budgetMs?: number): Promise<AIResult> {
  const askFn = kind === 'chatgpt' ? askChatGPTFastWithTimings : askGeminiFastWithTimings;
  const label = kind === 'chatgpt' ? 'ChatGPT' : 'Gemini';

  const maxRetries = 2;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await askFn(question, debug, budgetMs);
      return {
        provider: label,
        success: true,
        answer: result.answer || '（空の応答）',
        debug: result.debug,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (isNonRetryableError(error) || attempt >= maxRetries) {
        return {
          provider: label,
          success: false,
          answer: '',
          error: lastError.message,
        };
      }

      // 接続系エラーまたは Gemini stuck → resetConnection してリトライ
      if (isRetryableConnectionError(error) || isGeminiStuckError(error)) {
        console.error(`[askAI] ${label} error on attempt ${attempt} (${isRetryableConnectionError(error) ? 'connection' : 'stuck'}), resetting and retrying...`);
        try {
          await resetConnection(kind);
        } catch {
          // resetConnection failure is not fatal — retry anyway
        }
        continue;
      }

      // Unknown error — don't retry
      return {
        provider: label,
        success: false,
        answer: '',
        error: lastError.message,
      };
    }
  }

  // Unreachable, but satisfies type checker
  return {
    provider: label,
    success: false,
    answer: '',
    error: lastError?.message || 'Unknown error',
  };
}

/**
 * AIへの接続を確立する（並列接続用）
 * 接続エラー・Geminiスタックエラーの場合は自動リトライ（resetConnection → 再接続）
 */
export async function connectAI(kind: AIKind): Promise<ConnectionResult> {
  const maxRetries = 2;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await getClient(kind);
      return {success: true};
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (isNonRetryableError(error) || attempt >= maxRetries) {
        return {
          success: false,
          error: lastError.message,
        };
      }

      if (isRetryableConnectionError(error) || isGeminiStuckError(error)) {
        console.error(`[connectAI] ${kind} error on attempt ${attempt} (${isRetryableConnectionError(error) ? 'connection' : 'stuck'}), resetting and retrying...`);
        try {
          await resetConnection(kind);
        } catch {
          // resetConnection failure is not fatal — retry anyway
        }
        continue;
      }

      // Unknown error — don't retry
      return {
        success: false,
        error: lastError.message,
      };
    }
  }

  // Unreachable, but satisfies type checker
  return {
    success: false,
    error: lastError?.message || 'Unknown error',
  };
}
