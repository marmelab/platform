export type JwtFailure =
  | "UNAUTHORIZED_NO_AUTH_HEADER"
  | "UNAUTHORIZED_INVALID_JWT_FORMAT"
  | "UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM"
  | "UNAUTHORIZED_JWT";

const encoder = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    keyCache.set(secret, key);
  }
  return key;
}

function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function extractToken(headers: Headers): string | JwtFailure {
  const authorization = headers.get("authorization");
  if (!authorization) return "UNAUTHORIZED_NO_AUTH_HEADER";
  const [scheme, token, ...rest] = authorization.split(" ");
  if (scheme !== "Bearer" || !token || rest.length > 0) {
    return "UNAUTHORIZED_INVALID_JWT_FORMAT";
  }
  return token;
}

export async function verifyHs256(
  token: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): Promise<JwtFailure | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return "UNAUTHORIZED_INVALID_JWT_FORMAT";
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  const header = decodeJson(headerSegment);
  const payload = decodeJson(payloadSegment);
  if (!header || !payload) return "UNAUTHORIZED_INVALID_JWT_FORMAT";
  if (header.alg !== "HS256") return "UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM";

  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64UrlDecode(signatureSegment);
  } catch {
    return "UNAUTHORIZED_INVALID_JWT_FORMAT";
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    encoder.encode(`${headerSegment}.${payloadSegment}`),
  );
  if (!valid) return "UNAUTHORIZED_JWT";
  if (typeof payload.exp === "number" && payload.exp <= now) return "UNAUTHORIZED_JWT";
  if (typeof payload.nbf === "number" && payload.nbf > now) return "UNAUTHORIZED_JWT";
  return null;
}

export async function signHs256(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(`${header}.${body}`),
  );
  return `${header}.${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}
