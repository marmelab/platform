// The pure rules of the code relay of web sessions (github.ts), unit-tested in test/github.test.ts: the push stream
// that becomes the GraphQL request, the paths a pull may read, GitHub's "behind" answer.
import { Transform } from "node:stream";

const CREATE_COMMIT_MUTATION =
  "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid tree { oid } } } }";
const OID_RE = /^[0-9a-f]{40}$/;
const MAX_HEADER_LINE_BYTES = 64 * 1024;
const IS_BASE64 = new Uint8Array(256);
for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=") IS_BASE64[char.charCodeAt(0)] = 1;

export interface CommitTarget {
  repo: string;
  branch: string;
  coAuthor: { name: string | null; email: string };
}

const cleanIdent = (value: string) => value.replace(/[<>\r\n]/g, "").trim();

/**
 * Writes the body of the createCommitOnBranch request from a session's push, as it flows. Frames, one per line, in
 * this order:
 *   headline <JSON string>
 *   body <JSON string>            (optional)
 *   expected <commit sha>         (the head the session last synced)
 *   delete <JSON string path>     (any number)
 *   add <JSON string path>        (any number), each followed by one line: the file's contents in base64
 * The platform writes the query, the repository and the branch, and re-serializes the header values; contents may
 * only hold base64 characters, which never end a JSON string. So the caller cannot reach another operation or
 * repository with the bot's token. A malformed stream errors: the request is aborted before GitHub runs anything.
 */
export function commitRequestBody(target: CommitTarget) {
  const trailer = `Co-authored-by: ${cleanIdent(target.coAuthor.name || target.coAuthor.email)} <${cleanIdent(target.coAuthor.email)}>`;
  const counts = { deleted: 0, added: 0 };
  let stage: "headline" | "body" | "expected" | "deletions" | "additions" = "headline";
  let headline = "";
  let body = "";
  let headerLine: Buffer[] = [];
  let headerLineBytes = 0;
  let readingContents = false;

  const jsonString = (value: string, frame: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      // reported below
    }
    if (typeof parsed !== "string" || parsed === "") throw new Error(`${frame}: expected a JSON string`);
    return parsed;
  };
  const frameToJson = (text: string) => {
    const space = text.indexOf(" ");
    const key = space < 0 ? text : text.slice(0, space);
    const value = space < 0 ? "" : text.slice(space + 1);
    if (key === "headline" && stage === "headline") {
      headline = jsonString(value, key);
      stage = "body";
      return "";
    }
    if (key === "body" && stage === "body") {
      body = jsonString(value, key);
      stage = "expected";
      return "";
    }
    if (key === "expected" && (stage === "body" || stage === "expected")) {
      if (!OID_RE.test(value)) throw new Error("expected: a commit sha");
      stage = "deletions";
      const branch = { repositoryNameWithOwner: target.repo, branchName: target.branch };
      const message = { headline, body: body ? `${body}\n\n${trailer}` : trailer };
      return `{"query":${JSON.stringify(CREATE_COMMIT_MUTATION)},"variables":{"input":{"branch":${JSON.stringify(branch)},` +
        `"expectedHeadOid":"${value}","message":${JSON.stringify(message)},"fileChanges":{"deletions":[`;
    }
    if (key === "delete" && stage === "deletions") {
      return `${counts.deleted++ ? "," : ""}{"path":${JSON.stringify(jsonString(value, key))}}`;
    }
    if (key === "add" && (stage === "deletions" || stage === "additions")) {
      const separator = stage === "deletions" ? `],"additions":[` : ",";
      stage = "additions";
      counts.added++;
      readingContents = true;
      return `${separator}{"path":${JSON.stringify(jsonString(value, key))},"contents":"`;
    }
    throw new Error(`unexpected frame "${key.slice(0, 20)}"`);
  };

  return Object.assign(
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const output: (string | Buffer)[] = [];
        try {
          let pos = 0;
          while (pos < chunk.length) {
            if (readingContents) {
              let end = pos;
              while (end < chunk.length && chunk[end] !== 0x0a) {
                if (!IS_BASE64[chunk[end]!]) throw new Error("add: the contents must be base64");
                end++;
              }
              if (end > pos) output.push(chunk.subarray(pos, end));
              if (end < chunk.length) {
                output.push(`"}`);
                readingContents = false;
                end++;
              }
              pos = end;
            } else {
              const newline = chunk.indexOf(0x0a, pos);
              const end = newline < 0 ? chunk.length : newline;
              headerLineBytes += end - pos;
              if (headerLineBytes > MAX_HEADER_LINE_BYTES) throw new Error("frame line too long");
              headerLine.push(chunk.subarray(pos, end));
              if (newline < 0) break;
              const text = Buffer.concat(headerLine).toString("utf8");
              headerLine = [];
              headerLineBytes = 0;
              output.push(frameToJson(text));
              pos = newline + 1;
            }
          }
        } catch (error) {
          return callback(error as Error);
        }
        for (const piece of output) if (piece.length) this.push(piece);
        callback();
      },
      flush(callback) {
        if (readingContents || headerLineBytes > 0 || (stage !== "deletions" && stage !== "additions")) {
          return callback(new Error("incomplete push: frames missing or not ended by a newline"));
        }
        callback(null, stage === "deletions" ? `],"additions":[]}}}}` : "]}}}}");
      },
    }),
    { counts },
  );
}

/** createCommitOnBranch refused because the branch moved since the session's last sync. */
export const isBehind = (errors: { type?: string; message?: string }[] = []) =>
  errors.some((e) => e.type === "STALE_DATA" || /expected branch to point to/i.test(e.message ?? ""));

/** The Git Data paths a pull reads: nothing else is relayed. */
export function pullPathAllowed(path: string, search: string, branch: string) {
  if (path === `git/ref/heads/${branch}` || /^git\/(commits|blobs)\/[0-9a-f]{40}$/.test(path)) return search === "";
  return /^git\/trees\/[0-9a-f]{40}$/.test(path) && (search === "" || search === "?recursive=1");
}
