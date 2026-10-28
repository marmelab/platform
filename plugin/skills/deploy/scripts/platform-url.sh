#!/usr/bin/env bash
# Prints the platform MCP URL the scripts use: PLATFORM_URL when exported, else the local stack's. The plugin served by
# a platform (https://api.<domain>/plugin/marketplace.json) has that platform's URL in place of the local one, here and
# in .mcp.json.
echo "${PLATFORM_URL:-http://api.localhost:8100/mcp}"
