import { mkdir, readlink, rename, rm, symlink, writeFile, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomHex } from "./crypto.ts";

export async function writeFileAtomic(path: string, content: string, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomHex(6)}`;
  await writeFile(tmp, content, { mode });
  const handle = await open(tmp, "r");
  await handle.sync();
  await handle.close();
  await rename(tmp, path);
}

/** Atomically points <dir>/current at <dir>/<target> (relative symlink + rename). */
export async function switchCurrent(dir: string, target: string) {
  const tmp = join(dir, `current.tmp-${randomHex(6)}`);
  await symlink(target, tmp);
  await rename(tmp, join(dir, "current"));
}

export async function currentTarget(dir: string): Promise<string | null> {
  try {
    return await readlink(join(dir, "current"));
  } catch {
    return null;
  }
}

export const removeDir = (path: string) => rm(path, { recursive: true, force: true });
