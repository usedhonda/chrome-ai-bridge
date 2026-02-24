/**
 * Process lock management using exclusive file lock.
 *
 * Lock file stores JSON: {pid, port, startedAt}
 * Multi-client mode: alive processes are NOT killed — Secondary
 * instances connect to the Primary via HTTP proxy instead.
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {logger} from './logger.js';
import {getRuntimeNamespace} from './runtime-scope.js';

const RUNTIME_NAMESPACE = getRuntimeNamespace();
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const LOCK_DIR = path.join(
  os.homedir(),
  '.cache',
  'chrome-ai-bridge',
  RUNTIME_NAMESPACE,
);
const LOCK_FILE = path.join(LOCK_DIR, 'mcp.lock');

let lockFd: number | null = null;

export interface LockInfo {
  pid: number;
  port: number;
  startedAt: string; // ISO 8601
  instanceId: string; // UUID to detect PID reuse
}

export interface PrimaryStatus {
  pid: number;
  alive: boolean;
  port: number;
  instanceId: string;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface ProcessTreeRow {
  pid: number;
  ppid: number;
}

function collectDescendants(
  rows: ProcessTreeRow[],
  rootPid: number,
): Set<number> {
  const descendants = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current !== 'number') {
      continue;
    }
    for (const row of rows) {
      if (row.ppid === current && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        stack.push(row.pid);
      }
    }
  }
  return descendants;
}

/**
 * Read lock file content. Supports both JSON (new) and plain PID (legacy).
 */
export function readLockInfo(): LockInfo | null {
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
    if (!content) return null;

    // Try JSON format first
    if (content.startsWith('{')) {
      const parsed = JSON.parse(content) as Partial<LockInfo>;
      if (parsed.pid && parsed.pid > 0) {
        return {
          pid: parsed.pid,
          port: parsed.port ?? 0,
          startedAt: parsed.startedAt ?? '',
          instanceId: parsed.instanceId ?? '',
        };
      }
      return null;
    }

    // Legacy: plain PID number
    const pid = Number(content);
    if (Number.isFinite(pid) && pid > 0) {
      return {pid, port: 0, startedAt: '', instanceId: ''};
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if an existing Primary is alive and reachable.
 * Reads the lock file and checks process liveness.
 */
export function checkExistingPrimary(): PrimaryStatus | null {
  const info = readLockInfo();
  if (!info) return null;

  if (!isProcessAlive(info.pid)) {
    logger(`[process-lock] Stale lock (pid=${info.pid}, not running).`);
    return null;
  }

  return {
    pid: info.pid,
    alive: true,
    port: info.port,
    instanceId: info.instanceId,
    startedAt: info.startedAt,
  };
}

/**
 * Try to create lock file exclusively (wx flag).
 * Writes JSON {pid, port, startedAt}.
 * Returns the file descriptor on success, null on EEXIST.
 */
function tryCreateLock(port: number, instanceId: string): number | null {
  try {
    fs.mkdirSync(LOCK_DIR, {recursive: true});
    const fd = fs.openSync(LOCK_FILE, 'wx');
    const lockInfo: LockInfo = {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString(),
      instanceId,
    };
    fs.writeSync(fd, JSON.stringify(lockInfo));
    return fd;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      return null;
    }
    throw error;
  }
}

/**
 * Handle an existing lock file.
 * In multi-client mode, alive processes are NOT killed.
 * Only stale (dead process) locks are removed.
 * Returns true if the stale lock was removed and retry is possible.
 * Returns false if the lock holder is alive (should enter proxy mode).
 */
async function handleExistingLock(): Promise<boolean> {
  const info = readLockInfo();

  if (info === null) {
    logger('[process-lock] Corrupted lock file found. Removing.');
    try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
    return true;
  }

  // Don't conflict with ourselves
  if (info.pid === process.pid) {
    try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
    return true;
  }

  if (!isProcessAlive(info.pid)) {
    logger(`[process-lock] Stale lock (pid=${info.pid}, not running). Removing.`);
    try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
    return true;
  }

  // Process is alive — do NOT kill. Caller should enter proxy mode.
  logger(`[process-lock] Primary is alive (pid=${info.pid}, port=${info.port}). Cannot acquire lock.`);
  return false;
}

/**
 * Try to acquire lock without throwing on failure.
 * Returns true if lock acquired, false if another process holds it.
 * Used by the retry-based startup loop in main.ts.
 */
export async function tryAcquireLockSafe(port: number, instanceId: string): Promise<boolean> {
  const fd = tryCreateLock(port, instanceId);
  if (fd !== null) {
    lockFd = fd;
    logger(`[process-lock] Lock acquired (pid=${process.pid}, port=${port}, instanceId=${instanceId.slice(0, 8)})`);
    return true;
  }

  const canRetry = await handleExistingLock();
  if (!canRetry) {
    return false;
  }

  const fd2 = tryCreateLock(port, instanceId);
  if (fd2 !== null) {
    lockFd = fd2;
    logger(`[process-lock] Lock acquired after cleanup (pid=${process.pid}, port=${port})`);
    return true;
  }

  return false;
}

/**
 * Acquire an exclusive process lock. Call once at startup for Primary mode.
 *
 * Flow:
 * 1. Try fs.openSync(LOCK_FILE, 'wx') for atomic exclusive creation
 * 2. Success -> write JSON {pid, port, startedAt}, hold FD
 * 3. EEXIST -> check holder; remove only if stale, retry once
 * 4. If holder is alive -> throw (caller should enter proxy mode)
 */
export async function acquireLock(port: number, instanceId: string): Promise<void> {
  const fd = tryCreateLock(port, instanceId);
  if (fd !== null) {
    lockFd = fd;
    logger(`[process-lock] Lock acquired (pid=${process.pid}, port=${port}, instanceId=${instanceId.slice(0, 8)})`);
    return;
  }

  // Lock file exists - handle the existing holder
  const canRetry = await handleExistingLock();
  if (!canRetry) {
    throw new Error('[process-lock] Primary is alive. Use proxy mode.');
  }

  // Retry once after stale removal
  const fd2 = tryCreateLock(port, instanceId);
  if (fd2 !== null) {
    lockFd = fd2;
    logger(`[process-lock] Lock acquired after cleanup (pid=${process.pid}, port=${port})`);
    return;
  }

  throw new Error('[process-lock] Failed to acquire lock after retry');
}

/**
 * Update the port in an existing lock file (e.g. after dynamic port fallback).
 * Rewrites the lock file content while keeping the FD open.
 */
export function updateLockPort(newPort: number): void {
  if (lockFd === null) {
    logger('[process-lock] Cannot update port: no lock held.');
    return;
  }
  const info = readLockInfo();
  if (!info) {
    logger('[process-lock] Cannot update port: lock file unreadable.');
    return;
  }
  info.port = newPort;
  // Truncate and rewrite
  fs.ftruncateSync(lockFd);
  const buf = Buffer.from(JSON.stringify(info));
  fs.writeSync(lockFd, buf, 0, buf.length, 0);
  logger(`[process-lock] Lock port updated to ${newPort}`);
}

/**
 * Release the process lock. Call during shutdown.
 */
export function releaseLock(): void {
  if (lockFd !== null) {
    try { fs.closeSync(lockFd); } catch { /* ignore */ }
    lockFd = null;
  }
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
  logger('[process-lock] Lock released.');
}

/**
 * Best-effort termination of a potentially unhealthy primary.
 * Returns true if the process no longer exists after termination attempts.
 */
export async function terminatePrimaryProcess(pid: number): Promise<boolean> {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (!isProcessAlive(pid)) return true;

  logger(`[process-lock] Attempting self-heal termination for pid=${pid} (SIGTERM).`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process may already be gone.
  }

  await sleep(1500);
  if (!isProcessAlive(pid)) {
    logger(`[process-lock] Self-heal termination succeeded for pid=${pid} after SIGTERM.`);
    return true;
  }

  logger(`[process-lock] pid=${pid} still alive after SIGTERM. Sending SIGKILL.`);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // ignore
  }

  await sleep(300);
  const dead = !isProcessAlive(pid);
  logger(
    dead
      ? `[process-lock] Self-heal termination succeeded for pid=${pid} after SIGKILL.`
      : `[process-lock] Self-heal termination failed for pid=${pid}.`,
  );
  return dead;
}

export function getLockNamespace(): string {
  return RUNTIME_NAMESPACE;
}

export function getLockFilePath(): string {
  return LOCK_FILE;
}

interface ProcessRow extends ProcessTreeRow {
  command: string;
}

function listProcessRows(): ProcessRow[] {
  try {
    const output = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return output
      .trim()
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!match) return null;
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          command: match[3],
        };
      })
      .filter((row): row is ProcessRow =>
        !!row && Number.isFinite(row.pid) && Number.isFinite(row.ppid),
      );
  } catch {
    return [];
  }
}

/**
 * Best-effort stale process sweep for this project path.
 *
 * Targets only orphaned bridge processes (ppid=1) for the same project root.
 * The current process and lock-primary family are preserved.
 *
 * Returns number of terminated orphan processes.
 */
export async function cleanupOrphanBridgeProcesses(
  projectRootHint: string = PROJECT_ROOT,
): Promise<number> {
  const rows = listProcessRows();
  if (rows.length === 0) return 0;

  const normalizedRoot = path.resolve(projectRootHint);
  const bridgeRows = rows.filter(
    row =>
      row.command.includes(normalizedRoot) &&
      (row.command.includes('/build/src/main.js') ||
        row.command.includes('/scripts/cli.mjs')),
  );
  if (bridgeRows.length === 0) return 0;

  const protectedPids = new Set<number>([process.pid, process.ppid]);
  const lockInfo = readLockInfo();
  if (lockInfo?.pid && isProcessAlive(lockInfo.pid)) {
    protectedPids.add(lockInfo.pid);
    for (const pid of collectDescendants(rows, lockInfo.pid)) {
      protectedPids.add(pid);
    }
  } else if (lockInfo?.pid && !isProcessAlive(lockInfo.pid)) {
    try {
      fs.unlinkSync(LOCK_FILE);
      logger(
        `[process-lock] Removed stale lock during orphan sweep (pid=${lockInfo.pid}).`,
      );
    } catch {
      // ignore lock unlink failures
    }
  }

  const targets = bridgeRows
    .filter(row => row.ppid === 1)
    .map(row => row.pid)
    .filter(pid => !protectedPids.has(pid));
  if (targets.length === 0) return 0;

  const dedupedTargets = Array.from(new Set(targets));
  logger(
    `[process-lock] Cleaning orphan bridge process(es): ${dedupedTargets.join(', ')}`,
  );

  for (const pid of dedupedTargets) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  await sleep(500);

  for (const pid of dedupedTargets) {
    if (!isProcessAlive(pid)) {
      continue;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }

  return dedupedTargets.length;
}

/**
 * Kill all sibling chrome-ai-bridge processes (bulk cleanup).
 *
 * Uses pgrep to find processes matching 'chrome-ai-bridge/build/src/main.js',
 * excludes self and parent, then SIGTERM -> wait -> SIGKILL survivors.
 *
 * Returns the number of processes killed.
 * On pgrep failure (e.g. not installed), returns 0 silently.
 */
export async function killSiblings(): Promise<number> {
  let pids: number[];
  try {
    const output = execFileSync('pgrep', ['-f', 'chrome-ai-bridge/build/src/main.js'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    pids = output.trim().split('\n')
      .map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n) && n > 0);
  } catch {
    // pgrep returns exit code 1 when no matches, or not available
    return 0;
  }

  // Exclude self and parent (cli.mjs wrapper)
  const selfPid = process.pid;
  const parentPid = process.ppid;
  const targets = pids.filter(pid => pid !== selfPid && pid !== parentPid);

  if (targets.length === 0) {
    return 0;
  }

  logger(`[process-lock] Found ${targets.length} stale sibling(s): ${targets.join(', ')}`);

  // Send SIGTERM to all
  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process already gone
    }
  }

  // Wait for graceful shutdown
  await sleep(2000);

  // SIGKILL survivors
  let killed = 0;
  for (const pid of targets) {
    if (isProcessAlive(pid)) {
      logger(`[process-lock] Process ${pid} still alive after SIGTERM. Sending SIGKILL...`);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
    killed++;
  }

  return killed;
}
