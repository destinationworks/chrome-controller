import { WebSocket } from 'ws';

async function main() {
  const res = await fetch('http://127.0.0.1:9222/json/version');
  const data = await res.json();
  const wsUrl = data.webSocketDebuggerUrl;
  console.log('Connecting to browser WebSocket:', wsUrl);

  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('Connected to CDP browser target');
    ws.send(JSON.stringify({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } }));
  });

  ws.on('message', async (message) => {
    const msg = JSON.parse(message.toString('utf8'));

    if (msg.method === 'Target.targetCreated') {
      const info = msg.params.targetInfo;
      console.log(`Target discovered: type=${info.type} url=${info.url}`);
      if (info.url.includes('chrome.google.com/webstore/devconsole')) {
        console.log('FOUND DEVCONSOLE TARGET:', info);
        ws.send(JSON.stringify({
          id: 2,
          method: 'Target.attachToTarget',
          params: { targetId: info.targetId, flatten: true }
        }));
      }
    }

    if (msg.id === 2) {
      const sessionId = msg.result?.sessionId;
      console.log('Attached with sessionId:', sessionId);
      ws.send(JSON.stringify({
        id: 3,
        sessionId,
        method: 'Runtime.evaluate',
        params: { expression: 'document.title + " | " + location.href', returnByValue: true }
      }));
    }

    if (msg.id === 3) {
      console.log('EVALUATE RESULT ON DEVCONSOLE:', JSON.stringify(msg.result, null, 2));
      ws.close();
      process.exit(0);
    }
  });

  ws.on('error', console.error);
}

main().catch(console.error);
