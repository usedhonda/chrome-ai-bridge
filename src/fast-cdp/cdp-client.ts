/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type {RelayServer} from '../extension/relay-server.js';

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

const RETRYABLE_RELAY_TIMEOUT_METHODS = new Set([
  'DOM.enable',
  'Emulation.setFocusEmulationEnabled',
  'Network.enable',
  'Network.getResponseBody',
  'Page.bringToFront',
  'Page.captureScreenshot',
  'Page.enable',
  'Page.navigate',
  'Runtime.enable',
  'Runtime.evaluate',
]);

function isRelayRequestTimeout(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes('RELAY_REQUEST_TIMEOUT')
  );
}

function relayRetryDelayMs(attempt: number): number {
  return 250 * Math.pow(2, attempt);
}

export class CdpClient {
  private relay: RelayServer;
  private sessionId?: string;
  private eventHandlers = new Map<
    string,
    Map<(params: Record<string, unknown>) => void, (event: CdpEvent) => void>
  >();

  constructor(relay: RelayServer, sessionId?: string) {
    this.relay = relay;
    this.sessionId = sessionId;
  }

  async send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const maxAttempts = RETRYABLE_RELAY_TIMEOUT_METHODS.has(method) ? 3 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.relay.sendRequest('forwardCDPCommand', {
          sessionId: this.sessionId,
          method,
          params: params ?? {},
        });
      } catch (error) {
        if (!isRelayRequestTimeout(error) || attempt >= maxAttempts - 1) {
          throw error;
        }
        const waitMs = relayRetryDelayMs(attempt);
        console.error(
          `[CDP] ${method} hit RELAY_REQUEST_TIMEOUT; retry ${attempt + 2}/${maxAttempts} after ${waitMs}ms`,
        );
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
    throw new Error(`CDP_RETRY_EXHAUSTED: method=${method}`);
  }

  /**
   * Subscribe to a specific CDP event method (e.g. 'Network.webSocketFrameReceived').
   * Filters RelayServer 'cdp-event' emissions by method name.
   */
  on(
    eventMethod: string,
    callback: (params: Record<string, unknown>) => void,
  ): void {
    const handler = (event: CdpEvent) => {
      if (event.method === eventMethod) callback(event.params);
    };
    if (!this.eventHandlers.has(eventMethod)) {
      this.eventHandlers.set(eventMethod, new Map());
    }
    this.eventHandlers.get(eventMethod)!.set(callback, handler);
    this.relay.on('cdp-event', handler);
  }

  /**
   * Unsubscribe from a specific CDP event method.
   */
  off(
    eventMethod: string,
    callback: (params: Record<string, unknown>) => void,
  ): void {
    const methodMap = this.eventHandlers.get(eventMethod);
    if (!methodMap) return;
    const handler = methodMap.get(callback);
    if (handler) {
      this.relay.off('cdp-event', handler);
      methodMap.delete(callback);
    }
    if (methodMap.size === 0) {
      this.eventHandlers.delete(eventMethod);
    }
  }

  /**
   * Remove all CDP event listeners registered through this client.
   */
  removeAllCdpListeners(): void {
    for (const [, methodMap] of this.eventHandlers) {
      for (const [, handler] of methodMap) {
        this.relay.off('cdp-event', handler);
      }
    }
    this.eventHandlers.clear();
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    // デバッグ: 例外がある場合はログに出力
    if (result?.exceptionDetails) {
      console.error(
        '[CDP] evaluate exception:',
        JSON.stringify(result.exceptionDetails),
      );
    }
    const inner = result?.result as Record<string, unknown> | undefined;
    return inner?.value as T;
  }

  async waitForFunction(
    expression: string,
    timeoutMs = 30000,
    intervalMs = 250,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const value = await this.evaluate<boolean>(expression);
        if (value) return true;
      } catch {
        // ignore and retry
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timed out waiting for function: ${expression}`);
  }
}
