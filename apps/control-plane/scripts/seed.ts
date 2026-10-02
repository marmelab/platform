// Local dev seed, run by `deploy/install.sh --seed` once the stack is up. Idempotent.
// Creates the app builders alice and bob (developer role, fixed local passwords, a PAT each saved in
// deploy/.env.local), then deploys one example app per builder through the real API (MCP with the builder's
// PAT, pre-signed upload, finalize), and signs up app users with a few rows: demo-user in todo-app, demo-user and
// demo-user-2 in notes-app, with notes shared between them.
// An app that already exists is redeployed (migrations already applied are skipped, new frontend and
// functions versions). A slug already taken by someone else is skipped with a warning: memberships are never changed.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = new URL("../../../", import.meta.url);
const ENV_LOCAL = new URL("deploy/.env.local", ROOT);
const SCRIPTS = fileURLToPath(new URL("plugin/skills/deploy/scripts/", ROOT));
const STUDIO_URL = "http://studio.localhost:8100";
const DEMO_USER = { email: "demo-user@example.com", password: "demo-password" };
const DEMO_USER_2 = { email: "demo-user-2@example.com", password: "demo-password" };

interface App {
  url: string;
  supabase_url: string;
  anon_key: string;
}

const builders = [
  {
    key: "ALICE",
    email: "alice@example.com",
    password: process.env.SEED_ALICE_PASSWORD || "alice-password",
    app: { slug: "todo-app", name: "Todo app", example: "todo-app", seed: seedTodos },
  },
  {
    key: "BOB",
    email: "bob@example.com",
    password: process.env.SEED_BOB_PASSWORD || "bob-password",
    app: { slug: "notes-app", name: "Notes app", example: "notes-app", seed: seedNotes },
  },
];

const env = new Map(
  readFileSync(ENV_LOCAL, "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const),
);
const mcpUrl = env.get("PLATFORM_URL") ?? "http://api.localhost:8100/mcp";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isTransient = (error: unknown): boolean => {
  const err = error as { code?: string; message?: string; cause?: unknown } | undefined;
  if (!err) return false;
  if (["ECONNRESET", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED"].includes(err.code ?? "")) return true;
  if (/socket|other side closed|fetch failed/i.test(err.message ?? "")) return true;
  return isTransient(err.cause);
};

// Caddy closes idle keep-alive connections when the control plane reloads its config (e.g. on create_app),
// so a reused socket can fail once: retry network errors, never HTTP or tool errors.
async function retry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isTransient(error)) throw error;
      await sleep(500 * attempt);
    }
  }
}

const http = (url: string, init?: RequestInit) => retry(() => fetch(url, init));

async function waitForControlPlane() {
  const health = new URL("/health", mcpUrl);
  for (let i = 0; i < 60; i++) {
    if (await fetch(health).then((r) => r.ok, () => false)) return;
    await sleep(1000);
  }
  throw new Error(`control plane not ready at ${health}`);
}

const cli = (args: string[], input?: string) =>
  execFileSync("docker", ["exec", "-i", "plat-control-plane", "node", "src/cli.ts", ...args], { input, encoding: "utf8" })
    .trim();

async function connect(token: string) {
  return retry(async () => {
    const client = new Client({ name: "seed", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    return client;
  });
}

async function tool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await retry(() => client.callTool({ name, arguments: args }))) as {
    isError?: boolean;
    content: { text: string }[];
  };
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0]!.text);
}

async function validToken(token: string | undefined) {
  if (!token) return false;
  try {
    const client = await connect(token);
    const me = await tool(client, "whoami");
    await client.close();
    return me.role === "developer";
  } catch {
    return false;
  }
}

function saveEnv() {
  env.delete("STUDIO_TEST_ALICE_PASSWORD");
  env.delete("STUDIO_TEST_BOB_PASSWORD");
  writeFileSync(ENV_LOCAL, [...env].map(([k, v]) => `${k}=${v}\n`).join(""));
}

async function deploy(client: Client, slug: string, name: string, example: string) {
  const cwd = fileURLToPath(new URL(`examples/${example}/`, ROOT));
  const sh = (script: string, args: string[]) =>
    execFileSync(`${SCRIPTS}${script}`, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const app = await tool(client, "create_app", { name, slug });
  const migrations = await tool(client, "apply_migrations", { app: slug, migrations: JSON.parse(sh("migrations.sh", [])) });
  console.log(`  migrations: ${migrations.status} (applied ${migrations.applied.length}, skipped ${migrations.skipped.length})`);
  sh("build.sh", [app.supabase_url, app.anon_key]);
  for (const kind of ["functions", "frontend"]) {
    const { deployment_id, upload_url } = await tool(client, "create_deployment", { app: slug, kind });
    sh("upload.sh", [kind, upload_url]);
    const done = await tool(client, "finalize_deployment", { deployment_id });
    console.log(`  ${kind}: version ${done.version ?? "?"} ${done.status ?? ""}`.trimEnd());
  }
  return app as App;
}

async function signIn(app: App, user: { email: string; password: string }) {
  const auth = (path: string) =>
    http(`${app.supabase_url}/auth/v1/${path}`, {
      method: "POST",
      headers: { apikey: app.anon_key, "content-type": "application/json" },
      body: JSON.stringify(user),
    });
  let session = await auth("token?grant_type=password");
  if (session.status === 400) session = await auth("signup");
  if (!session.ok) throw new Error(`${user.email} sign in: ${session.status} ${await session.text()}`);
  const { access_token } = await session.json() as { access_token: string };
  return async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await http(`${app.supabase_url}${path}`, {
      ...init,
      headers: {
        apikey: app.anon_key,
        authorization: `Bearer ${access_token}`,
        "content-type": "application/json",
        prefer: "return=representation",
      },
    });
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} as ${user.email}: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  };
}

async function seedTodos(app: App) {
  const api = await signIn(app, DEMO_USER);
  if ((await api<unknown[]>("/rest/v1/todos?select=id")).length > 0) return;
  const rows = ["Buy oat milk", "Book the dentist", "Water the plants"].map((title) => ({ title }));
  await api("/rest/v1/todos", { method: "POST", body: JSON.stringify(rows) });
}

const NOTES = [
  {
    title: "Team offsite ideas",
    content: "# Team offsite\n\n- Half day of **hack time**\n- Walk by the lake\n- Retro on the last quarter\n\nBudget to confirm with *finance*.",
    share: "read",
  },
  {
    title: "Release checklist",
    content: "## Before the release\n\n- Run `pnpm typecheck`\n- Update the changelog\n- Tag the release\n\nAnyone sharing this note can tick items off.",
    share: "edit",
  },
  {
    title: "Personal reminders",
    content: "Renew the passport.\n\nThis note is private: nobody else can see it.",
    share: null,
  },
] as const;

async function seedNotes(app: App) {
  const api = await signIn(app, DEMO_USER);
  await signIn(app, DEMO_USER_2);
  const existing = await api<{ id: string; title: string }[]>("/rest/v1/notes?select=id,title");
  for (const note of NOTES) {
    let id = existing.find((n) => n.title === note.title)?.id;
    if (!id) {
      const [created] = await api<{ id: string }[]>("/rest/v1/notes?select=id", {
        method: "POST",
        body: JSON.stringify({ title: note.title, content: note.content }),
      });
      id = created!.id;
    }
    if (note.share) {
      await api("/functions/v1/share-note", {
        method: "POST",
        body: JSON.stringify({ note_id: id, email: DEMO_USER_2.email, permission: note.share }),
      });
    }
  }
}

await waitForControlPlane();

const summary: string[] = [];
for (const builder of builders) {
  console.log(`\n== ${builder.email}`);
  const tokenKey = `SEED_${builder.key}_TOKEN`;
  if (!(await validToken(env.get(tokenKey)))) {
    env.set(tokenKey, cli(["create-user", builder.email, "developer", "seed"]));
    console.log("  personal access token issued");
  }
  console.log(`  ${cli(["set-password", builder.email], builder.password)}`);
  env.set(`SEED_${builder.key}_EMAIL`, builder.email);
  env.set(`SEED_${builder.key}_PASSWORD`, builder.password);
  saveEnv();

  const client = await connect(env.get(tokenKey)!);
  try {
    const { slug, name, example, seed } = builder.app;
    console.log(`  deploying ${slug} (examples/${example})`);
    try {
      const app = await deploy(client, slug, name, example);
      await seed(app);
      summary.push(`  ${slug.padEnd(10)} ${app.url}  (owner ${builder.email})`);
    } catch (error) {
      if (!String(error).includes("already taken")) throw error;
      console.warn(`  WARNING: slug ${slug} belongs to another user, skipped`);
      summary.push(`  ${slug.padEnd(10)} skipped: the slug belongs to another user`);
    }
    const others = (await tool(client, "whoami")).apps.filter((a: { slug: string }) => a.slug !== slug);
    if (others.length > 0) {
      console.warn(`  WARNING: ${builder.email} is also a member of ${others.map((a: { slug: string }) => a.slug).join(", ")}`);
    }
  } finally {
    await client.close();
  }
}

console.log(`
Seed done.
Apps:
${summary.join("\n")}
Studio:  ${STUDIO_URL}
MCP:     ${mcpUrl}
Admin:   ${env.get("PLATFORM_ADMIN_EMAIL")} (password PLATFORM_ADMIN_PASSWORD in deploy/.env.local)
App builders (Studio login, developer role):
  ${builders.map((b) => `${b.email} / ${b.password}  -> ${b.app.slug}`).join("\n  ")}
App users: ${DEMO_USER.email} / ${DEMO_USER.password} (todo-app and notes-app), ${DEMO_USER_2.email} / ${DEMO_USER_2.password} (notes-app)
Personal access tokens: SEED_ALICE_TOKEN and SEED_BOB_TOKEN in deploy/.env.local`);
