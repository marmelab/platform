// Plays the control plane: generates app configs, versioned function dirs and the Caddyfile under runtime/.
// Usage: deno run -A setup.ts [appCount=2]
import { signHs256 } from "../../packages/edge-main-worker/jwt.ts";

const here = new URL(".", import.meta.url).pathname;
const runtime = `${here}runtime`;
const fixtures = `${here}fixtures/functions`;
const appCount = Number(Deno.args[0] ?? "2");
const apps = Array.from({ length: appCount }, (_, i) => `app${i + 1}`);

const randomSecret = (bytes = 32) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

async function writeAtomic(path: string, content: string) {
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(tmp, content);
  await Deno.rename(tmp, path);
}

async function copyDir(from: string, to: string) {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    if (entry.isDirectory) await copyDir(`${from}/${entry.name}`, `${to}/${entry.name}`);
    else await Deno.copyFile(`${from}/${entry.name}`, `${to}/${entry.name}`);
  }
}

await Deno.mkdir(runtime, { recursive: true });
for await (const entry of Deno.readDir(runtime)) await Deno.remove(`${runtime}/${entry.name}`, { recursive: true });
await Deno.mkdir(`${runtime}/config/apps`, { recursive: true });
await Deno.mkdir(`${runtime}/functions`, { recursive: true });

const tokens: Record<string, { jwt_secret: string; anon: string; service_role: string }> = {};
const iat = Math.floor(Date.now() / 1000);
const exp = iat + 10 * 365 * 24 * 3600;

for (const app of apps) {
  const source = app === "app1" ? `${fixtures}/app1` : `${fixtures}/app2`;
  for await (const version of Deno.readDir(source)) {
    await copyDir(`${source}/${version.name}`, `${runtime}/functions/${app}/${version.name}`);
  }
  await Deno.symlink("v1", `${runtime}/functions/${app}/current`);

  const jwtSecret = randomSecret();
  const anon = await signHs256({ iss: "supabase", ref: app, role: "anon", iat, exp }, jwtSecret);
  const serviceRole = await signHs256({ iss: "supabase", ref: app, role: "service_role", iat, exp }, jwtSecret);
  tokens[app] = { jwt_secret: jwtSecret, anon, service_role: serviceRole };

  const config = {
    app,
    jwt_secret: jwtSecret,
    env: {
      SUPABASE_URL: `http://${app}.localhost:8090`,
      SUPABASE_ANON_KEY: anon,
      SUPABASE_SERVICE_ROLE_KEY: serviceRole,
      SUPABASE_DB_URL: `postgresql://${app}_fn:${randomSecret(12)}@postgres:5432/app_${app}`,
      APP_NAME: app,
      MY_SECRET: `secret-of-${app}-${randomSecret(8)}`,
    },
    limits: { memory_mb: 150, cpu_soft_ms: 1000, cpu_hard_ms: 2000, wall_clock_ms: 60000 },
  };
  await writeAtomic(`${runtime}/config/apps/${app}.json`, JSON.stringify(config, null, 2));
}

await Deno.writeTextFile(
  `${runtime}/secrets.env`,
  `PLATFORM_GATEWAY_TOKEN=${randomSecret()}\nPLATFORM_ADMIN_TOKEN=${randomSecret()}\n`,
);
await Deno.writeTextFile(`${runtime}/tokens.json`, JSON.stringify(tokens, null, 2));

const sites = apps.map((app) => `http://${app}.localhost:8090 {\n\timport edge ${app}\n}`).join("\n\n");
await Deno.writeTextFile(
  `${runtime}/Caddyfile`,
  `{
\tauto_https off
\tadmin localhost:2019
}

(edge) {
\thandle_path /functions/v1/* {
\t\treverse_proxy edge:9000 {
\t\t\theader_up X-Platform-App {args[0]}
\t\t\theader_up X-Platform-Gateway-Token {$PLATFORM_GATEWAY_TOKEN}
\t\t}
\t}
\trespond "not found" 404
}

${sites}

http://:8090 {
\trespond "unknown host" 404
}
`,
);

console.log(`generated ${apps.length} apps in ${runtime}`);
