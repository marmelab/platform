// Integration tests for the M1 spike. Expects the stack to be running (see run.sh).
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { appConfigPath, curl, fn, signHs256, switchCurrent, tokens, waitReady, writeAppConfig } from "./lib.ts";

await waitReady();
const t = tokens();
const readConfig = (app: string) => JSON.parse(Deno.readTextFileSync(appConfigPath(app)));

Deno.test("routes each host to its own app", async () => {
  const app1 = await curl(fn("app1", "hello"));
  const app2 = await curl(fn("app2", "hello"));
  assertEquals(app1.status, 200);
  assertEquals(app1.json().message, "hello from app1 (v1)");
  assertEquals(app1.json().supabaseUrl, "http://app1.localhost:8090");
  assertEquals(app1.json().url, "http://app1.localhost:8090/hello");
  assertEquals(app2.json().message, "bonjour from app2 (v1)");
});

Deno.test("unknown host and unknown function are rejected", async () => {
  assertEquals((await curl(fn("app3", "hello"))).status, 404);
  assertEquals((await curl(fn("app1", "nope"))).status, 404);
  assertEquals((await curl(fn("app1", "_shared"))).status, 404);
  assertEquals((await curl("http://app1.localhost:8090/functions/v1/")).status, 404);
});

Deno.test("env contains only the app's own variables", async () => {
  const env1 = (await curl(fn("app1", "env"))).json<Record<string, string>>();
  const env2 = (await curl(fn("app2", "env"))).json<Record<string, string>>();
  const config1 = readConfig("app1");
  const config2 = readConfig("app2");
  for (const [key, value] of Object.entries(config1.env)) assertEquals(env1[key], value, key);
  for (const [key, value] of Object.entries(config2.env)) assertEquals(env2[key], value, key);
  const app1Body = JSON.stringify(env1);
  for (const value of [...Object.values(config2.env), config2.jwt_secret, config1.jwt_secret] as string[]) {
    assert(!app1Body.includes(value), "app1 must never see app2 values nor any jwt secret");
  }
  const allowed = new Set([...Object.keys(config1.env), "SUPABASE_FUNCTION_SLUG", "SB_EXECUTION_ID"]);
  assertEquals(Object.keys(env1).filter((k) => !allowed.has(k)), [], "no leaked runtime env (PLATFORM_*, PATH…)");
});

Deno.test("client cannot choose the app with a forged header", async () => {
  const forged = [
    ["-H", "X-Platform-App: app2"],
    ["-H", "x-platform-app: app2"],
    ["-H", "X-Platform-App: app2", "-H", "X-Platform-App: app2"],
    ["-H", "X_Platform_App: app2"],
    ["-H", "X-Platform-Gateway-Token: forged", "-H", "X-Platform-App: app2"],
  ];
  const secret2 = readConfig("app2").env.MY_SECRET;
  for (const headers of forged) {
    const res = await curl(fn("app1", "env"), headers);
    assertEquals(res.status, 200, headers.join(" "));
    assertEquals(res.json().APP_NAME, "app1", headers.join(" "));
    assert(!res.body.includes(secret2));
  }
  const spoofedHost = await curl(fn("app1", "hello"), ["-H", "X-Forwarded-Host: app2.localhost:8090"]);
  assertEquals(spoofedHost.json().url, "http://app1.localhost:8090/hello");
  const viaIp = await curl("http://127.0.0.1:8090/functions/v1/env", ["-H", "X-Platform-App: app2"]);
  assertEquals(viaIp.status, 404);
});

Deno.test("path traversal cannot reach another app", async () => {
  const paths = [
    "/functions/v1/../app2/current/hello",
    "/functions/v1/../../functions/app2/current/hello/index.ts",
    "/functions/v1/..%2F..%2Fapp2%2Fcurrent%2Fhello",
    "/functions/v1/%2e%2e/%2e%2e/app2/current/hello",
    "/functions/v1/hello/../../../app2/hello",
    "/functions/v1/%2e%2e%2fapp2",
    "/functions/v1/..;/app2/hello",
  ];
  for (const path of paths) {
    const res = await curl(`http://app1.localhost:8090${path}`, ["--path-as-is"]);
    assert(!res.body.includes("app2"), `${path} -> ${res.status} ${res.body}`);
    assertNotEquals(res.status, 200, path);
  }
});

Deno.test("verify_jwt uses each app's own secret", async () => {
  const bearer = (token: string) => ["-H", `Authorization: Bearer ${token}`];
  assertEquals((await curl(fn("app2", "secure"), bearer(t.app2.anon))).status, 200);
  const crossApp = await curl(fn("app2", "secure"), bearer(t.app1.anon));
  assertEquals(crossApp.status, 401);
  assertEquals(crossApp.json().code, "UNAUTHORIZED_JWT");
  assertEquals((await curl(fn("app2", "secure"), bearer(t.app1.service_role))).status, 401);
  assertEquals((await curl(fn("app2", "secure"))).json().code, "UNAUTHORIZED_NO_AUTH_HEADER");
  const expired = await signHs256({ role: "authenticated", exp: 1000 }, t.app2.jwt_secret);
  assertEquals((await curl(fn("app2", "secure"), bearer(expired))).status, 401);
  const none = `${btoa('{"alg":"none","typ":"JWT"}')}.${btoa('{"role":"service_role"}')}.`.replace(/=/g, "");
  assertEquals((await curl(fn("app2", "secure"), bearer(none))).status, 401);
  const user = await signHs256({ role: "authenticated", sub: "u1", exp: 4_000_000_000 }, t.app1.jwt_secret);
  const ok = await curl(fn("app1", "secure"), bearer(user));
  assertEquals(ok.status, 200);
  assertEquals(ok.json<{ claims: { sub: string } }>().claims.sub, "u1");
  assertEquals((await curl(fn("app1", "secure"), ["-X", "OPTIONS"])).status, 200, "CORS preflight bypasses JWT");
  assertEquals((await curl(fn("app1", "hello"))).status, 200, "verify_jwt=false needs no token");
});

Deno.test("npm: dependencies (zod, supabase-js) work", async () => {
  const valid = await curl(fn("app1", "deps"), ["-X", "POST", "-d", '{"name":"Ada"}']);
  assertEquals(valid.status, 200, valid.body);
  assertEquals(valid.json(), { zod: "valid: Ada", supabaseClient: true });
  const invalid = await curl(fn("app1", "deps"), ["-X", "POST", "-d", '{"name":""}']);
  assertStringIncludes(invalid.json<{ zod: string }>().zod, "invalid");
  const bare = await curl(fn("app2", "imports"));
  assertEquals(bare.json(), { parsed: "bare specifier via deno.json" }, "per-function deno.json import map");
});

Deno.test("user worker sandbox: no access to config, other apps, main worker or gateway", async () => {
  await curl(fn("app2", "probe"));
  const probe = (await curl(fn("app1", "probe"))).json<Record<string, { ok: boolean; value?: string }>>();
  for (
    const key of [
      "readOtherConfig",
      "readOwnConfig",
      "readOtherFunction",
      "listFunctionsRoot",
      "readProcEnviron",
      "readMainWorker",
      "readOtherTmp",
      "writeFunctions",
      "runCommand",
    ]
  ) {
    assertEquals(probe[key].ok, false, `${key}: ${JSON.stringify(probe[key])}`);
  }
  assertStringIncludes(probe.callMainLocalhost.value ?? "", "403");
  assertStringIncludes(probe.callMainByServiceName.value ?? "", "403");
  assertEquals(probe.callCaddyAdmin.ok, false, "Caddy admin API must not be reachable from functions");
});

Deno.test("internal metrics are not reachable through the gateway without admin token", async () => {
  const res = await curl("http://app1.localhost:8090/functions/v1/_internal/metrics");
  assertEquals(res.status, 403);
});

Deno.test("switching the current symlink changes the version without restart", async () => {
  try {
    await switchCurrent("app1", "v2");
    assertEquals((await curl(fn("app1", "hello"))).json().message, "hello from app1 (v2)");
    assertEquals((await curl(fn("app1", "env"))).status, 404, "env does not exist in v2");
    assertEquals((await curl(fn("app2", "hello"))).json().message, "bonjour from app2 (v1)");
  } finally {
    await switchCurrent("app1", "v1");
  }
  assertEquals((await curl(fn("app1", "hello"))).json().message, "hello from app1 (v1)");
});

Deno.test("rewriting the app config reloads env and jwt secret without restart", async () => {
  const original = Deno.readTextFileSync(appConfigPath("app1"));
  try {
    const config = JSON.parse(original);
    config.env.MY_SECRET = "rotated-secret";
    config.jwt_secret = "rotated-jwt-secret-rotated-jwt-secret-1234";
    await writeAppConfig("app1", JSON.stringify(config));
    assertEquals((await curl(fn("app1", "env"))).json().MY_SECRET, "rotated-secret");
    const oldToken = ["-H", `Authorization: Bearer ${t.app1.anon}`];
    assertEquals((await curl(fn("app1", "secure"), oldToken)).status, 401);
  } finally {
    await writeAppConfig("app1", original);
  }
  assertEquals((await curl(fn("app1", "env"))).json().MY_SECRET, readConfig("app1").env.MY_SECRET);
});

Deno.test("resource limits stop a runaway worker without affecting others", async () => {
  const cpu = await curl(fn("app1", "burn", "?mode=cpu"));
  assertEquals(cpu.status, 546, `cpu: ${cpu.status} ${cpu.body}`);
  const memory = await curl(fn("app1", "burn", "?mode=memory"));
  assertEquals(memory.status, 546, `memory: ${memory.status} ${memory.body}`);
  assertEquals((await curl(fn("app1", "hello"))).status, 200);
  assertEquals((await curl(fn("app2", "hello"))).status, 200);
});
