#!/usr/bin/env node
/**
 * CLI Entry Point for chrome-ai-bridge
 *
 * Launches Chrome AI Bridge daemon with browser-globals mock in a child process.
 *
 * Why child process:
 * - main.js may intentionally enter a never-returning proxy path.
 * - awaiting dynamic import(main.js) in-process can trigger unsettled
 *   top-level-await warnings and startup failure in that path.
 */

import path from 'node:path';
import process from 'node:process';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockPath = path.join(__dirname, 'browser-globals-mock.mjs');
const mainPath = path.join(__dirname, '..', 'build', 'src', 'main.js');

const child = spawn(
  process.execPath,
  ['--import', mockPath, mainPath, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: process.env,
  },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});

process.on('exit', () => {
  if (!child.killed) {
    child.kill('SIGTERM');
  }
});

process.on('SIGTERM', () => child?.kill('SIGTERM'));
process.on('SIGINT', () => child?.kill('SIGINT'));
