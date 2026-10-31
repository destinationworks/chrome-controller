const NATIVE_HOST_NAME = 'com.dst.chrome_controller';
const CONTROLLED_GROUP_TITLE = 'AI Tool';
const CONTROLLED_GROUP_COLOR = 'cyan';
const RECONNECT_ALARM = 'reconnect';
const RECONNECT_INTERVAL_MIN = 1;
const KEEPALIVE_ALARM = 'keepalive';
const KEEPALIVE_INTERVAL_MIN = 1;
const RELAY_CONFIG_STORAGE_KEY = 'chromeControllerRelayConfig';
const PROTECTED_TAB_GUARDS_STORAGE_KEY = 'chromeControllerProtectedTabGuards';
const PROTECTED_TAB_ALARM_PREFIX = 'protected-tab:';
const MAX_GUARD_TTL_SECONDS = 24 * 60 * 60;
const MIN_RELAY_KEY_BYTES = 32;

let socket = null;
let sensitiveActionDepth = 0;
// Bumped whenever a guarded action starts. A request that saw another value on
// entry overlapped a guard, even one that has since expired or been released.
let outputLockEpoch = 0;
let protectedTabGuards = new Map();
let protectedTabStateUnavailable = false;
let relayConfig = null;
let relayConfigGeneration = 0;
let nativePort = null;
let controlledTabId = null;
let controlledGroupIdsByWindow = new Map();
let overlayHidden = false;
const protectedTabGuardsReady = restoreProtectedTabGuards();
const relayConfigReady = restoreRelayConfig();

function validRelayConfig(value) {
  return Boolean(
    value &&
    Number.isSafeInteger(value.wsPort) &&
    value.wsPort >= 1 &&
    value.wsPort <= 65535 &&
    typeof value.apiKey === 'string' &&
    new TextEncoder().encode(value.apiKey).length >= MIN_RELAY_KEY_BYTES
  );
}

async function restoreRelayConfig() {
  try {
    const stored = await chrome.storage.session.get(RELAY_CONFIG_STORAGE_KEY);
    const candidate = stored[RELAY_CONFIG_STORAGE_KEY];
    relayConfig = validRelayConfig(candidate) ? candidate : null;
    if (candidate && !relayConfig) await chrome.storage.session.remove(RELAY_CONFIG_STORAGE_KEY);
  } catch {
    relayConfig = null;
    console.error('Relay configuration could not be restored; relay fallback remains disabled');
  }
}

async function configureRelay(value) {
  await relayConfigReady;
  const nextConfig = validRelayConfig(value)
    ? {
        instance: typeof value.instance === 'string' ? value.instance : 'default',
        wsPort: value.wsPort,
        apiKey: value.apiKey,
        pid: value.pid,
        startedAt: value.startedAt,
      }
    : null;
  const changed = !relayConfig || !nextConfig ||
    relayConfig.wsPort !== nextConfig.wsPort ||
    relayConfig.apiKey !== nextConfig.apiKey ||
    relayConfig.instance !== nextConfig.instance;

  if (changed) {
    relayConfigGeneration += 1;
    const oldSocket = socket;
    socket = null;
    if (oldSocket) {
      oldSocket.onopen = null;
      oldSocket.onmessage = null;
      oldSocket.onclose = null;
      oldSocket.onerror = null;
      try { oldSocket.close(); } catch (_) {}
    }
  }

  relayConfig = nextConfig;
  if (!nextConfig) {
    await chrome.storage.session.remove(RELAY_CONFIG_STORAGE_KEY);
    return;
  }
  await chrome.storage.session.set({ [RELAY_CONFIG_STORAGE_KEY]: relayConfig });
}

async function restoreProtectedTabGuards() {
  try {
    const stored = await chrome.storage.session.get(PROTECTED_TAB_GUARDS_STORAGE_KEY);
    const entries = stored[PROTECTED_TAB_GUARDS_STORAGE_KEY];
    const now = Date.now();
    const restored = new Map();
    if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
      for (const [tabIdText, expiresAt] of Object.entries(entries)) {
        const tabId = Number(tabIdText);
        if (Number.isSafeInteger(tabId) && tabId > 0 && Number.isFinite(expiresAt) && expiresAt > now) {
          restored.set(tabId, expiresAt);
        }
      }
    }
    protectedTabGuards = restored;
    protectedTabStateUnavailable = false;
    await persistProtectedTabGuards();
  } catch {
    protectedTabStateUnavailable = true;
    console.error('Protected-tab state could not be restored; browser output remains locked');
  }
}

async function persistProtectedTabGuards() {
  const entries = Object.create(null);
  for (const [tabId, expiresAt] of protectedTabGuards) entries[String(tabId)] = expiresAt;
  await chrome.storage.session.set({ [PROTECTED_TAB_GUARDS_STORAGE_KEY]: entries });
}

function guardTtlSeconds(value) {
  const ttl = value === undefined ? 300 : value;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_GUARD_TTL_SECONDS) {
    throw new Error(`Protected-tab TTL must be an integer from 1 to ${MAX_GUARD_TTL_SECONDS} seconds`);
  }
  return ttl;
}

async function reserveProtectedTab(tabIdValue, ttlValue) {
  await protectedTabGuardsReady;
  if (protectedTabStateUnavailable) throw new Error('Protected-tab state is unavailable');
  const tabId = Number(tabIdValue);
  if (!Number.isSafeInteger(tabId) || tabId <= 0) throw new Error('Protected-tab guard requires a valid tabId');
  const ttlSeconds = guardTtlSeconds(ttlValue);
  const priorExpiresAt = protectedTabGuards.get(tabId) ?? 0;
  const reservationExpiresAt = Math.max(
    priorExpiresAt,
    Date.now() + MAX_GUARD_TTL_SECONDS * 1000,
  );
  protectedTabGuards.set(tabId, reservationExpiresAt);
  await persistProtectedTabGuards();
  await chrome.alarms.create(`${PROTECTED_TAB_ALARM_PREFIX}${tabId}`, { when: reservationExpiresAt });
  return { tabId, ttlSeconds, priorExpiresAt, reservationExpiresAt };
}

async function finalizeProtectedTab(reservation) {
  if (!reservation) return;
  await protectedTabGuardsReady;
  if (protectedTabStateUnavailable) throw new Error('Protected-tab state is unavailable');
  if (protectedTabGuards.get(reservation.tabId) !== reservation.reservationExpiresAt) return;
  const expiresAt = Math.max(
    reservation.priorExpiresAt,
    Date.now() + reservation.ttlSeconds * 1000,
  );
  protectedTabGuards.set(reservation.tabId, expiresAt);
  await persistProtectedTabGuards();
  await chrome.alarms.create(`${PROTECTED_TAB_ALARM_PREFIX}${reservation.tabId}`, { when: expiresAt });
}

async function unprotectTab(tabIdValue) {
  await protectedTabGuardsReady;
  const tabId = Number(tabIdValue);
  if (!Number.isSafeInteger(tabId) || tabId <= 0) return;
  protectedTabGuards.delete(tabId);
  await persistProtectedTabGuards();
  await chrome.alarms.clear(`${PROTECTED_TAB_ALARM_PREFIX}${tabId}`);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'setOverlayHidden') {
    overlayHidden = Boolean(request.hidden);
    sendResponse({ success: true, hidden: overlayHidden });
  } else if (request.action === 'getOverlayState') {
    sendResponse({ success: true, overlayHidden, controlledTabId });
  } else if (request.action === 'getConnectionState') {
    sendResponse({
      success: true,
      nativeConnected: Boolean(nativePort),
      wsConnected: Boolean(socket && socket.readyState === WebSocket.OPEN),
      relayPaired: Boolean(relayConfig),
      extensionId: chrome.runtime.id,
      controlledTabId,
    });
  }
});


// ── Native Messaging ─────────────────────────────────────────────────────────

function connectNative() {
  if (nativePort) return;

  try {
    console.log('Connecting to Native Messaging host:', NATIVE_HOST_NAME);
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    nativePort.onMessage.addListener(async (msg) => {
      try {
        if (msg?.event === 'relayConfig') {
          await configureRelay(msg.relay);
          return;
        }
        if (msg?.event === 'relayConfigUnavailable') {
          await configureRelay(null);
          return;
        }
        await handleNativeMessage(msg);
      } catch (e) {
        console.error('Error handling native message:', e);
      }
    });

    nativePort.onDisconnect.addListener(() => {
      console.log('Native Messaging host disconnected:', chrome.runtime.lastError?.message);
      nativePort = null;
      scheduleReconnect();
      // Fallback to WebSocket if native host is unavailable
      void connectWs();
    });

    nativePort.postMessage({ action: 'getRelayConfig' });
  } catch (err) {
    console.warn('Native messaging connect failed, falling back to WS:', err);
    void connectWs();
  }
}

function sendNativeResponse(id, payload) {
  if (nativePort && id) {
    nativePort.postMessage({ id, ...payload });
  }
}

async function handleNativeMessage(message) {
  await protectedTabGuardsReady;
  const { id, action, ...params } = message;
  const sensitive = params.sensitive === true;
  const recoveryClose = sensitive && action === 'removeTab';
  if (protectedTabStateUnavailable && !recoveryClose) {
    sendNativeResponse(id, { error: 'Browser output is locked because protected-tab state is unavailable' });
    return;
  }
  const epoch = outputLockEpoch;
  // Internal metadata-only admission: never reserve a guard or touch page data.
  // Existing protected tabs may coexist, but a concurrent secret action invalidates
  // admission and must not let a stale completion acknowledge another target.
  if (sensitive && action === 'preflightSecretTarget') {
    try {
      if (!Number.isSafeInteger(params.targetTabId) || params.targetTabId <= 0 || sensitiveActionDepth > 0) {
        throw new Error('Invalid target admission');
      }
      const tab = await chrome.tabs.get(params.targetTabId);
      if (tab.id !== params.targetTabId || protectedTabStateUnavailable || sensitiveActionDepth > 0 || epoch !== outputLockEpoch) {
        throw new Error('Stale target admission');
      }
      sendNativeResponse(id, { result: { tabId: tab.id } });
    } catch {
      sendNativeResponse(id, { error: 'Guarded target admission failed' });
    }
    return;
  }
  const entryLock = sensitive ? null : browserOutputLock(epoch);
  if (entryLock) {
    sendNativeResponse(id, { error: entryLock });
    return;
  }
  if (sensitive && !recoveryClose && sensitiveActionDepth > 0) {
    sendNativeResponse(id, { error: 'Sensitive browser action failed; details suppressed' });
    return;
  }
  const tracksSensitiveAction = sensitive && !recoveryClose;
  if (tracksSensitiveAction) {
    sensitiveActionDepth += 1;
    outputLockEpoch += 1;
  }
  let reservation = null;
  try {
    if (sensitive && !recoveryClose && Number.isInteger(Number(params.tabId))) {
      const ttlSeconds = params.guardTtlSeconds ?? params.ttlSeconds ?? 300;
      try {
        reservation = await reserveProtectedTab(params.tabId, ttlSeconds);
      } catch {
        protectedTabStateUnavailable = true;
        throw new Error('Protected-tab reservation failed');
      }
    }
    const result = await executeAction(action, params);
    if (reservation) {
      try {
        await finalizeProtectedTab(reservation);
      } catch {
        protectedTabStateUnavailable = true;
        throw new Error('Protected-tab finalization failed');
      }
    }
    const lock = sensitive ? null : browserOutputLock(epoch);
    sendNativeResponse(id, lock ? { error: lock } : { result });
  } catch (err) {
    if (reservation && !protectedTabStateUnavailable) {
      try {
        await finalizeProtectedTab(reservation);
      } catch {
        protectedTabStateUnavailable = true;
      }
    }
    if (sensitive) {
      console.error(`Sensitive native action ${action} failed; details suppressed`);
      sendNativeResponse(id, { error: 'Sensitive browser action failed; details suppressed' });
    } else {
      console.error(`Error executing native action ${action}:`, err);
      sendNativeResponse(id, { error: browserOutputLock(epoch) ?? err.toString() });
    }
  } finally {
    if (tracksSensitiveAction) sensitiveActionDepth -= 1;
  }
}

// ── WebSocket Fallback ────────────────────────────────────────────────────────

async function connectWs() {
  await relayConfigReady;
  if (!relayConfig) {
    console.warn('Relay fallback is not paired; waiting for Native Messaging configuration');
    scheduleReconnect();
    return;
  }
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }
  if (socket) {
    try { socket.onclose = null; socket.close(); } catch (_) {}
  }

  console.log('Attempting paired loopback WebSocket connection');
  const wsUrl = `ws://127.0.0.1:${relayConfig.wsPort}/?key=${encodeURIComponent(relayConfig.apiKey)}`;
  const generation = relayConfigGeneration;
  const candidateSocket = new WebSocket(wsUrl);
  socket = candidateSocket;

  candidateSocket.onopen = () => {
    if (socket !== candidateSocket || generation !== relayConfigGeneration) return;
    console.log('Connected to local WebSocket server');
    try { chrome.alarms.clear(RECONNECT_ALARM); } catch (_) {}
    scheduleKeepaliveAlarm();
  };

  candidateSocket.onmessage = async (event) => {
    if (socket !== candidateSocket || generation !== relayConfigGeneration) return;
    try {
      const data = JSON.parse(event.data);
      await handleWsMessage(data, candidateSocket, generation);
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  };

  candidateSocket.onclose = () => {
    if (socket !== candidateSocket || generation !== relayConfigGeneration) return;
    console.log('Disconnected from local WebSocket server');
    try { chrome.alarms.clear(RECONNECT_ALARM); } catch (_) {}
    socket = null;
    scheduleReconnect();
  };

  candidateSocket.onerror = (error) => {
    if (socket !== candidateSocket || generation !== relayConfigGeneration) return;
    console.error('WebSocket error:', error);
    candidateSocket.close();
  };
}

function scheduleReconnect() {
  try {
    chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: RECONNECT_INTERVAL_MIN });
  } catch (_) {}
}

function scheduleKeepaliveAlarm() {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MIN });
  } catch (_) {}
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    scheduleKeepaliveAlarm();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ event: 'ping' }));
    }
  } else if (alarm.name === RECONNECT_ALARM) {
    if (!nativePort && (!socket || socket.readyState !== WebSocket.OPEN)) {
      connectNative();
    }
  } else if (alarm.name.startsWith(PROTECTED_TAB_ALARM_PREFIX)) {
    await protectedTabGuardsReady;
    const tabId = Number(alarm.name.slice(PROTECTED_TAB_ALARM_PREFIX.length));
    if (!Number.isSafeInteger(tabId)) return;
    const expiresAt = protectedTabGuards.get(tabId);
    if (!expiresAt) return;
    if (expiresAt > Date.now()) {
      await chrome.alarms.create(alarm.name, { when: expiresAt });
      return;
    }
    await unprotectTab(tabId);
  }
});

function sendSocketResponse(id, payload, targetSocket = socket, generation = relayConfigGeneration) {
  if (
    targetSocket &&
    targetSocket === socket &&
    generation === relayConfigGeneration &&
    targetSocket.readyState === WebSocket.OPEN &&
    id
  ) {
    targetSocket.send(JSON.stringify({ id, ...payload }));
  }
}

async function sendTabMessage(tabId, message, options = { frameId: 0 }) {
  if (!tabId) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, message, options);
  } catch (err) {
    return null;
  }
}

const REQUIRED_CONTENT_ACTIONS = new Set([
  'clickSelector', 'fillSelector', 'selectOption', 'snapshotElements', 'getPageErrors',
]);

function assertContentActionTarget(action, params) {
  if (REQUIRED_CONTENT_ACTIONS.has(action) &&
      (!Number.isSafeInteger(params.tabId) || params.tabId <= 0)) {
    throw new Error(`Content action ${action} requires a positive integer tabId`);
  }
}

async function sendRequiredTabMessage(tabId, message) {
  const result = await sendTabMessage(tabId, message);
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.success !== true) {
    // Content errors can contain page data. Never forward an unsuccessful payload.
    throw new Error(`Content action ${message.action} failed: no successful content-script acknowledgement`);
  }
  return result;
}

async function getTabInfo(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return {
      tabId: tab.id,
      title: tab.title || '',
      url: tab.url || '',
      active: tab.active,
      windowId: tab.windowId,
    };
  } catch (err) {
    return { tabId };
  }
}

async function getControlledGroupId(windowId) {
  const cachedGroupId = controlledGroupIdsByWindow.get(windowId);
  if (typeof cachedGroupId === 'number') {
    try {
      const group = await chrome.tabGroups.get(cachedGroupId);
      if (group && group.windowId === windowId) {
        return cachedGroupId;
      }
    } catch (err) {
      controlledGroupIdsByWindow.delete(windowId);
    }
  }

  const groups = await chrome.tabGroups.query({ windowId, title: CONTROLLED_GROUP_TITLE });
  if (groups.length > 0) {
    controlledGroupIdsByWindow.set(windowId, groups[0].id);
    return groups[0].id;
  }

  return null;
}

async function ensureControlledTabGroup(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || tab.windowId == null) return null;

    const existingGroupId = await getControlledGroupId(tab.windowId);
    const groupId = await chrome.tabs.group(
      existingGroupId == null
        ? { tabIds: tabId }
        : { tabIds: tabId, groupId: existingGroupId }
    );
    controlledGroupIdsByWindow.set(tab.windowId, groupId);
    await chrome.tabGroups.update(groupId, {
      title: CONTROLLED_GROUP_TITLE,
      color: CONTROLLED_GROUP_COLOR,
      collapsed: false,
    });
    return groupId;
  } catch (err) {
    console.warn('Could not group controlled tab:', err);
    return null;
  }
}

async function releaseControlledTab(tabId, reason = 'released') {
  if (!tabId) return { success: true };
  await sendTabMessage(tabId, {
    action: 'setControllerState',
    selected: false,
    status: 'released',
    reason,
    overlayHidden,
  });
  if (controlledTabId === tabId) {
    controlledTabId = null;
  }
  return { success: true, tabId };
}

async function cleanupManagedTabs(options = {}) {
  const groups = await chrome.tabGroups.query({ title: CONTROLLED_GROUP_TITLE });
  const groupIds = groups.map((group) => group.id);
  const tabs = groupIds.length > 0
    ? await chrome.tabs.query({})
    : [];
  const managedTabs = tabs.filter((tab) => groupIds.includes(tab.groupId));
  const tabIds = managedTabs.map((tab) => tab.id).filter((tabId) => typeof tabId === 'number');

  if (options.closeTabs === true && tabIds.length > 0) {
    await chrome.tabs.remove(tabIds);
    if (tabIds.includes(controlledTabId)) {
      controlledTabId = null;
    }
  } else {
    await Promise.all(tabIds.map((tabId) => releaseControlledTab(tabId, 'cleanup')));
  }

  return {
    success: true,
    groupCount: groups.length,
    tabCount: tabIds.length,
    closedTabs: options.closeTabs === true ? tabIds : [],
    releasedTabs: options.closeTabs === true ? [] : tabIds,
  };
}

async function setControlledTab(tabId, reason = 'targeted') {
  if (!tabId) return;

  const previousTabId = controlledTabId;
  controlledTabId = tabId;

  if (previousTabId && previousTabId !== tabId) {
    await releaseControlledTab(previousTabId, 'switchedTab');
  }

  await ensureControlledTabGroup(tabId);
  await sendTabMessage(tabId, {
    action: 'setControllerState',
    selected: true,
    status: 'targeted',
    reason,
    overlayHidden,
  });
}

function visualizeAction(tabId, actionType, detail = '', options = {}) {
  if (!tabId) return;
  return sendTabMessage(tabId, {
    action: 'visualizeAction',
    type: actionType,
    detail,
    sound: options.sound !== false,
  });
}

function mouseEventTypeToVisualType(type) {
  if (type === 'mouseMoved') return 'move';
  if (type === 'mousePressed') return 'press';
  if (type === 'mouseReleased') return 'release';
  return 'action';
}

async function visualizeCdpCommand(tabId, method, commandParams = {}) {
  if (!tabId) return;

  if (method === 'Input.dispatchMouseEvent') {
    await sendTabMessage(tabId, {
      action: 'visualizeAction',
      type: mouseEventTypeToVisualType(commandParams.type),
      x: commandParams.x,
      y: commandParams.y,
      button: commandParams.button,
      detail: commandParams.type,
    });
    return;
  }

  if (method === 'Input.dispatchKeyEvent') {
    await sendTabMessage(tabId, {
      action: 'visualizeAction',
      type: 'typing',
      detail: commandParams.text || commandParams.key || commandParams.type || 'key event',
    });
    return;
  }

  if (method === 'Input.insertText') {
    await sendTabMessage(tabId, {
      action: 'visualizeAction',
      type: 'insertText',
      detail: commandParams.text || '',
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendAnimatedInsertText(tabId, commandParams = {}) {
  const text = String(commandParams.text || '');
  const delayMs = Math.max(12, Math.min(Number(commandParams.typingDelayMs || 65), 240));
  const jitterMs = Math.max(0, Math.min(Number(commandParams.typingJitterMs || 24), 80));
  let lastResult = {};

  for (const char of Array.from(text)) {
    lastResult = await chrome.debugger.sendCommand(
      { tabId },
      'Input.insertText',
      { text: char }
    );
    await visualizeAction(tabId, 'insertText', char, { sound: commandParams.sound !== false });
    await sleep(delayMs + Math.round(Math.random() * jitterMs));
    if (char === ' ' || char === '\n' || /[.,!?;:]/.test(char)) {
      await sleep(Math.round(delayMs * 0.65));
    }
  }

  return lastResult;
}

function scriptBodyToRuntimeExpression(funcBody) {
  return `(() => { ${funcBody || ''} })()`;
}

const ALLOWED_BATCH_ACTIONS = new Set([
  'createTab',
  'queryTabs',
  'selectTab',
  'removeTab',
  'updateTab',
  'executeScript',
  'clickSelector',
  'fillSelector',
  'selectOption',
  'snapshotElements',
  'getPageErrors',
  'captureScreenshot',
  'captureVideo',
  'releaseTab',
  'ensureDebugger',
  'attachDebugger',
  'detachDebugger',
  'visualizeAction',
  'evaluateOnPage',
  'getConsoleLogs',
  'cleanupManagedTabs',
  'setOverlayHidden',
  'getOverlayState',
  'sendCommand',
]);

// Raw CDP stays out of batches except the input methods chrome_type_text and
// chrome_mouse send. Keep in step with BATCH_CDP_METHODS in src/server.ts.
const BATCH_CDP_METHODS = new Set(['Input.insertText', 'Input.dispatchMouseEvent']);

// Same rule as batchItemsOf in src/server.ts. A body is a batch when its
// action is "batch", or when it names no action and carries actions or
// commands. Its items come from exactly one of those keys, which must hold the
// array. Any other action carrying either key is refused.
function batchItemsOf(action, params) {
  const hasActions = params.actions !== undefined;
  const hasCommands = params.commands !== undefined;
  if (action !== undefined && action !== 'batch') {
    if (hasActions || hasCommands) throw new Error('Only a batch can carry actions or commands');
    return undefined;
  }
  if (!hasActions && !hasCommands) {
    if (action === 'batch') throw new Error('Batch payload must include an actions array');
    return undefined;
  }
  if (hasActions && hasCommands) {
    throw new Error('Batch payload must use either actions or commands, not both');
  }
  const items = hasActions ? params.actions : params.commands;
  if (!Array.isArray(items)) {
    throw new Error('Batch payload must include an actions array');
  }
  return items;
}

async function runBatch(actions, options = {}) {
  const epoch = outputLockEpoch;
  const mode = options.mode === 'sequential' ? 'sequential' : 'parallel';
  const stopOnError = options.stopOnError !== false;
  const normalized = actions.map((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.action !== 'string') {
      throw new Error(`Batch item ${index} is missing action`);
    }
    if (item.action === 'batch') {
      throw new Error(`Batch item ${index} cannot be a nested batch`);
    }
    if (!ALLOWED_BATCH_ACTIONS.has(item.action)) {
      throw new Error(`Batch item ${index} specifies disallowed action "${item.action}"`);
    }
    if (item.action === 'sendCommand' && !BATCH_CDP_METHODS.has(item.method)) {
      // Only a string is named: String() throws on some JSON objects.
      const method = typeof item.method === 'string' ? item.method : `<${typeof item.method}>`;
      throw new Error(`Batch item ${index} sends CDP method "${method}", which batches do not allow`);
    }
    const { action, ...params } = item;
    assertContentActionTarget(action, params);
    return { action, params };
  });

  if (mode === 'sequential') {
    const results = [];
    for (let index = 0; index < normalized.length; index += 1) {
      // A guard can appear while an earlier item awaits: the host has stopped
      // tracking a native request once it times out. Stop the whole batch, whatever
      // stopOnError says; its caller gets the lock error only.
      const lock = browserOutputLock(epoch);
      if (lock) throw new Error(lock);
      const { action, params } = normalized[index];
      try {
        const result = await executeAction(action, params);
        results.push({ index, action, success: true, result });
      } catch (err) {
        results.push({ index, action, success: false, error: err.toString() });
        if (stopOnError) break;
      }
    }
    return { mode, results, success: results.every((item) => item.success) };
  }

  const settled = await Promise.allSettled(
    normalized.map(({ action, params }) => executeAction(action, params))
  );
  const results = settled.map((item, index) => ({
    index,
    action: normalized[index].action,
    success: item.status === 'fulfilled',
    ...(item.status === 'fulfilled'
      ? { result: item.value }
      : { error: item.reason?.toString() || String(item.reason) }),
  }));

  return { mode, results, success: results.every((item) => item.success) };
}

async function executeAction(action, params = {}) {
  assertContentActionTarget(action, params);
  const batchItems = batchItemsOf(action, params);
  if (batchItems) return runBatch(batchItems, params);

  let result = null;

  if (action === 'createTab') {
    result = await chrome.tabs.create({ url: params.url, active: params.active !== false });
    await setControlledTab(result.id, 'createTab');
  } else if (action === 'queryTabs') {
    result = await chrome.tabs.query(params.queryInfo || {});
  } else if (action === 'removeTab') {
    await chrome.tabs.remove(params.tabId);
    if (controlledTabId === params.tabId) {
      controlledTabId = null;
    }
    result = { success: true };
  } else if (action === 'createWindow') {
    result = await chrome.windows.create({ url: params.url, incognito: params.incognito || false });
    if (result.tabs && result.tabs[0]) {
      await setControlledTab(result.tabs[0].id, 'createWindow');
    }
  } else if (action === 'updateTab') {
    result = await chrome.tabs.update(params.tabId, { url: params.url, active: params.active });
    await setControlledTab(params.tabId || result.id, 'updateTab');
  } else if (action === 'executeScript') {
    await setControlledTab(params.tabId, 'executeScript');
    try {
      await chrome.debugger.attach({ tabId: params.tabId }, params.requiredVersion || '1.3');
    } catch (err) {
      if (!/already attached/i.test(err.toString())) throw err;
    }
    result = await chrome.debugger.sendCommand(
      { tabId: params.tabId },
      'Runtime.evaluate',
      {
        expression: scriptBodyToRuntimeExpression(params.funcBody),
        returnByValue: true,
        awaitPromise: true,
      }
    );
  } else if (action === 'clickSelector') {
    await setControlledTab(params.tabId, 'clickSelector');
    result = await sendRequiredTabMessage(params.tabId, {
      action: 'clickSelector',
      selector: params.selector,
      elementId: params.elementId,
    });
  } else if (action === 'fillSelector') {
    await setControlledTab(params.tabId, 'fillSelector');
    result = await sendRequiredTabMessage(params.tabId, {
      action: 'fillSelector',
      selector: params.selector,
      elementId: params.elementId,
      text: params.text,
    });
  } else if (action === 'selectOption') {
    await setControlledTab(params.tabId, 'selectOption');
    result = await sendRequiredTabMessage(params.tabId, {
      action: 'selectOption',
      selector: params.selector,
      elementId: params.elementId,
      value: params.value,
    });
  } else if (action === 'snapshotElements') {
    await setControlledTab(params.tabId, 'snapshotElements');
    result = await sendRequiredTabMessage(params.tabId, {
      action: 'snapshotElements',
      showOverlay: params.showOverlay !== false,
    });
  } else if (action === 'getPageErrors') {
    result = await sendRequiredTabMessage(params.tabId, { action: 'getPageErrors' });
  } else if (action === 'attachDebugger') {
    await chrome.debugger.attach({ tabId: params.tabId }, params.requiredVersion || '1.3');
    await setControlledTab(params.tabId, 'attachDebugger');
    result = { success: true };
  } else if (action === 'ensureDebugger') {
    try {
      await chrome.debugger.attach({ tabId: params.tabId }, params.requiredVersion || '1.3');
    } catch (err) {
      if (!/already attached/i.test(err.toString())) throw err;
    }
    await setControlledTab(params.tabId, 'ensureDebugger');
    result = { success: true };
  } else if (action === 'detachDebugger') {
    await chrome.debugger.detach({ tabId: params.tabId });
    result = { success: true };
  } else if (action === 'sendCommand') {
    const commandParams = params.commandParams || {};
    if (params.method === 'Input.insertText' && commandParams.animateTyping === true) {
      result = await sendAnimatedInsertText(params.tabId, commandParams);
    } else {
      result = await chrome.debugger.sendCommand(
        { tabId: params.tabId },
        params.method,
        commandParams
      );
    }
    await setControlledTab(params.tabId, 'sendCommand');
    if (!(params.method === 'Input.insertText' && commandParams.animateTyping === true)) {
      await visualizeCdpCommand(params.tabId, params.method, commandParams);
    }
  } else if (action === 'visualizeAction') {
    if (!params.tabId) throw new Error('tabId is required for visual actions');
    await setControlledTab(params.tabId, 'visualizeAction');
    result = await sendTabMessage(params.tabId, {
      action: 'visualizeAction',
      type: params.type,
      x: params.x,
      y: params.y,
      active: params.active,
      detail: params.detail,
      button: params.button,
    });
  } else if (action === 'selectTab') {
    await setControlledTab(params.tabId, 'selectTab');
    if (params.activate !== false) {
      result = await chrome.tabs.update(params.tabId, { active: true });
    } else {
      result = await getTabInfo(params.tabId);
    }
  } else if (action === 'releaseTab') {
    result = await releaseControlledTab(params.tabId, params.reason || 'releaseTab');
  } else if (action === 'captureScreenshot' || action === 'screenshot') {
    await setControlledTab(params.tabId, 'captureScreenshot');
    try {
      await chrome.debugger.attach({ tabId: params.tabId }, params.requiredVersion || '1.3');
    } catch (err) {
      if (!/already attached/i.test(err.toString())) throw err;
    }
    const cmdResult = await chrome.debugger.sendCommand(
      { tabId: params.tabId },
      'Page.captureScreenshot',
      params.screenshotOptions || { format: 'png', quality: 100 }
    );
    result = { success: true, data: cmdResult, format: (params.screenshotOptions && params.screenshotOptions.format) || 'png' };
  } else if (action === 'captureVideo') {
    await setControlledTab(params.tabId, 'captureVideo');
    try {
      await chrome.debugger.attach({ tabId: params.tabId }, params.requiredVersion || '1.3');
    } catch (err) {
      if (!/already attached/i.test(err.toString())) throw err;
    }

    const fps = Number(params.fps) || 5;
    const duration = Number(params.duration) || 3;
    const format = params.format || 'jpeg';
    const quality = Number(params.quality) || 80;
    const intervalMs = Math.round(1000 / fps);
    const totalFrames = Math.round(duration * fps);
    const frames = [];

    for (let i = 0; i < totalFrames; i++) {
      try {
        const frame = await chrome.debugger.sendCommand(
          { tabId: params.tabId },
          'Page.captureScreenshot',
          { format, quality }
        );
        frames.push({ index: i, timestamp: Date.now(), data: frame });
        if (i < totalFrames - 1) await sleep(intervalMs);
      } catch (err) {
        frames.push({ index: i, timestamp: Date.now(), error: err.toString() });
      }
    }

    result = { frames, count: frames.length, fps, duration, format };
  } else if (action === 'evaluateOnPage') {
    await setControlledTab(params.tabId, 'evaluateOnPage');
    try {
      await chrome.debugger.attach({ tabId: params.tabId }, params.requiredVersion || '1.3');
    } catch (err) {
      if (!/already attached/i.test(err.toString())) throw err;
    }
    result = await chrome.debugger.sendCommand(
      { tabId: params.tabId },
      'Runtime.evaluate',
      {
        expression: params.expression,
        returnByValue: params.returnByValue !== false,
        awaitPromise: params.awaitPromise !== false,
      }
    );
  } else if (action === 'getConsoleLogs') {
    await setControlledTab(params.tabId, 'getConsoleLogs');
    try {
      await chrome.debugger.attach({ tabId: params.tabId }, params.requiredVersion || '1.3');
    } catch (err) {
      if (!/already attached/i.test(err.toString())) throw err;
    }
    await chrome.debugger.sendCommand({ tabId: params.tabId }, 'Runtime.enable');
    const logs = [];
    const timeout = Number(params.timeoutMs || 2000);
    const collected = await new Promise((resolve) => {
      const handler = (source, method, eventParams) => {
        if (source.tabId === params.tabId && method === 'Runtime.consoleAPICalled') {
          const entry = {
            type: eventParams.type || 'log',
            arguments: (eventParams.args || []).map((arg) => arg.value || arg.description || ''),
            timestamp: Date.now(),
          };
          logs.push(entry);
        }
      };
      chrome.debugger.onEvent.addListener(handler);
      setTimeout(() => {
        chrome.debugger.onEvent.removeListener(handler);
        resolve(logs);
      }, timeout);
    });
    result = { logs: collected, count: collected.length };
  } else if (action === 'cleanupManagedTabs') {
    result = await cleanupManagedTabs(params);
  } else if (action === 'setOverlayHidden') {
    overlayHidden = Boolean(params.hidden);
    if (controlledTabId) {
      await sendTabMessage(controlledTabId, {
        action: 'setOverlayHidden',
        hidden: overlayHidden,
      });
    }
    result = { success: true, hidden: overlayHidden };
  } else if (action === 'getOverlayState') {
    result = { success: true, overlayHidden, controlledTabId };
  } else {
    throw new Error(`Unknown action: ${action}`);
  }

  return result;
}

async function handleWsMessage(message, targetSocket = socket, generation = relayConfigGeneration) {
  await protectedTabGuardsReady;
  if (targetSocket !== socket || generation !== relayConfigGeneration) return;
  const { id, action, ...params } = message;
  const epoch = outputLockEpoch;
  const entryLock = browserOutputLock(epoch);
  if (entryLock) {
    sendSocketResponse(id, { error: entryLock }, targetSocket, generation);
    return;
  }
  let payload;
  try {
    payload = { result: await executeAction(action, params) };
  } catch (err) {
    console.error(`Error executing action ${action}:`, err);
    payload = { error: err.toString() };
  }
  const lock = browserOutputLock(epoch);
  sendSocketResponse(id, lock ? { error: lock } : payload, targetSocket, generation);
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  await protectedTabGuardsReady;
  if (protectedTabStateUnavailable) return;
  if (sensitiveActionDepth > 0) return;
  if (isProtectedTab(source.tabId)) return;
  const eventObj = { event: 'debuggerEvent', source, method, params };
  if (nativePort) {
    nativePort.postMessage(eventObj);
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(eventObj));
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try { await unprotectTab(tabId); } catch { protectedTabStateUnavailable = true; }
  if (controlledTabId === tabId) {
    controlledTabId = null;
  }
});

function isProtectedTab(tabId) {
  if (!Number.isInteger(Number(tabId))) return false;
  const id = Number(tabId);
  const expiresAt = protectedTabGuards.get(id);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    protectedTabGuards.delete(id);
    void persistProtectedTabGuards().catch(() => { protectedTabStateUnavailable = true; });
    return false;
  }
  return true;
}

// Why output of a non-sensitive request that started at `sinceEpoch` is withheld,
// or null when it may flow. Checked on entry, between batch items, and again before
// any result or error is sent: whatever a request read while a guarded action ran
// stays withheld, even after that guard expires or its tab closes.
function browserOutputLock(sinceEpoch) {
  if (protectedTabStateUnavailable) return 'Browser output is locked because protected-tab state is unavailable';
  if (hasActiveProtectedTabs()) return 'Browser output is locked while a protected secret tab is active';
  if (sensitiveActionDepth > 0) return 'Browser output is locked during guarded extraction';
  if (sinceEpoch !== outputLockEpoch) return 'Browser output is locked because a guarded action ran during this request';
  return null;
}

function hasActiveProtectedTabs() {
  for (const tabId of protectedTabGuards.keys()) {
    if (isProtectedTab(tabId)) return true;
  }
  return false;
}

chrome.tabGroups.onRemoved.addListener((group) => {
  if (group.title === CONTROLLED_GROUP_TITLE) {
    controlledGroupIdsByWindow.delete(group.windowId);
  }
});

// Try connecting via Native Messaging host first
connectNative();
