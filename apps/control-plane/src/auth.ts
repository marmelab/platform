import { one, platform } from "./db.ts";
import { randomToken, sha256 } from "./crypto.ts";

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "developer";
}

/**
 * Who performs a publication: a platform user (PAT), or a CI run (GitHub OIDC) which has no platform account
 * (id null, email "github:<actor>").
 */
export interface Actor {
  id: string | null;
  email: string;
}

export async function authenticate(authorization: string | undefined): Promise<User | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match) return null;
  const user = await one<User & { token_id: string }>(
    `select u.id, u.email, u.name, u.role, t.id as token_id
       from tokens t join users u on u.id = t.user_id
      where t.hash = $1 and t.revoked_at is null and (t.expires_at is null or t.expires_at > now()) and u.active`,
    [sha256(match[1])],
  );
  if (!user) return null;
  await platform.query("update tokens set last_used_at = now() where id = $1", [user.token_id]);
  return { id: user.id, email: user.email, name: user.name, role: user.role };
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
