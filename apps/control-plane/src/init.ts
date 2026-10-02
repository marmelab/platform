import {
  bootstrapSql,
  realtimeAdminRoleSql,
  serviceDatabaseRoleSql,
  platformSql,
  schemaChangesSql,
  STUDIO_META_DEFAULT,
  studioMetaDefaultDatabaseSql,
  studioMetaDefaultRoleSql,
  TEMPLATE_DB,
  templateSql,
} from "@platform/sql";
import { config } from "./config.ts";
import { runAll, withAdmin } from "./db.ts";

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

/**
 * Upgrades of template_supabase applied at every start (the template is only built once): the DDL event trigger
 * (PLAN_1 §7). Idempotent. The template refuses connections outside this short window; startup runs before the API
 * listens, so no create_app clones it meanwhile (the `init` CLI on a running platform could make one fail: retry it).
 */
async function upgradeTemplate() {
  await withAdmin("template1", (c) => c.query(`alter database ${TEMPLATE_DB} allow_connections true`));
  try {
    await withAdmin(TEMPLATE_DB, (c) => c.query(schemaChangesSql()));
  } finally {
    await withAdmin("template1", (c) => c.query(`alter database ${TEMPLATE_DB} allow_connections false`));
  }
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

/** Empty database + unprivileged role for the shared postgres-meta's default connection (Studio). */
async function ensureStudioMetaDefault() {
  await withAdmin("template1", async (c) => {
    await runAll(c, studioMetaDefaultRoleSql(config.studio.metaDefaultPassword));
    const exists = (await c.query("select 1 from pg_database where datname = $1", [STUDIO_META_DEFAULT])).rowCount === 1;
    if (!exists) await c.query(`create database ${STUDIO_META_DEFAULT}`);
    await runAll(c, studioMetaDefaultDatabaseSql());
  });
  await withAdmin(STUDIO_META_DEFAULT, (c) => c.query("revoke all on schema public from public"));
}

/**
 * Metadata databases of the shared Storage (its tenants) and Realtime (its tenants, in the `_realtime` schema its
 * migrations expect), each owned by its own role; the global roles Realtime's tenant migrations need (M5).
 */
async function ensureServiceDatabases() {
  for (const { role, password } of [config.storage, config.realtime].map((s) => ({ role: s.dbRole, password: s.dbPassword }))) {
    await withAdmin("template1", async (c) => {
      await runAll(c, serviceDatabaseRoleSql(role, password));
      const exists = (await c.query("select 1 from pg_database where datname = $1", [role])).rowCount === 1;
      if (!exists) await c.query(`create database ${role} owner ${role}`);
      await c.query(`revoke all on database ${role} from public`);
    });
  }
  await withAdmin(config.realtime.dbRole, (c) =>
    c.query(`create schema if not exists _realtime authorization ${config.realtime.dbRole}`));
  await withAdmin("postgres", (c) => runAll(c, realtimeAdminRoleSql()));
}

export async function initCluster() {
  await waitForPostgres();
  await withAdmin("postgres", (c) => c.query(bootstrapSql()));
  await ensureTemplate();
  await upgradeTemplate();
  await ensurePlatformDb();
  await ensureStudioMetaDefault();
  await ensureServiceDatabases();
}
