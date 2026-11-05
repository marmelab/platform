// Unit tests of the code relay of web sessions (src/github-policy.ts): the push stream that becomes the GraphQL request,
// the paths a pull may read, the "behind" answer. The GitHub calls themselves are checked by hand (TECH_DEBT PLG-9).
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { test } from "node:test";
import { isBehind, pushRequest, readAllowed } from "../src/github-policy.ts";

const HEAD = "a".repeat(40);
const target = { repo: "acme/todo", branch: "main", coAuthor: { name: "Dana <x>\nEvil", email: "dana@example.com" } };

/** Feeds `input` to pushRequest in 3-byte chunks, so frames split mid-line and mid-contents. */
async function run(input: string) {
  const bytes = Buffer.from(input);
  const chunks = Array.from({ length: Math.ceil(bytes.length / 3) }, (_, i) => bytes.subarray(i * 3, i * 3 + 3));
  return text(Readable.from(chunks).pipe(pushRequest(target)));
}
const fails = (input: string, message: RegExp) =>
  assert.rejects(
    () => new Promise((resolve, reject) => {
      const frames = pushRequest(target);
      frames.on("error", reject).on("data", () => {}).on("end", resolve);
      Readable.from([Buffer.from(input)]).pipe(frames);
    }),
    message,
  );

test("the push becomes a createCommitOnBranch on the app's repository, with the member as co-author", async () => {
  const output = await run(
    `headline ${JSON.stringify("Add todos")}\nbody ${JSON.stringify("détails")}\nexpected ${HEAD}\n` +
      `delete "README.md"\nadd "src/a.ts"\n${Buffer.from("a").toString("base64")}\nadd "empty"\n\n`,
  );
  const request = JSON.parse(output);
  assert.match(request.query, /^mutation\(\$input: CreateCommitOnBranchInput!\) \{ createCommitOnBranch/);
  assert.deepEqual(Object.keys(request), ["query", "variables"]);
  assert.deepEqual(request.variables.input, {
    branch: { repositoryNameWithOwner: "acme/todo", branchName: "main" },
    expectedHeadOid: HEAD,
    message: { headline: "Add todos", body: "détails\n\nCo-authored-by: Dana xEvil <dana@example.com>" },
    fileChanges: {
      deletions: [{ path: "README.md" }],
      additions: [{ path: "src/a.ts", contents: "YQ==" }, { path: "empty", contents: "" }],
    },
  });
});

test("no body, no deletion, no addition: still a complete request", async () => {
  const request = JSON.parse(await run(`headline "x"\nexpected ${HEAD}\n`));
  assert.equal(request.variables.input.message.body, "Co-authored-by: Dana xEvil <dana@example.com>");
  assert.deepEqual(request.variables.input.fileChanges, { deletions: [], additions: [] });
});

test("contents cannot break out of their JSON string, nor frames reach the query or the repository", async () => {
  await fails(`headline "x"\nexpected ${HEAD}\nadd "a"\nYQ"}],"x":1\n`, /must be base64/);
  await fails(`headline "x"\nexpected ${HEAD}\nadd "a"\nYQ\\u0022\n`, /must be base64/);
  await fails(`headline "x"\nexpected ${HEAD}\nadd "a", "repositoryNameWithOwner": "acme/other"\n\n`, /JSON string/);
  await fails(`headline {"a":1}\nexpected ${HEAD}\n`, /JSON string/);
  await fails(`headline "x"\nexpected ${HEAD}"\n`, /commit sha/);
  await fails(`headline "x"\nexpected ${HEAD}\nquery "mutation { deleteRepository }"\n`, /unexpected frame/);
});

test("frames out of order, unterminated or oversized are refused", async () => {
  await fails(`expected ${HEAD}\n`, /unexpected frame/);
  await fails(`headline "x"\nexpected ${HEAD}\nadd "a"\n\ndelete "b"\n`, /unexpected frame/);
  await fails(`headline "x"\n`, /incomplete push/);
  await fails(`headline "x"\nexpected ${HEAD}\nadd "a"\nYQ==`, /incomplete push/);
  await fails(`headline "${"x".repeat(70_000)}"\n`, /too long/);
});

test("a pull reads only the app's branch head, and commits, trees and blobs by sha", () => {
  assert.ok(readAllowed("git/ref/heads/main", "", "main"));
  assert.ok(readAllowed(`git/commits/${HEAD}`, "", "main"));
  assert.ok(readAllowed(`git/trees/${HEAD}`, "?recursive=1", "main"));
  assert.ok(readAllowed(`git/blobs/${HEAD}`, "", "main"));
  assert.ok(!readAllowed("git/ref/heads/other", "", "main"));
  assert.ok(!readAllowed("git/refs/heads/main", "", "main"));
  assert.ok(!readAllowed(`git/blobs/${HEAD}`, "?x=1", "main"));
  assert.ok(!readAllowed(`git/trees/main`, "", "main"));
  assert.ok(!readAllowed("contents/.env", "", "main"));
  assert.ok(!readAllowed(`git/commits/${HEAD}/../../../../orgs`, "", "main"));
});

test("GitHub's stale head error means behind", () => {
  assert.ok(isBehind([{ message: `Expected branch to point to "${HEAD}" but it did not. Pull and try again.` }]));
  assert.ok(isBehind([{ type: "STALE_DATA", message: "" }]));
  assert.ok(!isBehind([{ type: "FORBIDDEN", message: "Resource not accessible" }]));
  assert.ok(!isBehind(undefined));
});
