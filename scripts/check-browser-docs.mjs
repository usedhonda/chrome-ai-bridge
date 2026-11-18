/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = [
  'README.md',
  'AGENTS.md',
  'docs/SPEC.md',
  'docs/README.md',
  'docs/tool-reference.md',
  'docs/user/setup.md',
  'docs/user/workflows.md',
  'docs/user/troubleshooting.md',
  'skills/ask-ai/SKILL.md',
];
for (const filename of docs) {
  const full = path.join(root, filename);
  const text = readFileSync(full, 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    assert.ok(
      existsSync(path.resolve(path.dirname(full), target)),
      `${filename}: missing link target ${target}`,
    );
  }
}
const reference = readFileSync(
  path.join(root, 'docs/tool-reference.md'),
  'utf8',
);
for (const command of [
  'prepare',
  'ready',
  'begin-send',
  'sent',
  'complete',
  'fail',
  'reconcile-not-sent',
  'resume',
  'prompt',
  'status',
  'block',
  'cancel',
  'doctor',
  'import-session',
]) {
  assert.ok(
    reference.includes(command),
    `Missing CLI reference for ${command}`,
  );
}
const skill = readFileSync(path.join(root, 'skills/ask-ai/SKILL.md'), 'utf8');
assert.match(skill, /^---\r?\nname: ask-ai\r?\ndescription:/);
assert.ok(
  !skill.includes('allowed-tools:'),
  'Shared skill must not restrict tools to a harness-specific allowlist.',
);
console.log(
  `Checked ${docs.length} active documents and shared skill links. No browser or daemon was started.`,
);
