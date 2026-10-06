import { appRoles } from "@platform/sql";
import type { LogLine } from "@platform/shared";
import { readRecent, requestLines } from "./access-log.ts";
import { type AppRow, dbId, orchestrator } from "./apps.ts";
import { config } from "./config.ts";
import { MAINTENANCE_FIELD } from "./router.ts";

type Service = "gotrue" | "postgrest" | "functions" | "postgres" | "requests";

/** M2 version of get_logs: Docker logs (no Loki yet) and the requests of Caddy's access log, filtered per app. */
export async function getLogs(
  app: AppRow,
  options: { service?: Service; sinceMinutes: number; limit: number; query?: string },
): Promise<LogLine[]> {
  const since = options.sinceMinutes * 60;
  const tail = Math.max(options.limit * 5, 500);
  const wanted = (service: Service) => !options.service || options.service === service;
  const lines: LogLine[] = [];

  for (const container of await orchestrator.appContainers(app.slug)) {
    if (!wanted(container.service as Service)) continue;
    for (const l of await orchestrator.logs(container.name, since, tail).catch(() => [])) {
      lines.push({ ts: l.ts, service: container.service, line: l.line });
    }
  }

  if (wanted("functions")) {
    // Edge lines are JSON emitted by the main worker / event worker, with an "app" field.
    for (const l of await orchestrator.logs(config.docker.edgeContainer, since, tail * 4).catch(() => [])) {
      if (!l.line.includes(`"app":"${app.slug}"`)) continue;
      try {
        if (JSON.parse(l.line).app !== app.slug) continue;
      } catch {
        continue;
      }
      lines.push({ ts: l.ts, service: "functions", line: l.line });
    }
  }

  if (wanted("postgres")) {
    const marker = `db=${appRoles(dbId(app.slug)).database} `;
    for (const l of await orchestrator.logs(config.docker.dbContainer, since, tail * 4).catch(() => [])) {
      if (l.line.includes(marker)) lines.push({ ts: l.ts, service: "postgres", line: l.line });
    }
  }

  if (wanted("requests")) {
    const text = await readRecent(config.accessLog.path).catch(() => "");
    for (const l of requestLines(text, app.slug, config.appsDomain, MAINTENANCE_FIELD, Date.now() - since * 1000)) {
      lines.push({ ts: l.ts, service: "requests", line: l.line });
    }
  }

  const query = options.query?.toLowerCase();
  return lines
    .filter((l) => !query || l.line.toLowerCase().includes(query))
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-options.limit);
}
