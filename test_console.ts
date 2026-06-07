import chromeControllerPiExtension from "./PiDev Extension/index.ts";

const mockPi = {
  tools: {},
  registerTool(tool: any) {
    this.tools[tool.name] = tool;
  }
};

chromeControllerPiExtension(mockPi as any);

async function test() {
  const queryTabs = mockPi.tools["chrome_query_tabs"];
  const consoleLogs = mockPi.tools["chrome_console_logs"];
  const evaluate = mockPi.tools["chrome_evaluate"];

  console.log("Querying tabs...");
  try {
    const tabsResult = await queryTabs.execute("call1", {}, new AbortController().signal);
    const tabs = JSON.parse(tabsResult.content[0].text).result;
    if (!tabs || tabs.length === 0) {
      console.log("No tabs found.");
      return;
    }
    const tabId = tabs[0].tabId || tabs[0].id;
    console.log(`Found tabId ${tabId}, getting console logs...`);
    
    console.log("Injecting async log/error...");
    await evaluate.execute("call2", { 
      tabId, 
      expression: "setTimeout(() => { console.error('Intentional error from test'); console.log('Intentional log from test'); }, 500);"
    }, new AbortController().signal);

    console.log("Running chrome_console_logs...");
    const logsResult = await consoleLogs.execute("call3", { tabId, timeoutMs: 2000 }, new AbortController().signal);
    console.log("Success! Logs:", logsResult.content[0].text);
  } catch (err) {
    console.error("Error running tool:", err);
  }
}

test();
