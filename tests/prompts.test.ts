/**
 * @license
 * Copyright 2026 usedhonda
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {
  collectContext,
  fencedText,
  MAX_CONTEXT_BYTES,
  readTextFile,
} from '../src/context.ts';
import {preparePrompt} from '../src/prompts.ts';
import type {Repository} from '../src/types.ts';

const repository: Repository = {
  url: 'https://github.com/example/project',
  owner: 'example',
  name: 'project',
  visibility: 'private',
};

test('private Gemini preserves exact source excerpts and fences while ChatGPT only receives the repository URL', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'cab-context-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const source =
    'const heading = "```";\r\nfunction run() {\r\n  return `secret-project-code`;\r\n}\r\n';
  writeFileSync(path.join(root, 'source.ts'), source);
  const context = collectContext(root, ['source.ts:2:4']);
  assert.equal(
    context[0].content,
    'function run() {\r\n  return `secret-project-code`;\r\n}\r\n',
  );
  assert.equal(context[0].startLine, 2);
  assert.equal(context[0].endLine, 4);
  const question = '変更を実装して。\n\n具体的なコードを示す。';
  const gemini = preparePrompt({
    project: 'project',
    provider: 'gemini',
    repository,
    question,
    context,
  });
  assert.ok(gemini.prompt.includes(context[0].content));
  assert.ok(gemini.prompt.includes(question));
  assert.ok(gemini.prompt.includes('source.ts (lines 2-4)'));
  const chatgpt = preparePrompt({
    project: 'project',
    provider: 'chatgpt',
    repository,
    question,
    context,
  });
  assert.ok(chatgpt.prompt.includes(repository.url));
  assert.ok(chatgpt.prompt.includes('open a real pull request'));
  assert.ok(!chatgpt.prompt.includes('secret-project-code'));
  assert.deepEqual(chatgpt.contextFiles, []);
  assert.ok(fencedText(source).startsWith('````text\n'));
  // Many short inline-code spans must not exhaust the JavaScript argument stack.
  const manySpans = '`x'.repeat(MAX_CONTEXT_BYTES / 2);
  assert.equal(fencedText(manySpans), `\`\`\`text\n${manySpans}\n\`\`\``);
});

test('Gemini private URL-only is rejected; public prompts still state that the repository is unreadable', () => {
  const input = {
    project: 'project',
    provider: 'gemini' as const,
    repository,
    question: 'Review the implementation',
  };
  assert.throws(() => preparePrompt(input), {code: 'PRIVATE_CONTEXT_REQUIRED'});
  const publicInput = preparePrompt({
    ...input,
    repository: {...repository, visibility: 'public'},
  });
  assert.ok(publicInput.prompt.includes(repository.url));
  assert.match(publicInput.prompt, /You cannot read this repository/);
  assert.match(publicInput.prompt, /even though it is public/);
  assert.match(publicInput.prompt, /handled separately by ChatGPT Pro/);
  assert.ok(publicInput.prompt.includes('Return the result in this chat'));
});

test('explicit context rejects traversal, credential aliases, binary and oversized input without truncation', t => {
  const outer = mkdtempSync(path.join(tmpdir(), 'cab-context-'));
  t.after(() => rmSync(outer, {recursive: true, force: true}));
  const root = path.join(outer, 'repo');
  mkdirSync(root);
  writeFileSync(path.join(outer, 'outside.ts'), 'outside source');
  writeFileSync(path.join(root, '.env'), 'TOKEN=private');
  writeFileSync(path.join(root, 'binary.ts'), Buffer.from([1, 0, 2]));
  writeFileSync(path.join(root, 'huge.ts'), 'a'.repeat(MAX_CONTEXT_BYTES + 1));
  assert.throws(() => collectContext(root, ['../outside.ts']), {
    code: 'CONTEXT_OUTSIDE_ROOT',
  });
  assert.throws(() => collectContext(root, ['.env']), {
    code: 'RESTRICTED_CONTEXT',
  });
  assert.throws(() => collectContext(root, ['binary.ts']), {
    code: 'BINARY_CONTEXT',
  });
  assert.throws(() => collectContext(root, ['huge.ts']), {
    code: 'CONTEXT_LIMIT',
  });
  assert.throws(() => collectContext(root, ['huge.ts:2:3']), {
    code: 'INVALID_RANGE',
  });
  assert.throws(() => readTextFile(root, 100));
  if (process.platform !== 'win32') {
    symlinkSync(path.join(outer, 'outside.ts'), path.join(root, 'escape.ts'));
    symlinkSync('.env', path.join(root, 'innocent.ts'));
    assert.throws(() => collectContext(root, ['escape.ts']), {
      code: 'CONTEXT_OUTSIDE_ROOT',
    });
    assert.throws(() => collectContext(root, ['innocent.ts']), {
      code: 'RESTRICTED_CONTEXT',
    });
  }
});
