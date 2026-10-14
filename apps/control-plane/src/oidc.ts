// GitHub Actions OIDC tokens (ARCHITECTURE §5.1): signature checked against the issuer's JWKS (cached by jose),
// then issuer, audience, expiry and the GitHub claims the CI API relies on.
import { createLocalJWKSet, createRemoteJWKSet, errors, type JWTPayload, jwtVerify } from "jose";
import type { Settings } from "./settings.ts";

/** Claims of a GitHub Actions OIDC token used by the platform (all strings, as GitHub sends them). */
export interface GithubClaims extends JWTPayload {
  repository: string;
  repository_id: string;
  ref: string;
  ref_protected?: string;
  sha: string;
  actor: string;
  run_id: string;
  run_attempt: string;
  job_workflow_ref: string;
  event_name?: string;
}

const REQUIRED = ["repository", "repository_id", "ref", "sha", "actor", "run_id", "run_attempt", "job_workflow_ref"];

export class OidcError extends Error {}

type KeySet = ReturnType<typeof createRemoteJWKSet>;
const remoteSets = new Map<string, KeySet>();
let localSet: { json: string; keys: ReturnType<typeof createLocalJWKSet> } | null = null;

function keySet(settings: Settings) {
  if (settings.oidcJwks) {
    if (localSet?.json !== settings.oidcJwks) {
      console.warn("OIDC: trusting the inline oidc_jwks setting (test only)");
      localSet = { json: settings.oidcJwks, keys: createLocalJWKSet(JSON.parse(settings.oidcJwks)) };
    }
    return localSet.keys;
  }
  let set = remoteSets.get(settings.oidcJwksUrl);
  if (!set) {
    // jose caches the keys (10 min) and refetches on an unknown kid (at most every 30 s)
    set = createRemoteJWKSet(new URL(settings.oidcJwksUrl), { timeoutDuration: 10_000 });
    remoteSets.set(settings.oidcJwksUrl, set);
  }
  return set;
}

export async function verifyGithubToken(token: string, settings: Settings): Promise<GithubClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keySet(settings), {
      issuer: settings.oidcIssuer,
      audience: settings.oidcAudience,
      algorithms: ["RS256"],
      clockTolerance: 30,
      requiredClaims: ["exp", "iat"],
    }));
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw new OidcError("OIDC token expired");
    if (error instanceof errors.JWTClaimValidationFailed) {
      throw new OidcError(`OIDC token rejected: ${error.claim} ${error.reason === "check_failed" ? "mismatch" : error.reason}`);
    }
    if (error instanceof errors.JOSEError) throw new OidcError(`OIDC token rejected: ${error.code}`);
    throw error;
  }
  const missing = REQUIRED.filter((claim) => typeof payload[claim] !== "string" || payload[claim] === "");
  if (missing.length) throw new OidcError(`OIDC token without ${missing.join(", ")}: not a GitHub Actions token`);
  return payload as GithubClaims;
}

/**
 * Allow-list entries: "owner/repo/.github/workflows/file.yml@<ref>" matches that exact ref;
 * without "@", any ref of that workflow file (so pin a ref in production).
 */
export function workflowAllowed(jobWorkflowRef: string, allowed: string[]) {
  const at = jobWorkflowRef.lastIndexOf("@");
  const workflow = at < 0 ? jobWorkflowRef : jobWorkflowRef.slice(0, at);
  return allowed.some((entry) => entry.includes("@") ? entry === jobWorkflowRef : entry === workflow);
}

/** github.com for the public issuer, the issuer's origin for GHES (https://HOST/_services/token). */
export function githubServerUrl(issuer: string) {
  const url = new URL(issuer);
  return url.hostname === "token.actions.githubusercontent.com" ? "https://github.com" : url.origin;
}
