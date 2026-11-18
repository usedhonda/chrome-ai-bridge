/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {ContextFile} from './types.js';
import {WorkflowError} from './types.js';

export const MAX_CONTEXT_BYTES = 256 * 1024;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_PROMPT_BYTES = 512 * 1024;
export const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

export interface SourceContext extends ContextFile {
  content: string;
}

/** Read a bounded UTF-8 file (or stdin), preserving newlines and code fences. */
export function readTextFile(filename: string, limit: number): string {
  const fd =
    filename === '-'
      ? 0
      : fs.openSync(
          filename,
          fs.constants.O_RDONLY |
            fs.constants.O_NONBLOCK |
            fs.constants.O_NOFOLLOW,
        );
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    if (filename !== '-' && !fs.fstatSync(fd).isFile()) {
      throw new WorkflowError('INVALID_FILE', 'Expected a regular text file.');
    }
    const buffer = Buffer.alloc(Math.min(limit + 1, 64 * 1024));
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count;
      if (bytes > limit) {
        throw new WorkflowError(
          'INPUT_TOO_LARGE',
          `Text exceeds ${limit} bytes. Select smaller explicit excerpts; nothing was truncated.`,
        );
      }
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
  } finally {
    if (fd !== 0) fs.closeSync(fd);
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.includes(0)) {
    throw new WorkflowError(
      'BINARY_CONTEXT',
      'Binary files cannot be prompt context.',
    );
  }
  try {
    return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(
      buffer,
    );
  } catch {
    throw new WorkflowError(
      'INVALID_ENCODING',
      'Prompt context must be valid UTF-8.',
    );
  }
}

function restrictedPath(relative: string): boolean {
  const segments = relative.replaceAll('\\', '/').split('/');
  return segments.some(segment => {
    const value = segment.toLowerCase();
    return (
      ['.git', '.ssh', 'node_modules', '.aws', '.gnupg'].includes(value) ||
      /^\.env(?:\.|$)/.test(value) ||
      /\.(?:pem|key|p12|pfx|keystore)$/.test(value) ||
      /^(?:id_rsa|id_ed25519|credentials(?:\.json)?|secrets?\.json)$/.test(
        value,
      )
    );
  });
}

/** Explicit files only; no repository crawl, symlink escape, or silent truncation. */
export function collectContext(root: string, specs: string[]): SourceContext[] {
  if (specs.length > 40) {
    throw new WorkflowError(
      'CONTEXT_LIMIT',
      'Select at most 40 context files or excerpts.',
    );
  }
  const base = fs.realpathSync(root);
  const result: SourceContext[] = [];
  let total = 0;
  for (const spec of specs) {
    const match = /^(.*):(\d+):(\d+)$/.exec(spec);
    const filename = match ? match[1] : spec;
    const start = match ? Number(match[2]) : undefined;
    const end = match ? Number(match[3]) : undefined;
    if (
      start !== undefined &&
      (!Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 1 ||
        end! < start)
    ) {
      throw new WorkflowError(
        'INVALID_RANGE',
        'Context ranges use 1-based inclusive START:END.',
      );
    }
    const requested = path.resolve(base, filename);
    const resolved = fs.realpathSync(requested);
    const relative = path.relative(base, resolved);
    const requestedRelative = path.relative(base, requested);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      requestedRelative === '..' ||
      requestedRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(requestedRelative)
    ) {
      throw new WorkflowError(
        'CONTEXT_OUTSIDE_ROOT',
        'Context files must resolve inside --root.',
      );
    }
    if (restrictedPath(relative) || restrictedPath(requestedRelative)) {
      throw new WorkflowError(
        'RESTRICTED_CONTEXT',
        'Credential files and dependency/internal directories are not source context.',
      );
    }
    const original = readTextFile(resolved, MAX_FILE_BYTES);
    let content = original;
    if (start !== undefined) {
      // Keep original line endings and the final newline of every selected line.
      const lines = original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      if (end! > lines.length) {
        throw new WorkflowError(
          'INVALID_RANGE',
          `Requested range exceeds the ${lines.length} lines in ${relative}.`,
        );
      }
      content = lines.slice(start - 1, end).join('');
    }
    if (!content.trim()) {
      throw new WorkflowError(
        'EMPTY_CONTEXT',
        `No source text in ${relative}.`,
      );
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    total += bytes;
    if (total > MAX_CONTEXT_BYTES) {
      throw new WorkflowError(
        'CONTEXT_LIMIT',
        `Combined context exceeds ${MAX_CONTEXT_BYTES} bytes. Select smaller explicit excerpts; nothing was truncated.`,
      );
    }
    result.push({
      path: relative.split(path.sep).join('/'),
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes,
      ...(start === undefined ? {} : {startLine: start, endLine: end}),
      content,
    });
  }
  return result;
}

export function fencedText(content: string): string {
  let longest = 2;
  for (const match of content.matchAll(/`+/g))
    longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${content}${content.endsWith('\n') ? '' : '\n'}${fence}`;
}
