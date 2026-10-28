// The Claude Code plugin, served on the api host (journey B1): builders install it with one command and nothing to set,
// `claude plugin install platform --marketplace https://api.<domain>/plugin/marketplace.json`. The marketplace's
// only entry is an archive source (Claude Code fetches nothing else from a URL marketplace): plugin/ zipped, with this
// platform's MCP URL in place of the local stack's default. Public on purpose: the plugin holds no secret.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Zippable, zipSync } from "fflate";

const PLUGIN_DIR = fileURLToPath(new URL("../../../plugin/", import.meta.url));
/** The MCP URL of the repository's plugin (local stack), replaced in the files that name it. */
export const LOCAL_MCP_URL = "http://api.localhost:8100/mcp";
const WITH_URL = new Set([".mcp.json", "skills/deploy/scripts/platform-url.sh"]);
// a fixed date: the same plugin gives the same zip, hence the same sha256, across restarts
const MTIME = new Date("2000-01-01T00:00:00Z");

/** `api` is the platform's API URL, https://api.<domain> */
export function buildPlugin(api: string, dir = PLUGIN_DIR) {
  const files: Zippable = {};
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" }).sort()) {
    const stat = statSync(join(dir, name));
    if (!stat.isFile()) continue;
    let data: Uint8Array = readFileSync(join(dir, name));
    if (WITH_URL.has(name)) data = Buffer.from(data.toString().replaceAll(LOCAL_MCP_URL, `${api}/mcp`));
    // Unix mode in the external attributes: the scripts stay executable (only the exec bit, as git, whatever the umask)
    files[name] = [data, { os: 3, attrs: (stat.mode & 0o111 ? 0o100755 : 0o100644) * 0x10000, mtime: MTIME }];
  }
  const zip = zipSync(files, { level: 9 }) as Uint8Array<ArrayBuffer>; // fflate allocates plain Uint8Arrays
  const manifest = JSON.parse(readFileSync(join(dir, ".claude-plugin/plugin.json"), "utf8"));
  const marketplace = {
    name: "platform",
    description: "The platform's Claude Code plugin",
    owner: manifest.author,
    plugins: [{
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      source: { source: "archive", url: `${api}/plugin/platform.zip`, sha256: createHash("sha256").update(zip).digest("hex") },
    }],
  };
  return { zip, marketplace };
}
