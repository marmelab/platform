import { assertEquals } from "jsr:@std/assert@1";
import { extractToken, signHs256, verifyHs256 } from "./jwt.ts";
import { isValidAppSlug, parseFunctionName, resolveFunction } from "./resolve.ts";

const SECRET = "a".repeat(40);

Deno.test("verifyHs256 accepts a valid token and rejects tampering, other secrets, expiry", async () => {
  const token = await signHs256({ role: "anon", exp: 2_000_000_000 }, SECRET);
  assertEquals(await verifyHs256(token, SECRET), null);
  assertEquals(await verifyHs256(token, "b".repeat(40)), "UNAUTHORIZED_JWT");
  assertEquals(await verifyHs256(token.slice(0, -2) + "xx", SECRET), "UNAUTHORIZED_JWT");
  const expired = await signHs256({ role: "anon", exp: 1 }, SECRET);
  assertEquals(await verifyHs256(expired, SECRET), "UNAUTHORIZED_JWT");
  assertEquals(await verifyHs256("not-a-jwt", SECRET), "UNAUTHORIZED_INVALID_JWT_FORMAT");
  const none = `${btoa('{"alg":"none"}')}.${btoa('{"role":"service_role"}')}.`;
  assertEquals(await verifyHs256(none, SECRET), "UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM");
});

Deno.test("extractToken", () => {
  assertEquals(extractToken(new Headers()), "UNAUTHORIZED_NO_AUTH_HEADER");
  assertEquals(extractToken(new Headers({ authorization: "Basic x" })), "UNAUTHORIZED_INVALID_JWT_FORMAT");
  assertEquals(extractToken(new Headers({ authorization: "Bearer abc" })), "abc");
});

Deno.test("slug and function name validation", () => {
  assertEquals(isValidAppSlug("app1"), true);
  assertEquals(isValidAppSlug("../app2"), false);
  assertEquals(isValidAppSlug("app1,app2"), false);
  assertEquals(isValidAppSlug(null), false);
  assertEquals(parseFunctionName("/hello/sub/path"), "hello");
  assertEquals(parseFunctionName("/../app2"), null);
  assertEquals(parseFunctionName("/%2e%2e"), null);
  assertEquals(parseFunctionName("/_shared"), null);
  assertEquals(parseFunctionName("/"), null);
});

Deno.test("resolveFunction follows current and refuses escapes", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/app1/v1/hello`, { recursive: true });
  await Deno.writeTextFile(`${root}/app1/v1/hello/index.ts`, "");
  await Deno.mkdir(`${root}/app2/v1/secret`, { recursive: true });
  await Deno.writeTextFile(`${root}/app2/v1/secret/index.ts`, "");
  await Deno.symlink("v1", `${root}/app1/current`);
  await Deno.symlink(`${root}/app2/v1/secret`, `${root}/app1/v1/escape`);

  const resolved = await resolveFunction(root, "app1", "hello");
  assertEquals(resolved?.entrypoint, `${await Deno.realPath(root)}/app1/v1/hello/index.ts`);
  assertEquals(await resolveFunction(root, "app1", "escape"), null);
  assertEquals(await resolveFunction(root, "app1", "missing"), null);
  assertEquals(await resolveFunction(root, "app2", "secret"), null);

  await Deno.symlink(`${root}/app2/v1`, `${root}/app2/current`);
  await Deno.remove(`${root}/app1/current`);
  await Deno.symlink(`${root}/app2/v1`, `${root}/app1/current`);
  assertEquals(await resolveFunction(root, "app1", "secret"), null);
  await Deno.remove(root, { recursive: true });
});
