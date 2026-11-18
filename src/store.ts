/**
 * @license
 * Copyright 2026 usedhonda
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

import type {WorkflowState} from './types.ts';
import {WorkflowError} from './types.ts';
import {canonicalConversationUrl, canonicalRepositoryUrl} from './urls.ts';

const MAX_STATE_BYTES = 64 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function repository(value: unknown): boolean {
  if (
    !record(value) ||
    typeof value.url !== 'string' ||
    typeof value.owner !== 'string' ||
    typeof value.name !== 'string' ||
    !['public', 'private'].includes(String(value.visibility))
  )
    return false;
  if (
    value.baseBranch !== undefined &&
    (typeof value.baseBranch !== 'string' || !value.baseBranch.trim())
  )
    return false;
  const parsed = canonicalRepositoryUrl(value.url);
  return (
    parsed.url === value.url &&
    parsed.owner.toLowerCase() === value.owner.toLowerCase() &&
    parsed.name.toLowerCase() === value.name.toLowerCase()
  );
}

function validDate(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateState(value: unknown): asserts value is WorkflowState {
  if (
    !record(value) ||
    value.version !== 1 ||
    !record(value.projects) ||
    !record(value.runs)
  )
    throw new Error('Unsupported or invalid state format.');
  for (const [key, project] of Object.entries(value.projects)) {
    if (
      !/^[a-f0-9]{64}$/.test(key) ||
      !record(project) ||
      typeof project.name !== 'string' ||
      !project.name ||
      !repository(project.repository) ||
      !record(project.conversations) ||
      !record(project.archivedConversations)
    )
      throw new Error('Invalid project record.');
    for (const [provider, entries] of Object.entries(
      project.archivedConversations,
    )) {
      if (!['chatgpt', 'gemini'].includes(provider) || !Array.isArray(entries))
        throw new Error('Invalid archived conversations.');
      for (const entry of entries) validateConversation(provider, entry);
    }
    for (const [provider, entry] of Object.entries(project.conversations))
      validateConversation(provider, entry);
  }
  for (const [id, run] of Object.entries(value.runs)) {
    if (
      !record(run) ||
      run.id !== id ||
      typeof run.project !== 'string' ||
      !run.project ||
      !['chatgpt', 'gemini'].includes(String(run.provider)) ||
      !repository(run.repository) ||
      typeof run.prompt !== 'string' ||
      !run.prompt ||
      typeof run.inputHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(run.inputHash) ||
      !Array.isArray(run.contextFiles) ||
      ![
        'prepared',
        'ready',
        'sending',
        'submitted',
        'completed',
        'failed',
        'canceled',
      ].includes(String(run.phase)) ||
      typeof run.openUrl !== 'string' ||
      typeof run.requiresNewPage !== 'boolean' ||
      typeof run.newChat !== 'boolean' ||
      !validDate(run.createdAt) ||
      !validDate(run.updatedAt)
    )
      throw new Error('Invalid operation record.');
    if (
      run.conversationUrl !== undefined &&
      (typeof run.conversationUrl !== 'string' ||
        canonicalConversationUrl(
          run.provider as 'chatgpt' | 'gemini',
          run.conversationUrl,
        ) !== run.conversationUrl)
    )
      throw new Error('Invalid saved conversation URL.');
    if (
      run.previousConversationUrl !== undefined &&
      (typeof run.previousConversationUrl !== 'string' ||
        canonicalConversationUrl(
          run.provider as 'chatgpt' | 'gemini',
          run.previousConversationUrl,
        ) !== run.previousConversationUrl)
    )
      throw new Error('Invalid previous conversation URL.');
    if (
      ['ready', 'sending', 'submitted', 'completed', 'failed'].includes(
        String(run.phase),
      ) &&
      (typeof run.modeLabel !== 'string' ||
        !run.modeLabel ||
        typeof run.readyUrl !== 'string')
    )
      throw new Error('Operation lacks browser readiness evidence.');
    if (
      ['sending', 'submitted', 'completed', 'failed'].includes(
        String(run.phase),
      ) &&
      !validDate(run.sendingAt)
    )
      throw new Error('Operation lacks send boundary.');
    if (
      ['submitted', 'completed', 'failed'].includes(String(run.phase)) &&
      (typeof run.conversationUrl !== 'string' || !validDate(run.submittedAt))
    )
      throw new Error('Operation lacks submission evidence.');
    if (
      run.phase === 'completed' &&
      (!record(run.result) ||
        typeof run.result.answer !== 'string' ||
        !run.result.answer.trim() ||
        !validDate(run.completedAt))
    )
      throw new Error('Operation lacks completion evidence.');
    if (
      run.phase === 'failed' &&
      (!record(run.result) ||
        typeof run.result.answer !== 'string' ||
        !run.result.answer.trim() ||
        !record(run.failure) ||
        typeof run.failure.reason !== 'string' ||
        !run.failure.reason.trim() ||
        !validDate(run.failure.at))
    )
      throw new Error('Operation lacks final failure evidence.');
    if (run.reconciliations !== undefined) {
      if (
        !Array.isArray(run.reconciliations) ||
        run.reconciliations.some(
          observation =>
            !record(observation) ||
            typeof observation.url !== 'string' ||
            typeof observation.reason !== 'string' ||
            !observation.reason.trim() ||
            !validDate(observation.at),
        )
      )
        throw new Error('Invalid reconciliation history.');
    }
    if (
      run.blocked !== undefined &&
      (!record(run.blocked) ||
        typeof run.blocked.reason !== 'string' ||
        !run.blocked.reason.trim() ||
        !validDate(run.blocked.at))
    )
      throw new Error('Invalid blocked operation.');
  }
}

function validateConversation(provider: string, value: unknown): void {
  if (
    !['chatgpt', 'gemini'].includes(provider) ||
    !record(value) ||
    typeof value.url !== 'string' ||
    canonicalConversationUrl(provider as 'chatgpt' | 'gemini', value.url) !==
      value.url ||
    !validDate(value.createdAt) ||
    !validDate(value.updatedAt) ||
    typeof value.lastRunId !== 'string'
  )
    throw new Error('Invalid conversation record.');
}

function emptyState(): WorkflowState {
  return {version: 1, projects: {}, runs: {}};
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission denied is a live process, not a stale lock.
    return errno(error) !== 'ESRCH';
  }
}

/** Atomic, private, cross-process storage. A malformed file is never reset. */
export class StateStore {
  readonly directory: string;
  readonly filePath: string;
  private readonly lockPath: string;
  private readonly recoveryPath: string;

  constructor(directory?: string) {
    this.directory = path.resolve(
      directory ||
        process.env.CAB_STATE_DIR ||
        path.join(
          process.env.XDG_STATE_HOME ||
            path.join(os.homedir(), '.local', 'state'),
          'chrome-ai-bridge',
        ),
    );
    this.filePath = path.join(this.directory, 'browser-workflows.json');
    this.lockPath = path.join(this.directory, 'browser-workflows.lock');
    this.recoveryPath = `${this.lockPath}.recovery`;
  }

  async read(): Promise<WorkflowState> {
    try {
      const handle = await fs.open(
        this.filePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile())
          throw new Error('Workflow state must be a regular file.');
        if (info.size > MAX_STATE_BYTES)
          throw new Error('State file exceeds 64 MiB.');
        const value: unknown = JSON.parse(await handle.readFile('utf8'));
        validateState(value);
        return value;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (errno(error) === 'ENOENT') return emptyState();
      throw new WorkflowError(
        'STATE_CORRUPT',
        `Cannot read workflow state at ${this.filePath}; it has not been overwritten. Check the file's permissions and format or restore a backup. Malformed state is never treated as an empty store.`,
      );
    }
  }

  async mutate<T>(
    mutation: (state: WorkflowState) => T | Promise<T>,
  ): Promise<T> {
    await fs.mkdir(this.directory, {recursive: true, mode: 0o700});
    await fs.chmod(this.directory, 0o700);
    const release = await this.acquire();
    try {
      const state = await this.read();
      const before = JSON.stringify(state);
      const result = await mutation(state);
      validateState(state);
      if (JSON.stringify(state) !== before) await this.write(state);
      return structuredClone(result);
    } finally {
      await release();
    }
  }

  private async write(state: WorkflowState): Promise<void> {
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) {
      throw new WorkflowError(
        'STATE_CAPACITY_EXCEEDED',
        'Workflow history would exceed 64 MiB; the existing state file is unchanged. Back it up, then use a separate CAB_STATE_DIR and explicitly import the saved conversation URLs to continue without losing the old history.',
      );
    }
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, this.filePath);
      // Windows does not expose directory handles through fs.open('r'). File
      // fsync above remains mandatory there; POSIX additionally syncs rename.
      if (process.platform !== 'win32') {
        const directory = await fs.open(this.directory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await fs.unlink(temporary).catch(error => {
        if (errno(error) !== 'ENOENT') throw error;
      });
    }
  }

  private async acquire(): Promise<() => Promise<void>> {
    const token = randomUUID();
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      // A single recovery guard prevents competing stale-lock removals.
      const recovering = await fs.stat(this.recoveryPath).then(
        () => true,
        error => {
          if (errno(error) === 'ENOENT') return false;
          throw error;
        },
      );
      if (!recovering) {
        try {
          const handle = await fs.open(this.lockPath, 'wx', 0o600);
          try {
            await handle.writeFile(JSON.stringify({pid: process.pid, token}));
          } finally {
            await handle.close();
          }
          return async () => {
            const current = JSON.parse(
              await fs.readFile(this.lockPath, 'utf8'),
            ) as {token?: string};
            if (current.token !== token)
              throw new WorkflowError(
                'STATE_LOCK_CHANGED',
                'Workflow lock changed unexpectedly; state is preserved.',
              );
            await fs.unlink(this.lockPath);
          };
        } catch (error) {
          if (errno(error) !== 'EEXIST') throw error;
        }
        await this.recoverDeadOwner();
      }
      await delay(20);
    }
    throw new WorkflowError(
      'STATE_LOCKED',
      `Workflow state is locked at ${this.lockPath}. Another process may be updating it. An invalid lock or interrupted recovery requires inspection; no lock was removed by timeout.`,
    );
  }

  private async recoverDeadOwner(): Promise<void> {
    let acquired = false;
    try {
      try {
        await fs.mkdir(this.recoveryPath, {mode: 0o700});
        acquired = true;
      } catch (error) {
        if (errno(error) === 'EEXIST') return;
        throw error;
      }
      let owner: unknown;
      try {
        owner = JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
      } catch (error) {
        if (errno(error) === 'ENOENT' || error instanceof SyntaxError) return;
        throw error;
      }
      if (
        !record(owner) ||
        !Number.isSafeInteger(owner.pid) ||
        Number(owner.pid) <= 0 ||
        typeof owner.token !== 'string'
      )
        return;
      if (!processExists(Number(owner.pid))) await fs.unlink(this.lockPath);
    } finally {
      if (acquired) await fs.rmdir(this.recoveryPath);
    }
  }
}
