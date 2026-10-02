// B8 step 2: the final backup delete_app takes before removing anything. One directory per backup,
// <backups>/<slug>-<timestamp>/:
//   database.dump     pg_dump -Fc of the app database (schema, data, auth users), run in the Postgres container so that
//                     pg_dump always matches the server version
//   sites.tar.gz      the app's frontend versions (sites/<slug>), when present
//   functions.tar.gz  the app's functions versions (functions/<slug>), when present
//   manifest.json     what was backed up; no secret (the app's keys and function secrets are not kept)
// Restore, retention and off-site copies are M7 (TECH_DEBT CP-14).
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as tar from "tar";
import { appRoles, databaseExistsSql } from "@platform/sql";
import { type AppRow, dbId, orchestrator, pathExists } from "./apps.ts";
import { config } from "./config.ts";
import { withAdmin } from "./db.ts";

export interface Backup {
  path: string;
  /** File name -> size in bytes. */
  files: Record<string, number>;
}

const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/**
 * Throws (and leaves nothing behind) if any part fails: the caller must then keep the app. Null when there is nothing
 * to back up at all (no app row, database or files: delete-app is idempotent).
 */
export async function backupApp(slug: string, app?: AppRow): Promise<Backup | null> {
  const path = join(config.dataDir.backups, `${slug}-${timestamp()}`);
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    const files: Record<string, number> = {};
    const database = appRoles(dbId(slug)).database;
    const exists = await withAdmin("postgres", async (c) => (await c.query(databaseExistsSql, [database])).rowCount === 1);
    if (exists) {
      await orchestrator.execToFile(
        config.docker.dbContainer,
        ["pg_dump", "--format=custom", "--host=localhost", `--username=${config.pg.adminUser}`, `--dbname=${database}`],
        { PGPASSWORD: config.pg.adminPassword },
        join(path, "database.dump"),
      );
    }
    for (const [name, root] of [["sites", config.dataDir.sites], ["functions", config.dataDir.functions]] as const) {
      if (!(await pathExists(join(root, slug)))) continue;
      await tar.c({ gzip: true, cwd: root, file: join(path, `${name}.tar.gz`), portable: true }, [slug]);
    }
    for (const name of ["database.dump", "sites.tar.gz", "functions.tar.gz"]) {
      const size = await stat(join(path, name)).then((s) => s.size, () => null);
      if (size !== null) files[name] = size;
    }
    if (exists && !files["database.dump"]) throw new Error("pg_dump produced an empty file");
    if (!app && Object.keys(files).length === 0) {
      await rm(path, { recursive: true, force: true });
      return null;
    }
    const manifest = {
      slug,
      name: app?.name ?? null,
      created_at: app?.created_at ?? null,
      status: app?.status ?? null,
      github_repo: app?.github_repo ?? null,
      database: exists ? database : null,
      taken_at: new Date().toISOString(),
      files,
    };
    await writeFile(join(path, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { path, files };
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw new Error(`backup of ${slug} failed, nothing was deleted: ${error instanceof Error ? error.message : error}`);
  }
}
