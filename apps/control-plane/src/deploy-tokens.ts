// Deploy tokens (create_deploy_token): a builder signed in through Claude Code (OAuth) has no PAT to give to
// platform-deploy, a separate process that cannot read Claude Code's keychain. The deploy skill asks for one of these
// instead: valid 15 minutes, restricted to one app (app_ids) and to the tools platform-deploy calls (scope "deploy"),
// revoked with the credential that minted it (parent_id). A first step towards per-token scopes (SEC-8).
// Any member of the app gets one: `platform-deploy check` (dry run) is open to every member, and the publishing tools
// apply DIRECT_DEPLOY to the token as to any credential (direct_deploy tells which case applies).
import { type AppRow, UserError } from "./apps.ts";
import { audit } from "./audit.ts";
import type { User } from "./auth.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { one } from "./db.ts";
import { getSettings } from "./settings.ts";

export const DEPLOY_TOKEN_MINUTES = 15;

export async function createDeployToken(user: User, app: AppRow) {
  if (user.token?.kind === "deploy") throw new UserError("a deploy token cannot create another one");
  const { directDeploy } = await getSettings();
  const direct = user.role === "admin" || directDeploy === "everyone";
  const value = randomToken("plat_dep");
  const row = await one<{ id: string; expires_at: Date }>(
    `insert into tokens (user_id, name, hash, kind, scopes, app_ids, parent_id, expires_at)
     values ($1, $2, $3, 'deploy', '{deploy}', array[$4::uuid], $5, now() + make_interval(mins => $6))
     returning id, expires_at`,
    [user.id, `deploy ${app.slug}`, sha256(value), app.id, user.token?.id ?? null, DEPLOY_TOKEN_MINUTES],
  );
  await audit(user.id, app.id, "create_deploy_token", {
    token_id: row!.id,
    via: user.token?.kind ?? null,
    direct_deploy: direct,
    expires_at: row!.expires_at.toISOString(),
  });
  return { token: value, app: app.slug, expires_at: row!.expires_at.toISOString(), direct_deploy: direct };
}
