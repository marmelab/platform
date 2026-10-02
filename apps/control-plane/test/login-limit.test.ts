// Unit tests of the login throttling (SEC-3): backoff per email and per IP, idle reset, client IP behind Caddy.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clientIp, IDLE_MS, LoginLimiter } from "../src/login-limit.ts";

function setup() {
  let now = 1_000_000;
  const clock = { advance: (ms: number) => (now += ms) };
  const policies = {
    email: { free: 5, baseMs: 30_000, maxMs: 15 * 60_000 },
    ip: { free: 30, baseMs: 30_000, maxMs: 15 * 60_000 },
  };
  return { limiter: new LoginLimiter(policies, () => now), clock };
}

test("per email: free attempts, then an exponential backoff capped at 15 minutes", () => {
  const { limiter, clock } = setup();
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.retryAfterMs("Alice@Example.com", "10.0.0.1"), 0, `attempt ${i + 1} is free`);
    limiter.failure("alice@example.com", "10.0.0.1");
  }
  assert.equal(limiter.retryAfterMs("alice@example.com", "10.0.0.1"), 0, "5 failures: still allowed");
  limiter.failure("alice@example.com", "10.0.0.1");
  assert.equal(limiter.retryAfterMs("alice@example.com", "10.0.0.2"), 30_000, "locked for the email, from any IP");
  assert.equal(limiter.retryAfterMs(" ALICE@example.com ", "10.0.0.2"), 30_000, "email normalized");
  assert.equal(limiter.retryAfterMs("bob@example.com", "10.0.0.2"), 0, "other accounts are not affected");
  clock.advance(30_000);
  limiter.failure("alice@example.com", "10.0.0.2");
  assert.equal(limiter.retryAfterMs("alice@example.com", "10.0.0.3"), 60_000, "doubled");
  for (let i = 0; i < 10; i++) {
    clock.advance(limiter.retryAfterMs("alice@example.com", "10.0.0.3"));
    limiter.failure("alice@example.com", "10.0.0.3");
  }
  assert.equal(limiter.retryAfterMs("alice@example.com", "10.0.0.3"), 15 * 60_000, "capped");
});

test("per email: a success clears the failures, idle failures are forgotten", () => {
  const { limiter, clock } = setup();
  for (let i = 0; i < 5; i++) limiter.failure("alice@example.com", "10.0.0.1");
  limiter.success("alice@example.com");
  limiter.failure("alice@example.com", "10.0.0.1");
  assert.equal(limiter.retryAfterMs("alice@example.com", "10.0.0.1"), 0, "counter restarted after the success");

  for (let i = 0; i < 6; i++) limiter.failure("carol@example.com", "10.0.0.9");
  assert.ok(limiter.retryAfterMs("carol@example.com", "10.0.0.8") > 0);
  clock.advance(IDLE_MS + 1);
  assert.equal(limiter.retryAfterMs("carol@example.com", "10.0.0.8"), 0);
  limiter.failure("carol@example.com", "10.0.0.8");
  assert.equal(limiter.retryAfterMs("carol@example.com", "10.0.0.8"), 0, "failures forgotten after the idle period");
});

test("per IP: password spraying over many accounts is throttled", () => {
  const { limiter } = setup();
  for (let i = 0; i < 30; i++) limiter.failure(`user${i}@example.com`, "203.0.113.7");
  assert.equal(limiter.retryAfterMs("new@example.com", "203.0.113.7"), 0, "30 failures allowed");
  limiter.failure("user30@example.com", "203.0.113.7");
  assert.equal(limiter.retryAfterMs("new@example.com", "203.0.113.7"), 30_000, "then locked for any email");
  assert.equal(limiter.retryAfterMs("new@example.com", "203.0.113.8"), 0, "other IPs are not affected");
  limiter.success("user1@example.com");
  assert.equal(limiter.retryAfterMs("new@example.com", "203.0.113.7"), 30_000, "a success does not reset the IP");
});

test("client IP: X-Forwarded-For is only trusted from the proxy", () => {
  const caddy = new Set(["172.20.0.5"]);
  assert.equal(clientIp("::ffff:172.20.0.5", "198.51.100.4", caddy), "198.51.100.4", "through Caddy");
  assert.equal(clientIp("172.20.0.5", "1.1.1.1, 198.51.100.4", caddy), "198.51.100.4", "the last hop is Caddy's");
  assert.equal(clientIp("172.20.0.9", "198.51.100.4", caddy), "172.20.0.9", "another container cannot choose its IP");
  assert.equal(clientIp("172.20.0.5", undefined, caddy), "172.20.0.5");
  assert.equal(clientIp("172.20.0.5", "not-an-ip", caddy), "172.20.0.5");
});
