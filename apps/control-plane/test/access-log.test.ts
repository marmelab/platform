// Unit tests of the access log reader and counter (metrics sampler): incremental reads, partial lines, rotation.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { countAccessLines, type LogCursor, readNewLines } from "../src/access-log.ts";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 2, 10, 0, 0);
const line = (host: string, status: number, at: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ level: "info", ts: at / 1000, logger: "http.log.access.platform_access", request: { host }, status, ...extra }) + "\n";

test("counts requests and 5xx per app host and hour; maintenance responses are not errors", () => {
  const text = [
    line("todo.localhost:8100", 200, T0 + 1000),
    line("todo.localhost:8100", 500, T0 + 2000),
    line("todo.localhost", 502, T0 + HOUR + 5),
    line("TODO.localhost:8100", 404, T0 + HOUR + 6),
    line("notes.localhost:8100", 503, T0 + 3000, { platform_maintenance: "1" }),
    line("studio.localhost:8100", 500, T0),
    line("evil.localhost.example.com", 500, T0),
    line("a.localhost:8100", 200, T0), // too short for a slug
    "not json\n",
    "",
  ].join("");
  const { counts, last, lines } = countAccessLines(text, "localhost", "platform_maintenance");
  assert.equal(lines, 8);
  assert.deepEqual([...counts.keys()].sort(), ["notes", "studio", "todo"]);
  assert.deepEqual(counts.get("todo")!.get(T0), { requests: 2, errors: 1 });
  assert.deepEqual(counts.get("todo")!.get(T0 + HOUR), { requests: 2, errors: 1 });
  assert.deepEqual(counts.get("notes")!.get(T0), { requests: 1, errors: 0 });
  assert.equal(last.get("todo"), T0 + HOUR + 6);
});

test("reads appended lines incrementally, leaves a partial line, follows a rotation by inode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "access-log-"));
  const path = join(dir, "access.log");
  let cursor: LogCursor = { inode: null, offset: 0 };

  assert.deepEqual(await readNewLines(path, cursor), { text: "", cursor, lost: false }, "no file yet");

  writeFileSync(path, line("a1.localhost", 200, T0) + '{"partial":');
  let read = await readNewLines(path, cursor);
  assert.equal(read.text, line("a1.localhost", 200, T0));
  cursor = read.cursor;

  appendFileSync(path, ' "line"}\n' + line("a2.localhost", 200, T0));
  read = await readNewLines(path, cursor);
  assert.equal(read.text, '{"partial": "line"}\n' + line("a2.localhost", 200, T0));
  cursor = read.cursor;
  assert.equal((await readNewLines(path, cursor)).text, "", "nothing new");

  // Caddy (lumberjack) renames the file and creates a new one; the old one got a last line before the rotation
  appendFileSync(path, line("a3.localhost", 200, T0));
  renameSync(path, join(dir, "access-2026-10-02T10-00-00.000.log"));
  writeFileSync(path, line("a4.localhost", 200, T0));
  read = await readNewLines(path, cursor);
  assert.equal(read.text, line("a3.localhost", 200, T0) + line("a4.localhost", 200, T0));
  assert.equal(read.lost, false);
  cursor = read.cursor;

  // rotated twice between two reads: the first rotated file is gone from the cursor's view
  appendFileSync(path, line("a5.localhost", 200, T0));
  renameSync(path, join(dir, "other-name.log"));
  writeFileSync(path, line("a6.localhost", 200, T0));
  read = await readNewLines(path, cursor);
  assert.equal(read.lost, true);
  assert.equal(read.text, line("a6.localhost", 200, T0));
  cursor = read.cursor;

  // truncated in place
  writeFileSync(path, line("a7.localhost", 200, T0));
  read = await readNewLines(path, { ...cursor, offset: 10_000 });
  assert.equal(read.text, line("a7.localhost", 200, T0));

  // a bounded read resumes where it stopped
  writeFileSync(path, line("b1.localhost", 200, T0) + line("b2.localhost", 200, T0));
  const first = await readNewLines(path, { inode: null, offset: 0 }, line("b1.localhost", 200, T0).length + 5);
  assert.equal(first.text, line("b1.localhost", 200, T0));
  assert.equal((await readNewLines(path, first.cursor)).text, line("b2.localhost", 200, T0));
});
