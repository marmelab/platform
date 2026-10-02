// Incremental reader of Caddy's JSON access log (router.ensureAccessLog) and its per-app aggregation, for the metrics
// sampler (metrics.ts). No configuration import: unit-tested on its own (test/access-log.test.ts).
//
// Caddy rotates the file by renaming it (`access-<time>.log`, same inode) and creating a new one. The cursor keeps the
// inode and the offset read so far: when the current file has another inode, the rest of the previous one is read
// first (found by its inode among the rotated files), then the new file from its start. Only complete lines are
// consumed; a line still being written is read on the next sample.
import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface LogCursor {
  inode: string | null;
  offset: number;
}

export interface LogRead {
  text: string;
  cursor: LogCursor;
  /** A rotated file with the cursor's inode could not be found: its unread end is lost (rotated twice, or deleted). */
  lost: boolean;
}

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  if (end <= start) return Buffer.alloc(0);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  } finally {
    await handle.close();
  }
}

/** Complete lines only: the bytes after the last newline are left for the next read. */
function completeLines(buffer: Buffer): { text: string; consumed: number } {
  const last = buffer.lastIndexOf(0x0a);
  if (last < 0) return { text: "", consumed: 0 };
  return { text: buffer.subarray(0, last + 1).toString("utf8"), consumed: last + 1 };
}

async function findByInode(path: string, inode: string): Promise<string | null> {
  const dir = dirname(path);
  const prefix = basename(path).replace(/\.log$/, "");
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(prefix)) continue;
    const info = await stat(join(dir, name), { bigint: true }).catch(() => null);
    if (info?.ino.toString() === inode) return join(dir, name);
  }
  return null;
}

/** Reads what was appended since `cursor`, at most about `maxBytes`. */
export async function readNewLines(path: string, cursor: LogCursor, maxBytes = 32 * 1024 * 1024): Promise<LogRead> {
  const info = await stat(path, { bigint: true }).catch(() => null);
  if (!info) return { text: "", cursor, lost: false };
  const inode = info.ino.toString();
  const size = Number(info.size);
  let text = "";
  let lost = false;
  let offset = cursor.offset;
  if (cursor.inode !== null && cursor.inode !== inode) {
    const rotated = await findByInode(path, cursor.inode);
    if (rotated) {
      const rotatedSize = Number((await stat(rotated)).size);
      const end = Math.min(rotatedSize, offset + maxBytes);
      const buffer = await readRange(rotated, offset, end);
      if (end < rotatedSize) {
        // still more to read in the rotated file: keep its cursor
        const { text: lines, consumed } = completeLines(buffer);
        return { text: lines, cursor: { inode: cursor.inode, offset: offset + consumed }, lost: false };
      }
      // a closed file: its last line is complete even without a final newline
      text = buffer.toString("utf8");
      if (text && !text.endsWith("\n")) text += "\n";
    } else {
      lost = true;
    }
    offset = 0;
  } else if (cursor.inode === null || offset > size) {
    // first read, or the file was truncated
    offset = 0;
  }
  const end = Math.min(size, offset + Math.max(0, maxBytes - Buffer.byteLength(text)));
  const { text: lines, consumed } = completeLines(await readRange(path, offset, end));
  return { text: text + lines, cursor: { inode, offset: offset + consumed }, lost };
}

export interface HourCount {
  requests: number;
  errors: number;
}

export interface AccessCounts {
  /** slug -> hour (epoch ms, start of the UTC hour) -> counts */
  counts: Map<string, Map<number, HourCount>>;
  /** slug -> time of its last request (epoch ms) */
  last: Map<string, number>;
  lines: number;
}

const HOUR = 3_600_000;
const SLUG = "[a-z][a-z0-9-]{1,30}[a-z0-9]";

/**
 * Counts requests and 5xx responses per app host (`<slug>.<appsDomain>`, with or without port) and hour. Entries of
 * other hosts and unparsable lines are ignored. Maintenance responses of a stopped app (`maintenanceField` set by the
 * router) count as requests, not as errors.
 */
export function countAccessLines(text: string, appsDomain: string, maintenanceField: string, into?: AccessCounts): AccessCounts {
  const result = into ?? { counts: new Map(), last: new Map(), lines: 0 };
  const hostPattern = new RegExp(`^(${SLUG})\\.${appsDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?::\\d+)?$`, "i");
  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry: { ts?: unknown; status?: unknown; request?: { host?: unknown }; [key: string]: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    result.lines++;
    const host = typeof entry.request?.host === "string" ? entry.request.host : "";
    const match = hostPattern.exec(host);
    if (!match || typeof entry.ts !== "number") continue;
    const slug = match[1]!.toLowerCase();
    const at = Math.round(entry.ts * 1000);
    const hour = Math.floor(at / HOUR) * HOUR;
    let hours = result.counts.get(slug);
    if (!hours) result.counts.set(slug, (hours = new Map()));
    let count = hours.get(hour);
    if (!count) hours.set(hour, (count = { requests: 0, errors: 0 }));
    count.requests++;
    if (typeof entry.status === "number" && entry.status >= 500 && !entry[maintenanceField]) count.errors++;
    if (at > (result.last.get(slug) ?? 0)) result.last.set(slug, at);
  }
  return result;
}
