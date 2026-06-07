import test from "node:test";
import assert from "node:assert";
import chromeControllerPiExtension from "./index.ts";

test("chrome_screenshot uses valid Buffer parameters", async (t) => {
  // We mock fetch to intercept the call and return a mock successful captureScreenshot CDP response.
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    return {
      ok: true,
      json: async () => ({
        success: true,
        result: {
          success: true,
          data: {
            data: Buffer.from("mock_image_data").toString("base64")
          },
          format: "png"
        }
      })
    } as any;
  };

  const mockPi = {
    tools: {} as any,
    registerTool(tool: any) {
      this.tools[tool.name] = tool;
    }
  };

  chromeControllerPiExtension(mockPi as any);
  const tool = mockPi.tools["chrome_screenshot"];

  try {
    const result = await tool.execute("call_1", { tabId: 123 }, undefined);
    assert.ok(result.content[0].text.includes("/tmp/browser_last_screenshot_"), "Output should contain the screenshot path");
  } finally {
    global.fetch = originalFetch;
  }
});

test("chrome_query_tabs returns short response by default", async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    return {
      ok: true,
      json: async () => ({
        success: true,
        result: [
          { id: 1, title: "Tab 1", url: "http://example.com", active: true, windowId: 1, width: 800, height: 600, extra: "data" }
        ]
      })
    } as any;
  };

  const mockPi = {
    tools: {} as any,
    registerTool(tool: any) {
      this.tools[tool.name] = tool;
    }
  };

  chromeControllerPiExtension(mockPi as any);
  const tool = mockPi.tools["chrome_query_tabs"];

  try {
    const resultShort = await tool.execute("call_1", {}, undefined);
    const shortData = JSON.parse(resultShort.content[0].text);
    assert.deepStrictEqual(shortData.result[0], { id: 1, title: "Tab 1", url: "http://example.com", active: true, windowId: 1 });
    
    const resultFull = await tool.execute("call_2", { mode: "full" }, undefined);
    const fullData = JSON.parse(resultFull.content[0].text);
    assert.deepStrictEqual(fullData.result[0], { id: 1, title: "Tab 1", url: "http://example.com", active: true, windowId: 1, width: 800, height: 600, extra: "data" });
  } finally {
    global.fetch = originalFetch;
  }
});

