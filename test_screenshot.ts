import chromeControllerPiExtension from "./PiDev Extension/index.ts";

const mockPi = {
  tools: {},
  registerTool(tool) {
    this.tools[tool.name] = tool;
  }
};

chromeControllerPiExtension(mockPi);

async function test() {
  const tool = mockPi.tools["chrome_screenshot"];
  console.log("Running chrome_screenshot...");
  try {
    const result = await tool.execute("call1", { tabId: 1050172046 }, new AbortController().signal);
    console.log("Success! File saved at:", result.content[0].text);
  } catch (err) {
    console.error("Error running tool:", err);
  }
}

test();
