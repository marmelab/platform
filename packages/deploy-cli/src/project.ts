// The app repository: .platform.json, migrations, functions, frontend build and bundles.
// Same conventions as the `deploy` skill's scripts (plugin/skills/deploy/scripts).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcceptedLint, Kind, Lint, MigrationFile } from "./platform.ts";

export interface PlatformConfig {
  app: string;
  acceptedLints: AcceptedLint[];
}

const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

/** `.platform.json`: `{ "app": "<slug>", "acceptedLints": ["lint", { "name": "lint", "object": "public.t" }] }`. */
export function readConfig(dir: string): PlatformConfig {
  const file = join(dir, ".platform.json");
  if (!existsSync(file)) throw new Error(`${file} not found: it names the platform app ({ "app": "<slug>" })`);
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: invalid JSON (${(error as Error).message})`);
  }
  if (typeof raw?.app !== "string" || !SLUG_RE.test(raw.app)) throw new Error(`${file}: "app" must be an app slug`);
  const accepted = raw.acceptedLints ?? [];
  const valid = (a: any) =>
    (typeof a === "string" && a.length > 0) ||
    (typeof a?.name === "string" && a.name.length > 0 && typeof a?.object === "string" && a.object.length > 0);
  if (!Array.isArray(accepted) || !accepted.every(valid)) {
    throw new Error(`${file}: "acceptedLints" must be an array of lint names or { "name", "object" } objects`);
  }
  return { app: raw.app, acceptedLints: accepted };
}

/** Same rule as the platform: a lint name accepts it on every object, {name, object} on that object only. */
export const isAccepted = (lint: Lint, accepted: AcceptedLint[]) =>
  accepted.some((a) => typeof a === "string" ? a === lint.name : a.name === lint.name && a.object === lint.object);

/** supabase/migrations/<version>_<name>.sql, sorted. Any other .sql file name is an error. */
export function readMigrations(dir: string): MigrationFile[] {
  const migrationsDir = join(dir, "supabase", "migrations");
  if (!existsSync(migrationsDir)) return [];
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const invalid = files.filter((f) => !/^\d+_.+\.sql$/.test(f));
  if (invalid.length) {
    throw new Error(`migration files must be named <version>_<name>.sql with a numeric version: ${invalid.join(", ")}`);
  }
  return files.map((file) => {
    const [, version, name] = /^(\d+)_(.+)\.sql$/.exec(file)!;
    return { version: version!, name: name!, sql: readFileSync(join(migrationsDir, file), "utf8") };
  });
}

/** supabase/functions/<name>/index.ts (directories starting with _ or ., like _shared, are not functions). */
export function functionNames(dir: string): string[] {
  const functionsDir = join(dir, "supabase", "functions");
  if (!existsSync(functionsDir)) return [];
  return readdirSync(functionsDir)
    .filter((name) => !/^[_.]/.test(name) && statSync(join(functionsDir, name)).isDirectory())
    .filter((name) => existsSync(join(functionsDir, name, "index.ts")))
    .sort();
}

/** A Vite SPA: package.json with a build script. */
export function hasFrontend(dir: string): boolean {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return false;
  return typeof JSON.parse(readFileSync(file, "utf8"))?.scripts?.build === "string";
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  // build output goes to stderr: stdout stays for the CLI's own report
  const result = spawnSync(command, args, { cwd, env, stdio: ["ignore", process.stderr, process.stderr] });
  if (result.error) throw new Error(`${command} ${args.join(" ")}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

/** Installs dependencies when node_modules is missing, then `npm run build` with the app's public variables. */
export function buildFrontend(dir: string, vars: { supabaseUrl: string; anonKey: string }) {
  if (!existsSync(join(dir, "node_modules"))) {
    const lock = existsSync(join(dir, "package-lock.json"));
    run("npm", [lock ? "ci" : "install", "--no-audit", "--no-fund"], dir);
  }
  run("npm", ["run", "build"], dir, {
    ...process.env,
    VITE_SUPABASE_URL: vars.supabaseUrl,
    VITE_SUPABASE_ANON_KEY: vars.anonKey,
  });
  const index = join(dir, "dist", "index.html");
  if (!existsSync(index)) throw new Error("the build did not produce dist/index.html");
  return readFileSync(index, "utf8");
}

/** tar.gz of the content of dist/ (frontend), or supabase/functions + supabase/config.toml (functions). */
export function pack(dir: string, kind: Kind): Buffer {
  const tmp = mkdtempSync(join(tmpdir(), "platform-deploy-"));
  const out = join(tmp, `${kind}.tar.gz`);
  try {
    const env = { ...process.env, COPYFILE_DISABLE: "1" };
    if (kind === "frontend") {
      run("tar", ["-czf", out, "-C", join(dir, "dist"), "."], dir, env);
    } else {
      const paths = ["supabase/functions"];
      if (existsSync(join(dir, "supabase", "config.toml"))) paths.push("supabase/config.toml");
      run("tar", ["-czf", out, "--exclude", "node_modules", "--exclude", ".env", "--exclude", ".env.*", ...paths], dir, env);
    }
    return readFileSync(out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** HEAD commit and whether the working tree has changes; null outside a git repository. */
export function gitState(dir: string): { sha: string; dirty: boolean } | null {
  const git = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  const head = git(["rev-parse", "HEAD"]);
  if (head.status !== 0) return null;
  const status = git(["status", "--porcelain"]);
  return { sha: head.stdout.trim(), dirty: status.status === 0 && status.stdout.trim() !== "" };
}
