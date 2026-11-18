/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import type {Repository, VerifiedPullRequest} from './types.ts';
import {WorkflowError} from './types.ts';

const execFileAsync = promisify(execFile);
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const API_VERSION = '2026-03-10';

export interface PullRequestLocation {
  url: string;
  number: number;
  endpoint: string;
}

/** Transport hooks accept raw GitHub responses; every response is still validated. */
export interface PullRequestVerificationOptions {
  readWithGh?: (endpoint: string) => Promise<unknown>;
  fetch?: typeof globalThis.fetch;
  /** null explicitly disables environment-token lookup. Never persisted or logged. */
  token?: string | null;
}

function invalidEvidence(message: string): never {
  throw new WorkflowError('INVALID_PULL_REQUEST', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlOrSpace(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) return true;
  }
  return false;
}

function repositoryName(repository: Repository): string {
  const name = `${repository.owner}/${repository.name}`;
  if (
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\/[a-zA-Z0-9_.-]+$/.test(name) ||
    repository.name === '.' ||
    repository.name === '..' ||
    repository.url.toLowerCase() !== `https://github.com/${name}`.toLowerCase()
  ) {
    invalidEvidence(
      'Expected a canonical GitHub repository before verifying a PR.',
    );
  }
  return name;
}

/** Validate before passing any user-supplied text to a process or network client. */
export function parsePullRequestUrl(
  repository: Repository,
  value: string,
): PullRequestLocation {
  const expectedRepository = repositoryName(repository);
  if (typeof value !== 'string' || hasControlOrSpace(value)) {
    invalidEvidence('PR URL must be an HTTPS GitHub pull-request URL.');
  }
  // Match the original authority, rather than URL.port (which hides explicit :443).
  // A fragment is a harmless browser anchor; query parameters are never needed.
  const match =
    /^https:\/\/github\.com\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?(?:#.*)?$/iu.exec(
      value,
    );
  if (
    !match ||
    `${match[1]}/${match[2]}`.toLowerCase() !== expectedRepository.toLowerCase()
  ) {
    invalidEvidence('PR URL must belong to the requested GitHub repository.');
  }
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) {
    invalidEvidence('PR number must be a positive safe integer.');
  }
  return {
    url: `https://github.com/${expectedRepository}/pull/${number}`,
    number,
    endpoint: `repos/${expectedRepository}/pulls/${number}`,
  };
}

function branchName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    !hasControlOrSpace(value)
  );
}

/** Validate the actual REST response, never a PR claim in a generated chat answer. */
export function validatePullRequestPayload(
  repository: Repository,
  url: string,
  payload: unknown,
): VerifiedPullRequest {
  const location = parsePullRequestUrl(repository, url);
  const fullName = repositoryName(repository);
  if (
    !isRecord(payload) ||
    payload.number !== location.number ||
    typeof payload.html_url !== 'string'
  ) {
    invalidEvidence('GitHub did not return a matching pull request.');
  }
  const returnedLocation = parsePullRequestUrl(repository, payload.html_url);
  if (returnedLocation.number !== location.number) {
    invalidEvidence('GitHub returned a different pull request.');
  }
  if (payload.state !== 'open' || payload.merged === true) {
    invalidEvidence('The deliverable must be an open pull request.');
  }
  const head = payload.head;
  const base = payload.base;
  if (
    !isRecord(head) ||
    !isRecord(base) ||
    !isRecord(head.repo) ||
    !isRecord(base.repo) ||
    typeof head.repo.full_name !== 'string' ||
    typeof base.repo.full_name !== 'string' ||
    head.repo.full_name.toLowerCase() !== fullName.toLowerCase() ||
    base.repo.full_name.toLowerCase() !== fullName.toLowerCase()
  ) {
    invalidEvidence('The PR must use a branch in the requested repository.');
  }
  if (
    !branchName(head.ref) ||
    !branchName(base.ref) ||
    head.ref === base.ref ||
    head.ref === head.repo.default_branch
  ) {
    invalidEvidence('The PR must have a separate, non-default head branch.');
  }
  if (repository.baseBranch && base.ref !== repository.baseBranch) {
    invalidEvidence('The PR targets a different base branch than requested.');
  }
  return {
    url: location.url,
    number: location.number,
    headBranch: head.ref,
    baseBranch: base.ref,
    repository: fullName,
    verifiedAt: new Date().toISOString(),
  };
}

async function readWithGh(endpoint: string): Promise<unknown> {
  const {stdout} = await execFileAsync(
    'gh',
    [
      'api',
      '--hostname',
      'github.com',
      '--method',
      'GET',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      `X-GitHub-Api-Version: ${API_VERSION}`,
      endpoint,
    ],
    {
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: REQUEST_TIMEOUT_MS,
      maxBuffer: MAX_RESPONSE_BYTES,
      env: {
        ...process.env,
        GH_HOST: 'github.com',
        GH_PROMPT_DISABLED: '1',
        GH_DEBUG: '',
      },
    },
  );
  return JSON.parse(stdout) as unknown;
}

async function readFromApi(
  endpoint: string,
  token: string | null,
  fetcher: typeof globalThis.fetch,
): Promise<unknown> {
  const response = await fetcher(`https://api.github.com/${endpoint}`, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'chrome-ai-bridge',
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
    },
    // Never forward a token through a redirect, including repository transfers.
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new WorkflowError(
      'PR_VERIFICATION_UNAVAILABLE',
      `GitHub could not verify the PR (HTTP ${response.status}). Check repository access and gh authentication; the run remains incomplete.`,
    );
  }
  if (!response.body) {
    throw new Error('Missing API body.');
  }
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('API response exceeded the size limit.');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
}

/**
 * Read-only GitHub verification. No browser credentials are read and no PR is
 * created or updated here. Errors intentionally omit subprocess stderr, response
 * bodies, and token values.
 */
export async function verifyPullRequest(
  repository: Repository,
  url: string,
  options: PullRequestVerificationOptions = {},
): Promise<VerifiedPullRequest> {
  const location = parsePullRequestUrl(repository, url);
  let payload: unknown;
  try {
    payload = await (options.readWithGh ?? readWithGh)(location.endpoint);
  } catch {
    const token =
      (options.token === undefined
        ? process.env.GH_TOKEN || process.env.GITHUB_TOKEN
        : options.token
      )?.trim() || null;
    if (repository.visibility === 'private' && !token) {
      throw new WorkflowError(
        'PR_VERIFICATION_UNAVAILABLE',
        'Private PR verification requires gh authenticated for this repository or GH_TOKEN/GITHUB_TOKEN. ChatGPT connector access alone does not authenticate this CLI. The run remains incomplete.',
      );
    }
    try {
      payload = await readFromApi(
        location.endpoint,
        token,
        options.fetch ?? globalThis.fetch,
      );
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError(
        'PR_VERIFICATION_UNAVAILABLE',
        'Could not read the PR from GitHub. Check network connectivity and repository access; the run remains incomplete.',
      );
    }
  }
  // A successful transport with invalid evidence is terminal: a fallback must not
  // hide a repository mismatch or turn a closed PR into a successful deliverable.
  return validatePullRequestPayload(repository, location.url, payload);
}
