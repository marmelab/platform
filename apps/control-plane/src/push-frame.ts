// One header frame of a web session's push, as commitRequestBody (github-policy.ts) reads it: the JSON it adds to the
// createCommitOnBranch request body. The platform writes the query, the repository and the branch itself, and
// re-serializes every value the session sends.

const CREATE_COMMIT_MUTATION =
  "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid tree { oid } } } }";
const OID_RE = /^[0-9a-f]{40}$/;

export interface CommitTarget {
  repo: string;
  branch: string;
  coAuthor: { name: string | null; email: string };
}

/** Where a push stands between two frames. */
export interface PushFrameState {
  stage: "headline" | "body" | "expected" | "deletions" | "additions";
  headline: string;
  body: string;
  counts: { deleted: number; added: number };
  /** An add frame was read: the next line is the file's contents, in base64. */
  readingContents: boolean;
}

export const newPushFrameState = (): PushFrameState => ({
  stage: "headline",
  headline: "",
  body: "",
  counts: { deleted: 0, added: 0 },
  readingContents: false,
});

const cleanIdent = (value: string) => value.replace(/[<>\r\n]/g, "").trim();

function jsonString(value: string, frame: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // reported below
  }
  if (typeof parsed !== "string" || parsed === "") throw new Error(`${frame}: expected a JSON string`);
  return parsed;
}

/** The JSON that `text`, one header frame without its newline, adds to the request body. Throws when out of order. */
export function frameToJson(text: string, state: PushFrameState, target: CommitTarget) {
  const space = text.indexOf(" ");
  const key = space < 0 ? text : text.slice(0, space);
  const value = space < 0 ? "" : text.slice(space + 1);
  if (key === "headline" && state.stage === "headline") {
    state.headline = jsonString(value, key);
    state.stage = "body";
    return "";
  }
  if (key === "body" && state.stage === "body") {
    state.body = jsonString(value, key);
    state.stage = "expected";
    return "";
  }
  if (key === "expected" && (state.stage === "body" || state.stage === "expected")) {
    if (!OID_RE.test(value)) throw new Error("expected: a commit sha");
    state.stage = "deletions";
    const { name, email } = target.coAuthor;
    const trailer = `Co-authored-by: ${cleanIdent(name || email)} <${cleanIdent(email)}>`;
    const branch = { repositoryNameWithOwner: target.repo, branchName: target.branch };
    const message = { headline: state.headline, body: state.body ? `${state.body}\n\n${trailer}` : trailer };
    return `{"query":${JSON.stringify(CREATE_COMMIT_MUTATION)},"variables":{"input":{"branch":${JSON.stringify(branch)},` +
      `"expectedHeadOid":"${value}","message":${JSON.stringify(message)},"fileChanges":{"deletions":[`;
  }
  if (key === "delete" && state.stage === "deletions") {
    return `${state.counts.deleted++ ? "," : ""}{"path":${JSON.stringify(jsonString(value, key))}}`;
  }
  if (key === "add" && (state.stage === "deletions" || state.stage === "additions")) {
    const separator = state.stage === "deletions" ? `],"additions":[` : ",";
    state.stage = "additions";
    state.counts.added++;
    state.readingContents = true;
    return `${separator}{"path":${JSON.stringify(jsonString(value, key))},"contents":"`;
  }
  throw new Error(`unexpected frame "${key.slice(0, 20)}"`);
}
