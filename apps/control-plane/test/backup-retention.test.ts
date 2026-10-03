// Unit tests of the backup retention (M7, src/backup-retention.ts): N daily + M weekly scheduled backups per app,
// manual and pre-restore backups by age, final backups by age, failed attempts forgotten after 30 days.
import assert from "node:assert/strict";
import { test } from "node:test";
import { expiredBackups, type RetentionRow, weekKey } from "../src/backup-retention.ts";

const settings = { keepDaily: 3, keepWeekly: 2, manualRetentionDays: 30, finalRetentionDays: 90 };
const NOW = new Date("2026-10-03T12:00:00Z"); // a Saturday

let n = 0;
const row = (at: string, kind: RetentionRow["kind"] = "scheduled", status: RetentionRow["status"] = "succeeded", slug = "a"): RetentionRow =>
  ({ id: `${slug}-${kind}-${status}-${at}-${n++}`, slug, kind, status, started_at: new Date(at) });
const expired = (rows: RetentionRow[], s = settings) => new Set(expiredBackups(rows, s, NOW));

test("ISO weeks start on Monday (UTC)", () => {
  assert.equal(weekKey(new Date("2026-10-03T23:59:00Z")), "2026-09-28");
  assert.equal(weekKey(new Date("2026-09-28T00:00:00Z")), "2026-09-28");
  assert.equal(weekKey(new Date("2026-09-27T23:59:00Z")), "2026-09-21");
});

test("scheduled: the newest of the last N days, plus the newest of the last M weeks", () => {
  // two a day for 20 days
  const rows: RetentionRow[] = [];
  for (let d = 0; d < 20; d++) {
    const day = new Date(NOW.getTime() - d * 86_400_000).toISOString().slice(0, 10);
    rows.push(row(`${day}T02:00:00Z`), row(`${day}T09:00:00Z`));
  }
  const gone = expired(rows);
  const kept = rows.filter((r) => !gone.has(r.id)).map((r) => r.started_at.toISOString().slice(0, 16)).sort();
  // days: 3 Oct, 2 Oct, 1 Oct (newest of each); weeks: of 28 Sep (3 Oct, already kept), of 21 Sep (27 Sep)
  assert.deepEqual(kept, ["2026-09-27T09:00", "2026-10-01T09:00", "2026-10-02T09:00", "2026-10-03T09:00"]);
});

test("missing days do not shorten the history: N days that have a backup", () => {
  const rows = [row("2026-10-03T02:00:00Z"), row("2026-09-20T02:00:00Z"), row("2026-09-01T02:00:00Z"), row("2026-08-01T02:00:00Z")];
  const gone = expired(rows, { ...settings, keepWeekly: 0 });
  assert.deepEqual(rows.filter((r) => gone.has(r.id)).map((r) => r.started_at.toISOString().slice(0, 10)), ["2026-08-01"]);
});

test("per app: one app's backups never count for another", () => {
  const rows = [row("2026-10-03T02:00:00Z", "scheduled", "succeeded", "a"), row("2026-10-02T02:00:00Z", "scheduled", "succeeded", "b")];
  assert.equal(expired(rows, { ...settings, keepDaily: 1, keepWeekly: 0 }).size, 0);
});

test("manual and pre-restore by age, final by its own age, failed after 30 days, running never", () => {
  const recentManual = row("2026-09-10T00:00:00Z", "manual");
  const oldManual = row("2026-08-20T00:00:00Z", "manual");
  const oldPre = row("2026-08-20T00:00:00Z", "pre_restore");
  const final = row("2026-08-01T00:00:00Z", "final");
  const oldFinal = row("2026-06-01T00:00:00Z", "final");
  const recentFailed = row("2026-09-20T00:00:00Z", "scheduled", "failed");
  const oldFailed = row("2026-08-20T00:00:00Z", "scheduled", "failed");
  const running = row("2020-01-01T00:00:00Z", "scheduled", "running");
  const gone = expired([recentManual, oldManual, oldPre, final, oldFinal, recentFailed, oldFailed, running]);
  assert.deepEqual([...gone].sort(), [oldManual.id, oldPre.id, oldFinal.id, oldFailed.id].sort());
});

test("failed scheduled backups do not take a daily slot", () => {
  const good = row("2026-10-02T02:00:00Z");
  const failed = row("2026-10-03T02:00:00Z", "scheduled", "failed");
  assert.equal(expired([good, failed], { ...settings, keepDaily: 1, keepWeekly: 0 }).size, 0);
});
