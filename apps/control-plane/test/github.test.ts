// Unit tests of src/github-policy.ts. The JSON of each frame is tested in test/push-frame.test.ts; the calls to the
// real GitHub are checked by hand (TECH_DEBT PLG-9).
import assert from "node:assert/strict";
import { once } from "node:events";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { test } from "node:test";
import { commitRequestBody, githubError, isBehind, logTail, pullAnswer, pullPathAllowed } from "../src/github-policy.ts";

const OID = "a".repeat(40);
const TARGET = { repo: "acme/todo", branch: "main", coAuthor: { name: "Dana", email: "dana@example.com" } };
const HEAD = `headline "Add todos"\nexpected ${OID}\n`;
const MAX_HEADER_LINE_BYTES = 64 * 1024;

function chunked(input: string | Buffer, size: number) {
  const bytes = Buffer.from(input);
  return Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size));
}
async function requestOf(chunks: (string | Buffer)[]) {
  const body = commitRequestBody(TARGET);
  const output = await text(Readable.from(chunks.map((chunk) => Buffer.from(chunk))).pipe(body));
  return { output, input: JSON.parse(output).variables.input, counts: body.counts };
}
const refuses = (chunks: (string | Buffer)[], message: RegExp) => assert.rejects(requestOf(chunks), message);
const contentsOf = async (chunks: (string | Buffer)[]) => (await requestOf(chunks)).input.fileChanges.additions[0].contents;

test("the frames become the request, each file's contents copied as it comes", async () => {
  const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString("base64");
  const { output, input, counts } = await requestOf([
    `headline "Add todos 🎉"\nbody "Détails"\nexpected ${OID}\ndelete "README.md"\ndelete "old.ts"\n` +
      `add "logo.bin"\n${binary}\nadd "empty"\n\nadd "src/é.ts"\nYQ==\n`,
  ]);
  assert.deepEqual(Object.keys(JSON.parse(output)), ["query", "variables"]);
  assert.deepEqual(input, {
    branch: { repositoryNameWithOwner: "acme/todo", branchName: "main" },
    expectedHeadOid: OID,
    message: { headline: "Add todos 🎉", body: "Détails\n\nCo-authored-by: Dana <dana@example.com>" },
    fileChanges: {
      deletions: [{ path: "README.md" }, { path: "old.ts" }],
      additions: [{ path: "logo.bin", contents: binary }, { path: "empty", contents: "" }, { path: "src/é.ts", contents: "YQ==" }],
    },
  });
  assert.deepEqual(counts, { deleted: 2, added: 3 });
});

test("the request is the same however the push is cut into chunks", async () => {
  const push = Buffer.from(`headline "🎉 é"\nbody "b"\nexpected ${OID}\ndelete "d"\nadd "a"\nYWJj\nadd "e"\n\nadd "f"\nZGVm\n`);
  const { output } = await requestOf([push]);
  for (let cut = 1; cut < push.length; cut++) {
    assert.equal((await requestOf([push.subarray(0, cut), push.subarray(cut)])).output, output, `cut at byte ${cut}`);
  }
  assert.equal((await requestOf(chunked(push, 1))).output, output);
  assert.equal((await requestOf(["", push, ""])).output, output);
});

test("contents go out as they come, before their line ends", async () => {
  const body = commitRequestBody(TARGET);
  let output = "";
  body.on("data", (chunk: Buffer) => (output += chunk));
  body.write(`${HEAD}add "a"\nYWJj`);
  await new Promise(setImmediate);
  assert.match(output, /"contents":"YWJj$/);
  body.end("ZGVm\n");
  await once(body, "end");
  assert.equal(JSON.parse(output).variables.input.fileChanges.additions[0].contents, "YWJjZGVm");
});

test("a file's contents have no size cap", async () => {
  const contents = "QUJD".repeat(256 * 1024);
  assert.equal(await contentsOf(chunked(`${HEAD}add "big"\n${contents}\n`, 64 * 1024)), contents);
});

test("a frame line holds at most 64 KiB, counted in bytes, however it arrives", async () => {
  const deleteLine = (bytes: number) => `delete "${"x".repeat(bytes - 9)}"\n`; // 9: `delete "` and `"`
  for (const chunkSize of [1024 * 1024, 1000]) {
    const { input } = await requestOf(chunked(`${HEAD}${deleteLine(MAX_HEADER_LINE_BYTES)}`, chunkSize));
    assert.equal(input.fileChanges.deletions[0].path.length, MAX_HEADER_LINE_BYTES - 9);
    await refuses(chunked(`${HEAD}${deleteLine(MAX_HEADER_LINE_BYTES + 1)}`, chunkSize), /frame line too long/);
  }
  await refuses([`${HEAD}delete "${"€".repeat(22_000)}"\n`], /frame line too long/);
  const { input } = await requestOf([HEAD, deleteLine(60_000), deleteLine(60_000), deleteLine(60_000)]);
  assert.equal(input.fileChanges.deletions.length, 3);
});

test("an oversized frame line is refused before it ends", async () => {
  const body = commitRequestBody(TARGET);
  body.resume();
  body.write(`${HEAD}delete "${"x".repeat(MAX_HEADER_LINE_BYTES)}`);
  const [error] = await once(body, "error");
  assert.match(error.message, /frame line too long/);
});

test("contents hold only base64 characters, so they never leave their JSON string", async () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  assert.equal(await contentsOf([`${HEAD}add "a"\n${alphabet}\n`]), alphabet);
  for (const character of ['"', "\\", " ", "\t", "\r", "\0", "-", "_", ".", "%", "}", "é", " "]) {
    await refuses([`${HEAD}add "a"\nYQ${character}==\n`], /must be base64/);
  }
  await refuses([Buffer.concat([Buffer.from(`${HEAD}add "a"\nYQ`), Buffer.from([0xff]), Buffer.from("==\n")])], /must be base64/);
  await refuses([`${HEAD}add "a"\nYQ==\r\n`], /must be base64/);
  await refuses([`${HEAD}add "a"\nYQ"}],"x":1\n`], /must be base64/);
  await refuses(chunked(`${HEAD}add "a"\n${"YQ==".repeat(100)}"\n`, 7), /must be base64/);
});

test("a push ends with a newline, after the expected head at least", async () => {
  for (const push of ["", `headline "x"\n`, `headline "x"\nbody "y"\n`, `headline "x"\nexpected ${OID}`, `${HEAD}delete "a"`, `${HEAD}add "a"\n`, `${HEAD}add "a"\nYQ==`]) {
    await refuses([push], /incomplete push/);
  }
  assert.deepEqual((await requestOf([HEAD])).input.fileChanges, { deletions: [], additions: [] });
  assert.deepEqual((await requestOf([`${HEAD}delete "a"\n`])).input.fileChanges, { deletions: [{ path: "a" }], additions: [] });
  assert.deepEqual((await requestOf([`${HEAD}add "a"\nYQ==\n`])).input.fileChanges, { deletions: [], additions: [{ path: "a", contents: "YQ==" }] });
});

test("a blank line is the empty contents of an added file, never a frame", async () => {
  assert.equal(await contentsOf([`${HEAD}add "a"\n\n`]), "");
  await refuses([`\n${HEAD}`], /unexpected frame ""/);
  await refuses([`${HEAD}\n`], /unexpected frame ""/);
  await refuses([`${HEAD}add "a"\nYQ==\n\n`], /unexpected frame ""/);
});

test("a frame out of order, unknown or not a JSON string fails the push", async () => {
  await refuses([`expected ${OID}\n`], /unexpected frame/);
  await refuses([`${HEAD}query "mutation { deleteRepository }"\n`], /unexpected frame/);
  await refuses([`${HEAD}add "a", "repositoryNameWithOwner": "acme/other"\n\n`], /JSON string/);
});

test("a pull reads only the app's branch head, and commits, trees and blobs by sha", () => {
  assert.ok(pullPathAllowed("git/ref/heads/main", "", "main"));
  assert.ok(pullPathAllowed(`git/commits/${OID}`, "", "main"));
  assert.ok(pullPathAllowed(`git/trees/${OID}`, "?recursive=1", "main"));
  assert.ok(pullPathAllowed(`git/blobs/${OID}`, "", "main"));
  assert.ok(!pullPathAllowed("git/ref/heads/other", "", "main"));
  assert.ok(!pullPathAllowed("git/refs/heads/main", "", "main"));
  assert.ok(!pullPathAllowed(`git/blobs/${OID}`, "?x=1", "main"));
  assert.ok(!pullPathAllowed(`git/trees/main`, "", "main"));
  assert.ok(!pullPathAllowed("contents/.env", "", "main"));
  assert.ok(!pullPathAllowed(`git/commits/${OID}/../../../../orgs`, "", "main"));
});

test("a pull relays GitHub's answer, and its failure as the relay's own error", async () => {
  const read = await pullAnswer(Response.json({ sha: OID }));
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { sha: OID });
  const failed = await pullAnswer(
    Response.json({ message: "Bad credentials", documentation_url: "https://docs.github.com/rest" }, { status: 401 }),
  );
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: "GitHub answered 401: Bad credentials" });
});

test("GitHub's errors read as gh reads them: the message, then each error", async () => {
  const errorOf = (body: unknown, status = 422) =>
    githubError(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  assert.equal(
    await errorOf({
      message: "Repository creation failed.",
      errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }],
    }),
    "GitHub answered 422: Repository creation failed.; name already exists on this account",
  );
  assert.equal(
    await errorOf({
      message: "Validation Failed",
      errors: [{ resource: "Repository", field: "name", code: "missing_field" }, "visibility is invalid"],
    }),
    "GitHub answered 422: Validation Failed; Repository.name missing_field; visibility is invalid",
  );
  assert.equal(await errorOf("<html>Bad gateway</html>", 502), "GitHub answered 502: <html>Bad gateway</html>");
});

test("GitHub's stale head error means behind", () => {
  assert.ok(isBehind([{ message: `Expected branch to point to "${OID}" but it did not. Pull and try again.` }]));
  assert.ok(isBehind([{ type: "STALE_DATA", message: "" }]));
  assert.ok(!isBehind([{ type: "FORBIDDEN", message: "Resource not accessible" }]));
  assert.ok(!isBehind(undefined));
});

test("a CI job's log is shown from its end, without the timestamps", () => {
  const log = "\uFEFF2026-11-06T10:00:00.1234567Z ##[group]Run npm run build\n" +
    "2026-11-06T10:00:01.0000000Z src/App.tsx(3,1): error TS2304: Cannot find name 'x'.\n" +
    "2026-11-06T10:00:01Z ##[error]Process completed with exit code 2.\n";
  assert.equal(
    logTail(log),
    "##[group]Run npm run build\nsrc/App.tsx(3,1): error TS2304: Cannot find name 'x'.\n" +
      "##[error]Process completed with exit code 2.\n",
  );
  const long = logTail(`${"x".repeat(30_000)}\nthe error\n`);
  assert.equal(long.length, 20_000);
  assert.ok(long.endsWith("the error\n"));
});
