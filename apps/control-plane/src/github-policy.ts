// The pure rules of the code relay of web sessions (github.ts), unit-tested in test/github.test.ts: the push stream
// that becomes the GraphQL request (each header frame translated by push-frame.ts), the paths a pull may read and what
// it answers, GitHub's "behind" answer, GitHub's errors.
import { Transform } from "node:stream";
import { type CommitTarget, frameToJson, newPushFrameState } from "./push-frame.ts";

const MAX_HEADER_LINE_BYTES = 64 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/=]*$/;

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
  const state = newPushFrameState();
  let headerLine: Buffer[] = [];
  let headerLineBytes = 0;

  return Object.assign(
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const output: (string | Buffer)[] = [];
        try {
          let pos = 0;
          while (pos < chunk.length) {
            const newlineIndex = chunk.indexOf(0x0a, pos);
            const end = newlineIndex < 0 ? chunk.length : newlineIndex;
            if (state.readingContents) {
              if (!BASE64_RE.test(chunk.toString("latin1", pos, end))) throw new Error("add: the contents must be base64");
              output.push(chunk.subarray(pos, end));
              if (newlineIndex >= 0) {
                output.push(`"}`);
                state.readingContents = false;
              }
            } else {
              headerLineBytes += end - pos;
              if (headerLineBytes > MAX_HEADER_LINE_BYTES) throw new Error("frame line too long");
              headerLine.push(chunk.subarray(pos, end));
              if (newlineIndex >= 0) {
                const text = Buffer.concat(headerLine).toString("utf8");
                headerLine = [];
                headerLineBytes = 0;
                output.push(frameToJson(text, state, target));
              }
            }
            if (newlineIndex < 0) break;
            pos = newlineIndex + 1;
          }
        } catch (error) {
          return callback(error as Error);
        }
        for (const piece of output) if (piece.length) this.push(piece);
        callback();
      },
      flush(callback) {
        if (state.readingContents || headerLineBytes > 0 || (state.stage !== "deletions" && state.stage !== "additions")) {
          return callback(new Error("incomplete push: frames missing or not ended by a newline"));
        }
        callback(null, state.stage === "deletions" ? `],"additions":[]}}}}` : "]}}}}");
      },
    }),
    { counts: state.counts },
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

/** A pull read as the session gets it: GitHub's answer, or its failure as the relay's own error, never GitHub's status. */
export async function pullAnswer(response: Response) {
  if (!response.ok) return Response.json({ error: await githubError(response) }, { status: 502 });
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}

const LOG_TAIL_CHARS = 20_000;

/** The end of a CI job's log as get_ci_run shows it, without GitHub's timestamp at the start of each line. */
export const logTail = (log: string) =>
  log.replace(/^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z /gm, "").slice(-LOG_TAIL_CHARS);

/** GitHub's error answer in one line, as gh reads it (go-gh HandleHTTPError): its message, then each of `errors`. */
export async function githubError(response: Response) {
  const text = await response.text();
  let parts: string[] = [];
  try {
    const { message, errors = [] } = JSON.parse(text) as {
      message?: string;
      errors?: (string | { message?: string; resource?: string; field?: string; code?: string })[];
    };
    parts = [message, ...errors.map((e) => (typeof e === "string" ? e : e.message ?? `${e.resource}.${e.field} ${e.code}`))]
      .filter((part): part is string => !!part);
  } catch {
    // not JSON: the raw text below
  }
  return `GitHub answered ${response.status}: ${parts.join("; ") || text.slice(0, 500)}`;
}
