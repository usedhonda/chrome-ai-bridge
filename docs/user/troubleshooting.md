# Troubleshooting Guide

## Extension Not Loading

### Symptoms
- Extension icon not visible in Chrome toolbar
- MCP server cannot connect to extension

### Solutions

1. **Install the Chrome extension**
   - Open `chrome://extensions/`
   - Enable "Developer mode" (toggle in top-right)
   - Click "Load unpacked" and select `build/extension/` directory
   - Verify the extension appears and is enabled

2. **Validate manifest syntax**
   - Must be valid Manifest V3
   - Check for JSON syntax errors
   - Required fields: `manifest_version`, `name`, `version`

3. **Check extension errors**
   - Open `chrome://extensions/`
   - Click "Errors" under the chrome-ai-bridge extension
   - Check Service Worker console for errors

4. **Rebuild if needed**
   ```bash
   npm run build
   ```
   Then reload the extension in `chrome://extensions/`

## MCP Server Not Starting

### Check version
```bash
npx chrome-ai-bridge@latest --version
```

### Clear npx cache
```bash
npx clear-npx-cache
# or
rm -rf ~/.npm/_npx
```

### Verify MCP configuration
```bash
cat ~/.claude.json | jq '.mcpServers'
```

### Common issues

1. **Stale cache** - Clear npx cache and restart
2. **Invalid JSON** - Validate `~/.claude.json` syntax
3. **Port conflict** - Check if port 8766 is already in use:
   ```bash
   lsof -i :8766 | grep LISTEN
   ```
4. **Stale processes** - Cleanup old MCP server processes (namespace-safe by default):
   ```bash
   npm run cleanup
   # Use only when you intentionally want to kill every namespace:
   npm run cleanup -- --all
   ```

## Extension Connection Issues

### Symptoms
- "Extension not connected" error
- MCP tools not responding

### Solutions

1. **Verify Discovery Server is running**
   ```bash
   curl http://127.0.0.1:8766/mcp-discovery
   ```
   Expected response:
   ```json
   {"wsUrl": "ws://127.0.0.1:XXXXX", ...}
   ```

2. **Check port 8766 availability**
   ```bash
   lsof -i :8766 | grep LISTEN
   ```

3. **Click extension icon** to trigger reconnection

4. **Restart Chrome** to reload the Service Worker

5. **Check extension permissions** in `chrome://extensions/`

## Hot-Reload Not Working (Developers)

### Verify development mode
```bash
ps aux | grep mcp-wrapper | grep MCP_ENV=development
```

### Check tsc -w is running
```bash
ps aux | grep 'tsc -w'
```

### Manually restart wrapper
```bash
pkill -f mcp-wrapper
# Then restart AI client (Cmd+R)
```

## ChatGPT/Gemini Integration Issues

### Login required
- First use requires manual login in browser
- MCP will prompt when login is needed
- Credentials are saved in browser profile

### Response not captured
- Wait for response to complete
- Check network connectivity
- Verify ChatGPT/Gemini service is available
- Try running with debug mode: `{ "question": "...", "debug": true }`

### Empty response (background tab)
- v2.1+ uses network extraction which is unaffected by background tab throttling
- If DOM fallback is used, `Page.bringToFront` handles this automatically
- See SPEC.md Section 13 Problem 4 for details

## Network Extraction Issues

### Symptoms
- Network interceptor captures frames but text is empty
- Falling back to DOM extraction when network should work

### Diagnosis
```bash
# Test network extraction directly
npm run test:network -- chatgpt
npm run test:network -- gemini
```

Check the output for:
- **Tracked requests**: Verify API URLs are being captured
- **Extracted text**: Verify text is non-empty
- **Frame count**: Should be > 0 for API responses

### Common causes

1. **`Network.enable` not called**: Ensure it's called in both tab reuse and new tab paths in `fast-chat.ts`
2. **API endpoint changed**: Check URL patterns in `network-interceptor.ts`:
   - ChatGPT: `/backend-api/f/conversation`
   - Gemini: `/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`
3. **Response body unavailable**: Some redirects or cancelled requests don't have response bodies (expected)

## Performance Issues

### Slow startup
- First connection requires extension handshake (~2-3s)
- Subsequent connections reuse existing tabs (faster)

### Memory usage
- Close unused browser tabs
- Restart MCP server periodically
- Kill stale processes (namespace-safe): `npm run cleanup`

### Many panes / many MCP clients (OOM or timeout under load)

When running many panes at once, tune IPC overload protection on the Primary:

```bash
export CAI_IPC_MAX_SESSIONS=20
export CAI_IPC_RESERVED_INIT_SLOTS=2
export CAI_IPC_MAX_QUEUE=64
export CAI_IPC_QUEUE_WAIT_TIMEOUT_MS=45000
export CAI_IPC_SESSION_IDLE_MS=1800000
export CAI_EXEC_MAX_CONCURRENCY=3
export CAI_STARTUP_PROCESS_THRESHOLD=8
export CAI_STARTUP_DELAY_JITTER_MS=1500
export CAI_PRIMARY_IDLE_MS=0
```

Expected overload errors:
- `SERVER_CAPACITY_EXCEEDED`: session capacity is full and no initialize waiter slot is available
- `SERVER_QUEUE_FULL`: initialize queue is full
- `SERVER_BUSY_TIMEOUT`: queued initialize request waited too long

Recommended startup sequence for large tmux workspaces:
1. Start 2 panes -> verify basic tool call
2. Scale to 4 panes -> verify health
3. Scale to 8 panes -> verify no repeated reconnect loops
4. Scale to 20 panes

If you still see intermittent `Transport closed` after long idle time, verify:
- `CAI_PRIMARY_IDLE_MS=0` (prevents Primary auto-exit while clients are still open)
- `CAI_IPC_SESSION_IDLE_MS` is not too short for your usage pattern

## Debug Mode

Enable verbose logging:
```bash
DEBUG=mcp:* npx chrome-ai-bridge@latest
```

Or check debug files:
```bash
ls .local/chrome-ai-bridge/debug/
```

## Still Having Issues?

1. Check [GitHub Issues](https://github.com/usedhonda/chrome-ai-bridge/issues)
2. Search existing discussions
3. Create a new issue with:
   - Error message
   - Configuration used
   - Steps to reproduce
   - Output of `npm run test:network -- chatgpt` (if relevant)

## Auto-Recovery Tuning (v2.3.x+)

If you see frequent `tools/call` timeout around 60 seconds:

```bash
# Keep internal waits under client deadline (defaults shown)
export CAI_MCP_TOOL_BUDGET_MS=50000
export CAI_RESPONSE_WAIT_MAX_MS=40000
export CAI_MCP_BUDGET_RESERVE_MS=3000
```

If startup gets stuck behind an unhealthy Primary:

```bash
# Auto-heal unhealthy primary older than this threshold (ms)
export CAI_PRIMARY_SELF_HEAL_MIN_AGE_MS=20000
```

Cross-project isolation:
- Lock namespace is now derived from project scope (git root/cwd) automatically.
- You can force explicit isolation with:

```bash
export CAI_NAMESPACE=my-project-name
```
