const CREATE_COMMIT_MUTATION =
  "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid tree { oid } } } }";
const OID_RE = /^[0-9a-f]{40}$/;

export interface CommitTarget {
  repo: string;
  branch: string;
  coAuthor: { name: string | null; email: string };
}

export interface PushFrameState {
  stage: "headline" | "body" | "expected" | "deletions" | "additions";
  headline: string;
  body: string;
  counts: { deleted: number; added: number };
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

/** `text`: one header frame, without its newline. */
export function frameToJson(text: string, state: PushFrameState, target: CommitTarget) {
  const spaceIndex = text.indexOf(" ");
  const key = spaceIndex < 0 ? text : text.slice(0, spaceIndex);
  const value = spaceIndex < 0 ? "" : text.slice(spaceIndex + 1);
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
    const email = cleanIdent(target.coAuthor.email);
    const trailer = `Co-authored-by: ${cleanIdent(target.coAuthor.name ?? "") || email} <${email}>`;
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
