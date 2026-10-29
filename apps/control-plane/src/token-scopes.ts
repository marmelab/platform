// What a token may reach (SEC-8), pure: unit-tested in test/oauth-policy.test.ts. The apps of a token (tokens.app_ids)
// are enforced by appForUser and appsForUser, its tools (tokens.scopes) by buildMcpServer, and what a preview token
// opens in the preview tunnel by frpDecision (previews.ts).
import { PREVIEW_PREFIX } from "@platform/shared";
import type { User } from "./auth.ts";

/** The MCP tools of each token scope: `deploy` is what platform-deploy calls (create_deploy_token). */
export const SCOPE_TOOLS: Record<string, string[]> = {
  deploy: ["whoami", "get_app", "apply_migrations", "begin_release", "create_deployment", "finalize_deployment", "finish_release"],
};

/** Tools allowed by a token's scopes; null (no scope) means all of them. An unknown scope allows nothing. */
export const scopeTools = (scopes: string[]) =>
  scopes.length === 0 ? null : [...new Set(scopes.flatMap((scope) => SCOPE_TOOLS[scope] ?? []))];

export const toolAllowed = (user: Pick<User, "token">, tool: string) => !user.token?.tools || user.token.tools.includes(tool);

export interface FrpRequest {
  op?: string;
  content?: {
    metas?: Record<string, string>;
    user?: { metas?: Record<string, string> };
    proxy_type?: string;
    subdomain?: string;
    custom_domains?: string[] | null;
  };
}

/** The token frpc sends (`metadatas.token`): in `metas` at login, in `user.metas` afterwards. */
export const frpToken = (request: FrpRequest) =>
  (request.op === "Login" ? request.content?.metas?.token : request.content?.user?.metas?.token) ?? "";

/**
 * The answer of the preview tunnel's frps plugin (previews.ts), given the slug of the client's preview token (null: no
 * valid token): a preview token logs in and opens an http proxy on preview-<its app>, nothing else.
 */
export function frpDecision(request: FrpRequest, slug: string | null): { reject: boolean; reject_reason?: string; unchange?: boolean } {
  const reject = (reason: string) => ({ reject: true, reject_reason: reason });
  if (!slug) return reject("invalid or expired preview token: ask Claude for a new one (create_preview_token)");
  if (request.op === "Login") return { reject: false, unchange: true };
  if (request.op !== "NewProxy") return reject(`operation ${String(request.op)} not allowed`);
  const proxy = request.content ?? {};
  if (proxy.proxy_type !== "http") return reject("only http proxies are allowed");
  if (proxy.custom_domains?.length) return reject("custom domains are not allowed");
  if (proxy.subdomain !== `${PREVIEW_PREFIX}${slug}`) return reject(`the subdomain must be ${PREVIEW_PREFIX}${slug}`);
  return { reject: false, unchange: true };
}
