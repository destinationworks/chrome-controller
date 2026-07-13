/**
 * Helper script spawned by port-conflict.test.ts to test EADDRINUSE crash behavior.
 * Takes a blocked port as argv[0] and tries to create a server on it.
 * The process will crash with an uncaught EADDRINUSE exception.
 */
import { createChromeControllerServer } from '../src/server.ts';

const blockedPort = Number(process.argv[2]);

// This will crash because the port is blocked and there's no error handler
createChromeControllerServer({
  wsPort: blockedPort,
  httpPort: 0,
  apiKey: 'test-key',
  writeDiscoveryFile: false,
});

// Keep process alive briefly so the error can fire
setTimeout(() => {
  process.exit(0);
}, 2000);
