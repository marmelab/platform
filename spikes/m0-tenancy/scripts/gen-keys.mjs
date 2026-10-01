// Prints env lines for a new app: JWT secret, legacy anon/service_role keys, DB passwords.
import { createHmac, randomBytes } from "node:crypto";

const b64url = (input) => Buffer.from(input).toString("base64url");

const sign = (payload, secret) => {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
};

const appId = process.argv[2];
const jwtSecret = randomBytes(32).toString("hex");
const iat = Math.floor(Date.now() / 1000);
const exp = iat + 10 * 365 * 24 * 3600;

const lines = {
  APP_ID: appId,
  JWT_SECRET: jwtSecret,
  ANON_KEY: sign({ iss: "supabase", ref: appId, role: "anon", iat, exp }, jwtSecret),
  SERVICE_ROLE_KEY: sign({ iss: "supabase", ref: appId, role: "service_role", iat, exp }, jwtSecret),
  AUTHENTICATOR_PASSWORD: randomBytes(16).toString("hex"),
  AUTH_ADMIN_PASSWORD: randomBytes(16).toString("hex"),
};

for (const [key, value] of Object.entries(lines)) console.log(`${key}=${value}`);
