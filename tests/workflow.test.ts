/**
 * @license
 * Copyright 2026 usedhonda
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {StateStore} from '../src/store.ts';
import type {PreparedInput, Run, VerifiedPullRequest} from '../src/types.ts';
import {WorkflowError} from '../src/types.ts';
import {
  canonicalConversationUrl,
  canonicalRepositoryUrl,
  validateMode,
} from '../src/urls.ts';
import {Workflow} from '../src/workflow.ts';

const repository = {
  url: 'https://github.com/example/project',
  owner: 'example',
  name: 'project',
  visibility: 'public' as const,
  baseBranch: 'main',
};
const input: PreparedInput = {
  project: 'project',
  provider: 'gemini',
  repository,
  prompt: 'Inspect the implementation.\n\nPreserve code formatting.',
};
const code = (value: string) => (error: unknown) =>
  error instanceof WorkflowError && error.code === value;

async function fixture(t: {after: (callback: () => Promise<void>) => void}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cab-state-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  return {directory, workflow: new Workflow(new StateStore(directory))};
}

async function submit(workflow: Workflow, run: Run, url: string): Promise<Run> {
  await workflow.ready(run.id, {
    url: run.openUrl,
    modeLabel: run.provider === 'chatgpt' ? 'GPT Pro' : 'Neon, 思考レベル: 高',
    newPage: run.requiresNewPage,
    tabId: 'tab-123',
  });
  await workflow.beginSend(run.id);
  return workflow.sent(run.id, {url});
}

test('conversation identity persists across processes and follow-up failures', async t => {
  const {directory, workflow} = await fixture(t);
  const first = await workflow.prepare(input);
  assert.equal(first.requiresNewPage, true);
  await submit(
    workflow,
    first,
    'https://gemini.google.com/app/first?utm_source=test#latest',
  );
  const restarted = new Workflow(new StateStore(directory));
  assert.equal(
    (await restarted.resume(first.id)).conversationUrl,
    'https://gemini.google.com/app/first',
  );
  await restarted.block(first.id, 'Browser disconnected while waiting');
  await assert.rejects(restarted.prepare(input), code('PENDING_OPERATION'));
  assert.equal((await restarted.resume(first.id)).phase, 'submitted');
  await restarted.complete(first.id, {answer: '```ts\nconst result = 1;\n```'});
  const next = await restarted.prepare({...input, prompt: 'Follow up'});
  assert.equal(next.openUrl, 'https://gemini.google.com/app/first');
  assert.equal(next.requiresNewPage, false);
  await assert.rejects(
    restarted.ready(next.id, {
      url: 'https://gemini.google.com/app/other',
      modeLabel: 'Neon, 思考レベル: 高',
    }),
    code('CONVERSATION_MISMATCH'),
  );
  await restarted.cancel(next.id);
  const separate = await restarted.prepare({
    ...input,
    project: 'another project',
  });
  assert.equal(separate.requiresNewPage, true);
});

test('beginSend is single-use and unknown submissions cannot be canceled or retried', async t => {
  const {workflow} = await fixture(t);
  const run = await workflow.prepare(input);
  await assert.rejects(workflow.beginSend(run.id), code('SEND_NOT_AUTHORIZED'));
  await assert.rejects(
    workflow.ready(run.id, {
      url: run.openUrl,
      modeLabel: 'Neon, 思考レベル: 高',
    }),
    code('NEW_PAGE_REQUIRED'),
  );
  await workflow.ready(run.id, {
    url: run.openUrl,
    modeLabel: 'Neon, 思考レベル: 高',
    newPage: true,
  });
  await workflow.beginSend(run.id);
  await workflow.block(run.id, 'Send click result unknown');
  await assert.rejects(workflow.beginSend(run.id), code('SEND_NOT_AUTHORIZED'));
  await assert.rejects(
    workflow.cancel(run.id),
    code('CANNOT_CANCEL_SUBMITTED'),
  );
  assert.equal((await workflow.resume(run.id)).phase, 'sending');
  await workflow.sent(run.id, {url: 'https://gemini.google.com/app/recovered'});
  assert.equal(
    (await workflow.resume(run.id)).conversationUrl,
    'https://gemini.google.com/app/recovered',
  );
});

test('idempotency is exact and prepareMany is atomic', async t => {
  const {workflow} = await fixture(t);
  const run = await workflow.prepare({...input, requestId: 'request-1'});
  const before = await fs.stat(workflow.store.filePath);
  assert.deepEqual(
    await workflow.prepare({...input, requestId: 'request-1'}),
    run,
  );
  assert.equal(
    (await fs.stat(workflow.store.filePath)).mtimeMs,
    before.mtimeMs,
  );
  await assert.rejects(
    workflow.prepare({...input, requestId: 'request-1', prompt: 'Different'}),
    code('REQUEST_ID_CONFLICT'),
  );
  await workflow.cancel(run.id);
  await assert.rejects(
    workflow.prepareMany([
      {...input, provider: 'chatgpt'},
      {...input, repository: {...repository, visibility: 'private'}},
    ]),
    code('PRIVATE_CODE_REQUIRED'),
  );
  assert.equal((await workflow.status()).runs.length, 1);
});

test('positive not-sent reconciliation recovers a pre-click crash without authorizing a send', async t => {
  const {workflow} = await fixture(t);
  const run = await workflow.prepare(input);
  await workflow.ready(run.id, {
    url: run.openUrl,
    modeLabel: 'Neon, 思考レベル: 高',
    newPage: true,
  });
  await workflow.beginSend(run.id);
  await assert.rejects(
    workflow.reconcileNotSent(run.id, {
      url: 'https://gemini.google.com/app/unrelated',
      reason: 'Inspected a different page',
    }),
    code('NEW_PAGE_REQUIRED'),
  );
  const recovered = await workflow.reconcileNotSent(run.id, {
    url: run.openUrl,
    reason:
      'Inspected the same tab: composer still holds the complete prompt, empty conversation, Send button available; no user message was submitted.',
  });
  assert.equal(recovered.phase, 'ready');
  assert.equal(recovered.sendingAt, undefined);
  assert.equal(recovered.reconciliations?.length, 1);
  await assert.rejects(
    workflow.sent(run.id, {url: 'https://gemini.google.com/app/recovered'}),
    code('INVALID_PHASE'),
  );
  await workflow.ready(run.id, {
    url: run.openUrl,
    modeLabel: 'Neon, 思考レベル: 高',
    newPage: true,
  });
  await workflow.beginSend(run.id);
  await workflow.sent(run.id, {url: 'https://gemini.google.com/app/recovered'});
  await assert.rejects(
    workflow.reconcileNotSent(run.id, {
      url: run.openUrl,
      reason: 'Cannot undo a sent operation',
    }),
    code('INVALID_PHASE'),
  );
});

test('an observed final failure frees the lane for corrective follow-up and retains its URL', async t => {
  const {workflow} = await fixture(t);
  const run = await workflow.prepare({...input, provider: 'chatgpt'});
  await assert.rejects(
    workflow.fail(run.id, {answer: 'Unavailable', reason: 'No submit yet'}),
    code('INVALID_PHASE'),
  );
  await submit(workflow, run, 'https://chatgpt.com/c/needs-access');
  await assert.rejects(
    workflow.fail(run.id, {answer: '', reason: 'Timed out'}),
    code('ANSWER_REQUIRED'),
  );
  const failed = await workflow.fail(run.id, {
    answer:
      'I cannot access the repository with the current GitHub connection.',
    reason:
      'Assistant finished without producing the requested PR because repository access failed.',
  });
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.result?.pullRequest, undefined);
  const followup = await workflow.prepare({
    ...input,
    provider: 'chatgpt',
    prompt: 'Access is now repaired. Please continue.',
  });
  assert.equal(followup.openUrl, 'https://chatgpt.com/c/needs-access');
  assert.equal(followup.requiresNewPage, false);
});

test('private Gemini needs explicit code and provider completion contracts differ', async t => {
  const {workflow} = await fixture(t);
  await assert.rejects(
    workflow.prepare({
      ...input,
      repository: {...repository, visibility: 'private'},
    }),
    code('PRIVATE_CODE_REQUIRED'),
  );
  const gemini = await workflow.prepare({
    ...input,
    repository: {...repository, visibility: 'private'},
    contextFiles: [{path: 'src/main.ts', sha256: 'a'.repeat(64), bytes: 42}],
  });
  await submit(workflow, gemini, 'https://gemini.google.com/app/private');
  await assert.rejects(
    workflow.complete(gemini.id, {answer: ''}),
    code('ANSWER_REQUIRED'),
  );
  const pr: VerifiedPullRequest = {
    url: `${repository.url}/pull/12`,
    number: 12,
    headBranch: 'fix/code',
    baseBranch: 'main',
    repository: 'example/project',
    verifiedAt: new Date().toISOString(),
  };
  await assert.rejects(
    workflow.complete(gemini.id, {answer: 'Code', pullRequest: pr}),
    code('UNEXPECTED_PULL_REQUEST'),
  );
  await workflow.complete(gemini.id, {answer: 'Code'});
  const chatgpt = await workflow.prepare({...input, provider: 'chatgpt'});
  await submit(workflow, chatgpt, 'https://chatgpt.com/c/repository-work');
  await assert.rejects(
    workflow.complete(chatgpt.id, {answer: 'I will open a PR.'}),
    code('PULL_REQUEST_REQUIRED'),
  );
  await assert.rejects(
    workflow.complete(chatgpt.id, {
      answer: 'Done',
      pullRequest: {...pr, url: 'https://github.com/example/other/pull/12'},
    }),
    code('INVALID_PULL_REQUEST'),
  );
  await assert.rejects(
    workflow.complete(chatgpt.id, {
      answer: 'Done',
      pullRequest: {...pr, headBranch: 'main'},
    }),
    code('INVALID_PULL_REQUEST'),
  );
  const completed = await workflow.complete(chatgpt.id, {
    answer: 'Opened PR 12',
    pullRequest: pr,
  });
  assert.equal(completed.phase, 'completed');
});

test('explicit new chats archive existing URLs only after accepted submission', async t => {
  const {workflow} = await fixture(t);
  await workflow.importSession({
    project: input.project,
    provider: input.provider,
    repository,
    url: 'https://gemini.google.com/app/imported',
  });
  const reset = await workflow.prepare({...input, newChat: true});
  await workflow.cancel(reset.id);
  assert.equal(
    (await workflow.status()).projects[0].conversations.gemini?.url,
    'https://gemini.google.com/app/imported',
  );
  const next = await workflow.prepare({...input, newChat: true});
  await submit(workflow, next, 'https://gemini.google.com/app/replacement');
  const project = (await workflow.status()).projects[0];
  assert.equal(
    project.archivedConversations.gemini?.[0].url,
    'https://gemini.google.com/app/imported',
  );
  assert.equal(
    project.conversations.gemini?.url,
    'https://gemini.google.com/app/replacement',
  );
  await assert.rejects(
    workflow.importSession({
      project: 'other',
      provider: 'gemini',
      repository,
      url: 'https://gemini.google.com/app/replacement',
    }),
    code('CONVERSATION_IN_USE'),
  );
});

test('URL and mode validation reject unrelated pages and credential-bearing URLs', () => {
  assert.equal(
    canonicalConversationUrl(
      'chatgpt',
      'https://chatgpt.com/g/g-test/c/123?model=pro#bottom',
    ),
    'https://chatgpt.com/g/g-test/c/123',
  );
  assert.equal(
    canonicalConversationUrl(
      'gemini',
      'https://gemini.google.com/u/1/app/abcdef',
    ),
    'https://gemini.google.com/u/1/app/abcdef',
  );
  for (const value of [
    'https://chatgpt.com/',
    'https://chatgpt.com/share/abc',
    'https://evil.example/c/abc',
    'https://chatgpt.com/c/abc?token=secret',
    'https://user:pass@chatgpt.com/c/abc',
  ])
    assert.throws(() => canonicalConversationUrl('chatgpt', value));
  assert.equal(
    canonicalRepositoryUrl('https://github.com/example/project.git').url,
    repository.url,
  );
  assert.throws(() =>
    canonicalRepositoryUrl('https://github.com/example/project/tree/main'),
  );
  assert.equal(validateMode('chatgpt', 'GPT-6 Pro'), 'GPT-6 Pro');
  assert.equal(
    validateMode('gemini', 'Neon, 思考レベル: 高'),
    'Neon, 思考レベル: 高',
  );
  assert.equal(
    validateMode('gemini', '4 Neon, Thinking level: High'),
    '4 Neon, Thinking level: High',
  );
  for (const label of [
    'Fast',
    'Pro',
    'High',
    'Neon',
    'Thinking: High',
    'Neon, 思考レベル: 標準',
    'Neon, 思考レベル: 低',
    'Hydrogen, 思考レベル: 高',
    'Carbon, Thinking level: High',
    '自動モード, 思考レベル: 高',
    'Neon unavailable, 思考レベル: 高',
  ])
    assert.throws(() => validateMode('gemini', label));
  for (const label of [
    'Thinking',
    'Upgrade to Pro',
    'Pro plan',
    'not Pro',
    'Pro unavailable',
    'Pro or Thinking',
  ])
    assert.throws(() => validateMode('chatgpt', label));
});

test('malformed durable state fails without being replaced', async t => {
  const {workflow} = await fixture(t);
  await workflow.prepare(input);
  const corrupt =
    '{"version": 1, "privatePrompt": "SECRET_CORRUPTION_MARKER", broken';
  await fs.writeFile(workflow.store.filePath, corrupt);
  await assert.rejects(
    workflow.prepare({...input, project: 'new'}),
    error =>
      code('STATE_CORRUPT')(error) &&
      !String(error).includes('SECRET_CORRUPTION_MARKER'),
  );
  assert.equal(await fs.readFile(workflow.store.filePath, 'utf8'), corrupt);
});

test('independent processes cannot both prepare a send for the same project', async t => {
  const {directory, workflow} = await fixture(t);
  const workflowUrl = new URL('../src/workflow.ts', import.meta.url).href;
  const storeUrl = new URL('../src/store.ts', import.meta.url).href;
  const script = `import {Workflow} from ${JSON.stringify(workflowUrl)}; import {StateStore} from ${JSON.stringify(storeUrl)}; const workflow = new Workflow(new StateStore(process.argv[1])); try { const run = await workflow.prepare(JSON.parse(process.argv[2])); console.log(JSON.stringify({id:run.id})); } catch(e) { console.log(JSON.stringify({code:e.code})); }`;
  const child = () =>
    new Promise<{id?: string; code?: string}>((resolve, reject) => {
      const process = spawn(
        globalThis.process.execPath,
        ['--input-type=module', '-e', script, directory, JSON.stringify(input)],
        {stdio: ['ignore', 'pipe', 'pipe']},
      );
      let output = '';
      let stderr = '';
      process.stdout.on('data', value => {
        output += String(value);
      });
      process.stderr.on('data', value => {
        stderr += String(value);
      });
      process.on('error', reject);
      process.on('exit', exitCode => {
        if (exitCode !== 0) reject(new Error(stderr));
        else {
          try {
            resolve(JSON.parse(output));
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  const results = await Promise.all([child(), child(), child(), child()]);
  assert.equal(results.filter(result => result.id).length, 1);
  assert.equal(
    results.filter(result => result.code === 'PENDING_OPERATION').length,
    3,
  );
  assert.equal((await workflow.status()).runs.length, 1);
  if (globalThis.process.platform !== 'win32')
    assert.equal((await fs.stat(workflow.store.filePath)).mode & 0o777, 0o600);
});
