#!/usr/bin/env node
/**
 * Extension自動リロードスクリプト
 *
 * ビルド後にChrome拡張機能を自動でリロードする。
 * 1. relay info ファイルのポートを試す
 * 2. 失敗したら全 discovery ポート (38765-38775) をスキャンして試す
 *
 * 使い方:
 *   node scripts/reload-extension.mjs
 *
 * npm scriptとして:
 *   npm run reload-ext
 *   npm run build  # ビルド後に自動実行
 */

import fs from 'node:fs';

const RELAY_INFO_PATH = '/tmp/chrome-ai-bridge-relay.json';
const DISCOVERY_PORTS = [38765, 38766, 38767, 38768, 38769, 38770, 38771, 38772, 38773, 38774, 38775];
const TIMEOUT_MS = 3000;

async function tryReload(port) {
  const url = `http://127.0.0.1:${port}/reload-extension`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok) {
      const result = await response.json();
      if (result.success) {
        console.log(`[reload-ext] Extension reloaded via port ${port}`);
        return true;
      }
    }
  } catch {
    // Silent — will try next port
  }
  return false;
}

async function main() {
  // Phase 1: Try the port from relay info file (fastest path)
  let relayPort = null;
  try {
    if (fs.existsSync(RELAY_INFO_PATH)) {
      const relayInfo = JSON.parse(fs.readFileSync(RELAY_INFO_PATH, 'utf8'));
      const age = Date.now() - (relayInfo.timestamp || 0);
      if (age < 60 * 60 * 1000 && relayInfo.discoveryPort) {
        relayPort = relayInfo.discoveryPort;
        if (await tryReload(relayPort)) {
          return;
        }
        console.log(`[reload-ext] Relay info port ${relayPort} failed, scanning all ports...`);
      } else {
        console.log('[reload-ext] Relay info is stale, scanning all ports...');
        fs.unlinkSync(RELAY_INFO_PATH);
      }
    }
  } catch {
    // Ignore relay info errors
  }

  // Phase 2: Scan all discovery ports
  for (const port of DISCOVERY_PORTS) {
    if (port === relayPort) continue; // Already tried
    if (await tryReload(port)) {
      return;
    }
  }

  console.log('[reload-ext] No active MCP server found on any discovery port (skipping)');
}

main();
