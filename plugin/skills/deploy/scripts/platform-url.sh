#!/usr/bin/env bash
# Prints the platform MCP URL the scripts use: PLATFORM_URL when exported, else the plugin's "Platform MCP URL" option
# (plugin.json userConfig: Claude Code asks for it when the plugin is enabled and stores it in settings.json under
# pluginConfigs; the local settings win over the project's, which win over the user's), else the local stack.
set -uo pipefail
option="$(node -e '
  const fs = require("node:fs"), path = require("node:path");
  const files = [path.join(process.env.HOME || "", ".claude/settings.json"), ".claude/settings.json", ".claude/settings.local.json"];
  let url = "";
  for (const file of files) {
    try { url = JSON.parse(fs.readFileSync(file, "utf8")).pluginConfigs?.["platform@platform-local"]?.options?.platform_url || url; } catch {}
  }
  process.stdout.write(url);
' 2> /dev/null || true)"
echo "${PLATFORM_URL:-${option:-http://api.localhost:8100/mcp}}"
