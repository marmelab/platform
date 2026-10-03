// Pure part of the company SSO (M6 part 2, sso.ts): checks on the IdP's claims, PKCE, the password login policy.
// No I/O and no platform configuration import, so that the unit tests (test/sso-policy.test.ts) load it alone.
import { createHash, timingSafeEqual } from "node:crypto";
import type { SsoSettings } from "./settings.ts";

/** A refused SSO login: `reason` is a stable code (audit log, tests), `message` is shown to the person. */
export class SsoError extends Error {
  readonly reason: string;
  readonly email: string | null;

  constructor(reason: string, message: string, email: string | null = null) {
    super(message);
    this.reason = reason;
    this.email = email;
  }
}

export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export function sameSecret(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Client authentication at the token endpoint: client_secret_basic (the OIDC default) unless the IdP only lists
 * client_secret_post.
 */
export function tokenAuthMethod(supported: string[] | undefined): "basic" | "post" {
  if (!supported || supported.length === 0 || supported.includes("client_secret_basic")) return "basic";
  if (supported.includes("client_secret_post")) return "post";
  throw new SsoError("unsupported_client_auth", `the identity provider supports neither client_secret_basic nor client_secret_post (${supported.join(", ")})`);
}

/** RFC 6749 §2.3.1: both parts are form-urlencoded before the base64 encoding. */
export const basicAuth = (clientId: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString("base64")}`;

/**
 * The email the IdP asserts, once checked against the platform policy: present, verified (unless the admin turned
 * that off for an IdP that never sends `email_verified`), and in the allowed domains.
 */
export function checkedEmail(claims: Record<string, unknown>, sso: Pick<SsoSettings, "requireVerifiedEmail" | "allowedDomains">) {
  const raw = claims.email;
  if (typeof raw !== "string" || !/^[^\s@]+@[^\s@]+$/.test(raw.trim())) {
    throw new SsoError("no_email", "The identity provider did not send an email address (scope \"email\").");
  }
  const email = raw.trim().toLowerCase();
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (sso.requireVerifiedEmail && !verified) {
    throw new SsoError("email_not_verified", `The identity provider did not confirm that ${email} is verified.`, email);
  }
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (sso.allowedDomains.length > 0 && !sso.allowedDomains.includes(domain)) {
    throw new SsoError("domain_not_allowed", `${email}: SSO sign-in is restricted to ${sso.allowedDomains.join(", ")}.`, email);
  }
  return email;
}

/** With several audiences, the ID token must have been issued to us (OIDC Core §3.1.3.7, items 4 and 5). */
export function checkAuthorizedParty(claims: { aud?: string | string[]; azp?: unknown }, clientId: string) {
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (aud.length > 1 && claims.azp !== clientId) {
    throw new SsoError("azp_mismatch", "The ID token was issued to another client.");
  }
  if (claims.azp !== undefined && claims.azp !== clientId) {
    throw new SsoError("azp_mismatch", "The ID token was issued to another client.");
  }
}

/** Password sign-in (Studio, admin console) while SSO is active: everyone, or admins only (break-glass). */
export function passwordLoginRefused(role: "admin" | "developer", sso: Pick<SsoSettings, "passwordLogin">, active: boolean) {
  return active && sso.passwordLogin === "admins" && role !== "admin";
}

/** Only local paths: no scheme, no protocol-relative URL, no backslash tricks. */
export const safeNext = (next: string | undefined | null, fallback: string) =>
  next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : fallback;
