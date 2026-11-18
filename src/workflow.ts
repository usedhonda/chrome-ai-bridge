/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createHash, randomUUID} from 'node:crypto';

import {StateStore} from './store.ts';
import type {
  CompletionEvidence,
  ContextFile,
  PreparedInput,
  ProjectState,
  Provider,
  ReadyEvidence,
  Repository,
  Run,
  VerifiedPullRequest,
  WorkflowState,
} from './types.ts';
import {WorkflowError} from './types.ts';
import {
  canonicalConversationUrl,
  canonicalNewChatUrl,
  canonicalRepositoryUrl,
  providerHome,
  validateMode,
} from './urls.ts';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function text(value: unknown, label: string, maximum = 256): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    [...value].some(character => {
      const point = character.codePointAt(0)!;
      return point < 32 && point !== 9 && point !== 10 && point !== 13;
    })
  ) {
    throw new WorkflowError(
      'INVALID_INPUT',
      `${label} must be a nonempty string of at most ${maximum} characters.`,
    );
  }
  return value.trim();
}

function validProvider(value: Provider): Provider {
  if (value !== 'chatgpt' && value !== 'gemini')
    throw new WorkflowError(
      'INVALID_PROVIDER',
      'Provider must be chatgpt or gemini.',
    );
  return value;
}

function normalizeRepository(value: Repository): Repository {
  if (!value || typeof value !== 'object')
    throw new WorkflowError(
      'INVALID_REPOSITORY',
      'Repository metadata is required.',
    );
  const parsed = canonicalRepositoryUrl(value.url);
  if (
    typeof value.owner !== 'string' ||
    typeof value.name !== 'string' ||
    parsed.owner.toLowerCase() !== value.owner.toLowerCase() ||
    parsed.name.toLowerCase() !== value.name.toLowerCase()
  )
    throw new WorkflowError(
      'INVALID_REPOSITORY',
      'Repository owner/name must match its URL.',
    );
  if (value.visibility !== 'public' && value.visibility !== 'private')
    throw new WorkflowError(
      'INVALID_REPOSITORY',
      'Repository visibility must be public or private.',
    );
  const baseBranch =
    value.baseBranch === undefined
      ? undefined
      : text(value.baseBranch, 'Base branch');
  return {
    ...parsed,
    visibility: value.visibility,
    ...(baseBranch ? {baseBranch} : {}),
  };
}

function validateContext(files: ContextFile[] | undefined): ContextFile[] {
  if (files === undefined) return [];
  if (!Array.isArray(files))
    throw new WorkflowError(
      'INVALID_CONTEXT',
      'contextFiles must be an array.',
    );
  for (const file of files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      !file.path.trim() ||
      !/^[a-f0-9]{64}$/i.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      (file.startLine !== undefined &&
        (!Number.isSafeInteger(file.startLine) || file.startLine < 1)) ||
      (file.endLine !== undefined &&
        (!Number.isSafeInteger(file.endLine) ||
          file.endLine < (file.startLine || 1)))
    )
      throw new WorkflowError(
        'INVALID_CONTEXT',
        'Code context metadata must include a path, SHA-256, and positive byte count.',
      );
  }
  return structuredClone(files);
}

function pending(run: Run): boolean {
  return !['completed', 'failed', 'canceled'].includes(run.phase);
}

function lookup(state: WorkflowState, runId: string): Run {
  if (!Object.hasOwn(state.runs, runId))
    throw new WorkflowError(
      'RUN_NOT_FOUND',
      `No operation exists with ID ${runId}.`,
    );
  return state.runs[runId];
}

function pendingRun(
  state: WorkflowState,
  project: string,
  provider: Provider,
): Run | undefined {
  return Object.values(state.runs).find(
    run => run.project === project && run.provider === provider && pending(run),
  );
}

function projectRecord(
  state: WorkflowState,
  name: string,
  repository: Repository,
): ProjectState {
  const key = hash(name);
  if (Object.hasOwn(state.projects, key)) {
    const project = state.projects[key];
    if (project.repository.url.toLowerCase() !== repository.url.toLowerCase())
      throw new WorkflowError(
        'PROJECT_REPOSITORY_CONFLICT',
        `Project ${name} is already bound to ${project.repository.url}; use another project name for ${repository.url}.`,
      );
    return project;
  }
  const project: ProjectState = {
    name,
    repository,
    conversations: {},
    archivedConversations: {},
  };
  state.projects[key] = project;
  return project;
}

function validatePullRequest(
  value: VerifiedPullRequest | undefined,
  repository: Repository,
): VerifiedPullRequest {
  if (!value || typeof value !== 'object')
    throw new WorkflowError(
      'PULL_REQUEST_REQUIRED',
      'ChatGPT completion requires a real branch and a GitHub-verified pull request.',
    );
  const repoName = `${repository.owner}/${repository.name}`;
  const match =
    typeof value.url === 'string'
      ? /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/.exec(
          value.url,
        )
      : null;
  if (
    !match ||
    `${match[1]}/${match[2]}`.toLowerCase() !== repoName.toLowerCase() ||
    typeof value.repository !== 'string' ||
    value.repository.toLowerCase() !== repoName.toLowerCase() ||
    !Number.isSafeInteger(value.number) ||
    value.number !== Number(match[3])
  )
    throw new WorkflowError(
      'INVALID_PULL_REQUEST',
      'The verified pull request must belong to this operation’s repository and its number must match its URL.',
    );
  const headBranch = text(value.headBranch, 'PR head branch');
  const baseBranch = text(value.baseBranch, 'PR base branch');
  if (
    headBranch === baseBranch ||
    (repository.baseBranch && repository.baseBranch !== baseBranch)
  )
    throw new WorkflowError(
      'INVALID_PULL_REQUEST',
      'The PR must use a separate head branch and target the requested base branch.',
    );
  if (
    typeof value.verifiedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.verifiedAt))
  )
    throw new WorkflowError(
      'INVALID_PULL_REQUEST',
      'The pull request needs a GitHub verification timestamp.',
    );
  return {...value, headBranch, baseBranch};
}

export class Workflow {
  readonly store: StateStore;

  constructor(store = new StateStore()) {
    this.store = store;
  }

  async prepare(input: PreparedInput): Promise<Run> {
    return this.store.mutate(state => this.prepareInState(state, input));
  }

  /** Preparing both providers is atomic; either all inputs validate or none are saved. */
  async prepareMany(inputs: PreparedInput[]): Promise<Run[]> {
    if (!Array.isArray(inputs) || inputs.length === 0)
      throw new WorkflowError(
        'INVALID_INPUT',
        'At least one request is required.',
      );
    return this.store.mutate(state =>
      inputs.map(input => this.prepareInState(state, input)),
    );
  }

  private prepareInState(state: WorkflowState, input: PreparedInput): Run {
    const projectName = text(input.project, 'Project');
    const provider = validProvider(input.provider);
    const repository = normalizeRepository(input.repository);
    if (
      typeof input.prompt !== 'string' ||
      !input.prompt.trim() ||
      Buffer.byteLength(input.prompt, 'utf8') > 2 * 1024 * 1024 ||
      input.prompt.includes('\0')
    )
      throw new WorkflowError(
        'INVALID_PROMPT',
        'Prompt must be nonempty UTF-8 text up to 2 MiB without NUL characters.',
      );
    if (input.newChat !== undefined && typeof input.newChat !== 'boolean')
      throw new WorkflowError('INVALID_INPUT', 'newChat must be a boolean.');
    const contextFiles = validateContext(input.contextFiles);
    if (
      provider === 'gemini' &&
      repository.visibility === 'private' &&
      contextFiles.length === 0
    )
      throw new WorkflowError(
        'PRIVATE_CODE_REQUIRED',
        'Gemini cannot read a private repository by URL. Supply explicit code files or excerpts in the prompt.',
      );
    const requestId =
      input.requestId === undefined
        ? undefined
        : text(input.requestId, 'Request ID');
    const inputHash = hash(
      JSON.stringify({
        project: projectName,
        provider,
        repository,
        prompt: input.prompt,
        contextFiles,
        newChat: Boolean(input.newChat),
      }),
    );
    if (requestId) {
      const existing = Object.values(state.runs).find(
        run =>
          run.project === projectName &&
          run.provider === provider &&
          run.requestId === requestId,
      );
      if (existing) {
        if (existing.inputHash !== inputHash)
          throw new WorkflowError(
            'REQUEST_ID_CONFLICT',
            'This request ID was already used with different input.',
          );
        return existing;
      }
    }
    const active = pendingRun(state, projectName, provider);
    if (active)
      throw new WorkflowError(
        'PENDING_OPERATION',
        `Project ${projectName} already has pending ${provider} operation ${active.id} (${active.phase}). Resume it instead of sending again.`,
      );
    const project = projectRecord(state, projectName, repository);
    const previous = project.conversations[provider];
    const requiresNewPage = Boolean(input.newChat) || !previous;
    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      ...(requestId ? {requestId} : {}),
      inputHash,
      project: projectName,
      provider,
      repository,
      prompt: input.prompt,
      contextFiles,
      phase: 'prepared',
      ...(previous && !requiresNewPage ? {conversationUrl: previous.url} : {}),
      ...(previous && requiresNewPage
        ? {previousConversationUrl: previous.url}
        : {}),
      openUrl: requiresNewPage ? providerHome(provider) : previous.url,
      requiresNewPage,
      newChat: Boolean(input.newChat),
      createdAt: now,
      updatedAt: now,
    };
    state.runs[run.id] = run;
    return run;
  }

  async ready(runId: string, evidence: ReadyEvidence): Promise<Run> {
    return this.store.mutate(state => {
      const run = lookup(state, runId);
      if (run.phase !== 'prepared' && run.phase !== 'ready')
        throw new WorkflowError(
          'INVALID_PHASE',
          `Cannot prepare browser controls after ${run.phase}; inspect the existing conversation.`,
        );
      const modeLabel = validateMode(run.provider, evidence.modeLabel);
      let url: string;
      if (run.requiresNewPage) {
        if (evidence.newPage !== true)
          throw new WorkflowError(
            'NEW_PAGE_REQUIRED',
            'The first conversation for a project must use a newly opened page.',
          );
        url = canonicalNewChatUrl(run.provider, evidence.url);
      } else {
        url = canonicalConversationUrl(run.provider, evidence.url);
        if (url !== run.conversationUrl)
          throw new WorkflowError(
            'CONVERSATION_MISMATCH',
            `Continue the saved conversation ${run.conversationUrl}; do not use a different chat.`,
          );
      }
      run.phase = 'ready';
      run.modeLabel = modeLabel;
      run.readyUrl = url;
      if (evidence.tabId !== undefined)
        run.tabId = text(evidence.tabId, 'Browser tab ID', 1024);
      run.updatedAt = new Date().toISOString();
      delete run.blocked;
      return run;
    });
  }

  /** The only permission to click Send. Never retry this command after an uncertain result. */
  async beginSend(runId: string): Promise<Run> {
    return this.store.mutate(state => {
      const run = lookup(state, runId);
      if (run.phase !== 'ready')
        throw new WorkflowError(
          'SEND_NOT_AUTHORIZED',
          `Cannot send operation in phase ${run.phase}. If a prior send result was uncertain, inspect the conversation; do not resend.`,
        );
      if (run.blocked)
        throw new WorkflowError(
          'OPERATION_BLOCKED',
          `Refresh browser readiness before sending: ${run.blocked.reason}`,
        );
      run.phase = 'sending';
      run.sendingAt = new Date().toISOString();
      run.updatedAt = run.sendingAt;
      return run;
    });
  }

  /** Call immediately when the accepted user message and its canonical URL are visible. */
  async sent(runId: string, evidence: {url: string}): Promise<Run> {
    return this.store.mutate(state => {
      const run = lookup(state, runId);
      if (run.phase !== 'sending' && run.phase !== 'submitted')
        throw new WorkflowError(
          'INVALID_PHASE',
          `Submission evidence cannot be recorded in phase ${run.phase}.`,
        );
      const url = canonicalConversationUrl(run.provider, evidence.url);
      if (run.conversationUrl && run.conversationUrl !== url)
        throw new WorkflowError(
          'CONVERSATION_MISMATCH',
          'The saved conversation URL cannot be replaced during a follow-up.',
        );
      if (run.previousConversationUrl === url)
        throw new WorkflowError(
          'NEW_PAGE_REQUIRED',
          'A requested new conversation cannot reuse the previous conversation URL.',
        );
      const project = projectRecord(state, run.project, run.repository);
      for (const other of Object.values(state.projects)) {
        if (
          other.name !== run.project &&
          other.conversations[run.provider]?.url === url
        )
          throw new WorkflowError(
            'CONVERSATION_IN_USE',
            `This conversation is already assigned to project ${other.name}.`,
          );
      }
      if (run.phase === 'submitted') return run;
      const now = new Date().toISOString();
      const previous = project.conversations[run.provider];
      if (run.requiresNewPage && previous && previous.url !== url) {
        (project.archivedConversations[run.provider] ||= []).push(previous);
      }
      project.conversations[run.provider] = {
        url,
        createdAt: previous?.url === url ? previous.createdAt : now,
        updatedAt: now,
        lastRunId: run.id,
      };
      project.repository = run.repository;
      run.conversationUrl = url;
      run.phase = 'submitted';
      run.submittedAt = now;
      run.updatedAt = now;
      delete run.blocked;
      return run;
    });
  }

  /**
   * Explicit browser evidence that no user message was sent. A timeout, missing
   * tab, or uncertain click is not this evidence. This does not authorize Send;
   * the caller must recheck browser readiness and call beginSend separately.
   */
  async reconcileNotSent(
    runId: string,
    evidence: {url: string; reason: string},
  ): Promise<Run> {
    return this.store.mutate(state => {
      const run = lookup(state, runId);
      if (run.phase !== 'sending') {
        throw new WorkflowError(
          'INVALID_PHASE',
          'Only an uncertain sending operation can be reconciled as not sent.',
        );
      }
      const url = run.requiresNewPage
        ? canonicalNewChatUrl(run.provider, evidence.url)
        : canonicalConversationUrl(run.provider, evidence.url);
      if (url !== run.readyUrl) {
        throw new WorkflowError(
          'CONVERSATION_MISMATCH',
          'Not-sent evidence must come from the page prepared for this operation.',
        );
      }
      const observation = {
        url,
        reason: text(
          evidence.reason,
          'Positive not-sent browser observation',
          8000,
        ),
        at: new Date().toISOString(),
      };
      (run.reconciliations ||= []).push(observation);
      run.phase = 'ready';
      run.updatedAt = observation.at;
      delete run.sendingAt;
      delete run.blocked;
      return run;
    });
  }

  /** End a finished provider turn that could not deliver the requested result. */
  async fail(
    runId: string,
    evidence: {answer: string; reason: string},
  ): Promise<Run> {
    return this.store.mutate(state => {
      const run = lookup(state, runId);
      if (run.phase !== 'submitted') {
        throw new WorkflowError(
          'INVALID_PHASE',
          'Only an accepted submission with an observed final assistant answer can be marked failed.',
        );
      }
      if (typeof evidence.answer !== 'string' || !evidence.answer.trim()) {
        throw new WorkflowError(
          'ANSWER_REQUIRED',
          'Record the actual final assistant answer explaining the failure.',
        );
      }
      run.failure = {
        reason: text(evidence.reason, 'Failure reason', 8000),
        at: new Date().toISOString(),
      };
      run.result = {answer: evidence.answer};
      run.phase = 'failed';
      run.updatedAt = run.failure.at;
      delete run.blocked;
      return run;
    });
  }

  async complete(runId: string, evidence: CompletionEvidence): Promise<Run> {
    return this.store.mutate(state => {
      const run = lookup(state, runId);
      if (run.phase !== 'submitted' && run.phase !== 'completed')
        throw new WorkflowError(
          'INVALID_PHASE',
          'Record the accepted submission and conversation URL before completing.',
        );
      if (typeof evidence.answer !== 'string' || !evidence.answer.trim())
        throw new WorkflowError(
          'ANSWER_REQUIRED',
          'A nonempty final assistant answer is required.',
        );
      let result: CompletionEvidence;
      if (run.provider === 'chatgpt') {
        result = {
          answer: evidence.answer,
          pullRequest: validatePullRequest(
            evidence.pullRequest,
            run.repository,
          ),
        };
      } else {
        if (evidence.pullRequest !== undefined)
          throw new WorkflowError(
            'UNEXPECTED_PULL_REQUEST',
            'Gemini outputs its result in chat and cannot supply PR completion evidence.',
          );
        result = {answer: evidence.answer};
      }
      if (run.phase === 'completed') {
        if (JSON.stringify(result) !== JSON.stringify(run.result))
          throw new WorkflowError(
            'COMPLETION_CONFLICT',
            'This operation was already completed with different evidence.',
          );
        return run;
      }
      run.result = result;
      run.phase = 'completed';
      run.completedAt = new Date().toISOString();
      run.updatedAt = run.completedAt;
      delete run.blocked;
      return run;
    });
  }

  async block(runId: string, reason: string): Promise<Run> {
    return this.store.mutate(state => {
      const run = lookup(state, runId);
      if (!pending(run))
        throw new WorkflowError(
          'INVALID_PHASE',
          'A finished or canceled operation cannot be blocked.',
        );
      run.blocked = {
        reason: text(reason, 'Block reason', 8000),
        at: new Date().toISOString(),
      };
      run.updatedAt = run.blocked.at;
      return run;
    });
  }

  async cancel(runId: string): Promise<Run> {
    return this.store.mutate(state => {
      const run = lookup(state, runId);
      if (run.phase === 'canceled') return run;
      if (run.phase !== 'prepared' && run.phase !== 'ready')
        throw new WorkflowError(
          'CANNOT_CANCEL_SUBMITTED',
          'An operation that may have been submitted cannot be canceled or resent. Resume it and inspect the saved browser conversation.',
        );
      run.phase = 'canceled';
      run.updatedAt = new Date().toISOString();
      delete run.blocked;
      return run;
    });
  }

  async get(runId: string): Promise<Run> {
    return lookup(await this.store.read(), runId);
  }

  async resume(runId: string): Promise<Run> {
    return this.get(runId);
  }

  async status(
    project?: string,
  ): Promise<{projects: ProjectState[]; runs: Run[]}> {
    const state = await this.store.read();
    return {
      projects: Object.values(state.projects).filter(
        value => project === undefined || value.name === project,
      ),
      runs: Object.values(state.runs).filter(
        value => project === undefined || value.project === project,
      ),
    };
  }

  async list(
    project?: string,
  ): Promise<{projects: ProjectState[]; runs: Run[]}> {
    return this.status(project);
  }

  /** Explicit adoption of a known existing conversation; no legacy lane is guessed. */
  async importSession(input: {
    project: string;
    provider: Provider;
    repository: Repository;
    url: string;
  }): Promise<ProjectState> {
    const projectName = text(input.project, 'Project');
    const provider = validProvider(input.provider);
    const repository = normalizeRepository(input.repository);
    const url = canonicalConversationUrl(provider, input.url);
    return this.store.mutate(state => {
      const active = pendingRun(state, projectName, provider);
      if (active)
        throw new WorkflowError(
          'PENDING_OPERATION',
          `Resume pending operation ${active.id} before adopting a conversation.`,
        );
      const project = projectRecord(state, projectName, repository);
      const existing = project.conversations[provider];
      if (existing?.url === url) return project;
      if (existing)
        throw new WorkflowError(
          'CONVERSATION_MISMATCH',
          `Project already uses ${existing.url}; importing cannot replace it.`,
        );
      for (const other of Object.values(state.projects)) {
        if (
          other.name !== projectName &&
          other.conversations[provider]?.url === url
        )
          throw new WorkflowError(
            'CONVERSATION_IN_USE',
            `This conversation is already assigned to project ${other.name}.`,
          );
      }
      const now = new Date().toISOString();
      project.conversations[provider] = {
        url,
        createdAt: now,
        updatedAt: now,
        lastRunId: 'imported',
      };
      return project;
    });
  }
}
