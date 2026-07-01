/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Context Management for Agent Teams support.
 *
 * Each client (process) gets a unique agent ID, enabling:
 * - Isolated browser sessions per agent
 * - Tab management per agent
 * - TTL-based cleanup of stale sessions
 */

import {AsyncLocalStorage} from 'node:async_hooks';

import type {RelayServer} from '../extension/relay-server.js';

import type {CdpClient} from './cdp-client.js';

/**
 * Connection state for a single agent
 */
export interface AgentConnection {
  chatgptClient: CdpClient | null;
  geminiClient: CdpClient | null;
  chatgptRelay: RelayServer | null;
  geminiRelay: RelayServer | null;
  lastAccess: Date;
}

/**
 * Map of agent ID to connection state
 */
const agentConnections = new Map<string, AgentConnection>();

/**
 * Request-scoped agent ID. The daemon handles multiple callers in one process,
 * so per-request context must not be stored in a mutable global.
 */
const agentIdStorage = new AsyncLocalStorage<string>();

/**
 * Fallback agent ID for process-level scripts and legacy callers.
 */
let defaultAgentId: string | null = null;

/**
 * Generate a unique agent ID.
 *
 * Strategy:
 * 1. If CAI_AGENT_ID environment variable is set, use it as-is
 * 2. Otherwise, use the caller-provided client name
 * 3. Fall back to "default"
 *
 * @param clientName Optional client name (e.g., "claude-code")
 * @returns Unique agent ID
 */
export function generateAgentId(clientName?: string): string {
  const envAgentId = process.env.CAI_AGENT_ID;

  if (envAgentId) {
    return envAgentId;
  }

  if (clientName) {
    return clientName;
  }

  return 'default';
}

/**
 * Set the current agent ID for this process.
 * Should be called once at process startup.
 *
 * @param id Agent ID to set
 */
export function setAgentId(id: string): void {
  if (defaultAgentId !== null && defaultAgentId !== id) {
    console.error(
      `[agent-context] Warning: default agent ID changed from ${defaultAgentId} to ${id}`,
    );
  }
  defaultAgentId = id;
  console.error(`[agent-context] Default agent ID set: ${id}`);
}

/**
 * Run a callback with a request-scoped agent ID.
 */
export function runWithAgentId<T>(id: string, callback: () => T): T {
  return agentIdStorage.run(id, callback);
}

/**
 * Get the current agent ID.
 *
 * @returns Current agent ID
 * @throws Error if agent ID is not set
 */
export function getAgentId(): string {
  const scopedAgentId = agentIdStorage.getStore();
  if (scopedAgentId) {
    return scopedAgentId;
  }
  if (!defaultAgentId) {
    throw new Error('Agent ID not set. Call setAgentId() first.');
  }
  return defaultAgentId;
}

/**
 * Get the current agent ID, if one is available.
 */
export function getCurrentAgentId(): string | null {
  return agentIdStorage.getStore() ?? defaultAgentId;
}

/**
 * Check if agent ID is set.
 *
 * @returns true if agent ID is set
 */
export function hasAgentId(): boolean {
  return getCurrentAgentId() !== null;
}

/**
 * Get or create connection state for the current agent.
 *
 * @returns AgentConnection for the current agent
 */
export function getAgentConnection(): AgentConnection {
  const agentId = getAgentId();

  let conn = agentConnections.get(agentId);
  if (!conn) {
    conn = {
      chatgptClient: null,
      geminiClient: null,
      chatgptRelay: null,
      geminiRelay: null,
      lastAccess: new Date(),
    };
    agentConnections.set(agentId, conn);
    console.error(
      `[agent-context] Created new connection for agent: ${agentId}`,
    );
  }

  // Update last access time
  conn.lastAccess = new Date();
  return conn;
}

/**
 * Get all agent connections (for cleanup purposes).
 *
 * @returns Map of agent ID to AgentConnection
 */
export function getAllAgentConnections(): Map<string, AgentConnection> {
  return agentConnections;
}

/**
 * Clear all agent connections.
 * Used during shutdown.
 */
export function clearAllAgentConnections(): void {
  agentConnections.clear();
  console.error('[agent-context] Cleared all agent connections');
}
