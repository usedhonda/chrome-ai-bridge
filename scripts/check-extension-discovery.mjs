#!/usr/bin/env node
import process from 'node:process';

const DEFAULT_PORTS = '38765-38775';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_FETCH_TIMEOUT_MS = 700;

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parsePorts(spec) {
  const input = (spec || DEFAULT_PORTS).trim();
  const out = new Set();
  for (const chunk of input.split(',')) {
    const part = chunk.trim();
    if (!part) continue;
    if (part.includes('-')) {
      const [rawStart, rawEnd] = part.split('-', 2).map(s => s.trim());
      const start = Number(rawStart);
      const end = Number(rawEnd);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= 0) {
        throw new Error(`Invalid port range "${part}"`);
      }
      const lower = Math.min(start, end);
      const upper = Math.max(start, end);
      for (let port = lower; port <= upper; port += 1) {
        out.add(port);
      }
      continue;
    }
    const port = Number(part);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`Invalid port "${part}"`);
    }
    out.add(port);
  }
  return [...out];
}

async function fetchRelayInfo(port, fetchTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const url = `http://127.0.0.1:${port}/relay-info`;
    const response = await fetch(url, {signal: controller.signal});
    if (!response.ok) {
      return {ok: false, reason: `http-${response.status}`};
    }
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload.wsUrl !== 'string' || payload.wsUrl.length === 0) {
      return {ok: false, reason: 'invalid-payload'};
    }
    return {ok: true, payload};
  } catch (error) {
    if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
      return {ok: false, reason: 'timeout'};
    }
    return {
      ok: false,
      reason: error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const ports = parsePorts(process.env.CAI_DISCOVERY_PORTS);
  const timeoutMs = parsePositiveInt(
    process.env.CAI_DISCOVERY_CHECK_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const intervalMs = parsePositiveInt(
    process.env.CAI_DISCOVERY_CHECK_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
  );
  const fetchTimeoutMs = parsePositiveInt(
    process.env.CAI_DISCOVERY_FETCH_TIMEOUT_MS,
    DEFAULT_FETCH_TIMEOUT_MS,
  );

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const failures = new Map();
  for (const port of ports) {
    failures.set(port, 0);
  }

  while (Date.now() < deadline) {
    for (const port of ports) {
      const result = await fetchRelayInfo(port, fetchTimeoutMs);
      if (result.ok) {
        const summary = {
          ok: true,
          port,
          elapsedMs: Date.now() - startedAt,
          wsUrl: result.payload.wsUrl,
          tabUrl: result.payload.tabUrl || null,
          sessionId: result.payload.sessionId || null,
          startedAt: result.payload.startedAt || null,
          instanceId: result.payload.instanceId || null,
        };
        process.stdout.write(`${JSON.stringify(summary)}\n`);
        process.exit(0);
      }
      failures.set(port, (failures.get(port) || 0) + 1);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  const details = ports.map(port => `${port}:${failures.get(port) || 0}`).join(', ');
  process.stderr.write(
    `No extension discovery endpoint responded within ${timeoutMs}ms. attempts={${details}}\n`,
  );
  process.exit(1);
}

main().catch(error => {
  process.stderr.write(
    `check-extension-discovery failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
