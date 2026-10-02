import assert from "node:assert/strict";
import { test } from "node:test";
import { studioAccess, type StudioUser } from "../src/studio/policy.ts";

const alice: StudioUser = { role: "developer", apps: ["demo"] };
const admin: StudioUser = { role: "admin", apps: [] };

const allowed = (method: string, uri: string, user = alice) => studioAccess(method, uri, user).allow;
const status = (method: string, uri: string, user = alice) => {
  const access = studioAccess(method, uri, user);
  return access.allow ? 200 : access.status;
};

test("project-scoped routes follow membership", () => {
  assert.ok(allowed("POST", "/api/platform/pg-meta/demo/query?key=x"));
  assert.ok(allowed("GET", "/api/platform/pg-meta/demo/tables?include_columns=true"));
  assert.ok(allowed("POST", "/api/platform/auth/demo/users"));
  assert.ok(allowed("GET", "/api/platform/storage/demo/buckets"));
  assert.ok(allowed("GET", "/project/demo/editor"));
  assert.ok(allowed("GET", "/project/demo"));
  assert.equal(status("POST", "/api/platform/pg-meta/todo-app/query"), 403);
  assert.equal(status("GET", "/project/todo-app/editor"), 403);
  assert.equal(status("GET", "/_next/data/build/project/todo-app/editor.json"), 403);
  assert.equal(status("GET", "/api/v1/projects/todo-app/types/typescript"), 403);
  assert.ok(allowed("POST", "/api/platform/pg-meta/todo-app/query", admin));
});

test("refs that could be normalised differently are rejected", () => {
  assert.equal(status("POST", "/api/platform/pg-meta/todo%2Dapp/query"), 403);
  assert.equal(status("POST", "/api/platform/pg-meta/TODO-APP/query"), 403);
  assert.equal(status("POST", "/api/platform/pg-meta/demo/../todo-app/query"), 400);
  assert.equal(status("POST", "/api/platform/pg-meta/demo/%2e%2e/todo-app/query"), 400);
  assert.equal(status("POST", "/api/platform/pg-meta/demo%2f..%2ftodo-app/query"), 400);
  assert.equal(status("POST", "/api/platform/pg-meta//todo-app/query"), 400);
  assert.equal(status("POST", "/API/platform/pg-meta/todo-app/query"), 400);
  assert.equal(status("GET", "/Project/todo-app"), 400);
  assert.equal(status("POST", "/api/platform/pg-meta/default/query", admin), 403);
});

test("fork features outside the platform are denied to everyone", () => {
  for (const user of [alice, admin]) {
    assert.equal(status("POST", "/api/self-hosted/bootstrap", user), 403);
    assert.equal(status("POST", "/api/platform/projects/import", user), 403);
    assert.equal(status("POST", "/api/platform/projects", user), 403);
    assert.equal(status("DELETE", "/api/platform/projects/demo", user), 403);
    assert.equal(status("POST", "/api/platform/projects/demo/failover", user), 403);
    assert.equal(status("POST", "/api/platform/projects/demo/replica", user), 403);
    assert.equal(status("GET", "/api/platform/license", user), 403);
    assert.equal(status("POST", "/api/v1/projects/demo/functions/deploy", user), 403);
    assert.equal(status("POST", "/api/platform/organizations", user), 403);
    assert.equal(status("GET", "/api/unknown", user), 403);
    assert.equal(status("GET", "/new/project", user), 403);
  }
});

test("lists and shell pages are allowed", () => {
  assert.ok(allowed("GET", "/api/platform/projects?limit=10"));
  assert.ok(allowed("GET", "/api/platform/organizations"));
  assert.ok(allowed("GET", "/api/platform/profile"));
  assert.ok(allowed("GET", "/projects"));
  assert.ok(allowed("GET", "/_next/static/chunks/main.js"));
});
