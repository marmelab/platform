import { signHs256 } from "../../packages/edge-main-worker/jwt.ts";

export const here = new URL(".", import.meta.url).pathname;
export const runtime = `${here}runtime`;

export interface CurlResult {
  status: number;
  body: string;
  seconds: number;
  json<T = Record<string, unknown>>(): T;
}

export async function curl(url: string, args: string[] = []): Promise<CurlResult> {
  const { stdout, success, stderr } = await new Deno.Command("curl", {
    args: ["-s", "-m", "30", "-o", "-", "-w", "\n%{http_code} %{time_total}", ...args, url],
  }).output();
  if (!success) throw new Error(`curl failed: ${new TextDecoder().decode(stderr)}`);
  const text = new TextDecoder().decode(stdout);
  const cut = text.lastIndexOf("\n");
  const [status, seconds] = text.slice(cut + 1).split(" ");
  const body = text.slice(0, cut);
  return { status: Number(status), body, seconds: Number(seconds), json: () => JSON.parse(body) };
}

export const fn = (app: string, name: string, query = "") =>
  `http://${app}.localhost:8090/functions/v1/${name}${query}`;

export async function compose(...args: string[]) {
  const { success, stderr } = await new Deno.Command("docker", {
    args: ["compose", "-p", "m1", ...args],
    cwd: here,
  }).output();
  if (!success) throw new Error(`docker compose ${args.join(" ")}: ${new TextDecoder().decode(stderr)}`);
}

export async function docker(...args: string[]): Promise<string> {
  const { success, stdout, stderr } = await new Deno.Command("docker", { args }).output();
  if (!success) throw new Error(`docker ${args.join(" ")}: ${new TextDecoder().decode(stderr)}`);
  return new TextDecoder().decode(stdout).trim();
}

export async function waitReady(app = "app1") {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await curl(fn(app, "_internal/health"))).status === 200) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("stack not ready");
}

export async function memoryMiB(container: string): Promise<number> {
  const usage = await docker("stats", "--no-stream", "--format", "{{.MemUsage}}", container);
  const [, value, unit] = usage.match(/^([\d.]+)\s*([KMG]i?B)/) ?? [];
  const factor = unit?.startsWith("G") ? 1024 : unit?.startsWith("K") ? 1 / 1024 : 1;
  return Math.round(Number(value) * factor);
}

export interface AppTokens {
  jwt_secret: string;
  anon: string;
  service_role: string;
}

export const tokens = (): Record<string, AppTokens> => JSON.parse(Deno.readTextFileSync(`${runtime}/tokens.json`));

export const appConfigPath = (app: string) => `${runtime}/config/apps/${app}.json`;

async function controlPlane(script: string, stdin?: string) {
  const child = new Deno.Command("docker", {
    args: ["exec", "-i", "m1-controlplane-1", "sh", "-euc", script],
    stdin: "piped",
    stderr: "piped",
    stdout: "null",
  }).spawn();
  const writer = child.stdin.getWriter();
  if (stdin) await writer.write(new TextEncoder().encode(stdin));
  await writer.close();
  const { success, stderr } = await child.output();
  if (!success) throw new Error(`control plane: ${new TextDecoder().decode(stderr)}`);
}

export const publishRuntime = () =>
  controlPlane(
    "rm -rf /functions/* /config/apps/*; cp -a /src/functions/. /functions/; cp /src/config/apps/*.json /config/apps/",
  );

export const switchCurrent = (app: string, version: string) =>
  controlPlane(`cd /functions/${app} && ln -s ${version} current.tmp && mv -T current.tmp current`);

export const writeAppConfig = (app: string, content: string) =>
  controlPlane(
    `cat > /config/apps/${app}.json.tmp && mv /config/apps/${app}.json.tmp /config/apps/${app}.json`,
    content,
  );

export { signHs256 };
