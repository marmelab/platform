import { SLUG_RE } from "@platform/shared";

export interface StudioUser {
  role: "admin" | "developer";
  apps: string[];
}

export type Access =
  | { allow: true; ref: string | null }
  | { allow: false; status: 400 | 403; reason: string };

type Methods = "GET" | "ANY";

interface Rule {
  pattern: RegExp;
  methods: Methods | null;
}

const deny = (status: 400 | 403, reason: string): Access => ({ allow: false, status, reason });
const rule = (pattern: RegExp, methods: Methods | null): Rule => ({ pattern, methods });

const SEG = "([^/]+)";

/**
 * Studio API routes reachable through the forward auth, first match wins. `methods: null` denies the path to
 * everyone, admins included. A capture group is the project ref, checked against the user's apps.
 * Anything not listed is denied.
 */
const API_RULES: Rule[] = [
  // fork features that bypass the platform (provisioning, accounts, licensing, HA) or ignore the project ref
  rule(/^\/api\/self-hosted(?:\/|$)/, null),
  rule(/^\/api\/platform\/projects\/import$/, null),
  rule(/^\/api\/platform\/license(?:\/|$)/, null),
  rule(/^\/api\/platform\/integrations(?:\/|$)/, null),
  rule(/^\/api\/(?:mcp|ai|edge-functions|connect|integrations|generate-attachment-url|content|check-cname)(?:\/|$)/, null),
  rule(new RegExp(`^/api/platform/projects/${SEG}/(?:failover|cluster-failover|replica|standby|migrate|pocketbase-migrate|db-password|analytics|billing)(?:/|$)`), null),
  rule(new RegExp(`^/api/v1/projects/${SEG}/functions(?:/|$)`), null),
  // project-scoped routes
  rule(new RegExp(`^/api/platform/(?:pg-meta|auth|storage|database)/${SEG}(?:/|$)`), "ANY"),
  rule(new RegExp(`^/api/platform/projects/${SEG}/(?:content|api|run-lints)(?:/|$)`), "ANY"),
  rule(new RegExp(`^/api/platform/projects/${SEG}(?:/|$)`), "GET"),
  rule(new RegExp(`^/api/platform/props/project/${SEG}(?:/|$)`), "GET"),
  rule(new RegExp(`^/api/v1/projects/${SEG}/(?:types/typescript|api-keys|database/migrations)$`), "GET"),
  // lists (filtered by Studio) and harmless self-hosted helpers
  rule(/^\/api\/platform\/projects$/, "GET"),
  rule(/^\/api\/platform\/(?:organizations|profile|notifications|props\/org)(?:\/|$)/, "GET"),
  rule(/^\/api\/(?:get-utc-time|get-ip-address|get-deployment-commit|cli-release-version|incident-status|incident-banner|status-override)$/, "GET"),
];

const PAGE_REF = /^(?:\/_next\/data\/[^/]+)?\/project\/([^/]+?)(?:\.json)?(?:\/|$)/;
const PAGE_DENY = /^\/(?:new|setup|sign-in|sign-up)(?:\/|$)/;
const RESERVED_REFS = new Set(["default", "_"]);

/** Rejects paths whose meaning could differ between this check and Studio's router. */
function unsafePath(path: string): boolean {
  if (/\\|\/\/|%2e|%2f|%5c|%00/i.test(path)) return true;
  if (/^\/(api|project|_next)(\/|$)/i.test(path) && !/^\/(api|project|_next)(\/|$)/.test(path)) return true;
  return path.split("/").some((s) => s === "." || s === "..");
}

function checkRef(ref: string, user: StudioUser): Access {
  if (!SLUG_RE.test(ref) || RESERVED_REFS.has(ref)) return deny(403, `invalid project ref "${ref}"`);
  if (user.role !== "admin" && !user.apps.includes(ref)) return deny(403, `no access to project "${ref}"`);
  return { allow: true, ref };
}

/** Decides whether `user` may send `method uri` to Studio. `uri` is the raw request URI (path and query). */
export function studioAccess(method: string, uri: string, user: StudioUser): Access {
  const path = uri.split("?")[0] ?? "";
  if (!path.startsWith("/") || unsafePath(path)) return deny(400, "malformed path");

  if (!path.startsWith("/api/")) {
    if (PAGE_DENY.test(path)) return deny(403, "not available on this platform");
    const page = PAGE_REF.exec(path);
    return page ? checkRef(page[1]!, user) : { allow: true, ref: null };
  }

  const verb = method.toUpperCase();
  for (const { pattern, methods } of API_RULES) {
    const match = pattern.exec(path);
    if (!match) continue;
    if (methods === null) return deny(403, "not available on this platform");
    if (methods === "GET" && verb !== "GET" && verb !== "HEAD") return deny(403, "read-only on this platform");
    return match[1] === undefined ? { allow: true, ref: null } : checkRef(match[1], user);
  }
  return deny(403, "not available on this platform");
}
