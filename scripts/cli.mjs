#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error('chrome-ai-bridge requires Node.js 22.12.0 or newer.');
  process.exitCode = 1;
} else if (process.argv[2] === 'legacy') {
  // Compatibility is an explicit choice, never a failed-browser fallback.
  const script = fileURLToPath(new URL('./legacy-cab', import.meta.url));
  const child = spawn('bash', [script, ...process.argv.slice(3)], {
    stdio: 'inherit',
    shell: false,
  });
  child.on('error', () => {
    console.error(
      'Legacy mode needs Bash and the v2 Chrome extension/daemon setup.',
    );
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
} else {
  try {
    const {runCli, cliError} = await import('../build/src/browser-use/cli.js');
    await runCli().catch(cliError);
  } catch (error) {
    console.error(
      error?.code === 'ERR_MODULE_NOT_FOUND'
        ? 'Build chrome-ai-bridge first: npm ci && npm run build'
        : `Unable to start chrome-ai-bridge: ${error.message}`,
    );
    process.exitCode = 1;
  }
}
