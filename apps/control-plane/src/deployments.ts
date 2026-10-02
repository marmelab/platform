import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { parse as parseToml } from "smol-toml";
import * as tar from "tar";
import { type DeploymentKind, FUNCTION_NAME_RE } from "@platform/shared";
import { type AppRow, appForUser, pathExists, UserError, writeEdgeConfig } from "./apps.ts";
import { audit } from "./audit.ts";
import type { User } from "./auth.ts";
import { apiUrl, appUrl, config } from "./config.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { many, one, platform } from "./db.ts";
import { switchCurrent, writeFileAtomic } from "./fsutil.ts";

interface DeploymentRow {
  id: string;
  app_id: string;
  kind: DeploymentKind | "migrations";
  version: number;
  status: string;
  created_at: Date;
  finalized_at: Date | null;
  manifest: unknown;
  error: string | null;
}

const MAX_ENTRIES = 20_000;
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["File", "OldFile", "ContiguousFile", "Directory"]);

const rootFor = (kind: DeploymentKind, slug: string) =>
  join(kind === "frontend" ? config.dataDir.sites : config.dataDir.functions, slug);
const uploadPath = (deploymentId: string) => join(config.dataDir.uploads, `${deploymentId}.tar.gz`);
const isMacMetadata = (path: string) => basename(path).startsWith("._") || path.split("/").includes("__MACOSX");

export async function createDeployment(user: User, app: AppRow, kind: DeploymentKind) {
  const deployment = await one<DeploymentRow>(
    `insert into deployments (app_id, kind, version, created_by)
     values ($1, $2, (select coalesce(max(version), 0) + 1 from deployments where app_id = $1 and kind = $2), $3)
     returning *`,
    [app.id, kind, user.id],
  );
  const token = randomToken("up");
  const expiresAt = new Date(Date.now() + config.uploadTtlSeconds * 1000);
  await platform.query("insert into uploads (deployment_id, token_hash, expires_at) values ($1, $2, $3)", [
    deployment!.id,
    sha256(token),
    expiresAt,
  ]);
  const uploadUrl = `${apiUrl()}/uploads/${token}`;
  const source = kind === "frontend" ? "-C dist ." : "supabase/functions supabase/config.toml";
  return {
    deployment_id: deployment!.id,
    version: deployment!.version,
    upload_url: uploadUrl,
    method: "PUT",
    expires_at: expiresAt.toISOString(),
    howto: `COPYFILE_DISABLE=1 tar -czf /tmp/bundle.tgz ${source} && ` +
      `curl -fsS -X PUT --data-binary @/tmp/bundle.tgz -H 'content-type: application/gzip' '${uploadUrl}'`,
  };
}

/** PUT /uploads/<token>: single use, short TTL, size-limited. */
export async function receiveUpload(token: string, body: WebReadableStream<Uint8Array> | null) {
  const upload = await one<{ id: string; deployment_id: string }>(
    `update uploads set used_at = now() where token_hash = $1 and used_at is null and expires_at > now()
     returning id, deployment_id`,
    [sha256(token)],
  );
  if (!upload) return { status: 404 as const, error: "unknown, expired or already used upload URL" };
  if (!body) return { status: 400 as const, error: "empty body" };
  await mkdir(config.dataDir.uploads, { recursive: true });
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > config.maxUploadBytes) callback(new Error("upload too large"));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(body), limit, createWriteStream(uploadPath(upload.deployment_id)));
  } catch (error) {
    await rm(uploadPath(upload.deployment_id), { force: true });
    await platform.query("update deployments set status = 'failed', error = $2 where id = $1", [
      upload.deployment_id,
      String(error),
    ]);
    return { status: 413 as const, error: String(error) };
  }
  await platform.query("update uploads set size_bytes = $2 where id = $1", [upload.id, size]);
  await platform.query("update deployments set status = 'uploaded' where id = $1 and status = 'pending'", [
    upload.deployment_id,
  ]);
  return { status: 200 as const, size };
}

/** Lists the archive and rejects links, devices, absolute paths and "..". */
async function inspectArchive(file: string) {
  const problems: string[] = [];
  const paths: string[] = [];
  let unpacked = 0;
  await tar.t({
    file,
    strict: true,
    onReadEntry: (entry) => {
      const path = entry.path;
      if (isMacMetadata(path)) return;
      if (!ALLOWED_TYPES.has(entry.type)) problems.push(`${path}: ${entry.type} entries are not allowed`);
      if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) problems.push(`${path}: absolute path`);
      if (path.split(/[\\/]+/).includes("..")) problems.push(`${path}: ".." is not allowed`);
      unpacked += entry.size ?? 0;
      paths.push(path.replace(/^\.\//, ""));
    },
  });
  if (paths.length > MAX_ENTRIES) problems.push(`too many entries (${paths.length})`);
  if (unpacked > MAX_UNPACKED_BYTES) problems.push("archive too large once unpacked");
  if (problems.length) throw new UserError(`archive rejected: ${problems.slice(0, 10).join("; ")}`);
  return paths;
}

async function extract(file: string, cwd: string) {
  await mkdir(cwd, { recursive: true });
  await tar.x({
    file,
    cwd,
    strict: true,
    preserveOwner: false,
    filter: (path, entry) => ALLOWED_TYPES.has((entry as tar.ReadEntry).type) && !isMacMetadata(path),
  });
}

const isDir = (path: string) => stat(path).then((s) => s.isDirectory(), () => false);

async function firstDir(base: string, candidates: string[]) {
  for (const candidate of candidates) if (await isDir(join(base, candidate))) return join(base, candidate);
  return null;
}

async function prepareFrontend(staging: string) {
  const root = (await pathExists(join(staging, "index.html"))) ? staging : await firstDir(staging, ["dist"]);
  if (!root || !(await pathExists(join(root, "index.html")))) {
    throw new UserError("frontend archive must contain index.html at its root (tar -C dist .)");
  }
  return { root, manifest: {} };
}

async function prepareFunctions(staging: string) {
  const root = (await firstDir(staging, ["supabase/functions", "functions"])) ?? staging;
  const tomlPath = [join(staging, "supabase/config.toml"), join(staging, "config.toml")];
  let toml: Record<string, unknown> = {};
  for (const path of tomlPath) {
    if (await pathExists(path)) {
      try {
        toml = parseToml(await readFile(path, "utf8")) as Record<string, unknown>;
      } catch (error) {
        throw new UserError(`invalid ${basename(path)}: ${String(error)}`);
      }
      break;
    }
  }
  const tomlFunctions = (toml.functions ?? {}) as Record<string, { verify_jwt?: boolean; enabled?: boolean }>;
  const functions: Record<string, { verify_jwt: boolean }> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    if (!FUNCTION_NAME_RE.test(entry.name)) throw new UserError(`invalid function name "${entry.name}"`);
    if (!(await pathExists(join(root, entry.name, "index.ts")))) {
      throw new UserError(`function "${entry.name}" has no index.ts`);
    }
    if (tomlFunctions[entry.name]?.enabled === false) continue;
    functions[entry.name] = { verify_jwt: tomlFunctions[entry.name]?.verify_jwt ?? true };
  }
  if (!Object.keys(functions).length) throw new UserError("no function found (expected supabase/functions/<name>/index.ts)");
  await writeFileAtomic(join(root, "functions.json"), JSON.stringify({ functions }, null, 2), 0o644);
  return { root, manifest: { functions } };
}

interface WarmResult {
  ok: boolean;
  function: string;
  status?: number;
  code?: string;
  error?: string;
  ms?: number;
}

/** Boots each function on the new version (not `current`) through the main worker, before the switch. */
async function warmFunctions(slug: string, version: number, functions: string[]) {
  const results = await Promise.all(functions.map(async (name): Promise<WarmResult> => {
    try {
      const response = await fetch(`http://${config.edgeUpstream}/_internal/warm`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-platform-admin-token": config.edgeAdminToken },
        body: JSON.stringify({ app: slug, version, function: name }),
        signal: AbortSignal.timeout(config.warmTimeoutMs),
      });
      const body = await response.json().catch(() => ({})) as Partial<WarmResult>;
      if (response.ok && body.ok) return { ok: true, function: name, status: body.status, ms: body.ms };
      return { ok: false, function: name, code: body.code ?? `HTTP_${response.status}`, error: body.error ?? "" };
    } catch (error) {
      return { ok: false, function: name, code: "WARM_UNREACHABLE", error: String(error) };
    }
  }));
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new UserError(
      `functions failed to start, version ${version} was not published (current version unchanged): ` +
        failed.map((r) => `${r.function}: ${r.code} ${r.error}`).join("; "),
    );
  }
  return Object.fromEntries(results.map((r) => [r.function, { boot_status: r.status, ms: r.ms }]));
}

async function loadDeployment(user: User, deploymentId: string) {
  const deployment = await one<DeploymentRow & { slug: string }>(
    "select d.*, a.slug from deployments d join apps a on a.id = d.app_id where d.id = $1",
    [deploymentId],
  );
  if (!deployment) throw new UserError("deployment not found");
  const app = await appForUser(user, deployment.slug).catch(() => {
    throw new UserError("deployment not found");
  });
  return { deployment, app };
}

async function markLive(appId: string, kind: string, deploymentId: string) {
  await platform.query(
    "update deployments set status = 'ready' where app_id = $1 and kind = $2 and status = 'live' and id <> $3",
    [appId, kind, deploymentId],
  );
  await platform.query("update deployments set status = 'live', finalized_at = coalesce(finalized_at, now()) where id = $1", [
    deploymentId,
  ]);
}

export async function finalizeDeployment(user: User, deploymentId: string) {
  const { deployment, app } = await loadDeployment(user, deploymentId);
  const kind = deployment.kind as DeploymentKind;
  if (deployment.status !== "uploaded") {
    throw new UserError(`deployment is "${deployment.status}": upload the archive first (create_deployment gives the URL)`);
  }
  // the warm-up boots the functions: they must not run while the app is stopped
  if (kind === "functions" && app.status === "stopped") {
    throw new UserError(`app "${app.slug}" is stopped: start_app before deploying functions`);
  }
  const archive = uploadPath(deployment.id);
  const appRoot = rootFor(kind, app.slug);
  const staging = join(appRoot, `.staging-${deployment.id}`);
  const versionDir = `v${deployment.version}`;
  try {
    const entries = await inspectArchive(archive);
    await extract(archive, staging);
    const { root, manifest } = kind === "frontend" ? await prepareFrontend(staging) : await prepareFunctions(staging);
    await rm(join(appRoot, versionDir), { recursive: true, force: true });
    await rename(root, join(appRoot, versionDir));
    let warm: Record<string, unknown> | undefined;
    if (kind === "functions") {
      await writeEdgeConfig(app);
      const names = Object.keys((manifest as { functions: Record<string, unknown> }).functions);
      try {
        warm = await warmFunctions(app.slug, deployment.version, names);
      } catch (error) {
        await rm(join(appRoot, versionDir), { recursive: true, force: true });
        throw error;
      }
    }
    await switchCurrent(appRoot, versionDir);
    await markLive(app.id, kind, deployment.id);
    await platform.query("update deployments set manifest = $2 where id = $1", [
      deployment.id,
      JSON.stringify({ ...manifest, files: entries.length }),
    ]);
    await audit(user.id, app.id, "finalize_deployment", { kind, version: deployment.version });
    return {
      deployment_id: deployment.id,
      kind,
      version: deployment.version,
      status: "live",
      url: kind === "frontend" ? appUrl(app.slug) : undefined,
      ...manifest,
      warm,
    };
  } catch (error) {
    await platform.query("update deployments set status = 'failed', error = $2 where id = $1", [
      deployment.id,
      String(error instanceof Error ? error.message : error),
    ]);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(archive, { force: true });
  }
}

export async function listDeployments(app: AppRow, kind?: string) {
  return many<DeploymentRow>(
    `select id, kind, version, status, created_at, finalized_at, manifest, error from deployments
      where app_id = $1 and ($2::text is null or kind = $2) order by created_at desc limit 50`,
    [app.id, kind ?? null],
  );
}

export async function rollback(user: User, app: AppRow, kind: DeploymentKind, version?: number) {
  const live = await one<DeploymentRow>(
    "select * from deployments where app_id = $1 and kind = $2 and status = 'live'",
    [app.id, kind],
  );
  const target = await one<DeploymentRow>(
    version
      ? "select * from deployments where app_id = $1 and kind = $2 and version = $3 and status in ('ready', 'live')"
      : "select * from deployments where app_id = $1 and kind = $2 and status = 'ready' and version < $3 order by version desc limit 1",
    [app.id, kind, version ?? live?.version ?? Number.MAX_SAFE_INTEGER],
  );
  if (!target) throw new UserError(version ? `version ${version} cannot be restored` : "no previous version to roll back to");
  const appRoot = rootFor(kind, app.slug);
  if (!(await isDir(join(appRoot, `v${target.version}`)))) throw new UserError(`version ${target.version} files are gone`);
  await switchCurrent(appRoot, `v${target.version}`);
  await markLive(app.id, kind, target.id);
  await audit(user.id, app.id, "rollback", { kind, from: live?.version ?? null, to: target.version });
  return { kind, from: live?.version ?? null, to: target.version };
}
