// The check and deploy flows. One code path for CI (OIDC) and direct (PAT) deployments: only the Platform
// transport differs (platform.ts).
import { type AppInfo, type Kind, type Lint, type MigrationsResult, type Platform, PlatformError, request } from "./platform.ts";
import { buildFrontend, functionNames, gitState, hasFrontend, isAccepted, pack, type PlatformConfig, readMigrations } from "./project.ts";

export type Mode = "check" | "deploy";
export type StepStatus = "ok" | "skipped" | "failed";

export interface Step {
  name: string;
  status: StepStatus;
  detail: string;
}

export interface Report {
  mode: Mode;
  auth: Platform["auth"];
  config: PlatformConfig;
  app: AppInfo | null;
  commit: { sha: string; dirty: boolean } | null;
  release: { id: string; admin_exception: boolean } | null;
  steps: Step[];
  /** New ERROR lints not in acceptedLints: they block the deployment. */
  blockingLints: Lint[];
  /** New ERROR lints accepted by `.platform.json`. */
  acceptedLints: Lint[];
  /** WARN and INFO lints, and ERRORs that already existed. */
  otherLints: Lint[];
  ok: boolean;
  error: string | null;
}

export interface Options {
  mode: Mode;
  dir: string;
  config: PlatformConfig;
  platform: Platform;
  /** Direct deployments: why it is deployed outside CI (recorded on the release). */
  reason?: string;
  log?: (line: string) => void;
}

class Stop extends Error {}

export async function run(options: Options): Promise<Report> {
  const { mode, dir, config, platform } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const report: Report = {
    mode,
    auth: platform.auth,
    config,
    app: null,
    commit: platform.auth === "token" ? gitState(dir) : null,
    release: null,
    steps: [],
    blockingLints: [],
    acceptedLints: [],
    otherLints: [],
    ok: false,
    error: null,
  };
  const step = (name: string, status: StepStatus, detail: string) => {
    report.steps.push({ name, status, detail });
    log(`${status === "ok" ? "ok  " : status === "skipped" ? "skip" : "FAIL"} ${name}: ${detail}`);
  };
  const fail = (name: string, detail: string): never => {
    step(name, "failed", detail);
    throw new Stop(detail);
  };
  /** Runs one step; a thrown error fails it and stops the run. */
  const attempt = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Stop) throw error;
      return fail(name, (error as Error).message);
    }
  };
  const recordLints = (result: MigrationsResult) => {
    const blocking = result.blocking_lints ?? [];
    report.blockingLints = blocking.filter((l) => !isAccepted(l, config.acceptedLints));
    report.acceptedLints = [
      ...(result.accepted_lints ?? []),
      ...blocking.filter((l) => isAccepted(l, config.acceptedLints)),
    ];
    const known = new Set([...blocking, ...(result.accepted_lints ?? [])].map((l) => `${l.name} ${l.object}`));
    report.otherLints = (result.lints ?? []).filter((l) => !known.has(`${l.name} ${l.object}`));
  };

  let releaseOpen = false;
  try {
    // 1. the app, and its public variables for the build
    const app = await attempt("app", () => platform.getApp());
    report.app = app;
    if (platform.auth === "oidc" && app.mode) {
      const reasons = app.check_reasons?.length ? ` (${app.check_reasons.join("; ")})` : "";
      if (mode === "deploy" && app.mode !== "deploy") fail("app", `this run can only check, not deploy${reasons}`);
      step("app", "ok", `${app.slug} (${app.status}), ${app.mode} token${reasons}`);
    } else {
      step("app", "ok", `${app.slug} (${app.status})`);
    }

    const migrations = await attempt("migrations", () => readMigrations(dir));
    const functions = functionNames(dir);
    const frontend = hasFrontend(dir);

    // 2. migrations dry run (check), with the platform's security linter; always rolled back
    if (mode === "check") {
      if (!migrations.length) {
        step("migrations", "skipped", "no supabase/migrations/*.sql");
      } else {
        const result = await attempt("migrations", () =>
          platform.migrations(migrations, { dryRun: true, acceptLints: config.acceptedLints }));
        recordLints(result);
        const pending = result.would_apply ?? [];
        const summary = `${pending.length} to apply${pending.length ? ` (${pending.join(", ")})` : ""}, ` +
          `${result.skipped.length} already applied`;
        if (report.blockingLints.length) {
          step("migrations", "failed", `${summary}; ${report.blockingLints.length} new ERROR lint(s) not in acceptedLints`);
        } else {
          step("migrations", "ok", `${summary} (dry run)`);
        }
      }
      step("functions", functions.length ? "ok" : "skipped",
        functions.length ? `${functions.join(", ")} (not deployed in check mode)` : "no supabase/functions/<name>/index.ts");
    }

    // 3. build, before anything is published: a broken build publishes nothing
    let builtIndex: string | null = null;
    if (frontend) {
      builtIndex = await attempt("build", () =>
        buildFrontend(dir, { supabaseUrl: app.supabase_url, anonKey: app.anon_key }));
      step("build", "ok", "npm run build with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY");
    } else {
      step("build", "skipped", "no package.json with a build script");
    }

    if (mode === "check") {
      report.ok = report.steps.every((s) => s.status !== "failed");
      return report;
    }

    // 4. release: groups the publications below
    const release = await attempt("release", () =>
      platform.beginRelease({ commitSha: report.commit?.sha, reason: options.reason }));
    releaseOpen = true;
    report.release = release;
    step("release", "ok", `${release.id}${release.admin_exception ? " (admin exception)" : ""}`);

    // 5. migrations: the platform rejects any new ERROR lint not accepted by .platform.json
    if (!migrations.length) {
      step("migrations", "skipped", "no supabase/migrations/*.sql");
    } else {
      let result: MigrationsResult;
      try {
        result = await platform.migrations(migrations, { dryRun: false, acceptLints: config.acceptedLints });
      } catch (error) {
        if (error instanceof PlatformError && error.details.status === "rejected") {
          recordLints(error.details as unknown as MigrationsResult);
          fail("migrations", `rejected, nothing applied: ${report.blockingLints.length} new ERROR lint(s) ` +
            "not in acceptedLints");
        }
        throw error;
      }
      recordLints(result);
      step("migrations", "ok", `applied ${result.applied.length}${result.applied.length ? ` (${result.applied.join(", ")})` : ""}, ` +
        `${result.skipped.length} already applied`);
    }

    const publish = async (kind: Kind) => {
      const { deployment_id, upload_url } = await platform.createDeployment(kind);
      const archive = pack(dir, kind);
      const uploaded = await request(upload_url, {
        method: "PUT",
        headers: { "content-type": "application/gzip" },
        body: new Uint8Array(archive),
      }, 1);
      if (!uploaded.ok) throw new Error(`upload failed: HTTP ${uploaded.status} ${await uploaded.text()}`);
      return platform.finalizeDeployment(deployment_id);
    };

    // 6. functions: booted on the new version before the switch
    let deployedFunctions: string[] = [];
    if (!functions.length) {
      step("functions", "skipped", "no supabase/functions/<name>/index.ts");
    } else {
      const done = await attempt("functions", () => publish("functions"));
      deployedFunctions = Object.keys(done.functions ?? {});
      step("functions", "ok", `version ${done.version}: ${deployedFunctions.join(", ") || functions.join(", ")}`);
    }

    // 7. frontend
    if (frontend) {
      const done = await attempt("frontend", () => publish("frontend"));
      step("frontend", "ok", `version ${done.version}`);
    } else {
      step("frontend", "skipped", "no frontend");
    }

    // 8. smoke test through the public routes
    await attempt("smoke test", async () => {
      const checks: string[] = [];
      if (builtIndex !== null) {
        const response = await request(app.url);
        const body = await response.text();
        if (response.status !== 200) throw new Error(`GET ${app.url}: HTTP ${response.status}`);
        if (body !== builtIndex) throw new Error(`GET ${app.url} does not serve the new dist/index.html`);
        checks.push(`GET / 200`);
      }
      for (const name of deployedFunctions.length ? deployedFunctions : functions) {
        // a preflight skips the JWT check: it reaches the function itself
        const url = `${app.url.replace(/\/+$/, "")}/functions/v1/${name}`;
        const response = await request(url, { method: "OPTIONS" });
        const body = await response.text();
        if (response.status >= 500 || /BOOT_ERROR|WORKER_ERROR/.test(body)) {
          throw new Error(`OPTIONS /functions/v1/${name}: HTTP ${response.status} ${body.slice(0, 200)}`);
        }
        checks.push(`${name} ${response.status}`);
      }
      step("smoke test", checks.length ? "ok" : "skipped", checks.join(", ") || "nothing to check");
    });

    await attempt("release", () => platform.finishRelease("succeeded"));
    releaseOpen = false;
    report.ok = true;
    return report;
  } catch (error) {
    report.error = (error as Error).message;
    if (!(error instanceof Stop)) step("error", "failed", report.error);
    if (releaseOpen) {
      await platform.finishRelease("failed", report.error).catch((finishError) =>
        log(`could not mark the release as failed: ${(finishError as Error).message}`));
    }
    return report;
  }
}
