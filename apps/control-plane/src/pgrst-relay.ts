// PostgREST schema cache reloads (README.md, "Connection pooler"). PostgREST reaches its database through the pooler in
// transaction mode, where LISTEN does not work, so its own "pgrst" channel is off (PGRST_DB_CHANNEL_ENABLED=false).
// The control plane listens instead: one direct connection per running app, as PGRST_RELAY_ROLE (LOGIN and CONNECT
// only), and relays each notification to the app's PostgREST container as a signal, which PostgREST handles exactly as
// the notification: SIGUSR1 reloads the schema cache, SIGUSR2 the configuration.
//
// Notifications come from the image's DDL event triggers (pgrst_ddl_watch, pgrst_drop_watch: Studio, execute_sql,
// edge functions...) and from applyMigrations (NOTIFY pgrst after commit). On each (re)connection the schema is
// reloaded once, for the notifications missed while the relay was not listening.
import { appRoles, PGRST_RELAY_ROLE } from "@platform/sql";
import pg from "pg";
import { containerName, dbId, orchestrator } from "./apps.ts";
import { config } from "./config.ts";
import { derivedSecret } from "./crypto.ts";

/** Password of PGRST_RELAY_ROLE: derived from the master key, set by init. */
export const pgrstRelayPassword = () => derivedSecret(PGRST_RELAY_ROLE);

const DEBOUNCE_MS = 150;
const MAX_BACKOFF_MS = 30_000;

interface Watch {
  client: pg.Client | null;
  stopped: boolean;
  backoff: number;
  pending: Map<string, NodeJS.Timeout>;
}

const watches = new Map<string, Watch>();

function relay(slug: string, watch: Watch, signal: "SIGUSR1" | "SIGUSR2") {
  if (watch.pending.has(signal)) return;
  watch.pending.set(signal, setTimeout(() => {
    watch.pending.delete(signal);
    if (watch.stopped) return;
    orchestrator.signal(containerName(slug, "rest"), signal)
      .catch((error) => console.error(`pgrst relay: ${signal} to ${slug} failed`, error));
  }, DEBOUNCE_MS));
}

async function connect(slug: string, watch: Watch) {
  if (watch.stopped) return;
  const client = new pg.Client({
    host: config.pg.host,
    port: config.pg.port,
    user: PGRST_RELAY_ROLE,
    password: pgrstRelayPassword(),
    database: appRoles(dbId(slug)).database,
    application_name: "platform-pgrst-relay",
    keepAlive: true,
  });
  const retry = () => {
    if (watch.client !== client) return;
    watch.client = null;
    client.end().catch(() => {});
    if (watch.stopped) return;
    const delay = watch.backoff;
    watch.backoff = Math.min(watch.backoff * 2, MAX_BACKOFF_MS);
    setTimeout(() => void connect(slug, watch), delay);
  };
  watch.client = client;
  client.on("error", retry);
  client.on("end", retry);
  client.on("notification", (message) => {
    const payload = (message.payload ?? "").trim().toLowerCase();
    relay(slug, watch, payload === "reload config" ? "SIGUSR2" : "SIGUSR1");
  });
  try {
    await client.connect();
    await client.query("listen pgrst");
    if (watch.stopped) {
      await client.end();
      return;
    }
    watch.backoff = 1000;
    relay(slug, watch, "SIGUSR1");
  } catch (error) {
    if (watch.backoff >= MAX_BACKOFF_MS) console.error(`pgrst relay of ${slug} cannot connect`, error);
    retry();
  }
}

/** Starts relaying the app's "pgrst" notifications (running app). Idempotent. */
export function watchSchema(slug: string) {
  if (watches.has(slug)) return;
  const watch: Watch = { client: null, stopped: false, backoff: 1000, pending: new Map() };
  watches.set(slug, watch);
  void connect(slug, watch);
}

/** Stops relaying (stop_app, delete_app): closes the app's relay connection. Idempotent. */
export async function unwatchSchema(slug: string) {
  const watch = watches.get(slug);
  if (!watch) return;
  watches.delete(slug);
  watch.stopped = true;
  for (const timer of watch.pending.values()) clearTimeout(timer);
  const client = watch.client;
  watch.client = null;
  await client?.end().catch(() => {});
}

/** Apps whose notifications are relayed (tests, diagnostics). */
export const watchedApps = () => [...watches.keys()].sort();
