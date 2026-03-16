/**
 * chrome-ai-bridge Extension Background Service Worker
 * Playwright extension2-style flow:
 * - connectToRelay -> establishes WS only
 * - connectToTab -> binds a tab to that relay
 * - attachToTab / forwardCDPCommand for CDP passthrough
 */

// ============================================
// Logging System
// ============================================
const LOG_LEVEL = {DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3};
let currentLogLevel = LOG_LEVEL.DEBUG;

/**
 * Enhanced logger with level, category, and Storage persistence
 */
function log(level, category, message, data = {}) {
  const timestamp = new Date().toISOString();
  const levelName =
    Object.keys(LOG_LEVEL).find(k => LOG_LEVEL[k] === level) || 'INFO';
  const entry = {timestamp, level: levelName, category, message, data};

  // Console output
  const prefix = `[${timestamp}] [${levelName}] [${category}]`;
  if (level >= currentLogLevel) {
    const dataStr = Object.keys(data).length > 0 ? JSON.stringify(data) : '';
    console.log(prefix, message, dataStr);
  }

  // Save to Storage (async, fire-and-forget)
  saveLogEntry(entry);
}

async function saveLogEntry(entry) {
  try {
    const result = await chrome.storage.local.get('logs');
    const logs = result.logs || [];
    logs.push(entry);
    // Keep only last 100 entries
    while (logs.length > 100) {
      logs.shift();
    }
    await chrome.storage.local.set({logs});
  } catch {
    // Ignore storage errors
  }
}

// Convenience functions
function logDebug(category, message, data) {
  log(LOG_LEVEL.DEBUG, category, message, data);
}
function logInfo(category, message, data) {
  log(LOG_LEVEL.INFO, category, message, data);
}
function logWarn(category, message, data) {
  log(LOG_LEVEL.WARN, category, message, data);
}
function logError(category, message, data) {
  log(LOG_LEVEL.ERROR, category, message, data);
}

// Legacy debug log (for compatibility)
function debugLog(...args) {
  logDebug('general', args.join(' '));
  console.log('[Extension]', ...args);
}

class RelayConnection {
  constructor(ws) {
    this._debuggee = {};
    this._ws = ws;
    this._closed = false;
    this._tabPromise = new Promise(
      resolve => (this._tabPromiseResolve = resolve),
    );
    this._eventListener = this._onDebuggerEvent.bind(this);
    this._detachListener = this._onDebuggerDetach.bind(this);
    this._ws.onmessage = this._onMessage.bind(this);
    this._ws.onclose = () => this._onClose();
    chrome.debugger.onEvent.addListener(this._eventListener);
    chrome.debugger.onDetach.addListener(this._detachListener);
  }

  setTabId(tabId) {
    this._debuggee = {tabId};
    this._tabPromiseResolve();
  }

  sendReady(tabId) {
    this._sendMessage({
      type: 'ready',
      tabId,
    });
  }

  close(message) {
    if (
      this._ws.readyState === WebSocket.OPEN ||
      this._ws.readyState === WebSocket.CONNECTING
    ) {
      this._ws.close(1000, message);
    }
    this._onClose();
  }

  _onClose() {
    if (this._closed) return;
    this._closed = true;
    chrome.debugger.onEvent.removeListener(this._eventListener);
    chrome.debugger.onDetach.removeListener(this._detachListener);
    chrome.debugger.detach(this._debuggee).catch(() => {});
    if (this.onclose) this.onclose();
  }

  _onDebuggerEvent(source, method, params) {
    if (source.tabId !== this._debuggee.tabId) return;
    const sessionId = source.sessionId;
    this._sendMessage({
      method: 'forwardCDPEvent',
      params: {
        sessionId,
        method,
        params,
      },
    });
  }

  _onDebuggerDetach(source, reason) {
    if (source.tabId !== this._debuggee.tabId) return;
    this.close(`Debugger detached: ${reason}`);
    this._debuggee = {};
  }

  _onMessage(event) {
    this._onMessageAsync(event).catch(err =>
      debugLog('Error handling message:', err),
    );
  }

  async _onMessageAsync(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      this._sendMessage({
        error: {
          code: -32700,
          message: `Error parsing message: ${error.message}`,
        },
      });
      return;
    }

    // Handle keep-alive ping from relay server
    if (message.type === 'ping') {
      this._sendMessage({type: 'pong'});
      logDebug('keepalive', 'Received ping, sent pong');
      return;
    }

    const response = {id: message.id};
    try {
      response.result = await this._handleCommand(message);
    } catch (error) {
      response.error = error.message;
    }
    this._sendMessage(response);
  }

  async _handleCommand(message) {
    if (message.method === 'getVersion') {
      const manifest = chrome.runtime.getManifest();
      return {version: manifest.version, name: manifest.name};
    }
    if (message.method === 'reloadExtension') {
      logInfo('reload', 'reloadExtension command received');
      // Set flag so the reloaded service worker skips cooldown
      chrome.storage.local.set({_reloadTriggered: Date.now()}).catch(() => {});
      // Delay reload to allow response to be sent first
      setTimeout(() => {
        logInfo('reload', 'Calling chrome.runtime.reload()');
        chrome.runtime.reload();
      }, 100);
      return {success: true, message: 'Extension reload initiated'};
    }
    if (message.method === 'attachToTab') {
      await this._tabPromise;
      debugLog('Attaching debugger to tab:', this._debuggee);

      // デバッグ: アタッチ前にタブの状態を確認
      try {
        const tabInfo = await chrome.tabs.get(this._debuggee.tabId);
        logInfo('attach', 'Tab info before attach', {
          tabId: tabInfo.id,
          url: tabInfo.url,
          title: tabInfo.title,
          status: tabInfo.status,
          active: tabInfo.active,
        });
      } catch (e) {
        logError('attach', 'Failed to get tab info', {error: e.message});
      }

      await chrome.debugger.attach(this._debuggee, '1.3');
      const result = await chrome.debugger.sendCommand(
        this._debuggee,
        'Target.getTargetInfo',
      );
      logInfo('attach', 'Target info after attach', {
        targetInfo: result?.targetInfo,
      });
      return {targetInfo: result?.targetInfo};
    }
    if (!this._debuggee.tabId) {
      throw new Error(
        'No tab is connected. Please select a tab in the extension UI.',
      );
    }
    if (message.method === 'forwardCDPCommand') {
      const {sessionId, method, params} = message.params;
      const debuggerSession = {...this._debuggee, sessionId};

      logDebug('cdp', `Sending ${method}`, {
        tabId: this._debuggee.tabId,
        sessionId,
      });
      if (method === 'Runtime.evaluate') {
        logDebug('cdp', `Runtime.evaluate expression`, {
          expression: params?.expression?.slice(0, 120),
        });
      }

      const result = await chrome.debugger.sendCommand(
        debuggerSession,
        method,
        params,
      );

      logDebug('cdp', `Result of ${method}`, {
        hasResult: result !== undefined,
      });
      if (method === 'Runtime.evaluate') {
        logDebug('cdp', 'Runtime.evaluate value', {
          value: result?.result?.value,
          type: result?.result?.type,
          subtype: result?.result?.subtype,
        });
      }

      return result;
    }
    return {};
  }

  _sendMessage(message) {
    if (this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(message));
    }
  }
}

class TabShareExtension {
  constructor() {
    this._activeConnections = new Map();
    this._pendingTabSelection = new Map();
    this._tabSessionOwners = new Map();
    chrome.tabs.onRemoved.addListener(this._onTabRemoved.bind(this));
    chrome.tabs.onActivated.addListener(this._onTabActivated.bind(this));
    chrome.tabs.onUpdated.addListener(this._onTabUpdated.bind(this));
    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
  }

  _onMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'connectToRelay':
        this._connectToRelay(
          sender.tab?.id,
          message.relayUrl,
          message.sessionId,
        ).then(
          () => sendResponse({success: true}),
          error => sendResponse({success: false, error: error.message}),
        );
        return true;
      case 'getTabs':
        this._getTabs().then(
          tabs =>
            sendResponse({
              success: true,
              tabs,
              currentTabId: sender.tab?.id,
            }),
          error => sendResponse({success: false, error: error.message}),
        );
        return true;
      case 'connectToTab':
        this._connectTab(
          sender.tab?.id,
          message.tabId || sender.tab?.id,
          message.windowId || sender.tab?.windowId,
          message.relayUrl,
          message.tabUrl,
          message.newTab,
          message.sessionId,
          Boolean(message.allowTabTakeover),
        ).then(
          () => sendResponse({success: true}),
          error => sendResponse({success: false, error: error.message}),
        );
        return true;
      case 'disconnect':
        this._disconnect(message.tabId).then(
          () => sendResponse({success: true}),
          error => sendResponse({success: false, error: error.message}),
        );
        return true;
      case 'getDebugLogs':
        this._getDebugLogs(message.filter, message.limit || 100).then(
          payload => sendResponse({success: true, ...payload}),
          error => sendResponse({success: false, error: error.message}),
        );
        return true;
      case 'clearDebugLogs':
        this._clearDebugLogs().then(
          () => sendResponse({success: true}),
          error => sendResponse({success: false, error: error.message}),
        );
        return true;
    }
    return false;
  }

  _getPendingKey(selectorTabId, sessionId) {
    if (sessionId) {
      return `session:${sessionId}`;
    }
    return `selector:${selectorTabId}`;
  }

  async _connectToRelay(selectorTabId, relayUrl, sessionId) {
    if (!relayUrl) {
      logError('relay', 'Missing relay URL');
      throw new Error('Missing relay URL');
    }
    const pendingKey = this._getPendingKey(selectorTabId, sessionId);
    const existingPending = this._pendingTabSelection.get(pendingKey);
    if (existingPending?.connection) {
      logInfo('relay', 'Replacing stale pending connection', {
        pendingKey,
        sessionId,
        selectorTabId,
      });
      existingPending.connection.close('Pending connection replaced');
      this._pendingTabSelection.delete(pendingKey);
      ensureKeepAliveAlarm('replace-stale-pending');
    }
    logInfo('relay', 'Connecting to relay', {
      relayUrl,
      selectorTabId,
      sessionId,
      pendingKey,
    });

    const openSocket = async attempt => {
      const socket = new WebSocket(relayUrl);
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = handler => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeoutId);
          handler();
        };
        const timeoutId = setTimeout(() => {
          finish(() => {
            try {
              socket.close();
            } catch {
              // ignore
            }
            reject(new Error('WS_OPEN_TIMEOUT: Connection timeout'));
          });
        }, 5000);
        socket.onopen = () => {
          finish(resolve);
        };
        socket.onerror = () => {
          finish(() => {
            try {
              socket.close();
            } catch {
              // ignore
            }
            reject(
              new Error(
                `WS_OPEN_ERROR: WebSocket error (attempt=${attempt + 1})`,
              ),
            );
          });
        };
        socket.onclose = () => {
          finish(() => {
            reject(
              new Error(
                `WS_OPEN_CLOSED: Socket closed before open (attempt=${attempt + 1})`,
              ),
            );
          });
        };
      });
      return socket;
    };
    let socket;
    let lastError;
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      logDebug('relay', `WebSocket attempt ${attempt + 1}/${maxAttempts}`, {
        relayUrl,
      });
      try {
        socket = await openSocket(attempt);
        logInfo('relay', 'WebSocket connected', {attempt: attempt + 1});
        break;
      } catch (error) {
        lastError = error;
        logWarn('relay', `WebSocket attempt ${attempt + 1} failed`, {
          error: error.message,
        });
        if (attempt < maxAttempts - 1) {
          const baseDelay = Math.min(300 * 2 ** attempt, 3000);
          const jitter = Math.floor(Math.random() * 200);
          const waitMs = baseDelay + jitter;
          await new Promise(resolve => setTimeout(resolve, waitMs));
        }
      }
    }
    if (!socket) {
      logError('relay', 'All WebSocket attempts failed', {
        lastError: lastError?.message,
      });
      throw lastError || new Error('WebSocket error');
    }
    const connection = new RelayConnection(socket);
    connection.onclose = () => {
      logInfo('relay', 'Connection closed', {
        selectorTabId,
        sessionId,
        pendingKey,
      });
      this._pendingTabSelection.delete(pendingKey);
      ensureKeepAliveAlarm('relay-connection-closed');
    };
    this._pendingTabSelection.set(pendingKey, {
      connection,
      sessionId,
      selectorTabId,
    });
    logInfo('relay', 'Relay connection established', {
      selectorTabId,
      sessionId,
      pendingKey,
    });
    ensureKeepAliveAlarm('relay-connected');
  }

  async _connectTab(
    selectorTabId,
    tabId,
    windowId,
    relayUrl,
    tabUrl,
    newTab,
    sessionId,
    allowTabTakeover = false,
  ) {
    const pendingKey = this._getPendingKey(selectorTabId, sessionId);
    logInfo('connect', '_connectTab called', {
      selectorTabId,
      tabId,
      tabUrl,
      newTab,
      sessionId,
      allowTabTakeover,
      pendingKey,
    });

    if (!tabId && tabUrl) {
      logDebug('connect', 'Resolving tabId from URL', {tabUrl, newTab});
      tabId = await this._resolveTabId(tabUrl, undefined, newTab);
    }
    if (!tabId) {
      logError('connect', 'No tab selected');
      throw new Error('No tab selected');
    }

    const ownerSessionId = this._tabSessionOwners.get(tabId);
    if (
      ownerSessionId &&
      sessionId &&
      ownerSessionId !== sessionId &&
      !allowTabTakeover
    ) {
      logWarn('connect', 'Tab already owned by another session', {
        tabId,
        ownerSessionId,
        requestedSessionId: sessionId,
      });
      throw new Error(
        `TAB_LOCKED_BY_OTHER_SESSION: tabId=${tabId} ownerSessionId=${ownerSessionId}`,
      );
    }

    const existingConnection = this._activeConnections.get(tabId);
    if (existingConnection) {
      logInfo('connect', 'Replacing existing connection', {tabId, sessionId});
      existingConnection.close('Connection replaced for the same tab');
      this._activeConnections.delete(tabId);
      this._tabSessionOwners.delete(tabId);
      await this._setConnectedTab(tabId, false);
    }

    const pending = this._pendingTabSelection.get(pendingKey);
    if (!pending) {
      logDebug('connect', 'No pending connection, creating relay', {
        selectorTabId,
        sessionId,
        relayUrl,
      });
      // If no pending connection, create one now.
      await this._connectToRelay(selectorTabId, relayUrl, sessionId);
    }
    const newPending = this._pendingTabSelection.get(pendingKey);
    if (!newPending) {
      logError('connect', 'No active relay connection');
      throw new Error('No active relay connection');
    }

    if (
      sessionId &&
      newPending.sessionId &&
      newPending.sessionId !== sessionId
    ) {
      throw new Error(
        `SESSION_MISMATCH_RELAY: expected=${sessionId} actual=${newPending.sessionId}`,
      );
    }

    this._pendingTabSelection.delete(pendingKey);
    ensureKeepAliveAlarm('pending-to-active-handoff');
    const connection = newPending.connection;
    connection.setTabId(tabId);
    connection.sendReady(tabId);
    connection.onclose = () => {
      logInfo('connect', 'Tab connection closed', {tabId, sessionId});
      this._activeConnections.delete(tabId);
      const owner = this._tabSessionOwners.get(tabId);
      if (!owner || owner === sessionId) {
        this._tabSessionOwners.delete(tabId);
      }
      void this._setConnectedTab(tabId, false);
      ensureKeepAliveAlarm('active-connection-closed');
    };
    this._activeConnections.set(tabId, connection);
    this._tabSessionOwners.set(tabId, sessionId || `selector:${selectorTabId}`);
    logInfo('connect', 'Tab connected successfully', {
      tabId,
      windowId,
      sessionId,
    });
    ensureKeepAliveAlarm('tab-connected');
    // バッジのみ設定（フォーカスはサーバー側が必要に応じて制御）
    await this._setConnectedTab(tabId, true);
  }

  async _resolveTabId(tabUrl, tabId, newTab, active = true) {
    logDebug('resolve', '_resolveTabId called', {
      tabUrl,
      tabId,
      newTab,
      active,
    });

    // デバッグ: 全タブの一覧を取得
    const allTabs = await chrome.tabs.query({});
    const tabSummary = allTabs.map(t => ({
      id: t.id,
      url: t.url?.slice(0, 60),
      active: t.active,
    }));
    logInfo('resolve', 'All tabs', {
      count: allTabs.length,
      tabs: tabSummary.slice(0, 10),
    });

    // Priority 1: If tabId is provided, try to use it directly
    // Note: newTab flag is ignored - always prefer existing tabs to prevent tab spam
    if (tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && tabUrl) {
          const urlObj = new URL(tabUrl);
          // Check if the tab's URL matches the expected hostname
          if (tab.url && tab.url.includes(urlObj.hostname)) {
            logInfo('resolve', 'Reusing tab by tabId', {tabId, url: tab.url});
            return tabId;
          }
          logDebug('resolve', 'Tab URL mismatch, continuing search', {
            tabId,
            expectedHost: urlObj.hostname,
            actualUrl: tab.url,
          });
        }
      } catch (error) {
        logDebug('resolve', 'Tab not found by tabId (may be closed)', {
          tabId,
          error: error.message,
        });
        // Tab may have been closed, continue with URL-based search
      }
    }

    // Priority 2: Search by URL pattern
    try {
      const urlObj = new URL(tabUrl);
      const pattern = `*://${urlObj.hostname}${urlObj.pathname}*`;
      const tabs = await chrome.tabs.query({url: pattern});
      logDebug('resolve', `Found ${tabs.length} matching tabs`, {
        pattern,
        tabCount: tabs.length,
      });
      // Note: newTab flag is ignored - always prefer existing tabs to prevent tab spam
      if (tabs.length) {
        // Prefer active tab, then the most recently accessed
        const activeTab = tabs.find(tab => tab.active);
        const selectedTab = activeTab || tabs[0];
        logInfo('resolve', 'Reusing existing tab by URL', {
          tabId: selectedTab.id,
          url: selectedTab.url,
        });
        return selectedTab.id;
      }
    } catch (error) {
      logWarn('resolve', 'Error querying tabs', {error: error.message});
      // ignore
    }

    // Priority 3: Create new tab
    if (!tabUrl) {
      logWarn('resolve', 'No tabUrl provided');
      return undefined;
    }
    logInfo('resolve', 'Creating new tab', {url: tabUrl, active});
    const created = await chrome.tabs.create({url: tabUrl, active});
    logInfo('resolve', 'New tab created', {tabId: created.id, active});
    return created.id;
  }

  async _getTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(
      tab =>
        tab.url &&
        !['chrome:', 'edge:', 'devtools:'].some(scheme =>
          tab.url.startsWith(scheme),
        ),
    );
  }

  async _getDebugLogs(filter, limit) {
    const result = await chrome.storage.local.get('logs');
    const rawLogs = Array.isArray(result.logs) ? result.logs : [];
    const toIso = value =>
      typeof value === 'number' && value > 0
        ? new Date(value).toISOString()
        : null;
    const normalized = rawLogs.map(logEntry => ({
      ts: logEntry.timestamp || logEntry.ts || new Date().toISOString(),
      category: logEntry.category || 'unknown',
      message: logEntry.message || '',
      data: logEntry.data ?? null,
      level: logEntry.level || 'INFO',
    }));

    const filtered = filter
      ? normalized.filter(logEntry => logEntry.category === filter)
      : normalized;

    const byCategory = {};
    for (const logEntry of normalized) {
      byCategory[logEntry.category] = (byCategory[logEntry.category] || 0) + 1;
    }

    return {
      logs: filtered.slice(-limit),
      stats: {
        total: normalized.length,
        byCategory,
      },
      state: {
        activeConnections: Array.from(this._activeConnections.keys()),
        pendingTabSelection: Array.from(this._pendingTabSelection.keys()),
        tabSessionOwners: Object.fromEntries(this._tabSessionOwners.entries()),
        discovery: {
          mode: discoveryMode,
          intervalMs: getDiscoveryIntervalMs(),
          isRunning: isDiscoveryRunning,
          hasScheduledTick: discoveryIntervalId !== null,
          emptyDiscoveryStreak,
          lastSuccessfulPort,
          lastTickStartedAt: toIso(lastDiscoveryTickStartedAt),
          lastTickFinishedAt: toIso(lastDiscoveryTickFinishedAt),
          lastTickDurationMs: lastDiscoveryTickDurationMs,
          lastSummary: lastDiscoverySummary,
          lastError: lastDiscoveryError,
          lastRelayProbeAt: toIso(lastRelayProbeAt),
          lastRelayProbePort,
          lastRelayProbeStatus,
          lastRelayProbeError,
          keepAliveActive,
          lastKeepAliveAlarmAt: toIso(lastKeepAliveAlarmAt),
        },
      },
    };
  }

  async _clearDebugLogs() {
    await chrome.storage.local.set({logs: []});
    logInfo('debug', 'Debug logs cleared');
  }

  async _setConnectedTab(tabId, connected) {
    if (!tabId) return;
    try {
      if (connected) {
        await chrome.action.setBadgeText({tabId, text: '✓'});
        await chrome.action.setBadgeBackgroundColor({
          tabId,
          color: '#4CAF50',
        });
      } else {
        await chrome.action.setBadgeText({tabId, text: ''});
      }
    } catch {
      // Tab no longer exists, ignore
    }
  }

  async _disconnect(tabId) {
    if (tabId) {
      const connection = this._activeConnections.get(tabId);
      if (connection) connection.close('User disconnected');
      this._activeConnections.delete(tabId);
      this._tabSessionOwners.delete(tabId);
      await this._setConnectedTab(tabId, false);
      ensureKeepAliveAlarm('disconnect-single-tab');
      return;
    }
    for (const [connectedTabId, connection] of this._activeConnections) {
      connection.close('User disconnected');
      await this._setConnectedTab(connectedTabId, false);
      this._tabSessionOwners.delete(connectedTabId);
    }
    this._activeConnections.clear();
    this._pendingTabSelection.clear();
    this._tabSessionOwners.clear();
    ensureKeepAliveAlarm('disconnect-all');
  }

  _onTabRemoved(tabId) {
    for (const [pendingKey, pending] of this._pendingTabSelection) {
      if (pending.selectorTabId === tabId) {
        this._pendingTabSelection.delete(pendingKey);
        pending.connection.close('Browser tab closed');
        ensureKeepAliveAlarm('pending-tab-removed');
      }
    }
    const active = this._activeConnections.get(tabId);
    if (active) {
      active.close('Browser tab closed');
      this._activeConnections.delete(tabId);
    }
    this._tabSessionOwners.delete(tabId);
    ensureKeepAliveAlarm('active-tab-removed');
  }

  _onTabActivated(activeInfo) {
    for (const [pendingKey, pending] of this._pendingTabSelection) {
      if (typeof pending.selectorTabId !== 'number') continue;
      if (pending.selectorTabId === activeInfo.tabId) continue;
      if (!pending.timerId) {
        pending.timerId = setTimeout(() => {
          const existed = this._pendingTabSelection.delete(pendingKey);
          if (existed) {
            pending.connection.close('Tab inactive for 30 seconds');
            chrome.tabs.sendMessage(pending.selectorTabId, {
              type: 'connectionTimeout',
            });
          }
        }, 30000);
      }
    }
  }

  _onTabUpdated(tabId) {
    if (this._activeConnections.has(tabId)) {
      void this._setConnectedTab(tabId, true);
    }
  }
}

const tabShareExtension = new TabShareExtension();

const DISCOVERY_ALARM = 'cab-relay-discovery';
const KEEPALIVE_ALARM = 'keepAlive';
const KEEPALIVE_PERIOD_MINUTES = 0.5;
const DISCOVERY_PORTS = [
  38765, 38766, 38767, 38768, 38769, 38770, 38771, 38772, 38773, 38774, 38775,
];
const DISCOVERY_MODE = {
  FAST: 'fast',
  NORMAL: 'normal',
  IDLE: 'idle',
};
const DISCOVERY_INTERVAL_MS = {
  [DISCOVERY_MODE.FAST]: 500,
  [DISCOVERY_MODE.NORMAL]: 3000,
  [DISCOVERY_MODE.IDLE]: 15000,
};
const FAST_TO_NORMAL_EMPTY_STREAK = 5;
const NORMAL_TO_IDLE_EMPTY_STREAK = 20;
const ACTIVE_TO_IDLE_EMPTY_STREAK = 10;
let lastSuccessfulPort = null;
const lastRelayByPort = new Map();

// Interval管理: 重複防止
let discoveryIntervalId = null;

// 並列実行防止: autoOpenConnectUiが実行中かどうか
let isDiscoveryRunning = false;
let discoveryMode = DISCOVERY_MODE.FAST;
let emptyDiscoveryStreak = 0;
let keepAliveActive = false;
let lastDiscoveryTickStartedAt = 0;
let lastDiscoveryTickFinishedAt = 0;
let lastDiscoveryTickDurationMs = null;
let lastDiscoverySummary = null;
let lastDiscoveryError = null;
let lastRelayProbeAt = 0;
let lastRelayProbePort = null;
let lastRelayProbeStatus = null;
let lastRelayProbeError = null;
let lastKeepAliveAlarmAt = 0;

// リロード時クールダウン: 5秒間は「新しいrelay」検出をスキップ
// ただし reloadExtension コマンド経由のリロード時はスキップしない
const extensionStartTime = Date.now();
const COOLDOWN_MS = 5000;
let cooldownDisabled = false;

// Check if this is a reload triggered by reloadExtension command
chrome.storage.local
  .get('_reloadTriggered')
  .then(result => {
    if (result._reloadTriggered) {
      const age = Date.now() - result._reloadTriggered;
      if (age < 10000) {
        // Within 10 seconds of reload trigger
        cooldownDisabled = true;
        logInfo('discovery', 'Cooldown disabled (reloadExtension triggered)', {
          age,
        });
      }
      // Clear the flag
      chrome.storage.local.remove('_reloadTriggered').catch(() => {});
    }
  })
  .catch(() => {});

// ユーザー操作によるDiscoveryかどうかのフラグ
// Chrome起動時やService Worker再起動時はfalse、アイコンクリック時のみtrue
let userTriggeredDiscovery = false;
let userTriggeredDiscoveryUntil = 0;

function isUserTriggeredDiscoveryActive() {
  if (!userTriggeredDiscovery) {
    return false;
  }
  if (Date.now() > userTriggeredDiscoveryUntil) {
    userTriggeredDiscovery = false;
    userTriggeredDiscoveryUntil = 0;
    return false;
  }
  return true;
}

function getConnectionCounts() {
  return {
    activeCount: tabShareExtension._activeConnections.size,
    pendingCount: tabShareExtension._pendingTabSelection.size,
  };
}

function shouldKeepAlive() {
  const {activeCount, pendingCount} = getConnectionCounts();
  return (
    activeCount > 0 ||
    pendingCount > 0 ||
    discoveryIntervalId !== null ||
    isDiscoveryRunning
  );
}

function ensureKeepAliveAlarm(reason = 'state-change') {
  const needed = shouldKeepAlive();
  if (needed === keepAliveActive) {
    return;
  }
  const {activeCount, pendingCount} = getConnectionCounts();
  if (needed) {
    chrome.alarms.create(KEEPALIVE_ALARM, {
      periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
    });
    keepAliveActive = true;
    logInfo('keepalive', 'Enabled keepAlive alarm', {
      reason,
      activeCount,
      pendingCount,
    });
    return;
  }
  chrome.alarms.clear(KEEPALIVE_ALARM).catch(() => {
    // Ignore errors - alarm may not exist.
  });
  keepAliveActive = false;
  logInfo('keepalive', 'Disabled keepAlive alarm', {
    reason,
    activeCount,
    pendingCount,
  });
}

function getDiscoveryIntervalMs(mode = discoveryMode) {
  return (
    DISCOVERY_INTERVAL_MS[mode] || DISCOVERY_INTERVAL_MS[DISCOVERY_MODE.FAST]
  );
}

function setDiscoveryMode(nextMode, reason) {
  if (discoveryMode === nextMode) {
    return;
  }
  const previousMode = discoveryMode;
  discoveryMode = nextMode;
  logInfo('discovery', 'Discovery mode changed', {
    from: previousMode,
    to: nextMode,
    reason,
    intervalMs: getDiscoveryIntervalMs(nextMode),
  });
}

function getDiscoveryPortsByPriority() {
  if (!lastSuccessfulPort || !DISCOVERY_PORTS.includes(lastSuccessfulPort)) {
    return DISCOVERY_PORTS;
  }
  return [
    lastSuccessfulPort,
    ...DISCOVERY_PORTS.filter(port => port !== lastSuccessfulPort),
  ];
}

function buildConnectUrl(
  wsUrl,
  tabUrl,
  newTab,
  autoMode = false,
  sessionId,
  allowTabTakeover = false,
) {
  const params = new URLSearchParams({relayUrl: wsUrl});
  if (tabUrl) params.set('tabUrl', tabUrl);
  if (newTab) params.set('newTab', 'true');
  if (autoMode) params.set('auto', 'true');
  if (sessionId) params.set('sessionId', sessionId);
  if (allowTabTakeover) params.set('allowTabTakeover', 'true');
  return chrome.runtime.getURL(`ui/connect.html?${params.toString()}`);
}

async function focusTab(tabId, windowId) {
  try {
    if (windowId) {
      await chrome.windows.update(windowId, {focused: true});
    }
    await chrome.tabs.update(tabId, {active: true});
  } catch {
    // Ignore transient tab editing errors (e.g. user dragging tabs).
  }
}

async function getExistingConnectTab() {
  const connectBase = chrome.runtime.getURL('ui/connect.html');
  const tabs = await chrome.tabs.query({url: `${connectBase}*`});
  if (!tabs.length) return false;
  const tab = tabs[0];
  if (!tab?.id) return false;
  return tab;
}

async function ensureConnectUiTab(
  wsUrl,
  tabUrl,
  newTab,
  autoMode = false,
  sessionId,
  allowTabTakeover = false,
) {
  const existing = await getExistingConnectTab();
  if (existing?.id) {
    await focusTab(existing.id, existing.windowId);
    return existing;
  }
  const url = buildConnectUrl(
    wsUrl,
    tabUrl,
    newTab,
    autoMode,
    sessionId,
    allowTabTakeover,
  );
  const created = await chrome.tabs.create({url, active: true});
  if (created?.id) {
    await focusTab(created.id, created.windowId);
  }
  return created;
}

async function fetchRelayInfo(port, timeoutMs = 800) {
  const discoveryUrl = `http://127.0.0.1:${port}/relay-info`;
  let timer = null;
  lastRelayProbeAt = Date.now();
  lastRelayProbePort = port;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(discoveryUrl, {signal: controller.signal});
    if (!res.ok) {
      lastRelayProbeStatus = `http-${res.status}`;
      lastRelayProbeError = null;
      return null;
    }
    const data = await res.json();
    if (!data?.wsUrl) {
      lastRelayProbeStatus = 'invalid-payload';
      lastRelayProbeError = null;
      return null;
    }
    lastRelayProbeStatus = 'ok';
    lastRelayProbeError = null;
    lastSuccessfulPort = port;
    return data;
  } catch (error) {
    const message =
      error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : String(error);
    lastRelayProbeStatus = 'fetch-error';
    lastRelayProbeError = message;
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function autoConnectRelay(best) {
  const tabUrl = best?.data?.tabUrl;
  const preferredTabId = best?.data?.tabId;
  logDebug('auto-connect', 'autoConnectRelay called', {
    port: best?.port,
    tabUrl,
    tabId: preferredTabId,
    newTab: best?.data?.newTab,
  });

  if (!tabUrl) {
    logDebug('auto-connect', 'No tabUrl, skipping');
    return false; // tabUrl がなければ失敗
  }

  if (best?.port) {
    const refreshed = await fetchRelayInfo(best.port, 400);
    if (refreshed?.wsUrl) {
      best.data = refreshed;
      lastSuccessfulPort = best.port;
      logDebug('auto-connect', 'Refreshed relay info', {
        wsUrl: refreshed.wsUrl,
        tabId: refreshed.tabId,
      });
    }
  }

  // tabUrl があれば、connect.html を開かずに直接接続
  // preferredTabId があれば優先的に使用
  const requestedNewTab = Boolean(best?.data?.newTab);
  let targetTabId;
  try {
    // autoConnectRelay経由の場合はフォーカスしない（active: false）
    // newTab: relay の要求を尊重する（サーバーが newTab: true を指定した場合は新規タブ作成を許可）
    targetTabId = await tabShareExtension._resolveTabId(
      tabUrl,
      preferredTabId,
      requestedNewTab,
      false, // active: false - 自動接続時はタブをフォーカスしない
    );
  } catch (error) {
    logError('auto-connect', 'Failed to resolve tab', {
      tabUrl,
      tabId: preferredTabId,
      error: error.message,
    });
    return false;
  }
  if (!targetTabId) {
    logWarn('auto-connect', 'No targetTabId resolved');
    return false;
  }
  if (tabShareExtension._activeConnections?.has(targetTabId)) {
    const existingSessionId =
      tabShareExtension._tabSessionOwners?.get(targetTabId);
    const newSessionId = best?.data?.sessionId;
    if (
      existingSessionId &&
      newSessionId &&
      existingSessionId !== newSessionId
    ) {
      // Different session wants the same tab — replace the old connection
      logInfo('auto-connect', 'Replacing stale connection with newer session', {
        targetTabId,
        oldSession: existingSessionId,
        newSession: newSessionId,
      });
      const oldConn = tabShareExtension._activeConnections.get(targetTabId);
      if (oldConn) {
        oldConn.close('Replaced by newer session');
        tabShareExtension._activeConnections.delete(targetTabId);
        tabShareExtension._tabSessionOwners.delete(targetTabId);
      }
    } else {
      logInfo('auto-connect', 'Tab already connected', {targetTabId});
      return true; // 同じセッションで接続済み
    }
  }

  const targetTab = await chrome.tabs.get(targetTabId).catch(() => null);

  const sessionId = best?.data?.sessionId || null;
  // selectorId は後方互換のため保持。sessionId がある場合は session 軸を優先する。
  const selectorId = `auto:${best.data.wsUrl}`;
  logInfo('auto-connect', 'Attempting auto-connect', {
    selectorId,
    sessionId,
    targetTabId,
    wsUrl: best.data.wsUrl,
  });

  try {
    await tabShareExtension._connectToRelay(
      selectorId,
      best.data.wsUrl,
      sessionId,
    );
    await tabShareExtension._connectTab(
      selectorId,
      targetTabId,
      targetTab?.windowId,
      best.data.wsUrl,
      tabUrl,
      Boolean(best.data.newTab),
      sessionId,
      Boolean(best.data.allowTabTakeover),
    );
    logInfo('auto-connect', 'Auto-connect successful', {targetTabId, tabUrl});
    if (best?.port) {
      lastSuccessfulPort = best.port;
    }
  } catch (err) {
    logError('auto-connect', 'autoConnectRelay failed', {
      error: err.message,
      tabUrl,
    });
    debugLog('autoConnectRelay failed:', err);
    if (best?.port) {
      lastRelayByPort.delete(best.port);
    }
    return false;
  }
  return true;
}

async function autoOpenConnectUi() {
  const result = {
    skippedCooldown: false,
    newRelayCount: 0,
    successCount: 0,
    failureCount: 0,
  };

  // リロード直後はタブを開かない（既存サーバーとの再接続を防ぐ）
  // ただし reloadExtension コマンド経由の場合はスキップしない
  const elapsed = Date.now() - extensionStartTime;
  if (elapsed < COOLDOWN_MS && !cooldownDisabled) {
    logDebug(
      'discovery',
      `Cooldown active (${elapsed}ms < ${COOLDOWN_MS}ms), skipping`,
    );
    result.skippedCooldown = true;
    return result;
  }

  // 複数の relay を同時にサポート（ChatGPT + Gemini）
  const newRelays = [];
  const portsToCheck = getDiscoveryPortsByPriority();
  for (const port of portsToCheck) {
    const timeoutMs = port === lastSuccessfulPort ? 250 : 800;
    const data = await fetchRelayInfo(port, timeoutMs);
    if (!data?.wsUrl) {
      continue;
    }

    const last = lastRelayByPort.get(port);
    const startedAt = data.startedAt || 0;
    const instanceId = data.instanceId || '';
    if (
      last &&
      last.wsUrl === data.wsUrl &&
      last.startedAt === startedAt &&
      last.instanceId === instanceId
    ) {
      continue;
    }

    logInfo('discovery', 'New relay detected', {
      port,
      tabUrl: data.tabUrl,
      wsUrl: data.wsUrl,
      startedAt,
    });
    lastRelayByPort.set(port, {
      wsUrl: data.wsUrl,
      startedAt,
      instanceId,
    });
    newRelays.push({port, data});
  }

  // Deduplicate: when multiple relays serve the same tabUrl, prefer the newest (by startedAt)
  // This prevents stale servers from stealing connections from active ones
  const bestByTabUrl = new Map();
  for (const relay of newRelays) {
    const tabUrl = relay.data?.tabUrl || '';
    const existing = bestByTabUrl.get(tabUrl);
    const relayStartedAt = relay.data?.startedAt || 0;
    if (!existing || relayStartedAt > (existing.data?.startedAt || 0)) {
      bestByTabUrl.set(tabUrl, relay);
    }
  }
  const dedupedRelays = [...bestByTabUrl.values()];
  if (dedupedRelays.length < newRelays.length) {
    logInfo('discovery', 'Deduped relays by tabUrl (preferring newest)', {
      before: newRelays.length,
      after: dedupedRelays.length,
      dropped: newRelays
        .filter(r => !dedupedRelays.includes(r))
        .map(r => ({
          port: r.port,
          tabUrl: r.data?.tabUrl,
          startedAt: r.data?.startedAt,
        })),
    });
  }

  result.newRelayCount = dedupedRelays.length;

  if (dedupedRelays.length > 0) {
    logInfo('discovery', `Processing ${dedupedRelays.length} new relay(s)`);
  }

  // 全ての新しい relay を処理（並列ではなく順次）
  for (const relay of dedupedRelays) {
    logInfo('discovery', 'Processing relay', {
      port: relay.port,
      tabUrl: relay.data.tabUrl,
    });
    debugLog('Processing new relay:', relay.port, relay.data.tabUrl);
    let ok = false;
    try {
      ok = await autoConnectRelay(relay);
    } catch (err) {
      logError('discovery', 'autoConnectRelay error', {
        error: err.message,
        port: relay.port,
      });
      debugLog('autoConnectRelay error:', err);
      ok = false;
    }
    if (!ok) {
      result.failureCount += 1;
      const userTriggered = isUserTriggeredDiscoveryActive();
      // Only open connect.html when user explicitly clicked the extension icon
      // This prevents tab spam on Chrome restart, Service Worker restart, etc.
      if (userTriggered) {
        logInfo('discovery', 'Opening connect UI', {
          port: relay.port,
          tabUrl: relay.data.tabUrl,
        });
        await ensureConnectUiTab(
          relay.data.wsUrl,
          relay.data.tabUrl || undefined,
          Boolean(relay.data.newTab),
          false,
          relay.data.sessionId || undefined,
          Boolean(relay.data.allowTabTakeover),
        );
        userTriggeredDiscovery = false; // Reset after opening
        userTriggeredDiscoveryUntil = 0;
      } else {
        logDebug('discovery', 'Skipping connect UI (auto mode)', {
          port: relay.port,
          tabUrl: relay.data.tabUrl,
        });
      }
      continue;
    }
    result.successCount += 1;
  }

  if (newRelays.length > 0) {
    userTriggeredDiscovery = false;
    userTriggeredDiscoveryUntil = 0;
  }

  return result;
}

// Discovery is now passive - only triggered by Chrome AI Bridge requests
// The extension no longer auto-opens tabs on install/startup
// サーバーからの明示的な接続要求時のみ動作する

// Clear any existing discovery alarms from previous sessions
// This prevents leftover alarms from auto-opening tabs
chrome.alarms
  .clear(DISCOVERY_ALARM)
  .then(() => {
    logInfo('background', 'Cleared existing discovery alarm (if any)');
  })
  .catch(() => {
    // Ignore errors - alarm may not exist
  });

function updateDiscoveryMode(result) {
  const {activeCount, pendingCount} = getConnectionCounts();
  const hasRelayActivity =
    result.newRelayCount > 0 ||
    result.successCount > 0 ||
    result.failureCount > 0;

  if (pendingCount > 0 || hasRelayActivity) {
    emptyDiscoveryStreak = 0;
    setDiscoveryMode(
      DISCOVERY_MODE.FAST,
      pendingCount > 0 ? 'pending-connections' : 'relay-activity',
    );
    return;
  }

  if (result.skippedCooldown) {
    setDiscoveryMode(DISCOVERY_MODE.FAST, 'cooldown');
    return;
  }

  emptyDiscoveryStreak += 1;

  if (activeCount > 0 && emptyDiscoveryStreak >= ACTIVE_TO_IDLE_EMPTY_STREAK) {
    setDiscoveryMode(DISCOVERY_MODE.IDLE, 'stable-active-connections');
    return;
  }

  if (emptyDiscoveryStreak >= NORMAL_TO_IDLE_EMPTY_STREAK) {
    setDiscoveryMode(DISCOVERY_MODE.IDLE, 'long-idle');
    return;
  }

  if (emptyDiscoveryStreak >= FAST_TO_NORMAL_EMPTY_STREAK) {
    setDiscoveryMode(DISCOVERY_MODE.NORMAL, 'no-new-relays');
    return;
  }

  setDiscoveryMode(DISCOVERY_MODE.FAST, 'probing');
}

function scheduleDiscoveryTick(delayMs) {
  if (discoveryIntervalId !== null) {
    return;
  }
  discoveryIntervalId = setTimeout(
    async () => {
      discoveryIntervalId = null;

      if (isDiscoveryRunning) {
        scheduleDiscoveryTick(getDiscoveryIntervalMs());
        return;
      }

      isDiscoveryRunning = true;
      lastDiscoveryTickStartedAt = Date.now();
      lastDiscoveryError = null;
      lastDiscoverySummary = null;
      try {
        const result = await autoOpenConnectUi();
        lastDiscoverySummary = {
          ...result,
          mode: discoveryMode,
          intervalMs: getDiscoveryIntervalMs(),
        };
        updateDiscoveryMode(result);
      } catch (error) {
        lastDiscoveryError =
          error && typeof error === 'object' && 'message' in error
            ? String(error.message)
            : String(error);
        logWarn('discovery', 'Discovery cycle failed', {
          error: lastDiscoveryError,
        });
        emptyDiscoveryStreak = 0;
        setDiscoveryMode(DISCOVERY_MODE.FAST, 'cycle-error');
      } finally {
        lastDiscoveryTickFinishedAt = Date.now();
        lastDiscoveryTickDurationMs =
          lastDiscoveryTickFinishedAt - lastDiscoveryTickStartedAt;
        isDiscoveryRunning = false;
      }

      scheduleDiscoveryTick(getDiscoveryIntervalMs());
      // Must run AFTER scheduleDiscoveryTick so discoveryIntervalId is set,
      // otherwise shouldKeepAlive() returns false and clears the alarm.
      ensureKeepAliveAlarm('discovery-cycle');
    },
    Math.max(0, delayMs),
  );
}

function scheduleDiscovery() {
  if (discoveryIntervalId !== null || isDiscoveryRunning) {
    logDebug('discovery', 'Discovery already scheduled', {
      mode: discoveryMode,
      intervalMs: getDiscoveryIntervalMs(),
    });
    return;
  }

  logInfo('discovery', 'Starting discovery scheduler', {
    mode: discoveryMode,
    intervalMs: getDiscoveryIntervalMs(),
  });
  scheduleDiscoveryTick(0);
  ensureKeepAliveAlarm('discovery-scheduled');
}

function kickDiscovery(reason) {
  emptyDiscoveryStreak = 0;
  setDiscoveryMode(DISCOVERY_MODE.FAST, reason);
  if (discoveryIntervalId !== null) {
    clearTimeout(discoveryIntervalId);
    discoveryIntervalId = null;
  }
  scheduleDiscovery();
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === KEEPALIVE_ALARM) {
    lastKeepAliveAlarmAt = Date.now();
    const {activeCount, pendingCount} = getConnectionCounts();
    if (activeCount > 0 || pendingCount > 0) {
      logDebug('keepalive', 'Alarm triggered', {activeCount, pendingCount});
    }

    if (!shouldKeepAlive()) {
      ensureKeepAliveAlarm('alarm-prune');
      return;
    }

    if (discoveryIntervalId === null && !isDiscoveryRunning) {
      logInfo('keepalive', 'Re-arming discovery scheduler after wake');
      scheduleDiscovery();
    }
  }
});

// Note: We no longer register an onAlarm listener for DISCOVERY_ALARM
// The scheduleDiscovery function is only called on explicit server requests

// Discovery auto-starts on Chrome startup
// connect.html only opens when user clicks the extension icon
// This prevents tab spam on Chrome restart and Service Worker restart

// Start discovery when user clicks extension icon
chrome.action.onClicked.addListener(() => {
  logInfo('action', 'Extension icon clicked - starting discovery');
  userTriggeredDiscovery = true; // ユーザーが明示的にトリガー
  userTriggeredDiscoveryUntil = Date.now() + 15000;
  kickDiscovery('user-click');
});

// Auto-start discovery on install/startup
chrome.runtime.onInstalled.addListener(() => {
  logInfo('background', 'Extension installed - starting discovery');
  scheduleDiscovery();
});
chrome.runtime.onStartup.addListener(() => {
  logInfo('background', 'Chrome started - starting discovery');
  scheduleDiscovery();
});
scheduleDiscovery(); // Start immediately
// Ensure keepAlive is active from the start to prevent SW termination during discovery
ensureKeepAliveAlarm('startup');

logInfo('background', 'Extension loaded (discovery active)');
