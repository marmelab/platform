// push / pull of a session on Claude Code on the web, which has no GitHub access: the platform commits the code to the
// app's repository with GitHub's API and reads it back the same way (apps/control-plane/src/github.ts).
// The folder's state is in its git: refs/platform/base (the local commit matching the last synced remote commit),
// platform.remote (that remote commit) and platform.app (the app this folder belongs to, never another one).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { request } from "./platform.ts";

/** The platform's side of push and pull: the app's code routes, and its repository (get_app). */
export interface CodeRemote {
  /** null: the app has no repository yet (never deployed). */
  branch(): Promise<string | null>;
  /** Creates the app's repository (first push): its branch and first commit. */
  create(): Promise<{ default_branch: string; head: string }>;
  /** A read-only Git Data path (git/ref/heads/<branch>, git/commits|trees|blobs/<sha>). */
  get(path: string): Promise<Response>;
  /** One commit: the framed push stream (github-policy.ts pushRequest). */
  commit(frames: AsyncIterable<Buffer>): Promise<Response>;
}

export function codeRemote(api: string, app: string, token: string, branch: () => Promise<string | null>): CodeRemote {
  const url = (path: string) => `${api}/apps/${app}/github${path}`;
  const authorization = `Bearer ${token}`;
  return {
    branch,
    create: async () => json(await request(url(""), { method: "POST", headers: { authorization } })),
    get: (path) => request(url(`/${path}`), { headers: { authorization } }),
    // a stream is read once: no retry
    commit: (frames) =>
      request(url("/commit"), {
        method: "POST",
        headers: { authorization },
        body: Readable.toWeb(Readable.from(frames)) as ReadableStream,
        duplex: "half",
      } as RequestInit, 1),
  };
}

export type PushResult =
  | { status: "PUSHED"; commit_sha: string }
  | { status: "UNCHANGED" | "BEHIND" | "EXISTING_CODE" };
export type PullResult = { status: "PULLED" | "CONFLICT"; commit_sha: string };

interface Entry {
  mode: string;
  sha: string;
  size: number;
  path: string;
}

const BASE = "refs/platform/base";
const BATCH_BYTES = 10 * 1024 * 1024;

function git(dir: string, args: string[], options: { input?: string | Buffer; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync("git", args, { cwd: dir, input: options.input, env: options.env, maxBuffer: 1024 ** 3 });
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr.toString().trim() || `exit ${result.status}`}`);
  return result.stdout.toString().trim();
}
const gitOk = (dir: string, args: string[]) => spawnSync("git", args, { cwd: dir }).status === 0;
const config = (dir: string, key: string) => (gitOk(dir, ["config", "--get", key]) ? git(dir, ["config", "--get", key]) : null);

async function json<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text.slice(0, 500) };
  }
  if (!response.ok) throw Object.assign(new Error(body.error ?? `HTTP ${response.status}`), { status: response.status, body });
  return body as T;
}

/** This folder belongs to one app: the one of its .platform.json, and the one it last synced with. */
function checkFolder(dir: string, app: string) {
  const file = join(dir, ".platform.json");
  const named = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).app : null;
  const synced = gitOk(dir, ["rev-parse", "--git-dir"]) ? config(dir, "platform.app") : null;
  for (const other of [named, synced]) {
    if (other && other !== app) throw new Error(`this folder holds the app "${other}", not "${app}": open a new session for "${app}"`);
  }
}

function cleanTree(dir: string) {
  if (git(dir, ["status", "--porcelain"]) !== "") throw new Error("uncommitted changes: commit them first");
}

/** `git ls-tree -r -l -z`: the files of a commit, with their size. */
function files(dir: string, rev: string): Entry[] {
  return git(dir, ["ls-tree", "-r", "-l", "-z", rev]).split("\0").filter(Boolean).map((line) => {
    const [, mode, , sha, size, path] = /^(\d+) (\w+) ([0-9a-f]+) +(\S+)\t(.*)$/s.exec(line)!;
    return { mode: mode!, sha: sha!, size: Number(size), path: path! };
  });
}

async function remoteFiles(remote: CodeRemote, commit: string) {
  const { tree } = await json<{ tree: { sha: string } }>(await remote.get(`git/commits/${commit}`));
  const listing = await json<{ sha: string; truncated: boolean; tree: { path: string; mode: string; type: string; sha: string }[] }>(
    await remote.get(`git/trees/${tree.sha}?recursive=1`),
  );
  if (listing.truncated) throw new Error("the app's repository is too big to be listed by GitHub's API");
  return { tree: listing.sha, entries: listing.tree.filter((e) => e.type === "blob") };
}

/** base64 of a stream, chunk by chunk (the 0 to 2 bytes left over wait for the next chunk). */
async function* base64(chunks: AsyncIterable<Buffer>) {
  let rest = Buffer.alloc(0);
  for await (const chunk of chunks) {
    const data = Buffer.concat([rest, chunk]);
    const whole = data.length - (data.length % 3);
    if (whole) yield Buffer.from(data.subarray(0, whole).toString("base64"));
    rest = data.subarray(whole);
  }
  if (rest.length) yield Buffer.from(rest.toString("base64"));
}

async function* blob(dir: string, sha: string) {
  const child = spawn("git", ["cat-file", "blob", sha], { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });
  const exit = new Promise<number | null>((resolve) => child.on("close", resolve));
  yield* child.stdout as AsyncIterable<Buffer>;
  if ((await exit) !== 0) throw new Error(`git cat-file blob ${sha} failed`);
}

const line = (text: string) => Buffer.from(`${text}\n`);

/**
 * Commits HEAD's files to the app's repository, as one commit per batch of about `batchBytes` (base64) on top of the
 * remote head this folder last synced. Never merges by itself: BEHIND (the app changed since) and EXISTING_CODE (the
 * app already has code this folder never synced) are for the caller to resolve with pull.
 */
export async function push(dir: string, app: string, remote: CodeRemote, batchBytes = BATCH_BYTES): Promise<PushResult> {
  checkFolder(dir, app);
  cleanTree(dir);
  let branch = await remote.branch();
  let head: string;
  if (!branch) {
    const created = await remote.create();
    ({ default_branch: branch, head } = created);
    git(dir, ["config", "platform.app", app]);
    git(dir, ["config", "platform.remote", head]);
  } else {
    head = (await json<{ object: { sha: string } }>(await remote.get(`git/ref/heads/${branch}`))).object.sha;
    const synced = config(dir, "platform.remote");
    if (!synced) return { status: "EXISTING_CODE" };
    if (synced !== head) return { status: "BEHIND" };
  }

  const local = files(dir, "HEAD");
  const unsupported = local.filter((f) => f.mode !== "100644");
  if (unsupported.length) {
    throw new Error(`symlinks, submodules and executable files cannot be pushed: ${unsupported.map((f) => f.path).join(", ")}`);
  }
  const online = await remoteFiles(remote, head);
  const known = new Map(online.entries.map((e) => [e.path, e.sha]));
  const additions = local.filter((f) => known.get(f.path) !== f.sha);
  const kept = new Set(local.map((f) => f.path));
  const deletions = online.entries.filter((e) => !kept.has(e.path)).map((e) => e.path);
  if (!additions.length && !deletions.length) return { status: "UNCHANGED" };

  // ponytail: ~10 MiB per commit because GitHub documents no GraphQL body limit; tune if GitHub refuses or allows more
  const batches: Entry[][] = [[]];
  let size = 0;
  for (const file of additions) {
    const encoded = Math.ceil(file.size / 3) * 4;
    if (size + encoded > batchBytes && batches.at(-1)!.length) {
      batches.push([]);
      size = 0;
    }
    batches.at(-1)!.push(file);
    size += encoded;
  }

  const range = gitOk(dir, ["rev-parse", "--verify", "-q", BASE]) ? [`${BASE}..HEAD`] : ["HEAD"];
  const subjects = git(dir, ["log", "--format=%s", ...range]).split("\n").filter(Boolean);
  const headline = subjects[0] || "Update the app";
  const details = subjects.slice(1).map((s) => `- ${s}`).join("\n");
  let commit: { commit_sha: string; tree_sha: string } | undefined;
  for (const [index, batch] of batches.entries()) {
    const part = batches.length > 1 ? ` (part ${index + 1}/${batches.length})` : "";
    async function* frames() {
      yield line(`headline ${JSON.stringify(headline + part)}`);
      if (details) yield line(`body ${JSON.stringify(details)}`);
      yield line(`expected ${commit?.commit_sha ?? head}`);
      if (index === 0) for (const path of deletions) yield line(`delete ${JSON.stringify(path)}`);
      for (const file of batch) {
        yield line(`add ${JSON.stringify(file.path)}`);
        yield* base64(blob(dir, file.sha));
        yield line("");
      }
    }
    const response = await remote.commit(frames());
    if (response.status === 409 && index === 0) {
      const body = await response.json().catch(() => ({}));
      if (body.error === "behind") return { status: "BEHIND" };
      throw new Error(body.error ?? "HTTP 409");
    }
    commit = await json(response);
  }
  if (commit!.tree_sha !== git(dir, ["rev-parse", "HEAD^{tree}"])) {
    console.error("warning: the app's repository and this folder differ after the push (file modes?)");
  }
  git(dir, ["update-ref", BASE, "HEAD"]);
  git(dir, ["config", "platform.app", app]);
  git(dir, ["config", "platform.remote", commit!.commit_sha]);
  return { status: "PUSHED", commit_sha: commit!.commit_sha };
}

/**
 * Brings the app's code into this folder: restores it into a folder with no commit, otherwise rebases the folder's
 * own commits on it (CONFLICT: resolve, then `git rebase --continue`). Only the missing files are downloaded, straight
 * into the folder's git.
 */
export async function pull(dir: string, app: string, remote: CodeRemote): Promise<PullResult> {
  checkFolder(dir, app);
  const branch = await remote.branch();
  if (!branch) throw new Error(`the app "${app}" was never deployed: there is no code to bring back`);
  if (!gitOk(dir, ["rev-parse", "--git-dir"])) git(dir, ["init", "-q", "-b", branch]);
  const hasHead = gitOk(dir, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (hasHead) cleanTree(dir);

  const head = (await json<{ object: { sha: string } }>(await remote.get(`git/ref/heads/${branch}`))).object.sha;
  const online = await remoteFiles(remote, head);
  for (const entry of online.entries) {
    if (gitOk(dir, ["cat-file", "-e", entry.sha])) continue;
    const { content } = await json<{ content: string }>(await remote.get(`git/blobs/${entry.sha}`));
    const written = git(dir, ["hash-object", "-w", "--stdin"], { input: Buffer.from(content, "base64") });
    if (written !== entry.sha) throw new Error(`${entry.path}: the downloaded content does not match`);
  }
  const index = join(git(dir, ["rev-parse", "--absolute-git-dir"]), "platform-index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  let tree: string;
  try {
    git(dir, ["update-index", "--add", "--index-info"], {
      input: online.entries.map((e) => `${e.mode} ${e.sha}\t${e.path}\n`).join(""),
      env,
    });
    tree = git(dir, ["write-tree"], { env });
  } finally {
    rmSync(index, { force: true });
  }
  if (tree !== online.tree) throw new Error("the downloaded code does not match the app's repository");

  const base = gitOk(dir, ["rev-parse", "--verify", "-q", BASE]) ? git(dir, ["rev-parse", BASE]) : null;
  const identity = config(dir, "user.email") ? {} : {
    GIT_AUTHOR_NAME: "platform", GIT_AUTHOR_EMAIL: "platform@localhost",
    GIT_COMMITTER_NAME: "platform", GIT_COMMITTER_EMAIL: "platform@localhost",
  };
  const synced = git(dir, ["commit-tree", tree, ...(base ? ["-p", base] : []), "-m", `${app} at ${head.slice(0, 7)}`], {
    env: { ...process.env, ...identity },
  });
  git(dir, ["update-ref", BASE, synced]);
  git(dir, ["config", "platform.app", app]);
  git(dir, ["config", "platform.remote", head]);

  if (!hasHead) {
    git(dir, ["checkout", "-q", "-B", branch, synced]);
    return { status: "PULLED", commit_sha: head };
  }
  const rebase = spawnSync("git", ["rebase", "-q", "--onto", synced, ...(base ? [base] : ["--root"])], { cwd: dir });
  return { status: rebase.status === 0 ? "PULLED" : "CONFLICT", commit_sha: head };
}
