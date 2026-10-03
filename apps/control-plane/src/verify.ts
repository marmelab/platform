// Platform verification (A8, deploy/upgrade.sh; also useful after an install): the running version, the shared
// services, and for every app its containers, GoTrue, PostgREST, its routes through Caddy, its Storage tenant and its
// latest linter run. Read-only.
import { type AppRow, containerName, orchestrator } from "./apps.ts";
import { config, internalAppUrl } from "./config.ts";
import { many } from "./db.ts";
import { latestLints } from "./lint.ts";
import { readVersion } from "./version.ts";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

async function probe(name: string, url: string, init: RequestInit = {}, okStatus = (s: number) => s < 500): Promise<Check> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    return { name, ok: okStatus(response.status), detail: `HTTP ${response.status}` };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function verifyPlatform() {
  const shared: Check[] = await Promise.all([
    probe("caddy admin", `${config.caddyAdmin}/config/`, { headers: { origin: config.caddyAdmin } }, (s) => s === 200),
    probe("storage", `${config.storage.adminUrl}/status`, {}, (s) => s === 200),
    probe("realtime", `${config.realtime.url}/healthcheck`, {}, (s) => s === 200),
  ]);
  const apps = await many<AppRow>("select * from apps where status in ('running', 'stopped', 'error') order by slug");
  const results = [];
  for (const app of apps) {
    const checks: Check[] = [];
    if (app.status === "running") {
      const containers = await orchestrator.appContainers(app.slug).catch(() => []);
      for (const service of ["auth", "rest"] as const) {
        const name = containerName(app.slug, service);
        const state = containers.find((c) => c.name === name)?.state ?? "missing";
        checks.push({ name: `${service} container`, ok: state === "running", detail: state });
      }
      checks.push(await probe("gotrue", `http://${containerName(app.slug, "auth")}:9999/health`, {}, (s) => s === 200));
      checks.push(await probe("postgrest", `http://${containerName(app.slug, "rest")}:3001/ready`, {}, (s) => s === 200));
      // through Caddy's internal listener, as the app's functions reach it: routing marker and upstreams
      checks.push(await probe("route /auth/v1", `${internalAppUrl(app.slug)}/auth/v1/health`, {}, (s) => s === 200));
      checks.push(await probe("route /storage/v1", `${internalAppUrl(app.slug)}/storage/v1/version`, {}, (s) => s < 500));
      checks.push(await probe("storage tenant", `${config.storage.adminUrl}/tenants/${app.slug}`, {
        headers: { apikey: config.storage.adminKey },
      }, (s) => s === 200));
    } else {
      checks.push({ name: "status", ok: app.status === "stopped", detail: app.status + (app.error ? `: ${app.error}` : "") });
    }
    const lint = await latestLints(app.id).catch(() => null);
    results.push({
      app: app.slug,
      status: app.status,
      ok: checks.every((c) => c.ok),
      checks,
      lints: lint && { ran_at: lint.ran_at, errors: lint.errors, unaccepted_errors: lint.unaccepted_errors, warnings: lint.warnings },
    });
  }
  return {
    version: await readVersion(),
    ok: shared.every((c) => c.ok) && results.every((r) => r.ok),
    shared,
    apps: results,
  };
}
