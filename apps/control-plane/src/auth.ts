import { one, platform } from "./db.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { verifyAccessToken } from "./platform-auth.ts";
import { scopeTools } from "./token-scopes.ts";

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "developer";
  /** The credential of an MCP request (PAT, Claude Code connection or deploy token); absent for browser sessions. */
  token?: TokenAccess;
}

/** What a credential may reach (SEC-8): null means everything its user may. */
export interface TokenAccess {
  id: string;
  kind: "pat" | "oauth" | "deploy";
  appIds: string[] | null;
  tools: string[] | null;
}

/**
 * Who performs a publication: a platform user (PAT), or a CI run (GitHub OIDC) which has no platform account
 * (id null, email "github:<actor>").
 */
export interface Actor {
  id: string | null;
  email: string;
}

interface TokenRow extends User {
  token_id: string;
  kind: TokenAccess["kind"];
  scopes: string[];
  app_ids: string[] | null;
}

const TOKEN_USER = `select u.id, u.email, u.name, u.role, t.id as token_id, t.kind, t.scopes, t.app_ids
   from tokens t join users u on u.id = t.user_id`;

/**
 * The user behind an MCP bearer credential: a PAT or deploy token (hash lookup), or an OAuth access token of the
 * platform's GoTrue (a JWT), whose connection row and GoTrue session must both still exist. Every kind requires an
 * active account, an unrevoked and unexpired row, and for a deploy token an unrevoked parent.
 */
export async function authenticate(authorization: string | undefined): Promise<User | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match) return null;
  const value = match[1]!;
  const claims = value.split(".").length === 3 ? await verifyAccessToken(value) : null;
  const row = claims
    ? await one<TokenRow>(
      `${TOKEN_USER} join auth.sessions s on s.id = t.oauth_session_id
        where t.kind = 'oauth' and t.oauth_session_id = $1 and t.user_id = $2 and t.revoked_at is null and u.active
          and (s.not_after is null or s.not_after > now())`,
      [claims.session_id, claims.sub],
    )
    : await one<TokenRow>(
      `${TOKEN_USER}
        where t.hash = $1 and t.kind <> 'oauth' and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
          and u.active and (t.parent_id is null or exists (
            select 1 from tokens p where p.id = t.parent_id and p.revoked_at is null))`,
      [sha256(value)],
    );
  if (!row) return null;
  await platform.query("update tokens set last_used_at = now() where id = $1", [row.token_id]);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    token: { id: row.token_id, kind: row.kind, appIds: row.app_ids, tools: scopeTools(row.scopes) },
  };
}

export async function upsertUser(email: string, role: User["role"], name?: string): Promise<User> {
  const user = await one<User>(
    `insert into users (email, name, role) values ($1, $2, $3)
     on conflict (email) do update set role = excluded.role, name = coalesce(excluded.name, users.name)
     returning id, email, name, role`,
    [email.toLowerCase(), name ?? null, role],
  );
  return user!;
}

export async function createToken(userId: string, name: string): Promise<string> {
  const token = randomToken("plat");
  await platform.query("insert into tokens (user_id, name, hash) values ($1, $2, $3)", [userId, name, sha256(token)]);
  return token;
}
