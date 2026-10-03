// Retention of the backups (M7, backups.ts): which backups expire. Pure (no I/O, no platform configuration import),
// so that the unit tests (test/backup-retention.test.ts) load it alone.
import type { BackupSettings } from "./settings.ts";

/** Failed backups (no files) are forgotten after this many days. */
export const FAILED_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

export interface RetentionRow {
  id: string;
  slug: string;
  kind: "scheduled" | "manual" | "pre_restore" | "final";
  status: "running" | "succeeded" | "failed";
  started_at: Date;
}

export const dayKey = (date: Date) => date.toISOString().slice(0, 10);
/** Monday of the date's ISO week (UTC). */
export const weekKey = (date: Date) => {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return dayKey(day);
};

/**
 * The backups to delete (pure, unit-tested). Per app (slug), scheduled backups: the newest of each of the last
 * `keepDaily` days that have one, and the newest of each of the last `keepWeekly` ISO weeks that have one, are kept.
 * Manual and pre-restore backups: kept `manualRetentionDays`; final backups: `finalRetentionDays`. Failed attempts:
 * forgotten after 30 days. Running ones are never selected.
 */
export function expiredBackups(
  rows: RetentionRow[],
  settings: Pick<BackupSettings, "keepDaily" | "keepWeekly" | "manualRetentionDays" | "finalRetentionDays">,
  now = new Date(),
): string[] {
  const expired: string[] = [];
  const bySlug = new Map<string, RetentionRow[]>();
  for (const row of rows) bySlug.set(row.slug, [...(bySlug.get(row.slug) ?? []), row]);
  const olderThan = (row: RetentionRow, days: number) => now.getTime() - row.started_at.getTime() > days * DAY_MS;
  for (const list of bySlug.values()) {
    const scheduled = list.filter((r) => r.kind === "scheduled" && r.status === "succeeded")
      .sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
    const keep = new Set<string>();
    for (const [count, key] of [[settings.keepDaily, dayKey], [settings.keepWeekly, weekKey]] as const) {
      const seen = new Set<string>();
      for (const row of scheduled) {
        const k = key(row.started_at);
        if (seen.has(k)) continue;
        if (seen.size >= count) break;
        seen.add(k);
        keep.add(row.id);
      }
    }
    for (const row of list) {
      if (row.status === "running") continue;
      if (row.status === "failed") {
        if (olderThan(row, FAILED_RETENTION_DAYS)) expired.push(row.id);
      } else if (row.kind === "scheduled") {
        if (!keep.has(row.id)) expired.push(row.id);
      } else if (row.kind === "final") {
        if (olderThan(row, settings.finalRetentionDays)) expired.push(row.id);
      } else if (olderThan(row, settings.manualRetentionDays)) {
        expired.push(row.id);
      }
    }
  }
  return expired;
}
