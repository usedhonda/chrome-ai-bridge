/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Chrome AI Bridge - Extension-only Mode (v2.0.0)
 *
 * This MCP server provides ChatGPT/Gemini integration via Chrome extension.
 * Puppeteer has been removed - all browser interaction is via WebSocket relay.
 *
 * Multi-client: The first instance becomes Primary (stdio + IPC HTTP).
 * Subsequent instances become Proxies that forward stdio to the Primary via HTTP.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {
  isInitializeRequest,
  SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {parseArguments} from './cli.js';
import {logger, saveLogsToFile} from './logger.js';
import {McpResponse} from './McpResponse.js';
import {Mutex} from './Mutex.js';
import {ToolRegistry, PluginLoader} from './plugin-api.js';
import {
  registerOptionalTools,
  WEB_LLM_TOOLS_INFO,
} from './tools/optional-tools.js';
import type {ToolDefinition} from './tools/ToolDefinition.js';
import type {Context} from './tools/ToolDefinition.js';
import {getFastContext} from './fast-cdp/fast-context.js';
import {cleanupAllConnections} from './fast-cdp/fast-chat.js';
import {askAI} from './tools/ai-helpers.js';
import type {AIKind} from './tools/ai-helpers.js';
import {generateAgentId, setAgentId} from './fast-cdp/agent-context.js';
import {cleanupStaleSessions} from './fast-cdp/session-manager.js';
import {getIpcGuardConfig, getSessionConfig, IPC_CONFIG} from './config.js';
import {
  releaseLock,
  tryAcquireLockSafe,
  checkExistingPrimary,
  updateLockPort,
  terminatePrimaryProcess,
  getLockNamespace,
  cleanupOrphanBridgeProcesses,
} from './process-lock.js';
import {checkPrimaryHealth, startProxyMode} from './stdio-http-proxy.js';

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

logger(`Starting Chrome AI Bridge v${version} (Extension-only mode)`);
logger(`[main] Runtime lock namespace: ${getLockNamespace()}`);

// Initialize agent ID for Agent Teams support
const agentId = generateAgentId();
setAgentId(agentId);

// ─── Multi-client routing with retry ───
// Handles concurrent startup of many processes (e.g. tproj 16-pane scenario).
// Each process tries to become Primary or fall back to Proxy mode,
// with exponential backoff + jitter to avoid thundering herd.

const MAX_STARTUP_ATTEMPTS = 5;
const BASE_DELAY_MS = 300;
const HEALTH_CHECK_RETRIES = 3;
const HEALTH_CHECK_INTERVAL_MS = 500;
const PRIMARY_SELF_HEAL_MIN_AGE_MS = Number(
  process.env.CAI_PRIMARY_SELF_HEAL_MIN_AGE_MS || '20000',
);
const ipcGuardConfig = getIpcGuardConfig();

const instanceId = randomUUID();
let becamePrimary = false;
let attemptedPrimarySelfHeal = false;
let stdinClosed = false;
let getActiveIpcSessionCount = (): number => 0;

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
        (line.includes('build/src/main.js') || line.includes('scripts/cli.mjs')),
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
  const delayMs = Math.floor(Math.random() * ipcGuardConfig.startupDelayJitterMs);
  logger(
    `[main] High startup concurrency detected (${instanceCount} processes). Applying jitter=${delayMs}ms.`,
  );
  await new Promise(resolve => setTimeout(resolve, delayMs));
}

await applyStartupJitterIfNeeded();

for (let attempt = 0; attempt < MAX_STARTUP_ATTEMPTS; attempt++) {
  // 1. Try to become Primary (non-throwing)
  const lockAcquired = await tryAcquireLockSafe(IPC_CONFIG.port, instanceId);
  if (lockAcquired) {
    becamePrimary = true;
    break;
  }

  // 2. Lock held by another process — try to connect as Proxy
  const existingPrimary = checkExistingPrimary();
  if (existingPrimary && existingPrimary.port > 0) {
    for (let hc = 0; hc < HEALTH_CHECK_RETRIES; hc++) {
      const healthy = await checkPrimaryHealth(existingPrimary.port);
      if (healthy) {
        logger(`[main] Primary is healthy (port=${existingPrimary.port}). Entering proxy mode.`);
        await startProxyMode(existingPrimary.port); // never returns
      }
      if (hc < HEALTH_CHECK_RETRIES - 1) {
        const jitter = Math.random() * HEALTH_CHECK_INTERVAL_MS;
        await new Promise(r => setTimeout(r, HEALTH_CHECK_INTERVAL_MS + jitter));
      }
    }
    logger(`[main] Primary (port=${existingPrimary.port}) not healthy after ${HEALTH_CHECK_RETRIES} retries.`);

    const parsedStartedAt = existingPrimary.startedAt
      ? Date.parse(existingPrimary.startedAt)
      : NaN;
    const primaryAgeMs = Number.isFinite(parsedStartedAt)
      ? Math.max(0, Date.now() - parsedStartedAt)
      : null;

    if (
      !attemptedPrimarySelfHeal &&
      existingPrimary.pid > 0 &&
      (primaryAgeMs === null || primaryAgeMs >= PRIMARY_SELF_HEAL_MIN_AGE_MS)
    ) {
      attemptedPrimarySelfHeal = true;
      logger(
        `[main] Attempting self-heal for unhealthy primary pid=${existingPrimary.pid} ageMs=${
          primaryAgeMs ?? 'unknown'
        }.`,
      );
      const terminated = await terminatePrimaryProcess(existingPrimary.pid);
      if (terminated) {
        logger('[main] Self-heal terminated unhealthy primary. Retrying startup immediately.');
        continue;
      }
      logger('[main] Self-heal could not terminate unhealthy primary.');
    } else if (
      !attemptedPrimarySelfHeal &&
      primaryAgeMs !== null &&
      primaryAgeMs < PRIMARY_SELF_HEAL_MIN_AGE_MS
    ) {
      logger(
        `[main] Primary is unhealthy but still young (ageMs=${primaryAgeMs} < ${PRIMARY_SELF_HEAL_MIN_AGE_MS}). Skipping self-heal this round.`,
      );
    }
  }

  // 3. Neither Primary nor Proxy — backoff with jitter and retry
  if (attempt < MAX_STARTUP_ATTEMPTS - 1) {
    const backoff = BASE_DELAY_MS * Math.pow(2, attempt);
    const jitter = Math.random() * BASE_DELAY_MS;
    const delay = backoff + jitter;
    logger(`[main] Startup attempt ${attempt + 1}/${MAX_STARTUP_ATTEMPTS} failed. Retrying in ${Math.round(delay)}ms...`);
    await new Promise(r => setTimeout(r, delay));
  }
}

if (!becamePrimary) {
  // Final fallback: one last proxy attempt before giving up
  const existingPrimary = checkExistingPrimary();
  if (existingPrimary && existingPrimary.port > 0) {
    const healthy = await checkPrimaryHealth(existingPrimary.port);
    if (healthy) {
      logger(`[main] Final fallback: entering proxy mode (port=${existingPrimary.port}).`);
      await startProxyMode(existingPrimary.port); // never returns
    }
  }
  logger('[main] Failed to start as Primary or Proxy after all retries. Exiting.');
  process.exit(1);
}

// ─── Primary mode ───

// Idle auto-exit tracking for Primary process
let primaryLastActivityAt = Date.now();
const touchPrimaryActivity = (): void => {
  primaryLastActivityAt = Date.now();
};

// Start session cleanup timer
const sessionConfig = getSessionConfig();
const cleanupTimer = setInterval(async () => {
  try {
    const removed = await cleanupStaleSessions();
    if (removed > 0) {
      logger(`[session] Cleaned up ${removed} stale sessions`);
    }
  } catch (error) {
    logger(`[session] Cleanup error: ${error instanceof Error ? error.message : String(error)}`);
  }
}, sessionConfig.cleanupIntervalMinutes * 60 * 1000);
cleanupTimer.unref();  // Don't keep process alive for cleanup

const server = new McpServer(
  {
    name: 'chrome-ai-bridge',
    title: 'Chrome AI Bridge - ChatGPT/Gemini via Extension',
    version,
  },
  {capabilities: {logging: {}}},
);

server.server.setRequestHandler(SetLevelRequestSchema, () => {
  return {};
});

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
      logger(`[main] Tool-triggered orphan cleanup removed ${cleaned} process(es).`);
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

function registerTool(tool: ToolDefinition): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.schema,
      annotations: tool.annotations,
    },
    async (params): Promise<CallToolResult> => {
      touchPrimaryActivity();
      await maybeRunToolSelfCleanup();
      const guard = await toolMutex.acquire();
      try {
        logger(`${tool.name} request: ${JSON.stringify(params, null, '  ')}`);
        // All tools use FastContext (extension-based, no Puppeteer)
        const context = getFastContext() as unknown as Context;
        const response = new McpResponse();
        await tool.handler(
          {
            params,
          },
          response,
          context,
        );
        try {
          const content = await response.handle(tool.name, context);
          return {
            content,
          };
        } catch (error) {
          const errorText =
            error instanceof Error ? error.message : String(error);

          // Detect extension connection error
          if (
            errorText.includes('Extension connection') ||
            errorText.includes('timeout') ||
            errorText.includes('disconnected')
          ) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Extension connection lost or not available.\n\nMake sure:\n1. Chrome is running\n2. The chrome-ai-bridge extension is installed\n3. The extension is enabled\n\nError: ${errorText}`,
                },
              ],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: errorText,
              },
            ],
            isError: true,
          };
        }
      } finally {
        guard.dispose();
      }
    },
  );
}

// Use ToolRegistry for plugin architecture
const toolRegistry = new ToolRegistry();

// Register optional tools (ChatGPT/Gemini via extension)
// Note: Core tools (Puppeteer-based) are no longer available in v2.0
const optionalCount = registerOptionalTools(toolRegistry);
if (optionalCount > 0) {
  logger(`[tools] ${WEB_LLM_TOOLS_INFO.disclaimer}`);
}

// Load external plugins from MCP_PLUGINS environment variable
const pluginList = process.env.MCP_PLUGINS;
if (pluginList) {
  const pluginLoader = new PluginLoader(toolRegistry, logger);
  const {loaded, failed} = await pluginLoader.loadFromList(pluginList);
  if (loaded.length > 0) {
    logger(`[plugins] Successfully loaded: ${loaded.join(', ')}`);
  }
  if (failed.length > 0) {
    logger(`[plugins] Failed to load: ${failed.join(', ')}`);
  }
}

// Register all tools with MCP server
for (const tool of toolRegistry.getAll()) {
  registerTool(tool as unknown as ToolDefinition);
}
logger(`[tools] Total registered: ${toolRegistry.size} tools`);

if (args.daemon) {
  logger('Chrome AI Bridge starting in daemon mode (HTTP-only, no stdio MCP)');
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger('Chrome AI Bridge MCP Server connected');
}
logDisclaimers();

// ─── IPC HTTP server (for proxy clients) ───
{
  const ipcTransports: Record<string, StreamableHTTPServerTransport> = {};
  const ipcSessionLastActivity = new Map<string, number>();
  const initQueue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];
  let initializingCount = 0;

  const getActiveSessionCount = (): number =>
    Object.keys(ipcTransports).length;
  getActiveIpcSessionCount = getActiveSessionCount;

  const getSessionLoad = (): number =>
    getActiveSessionCount() + initializingCount;

  const touchIpcSession = (sessionId: string): void => {
    ipcSessionLastActivity.set(sessionId, Date.now());
  };

  const cleanupIpcSession = (sessionId: string): void => {
    if (ipcTransports[sessionId]) {
      delete ipcTransports[sessionId];
    }
    ipcSessionLastActivity.delete(sessionId);
    drainInitQueue();
    maybeShutdownAfterStdinClose('ipc session cleanup');
  };

  function sendJsonRpcError(
    res: http.ServerResponse,
    code: number,
    message: string,
    id: string | number | null = null,
    statusCode = 400,
  ): void {
    res.writeHead(statusCode).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {code, message},
        id,
      }),
    );
  }

  function drainInitQueue(): void {
    while (initQueue.length > 0 && getSessionLoad() < ipcGuardConfig.maxSessions) {
      const waiter = initQueue.shift();
      if (!waiter) break;
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  }

  async function waitForInitCapacity(): Promise<void> {
    if (getSessionLoad() < ipcGuardConfig.maxSessions) {
      return;
    }
    const initWaiterLimit = Math.max(
      0,
      Math.min(ipcGuardConfig.reservedInitSlots, ipcGuardConfig.maxQueue),
    );
    if (initQueue.length >= initWaiterLimit) {
      throw new Error('SERVER_CAPACITY_EXCEEDED');
    }
    if (initQueue.length >= ipcGuardConfig.maxQueue) {
      throw new Error('SERVER_QUEUE_FULL');
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = initQueue.findIndex(item => item.resolve === resolve);
        if (index >= 0) {
          initQueue.splice(index, 1);
        }
        reject(new Error('SERVER_BUSY_TIMEOUT'));
      }, ipcGuardConfig.queueWaitTimeoutMs);
      timeout.unref();
      initQueue.push({resolve, reject, timeout});
    });
  }

  if (ipcGuardConfig.sessionIdleMs > 0) {
    const idleCleanupTimer = setInterval(async () => {
      const now = Date.now();
      const staleSessionIds = Array.from(ipcSessionLastActivity.entries())
        .filter(([, lastActivity]) => now - lastActivity > ipcGuardConfig.sessionIdleMs)
        .map(([sessionId]) => sessionId);
      if (staleSessionIds.length === 0) {
        return;
      }
      logger(
        `[ipc] Closing ${staleSessionIds.length} idle session(s) older than ${ipcGuardConfig.sessionIdleMs}ms.`,
      );
      for (const staleSessionId of staleSessionIds) {
        try {
          await ipcTransports[staleSessionId]?.close();
        } catch {
          // Ignore transport close errors and continue cleanup.
        }
        cleanupIpcSession(staleSessionId);
      }
    }, Math.max(10_000, Math.min(60_000, Math.floor(ipcGuardConfig.sessionIdleMs / 2))));
    idleCleanupTimer.unref();
  } else {
    logger('[ipc] Idle session cleanup is disabled (CAI_IPC_SESSION_IDLE_MS=0).');
  }

  const ipcServer = http.createServer(async (req, res) => {
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
          activeSessions: getActiveSessionCount(),
          queuedInitializations: initQueue.length,
          sessionCapacity: ipcGuardConfig.maxSessions,
          reservedInitSlots: ipcGuardConfig.reservedInitSlots,
          execMaxConcurrency: ipcGuardConfig.execMaxConcurrency,
        }),
      );
      return;
    }

    // REST API endpoint — bypass MCP protocol, call askAI() directly
    if (url.pathname === '/api/ask' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer | string) => {
        body += chunk;
      });
      req.on('end', async () => {
        touchPrimaryActivity();
        let parsed: {target?: string; question?: string; debug?: boolean; budgetMs?: number};
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          res.writeHead(400, {'Content-Type': 'application/json'}).end(
            JSON.stringify({success: false, error: 'Invalid JSON'}),
          );
          return;
        }

        const {target, question, debug: debugFlag, budgetMs: requestBudgetMs} = parsed;
        const effectiveBudgetMs = requestBudgetMs ?? 120000;  // REST API default: 120s
        if (!target || !question) {
          res.writeHead(400, {'Content-Type': 'application/json'}).end(
            JSON.stringify({success: false, error: 'Missing required fields: target, question'}),
          );
          return;
        }

        const validTargets = ['chatgpt', 'gemini', 'both'];
        if (!validTargets.includes(target)) {
          res.writeHead(400, {'Content-Type': 'application/json'}).end(
            JSON.stringify({success: false, error: `Invalid target: ${target}. Must be one of: ${validTargets.join(', ')}`}),
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
              JSON.stringify({success: true, results: [chatgptResult, geminiResult]}),
            );
          } else {
            const result = await askAI(target as AIKind, question, debugFlag, effectiveBudgetMs);
            res.writeHead(200, {'Content-Type': 'application/json'}).end(
              JSON.stringify({success: result.success, results: [result]}),
            );
          }
        } catch (error) {
          const errorText = error instanceof Error ? error.message : String(error);
          if (!res.headersSent) {
            res.writeHead(500, {'Content-Type': 'application/json'}).end(
              JSON.stringify({success: false, error: errorText}),
            );
          }
        } finally {
          guard.dispose();
        }
      });
      return;
    }

    // MCP endpoint
    if (url.pathname !== IPC_CONFIG.mcpPath) {
      res.writeHead(404).end();
      return;
    }

    // CORS for local usage
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,mcp-session-id');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', async () => {
        let json: any;
        try {
          json = body ? JSON.parse(body) : null;
        } catch {
          sendJsonRpcError(res, -32700, 'Parse error');
          return;
        }

        let ipcTransport: StreamableHTTPServerTransport | undefined;
        touchPrimaryActivity();
        if (sessionId && ipcTransports[sessionId]) {
          ipcTransport = ipcTransports[sessionId];
          touchIpcSession(sessionId);
        } else if (!sessionId && isInitializeRequest(json)) {
          try {
            await waitForInitCapacity();
          } catch (error) {
            const message =
              error instanceof Error ? error.message : 'SERVER_BUSY_TIMEOUT';
            if (message === 'SERVER_CAPACITY_EXCEEDED') {
              sendJsonRpcError(res, -32003, message, null, 503);
            } else if (message === 'SERVER_QUEUE_FULL') {
              sendJsonRpcError(res, -32002, message, null, 503);
            } else {
              sendJsonRpcError(res, -32001, message, null, 503);
            }
            return;
          }

          initializingCount++;
          try {
            ipcTransport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: newSessionId => {
                ipcTransports[newSessionId] = ipcTransport!;
                touchIpcSession(newSessionId);
              },
              onsessionclosed: closedSessionId => {
                cleanupIpcSession(closedSessionId);
              },
            });
            ipcTransport.onclose = () => {
              if (ipcTransport?.sessionId) {
                cleanupIpcSession(ipcTransport.sessionId);
              }
            };
            await server.connect(ipcTransport);
          } finally {
            initializingCount = Math.max(0, initializingCount - 1);
            drainInitQueue();
          }
        } else {
          sendJsonRpcError(
            res,
            -32000,
            'Bad Request: No valid session ID provided',
          );
          return;
        }

        try {
          await ipcTransport.handleRequest(req, res, json);
        } catch (error) {
          if (!res.headersSent) {
            res.writeHead(500).end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: {
                  code: -32603,
                  message:
                    error instanceof Error
                      ? error.message
                      : String(error),
                },
                id: null,
              }),
            );
          }
        }
      });
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!sessionId || !ipcTransports[sessionId]) {
        res.writeHead(400).end('Invalid or missing session ID');
        return;
      }
      touchPrimaryActivity();
      touchIpcSession(sessionId);
      try {
        await ipcTransports[sessionId].handleRequest(req, res);
        if (req.method === 'DELETE') {
          cleanupIpcSession(sessionId);
        }
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(500).end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32603,
                message:
                  error instanceof Error ? error.message : String(error),
              },
              id: null,
            }),
          );
        }
      }
      return;
    }

    res.writeHead(405).end();
  });

  function onListening(): void {
    const addr = ipcServer.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : IPC_CONFIG.port;
    if (actualPort !== IPC_CONFIG.port) {
      logger(`[ipc] Configured port ${IPC_CONFIG.port} was unavailable. Using dynamic port ${actualPort}.`);
      updateLockPort(actualPort);
    }
    logger(`[ipc] IPC HTTP listening on http://${IPC_CONFIG.host}:${actualPort} (health: ${IPC_CONFIG.healthPath}, mcp: ${IPC_CONFIG.mcpPath})`);
  }

  ipcServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger(`[ipc] Port ${IPC_CONFIG.port} in use. Retrying with dynamic port...`);
      ipcServer.listen(0, IPC_CONFIG.host, onListening);
    } else {
      logger(`[ipc] IPC server error: ${err.message}`);
    }
  });

  ipcServer.listen(IPC_CONFIG.port, IPC_CONFIG.host, onListening);

  // Primary idle auto-exit: exit when no activity and no active IPC sessions
  if (ipcGuardConfig.primaryIdleMs > 0) {
    const primaryIdleCheckTimer = setInterval(() => {
      const activeSessionCount = getActiveSessionCount();
      if (
        Date.now() - primaryLastActivityAt > ipcGuardConfig.primaryIdleMs &&
        activeSessionCount === 0
      ) {
        logger(
          `[main] Primary idle for ${Math.round((Date.now() - primaryLastActivityAt) / 1000)}s with 0 active sessions. Auto-exiting.`,
        );
        shutdown('idle timeout');
      }
    }, 30_000);
    primaryIdleCheckTimer.unref();
  } else {
    logger('[main] Primary idle auto-exit is disabled (CAI_PRIMARY_IDLE_MS=0).');
  }
}

// Graceful shutdown handler with timeout
// Based on review: タイムアウト必須、強制終了タイマー必要
let isShuttingDown = false;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    // unref() prevents this timer from keeping the process alive
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
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
    logger(`Cleanup error: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Close log file
  if (logFile) {
    logFile.close();
  }

  clearTimeout(forceExitTimer);
  process.exit(0);
}

function maybeShutdownAfterStdinClose(trigger: string): void {
  if (!stdinClosed || isShuttingDown) {
    return;
  }
  const activeSessionCount = getActiveIpcSessionCount();
  if (activeSessionCount > 0) {
    return;
  }
  logger(
    `[main] ${trigger}: stdin already closed and all IPC sessions drained. Shutting down.`,
  );
  void shutdown('stdin closed (all IPC sessions drained)');
}

function handleStdinClosed(reason: string): void {
  stdinClosed = true;
  if (isShuttingDown) {
    return;
  }
  const activeSessionCount = getActiveIpcSessionCount();
  if (activeSessionCount > 0) {
    logger(
      `[main] ${reason}: deferring shutdown while ${activeSessionCount} IPC session(s) remain.`,
    );
    return;
  }
  void shutdown(reason);
}

// stdin close = Claude Code disconnected (most reliable on Windows too)
// In daemon mode, stdin is not connected — ignore close events
if (!args.daemon) {
  process.stdin.on('end', () => handleStdinClosed('stdin ended'));
  process.stdin.on('close', () => handleStdinClosed('stdin closed'));
}

// Signal handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Keep beforeExit for edge cases where stdin doesn't close
process.on('beforeExit', () => {
  releaseLock();
  if (logFile) {
    logFile.close();
  }
});

// ─── Optional: User-configured external HTTP server (MCP_HTTP_PORT) ───
const httpPortRaw = process.env.MCP_HTTP_PORT;
if (httpPortRaw) {
  const httpPort = Number(httpPortRaw);
  if (!Number.isFinite(httpPort) || httpPort <= 0) {
    console.error(`[http] Invalid MCP_HTTP_PORT: ${httpPortRaw}`);
  } else {
    const httpHost = process.env.MCP_HTTP_HOST || '127.0.0.1';
    const transports: Record<string, StreamableHTTPServerTransport> = {};

    const serverHttp = http.createServer(async (req, res) => {
      if (!req.url || !req.method) {
        res.writeHead(400).end();
        return;
      }

      // Basic CORS for local usage (Codex / local tools)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type,mcp-session-id');
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }

      const url = new URL(req.url, `http://${httpHost}:${httpPort}`);
      if (url.pathname !== '/mcp') {
        res.writeHead(404).end();
        return;
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
          body += chunk;
        });
        req.on('end', async () => {
          let json: any;
          try {
            json = body ? JSON.parse(body) : null;
          } catch {
            res.writeHead(400).end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: {code: -32700, message: 'Parse error'},
                id: null,
              }),
            );
            return;
          }

          let transport: StreamableHTTPServerTransport | undefined;
          if (sessionId && transports[sessionId]) {
            transport = transports[sessionId];
          } else if (!sessionId && isInitializeRequest(json)) {
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: newSessionId => {
                transports[newSessionId] = transport!;
              },
            });
            transport.onclose = () => {
              if (transport?.sessionId) {
                delete transports[transport.sessionId];
              }
            };
            await server.connect(transport);
          } else {
            res.writeHead(400).end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: {
                  code: -32000,
                  message: 'Bad Request: No valid session ID provided',
                },
                id: null,
              }),
            );
            return;
          }

          try {
            await transport.handleRequest(req, res, json);
          } catch (error) {
            if (!res.headersSent) {
              res.writeHead(500).end(
                JSON.stringify({
                  jsonrpc: '2.0',
                  error: {
                    code: -32603,
                    message:
                      error instanceof Error
                        ? error.message
                        : String(error),
                  },
                  id: null,
                }),
              );
            }
          }
        });
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        if (!sessionId || !transports[sessionId]) {
          res.writeHead(400).end('Invalid or missing session ID');
          return;
        }
        try {
          await transports[sessionId].handleRequest(req, res);
        } catch (error) {
          if (!res.headersSent) {
            res.writeHead(500).end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: {
                  code: -32603,
                  message:
                    error instanceof Error ? error.message : String(error),
                },
                id: null,
              }),
            );
          }
        }
        return;
      }

      res.writeHead(405).end();
    });

    serverHttp.listen(httpPort, httpHost, () => {
      console.error(`[http] MCP Streamable HTTP listening on http://${httpHost}:${httpPort}/mcp`);
    });
  }
}
