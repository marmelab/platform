// Event worker: turns user worker events (logs, boot, limits, crashes) into JSON lines tagged with app/function.
interface RuntimeEvent {
  timestamp: string;
  event_type: string;
  event: { msg?: string; level?: string; [key: string]: unknown };
  metadata?: { service_path?: string; execution_id?: string };
}

const EventManager = (globalThis as unknown as { EventManager: new () => AsyncIterable<RuntimeEvent | null> })
  .EventManager;

// deno-lint-ignore no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

function origin(servicePath = "") {
  const [app, fn] = (servicePath.split("/").at(-1) ?? "").split(".");
  return { app: app || null, function: fn || null };
}

for await (const data of new EventManager()) {
  if (!data) continue;
  const { event_type, event, metadata, timestamp } = data;
  const isLog = event_type === "Log";
  const line = JSON.stringify({
    ts: timestamp,
    level: isLog ? (event.level ?? "Info").toLowerCase() : event_type === "Boot" ? "debug" : "warn",
    source: "function",
    ...origin(metadata?.service_path),
    execution_id: metadata?.execution_id,
    event: event_type,
    msg: isLog ? (event.msg ?? "").replace(ANSI, "").trimEnd() : undefined,
    details: isLog ? undefined : event,
  });
  if (isLog && event.level === "Error") console.error(line);
  else console.log(line);
}
