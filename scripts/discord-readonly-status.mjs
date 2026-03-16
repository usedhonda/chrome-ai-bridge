#!/usr/bin/env node
/**
 * Read-only Discord collector status viewer.
 *
 * Shows run summaries and message counts from local SQLite.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {DatabaseSync} from 'node:sqlite';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

const DEFAULT_DB_PATH = '.local/discord-collector/collector.db';

function tableExists(db, tableName) {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(tableName);
  return Boolean(row);
}

function printRunSummary(db, limit) {
  if (!tableExists(db, 'runs')) {
    console.log(
      '[status] No runs table found. Execute collector at least once.',
    );
    return;
  }

  const totalRuns = db.prepare('SELECT COUNT(*) AS n FROM runs').get().n;
  const lastRun = db
    .prepare(
      `SELECT run_id, started_at, finished_at, channels_scanned,
              messages_inserted, messages_updated, errors_count
         FROM runs
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .get();

  console.log(`runs_total=${totalRuns}`);
  if (lastRun) {
    console.log(
      `last_run id=${lastRun.run_id} started=${lastRun.started_at} finished=${lastRun.finished_at} channels=${lastRun.channels_scanned} inserted=${lastRun.messages_inserted} updated=${lastRun.messages_updated} errors=${lastRun.errors_count}`,
    );
  }

  const recent = db
    .prepare(
      `SELECT started_at, channels_scanned, messages_inserted, messages_updated, errors_count
         FROM runs
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(limit);

  console.log(`recent_runs(limit=${limit})`);
  for (const row of recent) {
    console.log(
      `  started=${row.started_at} channels=${row.channels_scanned} inserted=${row.messages_inserted} updated=${row.messages_updated} errors=${row.errors_count}`,
    );
  }
}

function printMessageSummary(db, channelFilter, tailLimit) {
  if (!tableExists(db, 'messages')) {
    console.log(
      '[status] No messages table found. Execute collector at least once.',
    );
    return;
  }

  const countRow = channelFilter
    ? db
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?')
        .get(channelFilter)
    : db.prepare('SELECT COUNT(*) AS n FROM messages').get();

  const channelCount = channelFilter
    ? 1
    : db.prepare('SELECT COUNT(DISTINCT channel_id) AS n FROM messages').get()
        .n;

  console.log(
    `messages_total=${countRow.n} channels=${channelCount}${channelFilter ? ` channel_filter=${channelFilter}` : ''}`,
  );

  const topRows = channelFilter
    ? db
        .prepare(
          `SELECT channel_id, COUNT(*) AS n, MAX(created_at) AS latest
             FROM messages
            WHERE channel_id = ?
            GROUP BY channel_id
            ORDER BY n DESC`,
        )
        .all(channelFilter)
    : db
        .prepare(
          `SELECT channel_id, COUNT(*) AS n, MAX(created_at) AS latest
             FROM messages
            GROUP BY channel_id
            ORDER BY n DESC
            LIMIT 10`,
        )
        .all();

  console.log('channel_counts');
  for (const row of topRows) {
    console.log(
      `  channel=${row.channel_id} messages=${row.n} latest=${row.latest}`,
    );
  }

  const tailRows = channelFilter
    ? db
        .prepare(
          `SELECT created_at, channel_id, author_name, substr(content, 1, 120) AS content
             FROM messages
            WHERE channel_id = ?
            ORDER BY created_at DESC
            LIMIT ?`,
        )
        .all(channelFilter, tailLimit)
    : db
        .prepare(
          `SELECT created_at, channel_id, author_name, substr(content, 1, 120) AS content
             FROM messages
            ORDER BY created_at DESC
            LIMIT ?`,
        )
        .all(tailLimit);

  console.log(`tail_messages(limit=${tailLimit})`);
  for (const row of tailRows) {
    const safeContent = String(row.content || '')
      .replace(/\s+/g, ' ')
      .trim();
    console.log(
      `  at=${row.created_at} channel=${row.channel_id} author=${row.author_name} content="${safeContent}"`,
    );
  }
}

function main() {
  const argv = yargs(hideBin(process.argv))
    .strict()
    .option('db', {
      type: 'string',
      default: DEFAULT_DB_PATH,
      describe: 'SQLite DB path',
    })
    .option('channel', {
      type: 'string',
      describe: 'Filter by channel ID',
    })
    .option('runs', {
      type: 'number',
      default: 5,
      describe: 'Recent run rows to show',
    })
    .option('tail', {
      type: 'number',
      default: 10,
      describe: 'Recent message rows to show',
    })
    .help()
    .parseSync();

  const dbPath = path.resolve(String(argv.db));
  if (!fs.existsSync(dbPath)) {
    console.error(`[status] DB does not exist: ${dbPath}`);
    console.error('[status] Run `npm run discord:collect` first.');
    process.exit(1);
  }

  const db = new DatabaseSync(dbPath, {readOnly: true});
  try {
    console.log(`[status] db=${dbPath}`);
    printRunSummary(db, Math.max(1, Number(argv.runs) || 5));
    printMessageSummary(
      db,
      argv.channel ? String(argv.channel) : '',
      Math.max(1, Number(argv.tail) || 10),
    );
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[status] fatal=${message}`);
  process.exit(1);
}
