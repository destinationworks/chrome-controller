const http = require('http');

const HTTP_PORT = Number(process.env.HTTP_PORT || 8898);
const API_KEY = process.env.API_KEY || 'B3C65095-74E1-4F48-9EBB-64F5DD6AB078';

async function sendCommand(action, params = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ ...params, action });
    const req = http.request({
      hostname: 'localhost',
      port: HTTP_PORT,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'Content-Length': Buffer.byteLength(data),
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk.toString());
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode === 200 && parsed.success) {
            resolve(parsed.result);
          } else {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

  const server = new Server(
    {
      name: 'chrome-controller',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'chrome_controller_health',
          description: 'Check if the Chrome extension is connected and healthy.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'chrome_query_tabs',
          description: 'Query Chrome tabs. Pass empty object to get all tabs.',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'Match URL pattern' },
              title: { type: 'string', description: 'Match title pattern' },
              active: { type: 'boolean' }
            }
          },
        },
        {
          name: 'chrome_create_tab',
          description: 'Open a new tab and make it controlled.',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'URL to open' },
              active: { type: 'boolean', description: 'Whether the tab should be active' }
            },
            required: ['url']
          },
        },
        {
          name: 'chrome_select_tab',
          description: 'Take control of an existing tab.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: { type: 'number', description: 'The tab ID to select' }
            },
            required: ['tabId']
          },
        },
        {
          name: 'chrome_mouse',
          description: 'Perform a mouse action on the active/controlled tab.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: { type: 'number', description: 'The tab ID to evaluate in' },
              type: { type: 'string', enum: ['move', 'press', 'release', 'click', 'wheel'] },
              x: { type: 'number', description: 'X coordinate' },
              y: { type: 'number', description: 'Y coordinate' },
              button: { type: 'string', enum: ['left', 'middle', 'right'], default: 'left' }
            },
            required: ['type', 'x', 'y']
          },
        },
        {
          name: 'chrome_type_text',
          description: 'Type text into the focused element of the tab.',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Text to type' },
              typingDelayMs: { type: 'number', description: 'Delay between keystrokes in ms (default 55)' }
            },
            required: ['text']
          },
        },
        {
          name: 'chrome_screenshot',
          description: 'Capture a screenshot of the active/controlled tab. Returns base64 image data.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: { type: 'number', description: 'The tab ID to evaluate in' },
              format: { type: 'string', enum: ['jpeg', 'png'], default: 'jpeg' },
              quality: { type: 'number', description: 'Quality 0-100 (default 80)' }
            }
          },
        },
        {
          name: 'chrome_capture_video',
          description: 'Capture a short video (sequence of screenshots) from the controlled tab. Returns base64-encoded frames.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: { type: 'number', description: 'The tab ID to capture' },
              fps: { type: 'number', description: 'Frames per second (default 5)', default: 5 },
              duration: { type: 'number', description: 'Duration in seconds (default 3)', default: 3 },
              format: { type: 'string', enum: ['jpeg', 'png'], default: 'jpeg' },
              quality: { type: 'number', description: 'Quality 0-100 (default 80)', default: 80 }
            }
          },
        },
        {
          name: 'chrome_evaluate',
          description: 'Evaluate JavaScript in the page context.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: { type: 'number', description: 'The tab ID to evaluate in' },
              expression: { type: 'string', description: 'JavaScript code to execute' },
              awaitPromise: { type: 'boolean', description: 'Wait for promise to resolve', default: true },
              returnByValue: { type: 'boolean', description: 'Return actual value instead of object reference', default: true }
            },
            required: ['expression']
          },
        },
        {
          name: 'chrome_console_logs',
          description: 'Read the recent console logs (log, warn, error) from the page.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'chrome_release_tab',
          description: 'Release control of a tab without closing it.',
          inputSchema: {
            type: 'object',
            properties: {
              tabId: { type: 'number', description: 'The tab ID to release. If omitted, releases active.' }
            }
          },
        },
        {
          name: 'chrome_cleanup_ai_tabs',
          description: 'Release control of all AI tabs, optionally closing them.',
          inputSchema: {
            type: 'object',
            properties: {
              closeTabs: { type: 'boolean', description: 'Whether to close the tabs (default false)' }
            }
          },
        }
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      let action = request.params.name;
      if (action === 'chrome_evaluate') {
        action = 'evaluateOnPage';
      } else if (action === 'chrome_screenshot') {
        action = 'captureScreenshot';
      } else if (action === 'chrome_console_logs') {
        action = 'getConsoleLogs';
      } else if (action === 'chrome_capture_video') {
        action = 'captureVideo';
      } else if (action === 'chrome_cleanup_ai_tabs') {
        action = 'cleanupManagedTabs';
      } else if (action.startsWith('chrome_')) {
        action = action.replace(/^chrome_/, '');
        // Convert snake_case to camelCase
        action = action.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
      }
      
      // Handle the specific naming if different
      // e.g. chrome_controller_health => health
      if (request.params.name === 'chrome_controller_health') {
        const res = await fetch(`http://localhost:${HTTP_PORT}/health`);
        const json = await res.json();
        return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
      }

      const result = await sendCommand(action, request.params.arguments || {});

      // For screenshot, format as an image response if possible or return base64
      if (request.params.name === 'chrome_screenshot' && result && result.data) {
        const base64Data = typeof result.data === 'string' ? result.data : result.data.data;
        return {
          content: [
            {
              type: 'image',
              data: base64Data,
              mimeType: `image/${request.params.arguments?.format || 'jpeg'}`
            }
          ]
        };
      }

      // For captureVideo, return frames as images with metadata summary
      if (request.params.name === 'chrome_capture_video' && result && result.frames) {
        const frames = result.frames;
        const images = frames
          .filter(f => f.data)
          .slice(-4) // last 4 frames as images
          .map(f => ({
            type: 'image',
            data: f.data,
            mimeType: `image/${result.format || 'jpeg'}`
          }));
        const summary = {
          totalFrames: frames.length,
          fps: result.fps,
          duration: result.duration,
          format: result.format,
          errors: frames.filter(f => f.error).length,
        };
        return {
          content: [
            { type: 'text', text: JSON.stringify(summary, null, 2) },
            ...images,
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error in MCP server:', error);
  process.exit(1);
});
