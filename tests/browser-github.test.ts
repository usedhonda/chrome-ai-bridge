/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  parsePullRequestUrl,
  validatePullRequestPayload,
  verifyPullRequest,
} from '../src/browser-use/github.js';
import type {Repository} from '../src/browser-use/types.js';
import {WorkflowError} from '../src/browser-use/types.js';

const repository: Repository = {
  url: 'https://github.com/usedhonda/chrome-ai-bridge',
  owner: 'usedhonda',
  name: 'chrome-ai-bridge',
  visibility: 'public',
  baseBranch: 'main',
};
const prUrl = `${repository.url}/pull/8`;

function payload() {
  return {
    number: 8,
    html_url: prUrl,
    state: 'open',
    merged: false,
    draft: true,
    head: {
      ref: 'feat/browser-use',
      repo: {
        full_name: 'usedhonda/chrome-ai-bridge',
        default_branch: 'main',
      },
    },
    base: {
      ref: 'main',
      repo: {full_name: 'usedhonda/chrome-ai-bridge'},
    },
  };
}

function errorCode(code: string) {
  return (error: unknown) =>
    error instanceof WorkflowError && error.code === code;
}

test('PR locations are restricted to the intended GitHub repository before I/O', async () => {
  assert.deepEqual(
    parsePullRequestUrl(
      repository,
      'https://GITHUB.com/UsedHonda/Chrome-AI-Bridge/pull/8/#discussion_r1',
    ),
    {
      url: prUrl,
      number: 8,
      endpoint: 'repos/usedhonda/chrome-ai-bridge/pulls/8',
    },
  );
  let calls = 0;
  for (const invalid of [
    'https://github.com.evil.example/usedhonda/chrome-ai-bridge/pull/8',
    'http://github.com/usedhonda/chrome-ai-bridge/pull/8',
    'https://secret@github.com/usedhonda/chrome-ai-bridge/pull/8',
    'https://github.com:443/usedhonda/chrome-ai-bridge/pull/8',
    'https://github.com/other/chrome-ai-bridge/pull/8',
    'https://github.com/usedhonda/other/pull/8',
    `${prUrl}?token=secret`,
    `${prUrl}/files`,
    `${repository.url}/issues/8`,
    `${repository.url}/pull/0`,
    `${repository.url}/pull/9007199254740992`,
    `${prUrl}\n`,
  ]) {
    await assert.rejects(
      verifyPullRequest(repository, invalid, {
        readWithGh: async () => {
          calls++;
          return payload();
        },
      }),
      errorCode('INVALID_PULL_REQUEST'),
      invalid,
    );
  }
  assert.equal(calls, 0);
});

test('an open same-repository draft with a separate branch is a valid deliverable', () => {
  const result = validatePullRequestPayload(repository, prUrl, payload());
  assert.equal(result.url, prUrl);
  assert.equal(result.number, 8);
  assert.equal(result.repository, 'usedhonda/chrome-ai-bridge');
  assert.equal(result.headBranch, 'feat/browser-use');
  assert.equal(result.baseBranch, 'main');
  assert.ok(Number.isFinite(Date.parse(result.verifiedAt)));
});

test('claims, mismatched PRs, closed PRs, forks, and wrong branch evidence fail closed', () => {
  const wrongNumber = {...payload(), number: 9};
  const wrongUrl = {...payload(), html_url: `${repository.url}/pull/9`};
  const wrongBaseRepository = payload();
  wrongBaseRepository.base.repo.full_name = 'other/chrome-ai-bridge';
  const fork = payload();
  fork.head.repo.full_name = 'fork/chrome-ai-bridge';
  const sameBranch = payload();
  sameBranch.head.ref = 'main';
  const wrongBase = payload();
  wrongBase.base.ref = 'develop';
  const emptyBranch = payload();
  emptyBranch.head.ref = '';
  const defaultHead = payload();
  defaultHead.head.repo.default_branch = 'feat/browser-use';
  for (const evidence of [
    null,
    'I created a PR',
    {url: prUrl},
    wrongNumber,
    wrongUrl,
    {...payload(), state: 'closed'},
    {...payload(), merged: true},
    wrongBaseRepository,
    fork,
    sameBranch,
    wrongBase,
    emptyBranch,
    defaultHead,
    {...payload(), head: {ref: 'feat/browser-use', repo: null}},
  ]) {
    assert.throws(
      () => validatePullRequestPayload(repository, prUrl, evidence),
      errorCode('INVALID_PULL_REQUEST'),
    );
  }
});

test('gh transport uses an exact repository endpoint and validates returned evidence', async () => {
  let endpoint = '';
  const result = await verifyPullRequest(repository, prUrl, {
    readWithGh: async value => {
      endpoint = value;
      return payload();
    },
    fetch: async () => {
      assert.fail('GitHub CLI success must not perform a second request');
    },
  });
  assert.equal(endpoint, 'repos/usedhonda/chrome-ai-bridge/pulls/8');
  assert.equal(result.headBranch, 'feat/browser-use');
});

test('invalid evidence from successful gh transport is not concealed by fallback', async () => {
  let fetchCalls = 0;
  await assert.rejects(
    verifyPullRequest(repository, prUrl, {
      readWithGh: async () => ({...payload(), state: 'closed'}),
      fetch: async () => {
        fetchCalls++;
        return Response.json(payload());
      },
    }),
    errorCode('INVALID_PULL_REQUEST'),
  );
  assert.equal(fetchCalls, 0);
});

test('public fallback reads only api.github.com and refuses redirects', async () => {
  let requested = '';
  let options: RequestInit | undefined;
  const result = await verifyPullRequest(repository, prUrl, {
    token: null,
    readWithGh: async () => {
      throw new Error('gh not installed');
    },
    fetch: async (input, init) => {
      requested = String(input);
      options = init;
      return Response.json(payload());
    },
  });
  assert.equal(
    requested,
    'https://api.github.com/repos/usedhonda/chrome-ai-bridge/pulls/8',
  );
  assert.equal(options?.method, 'GET');
  assert.equal(options?.redirect, 'error');
  assert.ok(options?.signal);
  assert.equal(new Headers(options?.headers).get('Authorization'), null);
  assert.equal(result.number, 8);
});

test('private verification needs authenticated CLI or a token; no anonymous probe', async () => {
  const privateRepository: Repository = {...repository, visibility: 'private'};
  let requests = 0;
  await assert.rejects(
    verifyPullRequest(privateRepository, prUrl, {
      token: null,
      readWithGh: async () => {
        throw new Error('sensitive process stderr');
      },
      fetch: async () => {
        requests++;
        return Response.json(payload());
      },
    }),
    errorCode('PR_VERIFICATION_UNAVAILABLE'),
  );
  assert.equal(requests, 0);

  const result = await verifyPullRequest(privateRepository, prUrl, {
    token: 'test-token-never-logged',
    readWithGh: async () => {
      throw new Error('not authenticated');
    },
    fetch: async (input, init) => {
      assert.equal(new URL(String(input)).hostname, 'api.github.com');
      assert.equal(
        new Headers(init?.headers).get('Authorization'),
        'Bearer test-token-never-logged',
      );
      return Response.json(payload());
    },
  });
  assert.equal(result.number, 8);
});

test('transport failures and malformed responses never reveal credentials or bodies', async () => {
  const sensitive = 'not-for-output-secret';
  for (const fetcher of [
    async () => {
      throw new Error(sensitive);
    },
    async () => new Response(sensitive, {status: 403}),
    async () => new Response(sensitive, {status: 200}),
    async () => new Response('a'.repeat(2 * 1024 * 1024 + 1)),
  ]) {
    await assert.rejects(
      verifyPullRequest(repository, prUrl, {
        token: sensitive,
        readWithGh: async () => {
          throw new Error(sensitive);
        },
        fetch: fetcher,
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, 'PR_VERIFICATION_UNAVAILABLE');
        assert.ok(!error.message.includes(sensitive));
        return true;
      },
    );
  }
});
