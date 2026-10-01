// Usage: node mcp.mjs <tool> '<json args>'  (PLATFORM_TOKEN from deploy/.env.local)
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/francois/Documents/git/platform/deploy/.env.local", "utf8");
const token = /PLATFORM_TOKEN=(.*)/.exec(env)[1].trim();
const [tool, args = "{}"] = process.argv.slice(2);
const res = await fetch("http://api.localhost:8100/mcp", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: JSON.parse(args) } }),
});
const text = await res.text();
const data = JSON.parse(text.startsWith("{") ? text : /data: (.*)/.exec(text)[1]);
console.log((data.result?.content?.[0]?.text ?? JSON.stringify(data)).replace(/eyJ[\w.-]{20,}/g, "eyJ***"));
