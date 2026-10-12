// In-memory lists of the admin API (src/admin/list.ts): sort, nulls, pagination.
import { test } from "node:test";
import assert from "node:assert/strict";
import { listInMemory } from "../src/admin/list.ts";

const params = (field: string, order: "ASC" | "DESC") => ({ sort: { field, order }, range: [0, 9] as [number, number], filter: {} });

test("dates sort by time, not by their text (Mon 12 before Tue 6 in DESC)", () => {
  const rows = [
    { id: "tue-6", created_at: new Date("2026-10-06T10:00:00Z") },
    { id: "mon-12", created_at: new Date("2026-10-12T10:00:00Z") },
    { id: "thu-1", created_at: new Date("2026-10-01T10:00:00Z") },
  ];
  assert.deepEqual(listInMemory(rows, params("created_at", "DESC")).rows.map((r) => r.id), ["mon-12", "tue-6", "thu-1"]);
  assert.deepEqual(listInMemory(rows, params("created_at", "ASC")).rows.map((r) => r.id), ["thu-1", "tue-6", "mon-12"]);
});

test("nulls last in both directions; pagination after the sort", () => {
  const rows = [{ id: "a", n: 2 }, { id: "b", n: null }, { id: "c", n: 5 }, { id: "d", n: 1 }];
  assert.deepEqual(listInMemory(rows, params("n", "DESC")).rows.map((r) => r.id), ["c", "a", "d", "b"]);
  assert.deepEqual(listInMemory(rows, params("n", "ASC")).rows.map((r) => r.id), ["d", "a", "c", "b"]);
  const page = listInMemory(rows, { ...params("n", "ASC"), range: [1, 2] });
  assert.deepEqual([page.rows.map((r) => r.id), page.total], [["a", "c"], 4]);
});
