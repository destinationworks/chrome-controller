const { WebSocketServer } = require('ws');
const http = require('http');

const WS_PORT = 8899;
const HTTP_PORT = 8898;
const API_KEY = process.env.API_KEY || 'B3C65095-74E1-4F48-9EBB-64F5DD6AB078';

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
    activeClient = null;
    
    // Fail all pending requests
    for (const [id, { reject }] of pendingRequests) {
      reject(new Error('Extension disconnected'));
    }
    pendingRequests.clear();
  });
});

console.log(`WebSocket server listening on ws://localhost:${WS_PORT}`);

function sendToExtension(action, params = {}) {
  return new Promise((resolve, reject) => {
    if (!activeClient) {
      return reject(new Error('No Chrome extension is currently connected.'));
    }

    const id = requestIdCounter++;
    pendingRequests.set(id, { resolve, reject });

    const payload = JSON.stringify({ id, action, ...params });
    activeClient.send(payload, (err) => {
      if (err) {
        pendingRequests.delete(id);
        reject(err);
      }
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Request timed out'));
      }
    }, 10000);
  });
}

// HTTP Server to accept commands (e.g., via curl)
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    const providedKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (providedKey !== API_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid or missing API key' }));
      return;
    }

    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      try {
        const command = JSON.parse(body);
        if (!command.action) {
          throw new Error('Missing action in payload');
        }

        console.log('Received HTTP command:', command.action);
        const { action, ...params } = command;
        
        const result = await sendToExtension(action, params);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result }));
      } catch (e) {
        console.error('Error handling HTTP command:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(HTTP_PORT, () => {
  console.log(`HTTP Command API listening on http://localhost:${HTTP_PORT}`);
  console.log(`Example usage: curl -X POST -H "Content-Type: application/json" -d '{"action":"createTab","url":"https://example.com"}' http://localhost:${HTTP_PORT}`);
});
