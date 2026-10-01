// Measures RAM and cold/warm latency. Usage: deno run -A bench.ts [scaleApps=50]
import { compose, curl, fn, here, memoryMiB, publishRuntime, switchCurrent, waitReady } from "./lib.ts";

const scaleApps = Number(Deno.args[0] ?? "50");
const ms = (seconds: number) => Math.round(seconds * 10000) / 10;
const sleep = (millis: number) => new Promise((r) => setTimeout(r, millis));
const results: Record<string, unknown> = {};

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { p50: ms(pick(0.5)), p95: ms(pick(0.95)), max: ms(sorted.at(-1)!) };
}

async function timed(url: string, args: string[] = []) {
  const res = await curl(url, args);
  if (res.status !== 200) throw new Error(`${url}: ${res.status} ${res.body}`);
  return res.seconds;
}

async function warm(url: string, n: number, args: string[] = []) {
  const samples = [];
  for (let i = 0; i < n; i++) samples.push(await timed(url, args));
  return stats(samples);
}

async function deploy(apps: number, recreate = true) {
  const setup = await new Deno.Command("deno", { args: ["run", "-A", "setup.ts", String(apps)], cwd: here }).output();
  if (!setup.success) throw new Error(new TextDecoder().decode(setup.stderr));
  await compose("up", "-d", "--force-recreate", "controlplane");
  await publishRuntime();
  if (recreate) await compose("up", "-d", "--force-recreate", "edge", "caddy");
  await waitReady();
}

const record = (key: string, value: unknown) => {
  results[key] = value;
  console.log(key, JSON.stringify(value));
};

const depsArgs = ["-X", "POST", "-d", '{"name":"Ada"}'];

await compose("down", "-v", "--remove-orphans");
await deploy(2);
await sleep(3000);
record("ram_idle_mib", { edge: await memoryMiB("m1-edge-1"), caddy: await memoryMiB("m1-caddy-1") });

record("hello_cold_ms", { app1: ms(await timed(fn("app1", "hello"))), app2: ms(await timed(fn("app2", "hello"))) });
record("hello_warm_ms", await warm(fn("app1", "hello"), 100));
record("deps_cold_empty_cache_ms", ms(await timed(fn("app1", "deps"), depsArgs)));
record("deps_warm_ms", await warm(fn("app1", "deps"), 50, depsArgs));
await sleep(1000);
record("ram_2_apps_mib", await memoryMiB("m1-edge-1"));

await compose("restart", "edge");
await waitReady();
record("after_restart_cold_ms", {
  deps_with_cache: ms(await timed(fn("app1", "deps"), depsArgs)),
  hello: ms(await timed(fn("app1", "hello"))),
});

await switchCurrent("app1", "v2");
record("version_switch_first_request_ms", ms(await timed(fn("app1", "hello"))));
await switchCurrent("app1", "v1");

await deploy(scaleApps);
await sleep(3000);
const apps = Array.from({ length: scaleApps }, (_, i) => `app${i + 1}`);
record(`ram_idle_${scaleApps}_apps_configured_mib`, await memoryMiB("m1-edge-1"));
const coldSamples = [];
for (const app of apps) coldSamples.push(await timed(fn(app, "hello")));
record(`hello_cold_${scaleApps}_apps_ms`, stats(coldSamples));
await sleep(1000);
record(`ram_${scaleApps}_workers_mib`, await memoryMiB("m1-edge-1"));
for (const app of apps) await timed(fn(app, "env"));
await sleep(1000);
record(`ram_${scaleApps * 2}_workers_mib`, await memoryMiB("m1-edge-1"));

const parallel = performance.now();
await Promise.all(apps.map((app) => timed(fn(app, "hello"))));
record(`parallel_${scaleApps}_warm_requests_total_ms`, Math.round(performance.now() - parallel));

console.log("waiting 20s for idle workers to be retired (PLATFORM_WORKER_IDLE_TIMEOUT_MS=10000)...");
await sleep(20_000);
record("ram_after_idle_retirement_mib", await memoryMiB("m1-edge-1"));
await sleep(60_000);
record("ram_after_idle_retirement_plus_60s_mib", await memoryMiB("m1-edge-1"));
for (const app of apps.slice(0, 10)) await timed(fn(app, "hello"));
record("ram_after_10_workers_restarted_mib", await memoryMiB("m1-edge-1"));

await Deno.writeTextFile(`${here}runtime/bench.json`, JSON.stringify(results, null, 2));
