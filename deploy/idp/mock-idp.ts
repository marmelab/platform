// Mock OpenID Connect provider of the local stack and the e2e suites (compose service `idp`, profile sso-test). NOT for
// production: it signs in whoever types an email. It plays the company IdP of the company SSO (M6 part 2):
// - discovery, JWKS (RS256), authorization endpoint (an email form, or `login_email` in the query for scripts),
//   token endpoint (authorization code, client_secret_basic or _post, PKCE S256), userinfo;
// - two listeners: plain HTTP on IDP_HTTP_PORT (the plat network, and published on the host loopback for the browser's
//   authorization requests), and HTTPS on IDP_HTTPS_PORT for the apps' GoTrue, which only accepts an https issuer on a
//   non-private address: the compose file gives this container an address in 198.51.100.0/24 (TEST-NET-2) on the
//   plat-sso-test network, with the alias of the issuer's host. Its CA is generated at the first start (openssl) and
//   copied to IDP_CA_DIR (a volume the control plane mounts into the apps' GoTrue).
// Test knobs on /authorize (query): login_email, login_sub, login_name, login_email_verified=false, and tamper=nonce|
// aud|iss|signature|expired to get an ID token that a relying party must refuse.
import { createHash, createPrivateKey, createPublicKey, createSign, generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";

const env = (name: string, fallback: string) => process.env[name] || fallback;
const ISSUER = env("IDP_ISSUER", "https://idp.sso.test:8443");
const PUBLIC_URL = env("IDP_PUBLIC_URL", "http://localhost:8090");
const INTERNAL_URL = env("IDP_INTERNAL_URL", "http://idp:8090");
const HTTP_PORT = Number(env("IDP_HTTP_PORT", "8090"));
const HTTPS_PORT = Number(env("IDP_HTTPS_PORT", "8443"));
const KEYS_DIR = env("IDP_KEYS_DIR", "/keys");
const CA_DIR = env("IDP_CA_DIR", "/ca");
/** client_id:secret pairs, comma-separated. */
const CLIENTS = new Map(env("IDP_CLIENTS", "platform:platform-secret").split(",").map((pair) => {
  const at = pair.indexOf(":");
  return [pair.slice(0, at).trim(), pair.slice(at + 1).trim()] as const;
}));

// --- keys: TLS (CA + server certificate for the issuer's host) and the ID token signing key, kept in KEYS_DIR ---

mkdirSync(KEYS_DIR, { recursive: true });
const issuerHost = new URL(ISSUER).hostname;
const file = (name: string) => join(KEYS_DIR, name);
if (!existsSync(file("server.pem"))) {
  const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "pipe" });
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650", "-subj", "/CN=Platform test IdP CA",
    "-keyout", file("ca.key"), "-out", file("ca.pem"));
  openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${issuerHost}`, "-keyout", file("server.key"), "-out", file("server.csr"));
  writeFileSync(file("server.ext"), `subjectAltName=DNS:${issuerHost}\nextendedKeyUsage=serverAuth\n`);
  openssl("x509", "-req", "-in", file("server.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca.key"), "-CAcreateserial",
    "-days", "3650", "-extfile", file("server.ext"), "-out", file("server.pem"));
}
mkdirSync(CA_DIR, { recursive: true });
copyFileSync(file("ca.pem"), join(CA_DIR, "platform-test-idp-ca.pem"));

function signingKey(name: string): KeyObject {
  if (!existsSync(file(name))) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(file(name), privateKey.export({ type: "pkcs8", format: "pem" }));
  }
  return createPrivateKey(readFileSync(file(name)));
}
const PRIVATE_KEY = signingKey("signing.pem");
const OTHER_KEY = signingKey("other.pem"); // tamper=signature: a key that is not in the JWKS
const jwk = { ...createPublicKey(PRIVATE_KEY).export({ format: "jwk" }), kid: "mock-1", alg: "RS256", use: "sig" };

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function signJwt(payload: Record<string, unknown>, key = PRIVATE_KEY) {
  const head = `${b64({ alg: "RS256", typ: "JWT", kid: jwk.kid })}.${b64(payload)}`;
  return `${head}.${createSign("RSA-SHA256").update(head).sign(key).toString("base64url")}`;
}

// --- protocol ---

const discovery = {
  issuer: ISSUER,
  authorization_endpoint: `${PUBLIC_URL}/authorize`,
  token_endpoint: `${INTERNAL_URL}/token`,
  userinfo_endpoint: `${INTERNAL_URL}/userinfo`,
  jwks_uri: `${INTERNAL_URL}/jwks`,
  response_types_supported: ["code"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
  scopes_supported: ["openid", "email", "profile"],
  token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
  code_challenge_methods_supported: ["S256"],
  claims_supported: ["sub", "email", "email_verified", "name"],
};

interface Grant {
  clientId: string;
  redirectUri: string;
  nonce: string | null;
  challenge: string | null;
  claims: Record<string, unknown>;
  tamper: string | null;
  expires: number;
}
const codes = new Map<string, Grant>();
const accessTokens = new Map<string, Record<string, unknown>>();

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json", "cache-control": "no-store", ...headers });
  res.end(text);
}

function authorize(url: URL, res: ServerResponse) {
  const q = url.searchParams;
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  if (!CLIENTS.has(clientId)) return send(res, 400, `<p>Unknown client_id ${escape(clientId)}</p>`);
  if (!/^https?:\/\//.test(redirectUri)) return send(res, 400, "<p>Missing redirect_uri</p>");
  if (q.get("response_type") !== "code") return send(res, 400, "<p>Only response_type=code</p>");
  const email = q.get("login_email");
  if (!email) {
    const hidden = [...q].map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`).join("");
    return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Mock IdP</title>
<body style="font:15px system-ui;max-width:24rem;margin:4rem auto"><h1>Mock company IdP</h1>
<p>Local test identity provider: signs in any email (never in production).</p>
<form method="get" action="/authorize">${hidden}
<label>Email <input name="login_email" type="email" required autofocus style="width:100%"></label>
<label><input type="checkbox" name="login_email_verified" value="false"> email not verified</label>
<p><button type="submit">Sign in</button></p></form>`);
  }
  const normalized = email.trim().toLowerCase();
  const claims = {
    sub: q.get("login_sub") || `mock-${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`,
    email: normalized,
    email_verified: q.get("login_email_verified") !== "false",
    name: q.get("login_name") || normalized.split("@")[0],
  };
  const code = randomBytes(24).toString("base64url");
  codes.set(code, {
    clientId,
    redirectUri,
    nonce: q.get("nonce"),
    challenge: q.get("code_challenge"),
    claims,
    tamper: q.get("tamper"),
    expires: Date.now() + 60_000,
  });
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (q.get("state") !== null) target.searchParams.set("state", q.get("state")!);
  res.writeHead(302, { location: target.toString(), "cache-control": "no-store" });
  res.end();
}

async function readForm(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function token(req: IncomingMessage, res: ServerResponse) {
  const form = await readForm(req);
  let clientId = form.get("client_id");
  let secret = form.get("client_secret");
  const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (basic) {
    const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
    const at = decoded.indexOf(":");
    clientId = decodeURIComponent(decoded.slice(0, at));
    secret = decodeURIComponent(decoded.slice(at + 1));
  }
  if (!clientId || CLIENTS.get(clientId) !== secret) return send(res, 401, { error: "invalid_client" });
  if (form.get("grant_type") !== "authorization_code") return send(res, 400, { error: "unsupported_grant_type" });
  const code = form.get("code") ?? "";
  const grant = codes.get(code);
  codes.delete(code);
  if (!grant || grant.expires < Date.now() || grant.clientId !== clientId) {
    return send(res, 400, { error: "invalid_grant", error_description: "unknown, used or expired code" });
  }
  if (form.get("redirect_uri") !== grant.redirectUri) {
    return send(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
  }
  if (grant.challenge) {
    const verifier = form.get("code_verifier") ?? "";
    if (createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) {
      return send(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const t = grant.tamper;
  const idToken = signJwt({
    iss: t === "iss" ? `${ISSUER}/other` : ISSUER,
    aud: t === "aud" ? "another-client" : clientId,
    iat: now,
    exp: t === "expired" ? now - 3600 : now + 300,
    ...(grant.nonce !== null ? { nonce: t === "nonce" ? `${grant.nonce}x` : grant.nonce } : {}),
    ...grant.claims,
  }, t === "signature" ? OTHER_KEY : PRIVATE_KEY);
  const accessToken = randomBytes(24).toString("base64url");
  accessTokens.set(accessToken, grant.claims);
  send(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 300, id_token: idToken, scope: "openid email profile" });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://idp");
  try {
    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") return send(res, 200, discovery);
    if (req.method === "GET" && url.pathname === "/jwks") return send(res, 200, { keys: [jwk] });
    if (req.method === "GET" && url.pathname === "/authorize") return authorize(url, res);
    if (req.method === "POST" && url.pathname === "/token") return await token(req, res);
    if (req.method === "GET" && url.pathname === "/userinfo") {
      const claims = accessTokens.get((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
      return claims ? send(res, 200, claims) : send(res, 401, { error: "invalid_token" });
    }
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    send(res, 404, { error: "not_found" });
  } catch (error) {
    console.error(error);
    send(res, 500, { error: "server_error" });
  }
}

createHttpServer(handle).listen(HTTP_PORT, () => console.log(`mock IdP: http on :${HTTP_PORT}, issuer ${ISSUER}`));
createHttpsServer({ key: readFileSync(file("server.key")), cert: readFileSync(file("server.pem")) }, handle)
  .listen(HTTPS_PORT, () => console.log(`mock IdP: https on :${HTTPS_PORT}`));
