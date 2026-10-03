// Platform version (M7 part 2, A8): the VERSION file at the root of the repository, copied into the control plane
// image. At every start the control plane records it in `platform_versions`, with the images of the platform's
// containers, when either changed; the admin dashboard shows the running version and the previous one.
import { readFile } from "node:fs/promises";
import { config } from "./config.ts";
import { many, one } from "./db.ts";
import type { Orchestrator } from "./orchestrator.ts";

export async function readVersion(): Promise<string> {
  const text = await readFile(config.versionFile, "utf8").catch(() => "");
  return text.trim() || "dev";
}

interface VersionRow {
  version: string;
  started_at: Date;
  components: Record<string, string>;
}

/** Records the running version and the platform's images, unless the latest row already says the same. */
export async function recordVersion(orchestrator: Orchestrator) {
  const version = await readVersion();
  const components = {
    ...(await orchestrator.platformImages().catch(() => ({}))),
    "app-gotrue": config.docker.gotrueImage,
    "app-postgrest": config.docker.postgrestImage,
  };
  const latest = await one<VersionRow>("select * from platform_versions order by id desc limit 1");
  if (latest && latest.version === version && JSON.stringify(latest.components) === JSON.stringify(components)) return;
  await one("insert into platform_versions (version, components) values ($1, $2) returning id", [
    version,
    JSON.stringify(components),
  ]);
  console.log(`platform version ${version}${latest ? ` (was ${latest.version})` : ""}`);
}

/** The running version (latest row) and the last different version before it. */
export async function platformVersion() {
  const rows = await many<VersionRow>("select version, started_at, components from platform_versions order by id desc limit 50");
  const [current] = rows;
  if (!current) return { version: await readVersion(), since: null, components: {}, previous: null };
  const previous = rows.find((r) => r.version !== current.version) ?? null;
  // since: the first row of the current version's latest streak
  let since = current.started_at;
  for (const row of rows) {
    if (row.version !== current.version) break;
    since = row.started_at;
  }
  return {
    version: current.version,
    since,
    components: current.components,
    previous: previous && { version: previous.version, started_at: previous.started_at },
  };
}
