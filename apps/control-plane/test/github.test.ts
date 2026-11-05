// Unit tests of the code relay of web sessions (src/github-policy.ts): the push stream that becomes the GraphQL request,
// the paths a pull may read, the "behind" answer. The GitHub calls themselves are checked by hand (TECH_DEBT PLG-9).
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { test } from "node:test";
import { isBehind, commitRequestBody, pullPathAllowed } from "../src/github-policy.ts";

const OID = "a".repeat(40);
const target = { repo: "acme/todo", branch: "main", coAuthor: { name: "Dana <x>\nEvil", email: "dana@example.com" } };

/** Feeds `input` to commitRequestBody in 3-byte chunks, so frames split mid-line and mid-contents. */
async function requestBodyOf(input: string) {
  const bytes = Buffer.from(input);
  const chunks = Array.from({ length: Math.ceil(bytes.length / 3) }, (_, i) => bytes.subarray(i * 3, i * 3 + 3));
  return text(Readable.from(chunks).pipe(commitRequestBody(target)));
}
const refuses = (input: string, message: RegExp) =>
  assert.rejects(
    () => new Promise((resolve, reject) => {
      const frames = commitRequestBody(target);
      frames.on("error", reject).on("data", () => {}).on("end", resolve);
      Readable.from([Buffer.from(input)]).pipe(frames);
    }),
    message,
  );

test("the push becomes a createCommitOnBranch on the app's repository, with the member as co-author", async () => {
  const output = await requestBodyOf(
    `headline ${JSON.stringify("Add todos")}\nbody ${JSON.stringify("détails")}\nexpected ${OID}\n` +
      `delete "README.md"\nadd "src/a.ts"\n${Buffer.from("a").toString("base64")}\nadd "empty"\n\n`,
  );
  const request = JSON.parse(output);
  assert.match(request.query, /^mutation\(\$input: CreateCommitOnBranchInput!\) \{ createCommitOnBranch/);
  assert.deepEqual(Object.keys(request), ["query", "variables"]);
  assert.deepEqual(request.variables.input, {
    branch: { repositoryNameWithOwner: "acme/todo", branchName: "main" },
    expectedHeadOid: OID,
    message: { headline: "Add todos", body: "détails\n\nCo-authored-by: Dana xEvil <dana@example.com>" },
    fileChanges: {
      deletions: [{ path: "README.md" }],
      additions: [{ path: "src/a.ts", contents: "YQ==" }, { path: "empty", contents: "" }],
    },
  });
});

test("no body, no deletion, no addition: still a complete request", async () => {
  const request = JSON.parse(await requestBodyOf(`headline "x"\nexpected ${OID}\n`));
  assert.equal(request.variables.input.message.body, "Co-authored-by: Dana xEvil <dana@example.com>");
  assert.deepEqual(request.variables.input.fileChanges, { deletions: [], additions: [] });
});

test("contents cannot break out of their JSON string, nor frames reach the query or the repository", async () => {
  await refuses(`headline "x"\nexpected ${OID}\nadd "a"\nYQ"}],"x":1\n`, /must be base64/);
  await refuses(`headline "x"\nexpected ${OID}\nadd "a"\nYQ\\u0022\n`, /must be base64/);
  await refuses(`headline "x"\nexpected ${OID}\nadd "a", "repositoryNameWithOwner": "acme/other"\n\n`, /JSON string/);
  await refuses(`headline {"a":1}\nexpected ${OID}\n`, /JSON string/);
  await refuses(`headline "x"\nexpected ${OID}"\n`, /commit sha/);
  await refuses(`headline "x"\nexpected ${OID}\nquery "mutation { deleteRepository }"\n`, /unexpected frame/);
});

test("frames out of order, unterminated or oversized are refused", async () => {
  await refuses(`expected ${OID}\n`, /unexpected frame/);
  await refuses(`headline "x"\nexpected ${OID}\nadd "a"\n\ndelete "b"\n`, /unexpected frame/);
  await refuses(`headline "x"\n`, /incomplete push/);
  await refuses(`headline "x"\nexpected ${OID}\nadd "a"\nYQ==`, /incomplete push/);
  await refuses(`headline "${"x".repeat(70_000)}"\n`, /too long/);
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

test("GitHub's stale head error means behind", () => {
  assert.ok(isBehind([{ message: `Expected branch to point to "${OID}" but it did not. Pull and try again.` }]));
  assert.ok(isBehind([{ type: "STALE_DATA", message: "" }]));
  assert.ok(!isBehind([{ type: "FORBIDDEN", message: "Resource not accessible" }]));
  assert.ok(!isBehind(undefined));
});
