#!/usr/bin/env node
/**
 * Read-only Discord collector (batch mode).
 *
 * - Uses only GET endpoints.
 * - Stores results in local SQLite.
 * - Designed to run on a schedule (cron/launchd/etc.).
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

const DISCORD_API_BASE_URL = 'https://discord.com/api/v10/';
const DEFAULT_DB_PATH = '.local/discord-collector/collector.db';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;
const MAX_RETRIES = 5;
const DEFAULT_LOCAL_ENV_FILE = '.local/discord-collector/.env';

function nowIso() {
  return new Date().toISOString();
}

function compareSnowflake(a, b) {
  const aInt = BigInt(a);
  const bInt = BigInt(b);
  if (aInt < bInt) return -1;
  if (aInt > bInt) return 1;
  return 0;
}

function maxSnowflake(current, candidate) {
  if (!current) return candidate;
  return compareSnowflake(candidate, current) > 0 ? candidate : current;
}

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

function parseChannelRefsFromUrls(channelUrls) {
  const refs = [];
  const list = Array.isArray(channelUrls) ? channelUrls : [];
  for (const raw of list) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const match = value.match(
      /^https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)(?:\/\d+)?\/?$/i,
    );
    if (match) {
      refs.push({guildId: match[1], channelId: match[2]});
    }
  }
  return refs;
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

class DiscordReadOnlyClient {
  constructor(token, baseUrl = DISCORD_API_BASE_URL) {
    this.token = token;
    this.baseUrl = baseUrl;
  }

  async get(pathname, params = undefined) {
    const normalizedPath = String(pathname || '').replace(/^\/+/, '');
    const url = new URL(normalizedPath, this.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: this.token,
          'User-Agent': 'chrome-ai-bridge-discord-readonly-collector/1.0',
        },
      });

      if (response.status === 429) {
        const body = await safeJson(response);
        const retryAfterMs = Math.max(
          250,
          Math.ceil((Number(body?.retry_after) || 1) * 1000),
        );
        if (attempt === MAX_RETRIES) {
          throw new Error(
            `Discord rate limited after ${MAX_RETRIES} attempts: ${url.pathname}`,
          );
        }
        await sleep(retryAfterMs);
        continue;
      }

      if (response.status >= 500) {
        if (attempt === MAX_RETRIES) {
          const text = await response.text();
          throw new Error(
            `Discord 5xx after ${MAX_RETRIES} attempts (${response.status}) ${url.pathname}: ${text.slice(0, 300)}`,
          );
        }
        const backoffMs = Math.min(8000, 250 * 2 ** (attempt - 1));
        await sleep(backoffMs);
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Discord GET failed (${response.status}) ${url.pathname}: ${text.slice(0, 400)}`,
        );
      }

      return response.json();
    }

    throw new Error(`Unreachable retry state for ${url.pathname}`);
  }
}

function safeJson(response) {
  return response.json().catch(() => null);
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at TEXT,
      attachments_count INTEGER NOT NULL DEFAULT 0,
      jump_url TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_channel_created_at
    ON messages(channel_id, created_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      channel_id TEXT PRIMARY KEY,
      last_message_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      channels_scanned INTEGER NOT NULL,
      messages_inserted INTEGER NOT NULL,
      messages_updated INTEGER NOT NULL,
      errors_count INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS run_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      error_message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

function normalizeMessage(raw, fallbackGuildId, channelId) {
  const guildId = String(raw.guild_id || fallbackGuildId || '');
  const authorId = String(raw.author?.id || 'unknown');
  const authorName = String(
    raw.author?.global_name ||
      raw.author?.username ||
      raw.author?.display_name ||
      'unknown',
  );
  const content = typeof raw.content === 'string' ? raw.content : '';
  const createdAt = String(raw.timestamp || nowIso());
  const editedAt = raw.edited_timestamp ? String(raw.edited_timestamp) : null;
  const attachmentsCount = Array.isArray(raw.attachments)
    ? raw.attachments.length
    : 0;
  const jumpUrl = guildId
    ? `https://discord.com/channels/${guildId}/${channelId}/${raw.id}`
    : '';

  return {
    messageId: String(raw.id),
    guildId,
    channelId: String(channelId),
    authorId,
    authorName,
    content,
    createdAt,
    editedAt,
    attachmentsCount,
    jumpUrl,
  };
}

async function fetchChannelMessages(client, channelId, afterId, pageSize, maxPages) {
  const messages = [];
  let cursor = afterId || null;
  let highestMessageId = afterId || null;
  let pagesFetched = 0;

  while (pagesFetched < maxPages) {
    const page = await client.get(`/channels/${channelId}/messages`, {
      limit: pageSize,
      ...(cursor ? {after: cursor} : {}),
    });

    if (!Array.isArray(page)) {
      throw new Error(`Unexpected response shape for channel ${channelId}`);
    }

    if (page.length === 0) {
      break;
    }

    const sorted = [...page].sort((a, b) => compareSnowflake(a.id, b.id));
    for (const item of sorted) {
      messages.push(item);
      highestMessageId = maxSnowflake(highestMessageId, String(item.id));
    }

    pagesFetched += 1;
    cursor = highestMessageId;

    if (page.length < pageSize) {
      break;
    }
  }

  return {messages, highestMessageId, pagesFetched};
}

function upsertMessages(db, records, fetchedAt) {
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO messages (
      message_id, guild_id, channel_id, author_id, author_name,
      content, created_at, edited_at, attachments_count, jump_url, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateStmt = db.prepare(`
    UPDATE messages
    SET
      guild_id = ?,
      channel_id = ?,
      author_id = ?,
      author_name = ?,
      content = ?,
      created_at = ?,
      edited_at = ?,
      attachments_count = ?,
      jump_url = ?,
      fetched_at = ?
    WHERE message_id = ?
  `);

  let inserted = 0;
  let updated = 0;

  for (const record of records) {
    const insertResult = insertStmt.run(
      record.messageId,
      record.guildId,
      record.channelId,
      record.authorId,
      record.authorName,
      record.content,
      record.createdAt,
      record.editedAt,
      record.attachmentsCount,
      record.jumpUrl,
      fetchedAt,
    );

    if (insertResult.changes > 0) {
      inserted += 1;
      continue;
    }

    const updateResult = updateStmt.run(
      record.guildId,
      record.channelId,
      record.authorId,
      record.authorName,
      record.content,
      record.createdAt,
      record.editedAt,
      record.attachmentsCount,
      record.jumpUrl,
      fetchedAt,
      record.messageId,
    );
    if (updateResult.changes > 0) {
      updated += 1;
    }
  }

  return {inserted, updated};
}

function readCheckpoint(db, channelId) {
  const row = db
    .prepare('SELECT last_message_id FROM checkpoints WHERE channel_id = ?')
    .get(channelId);
  return row?.last_message_id ? String(row.last_message_id) : null;
}

function writeCheckpoint(db, channelId, lastMessageId, updatedAt) {
  db.prepare(`
    INSERT INTO checkpoints (channel_id, last_message_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      last_message_id = excluded.last_message_id,
      updated_at = excluded.updated_at
  `).run(channelId, lastMessageId, updatedAt);
}

function insertRunSummary(db, summary) {
  db.prepare(`
    INSERT INTO runs (
      run_id, started_at, finished_at, channels_scanned,
      messages_inserted, messages_updated, errors_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    summary.runId,
    summary.startedAt,
    summary.finishedAt,
    summary.channelsScanned,
    summary.messagesInserted,
    summary.messagesUpdated,
    summary.errorsCount,
  );
}

function insertRunError(db, runId, channelId, errorMessage, createdAt) {
  db.prepare(`
    INSERT INTO run_errors (run_id, channel_id, error_message, created_at)
    VALUES (?, ?, ?, ?)
  `).run(runId, channelId, errorMessage, createdAt);
}

function maskToken(token) {
  if (!token || token.length < 10) return '***';
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

async function main() {
  loadLocalEnvFile();

  const argv = yargs(hideBin(process.argv))
    .strict()
    .option('token', {
      type: 'string',
      describe: 'Discord bot token (or set DISCORD_BOT_TOKEN)',
    })
    .option('guild-id', {
      type: 'string',
      describe: 'Guild ID (optional fallback for jump URLs)',
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
    .option('db', {
      type: 'string',
      default: DEFAULT_DB_PATH,
      describe: 'SQLite DB path',
    })
    .option('page-size', {
      type: 'number',
      default: DEFAULT_PAGE_SIZE,
      describe: 'Messages per API request (max 100)',
    })
    .option('max-pages', {
      type: 'number',
      default: DEFAULT_MAX_PAGES,
      describe: 'Max pages fetched per channel per run',
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
  const channelRefsFromUrls = parseChannelRefsFromUrls([
    ...(Array.isArray(argv['channel-url']) ? argv['channel-url'] : []),
    ...envChannelUrls,
  ]);
  for (const ref of channelRefsFromUrls) {
    channelIds.push(ref.channelId);
  }
  const dedupedChannelIds = [...new Set(channelIds)];
  if (dedupedChannelIds.length === 0) {
    throw new Error('No channel IDs provided. Use --channel or DISCORD_CHANNEL_IDS.');
  }

  const guildId = String(
    argv['guild-id'] ||
      process.env.DISCORD_GUILD_ID ||
      channelRefsFromUrls[0]?.guildId ||
      '',
  ).trim();
  const dbPath = path.resolve(String(argv.db));
  const pageSize = Math.max(1, Math.min(100, Math.floor(Number(argv['page-size']) || DEFAULT_PAGE_SIZE)));
  const maxPages = Math.max(1, Math.floor(Number(argv['max-pages']) || DEFAULT_MAX_PAGES));
  const startedAt = nowIso();
  const runId = randomUUID();
  const fetchedAt = nowIso();

  fs.mkdirSync(path.dirname(dbPath), {recursive: true});

  const db = new DatabaseSync(dbPath);
  ensureSchema(db);

  const client = new DiscordReadOnlyClient(token);

  const summary = {
    runId,
    startedAt,
    finishedAt: '',
    channelsScanned: 0,
    messagesInserted: 0,
    messagesUpdated: 0,
    errorsCount: 0,
  };

  console.log(`[collector] run_id=${runId}`);
  console.log(`[collector] channels=${dedupedChannelIds.length}`);
  console.log(`[collector] db=${dbPath}`);
  console.log(`[collector] token=${maskToken(token)}`);

  try {
    for (const channelId of dedupedChannelIds) {
      summary.channelsScanned += 1;
      const checkpoint = readCheckpoint(db, channelId);
      try {
        const {messages, highestMessageId, pagesFetched} = await fetchChannelMessages(
          client,
          channelId,
          checkpoint,
          pageSize,
          maxPages,
        );

        const normalized = messages.map(message =>
          normalizeMessage(message, guildId, channelId),
        );
        const {inserted, updated} = upsertMessages(db, normalized, fetchedAt);
        summary.messagesInserted += inserted;
        summary.messagesUpdated += updated;

        if (highestMessageId) {
          writeCheckpoint(db, channelId, highestMessageId, nowIso());
        }

        console.log(
          `[collector] channel=${channelId} pages=${pagesFetched} fetched=${messages.length} inserted=${inserted} updated=${updated}`,
        );
      } catch (error) {
        summary.errorsCount += 1;
        const message =
          error instanceof Error ? error.message : String(error);
        insertRunError(db, runId, channelId, message, nowIso());
        console.error(`[collector] channel=${channelId} error=${message}`);
      }
    }
  } finally {
    summary.finishedAt = nowIso();
    insertRunSummary(db, summary);
    db.close();
  }

  console.log(
    `[collector] done channels=${summary.channelsScanned} inserted=${summary.messagesInserted} updated=${summary.messagesUpdated} errors=${summary.errorsCount}`,
  );

  process.exit(summary.errorsCount > 0 ? 1 : 0);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[collector] fatal=${message}`);
  process.exit(1);
});
