// Worker churn: N cycles of (cold start every app's hello, wait for idle retirement), RAM after each cycle.
// Expects the stack deployed with >= 50 apps (bench.ts leaves it so). Usage: deno run -A churn.ts [cycles=5]
import { curl, fn, memoryMiB } from "./lib.ts";

const cycles = Number(Deno.args[0] ?? "5");
const apps = Array.from({ length: 50 }, (_, i) => `app${i + 1}`);
for (let cycle = 1; cycle <= cycles; cycle++) {
  for (const app of apps) await curl(fn(app, "hello"));
  const peak = await memoryMiB("m1-edge-1");
  await new Promise((r) => setTimeout(r, 15_000));
  console.log(`cycle ${cycle}: peak ${peak} MiB, after retirement ${await memoryMiB("m1-edge-1")} MiB`);
}
