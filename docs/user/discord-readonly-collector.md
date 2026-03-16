# Discord Read-Only Collector (Batch)

This collector fetches messages from specific Discord channels and stores them in local SQLite.

- Uses **GET only** against Discord API
- Does **not** post/edit/delete messages
- Intended for scheduled batch execution (cron/launchd)

## 1) Discord permissions (no write access)

### OAuth2 scope

- `bot`

### Required bot permissions

- `View Channels`
- `Read Message History`

### Do NOT grant

- `Send Messages`
- `Send Messages in Threads`
- `Create Public Threads`
- `Create Private Threads`
- `Manage Messages`
- Any other write/manage permission

### Recommended hardening

- In each target channel, explicitly deny `Send Messages` for the bot role.

## 2) Configure environment

```bash
export DISCORD_BOT_TOKEN="YOUR_BOT_TOKEN"
export DISCORD_CHANNEL_IDS="123456789012345678,234567890123456789"
# Or channel URL(s):
# export DISCORD_CHANNEL_URLS="https://discord.com/channels/968901052210507827/1019247637360296016"
# Optional (used for jump_url fallback):
export DISCORD_GUILD_ID="345678901234567890"
```

Template file:

`docs/user/examples/discord-collector.env.example`

## 3) Run once

Preflight (recommended first):

```bash
npm run discord:preflight
```

Direct URL preflight:

```bash
npm run discord:preflight -- --channel-url "https://discord.com/channels/968901052210507827/1019247637360296016"
```

This checks:

- bot identity can be resolved
- target channels are readable
- message history endpoint is accessible
- warns if send/manage permissions appear enabled

Then run collector:

```bash
npm run discord:collect
```

Direct URL collect:

```bash
npm run discord:collect -- --channel-url "https://discord.com/channels/968901052210507827/1019247637360296016"
```

Custom DB path:

```bash
npm run discord:collect -- --db .local/discord-collector/custom.db
```

Check status:

```bash
npm run discord:status
```

Filter one channel:

```bash
npm run discord:status -- --channel 123456789012345678 --tail 20
```

## 4) Schedule (example: every 5 minutes)

```cron
*/5 * * * * cd /path/to/chrome-ai-bridge && /usr/bin/env DISCORD_BOT_TOKEN=... DISCORD_CHANNEL_IDS=... npm run --silent discord:collect >> /tmp/discord-collector.log 2>&1
```

Templates:

- `docs/user/examples/discord-collector.cron.example`
- `docs/user/examples/com.chrome-ai-bridge.discord-collector.plist` (launchd/macOS)

## 5) SQLite schema

The script creates:

- `messages`
  - message body and metadata (id, author, timestamps, jump URL, attachments count)
- `checkpoints`
  - per-channel `last_message_id` for incremental fetch
- `runs`
  - one summary row per batch run
- `run_errors`
  - per-channel error details

## 6) Notes

- Default DB path: `.local/discord-collector/collector.db`
- Default page size: `100` (Discord max)
- Default max pages per channel per run: `10`
- Exit code is non-zero if any channel fails in that run
