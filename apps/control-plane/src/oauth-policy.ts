// Pure rules of the OAuth front (oauth.ts): which clients may register, which authorization requests are forwarded to
// the platform's GoTrue, how long a code lives. No I/O: the unit tests check them (test/oauth-policy.test.ts).

/** An authorization code must be exchanged within this delay after the consent (GoTrue alone allows 10 minutes). */
export const CODE_TTL_SECONDS = 60;
/** Loopback redirect URIs kept per client (one per callback port Claude Code picked). */
export const MAX_LOOPBACK_REDIRECTS = 10;

export class OAuthError extends Error {
  readonly error: string;
  readonly description: string;
  constructor(error: string, description: string) {
    super(description);
    this.error = error;
    this.description = description;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parse(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

/**
 * A native client's redirect URI (RFC 8252 §7.3): plain HTTP on the loopback interface, as Claude Code's
 * `http://localhost:<port>/callback`. The only kind accepted: the code never leaves the user's machine.
 */
export function isLoopbackRedirect(uri: string): boolean {
  const url = parse(uri);
  return !!url && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password &&
    // canonical form only: GoTrue compares the strings
    !url.hash && url.href === uri;
}

/** Same loopback redirect URI except for the port: RFC 8252 §7.3 lets a native client pick its port at each sign-in. */
export function sameLoopbackExceptPort(a: string, b: string): boolean {
  if (!isLoopbackRedirect(a) || !isLoopbackRedirect(b)) return false;
  const [x, y] = [new URL(a), new URL(b)];
  return x.hostname === y.hostname && x.pathname === y.pathname && x.search === y.search;
}

/**
 * The redirect URIs to store on the client so that GoTrue (exact match) accepts `requested`: null when it is already
 * registered, the new list when only its port differs from a registered loopback URI, and an error otherwise.
 */
export function redirectsToRegister(registered: string[], requested: string): string[] | null {
  if (registered.includes(requested)) return null;
  if (!registered.some((uri) => sameLoopbackExceptPort(uri, requested))) {
    throw new OAuthError("invalid_request", "redirect_uri is not registered for this client");
  }
  const loopback = registered.filter(isLoopbackRedirect);
  const kept = loopback.slice(Math.max(0, loopback.length - (MAX_LOOPBACK_REDIRECTS - 1)));
  return [...registered.filter((uri) => !isLoopbackRedirect(uri)), ...kept, requested];
}

export interface Registration {
  redirect_uris: string[];
  client_name?: string;
  client_uri?: string;
  token_endpoint_auth_method: "none";
  grant_types: string[];
}

/**
 * Dynamic client registration (RFC 7591), restricted to public native clients: loopback redirect URIs only, no
 * secret, authorization code and refresh token grants. Other metadata is dropped.
 */
export function sanitizeRegistration(body: unknown): Registration {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const uris = input.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_LOOPBACK_REDIRECTS) {
    throw new OAuthError("invalid_redirect_uri", `redirect_uris must list 1 to ${MAX_LOOPBACK_REDIRECTS} URIs`);
  }
  for (const uri of uris) {
    if (typeof uri !== "string" || !isLoopbackRedirect(uri)) {
      throw new OAuthError(
        "invalid_redirect_uri",
        "only native clients are accepted: redirect URIs must be http://localhost, http://127.0.0.1 or http://[::1]",
      );
    }
  }
  const method = input.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    throw new OAuthError("invalid_client_metadata", "only public clients are accepted (token_endpoint_auth_method none)");
  }
  const grants = input.grant_types ?? ["authorization_code", "refresh_token"];
  if (!Array.isArray(grants) || grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    throw new OAuthError("invalid_client_metadata", "grant_types: authorization_code and refresh_token only");
  }
  const text = (value: unknown, max: number) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
  const clientUri = text(input.client_uri, 2048);
  return {
    redirect_uris: [...new Set(uris as string[])],
    client_name: text(input.client_name, 100),
    ...(clientUri && /^https:\/\//.test(clientUri) ? { client_uri: clientUri } : {}),
    token_endpoint_auth_method: "none",
    grant_types: [...new Set(["authorization_code", ...(grants as string[])])],
  };
}

const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;

/**
 * Checks of an authorization request made once client_id and redirect_uri are known to be valid (the errors are then
 * sent back to the client's redirect URI): code flow, PKCE with S256 only (GoTrue also accepts "plain"), and the
 * resource indicator (RFC 8707), when present, must be the MCP endpoint.
 */
export function checkAuthorizeRequest(query: Record<string, string | undefined>, resource: string) {
  if ((query.response_type ?? "code") !== "code") throw new OAuthError("unsupported_response_type", "only response_type=code is supported");
  if (query.code_challenge_method !== "S256") {
    throw new OAuthError("invalid_request", "PKCE is required, with code_challenge_method=S256");
  }
  if (!query.code_challenge || !PKCE_CHALLENGE_RE.test(query.code_challenge)) {
    throw new OAuthError("invalid_request", "code_challenge must be a base64url SHA-256 (43 to 128 characters)");
  }
  if (query.resource !== undefined && query.resource !== resource) {
    throw new OAuthError("invalid_target", `resource must be ${resource}`);
  }
}

/** The error redirect of RFC 6749 §4.1.2.1. */
export function errorRedirect(redirectUri: string, error: OAuthError, state: string | undefined) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error.error);
  url.searchParams.set("error_description", error.description);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

/** Whether a code approved at `approvedAt` may still be exchanged at `now`. */
export const codeFresh = (approvedAt: Date | null, now: Date) =>
  approvedAt !== null && now.getTime() - approvedAt.getTime() <= CODE_TTL_SECONDS * 1000;
