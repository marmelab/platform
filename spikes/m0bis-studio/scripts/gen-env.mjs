// Prints the m0bis .env: Studio's own GoTrue (dashboard login), pg-meta crypto key, forward-auth mock secrets.
import { createHmac, randomBytes } from "node:crypto";

const b64url = (input) => Buffer.from(input).toString("base64url");
const sign = (payload, secret) => {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.${createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url")}`;
};

const hex = (n) => randomBytes(n).toString("hex");
const jwtSecret = hex(32);
const iat = Math.floor(Date.now() / 1000);
const exp = iat + 10 * 365 * 24 * 3600;

const lines = {
  PG_META_CRYPTO_KEY: hex(32),
  META_DEFAULT_PASSWORD: hex(16),
  STUDIO_JWT_SECRET: jwtSecret,
  STUDIO_SERVICE_KEY: sign({ iss: "supabase", ref: "studio", role: "service_role", iat, exp }, jwtSecret),
  STUDIO_AUTH_ADMIN_PASSWORD: hex(16),
  STUDIO_ADMIN_EMAIL: "admin@platform.localhost",
  STUDIO_ADMIN_PASSWORD: hex(12),
  FWD_AUTH_USER: "admin",
  FWD_AUTH_PASSWORD: hex(12),
  FWD_AUTH_SESSION_SECRET: hex(32),
};
for (const [k, v] of Object.entries(lines)) console.log(`${k}=${v}`);
