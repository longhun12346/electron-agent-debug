import { McpClient } from "./test-support.mjs";

function structuredData(response) {
  const text = response?.result?.content?.[0]?.text;
  if (!text) {
    throw new Error(`MCP 返回缺少结构化内容：${JSON.stringify(response)}`);
  }
  return JSON.parse(text);
}

const client = new McpClient();
try {
  await client.request(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "fixture-blocked-smoke", version: "1.0.0" },
  });
  client.notify("notifications/initialized", {});
  const response = await client.request(2, "tools/call", {
    name: "electron_attach",
    arguments: {},
  });
  const data = structuredData(response);
  if (data.ok !== false || data.error?.code !== "ENDPOINT_NOT_CONFIGURED") {
    throw new Error(`缺少 endpoint 时未返回预期 BLOCKED 证据：${JSON.stringify(data)}`);
  }
  console.log(JSON.stringify({ conclusion: "BLOCKED", response }, null, 2));
} finally {
  await client.close();
}
