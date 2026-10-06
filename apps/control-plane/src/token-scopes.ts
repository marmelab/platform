// What a token may reach (SEC-8), pure: unit-tested in test/oauth-policy.test.ts. The apps of a token (tokens.app_ids)
// are enforced by appForUser and appsForUser, its tools (tokens.scopes) by buildMcpServer.
import type { User } from "./auth.ts";

/** The MCP tools of each token scope: `deploy` is what platform-deploy calls (create_deploy_token). */
export const SCOPE_TOOLS: Record<string, string[]> = {
  deploy: ["whoami", "get_app", "apply_migrations", "begin_release", "create_deployment", "finalize_deployment", "finish_release"],
};

/** Tools allowed by a token's scopes; null (no scope) means all of them. An unknown scope allows nothing. */
export const scopeTools = (scopes: string[]) =>
  scopes.length === 0 ? null : [...new Set(scopes.flatMap((scope) => SCOPE_TOOLS[scope] ?? []))];

export const toolAllowed = (user: Pick<User, "token">, tool: string) => !user.token?.tools || user.token.tools.includes(tool);
