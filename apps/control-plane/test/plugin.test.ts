// The plugin served on the api host (src/plugin.ts): plugin/ zipped with the platform's MCP URL, pinned by sha256.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { buildPlugin, LOCAL_MCP_URL } from "../src/plugin.ts";

const API = "https://api.example.com";

test("the zip holds the plugin with the platform's MCP URL instead of the local one", () => {
  const { zip } = buildPlugin(API);
  const files = unzipSync(zip);
  assert.ok(files[".claude-plugin/plugin.json"] && files["skills/deploy/SKILL.md"] && files["deploy-cli/main.ts"]);
  const mcp = JSON.parse(strFromU8(files[".mcp.json"]!));
  assert.equal(mcp.mcpServers.platform.url, "${PLATFORM_URL:-https://api.example.com/mcp}");
  assert.match(strFromU8(files["skills/deploy/scripts/platform-url.sh"]!), /:-https:\/\/api\.example\.com\/mcp\}/);
  // only the README and the tests still name the local stack
  for (const [name, data] of Object.entries(files)) {
    if (!/^(README\.md|test\/)/.test(name)) assert.ok(!strFromU8(data).includes(LOCAL_MCP_URL), name);
  }
});

test("the cloud setup script is served with the platform's URL", () => {
  const { setup } = buildPlugin(API);
  assert.match(setup, /^#!\/usr\/bin\/env bash\n/);
  assert.ok(setup.includes('mcp="${PLATFORM_URL:-https://api.example.com/mcp}"'));
  assert.ok(!setup.includes(LOCAL_MCP_URL));
});

test("the scripts stay executable once unzipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-zip-"));
  writeFileSync(join(dir, "platform.zip"), buildPlugin(API).zip);
  const listing = execFileSync("zipinfo", [join(dir, "platform.zip")], { encoding: "utf8" });
  for (const script of ["skills/deploy/scripts/platform-deploy", "skills/deploy/scripts/platform-url.sh", "template/init-app.sh"]) {
    assert.match(listing, new RegExp(`^-rwxr-xr-x .* ${script}$`, "m"), script);
  }
  assert.match(listing, /^-rw-r--r-- .* \.mcp\.json$/m);
});

test("the marketplace pins the zip, and the same plugin gives the same zip", () => {
  const { zip, marketplace } = buildPlugin(API);
  assert.equal(marketplace.name, "platform");
  const [entry] = marketplace.plugins;
  assert.equal(entry!.name, "platform");
  assert.match(entry!.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(entry!.source, {
    source: "archive",
    url: "https://api.example.com/plugin/platform.zip",
    sha256: createHash("sha256").update(zip).digest("hex"),
  });
  assert.deepEqual(buildPlugin(API).zip, zip);
});
