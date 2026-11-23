/**
 * @license
 * Copyright 2026 usedhonda
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import type {TestContext} from 'node:test';

const packageRoot = path.resolve(import.meta.dirname, '..');
const entrypoint = path.join(packageRoot, 'scripts', 'cli.mjs');
const repository = 'https://github.com/example/project';

interface Plan {
  runId: string;
  provider: string;
  phase: string;
  completed: boolean;
  sendAuthorized: boolean;
  navigation: {url: string; newPage: boolean; tabHint?: string};
  conversationUrl?: string;
  steps: string[];
  result?: {answer: string};
}

function workspace(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cab-cli-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const state = path.join(directory, 'state');
  const run = (
    args: string[],
    options: {input?: string; executable?: string; session?: string} = {},
  ) => {
    const result = spawnSync(
      process.execPath,
      [options.executable ?? entrypoint, ...args],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          CAB_STATE_DIR: state,
          CAB_SESSION_ID: options.session ?? 'irrelevant-cli-session',
        },
        input: options.input,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null, `CLI was interrupted: ${result.stderr}`);
    return result;
  };
  const success = (args: string[], options?: Parameters<typeof run>[1]) => {
    const result = run(args, options);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const fail = (args: string[], code: string) => {
    const result = run(args);
    assert.equal(result.status, 1, result.stdout);
    const error = JSON.parse(result.stderr) as {
      error: {code: string; message: string};
    };
    assert.equal(error.error.code, code, error.error.message);
    return error.error;
  };
  return {directory, state, run, success, fail};
}

function taskArgs(
  provider: string,
  project: string,
  visibility = 'public',
  task = 'Review the request handling and provide the required output.',
): string[] {
  return [
    'prepare',
    provider,
    task,
    '--project',
    project,
    '--repo',
    repository,
    '--visibility',
    visibility,
  ];
}

test('private Gemini preserves source and final code across separate CLI processes and aliases', t => {
  const w = workspace(t);
  const question =
    'Review this code.\r\nKeep `formatting` and 日本語 intact.\r\n';
  const source =
    'export function message() {\r\n  return "``` quoted";\r\n}\r\n';
  const answer =
    'Use this implementation:\n\n```ts\nexport const value = "日本語";\n```\n';
  fs.writeFileSync(path.join(w.directory, 'question.txt'), question);
  fs.writeFileSync(path.join(w.directory, 'source.ts'), source);
  fs.writeFileSync(path.join(w.directory, 'answer.md'), answer);
  const prepared = JSON.parse(
    w.success(
      [
        'gemini',
        '--project',
        'persistent-project',
        '--repo',
        repository,
        '--visibility',
        'private',
        '--prompt-file',
        'question.txt',
        '--context',
        'source.ts',
      ],
      {executable: path.join(packageRoot, 'scripts', 'cab'), session: 'claude'},
    ),
  ) as Plan;
  assert.equal(prepared.phase, 'prepared');
  assert.equal(prepared.completed, false);
  assert.equal(prepared.sendAuthorized, false);
  assert.equal(prepared.navigation.newPage, true);
  const prompt = w.success(['prompt', prepared.runId]);
  assert.ok(prompt.includes(question));
  assert.ok(prompt.includes(source));
  assert.ok(prompt.includes('````text'));

  const ready = JSON.parse(
    w.success([
      'ready',
      prepared.runId,
      '--url',
      'https://gemini.google.com/app',
      '--mode',
      'Thinking: High',
      '--new-page',
      '--tab',
      'provider-tab-42',
    ]),
  ) as Plan;
  assert.equal(
    ready.navigation.newPage,
    false,
    'Readiness must continue the page already opened',
  );
  assert.equal(ready.navigation.tabHint, 'provider-tab-42');
  const sending = JSON.parse(w.success(['begin-send', prepared.runId])) as Plan;
  assert.equal(sending.sendAuthorized, true);
  const chatUrl = 'https://gemini.google.com/app/permanent-conversation';
  w.success(['sent', prepared.runId, '--url', chatUrl]);
  const finished = JSON.parse(
    w.success(['complete', prepared.runId, '--answer-file', 'answer.md']),
  ) as Plan;
  assert.equal(finished.phase, 'completed');
  assert.equal(finished.result?.answer, answer);

  const resumed = JSON.parse(
    w.success(['resume', prepared.runId], {
      executable: path.join(
        packageRoot,
        'skills',
        'ask-ai',
        'scripts',
        'ask-ai',
      ),
      session: 'codex',
    }),
  ) as Plan;
  assert.equal(resumed.conversationUrl, chatUrl);
  assert.equal(resumed.result?.answer, answer);
  w.fail(
    taskArgs('gemini', 'persistent-project', 'private'),
    'PRIVATE_CONTEXT_REQUIRED',
  );
  const followup = JSON.parse(
    w.success([
      ...taskArgs(
        'gemini',
        'persistent-project',
        'private',
        'Check the revised code.',
      ),
      '--context',
      'source.ts',
    ]),
  ) as Plan;
  assert.equal(followup.navigation.url, chatUrl);
  assert.equal(followup.navigation.newPage, false);
});

test('both-provider preparation is atomic and private source is sent only to Gemini', t => {
  const w = workspace(t);
  const args = taskArgs('both', 'atomic-project', 'private');
  w.fail(args, 'PRIVATE_CONTEXT_REQUIRED');
  const empty = JSON.parse(w.success(['status'])) as {
    projects: unknown[];
    runs: unknown[];
  };
  assert.deepEqual(empty.projects, []);
  assert.deepEqual(empty.runs, []);

  const source = 'export const privateSentinel = "PRIVATE_CONTEXT_ONLY";\n';
  fs.writeFileSync(path.join(w.directory, 'private.ts'), source);
  const result = JSON.parse(
    w.success([...args, '--context', 'private.ts']),
  ) as {tasks: Plan[]};
  assert.equal(result.tasks.length, 2);
  const chatgpt = result.tasks.find(run => run.provider === 'chatgpt')!;
  const gemini = result.tasks.find(run => run.provider === 'gemini')!;
  assert.ok(chatgpt.runId && gemini.runId && chatgpt.runId !== gemini.runId);
  assert.ok(
    !w.success(['prompt', chatgpt.runId]).includes('PRIVATE_CONTEXT_ONLY'),
  );
  assert.ok(w.success(['prompt', gemini.runId]).includes(source));
  assert.equal(chatgpt.navigation.url, 'https://chatgpt.com/');
  assert.equal(gemini.navigation.url, 'https://gemini.google.com/app');
});

test('interrupted sends resume without reauthorization and ChatGPT cannot complete with chat-only output', t => {
  const w = workspace(t);
  const prepared = JSON.parse(
    w.success(taskArgs('chatgpt', 'uncertain-send')),
  ) as Plan;
  w.success([
    'ready',
    prepared.runId,
    '--url',
    'https://chatgpt.com/',
    '--mode',
    'Pro',
    '--new-page',
    '--tab',
    'chatgpt-tab',
  ]);
  assert.equal(
    (JSON.parse(w.success(['begin-send', prepared.runId])) as Plan)
      .sendAuthorized,
    true,
  );
  const resumed = JSON.parse(w.success(['resume', prepared.runId])) as Plan;
  assert.equal(resumed.phase, 'sending');
  assert.equal(resumed.sendAuthorized, false);
  assert.equal(resumed.navigation.newPage, false);
  assert.ok(resumed.steps.some(step => /Do not send again/i.test(step)));
  w.fail(['begin-send', prepared.runId], 'SEND_NOT_AUTHORIZED');
  w.fail(['cancel', prepared.runId], 'CANNOT_CANCEL_SUBMITTED');
  w.fail(taskArgs('chatgpt', 'uncertain-send'), 'PENDING_OPERATION');
  w.fail(
    ['sent', prepared.runId, '--url', 'https://evil.example/c/captured'],
    'INVALID_CONVERSATION_URL',
  );
  assert.equal(
    (JSON.parse(w.success(['resume', prepared.runId])) as Plan).phase,
    'sending',
  );

  w.success([
    'sent',
    prepared.runId,
    '--url',
    'https://chatgpt.com/c/stable-conversation',
  ]);
  fs.writeFileSync(
    path.join(w.directory, 'answer.md'),
    'I will create a PR later.\n',
  );
  w.fail(
    ['complete', prepared.runId, '--answer-file', 'answer.md'],
    'MISSING_ARGUMENT',
  );
  w.fail(
    [
      'complete',
      prepared.runId,
      '--answer-file',
      'answer.md',
      '--pr',
      'https://github.com/unrelated/project/pull/1',
    ],
    'INVALID_PULL_REQUEST',
  );
  const waiting = JSON.parse(w.success(['resume', prepared.runId])) as Plan;
  assert.equal(waiting.phase, 'submitted');
  assert.equal(waiting.completed, false);
  assert.equal(
    waiting.conversationUrl,
    'https://chatgpt.com/c/stable-conversation',
  );
  const failed = JSON.parse(
    w.success([
      'fail',
      prepared.runId,
      '--answer-file',
      'answer.md',
      '--reason',
      'The provider ended its turn without producing the required PR.',
    ]),
  ) as Plan;
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.completed, false);
  const followup = JSON.parse(
    w.success(
      taskArgs(
        'chatgpt',
        'uncertain-send',
        'public',
        'Please implement and open the requested PR.',
      ),
    ),
  ) as Plan;
  assert.equal(
    followup.navigation.url,
    'https://chatgpt.com/c/stable-conversation',
  );
  assert.equal(followup.navigation.newPage, false);
});

test('project identity and provider identity survive CLI process boundaries independently', t => {
  const w = workspace(t);
  const importedUrl = 'https://chatgpt.com/c/imported-first-project';
  w.success([
    'import-session',
    'chatgpt',
    '--project',
    'first-project',
    '--repo',
    repository,
    '--visibility',
    'public',
    '--url',
    importedUrl,
  ]);
  const first = JSON.parse(
    w.success(taskArgs('chatgpt', 'first-project')),
  ) as Plan;
  const second = JSON.parse(
    w.success(taskArgs('chatgpt', 'second-project')),
  ) as Plan;
  const gemini = JSON.parse(
    w.success(taskArgs('gemini', 'first-project')),
  ) as Plan;
  assert.equal(first.navigation.url, importedUrl);
  assert.equal(first.navigation.newPage, false);
  assert.equal(second.navigation.url, 'https://chatgpt.com/');
  assert.equal(second.navigation.newPage, true);
  assert.equal(gemini.navigation.url, 'https://gemini.google.com/app');
  assert.equal(gemini.navigation.newPage, true);
  w.fail(
    [
      'ready',
      first.runId,
      '--url',
      'https://chatgpt.com/c/other-project',
      '--mode',
      'Pro',
    ],
    'CONVERSATION_MISMATCH',
  );
});

test('stdin and shell metacharacters remain literal prompt data', t => {
  const w = workspace(t);
  const marker = path.join(w.directory, 'should-not-exist');
  const literal = `Keep this literal:\n$(touch ${marker})\n\`touch ${marker}\`\n"quoted"\\path\n`;
  const fromStdin = JSON.parse(
    w.success(
      [
        'ask',
        'gemini',
        '--project',
        'stdin-project',
        '--repo',
        repository,
        '--visibility',
        'public',
        '--prompt-file',
        '-',
      ],
      {input: literal},
    ),
  ) as Plan;
  assert.ok(w.success(['prompt', fromStdin.runId]).includes(literal));
  const positional = JSON.parse(
    w.success(taskArgs('gemini', 'argv-project', 'public', literal)),
  ) as Plan;
  assert.ok(w.success(['prompt', positional.runId]).includes(literal));
  assert.equal(fs.existsSync(marker), false);
});

test('invalid repository URLs, missing source, and binary input cannot create workflow state', t => {
  const w = workspace(t);
  const invalidUrlArgs = taskArgs('chatgpt', 'bad-repository');
  invalidUrlArgs[invalidUrlArgs.indexOf(repository)] =
    'https://github.com@evil.example/example/project';
  w.fail(invalidUrlArgs, 'INVALID_URL');
  fs.writeFileSync(
    path.join(w.directory, 'binary.bin'),
    Buffer.from([0, 1, 2, 3]),
  );
  w.fail(
    [
      ...taskArgs('gemini', 'binary-context', 'private'),
      '--context',
      'binary.bin',
    ],
    'BINARY_CONTEXT',
  );
  w.fail(
    [
      ...taskArgs('gemini', 'missing-context', 'private'),
      '--context',
      'missing.ts',
    ],
    'CLI_ERROR',
  );
  const status = JSON.parse(w.success(['status'])) as {
    projects: unknown[];
    runs: unknown[];
  };
  assert.deepEqual(status.projects, []);
  assert.deepEqual(status.runs, []);
});

test('a conversation that reached its length limit rolls over with the earlier premises', t => {
  const w = workspace(t);
  const original = 'Add the foreground melody ranking and open a draft PR.';
  const first = JSON.parse(
    w.success(taskArgs('chatgpt', 'length-limit', 'public', original)),
  ) as Plan;
  w.success([
    'ready',
    first.runId,
    '--url',
    'https://chatgpt.com/',
    '--mode',
    'Pro',
    '--new-page',
  ]);
  w.success(['begin-send', first.runId]);
  w.success(['sent', first.runId, '--url', 'https://chatgpt.com/c/limit-hit']);
  fs.writeFileSync(
    path.join(w.directory, 'limit.md'),
    'The conversation reached its length limit.\n',
  );
  w.success([
    'fail',
    first.runId,
    '--answer-file',
    'limit.md',
    '--reason',
    'Conversation length limit before the PR.',
  ]);
  const next = [
    ...taskArgs('chatgpt', 'length-limit', 'public', 'Finish the work.'),
    '--new-chat',
  ];
  w.fail(
    [
      ...taskArgs('chatgpt', 'length-limit', 'public', 'Finish the work.'),
      '--handoff-file',
      'limit.md',
    ],
    'HANDOFF_WITHOUT_NEW_CHAT',
  );
  fs.writeFileSync(
    path.join(w.directory, 'handoff.md'),
    'Branch feat/melody has one commit; the PR is not open yet.\n',
  );
  const rolled = JSON.parse(
    w.success([...next, '--handoff-file', 'handoff.md']),
  ) as Plan;
  assert.equal(rolled.navigation.newPage, true);
  const prompt = w.success(['prompt', rolled.runId]);
  assert.match(prompt, /## Continuation from an earlier conversation/);
  assert.match(prompt, /Branch feat\/melody has one commit/);
  assert.ok(!prompt.includes(original), 'the latest request is the only task');
  assert.ok(prompt.indexOf('Finish the work.') < prompt.indexOf('### Handoff'));
});
