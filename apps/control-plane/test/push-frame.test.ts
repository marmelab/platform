// Unit tests of src/push-frame.ts: the JSON each header frame of a web session's push adds to the createCommitOnBranch
// request. The contents lines, the line splitting and the end of the request are commitRequestBody's
// (test/github.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { type CommitTarget, frameToJson, newPushFrameState } from "../src/push-frame.ts";

const OID = "0123456789abcdef0123456789abcdef01234567";
const TARGET: CommitTarget = { repo: "acme/todo", branch: "main", coAuthor: { name: "Dana", email: "dana@example.com" } };
const TRAILER = "Co-authored-by: Dana <dana@example.com>";

/** The request `frames` make, completed as commitRequestBody does: "YQ==" after each add frame, then the end. */
function requestOf(frames: string[], target = TARGET) {
  const state = newPushFrameState();
  let json = "";
  for (const frame of frames) {
    json += frameToJson(frame, state, target);
    if (state.readingContents) {
      json += `YQ=="}`;
      state.readingContents = false;
    }
  }
  json += state.stage === "deletions" ? `],"additions":[]}}}}` : "]}}}}";
  return { request: JSON.parse(json), counts: state.counts };
}

/** All frames but the last are accepted, the last throws `message`. */
function refuses(frames: string[], message: RegExp) {
  const state = newPushFrameState();
  for (const frame of frames.slice(0, -1)) {
    frameToJson(frame, state, TARGET);
    state.readingContents = false;
  }
  assert.throws(() => frameToJson(frames.at(-1)!, state, TARGET), message);
}

test("the frames make a createCommitOnBranch on the target's repository and branch, and nothing else", () => {
  const { request, counts } = requestOf([
    `headline "Add todos"`,
    `body "Details"`,
    `expected ${OID}`,
    `delete "README.md"`,
    `delete "old/a.ts"`,
    `add "src/a.ts"`,
    `add "src/b.ts"`,
  ]);
  assert.deepEqual(request, {
    query: "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid tree { oid } } } }",
    variables: {
      input: {
        branch: { repositoryNameWithOwner: "acme/todo", branchName: "main" },
        expectedHeadOid: OID,
        message: { headline: "Add todos", body: `Details\n\n${TRAILER}` },
        fileChanges: {
          deletions: [{ path: "README.md" }, { path: "old/a.ts" }],
          additions: [{ path: "src/a.ts", contents: "YQ==" }, { path: "src/b.ts", contents: "YQ==" }],
        },
      },
    },
  });
  assert.deepEqual(counts, { deleted: 2, added: 2 });
});

test("the body, the deletions and the additions are optional", () => {
  const { request, counts } = requestOf([`headline "x"`, `expected ${OID}`]);
  assert.deepEqual(request.variables.input.message, { headline: "x", body: TRAILER });
  assert.deepEqual(request.variables.input.fileChanges, { deletions: [], additions: [] });
  assert.deepEqual(counts, { deleted: 0, added: 0 });
  assert.deepEqual(requestOf([`headline "x"`, `expected ${OID}`, `delete "a"`]).request.variables.input.fileChanges, {
    deletions: [{ path: "a" }],
    additions: [],
  });
  assert.deepEqual(requestOf([`headline "x"`, `expected ${OID}`, `add "a"`]).request.variables.input.fileChanges, {
    deletions: [],
    additions: [{ path: "a", contents: "YQ==" }],
  });
});

test("each value is decoded, then written back by the platform", () => {
  const value = 'a "quote", a \\ backslash, a\nnewline, a\ttab, é, 🎉,  , </script>';
  const json = JSON.stringify(value);
  const { message, fileChanges } = requestOf([
    `headline ${json}`,
    `body ${json}`,
    `expected ${OID}`,
    `delete ${json}`,
    `add ${json}`,
  ]).request.variables.input;
  assert.equal(message.headline, value);
  assert.equal(message.body, `${value}\n\n${TRAILER}`);
  assert.equal(fileChanges.deletions[0].path, value);
  assert.equal(fileChanges.additions[0].path, value);
  assert.equal(requestOf([`headline "\\u00e9\\/\\"\\b"`, `expected ${OID}`]).request.variables.input.message.headline, 'é/"\b');
});

test("a value is one non-empty JSON string", () => {
  const notOneString = ["", "x", "'x'", '""', "1", "null", "true", '["x"]', '{"path":"x"}', '"x" "y"', '"unterminated'];
  notOneString.push('"x", "repositoryNameWithOwner": "acme/other"');
  const before = { headline: [], body: [`headline "x"`], delete: [`headline "x"`, `expected ${OID}`], add: [`headline "x"`, `expected ${OID}`] };
  for (const [key, frames] of Object.entries(before)) {
    for (const value of notOneString) refuses([...frames, `${key} ${value}`], new RegExp(`^Error: ${key}: expected a JSON string$`));
    refuses([...frames, key], new RegExp(`^Error: ${key}: expected a JSON string$`));
  }
});

test("the expected head is a full, lowercase commit sha", () => {
  for (const value of ["", OID.slice(1), `${OID}0`, OID.toUpperCase(), "g".repeat(40), `"${OID}"`, ` ${OID}`, `${OID} `, `${OID}\r`]) {
    refuses([`headline "x"`, `expected ${value}`], /^Error: expected: a commit sha$/);
  }
  refuses([`headline "x"`, "expected"], /^Error: expected: a commit sha$/);
});

test("frames come in order: headline, body, expected head, deletions, additions, each of the first three once", () => {
  const head = [`headline "x"`, `body "y"`, `expected ${OID}`];
  for (const first of [`body "y"`, `expected ${OID}`, `delete "a"`, `add "a"`]) refuses([first], /unexpected frame/);
  refuses([`headline "x"`, `headline "x"`], /unexpected frame/);
  refuses([`headline "x"`, `body "y"`, `body "y"`], /unexpected frame/);
  refuses([`headline "x"`, `body "y"`, `headline "x"`], /unexpected frame/);
  refuses([`headline "x"`, `delete "a"`], /unexpected frame/);
  refuses([`headline "x"`, `add "a"`], /unexpected frame/);
  for (const again of [`headline "x"`, `body "y"`, `expected ${OID}`]) {
    refuses([...head, again], /unexpected frame/);
    refuses([...head, `delete "a"`, again], /unexpected frame/);
    refuses([...head, `add "a"`, again], /unexpected frame/);
  }
  refuses([...head, `add "a"`, `delete "b"`], /unexpected frame/);
});

test("an unknown frame is refused, its name in the error cut to 20 characters", () => {
  refuses([`query "mutation { deleteRepository }"`], /^Error: unexpected frame "query"$/);
  refuses([`headline "x"`, `expected ${OID}`, `variables {"input":{}}`], /^Error: unexpected frame "variables"$/);
  refuses([""], /^Error: unexpected frame ""$/);
  refuses([`Headline "x"`], /^Error: unexpected frame "Headline"$/);
  refuses([`headline\t"x"`], /^Error: unexpected frame "headline\t"x""$/);
  refuses([`headline "x"`, `expected ${OID}`, `${"k".repeat(100)} "x"`], /^Error: unexpected frame "k{20}"$/);
});

test("only an add frame announces a contents line", () => {
  const state = newPushFrameState();
  for (const frame of [`headline "x"`, `body "y"`, `expected ${OID}`, `delete "a"`]) {
    frameToJson(frame, state, TARGET);
    assert.equal(state.readingContents, false, frame);
  }
  frameToJson(`add "b"`, state, TARGET);
  assert.equal(state.readingContents, true);
});

test("the member is the co-author, in a trailer their name cannot add lines or addresses to", () => {
  const bodyFor = (coAuthor: CommitTarget["coAuthor"]) =>
    requestOf([`headline "x"`, `expected ${OID}`], { ...TARGET, coAuthor }).request.variables.input.message.body;
  assert.equal(bodyFor({ name: "Dana Doe", email: "dana@example.com" }), "Co-authored-by: Dana Doe <dana@example.com>");
  for (const name of [null, "", "  ", "<>", "\r\n"]) {
    assert.equal(bodyFor({ name, email: "dana@example.com" }), "Co-authored-by: dana@example.com <dana@example.com>", String(name));
  }
  assert.equal(
    bodyFor({ name: " Dana <evil@example.com>\r\nSigned-off-by: Eve ", email: "<dana@example.com>\n" }),
    "Co-authored-by: Dana evil@example.comSigned-off-by: Eve <dana@example.com>",
  );
});
