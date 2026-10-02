import pg from "pg";
import { config } from "./config.ts";

export type Queryable = Pick<pg.Pool | pg.PoolClient | pg.Client, "query">;

export const platform = new pg.Pool({
  host: config.pg.host,
  port: config.pg.port,
  user: config.pg.adminUser,
  password: config.pg.adminPassword,
  database: config.pg.platformDb,
  max: 5,
  application_name: "control-plane",
});

export async function withClient<T>(
  options: { database: string; user?: string; password?: string; readWrite?: boolean; applicationName?: string },
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    host: config.pg.host,
    port: config.pg.port,
    user: options.user ?? config.pg.adminUser,
    password: options.password ?? config.pg.adminPassword,
    database: options.database,
    application_name: options.applicationName ?? "control-plane",
    // a stopped app's database is read-only by default (B8): the platform's own admin sessions opt out
    options: options.readWrite ? "-c default_transaction_read_only=off" : undefined,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export const withAdmin = <T>(database: string, fn: (client: pg.Client) => Promise<T>) =>
  withClient({ database, readWrite: true }, fn);

export async function runAll(client: Queryable, statements: string[]) {
  for (const statement of statements) await client.query(statement);
}

export async function one<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const { rows } = await platform.query<T>(sql, params);
  return rows[0];
}

export async function many<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await platform.query<T>(sql, params);
  return rows;
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await platform.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
