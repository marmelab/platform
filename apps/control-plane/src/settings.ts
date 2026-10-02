// Platform settings: environment defaults (config.defaults), overridden by rows of the `settings` table
// (CLI set-setting / unset-setting). Read on every CI request and every MCP publishing call: no restart needed.
import { apiUrl, config } from "./config.ts";
import { many, platform } from "./db.ts";

export type DirectDeploy = "admins" | "everyone";

export interface Settings {
  /** Who may publish with a PAT (MCP): only admins (the audited exception), or every member of the app. */
  directDeploy: DirectDeploy;
  /** Allowed `job_workflow_ref` values (see ciWorkflowAllowed). Empty: the CI API refuses every token. */
  ciAllowedWorkflows: string[];
  oidcIssuer: string;
  /** Expected `aud` claim; defaults to the platform API URL. */
  oidcAudience: string;
  /** Defaults to `<issuer>/.well-known/jwks` (github.com and GHES). */
  oidcJwksUrl: string;
  /** TEST ONLY: inline JWKS (JSON) trusted instead of fetching oidcJwksUrl. Ignored without ALLOW_TEST_OIDC_JWKS=1. */
  oidcJwks: string | null;
}

/** Keys accepted by set-setting, with their environment variable. */
export const SETTING_KEYS = {
  direct_deploy: "DIRECT_DEPLOY",
  ci_allowed_workflows: "CI_ALLOWED_WORKFLOWS",
  oidc_issuer: "OIDC_ISSUER",
  oidc_audience: "OIDC_AUDIENCE",
  oidc_jwks_url: "OIDC_JWKS_URL",
  oidc_jwks: "(none, test only: requires ALLOW_TEST_OIDC_JWKS=1)",
} as const;
export type SettingKey = keyof typeof SETTING_KEYS;

export function validateSetting(key: string, value: string): asserts key is SettingKey {
  if (!(key in SETTING_KEYS)) throw new Error(`unknown setting ${key}: ${Object.keys(SETTING_KEYS).join(", ")}`);
  if (key === "direct_deploy" && !["admins", "everyone"].includes(value)) {
    throw new Error("direct_deploy must be admins or everyone");
  }
  if (key === "oidc_jwks") {
    if (!config.allowTestOidcJwks) {
      throw new Error("oidc_jwks is test only: it requires ALLOW_TEST_OIDC_JWKS=1 on the control plane (local installs)");
    }
    JSON.parse(value);
  }
}

export async function getSettings(): Promise<Settings> {
  const rows = new Map(
    (await many<{ key: string; value: string }>("select key, value from settings")).map((r) => [r.key, r.value]),
  );
  const d = config.defaults;
  const directDeploy = rows.get("direct_deploy") ?? d.directDeploy;
  if (directDeploy !== "admins" && directDeploy !== "everyone") {
    throw new Error(`invalid DIRECT_DEPLOY "${directDeploy}": admins or everyone`);
  }
  const issuer = (rows.get("oidc_issuer") ?? d.oidcIssuer).replace(/\/+$/, "");
  return {
    directDeploy,
    ciAllowedWorkflows: (rows.get("ci_allowed_workflows") ?? d.ciAllowedWorkflows)
      .split(",").map((s) => s.trim()).filter(Boolean),
    oidcIssuer: issuer,
    oidcAudience: rows.get("oidc_audience") ?? d.oidcAudience ?? apiUrl(),
    oidcJwksUrl: rows.get("oidc_jwks_url") ?? d.oidcJwksUrl ?? `${issuer}/.well-known/jwks`,
    // SEC-10: a test value left behind is ignored unless the environment explicitly allows it
    oidcJwks: config.allowTestOidcJwks ? rows.get("oidc_jwks") ?? null : null,
  };
}

export async function setSetting(key: string, value: string) {
  validateSetting(key, value);
  await platform.query(
    `insert into settings (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value],
  );
}

export async function unsetSetting(key: string) {
  await platform.query("delete from settings where key = $1", [key]);
}
