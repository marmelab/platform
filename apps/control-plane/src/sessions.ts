import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { User } from "./auth.ts";
import { config } from "./config.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { one, platform } from "./db.ts";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
// Same cost for unknown emails, so that login timing does not reveal which accounts exist
const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${"00".repeat(16)}$${"00".repeat(SCRYPT.keylen)}`;

export const SESSION_COOKIE = "platform_session";
export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = await scryptAsync(password, Buffer.from(salt, "hex"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

export async function setPassword(email: string, password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const result = await platform.query("update users set password_hash = $2 where email = $1", [
    email.toLowerCase(),
    await hashPassword(password),
  ]);
  if (result.rowCount !== 1) throw new Error(`unknown user ${email}`);
  await platform.query("delete from sessions where user_id = (select id from users where email = $1)", [
    email.toLowerCase(),
  ]);
}

/** Returns a new session token, or null if the credentials are wrong. */
export async function login(email: string, password: string): Promise<string | null> {
  const user = await one<{ id: string; password_hash: string | null }>(
    "select id, password_hash from users where email = $1 and active",
    [email.trim().toLowerCase()],
  );
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user?.password_hash || !ok) return null;
  const token = randomToken("sess");
  await platform.query(
    "insert into sessions (user_id, token_hash, expires_at) values ($1, $2, now() + make_interval(secs => $3))",
    [user.id, sha256(token), config.sessionTtlSeconds],
  );
  await platform.query("delete from sessions where expires_at < now()");
  return token;
}

export async function userForSession(token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const user = await one<User>(
    `select u.id, u.email, u.name, u.role from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now() and u.active`,
    [sha256(token)],
  );
  return user ?? null;
}

export async function logout(token: string | undefined) {
  if (token) await platform.query("delete from sessions where token_hash = $1", [sha256(token)]);
}
