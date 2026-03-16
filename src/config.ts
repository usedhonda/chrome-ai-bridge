/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Global configuration for chrome-ai-bridge
 */

/**
 * ChatGPT configuration
 */
export const CHATGPT_CONFIG = {
  /**
   * Default ChatGPT URL with gpt-5-thinking model
   */
  DEFAULT_URL: 'https://chatgpt.com/?model=gpt-5-thinking',

  /**
   * Base URL for ChatGPT (without query params)
   */
  BASE_URL: 'https://chatgpt.com/',

  /**
   * Default model parameter
   */
  DEFAULT_MODEL: 'gpt-5-thinking',
} as const;

/**
 * Gemini configuration
 */
export const GEMINI_CONFIG = {
  /**
   * Default Gemini URL
   */
  DEFAULT_URL: 'https://gemini.google.com/',

  /**
   * Base URL for Gemini
   */
  BASE_URL: 'https://gemini.google.com/',
} as const;

/**
 * HTTP server configuration for the daemon.
 * The Primary instance exposes an HTTP endpoint on this port.
 */
export const IPC_CONFIG = {
  port: Number(process.env.CAI_IPC_PORT) || 9321,
  host: '127.0.0.1',
  healthPath: '/health',
} as const;

/**
 * Session configuration for Agent Teams support
 */
export interface SessionConfig {
  /** Session TTL in minutes (default: 30) */
  sessionTtlMinutes: number;
  /** Maximum number of concurrent agents (default: 10) */
  maxAgents: number;
  /** Cleanup interval in minutes (default: 5) */
  cleanupIntervalMinutes: number;
}

/**
 * Get session configuration from environment variables or defaults.
 */
export function getSessionConfig(): SessionConfig {
  const raw = {
    ttl: Number(process.env.CAI_SESSION_TTL_MINUTES),
    max: Number(process.env.CAI_MAX_AGENTS),
    interval: Number(process.env.CAI_CLEANUP_INTERVAL_MINUTES),
  };
  return {
    sessionTtlMinutes: raw.ttl > 0 ? raw.ttl : 30,
    maxAgents: raw.max > 0 ? Math.floor(raw.max) : 20,
    cleanupIntervalMinutes: raw.interval > 0 ? raw.interval : 5,
  };
}

/**
 * IPC overload protection configuration.
 */
export interface IpcGuardConfig {
  /** Maximum concurrent active IPC sessions. */
  maxSessions: number;
  /** Number of initialize waiters allowed while session capacity is full. */
  reservedInitSlots: number;
  /** Maximum queued initialization requests. */
  maxQueue: number;
  /** Maximum queue wait time in milliseconds. */
  queueWaitTimeoutMs: number;
  /** Idle timeout for inactive IPC sessions in milliseconds (0 disables cleanup). */
  sessionIdleMs: number;
  /** Start jitter when too many local instances are detected. */
  startupDelayJitterMs: number;
  /** Local instance count threshold that activates startup jitter. */
  startupProcessThreshold: number;
  /** Idle timeout for Primary process in milliseconds (0 disables auto-exit). */
  primaryIdleMs: number;
  /** Maximum number of concurrent tool executions in the Primary process. */
  execMaxConcurrency: number;
}

/**
 * Get IPC overload protection settings from environment variables or defaults.
 */
export function getIpcGuardConfig(): IpcGuardConfig {
  const raw = {
    maxSessions: Number(process.env.CAI_IPC_MAX_SESSIONS),
    reservedInitSlots: Number(process.env.CAI_IPC_RESERVED_INIT_SLOTS),
    maxQueue: Number(process.env.CAI_IPC_MAX_QUEUE),
    queueWaitTimeoutMs: Number(process.env.CAI_IPC_QUEUE_WAIT_TIMEOUT_MS),
    sessionIdleMs: Number(process.env.CAI_IPC_SESSION_IDLE_MS),
    startupDelayJitterMs: Number(process.env.CAI_STARTUP_DELAY_JITTER_MS),
    startupProcessThreshold: Number(process.env.CAI_STARTUP_PROCESS_THRESHOLD),
    primaryIdleMs: Number(process.env.CAI_PRIMARY_IDLE_MS),
    execMaxConcurrency: Number(process.env.CAI_EXEC_MAX_CONCURRENCY),
  };

  return {
    maxSessions: raw.maxSessions > 0 ? Math.floor(raw.maxSessions) : 20,
    reservedInitSlots:
      raw.reservedInitSlots >= 0 ? Math.floor(raw.reservedInitSlots) : 2,
    maxQueue: raw.maxQueue > 0 ? Math.floor(raw.maxQueue) : 64,
    queueWaitTimeoutMs:
      raw.queueWaitTimeoutMs > 0 ? Math.floor(raw.queueWaitTimeoutMs) : 45_000,
    sessionIdleMs:
      raw.sessionIdleMs >= 0 ? Math.floor(raw.sessionIdleMs) : 1_800_000,
    startupDelayJitterMs:
      raw.startupDelayJitterMs > 0
        ? Math.floor(raw.startupDelayJitterMs)
        : 1_500,
    startupProcessThreshold:
      raw.startupProcessThreshold > 0
        ? Math.floor(raw.startupProcessThreshold)
        : 8,
    primaryIdleMs: raw.primaryIdleMs >= 0 ? Math.floor(raw.primaryIdleMs) : 0,
    execMaxConcurrency:
      raw.execMaxConcurrency > 0 ? Math.floor(raw.execMaxConcurrency) : 3,
  };
}
