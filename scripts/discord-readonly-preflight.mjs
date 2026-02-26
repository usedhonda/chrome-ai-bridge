#!/usr/bin/env node
/**
 * Discord read-only preflight checker.
 *
 * Verifies that the bot token can read target channels and read history.
 * Uses GET only.
 */

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

const DISCORD_API_BASE_URL = 'https://discord.com/api/v10/';
const DEFAULT_LOCAL_ENV_FILE = '.local/discord-collector/.env';

const PERM = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
};

function parseChannelIds(argvChannels, argvChannelsCsv, envChannelsCsv) {
  const fromArgList = Array.isArray(argvChannels)
    ? argvChannels.map(String).map(s => s.trim()).filter(Boolean)
    : [];
  const fromArgCsv = typeof argvChannelsCsv === 'string'
    ? argvChannelsCsv.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const fromEnvCsv = typeof envChannelsCsv === 'string'
    ? envChannelsCsv.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  return [...new Set([...fromArgList, ...fromArgCsv, ...fromEnvCsv])];
}

function parseChannelIdsFromUrls(channelUrls) {
  const ids = [];
  const list = Array.isArray(channelUrls) ? channelUrls : [];
  for (const raw of list) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const match = value.match(
      /^https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)(?:\/\d+)?\/?$/i,
    );
    if (match) {
      ids.push(match[2]);
    }
  }
  return ids;
}

function loadLocalEnvFile(envFilePath = DEFAULT_LOCAL_ENV_FILE) {
  const resolved = path.resolve(envFilePath);
  if (!fs.existsSync(resolved)) return;
  const text = fs.readFileSync(resolved, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function hasPermission(bitfieldText, bit) {
  if (!bitfieldText) return null;
  const bits = BigInt(String(bitfieldText));
  return (bits & bit) === bit;
}

async function discordGet(token, pathname, params = undefined) {
  const normalizedPath = String(pathname || '').replace(/^\/+/, '');
  const url = new URL(normalizedPath, DISCORD_API_BASE_URL);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: token,
      'User-Agent': 'chrome-ai-bridge-discord-readonly-preflight/1.0',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GET ${pathname} failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }
  return response.json();
}

async function main() {
  loadLocalEnvFile();

  const argv = yargs(hideBin(process.argv))
    .strict()
    .option('token', {
      type: 'string',
      describe: 'Discord bot token (or set DISCORD_BOT_TOKEN)',
    })
    .option('channel', {
      type: 'array',
      string: true,
      describe: 'Target channel ID (repeatable)',
    })
    .option('channels', {
      type: 'string',
      describe: 'Comma-separated channel IDs',
    })
    .option('channel-url', {
      type: 'array',
      string: true,
      describe: 'Discord channel URL (repeatable)',
    })
    .help()
    .parseSync();

  const token = String(argv.token || process.env.DISCORD_BOT_TOKEN || '').trim();
  if (!token) {
    throw new Error('Missing token. Provide --token or DISCORD_BOT_TOKEN.');
  }

  const channelIds = parseChannelIds(
    argv.channel,
    argv.channels,
    process.env.DISCORD_CHANNEL_IDS,
  );
  const envChannelUrls = typeof process.env.DISCORD_CHANNEL_URLS === 'string'
    ? process.env.DISCORD_CHANNEL_URLS.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const channelIdsFromUrls = parseChannelIdsFromUrls([
    ...(Array.isArray(argv['channel-url']) ? argv['channel-url'] : []),
    ...envChannelUrls,
  ]);
  const dedupedChannelIds = [...new Set([...channelIds, ...channelIdsFromUrls])];
  if (dedupedChannelIds.length === 0) {
    throw new Error('No channel IDs provided. Use --channel or DISCORD_CHANNEL_IDS.');
  }

  const me = await discordGet(token, '/users/@me');
  console.log(`[preflight] bot_id=${me.id} username=${me.username}`);

  let hadError = false;
  for (const channelId of dedupedChannelIds) {
    try {
      const channel = await discordGet(token, `/channels/${channelId}`);
      const permissions = channel.permissions ? String(channel.permissions) : '';

      const canView = hasPermission(permissions, PERM.VIEW_CHANNEL);
      const canReadHistory = hasPermission(permissions, PERM.READ_MESSAGE_HISTORY);
      const canSend = hasPermission(permissions, PERM.SEND_MESSAGES);
      const canSendThreads = hasPermission(
        permissions,
        PERM.SEND_MESSAGES_IN_THREADS,
      );
      const canManageMessages = hasPermission(permissions, PERM.MANAGE_MESSAGES);

      // Ensure history endpoint is accessible.
      await discordGet(token, `/channels/${channelId}/messages`, {limit: 1});

      const checks = [];
      checks.push(`view=${canView === null ? 'unknown' : String(canView)}`);
      checks.push(`read_history=${canReadHistory === null ? 'unknown' : String(canReadHistory)}`);
      checks.push(`send=${canSend === null ? 'unknown' : String(canSend)}`);
      checks.push(`send_threads=${canSendThreads === null ? 'unknown' : String(canSendThreads)}`);
      checks.push(`manage_messages=${canManageMessages === null ? 'unknown' : String(canManageMessages)}`);

      console.log(
        `[preflight] PASS channel=${channelId} name=${channel.name || 'n/a'} ${checks.join(' ')}`,
      );

      if (canSend === true || canSendThreads === true || canManageMessages === true) {
        console.log(
          `[preflight] WARN channel=${channelId} write/manage permission appears enabled. For strict read-only, deny send/manage perms.`,
        );
      }
    } catch (error) {
      hadError = true;
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(`[preflight] FAIL channel=${channelId} error=${message}`);
    }
  }

  process.exit(hadError ? 1 : 0);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[preflight] fatal=${message}`);
  process.exit(1);
});
