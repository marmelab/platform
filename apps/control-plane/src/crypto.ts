import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { config } from "./config.ts";

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const randomHex = (bytes = 16) => randomBytes(bytes).toString("hex");
export const randomToken = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.masterKey, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

export function decrypt(encoded: string): string {
  const raw = Buffer.from(encoded, "base64");
  const decipher = createDecipheriv("aes-256-gcm", config.masterKey, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

const b64url = (value: string) => Buffer.from(value).toString("base64url");

export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const head = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}

/** A stable secret derived from the master key (nothing to store): e.g. the password of a platform role. */
export const derivedSecret = (label: string) =>
  createHmac("sha256", config.masterKey).update(`platform:${label}`).digest("hex").slice(0, 40);
