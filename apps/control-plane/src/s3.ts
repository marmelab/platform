// Minimal S3 client for the off-site backup target (M7, backups.ts): PUT, GET, LIST and DELETE of objects, signed
// with AWS Signature V4 by aws4fetch (a maintained single-file signer, no dependency). Works with AWS S3 and the
// S3-compatible stores (Cloudflare R2, Scaleway, OVH, Garage, SeaweedFS...). Uploads stream the file with
// `x-amz-content-sha256: UNSIGNED-PAYLOAD` (the transport is TLS), in a single PUT: 5 GB per file at most (TECH_DEBT
// CP-20). Requests use Node's fetch: behind an outbound HTTP proxy, set NODE_USE_ENV_PROXY=1 with HTTPS_PROXY and a
// NO_PROXY that lists the internal services (README.md, "Backups").
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { AwsV4Signer } from "aws4fetch";
import type { S3Settings } from "./settings.ts";

/** Small requests (list, delete, head). */
const TIMEOUT_MS = 30_000;
/** Uploads and downloads: large dumps. */
const TRANSFER_TIMEOUT_MS = 6 * 3600_000;
const ATTEMPTS = 3;

export class S3Error extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

export class S3Client {
  private readonly s3: S3Settings;
  constructor(s3: S3Settings) {
    this.s3 = s3;
  }

  /** The full key of `key` under the configured prefix. */
  key(key: string) {
    return this.s3.prefix ? `${this.s3.prefix}/${key}` : key;
  }

  /** s3://<bucket>/<full key>: how a location is shown and stored. */
  location(key: string) {
    return `s3://${this.s3.bucket}/${this.key(key)}`;
  }

  /** The full key of an s3://<bucket>/<key> location of this bucket. */
  keyOf(location: string) {
    const prefix = `s3://${this.s3.bucket}/`;
    if (!location.startsWith(prefix)) {
      throw new S3Error(`${location} is not in the configured bucket ${this.s3.bucket}`);
    }
    return location.slice(prefix.length);
  }

  private url(fullKey: string, query = "") {
    const endpoint = new URL(this.s3.endpoint);
    const path = fullKey ? `/${encodeKey(fullKey)}` : "";
    if (this.s3.pathStyle) return `${endpoint.origin}/${this.s3.bucket}${path}${query}`;
    return `${endpoint.protocol}//${this.s3.bucket}.${endpoint.host}${path || "/"}${query}`;
  }

  private async request(
    method: string,
    url: string,
    { headers = {}, body, timeoutMs = TIMEOUT_MS }: {
      headers?: Record<string, string>;
      body?: () => Promise<{ stream: Readable; length: number }>;
      timeoutMs?: number;
    } = {},
  ): Promise<Response> {
    let last: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const payload = body ? await body() : null;
        const signer = new AwsV4Signer({
          url,
          method,
          headers: payload ? { ...headers, "content-length": String(payload.length) } : headers,
          accessKeyId: this.s3.accessKeyId,
          secretAccessKey: this.s3.secretAccessKey,
          service: "s3",
          region: this.s3.region,
        });
        const signed = await signer.sign();
        const response = await fetch(signed.url, {
          method,
          headers: signed.headers,
          body: payload ? (Readable.toWeb(payload.stream) as unknown as BodyInit) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
          ...(payload ? { duplex: "half" } : {}),
        } as RequestInit);
        if (response.status >= 500 || response.status === 429) {
          last = new S3Error(`S3 ${method} ${new URL(url).pathname}: HTTP ${response.status} ${await response.text()}`, response.status);
          await sleep(500 * attempt);
          continue;
        }
        return response;
      } catch (error) {
        last = error;
        if (attempt < ATTEMPTS) await sleep(500 * attempt);
      }
    }
    if (last instanceof S3Error) throw last;
    const cause = last instanceof Error ? (last.cause instanceof Error ? `${last.message}: ${last.cause.message}` : last.message) : String(last);
    throw new S3Error(`S3 ${method} ${new URL(url).host}: ${cause}`);
  }

  private async check(response: Response, what: string, accepted: number[] = []) {
    if (response.ok || accepted.includes(response.status)) return;
    const text = await response.text().catch(() => "");
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
    throw new S3Error(`S3 ${what}: HTTP ${response.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`, response.status);
  }

  /** Uploads a local file to `<prefix>/<key>`. */
  async putFile(key: string, file: string) {
    const fullKey = this.key(key);
    const response = await this.request("PUT", this.url(fullKey), {
      headers: { "content-type": "application/octet-stream" },
      body: async () => ({ stream: createReadStream(file), length: (await stat(file)).size }),
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
    await this.check(response, `PUT ${fullKey}`);
    await response.body?.cancel();
  }

  /** Downloads an object (full key) to a local file. */
  async getFile(fullKey: string, file: string) {
    const response = await this.request("GET", this.url(fullKey), { timeoutMs: TRANSFER_TIMEOUT_MS });
    await this.check(response, `GET ${fullKey}`);
    if (!response.body) throw new S3Error(`S3 GET ${fullKey}: empty body`);
    await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), createWriteStream(file, { mode: 0o600 }));
  }

  /** Objects whose full key starts with `fullPrefix`. */
  async list(fullPrefix: string): Promise<{ key: string; size: number }[]> {
    const objects: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const query = `?list-type=2&prefix=${encodeURIComponent(fullPrefix)}` +
        (token ? `&continuation-token=${encodeURIComponent(token)}` : "");
      const response = await this.request("GET", this.url("", query));
      await this.check(response, `LIST ${fullPrefix}`);
      const xml = await response.text();
      for (const [, content] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([^<]*)<\/Key>/.exec(content!)?.[1];
        const size = /<Size>(\d+)<\/Size>/.exec(content!)?.[1];
        if (key !== undefined) objects.push({ key: unescapeXml(key), size: Number(size ?? 0) });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? unescapeXml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "")
        : undefined;
    } while (token);
    return objects;
  }

  /** Deletes an object (full key); a missing object is not an error. */
  async delete(fullKey: string) {
    const response = await this.request("DELETE", this.url(fullKey));
    await this.check(response, `DELETE ${fullKey}`, [404]);
    await response.body?.cancel();
  }

  /** Deletes every object under a full key prefix. */
  async deletePrefix(fullPrefix: string) {
    for (const object of await this.list(fullPrefix)) await this.delete(object.key);
  }
}

const unescapeXml = (value: string) =>
  value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
