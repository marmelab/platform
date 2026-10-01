import { bootstrapSql, platformSql, TEMPLATE_DB, templateSql } from "@platform/sql";
import { config } from "./config.ts";
import { withAdmin } from "./db.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await withAdmin("postgres", (c) => c.query("select 1"));
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error("postgres not reachable");
}

/** Builds template_supabase by cloning the image's "postgres" database (see M0). */
async function ensureTemplate() {
  const exists = await withAdmin("template1", async (c) =>
    (await c.query("select 1 from pg_database where datname = $1", [TEMPLATE_DB])).rowCount === 1);
  if (exists) return;
  await withAdmin("template1", async (c) => {
    // pg_net / pg_cron workers stay connected to "postgres": block, terminate, clone, reopen.
    await c.query("alter database postgres allow_connections false");
    try {
      await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = 'postgres'");
      await sleep(500);
      await c.query(`create database ${TEMPLATE_DB} template postgres`);
    } finally {
      await c.query("alter database postgres allow_connections true");
    }
  });
  await withAdmin(TEMPLATE_DB, (c) => c.query(templateSql()));
  await withAdmin("template1", async (c) => {
    await c.query(`revoke all on database ${TEMPLATE_DB} from public`);
    await c.query(`alter database ${TEMPLATE_DB} is_template true allow_connections false`);
  });
  console.log(`${TEMPLATE_DB} created`);
}

async function ensurePlatformDb() {
  const db = config.pg.platformDb;
  await withAdmin("template1", async (c) => {
    const exists = (await c.query("select 1 from pg_database where datname = $1", [db])).rowCount === 1;
    if (!exists) {
      await c.query(`create database ${db}`);
      await c.query(`revoke all on database ${db} from public`);
    }
  });
  await withAdmin(db, (c) => c.query(platformSql()));
}

export async function initCluster() {
  await waitForPostgres();
  await withAdmin("postgres", (c) => c.query(bootstrapSql()));
  await ensureTemplate();
  await ensurePlatformDb();
}
