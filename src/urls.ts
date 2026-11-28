/**
 * @license
 * Copyright 2026 usedhonda
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Provider} from './types.ts';
import {WorkflowError} from './types.ts';

function parseHttps(value: string): URL {
  if (typeof value !== 'string' || value.trim() !== value) {
    throw new WorkflowError(
      'INVALID_URL',
      'Expected an HTTPS URL without surrounding whitespace.',
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WorkflowError('INVALID_URL', `Invalid URL: ${value}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new WorkflowError(
      'INVALID_URL',
      'URLs must use HTTPS without credentials or a custom port.',
    );
  }
  for (const key of url.searchParams.keys()) {
    if (
      /^(?:access_?token|refresh_?token|id_?token|token|api_?key|key|password|passwd|secret|authorization|auth|code)$/i.test(
        key,
      )
    ) {
      throw new WorkflowError(
        'INVALID_URL',
        'Credential-bearing URLs cannot be saved.',
      );
    }
  }
  return url;
}

export function providerHome(provider: Provider): string {
  if (provider === 'chatgpt') return 'https://chatgpt.com/';
  if (provider === 'gemini') return 'https://gemini.google.com/app';
  throw new WorkflowError(
    'INVALID_PROVIDER',
    'Provider must be chatgpt or gemini.',
  );
}

export function canonicalConversationUrl(
  provider: Provider,
  value: string,
): string {
  const url = parseHttps(value);
  const pathname = url.pathname.replace(/\/$/, '');
  const id = '[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}';
  const matches =
    provider === 'chatgpt'
      ? url.hostname === 'chatgpt.com' &&
        new RegExp(`^/(?:g/${id}/)?c/${id}$`).test(pathname)
      : provider === 'gemini'
        ? url.hostname === 'gemini.google.com' &&
          new RegExp(`^/(?:u/[0-9]+/)?app/${id}$`).test(pathname)
        : false;
  if (!matches) {
    throw new WorkflowError(
      'INVALID_CONVERSATION_URL',
      `Expected a ${provider} conversation URL; home, login, and share URLs cannot be saved.`,
    );
  }
  return `${url.origin}${pathname}`;
}

/** Accept the provider's empty-chat page only while creating a new conversation. */
export function canonicalNewChatUrl(provider: Provider, value: string): string {
  const url = parseHttps(value);
  if (
    [...url.searchParams.keys()].some(key => /temporary|incognito/i.test(key))
  ) {
    throw new WorkflowError(
      'PERSISTENT_CHAT_REQUIRED',
      'Temporary chats cannot retain a reusable conversation URL. Disable temporary chat before sending.',
    );
  }
  const pathname = url.pathname.replace(/\/$/, '');
  if (
    provider === 'chatgpt' &&
    url.hostname === 'chatgpt.com' &&
    pathname === ''
  ) {
    return providerHome(provider);
  }
  if (
    provider === 'gemini' &&
    url.hostname === 'gemini.google.com' &&
    /^\/(?:u\/[0-9]+\/)?app$/.test(pathname)
  ) {
    return `${url.origin}${pathname}`;
  }
  throw new WorkflowError(
    'NEW_PAGE_REQUIRED',
    `Open a new ${provider} page at ${providerHome(provider)} for this project.`,
  );
}

export function canonicalRepositoryUrl(value: string): {
  url: string;
  owner: string;
  name: string;
} {
  const url = parseHttps(value);
  const match =
    /^\/([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)\/([a-zA-Z0-9_.-]+?)\/?$/.exec(
      url.pathname,
    );
  if (url.hostname !== 'github.com' || !match) {
    throw new WorkflowError(
      'INVALID_REPOSITORY',
      'Repository URL must be https://github.com/owner/repository.',
    );
  }
  const owner = match[1];
  const name = match[2].replace(/\.git$/i, '');
  if (!name || name === '.' || name === '..') {
    throw new WorkflowError('INVALID_REPOSITORY', 'Invalid repository name.');
  }
  return {url: `https://github.com/${owner}/${name}`, owner, name};
}

export function validateMode(provider: Provider, label: string): string {
  if (typeof label !== 'string' || !label.trim()) {
    throw new WorkflowError(
      'MODE_REQUIRED',
      'Record the selected model/mode label observed in the browser before sending.',
    );
  }
  const normalized = label.trim();
  const unavailableOrAmbiguous =
    /\b(?:not|unavailable|disabled|unselected|off|false|or|auto|automatic)\b|無効|未選択|利用不可|使用不可|使えません|非対応|なし|無し|自動|または|又は/i.test(
      normalized,
    );
  // These are selected-mode labels supplied by the browser observation, not page-wide text.
  const valid =
    !unavailableOrAmbiguous &&
    (provider === 'chatgpt'
      ? /\bpro\b/i.test(normalized) &&
        !/\b(?:upgrade|plan|subscription)\b|プラン|アップグレード/i.test(
          normalized,
        )
      : provider === 'gemini' &&
        /\bcarbon\b/i.test(normalized) &&
        /(?:思考レベル|thinking(?:\s+level)?)\s*[:：]?\s*(?:高|high\b)|\bhigh\s+thinking\b/i.test(
          normalized,
        ) &&
        !/\b(?:fast|quick|low|minimal|medium|standard|hydrogen|neon)\b|高速|低|中|標準/i.test(
          normalized,
        ));
  if (!valid) {
    throw new WorkflowError(
      'MODE_REQUIRED',
      `${provider === 'chatgpt' ? 'ChatGPT Pro' : 'Gemini Carbon with 思考レベル: 高'} must be visibly selected; weaker modes cannot be used silently.`,
    );
  }
  return normalized;
}
