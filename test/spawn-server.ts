/**
 * Helper script spawned by port-conflict.test.ts to test EADDRINUSE crash behavior.
 * Takes a blocked port as argv[0] and tries to create a server on it.
 * The process reports the rejected ready promise and exits without an uncaught exception.
 */
import { createChromeControllerServer } from '../src/server.ts';

const blockedPort = Number(process.argv[2]);

const server = createChromeControllerServer({
  wsPort: blockedPort,
  httpPort: 0,
  apiKey: 'test-key-0123456789abcdef01234567',
  writeDiscoveryFile: false,
});

try {
  await server.ready;
  server.close();
  process.exit(0);
} catch (error) {
  console.error(`Port conflict: ${(error as Error).message}`);
  server.close();
  process.exit(2);
}
