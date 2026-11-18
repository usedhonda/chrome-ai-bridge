#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 usedhonda
 * SPDX-License-Identifier: Apache-2.0
 */

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error('chrome-ai-bridge requires Node.js 22.18.0 or newer.');
  process.exitCode = 1;
} else {
  try {
    const {runCli, cliError} = await import('../build/cli.js');
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
