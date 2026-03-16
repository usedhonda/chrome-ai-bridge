/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Chrome AI Bridge - Daemon Mode (v3.0.0)
 *
 * Pure CLI/REST daemon for ChatGPT/Gemini integration via Chrome extension.
 * Exposes /health and /api/ask endpoints.
 * All interaction is via REST API or cab CLI.
 */

import assert from 'node:assert';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {parseArguments} from './cli.js';
import {getIpcGuardConfig, getSessionConfig, IPC_CONFIG} from './config.js';
import {generateAgentId, setAgentId} from './fast-cdp/agent-context.js';
import {cleanupAllConnections} from './fast-cdp/fast-chat.js';
import {cleanupStaleSessions} from './fast-cdp/session-manager.js';
import {logger, saveLogsToFile} from './logger.js';
import {Mutex} from './Mutex.js';
import {ToolRegistry} from './plugin-api.js';
import {
  releaseLock,
  tryAcquireLockSafe,
  updateLockPort,
  getLockNamespace,
  cleanupOrphanBridgeProcesses,
} from './process-lock.js';
import {askAI} from './tools/ai-helpers.js';
import type {AIKind} from './tools/ai-helpers.js';
import {
  registerOptionalTools,
  WEB_LLM_TOOLS_INFO,
} from './tools/optional-tools.js';

function readPackageJson(): {version?: string} {
  const currentDir = import.meta.dirname;
  const packageJsonPath = path.join(currentDir, '..', '..', 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return {};
  }
  try {
    const json = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    assert.strict(json['name'], 'chrome-ai-bridge');
    return json;
  } catch {
    return {};
  }
}

const version = readPackageJson().version ?? 'unknown';

export const args = parseArguments(version);

const logFile = args.logFile ? saveLogsToFile(args.logFile) : undefined;

logger(`Starting Chrome AI Bridge v${version} (daemon mode)`);
logger(`[main] Runtime lock namespace: ${getLockNamespace()}`);

// Initialize agent ID for Agent Teams support
const agentId = generateAgentId();
setAgentId(agentId);

// ─── Primary lock acquisition ───
// Only one daemon instance per namespace. If lock can't be acquired, exit.

const MAX_STARTUP_ATTEMPTS = 5;
const BASE_DELAY_MS = 300;
const ipcGuardConfig = getIpcGuardConfig();

const instanceId = randomUUID();
let becamePrimary = false;

function countLocalBridgeInstances(): number {
  try {
    const output = execFileSync('ps', ['-axo', 'command'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = output.split('\n').filter(Boolean);
    return lines.filter(
      line =>
        line.includes('chrome-ai-bridge') &&
        (line.includes('build/src/main.js') ||
          line.includes('scripts/cli.mjs')),
    ).length;
  } catch {
    return 0;
  }
}

async function applyStartupJitterIfNeeded(): Promise<void> {
  const instanceCount = countLocalBridgeInstances();
  if (instanceCount < ipcGuardConfig.startupProcessThreshold) {
    return;
  }
  const delayMs = Math.floor(
    Math.random() * ipcGuardConfig.startupDelayJitterMs,
  );
  logger(
    `[main] High startup concurrency detected (${instanceCount} processes). Applying jitter=${delayMs}ms.`,
  );
  await new Promise(resolve => setTimeout(resolve, delayMs));
}

await applyStartupJitterIfNeeded();

for (let attempt = 0; attempt < MAX_STARTUP_ATTEMPTS; attempt++) {
  const lockAcquired = await tryAcquireLockSafe(IPC_CONFIG.port, instanceId);
  if (lockAcquired) {
    becamePrimary = true;
    break;
  }

  // Lock held by another process — backoff with jitter and retry
  if (attempt < MAX_STARTUP_ATTEMPTS - 1) {
    const backoff = BASE_DELAY_MS * Math.pow(2, attempt);
    const jitter = Math.random() * BASE_DELAY_MS;
    const delay = backoff + jitter;
    logger(
      `[main] Startup attempt ${attempt + 1}/${MAX_STARTUP_ATTEMPTS} failed. Retrying in ${Math.round(delay)}ms...`,
    );
    await new Promise(r => setTimeout(r, delay));
  }
}

if (!becamePrimary) {
  logger(
    '[main] Failed to acquire primary lock after all retries. Another instance is running. Exiting.',
  );
  process.exit(1);
}

// ─── Primary mode ───

// Idle auto-exit tracking
let primaryLastActivityAt = Date.now();
const touchPrimaryActivity = (): void => {
  primaryLastActivityAt = Date.now();
};

// Start session cleanup timer
const sessionConfig = getSessionConfig();
const cleanupTimer = setInterval(
  async () => {
    try {
      const removed = await cleanupStaleSessions();
      if (removed > 0) {
        logger(`[session] Cleaned up ${removed} stale sessions`);
      }
    } catch (error) {
      logger(
        `[session] Cleanup error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
  sessionConfig.cleanupIntervalMinutes * 60 * 1000,
);
cleanupTimer.unref();

const logDisclaimers = () => {
  console.error(
    `chrome-ai-bridge connects to ChatGPT/Gemini via Chrome extension.
Make sure the chrome-ai-bridge extension is installed and Chrome is running.
Available tools: ask_chatgpt_web, ask_gemini_web, ask_chatgpt_gemini_web, take_cdp_snapshot, get_page_dom, ask_gemini_image`,
  );
};

const toolMutex = new Mutex(ipcGuardConfig.execMaxConcurrency);
const TOOL_SELF_CLEANUP_ENABLED =
  process.env.CAI_TOOL_SELF_CLEANUP_ENABLED !== '0';
const TOOL_SELF_CLEANUP_INTERVAL_MS = Math.max(
  5000,
  Number(process.env.CAI_TOOL_SELF_CLEANUP_INTERVAL_MS || '60000'),
);
let lastToolSelfCleanupAt = 0;
let toolSelfCleanupInFlight: Promise<void> | null = null;

async function maybeRunToolSelfCleanup(): Promise<void> {
  if (!TOOL_SELF_CLEANUP_ENABLED) {
    return;
  }

  const now = Date.now();
  if (now - lastToolSelfCleanupAt < TOOL_SELF_CLEANUP_INTERVAL_MS) {
    return;
  }

  if (toolSelfCleanupInFlight) {
    await toolSelfCleanupInFlight;
    return;
  }

  lastToolSelfCleanupAt = now;
  toolSelfCleanupInFlight = (async () => {
    const cleaned = await cleanupOrphanBridgeProcesses();
    if (cleaned > 0) {
      logger(
        `[main] Tool-triggered orphan cleanup removed ${cleaned} process(es).`,
      );
    }
  })()
    .catch(error => {
      logger(
        `[main] Tool-triggered orphan cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    })
    .finally(() => {
      toolSelfCleanupInFlight = null;
    });

  await toolSelfCleanupInFlight;
}

// Register optional tools (for tool metadata / future use)
const toolRegistry = new ToolRegistry();
const optionalCount = registerOptionalTools(toolRegistry);
if (optionalCount > 0) {
  logger(`[tools] ${WEB_LLM_TOOLS_INFO.disclaimer}`);
}
logger(`[tools] Total registered: ${toolRegistry.size} tools`);

logger('Chrome AI Bridge starting in daemon mode (HTTP-only)');
logDisclaimers();

// ─── HTTP server ───

const httpServer = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    res.writeHead(400).end();
    return;
  }

  const url = new URL(req.url, `http://${IPC_CONFIG.host}:${IPC_CONFIG.port}`);

  // Health endpoint
  if (url.pathname === IPC_CONFIG.healthPath) {
    res.writeHead(200, {'Content-Type': 'application/json'}).end(
      JSON.stringify({
        status: 'ok',
        pid: process.pid,
        version,
        namespace: getLockNamespace(),
        instanceId,
      }),
    );
    return;
  }

  // REST API endpoint — call askAI() directly
  if (url.pathname === '/api/ask' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk: Buffer | string) => {
      body += chunk;
    });
    req.on('end', async () => {
      touchPrimaryActivity();
      await maybeRunToolSelfCleanup();
      let parsed: {
        target?: string;
        question?: string;
        debug?: boolean;
        budgetMs?: number;
      };
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        res
          .writeHead(400, {'Content-Type': 'application/json'})
          .end(JSON.stringify({success: false, error: 'Invalid JSON'}));
        return;
      }

      const {
        target,
        question,
        debug: debugFlag,
        budgetMs: requestBudgetMs,
      } = parsed;
      const effectiveBudgetMs = requestBudgetMs ?? 300000;
      if (!target || !question) {
        res.writeHead(400, {'Content-Type': 'application/json'}).end(
          JSON.stringify({
            success: false,
            error: 'Missing required fields: target, question',
          }),
        );
        return;
      }

      const validTargets = ['chatgpt', 'gemini', 'both'];
      if (!validTargets.includes(target)) {
        res.writeHead(400, {'Content-Type': 'application/json'}).end(
          JSON.stringify({
            success: false,
            error: `Invalid target: ${target}. Must be one of: ${validTargets.join(', ')}`,
          }),
        );
        return;
      }

      const guard = await toolMutex.acquire();
      try {
        if (target === 'both') {
          const [chatgptResult, geminiResult] = await Promise.all([
            askAI('chatgpt', question, debugFlag, effectiveBudgetMs),
            askAI('gemini', question, debugFlag, effectiveBudgetMs),
          ]);
          res.writeHead(200, {'Content-Type': 'application/json'}).end(
            JSON.stringify({
              success: true,
              results: [chatgptResult, geminiResult],
            }),
          );
        } else {
          const result = await askAI(
            target as AIKind,
            question,
            debugFlag,
            effectiveBudgetMs,
          );
          res
            .writeHead(200, {'Content-Type': 'application/json'})
            .end(JSON.stringify({success: result.success, results: [result]}));
        }
      } catch (error) {
        const errorText =
          error instanceof Error ? error.message : String(error);
        if (!res.headersSent) {
          res
            .writeHead(500, {'Content-Type': 'application/json'})
            .end(JSON.stringify({success: false, error: errorText}));
        }
      } finally {
        guard.dispose();
      }
    });
    return;
  }

  res.writeHead(404).end();
});

function onListening(): void {
  const addr = httpServer.address();
  const actualPort =
    typeof addr === 'object' && addr ? addr.port : IPC_CONFIG.port;
  if (actualPort !== IPC_CONFIG.port) {
    logger(
      `[http] Configured port ${IPC_CONFIG.port} was unavailable. Using dynamic port ${actualPort}.`,
    );
    updateLockPort(actualPort);
  }
  logger(
    `[http] HTTP listening on http://${IPC_CONFIG.host}:${actualPort} (health: ${IPC_CONFIG.healthPath}, api: /api/ask)`,
  );
}

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger(
      `[http] Port ${IPC_CONFIG.port} in use. Retrying with dynamic port...`,
    );
    httpServer.listen(0, IPC_CONFIG.host, onListening);
  } else {
    logger(`[http] HTTP server error: ${err.message}`);
  }
});

httpServer.listen(IPC_CONFIG.port, IPC_CONFIG.host, onListening);

// Idle auto-exit
if (ipcGuardConfig.primaryIdleMs > 0) {
  const primaryIdleCheckTimer = setInterval(() => {
    if (Date.now() - primaryLastActivityAt > ipcGuardConfig.primaryIdleMs) {
      logger(
        `[main] Primary idle for ${Math.round((Date.now() - primaryLastActivityAt) / 1000)}s. Auto-exiting.`,
      );
      void shutdown('idle timeout');
    }
  }, 30_000);
  primaryIdleCheckTimer.unref();
} else {
  logger('[main] Primary idle auto-exit is disabled (CAI_PRIMARY_IDLE_MS=0).');
}

// ─── Graceful shutdown ───

let isShuttingDown = false;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    timer.unref();
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function shutdown(reason: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger(`Shutting down: ${reason}`);

  // Release lock early so a new instance can start immediately
  releaseLock();

  // Force exit timer (5 seconds) - prevents zombie if cleanup hangs
  const forceExitTimer = setTimeout(() => {
    logger('Graceful shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 5000);
  forceExitTimer.unref();

  // Cleanup relay connections with 3 second timeout
  try {
    await withTimeout(cleanupAllConnections(), 3000, 'cleanupAllConnections');
  } catch (error) {
    logger(
      `Cleanup error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Close log file
  if (logFile) {
    logFile.close();
  }

  clearTimeout(forceExitTimer);
  process.exit(0);
}

// Signal handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Keep beforeExit for edge cases
process.on('beforeExit', () => {
  releaseLock();
  if (logFile) {
    logFile.close();
  }
});
