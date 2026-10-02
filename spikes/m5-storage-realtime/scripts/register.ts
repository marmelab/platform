// Registers (or updates) the spike tenants in the shared Storage and Realtime. Usage: node scripts/register.ts m5a m5b
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { jwt, keys } from "./lib.ts";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
) as Record<string, string>;

const STORAGE_ADMIN = "http://127.0.0.1:15001";
const REALTIME = "http://127.0.0.1:14000";

for (const t of process.argv.slice(2)) {
  const secret = env[`${t}_JWT_SECRET`]!;
  const { anon, service } = keys(t, secret);
  const storageBody = {
    anonKey: anon,
    serviceKey: service,
    jwtSecret: secret,
    databaseUrl: `postgres://app_${t}_storage_admin:${env[`${t}_STORAGE_PASSWORD`]}@db:5432/spike_${t}`,
    maxConnections: Number(process.env.TENANT_MAX_CONNECTIONS ?? 4),
    fileSizeLimit: 52428800,
    features: { imageTransformation: { enabled: false }, s3Protocol: { enabled: false } },
  };
  let started = Date.now();
  const s = await fetch(`${STORAGE_ADMIN}/tenants/${t}`, {
    method: "PUT",
    headers: { apikey: env.STORAGE_ADMIN_KEY!, "content-type": "application/json" },
    body: JSON.stringify(storageBody),
  });
  console.log(`storage ${t}: ${s.status} ${(await s.text()).slice(0, 300)} (${Date.now() - started} ms)`);
  const m = await fetch(`${STORAGE_ADMIN}/tenants/${t}/migrations`, { headers: { apikey: env.STORAGE_ADMIN_KEY! } });
  console.log(`storage ${t} migrations: ${m.status} ${(await m.text()).slice(0, 200)}`);

  const management = jwt({ role: "service_role", iss: "platform" }, env.REALTIME_API_JWT_SECRET!);
  const tenant = (superuser: boolean) => ({
    tenant: {
      name: t,
      external_id: t,
      jwt_secret: secret,
      max_concurrent_users: 200,
      extensions: [{
        type: "postgres_cdc_rls",
        settings: {
          db_name: `spike_${t}`,
          db_host: "db",
          // Realtime's tenant migrations need a superuser (they GRANT the reserved supabase_realtime_admin role):
          // the tenant is created with it (POST runs the migrations synchronously), then switched to its own role
          db_user: superuser ? "spike_realtime_migrator" : `app_${t}_realtime`,
          db_password: superuser ? env.REALTIME_MIGRATOR_PASSWORD : env[`${t}_REALTIME_PASSWORD`],
          db_port: "5432",
          region: "local",
          poll_interval_ms: 100,
          poll_max_record_bytes: 1048576,
          publication: "supabase_realtime",
          slot_name: `realtime_${t}`,
          // sic (Realtime's spelling): connections of the postgres_changes subscription pool, 4 by default
          subcriber_pool_size: Number(process.env.SUBSCRIBER_POOL_SIZE ?? 1),
          ssl_enforced: false,
        },
      }],
    },
  });
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${REALTIME}${path}`, {
      method,
      headers: { authorization: `Bearer ${management}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  started = Date.now();
  const existing = await call("GET", `/api/tenants/${t}`);
  await existing.text();
  if (!existing.ok) {
    const created = await call("POST", "/api/tenants", tenant(true));
    console.log(`realtime ${t} created + migrated: ${created.status} (${Date.now() - started} ms)`);
    await created.text();
  }
  // After the migrations: objects the migrator (or Realtime's schema dump, which hardcodes supabase_admin) owns go to
  // supabase_realtime_admin, of which app_<id>_realtime is a member; then the "broadcast changes" publication on
  // realtime.messages (Realtime would create it itself, which needs CREATE on the database).
  {
    execFileSync("docker", ["exec", "-i", "plat-db", "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-h",
      "localhost", "-d", `spike_${t}`], {
      input: `do $$ declare r record; begin
          for r in select format('alter %s %s owner to supabase_realtime_admin',
              case c.relkind when 'S' then 'sequence' when 'v' then 'view' else 'table' end, c.oid::regclass) as q
            from pg_class c where c.relnamespace = 'realtime'::regnamespace and c.relkind in ('r', 'p', 'v', 'S')
              and pg_get_userbyid(c.relowner) in ('supabase_admin', 'spike_realtime_migrator')
          loop execute r.q; end loop;
          for r in select format('alter routine %s owner to supabase_realtime_admin', p.oid::regprocedure) as q
            from pg_proc p where p.pronamespace = 'realtime'::regnamespace
              and pg_get_userbyid(p.proowner) in ('supabase_admin', 'spike_realtime_migrator')
          loop execute r.q; end loop;
        end $$;
        alter schema realtime owner to supabase_realtime_admin;
        select 'create publication supabase_realtime_messages_publication for table realtime.messages'
        where not exists (select from pg_publication where pubname = 'supabase_realtime_messages_publication') \\gexec
        alter publication supabase_realtime_messages_publication owner to app_${t}_realtime;`,
    });
  }
  const r = await call("PUT", `/api/tenants/${t}`, tenant(false));
  console.log(`realtime ${t}: ${r.status} ${(await r.text()).slice(0, 80)} (${Date.now() - started} ms)`);
  const h = await fetch(`${REALTIME}/api/tenants/${t}/health`, { headers: { authorization: `Bearer ${management}` } });
  console.log(`realtime ${t} health: ${h.status} ${(await h.text()).slice(0, 300)}`);
}
