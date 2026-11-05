// The pure rules of the code relay of web sessions (github.ts), unit-tested in test/github.test.ts: the push stream
// that becomes the GraphQL request (each header frame translated by push-frame.ts), the paths a pull may read,
// GitHub's "behind" answer.
import { Transform } from "node:stream";
import { type CommitTarget, frameToJson, newPushFrameState } from "./push-frame.ts";

const MAX_HEADER_LINE_BYTES = 64 * 1024;
const IS_BASE64 = new Uint8Array(256);
for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=") IS_BASE64[char.charCodeAt(0)] = 1;

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
            if (state.readingContents) {
              let end = pos;
              while (end < chunk.length && chunk[end] !== 0x0a) {
                if (!IS_BASE64[chunk[end]!]) throw new Error("add: the contents must be base64");
                end++;
              }
              if (end > pos) output.push(chunk.subarray(pos, end));
              if (end < chunk.length) {
                output.push(`"}`);
                state.readingContents = false;
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
              output.push(frameToJson(text, state, target));
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
