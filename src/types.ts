/**
 * @license
 * Copyright 2026 usedhonda
 * SPDX-License-Identifier: Apache-2.0
 */

export type Provider = 'chatgpt' | 'gemini';
export type Visibility = 'public' | 'private';
export type RunPhase =
  | 'prepared'
  | 'ready'
  | 'sending'
  | 'submitted'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface Repository {
  url: string;
  owner: string;
  name: string;
  visibility: Visibility;
  baseBranch?: string;
}

export interface ContextFile {
  path: string;
  sha256: string;
  bytes: number;
  startLine?: number;
  endLine?: number;
}

export interface PreparedInput {
  project: string;
  provider: Provider;
  repository: Repository;
  prompt: string;
  requestId?: string;
  newChat?: boolean;
  contextFiles?: ContextFile[];
}

export interface ReadyEvidence {
  url: string;
  modeLabel: string;
  tabId?: string;
  newPage?: boolean;
}

/** Evidence obtained by the caller's GitHub verifier, not inferred from chat text. */
export interface VerifiedPullRequest {
  url: string;
  number: number;
  headBranch: string;
  baseBranch: string;
  repository: string;
  verifiedAt: string;
}

export interface CompletionEvidence {
  answer: string;
  pullRequest?: VerifiedPullRequest;
}

export interface Conversation {
  url: string;
  createdAt: string;
  updatedAt: string;
  lastRunId: string;
}

export interface ProjectState {
  name: string;
  repository: Repository;
  conversations: Partial<Record<Provider, Conversation>>;
  archivedConversations: Partial<Record<Provider, Conversation[]>>;
}

export interface Run {
  id: string;
  requestId?: string;
  inputHash: string;
  project: string;
  provider: Provider;
  repository: Repository;
  prompt: string;
  contextFiles: ContextFile[];
  phase: RunPhase;
  /** Only a canonical provider conversation URL, never the provider homepage. */
  conversationUrl?: string;
  /** The previous saved conversation when an explicit new-chat run replaces it. */
  previousConversationUrl?: string;
  openUrl: string;
  requiresNewPage: boolean;
  newChat: boolean;
  modeLabel?: string;
  tabId?: string;
  readyUrl?: string;
  createdAt: string;
  updatedAt: string;
  sendingAt?: string;
  submittedAt?: string;
  completedAt?: string;
  blocked?: {reason: string; at: string};
  failure?: {reason: string; at: string};
  reconciliations?: Array<{url: string; reason: string; at: string}>;
  result?: CompletionEvidence;
}

export interface WorkflowState {
  version: 1;
  projects: Record<string, ProjectState>;
  runs: Record<string, Run>;
}

export class WorkflowError extends Error {
  override name = 'WorkflowError';
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
