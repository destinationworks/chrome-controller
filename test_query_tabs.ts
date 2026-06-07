import chromeControllerPiExtension from "./PiDev Extension/index.ts";

const mockPi = {
  tools: {},
  registerTool(tool) {
    this.tools[tool.name] = tool;
  }
};

chromeControllerPiExtension(mockPi);

async function test() {
  const tool = mockPi.tools["chrome_query_tabs"];
  console.log("Running chrome_query_tabs in short mode (default)...");
  try {
    const resultShort = await tool.execute("call1", {}, new AbortController().signal);
    const tabsShort = JSON.parse(resultShort.content[0].text).result;
    console.log("Short mode result, first tab keys:", Object.keys(tabsShort[0]));
    
    console.log("Running chrome_query_tabs in full mode...");
    const resultFull = await tool.execute("call2", { mode: "full" }, new AbortController().signal);
    const tabsFull = JSON.parse(resultFull.content[0].text).result;
    console.log("Full mode result, first tab keys:", Object.keys(tabsFull[0]));
  } catch (err) {
    console.error("Error running tool:", err);
  }
}

test();
