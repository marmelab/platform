import { type AppConfig, loadJsonFile, validateAppConfig, validateManifest } from "./config.ts";
import { extractToken, type JwtFailure, verifyHs256 } from "./jwt.ts";
import { isValidAppSlug, isValidFunctionName, parseFunctionName, parseVersion, resolveFunction } from "./resolve.ts";

declare const EdgeRuntime: {
  userWorkers: {
    create(options: Record<string, unknown>): Promise<{
      fetch(request: Request, options?: { signal?: AbortSignal }): Promise<Response>;
    }>;
  };
  getRuntimeMetrics(): Promise<unknown>;
  applySupabaseTag?(source: Request, target: Request): void;
};

const env = (name: string, fallback?: string) => {
  const value = Deno.env.get(name) ?? fallback;
  if (value === undefined) throw new Error(`missing env ${name}`);
  return value;
};

const FUNCTIONS_ROOT = env("PLATFORM_FUNCTIONS_ROOT", "/functions");
const APPS_CONFIG_DIR = env("PLATFORM_APPS_CONFIG_DIR", "/config/apps");
const GATEWAY_TOKEN = env("PLATFORM_GATEWAY_TOKEN");
const ADMIN_TOKEN = Deno.env.get("PLATFORM_ADMIN_TOKEN");
const DEFAULT_LIMITS = {
  memory_mb: Number(env("PLATFORM_DEFAULT_MEMORY_MB", "150")),
  cpu_soft_ms: Number(env("PLATFORM_DEFAULT_CPU_SOFT_MS", "1000")),
  cpu_hard_ms: Number(env("PLATFORM_DEFAULT_CPU_HARD_MS", "2000")),
  wall_clock_ms: Number(env("PLATFORM_DEFAULT_WALL_CLOCK_MS", "150000")),
};
const IDLE_TIMEOUT_MS = Number(env("PLATFORM_WORKER_IDLE_TIMEOUT_MS", "30000"));
const WARM_TIMEOUT_MS = Number(env("PLATFORM_WARM_TIMEOUT_MS", "45000"));

const APP_HEADER = "x-platform-app";
const GATEWAY_HEADER = "x-platform-gateway-token";

const encoder = new TextEncoder();

function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function json(status: number, code: string, message: string, headers: HeadersInit = {}) {
  return Response.json({ code, message, msg: message }, { status, headers });
}

function authError(code: JwtFailure) {
  return json(401, code, code === "UNAUTHORIZED_NO_AUTH_HEADER" ? "Missing authorization header" : "Invalid JWT", {
    "sb-error-code": code,
    "Access-Control-Expose-Headers": "sb-error-code",
  });
}

function log(level: "info" | "error", fields: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, source: "main", ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

function loadAppConfig(app: string) {
  return loadJsonFile(`${APPS_CONFIG_DIR}/${app}.json`, validateAppConfig(app));
}

function loadManifest(versionDir: string) {
  return loadJsonFile(`${versionDir}/functions.json`, validateManifest);
}

const servicePaths = new Map<string, string>();

async function servicePathFor(app: string, functionName: string, functionDir: string, configHash: string) {
  const key = `${functionDir}\0${configHash}`;
  let servicePath = servicePaths.get(key);
  if (!servicePath) {
    servicePath = await Deno.makeTempDir({ prefix: `${app}.${functionName}.` });
    servicePaths.set(key, servicePath);
  }
  return servicePath;
}

function forwardRequest(req: Request, pathname: string, search: string): Request {
  const host = req.headers.get("x-forwarded-host") ?? new URL(req.url).host;
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const headers = new Headers(req.headers);
  headers.delete(APP_HEADER);
  headers.delete(GATEWAY_HEADER);
  const forwarded = new Request(`${proto}://${host}${pathname}${search}`, {
    method: req.method,
    headers,
    body: req.body,
    signal: req.signal,
    // @ts-ignore duplex is required for streaming bodies
    duplex: "half",
  });
  EdgeRuntime.applySupabaseTag?.(req, forwarded);
  return forwarded;
}

async function createWorker(
  app: string,
  functionName: string,
  config: AppConfig,
  configHash: string,
  resolved: { versionDir: string; functionDir: string; entrypoint: string },
) {
  const limits = { ...DEFAULT_LIMITS, ...config.limits };
  const envVars = Object.entries({
    ...config.env,
    SUPABASE_FUNCTION_SLUG: functionName,
  });
  return await EdgeRuntime.userWorkers.create({
    servicePath: await servicePathFor(app, functionName, resolved.functionDir, configHash),
    maybeEntrypoint: `file://${resolved.entrypoint}`,
    memoryLimitMb: limits.memory_mb,
    workerTimeoutMs: limits.wall_clock_ms,
    cpuTimeSoftLimitMs: limits.cpu_soft_ms,
    cpuTimeHardLimitMs: limits.cpu_hard_ms,
    noModuleCache: false,
    envVars,
    forceCreate: false,
    customModuleRoot: resolved.versionDir,
    permissions: {
      allow_env: [],
      allow_net: [],
      allow_read: [resolved.versionDir, "/tmp"],
      allow_write: ["/tmp"],
      allow_import: [],
      allow_sys: ["hostname"],
    },
    context: {
      useReadSyncFileAPI: true,
      projectRef: app,
      supervisor: { requestAbsentTimeoutMs: IDLE_TIMEOUT_MS },
    },
    staticPatterns: [],
  });
}

function isDenoError(error: unknown, name: string): boolean {
  const ctor = (Deno.errors as unknown as Record<string, (new () => Error) | undefined>)[name];
  return !!ctor && error instanceof ctor;
}

function workerErrorResponse(error: unknown): Response {
  if (isDenoError(error, "InvalidWorkerCreation")) {
    return json(503, "BOOT_ERROR", "Worker failed to boot (please check logs)");
  }
  if (isDenoError(error, "WorkerRequestCancelled")) {
    return json(546, "WORKER_LIMIT", "Worker failed to respond due to a resource limit (please check logs)");
  }
  if (isDenoError(error, "InvalidWorkerResponse")) {
    return json(500, "WORKER_ERROR", "Function exited due to an error (please check logs)");
  }
  return json(500, "Internal Server Error", "Request failed due to an internal server error");
}

function isAdmin(req: Request) {
  const token = req.headers.get("x-platform-admin-token") ?? "";
  return !!ADMIN_TOKEN && constantTimeEqual(token, ADMIN_TOKEN);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * POST /_internal/warm {app, version, function}: boots the function on that version (not `current`)
 * with the app env, and sends it a CORS preflight (OPTIONS). Boot errors (bad imports, missing npm
 * packages, top-level exceptions) surface here, and `npm:`/`jsr:` dependencies land in DENO_DIR.
 * Internal only: requests relayed by Caddy carry the gateway token and are refused.
 */
async function warm(req: Request): Promise<Response> {
  if (req.headers.has(GATEWAY_HEADER)) return json(404, "NOT_FOUND", "Function not found");
  if (!isAdmin(req)) return json(403, "FORBIDDEN", "Forbidden");
  if (req.method !== "POST") return json(405, "METHOD_NOT_ALLOWED", "Use POST");
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const app = body?.app as string | null;
  const functionName = body?.function;
  const version = parseVersion(body?.version);
  if (!isValidAppSlug(app) || !isValidFunctionName(functionName) || !version) {
    return json(400, "INVALID_REQUEST", "Expected {app, version, function}");
  }
  const appConfig = await loadAppConfig(app);
  if (!appConfig) return json(404, "NOT_FOUND", `No config for app ${app}`);
  const resolved = await resolveFunction(FUNCTIONS_ROOT, app, functionName, version);
  if (!resolved) return json(404, "NOT_FOUND", `Function ${functionName} not found in ${version}`);

  const started = performance.now();
  try {
    const status = await withTimeout(
      (async () => {
        const worker = await createWorker(app, functionName, appConfig.value, appConfig.hash, resolved);
        const preflight = new Request(`http://localhost/${functionName}`, {
          method: "OPTIONS",
          headers: {
            origin: "http://localhost",
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization, content-type",
          },
        });
        EdgeRuntime.applySupabaseTag?.(req, preflight);
        const response = await worker.fetch(preflight);
        await response.body?.cancel();
        return response.status;
      })(),
      WARM_TIMEOUT_MS,
      "warm-up",
    );
    const ms = Math.round(performance.now() - started);
    log("info", { app, function: functionName, version, event: "warm", status, ms });
    return Response.json({ ok: true, app, function: functionName, version, status, ms });
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    const code = isDenoError(error, "InvalidWorkerCreation") ? "BOOT_ERROR" : "WARM_FAILED";
    log("error", { app, function: functionName, version, event: "warm", error: String(error), ms });
    return Response.json({ ok: false, app, function: functionName, version, code, error: String(error), ms }, {
      status: 422,
    });
  }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/_internal/health") return Response.json({ message: "ok" });

  if (url.pathname === "/_internal/metrics") {
    if (!isAdmin(req)) return json(403, "FORBIDDEN", "Forbidden");
    return Response.json(await EdgeRuntime.getRuntimeMetrics());
  }

  if (url.pathname === "/_internal/warm") return await warm(req);

  if (!constantTimeEqual(req.headers.get(GATEWAY_HEADER) ?? "", GATEWAY_TOKEN)) {
    return json(403, "FORBIDDEN", "Requests must go through the platform gateway");
  }

  const app = req.headers.get(APP_HEADER);
  if (!isValidAppSlug(app)) return json(400, "INVALID_APP", "Invalid or missing app");

  const functionName = parseFunctionName(url.pathname);
  if (!functionName) return json(404, "NOT_FOUND", "Function not found");

  const appConfig = await loadAppConfig(app);
  if (!appConfig) return json(404, "NOT_FOUND", "Function not found");

  const resolved = await resolveFunction(FUNCTIONS_ROOT, app, functionName);
  if (!resolved) return json(404, "NOT_FOUND", "Function not found");

  const manifest = await loadManifest(resolved.versionDir);
  const verifyJwt = manifest?.value.functions?.[functionName]?.verify_jwt ?? true;

  if (verifyJwt && req.method !== "OPTIONS") {
    const token = extractToken(req.headers);
    if (token.startsWith("UNAUTHORIZED_")) return authError(token as JwtFailure);
    const failure = await verifyHs256(token, appConfig.value.jwt_secret);
    if (failure) return authError(failure);
  }

  const started = performance.now();
  for (let attempt = 0;; attempt++) {
    try {
      const worker = await createWorker(app, functionName, appConfig.value, appConfig.hash, resolved);
      const response = await worker.fetch(forwardRequest(req, url.pathname, url.search), { signal: req.signal });
      log("info", {
        app,
        function: functionName,
        version: resolved.versionDir.split("/").at(-1),
        method: req.method,
        status: response.status,
        ms: Math.round(performance.now() - started),
      });
      return response;
    } catch (error) {
      if (attempt === 0 && req.body === null && isDenoError(error, "WorkerAlreadyRetired")) continue;
      log("error", { app, function: functionName, error: String(error) });
      return workerErrorResponse(error);
    }
  }
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (error) {
    log("error", { error: String(error) });
    return json(500, "Internal Server Error", "Request failed due to an internal server error");
  }
});
