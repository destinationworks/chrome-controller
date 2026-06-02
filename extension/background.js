const API_KEY = 'B3C65095-74E1-4F48-9EBB-64F5DD6AB078';
const WS_URL = 'ws://127.0.0.1:8899/?key=' + API_KEY;
let socket = null;
let reconnectInterval = null;
let keepAliveInterval = null;

function connect() {
  console.log('Attempting to connect to ' + WS_URL);
  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    console.log('Connected to local WebSocket server');
    if (reconnectInterval) {
      clearInterval(reconnectInterval);
      reconnectInterval = null;
    }
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
    }
    // Send a ping every 20 seconds to keep the service worker alive
    keepAliveInterval = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ event: 'ping' }));
      }
    }, 20000);
  };

  socket.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      handleMessage(data);
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  };

  socket.onclose = () => {
    console.log('Disconnected from local WebSocket server');
    socket = null;
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
    scheduleReconnect();
  };

  socket.onerror = (error) => {
    console.error('WebSocket error:', error);
    socket.close();
  };
}

function scheduleReconnect() {
  if (!reconnectInterval) {
    reconnectInterval = setInterval(connect, 5000);
  }
}

// Forward debugger events back to the server
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ event: 'debuggerEvent', source, method, params }));
  }
});

async function handleMessage(message) {
  const { id, action, ...params } = message;

  try {
    let result = null;

    // Window and Tab Management
    if (action === 'createTab') {
      result = await chrome.tabs.create({ url: params.url, active: params.active !== false });
    } else if (action === 'queryTabs') {
      result = await chrome.tabs.query(params.queryInfo || {});
    } else if (action === 'removeTab') {
      await chrome.tabs.remove(params.tabId);
      result = { success: true };
    } else if (action === 'createWindow') {
      result = await chrome.windows.create({ url: params.url, incognito: params.incognito || false });
    } else if (action === 'updateTab') {
      result = await chrome.tabs.update(params.tabId, { url: params.url, active: params.active });
    } else if (action === 'executeScript') {
      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId: params.tabId },
        func: new Function(params.funcBody),
      });
      result = injectionResults;
    } 
    // Cookies Management
    else if (action === 'getAllCookies') {
      result = await chrome.cookies.getAll(params.details || {});
    } else if (action === 'setCookie') {
      result = await chrome.cookies.set(params.details);
    } else if (action === 'removeCookie') {
      result = await chrome.cookies.remove(params.details);
    } 
    // Debugger / CDP Management (for advanced interaction/DOM reading)
    else if (action === 'attachDebugger') {
      await chrome.debugger.attach({ tabId: params.tabId }, params.requiredVersion || '1.3');
      result = { success: true };
    } else if (action === 'detachDebugger') {
      await chrome.debugger.detach({ tabId: params.tabId });
      result = { success: true };
    } else if (action === 'sendCommand') {
      result = await chrome.debugger.sendCommand({ tabId: params.tabId }, params.method, params.commandParams || {});
    } 
    // Visualization Management
    else if (action === 'visualizeAction') {
      // Send message to the active tab's content script
      const { type, x, y, active } = params;
      const msg = {};
      if (type === 'move') {
        msg.action = 'visualizeMove';
        msg.x = x;
        msg.y = y;
      } else if (type === 'click') {
        msg.action = 'visualizeClick';
        msg.x = x;
        msg.y = y;
      } else if (type === 'highlight') {
        msg.action = 'highlightTab';
        msg.active = active;
      }
      
      const tabId = params.tabId;
      if (tabId) {
        result = await chrome.tabs.sendMessage(tabId, msg);
      } else {
        throw new Error('tabId is required for visual actions');
      }
    } 
    else {
      console.warn('Unknown action:', action);
      if (socket && socket.readyState === WebSocket.OPEN && id) {
        socket.send(JSON.stringify({ id, error: 'Unknown action' }));
      }
      return;
    }

    if (socket && socket.readyState === WebSocket.OPEN && id) {
      socket.send(JSON.stringify({ id, result }));
    }
  } catch (err) {
    console.error(`Error executing action ${action}:`, err);
    if (socket && socket.readyState === WebSocket.OPEN && id) {
      socket.send(JSON.stringify({ id, error: err.toString() }));
    }
  }
}

// Initial connection
connect();
