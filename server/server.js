const { WebSocket, WebSocketServer } = require('ws');
const http = require('http');

const WS_PORT = Number(process.env.WS_PORT || 8899);
const HTTP_PORT = Number(process.env.HTTP_PORT || 8898);
const API_KEY = process.env.API_KEY || 'B3C65095-74E1-4F48-9EBB-64F5DD6AB078';
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1024 * 1024);
const DEFAULT_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10000);
const MAX_BATCH_ACTIONS = Number(process.env.MAX_BATCH_ACTIONS || 50);

// WebSocket Server
const wss = new WebSocketServer({ port: WS_PORT });
let activeClient = null;
let pendingRequests = new Map();
let requestIdCounter = 1;

wss.on('connection', function connection(ws, req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get('key') !== API_KEY) {
    console.log('Rejected WebSocket connection: Invalid API key');
    ws.close(1008, 'Invalid API key');
    return;
  }

  console.log('Chrome extension connected!');
  if (activeClient && activeClient !== ws) {
    activeClient.close(1000, 'Replaced by a newer extension connection');
  }
  activeClient = ws;

  ws.on('error', console.error);

  ws.on('message', function message(data) {
    try {
      const msg = JSON.parse(data);
      if (msg.id && pendingRequests.has(msg.id)) {
        const { resolve, reject } = pendingRequests.get(msg.id);
        pendingRequests.delete(msg.id);
        if (msg.error) {
          reject(new Error(msg.error));
        } else {
          resolve(msg.result);
        }
      } else {
        if (msg.event !== 'ping') {
          console.log('Received from extension:', msg);
        }
      }
    } catch (e) {
      console.error('Error parsing response from extension:', e);
    }
  });

  ws.on('close', () => {
    console.log('Chrome extension disconnected');
    if (activeClient === ws) {
      activeClient = null;
    }
    
    // Fail all pending requests
    for (const [id, { reject }] of pendingRequests) {
      reject(new Error('Extension disconnected'));
    }
    pendingRequests.clear();
  });
});

console.log(`WebSocket server listening on ws://localhost:${WS_PORT}`);

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function isExtensionReady() {
  return Boolean(activeClient && activeClient.readyState === WebSocket.OPEN);
}

function sendToExtension(action, params = {}) {
  return new Promise((resolve, reject) => {
    if (!isExtensionReady()) {
      return reject(new Error('No Chrome extension is currently connected.'));
    }

    const id = requestIdCounter++;
    const timeoutMs = Number(params.requestTimeoutMs || params.timeoutMs || DEFAULT_TIMEOUT_MS);
    const timer = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`Request timed out after ${timeoutMs} ms`));
      }
    }, timeoutMs);

    pendingRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    const payload = JSON.stringify({ id, action, ...params });
    activeClient.send(payload, (err) => {
      if (err) {
        pendingRequests.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

function normalizeAction(item, index) {
  if (!item || typeof item !== 'object') {
    throw new Error(`Batch item ${index} must be an object`);
  }
  if (!item.action || typeof item.action !== 'string') {
    throw new Error(`Batch item ${index} is missing action`);
  }
  const { action, ...params } = item;
  return { action, params };
}

async function runBatch(actions, options = {}) {
  if (!Array.isArray(actions)) {
    throw new Error('Batch payload must include an actions array');
  }
  if (actions.length === 0) {
    throw new Error('Batch actions array cannot be empty');
  }
  if (actions.length > MAX_BATCH_ACTIONS) {
    throw new Error(`Batch cannot contain more than ${MAX_BATCH_ACTIONS} actions`);
  }

  const mode = options.mode === 'sequential' ? 'sequential' : 'parallel';
  const stopOnError = options.stopOnError !== false;
  const normalized = actions.map(normalizeAction);

  if (mode === 'sequential') {
    const results = [];
    for (let index = 0; index < normalized.length; index += 1) {
      const { action, params } = normalized[index];
      try {
        const result = await sendToExtension(action, params);
        results.push({ index, action, success: true, result });
      } catch (err) {
        results.push({ index, action, success: false, error: err.message });
        if (stopOnError) break;
      }
    }
    return { mode, results, success: results.every((item) => item.success) };
  }

  const settled = await Promise.allSettled(
    normalized.map(({ action, params }) => sendToExtension(action, params))
  );
  const results = settled.map((item, index) => ({
    index,
    action: normalized[index].action,
    success: item.status === 'fulfilled',
    ...(item.status === 'fulfilled'
      ? { result: item.value }
      : { error: item.reason?.message || String(item.reason) }),
  }));

  return { mode, results, success: results.every((item) => item.success) };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON payload'));
      }
    });

    req.on('error', reject);
  });
}

// HTTP Server to accept commands (e.g., via curl)
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      success: true,
      extensionConnected: isExtensionReady(),
      pendingRequests: pendingRequests.size,
      wsPort: WS_PORT,
      httpPort: HTTP_PORT,
      uptimeSeconds: Math.round(process.uptime()),
    });
    return;
  }

  if (req.method === 'POST') {
    const providedKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (providedKey !== API_KEY) {
      sendJson(res, 401, { success: false, error: 'Unauthorized: Invalid or missing API key' });
      return;
    }

    try {
      const command = await readJsonBody(req);
      const actions = command.actions || (command.action === 'batch' ? command.commands : null);

      if (actions) {
        console.log(`Received HTTP batch: ${actions.length} action(s), mode=${command.mode || 'parallel'}`);
        const result = await runBatch(actions, {
          mode: command.mode,
          stopOnError: command.stopOnError,
        });
        sendJson(res, result.success ? 200 : 207, result);
        return;
      }

      if (!command.action) {
        throw new Error('Missing action in payload');
      }

      console.log('Received HTTP command:', command.action);
      try {
        const { action, ...params } = command;
        const result = await sendToExtension(action, params);
        sendJson(res, 200, { success: true, result });
      } catch (e) {
        const statusCode = /No Chrome extension/.test(e.message) ? 503 : 400;
        sendJson(res, statusCode, { success: false, error: e.message });
      }
    } catch (e) {
      console.error('Error handling HTTP command:', e.message);
      sendJson(res, 400, { success: false, error: e.message });
    }
  } else {
    sendJson(res, 404, { success: false, error: 'Not found' });
  }
});

server.listen(HTTP_PORT, () => {
  console.log(`HTTP Command API listening on http://localhost:${HTTP_PORT}`);
  console.log(`Example usage: curl -X POST -H "Content-Type: application/json" -d '{"action":"createTab","url":"https://example.com"}' http://localhost:${HTTP_PORT}`);
  console.log(`Batch usage: curl -X POST -H "Content-Type: application/json" -H "x-api-key: <key>" -d '{"mode":"parallel","actions":[{"action":"queryTabs"},{"action":"createTab","url":"https://example.com"}]}' http://localhost:${HTTP_PORT}`);
});
