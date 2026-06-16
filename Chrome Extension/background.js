const API_KEY = 'B3C65095-74E1-4F48-9EBB-64F5DD6AB078';
const WS_URL = 'ws://127.0.0.1:8899/?key=' + API_KEY;
const CONTROLLED_GROUP_TITLE = 'AI Tool';
const CONTROLLED_GROUP_COLOR = 'cyan';
const RECONNECT_ALARM = 'reconnect';
const RECONNECT_INTERVAL_MIN = 1; // 1 min — chrome.alarms minimum period
const KEEPALIVE_ALARM = 'keepalive';
const KEEPALIVE_INTERVAL_MIN = 1; // 1 min — keeps worker from suspending

let socket = null;
let controlledTabId = null;
let controlledGroupIdsByWindow = new Map();

function connect() {
  console.log('Attempting to connect to ' + WS_URL);
  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    console.log('Connected to local WebSocket server');
    // No setInterval — MV3 suspends the worker after ~30s idle.
    // Ping + keepalive handled by chrome.alarms.
    scheduleKeepaliveAlarm();
  };

  socket.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      await handleMessage(data);
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  };

  socket.onclose = () => {
    console.log('Disconnected from local WebSocket server');
    socket = null;
    scheduleReconnect();
  };

  socket.onerror = (error) => {
    console.error('WebSocket error:', error);
    socket.close();
  };
}

function scheduleReconnect() {
  // chrome.alarms fires even when the service worker is suspended,
  // so the reconnect loop survives MV3 idle suspension.
  try {
    chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: RECONNECT_INTERVAL_MIN });
  } catch (_) {
    // alarms permission not available (dev mode quirks)
  }
}

function scheduleKeepaliveAlarm() {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MIN });
  } catch (_) {}
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // Send ping to keep WebSocket alive.
    scheduleKeepaliveAlarm();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ event: 'ping' }));
    }
  } else if (alarm.name === RECONNECT_ALARM) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.log('Alarm-triggered reconnect');
      connect();
    }
  }
});

function sendSocketResponse(id, payload) {
  if (socket && socket.readyState === WebSocket.OPEN && id) {
    socket.send(JSON.stringify({ id, ...payload }));
  }
}

async function sendTabMessage(tabId, message) {
  if (!tabId) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    // Restricted URLs such as chrome:// do not have content scripts.
    return null;
  }
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
    await releaseControlledTab(previousTabId, reason);
  }

  const groupId = await ensureControlledTabGroup(tabId);
  await sendTabMessage(tabId, {
    action: 'setControllerState',
    selected: true,
    status: 'selected',
    reason,
    tab: await getTabInfo(tabId),
    group: {
      id: groupId,
      title: CONTROLLED_GROUP_TITLE,
      color: CONTROLLED_GROUP_COLOR,
    },
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
    await sendTabMessage(tabId, {
      action: 'visualizeAction',
      type: 'insertText',
      detail: char,
      sound: commandParams.sound !== false,
    });
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

async function runBatch(actions, options = {}) {
  if (!Array.isArray(actions)) {
    throw new Error('Batch action requires actions array');
  }

  const mode = options.mode === 'sequential' ? 'sequential' : 'parallel';
  const stopOnError = options.stopOnError !== false;
  const normalized = actions.map((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.action !== 'string') {
      throw new Error(`Batch item ${index} is missing action`);
    }
    const { action, ...params } = item;
    return { action, params };
  });

  if (mode === 'sequential') {
    const results = [];
    for (let index = 0; index < normalized.length; index += 1) {
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
      if (!/already attached/i.test(err.toString())) {
        throw err;
      }
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
  } else if (action === 'getAllCookies') {
    result = await chrome.cookies.getAll(params.details || {});
  } else if (action === 'setCookie') {
    result = await chrome.cookies.set(params.details);
  } else if (action === 'removeCookie') {
    result = await chrome.cookies.remove(params.details);
  } else if (action === 'attachDebugger') {
    await chrome.debugger.attach({ tabId: params.tabId }, params.requiredVersion || '1.3');
    await setControlledTab(params.tabId, 'attachDebugger');
    result = { success: true };
  } else if (action === 'ensureDebugger') {
    try {
      await chrome.debugger.attach({ tabId: params.tabId }, params.requiredVersion || '1.3');
    } catch (err) {
      if (!/already attached/i.test(err.toString())) {
        throw err;
      }
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
    if (!params.tabId) {
      throw new Error('tabId is required for visual actions');
    }
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
      if (!/already attached/i.test(err.toString())) {
        throw err;
      }
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
      if (!/already attached/i.test(err.toString())) {
        throw err;
      }
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
        if (i < totalFrames - 1) {
          await sleep(intervalMs);
        }
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
      if (!/already attached/i.test(err.toString())) {
        throw err;
      }
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
      if (!/already attached/i.test(err.toString())) {
        throw err;
      }
    }
    // Enable the Runtime domain to receive console events
    await chrome.debugger.sendCommand({ tabId: params.tabId }, 'Runtime.enable');
    // Collect console events for a short window
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
  } else if (action === 'batch') {
    result = await runBatch(params.actions || params.commands, params);
  } else {
    throw new Error(`Unknown action: ${action}`);
  }

  return result;
}

async function handleMessage(message) {
  const { id, action, ...params } = message;

  try {
    const result = await executeAction(action, params);
    sendSocketResponse(id, { result });
  } catch (err) {
    console.error(`Error executing action ${action}:`, err);
    sendSocketResponse(id, { error: err.toString() });
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ event: 'debuggerEvent', source, method, params }));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (controlledTabId === tabId) {
    controlledTabId = null;
  }
});

chrome.tabGroups.onRemoved.addListener((group) => {
  if (group.title === CONTROLLED_GROUP_TITLE) {
    controlledGroupIdsByWindow.delete(group.windowId);
  }
});

connect();
