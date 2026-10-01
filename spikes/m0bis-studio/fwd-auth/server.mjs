// Forward-auth mock standing in for the control plane's SSO (PLAN_1 §3.6 "Accès").
// GET /verify      -> called by Caddy forward_auth: 200 + Remote-User if the request carries
//                     a valid session cookie or Basic credentials, 401 otherwise.
// GET|POST /_sso/login -> fake SSO login form that sets the session cookie.
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const { FWD_AUTH_USER, FWD_AUTH_PASSWORD, FWD_AUTH_SESSION_SECRET } = process.env;
const COOKIE = "platform_session";

const sign = (user) => `${user}.${createHmac("sha256", FWD_AUTH_SESSION_SECRET).update(user).digest("base64url")}`;
const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const checkPassword = (user, password) => safeEqual(user, FWD_AUTH_USER) && safeEqual(password, FWD_AUTH_PASSWORD);

const userFromRequest = (req) => {
  const cookie = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (cookie) {
    const value = decodeURIComponent(cookie.slice(COOKIE.length + 1));
    const user = value.split(".")[0];
    if (safeEqual(value, sign(user))) return user;
  }
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Basic ")) {
    const [user, password] = Buffer.from(auth.slice(6), "base64").toString().split(":");
    if (user && password && checkPassword(user, password)) return user;
  }
  return null;
};

const form = (error = "") => `<!doctype html><title>Platform SSO (mock)</title>
<style>body{font:16px system-ui;margin:4rem auto;max-width:22rem}input,button{display:block;width:100%;margin:.5rem 0;padding:.5rem}</style>
<h1>Platform SSO</h1><p>Mock of the control plane login.</p>${error && `<p style="color:#c00">${error}</p>`}
<form method="post"><input name="user" placeholder="user" autocomplete="username">
<input name="password" type="password" placeholder="password" autocomplete="current-password"><button>Sign in</button></form>`;

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/verify") {
    const user = userFromRequest(req);
    if (user) {
      res.writeHead(200, { "Remote-User": user, "Remote-Groups": "platform-admins" });
      return res.end();
    }
    const uri = req.headers["x-forwarded-uri"] || "/";
    const wantsHtml = (req.headers.accept || "").includes("text/html");
    if (wantsHtml) {
      res.writeHead(302, { Location: `/_sso/login?next=${encodeURIComponent(uri)}` });
      return res.end();
    }
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="platform"', "Content-Type": "application/json" });
    return res.end('{"error":"unauthenticated"}');
  }
  if (url.pathname === "/_sso/login") {
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const user = params.get("user") || "";
      if (!checkPassword(user, params.get("password") || "")) {
        res.writeHead(401, { "Content-Type": "text/html" });
        return res.end(form("invalid credentials"));
      }
      const next = url.searchParams.get("next") || "/";
      res.writeHead(302, {
        "Set-Cookie": `${COOKIE}=${encodeURIComponent(sign(user))}; Path=/; HttpOnly; SameSite=Lax`,
        Location: next.startsWith("/") && !next.startsWith("//") ? next : "/",
      });
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(form());
  }
  res.writeHead(404);
  res.end();
}).listen(9000, () => console.log("fwd-auth listening on :9000"));
