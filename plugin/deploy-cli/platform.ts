// The platform operations used by a deployment, behind one interface with two transports:
//   - "oidc":  GitHub Actions. A GitHub OIDC token (audience = platform API URL) on the CI API /ci/apps/<slug>/...
//   - "token": a personal access token (PLATFORM_TOKEN) on the MCP server, with the same operations as MCP tools.
// The deployment flow (run.ts) only sees this interface: CI and direct deployments share one code path.

export type Kind = "frontend" | "functions";
export type AcceptedLint = string | { name: string; object: string };

export interface Lint {
  name: string;
  level: string;
  object: string;
  detail?: string;
  [key: string]: unknown;
}

export interface MigrationFile {
  version: string;
  name?: string;
  sql: string;
}

export interface MigrationsResult {
  status: "dry_run" | "applied" | "rejected";
  applied: string[];
  would_apply?: string[];
  skipped: string[];
  blocking_lints?: Lint[];
  accepted_lints?: Lint[];
  lints: Lint[];
  release_id?: string | null;
}

export interface AppInfo {
  slug: string;
  name: string;
  status: string;
  url: string;
  supabase_url: string;
  anon_key: string;
  studio_url?: string;
  github_repo?: string | null;
  /** CI API only: "deploy" on the default branch, "check" otherwise. */
  mode?: "check" | "deploy";
  check_reasons?: string[];
}

export interface Release {
  id: string;
  admin_exception: boolean;
}

export interface Finalized {
  version?: number;
  status?: string;
  /** Functions deployments: the manifest, keyed by function name. */
  functions?: Record<string, unknown>;
  [key: string]: unknown;
}

/** An error answered by the platform; `details` holds the structured body (e.g. a rejected migrations batch). */
export class PlatformError extends Error {
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.details = details;
  }
}

export interface Platform {
  readonly auth: "oidc" | "token";
  getApp(): Promise<AppInfo>;
  migrations(migrations: MigrationFile[], options: { dryRun: boolean; acceptLints: AcceptedLint[] }): Promise<MigrationsResult>;
  /** Opens the release that groups the next publications. CI: one per run attempt, commit and actor from the token. */
  beginRelease(options: { commitSha?: string; reason?: string }): Promise<Release>;
  createDeployment(kind: Kind): Promise<{ deployment_id: string; upload_url: string }>;
  finalizeDeployment(deploymentId: string): Promise<Finalized>;
  finishRelease(status: "succeeded" | "failed", error?: string): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** fetch, retried on network errors only (no response: connection refused or reset, e.g. a proxy reload). */
export async function request(url: string, init?: RequestInit, attempts = 3): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (attempt >= attempts) throw new Error(`${init?.method ?? "GET"} ${url}: ${(error as Error).cause ?? error}`);
      await sleep(1000 * attempt);
    }
  }
}

/** "https://api.example.com/mcp" or "https://api.example.com/" -> "https://api.example.com". */
export const apiBase = (url: string) => url.replace(/\/+$/, "").replace(/\/mcp$/, "");

// ---------------------------------------------------------------------------------------------------------------
// GitHub OIDC

/** Fetches GitHub Actions OIDC tokens for an audience; reuses a token until one minute before it expires. */
export function githubOidc(audience: string, env: NodeJS.ProcessEnv = process.env) {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error("ACTIONS_ID_TOKEN_REQUEST_URL is not set: the workflow needs `permissions: id-token: write`");
  }
  let cached: { token: string; exp: number } | null = null;
  return async () => {
    if (cached && cached.exp - 60 > Date.now() / 1000) return cached.token;
    const url = new URL(requestUrl);
    url.searchParams.set("audience", audience);
    const response = await request(url.toString(), { headers: { authorization: `Bearer ${requestToken}` } });
    if (!response.ok) throw new Error(`GitHub OIDC token request failed: HTTP ${response.status} ${await response.text()}`);
    const { value } = await response.json() as { value?: string };
    if (!value) throw new Error("GitHub OIDC token request returned no token");
    const payload = JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString("utf8") || "{}");
    cached = { token: value, exp: typeof payload.exp === "number" ? payload.exp : 0 };
    return value;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// CI API (/ci/apps/<slug>/...)

export function ciPlatform(api: string, slug: string, token: () => Promise<string>): Platform {
  const call = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const response = await request(`${api}/ci/apps/${slug}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await token()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: text.slice(0, 500) };
    }
    if (!response.ok) {
      throw new PlatformError(`${method} /ci/apps/${slug}${path}: HTTP ${response.status}: ${json?.error ?? text}`, json);
    }
    return json as T;
  };
  return {
    auth: "oidc",
    getApp: () => call("GET", ""),
    migrations: (migrations, { dryRun, acceptLints }) =>
      call("POST", "/migrations", { migrations, dry_run: dryRun, accept_lints: acceptLints }),
    beginRelease: async () => {
      const release = await call<Release & { id: string }>("POST", "/release");
      return { id: release.id, admin_exception: release.admin_exception ?? false };
    },
    createDeployment: (kind) => call("POST", "/deployments", { kind }),
    finalizeDeployment: (id) => call("POST", `/deployments/${id}/finalize`),
    finishRelease: async (status, error) => {
      await call("POST", "/release/finish", { status, ...(error ? { error: error.slice(0, 2000) } : {}) });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// MCP (Streamable HTTP; the platform's server is stateless, so a bare tools/call is enough)

export function mcpPlatform(api: string, slug: string, pat: string): Platform {
  let releaseId: string | null = null;
  let nextId = 1;
  const tool = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const response = await request(`${api}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pat}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
    });
    let text = await response.text();
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      text = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop() ?? "";
    }
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      throw new PlatformError(`${name}: HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    if (message.error) throw new PlatformError(`${name}: ${message.error.message ?? JSON.stringify(message.error)}`);
    const content: string = message.result?.content?.[0]?.text ?? "";
    if (message.result?.isError) {
      // structured errors (a rejected migrations batch) are JSON, the others plain text
      let details: Record<string, unknown> = {};
      try {
        details = JSON.parse(content);
      } catch { /* plain message */ }
      throw new PlatformError(`${name}: ${typeof details.error === "string" ? details.error : content}`, details);
    }
    return JSON.parse(content) as T;
  };
  return {
    auth: "token",
    getApp: () => tool("get_app", { app: slug }),
    migrations: (migrations, { dryRun, acceptLints }) =>
      tool("apply_migrations", {
        app: slug,
        migrations,
        dry_run: dryRun,
        accept_lints: acceptLints,
        ...(releaseId && !dryRun ? { release_id: releaseId } : {}),
      }),
    beginRelease: async ({ commitSha, reason }) => {
      const begun = await tool<{ release_id: string; admin_exception: boolean }>("begin_release", {
        app: slug,
        ...(commitSha ? { commit_sha: commitSha } : {}),
        ...(reason ? { reason } : {}),
      });
      releaseId = begun.release_id;
      return { id: begun.release_id, admin_exception: begun.admin_exception };
    },
    createDeployment: (kind) => tool("create_deployment", { app: slug, kind, ...(releaseId ? { release_id: releaseId } : {}) }),
    finalizeDeployment: (id) => tool("finalize_deployment", { deployment_id: id }),
    finishRelease: async (status, error) => {
      if (!releaseId) return;
      await tool("finish_release", { release_id: releaseId, status, ...(error ? { error: error.slice(0, 2000) } : {}) });
    },
  };
}
