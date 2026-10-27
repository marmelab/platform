// On-demand TLS (A1, src/tls.ts): Caddy's `ask` endpoint on the control plane's internal listener approves the
// platform hosts and the hosts of existing apps only. On a production-mode stack (PLATFORM_URL in https, e.g.
// install.sh --production --internal-tls), it also checks the real handshakes through Caddy: a certificate for an app
// host, none for an unknown one, and the HTTP -> HTTPS redirect. Run the HTTPS part with NODE_EXTRA_CA_CERTS pointing
// to Caddy's root (deploy/caddy-root.crt) when the stack uses Caddy's internal CA.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:tls";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { cleanup, cli, runId, waitForControlPlane } from "./disposable.ts";

const ROOT = new URL("../../../", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL("deploy/.env.local", ROOT), "utf8").split("\n").filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
) as Record<string, string>;
const MCP_URL = env.PLATFORM_URL ?? "http://api.localhost:8100/mcp";
const API = new URL(MCP_URL);
const DOMAIN = API.hostname.replace(/^api\./, "");
const HTTPS = API.protocol === "https:";
const P = `e2e-${runId()}-tls`;

/** GET /caddy/ask as Caddy does it (from the Caddy container, on the internal listener). */
function ask(domain: string): number {
  try {
    execFileSync("docker", ["exec", "plat-caddy", "wget", "-q", "-O", "/dev/null",
      `http://control-plane:3001/caddy/ask?domain=${encodeURIComponent(domain)}`], { stdio: "pipe" });
    return 200;
  } catch (error) {
    const stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    const status = /HTTP\/1\.1 (\d{3})/.exec(stderr)?.[1];
    if (!status) throw error;
    return Number(status);
  }
}

/** TLS handshake with Caddy on 127.0.0.1:443 for this SNI: the certificate's subject, or the error. */
function handshake(host: string): Promise<{ ok: true; subject: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: 443, servername: host, timeout: 15_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve({ ok: true, subject: String(cert.subject?.CN ?? cert.subjectaltname ?? "") });
    });
    socket.on("error", (error) => resolve({ ok: false, error: error.message }));
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ok: false, error: "timeout" });
    });
  });
}

describe("On-demand TLS: ask endpoint", () => {
  let admin: Client;

  before(async () => {
    await waitForControlPlane(MCP_URL);
    admin = new Client({ name: "e2e-tls", version: "0.0.0" });
    await admin.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${env.PLATFORM_TOKEN}` } },
    }));
    const result = await admin.callTool({ name: "create_app", arguments: { name: P, slug: P } }) as { isError?: boolean };
    assert.ok(!result.isError);
  });

  after(async () => {
    await admin?.close();
    await cleanup([P], []);
  });

  test("1. platform hosts and existing apps are approved, anything else refused", () => {
    for (const host of [`api.${DOMAIN}`, `admin.${DOMAIN}`, DOMAIN, `${P}.${DOMAIN}`, `${P.toUpperCase()}.${DOMAIN}.`]) {
      assert.equal(ask(host), 200, host);
    }
    for (const host of [`unknown-${P}.${DOMAIN}`, `${P}.example.org`, `${P}.${DOMAIN}.example.org`, `x.${P}.${DOMAIN}`,
      `a.${DOMAIN}`, `studio.${DOMAIN}`, `www.${DOMAIN}`, "",
      ...(DOMAIN === "localhost" ? [] : ["localhost"])]) {
      assert.equal(ask(host), 404, JSON.stringify(host));
    }
  });

  test("2. a stopped app keeps its certificate (maintenance page); a deleted one loses it", () => {
    cli(["stop-app", P]);
    assert.equal(ask(`${P}.${DOMAIN}`), 200);
    cli(["delete-app", P, "--no-backup"]);
    assert.equal(ask(`${P}.${DOMAIN}`), 404);
  });

  test("3. production mode: certificates through Caddy for known hosts only, HTTP redirected to HTTPS", { skip: !HTTPS }, async () => {
    const app = await admin.callTool({ name: "create_app", arguments: { name: `${P}b`, slug: `${P}b` } }) as { isError?: boolean };
    assert.ok(!app.isError);
    try {
      for (const host of [`api.${DOMAIN}`, `admin.${DOMAIN}`, DOMAIN, `${P}b.${DOMAIN}`]) {
        const result = await handshake(host);
        assert.ok(result.ok, `${host}: ${JSON.stringify(result)}`);
      }
      const refused = await handshake(`unknown-${P}.${DOMAIN}`);
      assert.equal(refused.ok, false, "no certificate for an unknown host");
      // HTTPS requests (trusting Caddy's CA through NODE_EXTRA_CA_CERTS when it is the internal one)
      const health = await fetch(`https://api.${DOMAIN}/health`);
      assert.equal(health.status, 200);
      const site = await fetch(`https://${P}b.${DOMAIN}/`);
      assert.equal(site.status, 200);
      const auth = await fetch(`https://${P}b.${DOMAIN}/auth/v1/health`);
      assert.equal(auth.status, 200);
      // Studio's forward auth: a signed-out page request is redirected to the platform login
      const studio = await fetch(`https://${DOMAIN}/`, { redirect: "manual", headers: { accept: "text/html" } });
      assert.equal(studio.status, 302);
      assert.match(studio.headers.get("location") ?? "", /\/_platform\/login/);
      const login = await fetch(`https://${DOMAIN}/_platform/login`);
      assert.equal(login.status, 200);
      const adminPage = await fetch(`https://admin.${DOMAIN}/`);
      assert.equal(adminPage.status, 200);
      const redirect = await fetch(`http://${P}b.${DOMAIN}/some/path?x=1`, { redirect: "manual" });
      assert.equal(redirect.status, 308);
      assert.equal(redirect.headers.get("location"), `https://${P}b.${DOMAIN}/some/path?x=1`);
    } finally {
      await cleanup([`${P}b`], []);
    }
  });
});
