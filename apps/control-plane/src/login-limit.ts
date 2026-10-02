// SEC-3: throttling of the platform logins (Studio's /_platform/login and the admin console's /api/auth/login).
//
// Two independent limits, checked before the password (a locked-out caller learns nothing, not even whether the
// password was right) and updated after it:
// - per email: after EMAIL.free failures, each further failure locks the account's logins with an exponential backoff
//   (30 s, 1 min, 2 min... capped at 15 min). Guessing one account's password is then a few hundred attempts a day.
// - per client IP: same mechanism with a larger allowance (several people can share an IP behind a company NAT), so
//   that one source cannot spray passwords over many accounts.
// Failures are forgotten after IDLE without a new failure; a successful login clears its email's failures (not the
// IP's: a sprayer who knows one password must not reset its own counter).
//
// In memory, in the control plane process: one control plane serves every login (single VM, PLAN_1 §9), checks cost no
// database write, and a restart (which an attacker cannot trigger) only resets the counters. A multi-instance control
// plane would need a shared store (a table, or Postgres advisory state).
//
// Trade-off: the per-email lock lets anyone delay a known account's logins (bounded by the 15 min cap); existing
// sessions and PATs are not affected.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface LimitPolicy {
  /** Failures allowed before the first lock. */
  free: number;
  /** First lock duration, doubled at each further failure. */
  baseMs: number;
  maxMs: number;
}

export const EMAIL_POLICY: LimitPolicy = { free: 5, baseMs: 30_000, maxMs: 15 * 60_000 };
export const IP_POLICY: LimitPolicy = { free: 30, baseMs: 30_000, maxMs: 15 * 60_000 };
/** Failures are forgotten after this long without a new failure. */
export const IDLE_MS = 15 * 60_000;
/** Bound on the tracked keys (a sprayer using random emails); the oldest are dropped first. */
const MAX_KEYS = 100_000;

interface Entry {
  failures: number;
  lastFailure: number;
  lockedUntil: number;
}

export class LoginLimiter {
  private entries = new Map<string, Entry>();
  private policies: { email: LimitPolicy; ip: LimitPolicy };
  private now: () => number;

  constructor(policies = { email: EMAIL_POLICY, ip: IP_POLICY }, now: () => number = Date.now) {
    this.policies = policies;
    this.now = now;
  }

  private get(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.lastFailure > IDLE_MS && this.now() >= entry.lockedUntil) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Milliseconds before this email and IP may try again (0: allowed). */
  retryAfterMs(email: string, ip: string): number {
    const now = this.now();
    const waits = [this.get(`email:${normalize(email)}`), this.get(`ip:${ip}`)]
      .map((entry) => (entry ? Math.max(0, entry.lockedUntil - now) : 0));
    return Math.max(...waits);
  }

  failure(email: string, ip: string) {
    this.record(`email:${normalize(email)}`, this.policies.email);
    this.record(`ip:${ip}`, this.policies.ip);
  }

  success(email: string) {
    this.entries.delete(`email:${normalize(email)}`);
  }

  private record(key: string, policy: LimitPolicy) {
    const now = this.now();
    const entry = this.get(key) ?? { failures: 0, lastFailure: now, lockedUntil: 0 };
    entry.failures++;
    entry.lastFailure = now;
    if (entry.failures > policy.free) {
      const lock = Math.min(policy.baseMs * 2 ** (entry.failures - policy.free - 1), policy.maxMs);
      entry.lockedUntil = now + lock;
    }
    // re-inserted last: the Map's order is the order of the last failure, oldest first
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > MAX_KEYS) this.entries.delete(this.entries.keys().next().value!);
  }

  /** Test helper: forgets everything. */
  reset() {
    this.entries.clear();
  }
}

const normalize = (email: string) => email.trim().toLowerCase();

export const loginLimiter = new LoginLimiter();

/** Thrown (and rendered as 429 with Retry-After) while a login is locked. */
export class TooManyAttempts extends Error {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`Too many failed sign-in attempts. Try again in ${formatWait(retryAfterSeconds)}.`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const formatWait = (seconds: number) =>
  seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;

/**
 * Checks the limits, runs `verify` (the password check), and records the outcome. `verify` returns a truthy value on
 * success. Throws TooManyAttempts while locked, without calling `verify`.
 */
export async function throttledLogin<T>(email: string, ip: string, verify: () => Promise<T | null>): Promise<T | null> {
  const wait = loginLimiter.retryAfterMs(email, ip);
  if (wait > 0) {
    console.warn(`login throttled for ${JSON.stringify(email)} from ${ip} (${Math.ceil(wait / 1000)} s)`);
    throw new TooManyAttempts(Math.ceil(wait / 1000));
  }
  const result = await verify();
  if (result) loginLimiter.success(email);
  else loginLimiter.failure(email, ip);
  return result;
}

// --- client IP -------------------------------------------------------------------------------------------------

let proxyAddresses: { at: number; addresses: Set<string> } | null = null;

/** Addresses of the trusted reverse proxies (Caddy), resolved from their host names and cached 30 s. */
export async function trustedProxyAddresses(hosts: string[]): Promise<Set<string>> {
  if (proxyAddresses && Date.now() - proxyAddresses.at < 30_000) return proxyAddresses.addresses;
  const addresses = new Set<string>();
  for (const host of hosts) {
    if (isIP(host)) addresses.add(host);
    else {
      for (const { address } of await lookup(host, { all: true }).catch(() => [])) addresses.add(address);
    }
  }
  proxyAddresses = { at: Date.now(), addresses };
  return addresses;
}

const unmap = (address: string) => address.replace(/^::ffff:/, "");

/**
 * The client's IP: the TCP peer, or, when the peer is the trusted proxy (Caddy), the last X-Forwarded-For entry.
 * Caddy's reverse_proxy replaces any client-sent X-Forwarded-For (no `trusted_proxies` on its servers), so that entry
 * is the address Caddy saw. A request reaching the control plane directly (another container on the network) cannot
 * choose its IP with the header.
 */
export function clientIp(peer: string | undefined, forwardedFor: string | undefined, trusted: Set<string>): string {
  const remote = unmap(peer ?? "unknown");
  if (!forwardedFor || !trusted.has(remote)) return remote;
  const last = forwardedFor.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return last && isIP(unmap(last)) ? unmap(last) : remote;
}
