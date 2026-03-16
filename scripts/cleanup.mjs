#!/usr/bin/env node
/**
 * Cleanup of stale chrome-ai-bridge MCP server processes.
 *
 * Default behavior is namespace-scoped to avoid cross-project disruption.
 * Use --all for global cleanup.
 *
 * Usage:
 *   npm run cleanup
 *   npm run cleanup -- --all
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT_LOCK_DIR = path.join(os.homedir(), '.cache', 'chrome-ai-bridge');
const LEGACY_LOCK_FILE = path.join(ROOT_LOCK_DIR, 'mcp.lock');
const GLOBAL_MODE = process.argv.includes('--all');

function getCurrentNamespace() {
  const envNamespace = String(process.env.CAI_NAMESPACE || '').trim();
  if (envNamespace) {
    return envNamespace.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  }

  const envScope = String(process.env.CAI_SCOPE_PATH || '').trim();
  if (envScope) {
    return hashScopePath(path.resolve(envScope));
  }

  const scopePath = detectScopePath();
  return hashScopePath(scopePath);
}

function detectScopePath() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim();
  } catch {
    return path.resolve(process.cwd());
  }
}

function hashScopePath(scopePath) {
  const hash = crypto
    .createHash('sha1')
    .update(scopePath)
    .digest('hex')
    .slice(0, 12);
  return `scope-${hash}`;
}

function readLockPid(lockFile) {
  try {
    const raw = fs.readFileSync(lockFile, 'utf8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw);
      if (Number.isFinite(parsed?.pid) && parsed.pid > 0) return parsed.pid;
      return null;
    }
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function listChildren(parentPid) {
  try {
    const output = execFileSync('ps', ['-ax', '-o', 'pid=,ppid='], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const rows = output
      .trim()
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [pidText, ppidText] = line.split(/\s+/);
        return {pid: Number(pidText), ppid: Number(ppidText)};
      })
      .filter(row => Number.isFinite(row.pid) && Number.isFinite(row.ppid));

    const descendants = new Set();
    const stack = [parentPid];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const row of rows) {
        if (row.ppid === current && !descendants.has(row.pid)) {
          descendants.add(row.pid);
          stack.push(row.pid);
        }
      }
    }
    return Array.from(descendants);
  } catch {
    return [];
  }
}

function collectAllLockFiles() {
  const files = [];
  if (fs.existsSync(LEGACY_LOCK_FILE)) {
    files.push(LEGACY_LOCK_FILE);
  }
  if (!fs.existsSync(ROOT_LOCK_DIR)) {
    return files;
  }
  for (const entry of fs.readdirSync(ROOT_LOCK_DIR, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const lockFile = path.join(ROOT_LOCK_DIR, entry.name, 'mcp.lock');
    if (fs.existsSync(lockFile)) {
      files.push(lockFile);
    }
  }
  return files;
}

function findProcesses(pattern) {
  try {
    const output = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        if (!m) return null;
        return {
          pid: Number(m[1]),
          cmd: m[2],
        };
      })
      .filter(Boolean)
      .filter(p => p.cmd.includes(pattern))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log(
    `[cleanup] Mode: ${GLOBAL_MODE ? 'global (--all)' : 'namespace-scoped'}\n`,
  );

  let targets = [];
  if (GLOBAL_MODE) {
    const allProcs = findProcesses('chrome-ai-bridge');
    targets = allProcs
      .filter(
        p =>
          p.cmd.includes('/chrome-ai-bridge/build/src/main.js') ||
          p.cmd.includes('/chrome-ai-bridge/scripts/cli.mjs'),
      )
      .map(p => p.pid)
      .filter(pid => pid !== process.pid);
    console.log(`[cleanup] Global target count: ${targets.length}`);
  } else {
    const namespace = getCurrentNamespace();
    const lockFile = path.join(ROOT_LOCK_DIR, namespace, 'mcp.lock');
    const primaryPid = readLockPid(lockFile);
    if (!primaryPid) {
      console.log(`[cleanup] No lock found for namespace=${namespace}.`);
      removeLock(lockFile);
      return;
    }
    targets = [primaryPid, ...listChildren(primaryPid)].filter(
      pid => pid !== process.pid,
    );
    console.log(
      `[cleanup] Namespace=${namespace} primary=${primaryPid} descendants=${Math.max(0, targets.length - 1)}`,
    );
  }

  if (targets.length === 0) {
    console.log('[cleanup] No target processes to kill.');
    if (GLOBAL_MODE) {
      for (const lockFile of collectAllLockFiles()) {
        removeLock(lockFile);
      }
    } else {
      const namespace = getCurrentNamespace();
      const lockFile = path.join(ROOT_LOCK_DIR, namespace, 'mcp.lock');
      removeLock(lockFile);
    }
    return;
  }

  const dedupedTargets = [...new Set(targets)];
  console.log(
    `[cleanup] Sending SIGTERM to ${dedupedTargets.length} process(es): ${dedupedTargets.join(', ')}`,
  );
  for (const pid of dedupedTargets) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }

  await sleep(2000);

  // SIGKILL survivors
  let killedCount = 0;
  for (const pid of dedupedTargets) {
    if (isAlive(pid)) {
      console.log(`[cleanup] PID ${pid} still alive. Sending SIGKILL...`);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
    killedCount++;
  }

  if (GLOBAL_MODE) {
    for (const lockFile of collectAllLockFiles()) {
      removeLock(lockFile);
    }
  } else {
    const namespace = getCurrentNamespace();
    const lockFile = path.join(ROOT_LOCK_DIR, namespace, 'mcp.lock');
    removeLock(lockFile);
  }

  console.log(`\n[cleanup] Done. Terminated ${killedCount} process(es).`);
}

function removeLock(lockFile) {
  if (!lockFile) return;
  try {
    fs.unlinkSync(lockFile);
    console.log(`[cleanup] Removed lock file: ${lockFile}`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.log(
        `[cleanup] Could not remove lock file (${lockFile}): ${err.message}`,
      );
    }
  }
}

main().catch(err => {
  console.error(`[cleanup] Error: ${err.message}`);
  process.exit(1);
});
