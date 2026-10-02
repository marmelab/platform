import { createHmac, randomUUID } from "node:crypto";

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** HS256 JWT (legacy Supabase keys). */
export function jwt(payload: Record<string, unknown>, secret: string, ttlSeconds = 3600) {
  const iat = Math.floor(Date.now() / 1000);
  const body = { iat, exp: iat + ttlSeconds, ...payload };
  const unsigned = `${b64(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64(JSON.stringify(body))}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

export const keys = (ref: string, secret: string) => ({
  anon: jwt({ iss: "supabase", ref, role: "anon" }, secret, 10 * 365 * 86400),
  service: jwt({ iss: "supabase", ref, role: "service_role" }, secret, 10 * 365 * 86400),
});

/** An app user's access token, as GoTrue would issue it. */
export const userToken = (secret: string, sub = randomUUID()) => ({
  sub,
  token: jwt({ sub, role: "authenticated", aud: "authenticated", email: `${sub.slice(0, 8)}@example.com` }, secret),
});
