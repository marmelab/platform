// push / pull of web sessions (packages/deploy-cli/src/code.ts) against a fake GitHub backed by a local
// repository. The fake runs the platform's own commitRequestBody and pullPathAllowed (src/github-policy.ts), so the session's
// frames go through the same rules as on the platform. No stack needed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { after, test } from "node:test";
import { type CodeRelay, pull, push } from "../../../packages/deploy-cli/src/code.ts";
import { commitRequestBody, pullPathAllowed } from "../src/github-policy.ts";

const IDENT = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const git = (dir: string, args: string[], options: { input?: string | Buffer; env?: Record<string, string> } = {}) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", input: options.input, env: { ...process.env, ...options.env } }).trim();

/** GitHub as the platform relays it: one repository, createCommitOnBranch and the read-only Git Data paths. */
function fakeGithub() {
  const repo = tempDir("relay-github-");
  git(repo, ["init", "-q", "-b", "main"]); // not bare: update-index needs a work tree, even unused
  let created = false;
  const pushedChanges: { deletions: { path: string }[]; additions: { path: string }[] }[] = [];
  const head = () => git(repo, ["rev-parse", "refs/heads/main"]);
  const relay: CodeRelay = {
    defaultBranch: async () => (created ? "main" : null),
    createRepository: async () => {
      const readme = git(repo, ["hash-object", "-w", "--stdin"], { input: "# app\n" });
      const tree = git(repo, ["mktree"], { input: `100644 blob ${readme}\tREADME.md\n` });
      git(repo, ["update-ref", "refs/heads/main", git(repo, ["commit-tree", tree, "-m", "Initial commit"], { env: IDENT })]);
      created = true;
      return { default_branch: "main", head: head() };
    },
    readGit: async (url) => {
      const [path, query] = url.split("?") as [string, string | undefined];
      if (!pullPathAllowed(path, query ? `?${query}` : "", "main")) return Response.json({ error: "not allowed" }, { status: 404 });
      const [, kind, arg] = path.split("/") as [string, string, string];
      if (kind === "ref") return Response.json({ object: { sha: head() } });
      if (kind === "commits") return Response.json({ tree: { sha: git(repo, ["rev-parse", `${arg}^{tree}`]) } });
      if (kind === "trees") {
        const tree = git(repo, ["ls-tree", "-r", "-z", arg]).split("\0").filter(Boolean).map((line) => {
          const [, mode, type, sha, p] = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(line)!;
          return { path: p, mode, type, sha };
        });
        return Response.json({ sha: arg, truncated: false, tree });
      }
      const content = execFileSync("git", ["cat-file", "blob", arg], { cwd: repo }).toString("base64");
      return Response.json({ content, encoding: "base64" });
    },
    commit: async (frames) => {
      const target = { repo: "acme/todo", branch: "main", coAuthor: { name: "Dana", email: "dana@example.com" } };
      const { expectedHeadOid, message, fileChanges } = JSON.parse(await text(Readable.from(frames).pipe(commitRequestBody(target))))
        .variables.input;
      pushedChanges.push(fileChanges);
      if (expectedHeadOid !== head()) return Response.json({ error: "behind" }, { status: 409 });
      const env = { GIT_INDEX_FILE: join(repo, "fake-index") };
      git(repo, ["read-tree", expectedHeadOid], { env });
      for (const { path } of fileChanges.deletions) git(repo, ["update-index", "--force-remove", path], { env });
      for (const { path, contents } of fileChanges.additions) {
        const blob = git(repo, ["hash-object", "-w", "--stdin"], { input: Buffer.from(contents, "base64") });
        git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
      }
      const tree = git(repo, ["write-tree"], { env });
      rmSync(env.GIT_INDEX_FILE);
      const body = `${message.headline}\n\n${message.body}`;
      git(repo, ["update-ref", "refs/heads/main", git(repo, ["commit-tree", tree, "-p", expectedHeadOid, "-m", body], { env: IDENT })]);
      return Response.json({ commit_sha: head(), tree_sha: tree });
    },
  };
  return { relay, repo, head, pushedChanges };
}

function session(app: string | null = "todo") {
  const dir = tempDir("relay-session-");
  if (app) {
    git(dir, ["init", "-q", "-b", "main"]);
    setIdentity(dir);
    write(dir, ".platform.json", JSON.stringify({ app }));
  }
  return dir;
}
const setIdentity = (dir: string) => {
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
};
const write = (dir: string, path: string, content: string | Buffer) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const commitAll = (dir: string, message: string) => {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
};
const treeOf = (dir: string, rev = "HEAD") => git(dir, ["rev-parse", `${rev}^{tree}`]);

test("push and pull through the relay", async (t) => {
  const github = fakeGithub();
  const a = session();
  write(a, "src/app.ts", "export const app = 1;\n");
  write(a, "public/logo.bin", Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  commitAll(a, "Create the app");

  await t.test("the first push creates the repository and replaces its README with the folder's files", async () => {
    const result = await push(a, "todo", github.relay);
    assert.equal(result.status, "PUSHED");
    assert.equal(git(github.repo, ["rev-parse", "main^{tree}"]), treeOf(a));
    assert.match(git(github.repo, ["log", "-1", "--format=%B", "main"]), /^Create the app\n\nCo-authored-by: Dana <dana@example\.com>/);
    assert.equal(git(a, ["config", "platform.app"]), "todo");
    assert.equal(git(a, ["config", "platform.synced"]), github.head());
  });

  await t.test("a later push sends only the changed files, nothing when nothing changed", async () => {
    write(a, "src/app.ts", "export const app = 2;\n");
    commitAll(a, "Change the app");
    assert.equal((await push(a, "todo", github.relay)).status, "PUSHED");
    assert.deepEqual(github.pushedChanges.at(-1)!.additions.map((f) => f.path), ["src/app.ts"]);
    assert.deepEqual(await push(a, "todo", github.relay), { status: "UNCHANGED" });
  });

  await t.test("a big push is split in several commits", async () => {
    const before = Number(git(github.repo, ["rev-list", "--count", "main"]));
    write(a, "one.txt", "1".repeat(30));
    write(a, "two.txt", "2".repeat(30));
    commitAll(a, "Two files");
    assert.equal((await push(a, "todo", github.relay, 16)).status, "PUSHED");
    assert.equal(Number(git(github.repo, ["rev-list", "--count", "main"])), before + 2);
    assert.equal(git(github.repo, ["rev-parse", "main^{tree}"]), treeOf(a));
    assert.match(git(github.repo, ["log", "-1", "--format=%s", "main"]), /\(part 2\/2\)$/);
  });

  const b = session(null);
  await t.test("an empty folder gets the app's code back", async () => {
    assert.equal((await pull(b, "todo", github.relay)).status, "PULLED");
    assert.equal(treeOf(b), treeOf(a));
    assert.deepEqual(readFileSync(join(b, "public/logo.bin")), readFileSync(join(a, "public/logo.bin")));
    setIdentity(b);
  });

  await t.test("a folder behind the app pulls (rebase) and pushes again", async () => {
    write(b, "src/b.ts", "b\n");
    commitAll(b, "From b");
    assert.equal((await push(b, "todo", github.relay)).status, "PUSHED");
    write(a, "src/a.ts", "a\n");
    commitAll(a, "From a");
    assert.deepEqual(await push(a, "todo", github.relay), { status: "BEHIND" });
    assert.equal((await pull(a, "todo", github.relay)).status, "PULLED");
    assert.equal((await push(a, "todo", github.relay)).status, "PUSHED");
    const online = git(github.repo, ["ls-tree", "-r", "--name-only", "main"]).split("\n");
    assert.ok(online.includes("src/a.ts") && online.includes("src/b.ts"), online.join(","));
  });

  await t.test("a new folder never pushes over an app that already has code", async () => {
    const c = session();
    write(c, "index.html", "other app\n");
    commitAll(c, "Another app named the same");
    assert.deepEqual(await push(c, "todo", github.relay), { status: "EXISTING_CODE" });
  });

  await t.test("a folder holds one app only", async () => {
    const other = session("other");
    write(other, "x", "x\n");
    commitAll(other, "x");
    await assert.rejects(push(other, "todo", github.relay), /holds the app "other", not "todo"/);
    await assert.rejects(pull(a, "other", github.relay), /holds the app "todo", not "other"/);
  });
});
