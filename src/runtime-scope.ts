/**
 * Runtime scope utilities.
 *
 * By default, scope is derived from the current git root (or cwd fallback),
 * then hashed into a stable namespace.
 * This isolates lock files between different projects using the same MCP.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import {execFileSync} from 'node:child_process';

function detectScopePath(): string {
  const envScope = String(process.env.CAI_SCOPE_PATH || '').trim();
  if (envScope) {
    return path.resolve(envScope);
  }

  try {
    const gitRoot = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1500,
      },
    ).trim();
    if (gitRoot) {
      return path.resolve(gitRoot);
    }
  } catch {
    // Not a git repo or git unavailable; fall back to cwd.
  }

  return path.resolve(process.cwd());
}

function normalizeNamespace(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const normalized = trimmed.replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-');
  return normalized.replace(/^-+|-+$/g, '');
}

export function getRuntimeNamespace(): string {
  const envNamespace = String(process.env.CAI_NAMESPACE || '').trim();
  if (envNamespace) {
    const explicit = normalizeNamespace(envNamespace);
    if (explicit) {
      return explicit;
    }
  }

  const scopePath = detectScopePath();
  const hash = crypto
    .createHash('sha1')
    .update(scopePath)
    .digest('hex')
    .slice(0, 12);
  return `scope-${hash}`;
}

