export interface AppLimits {
  memory_mb?: number;
  cpu_soft_ms?: number;
  cpu_hard_ms?: number;
  wall_clock_ms?: number;
}

export interface AppConfig {
  app: string;
  jwt_secret: string;
  env: Record<string, string>;
  limits?: AppLimits;
}

export interface FunctionSettings {
  verify_jwt?: boolean;
}

export interface FunctionsManifest {
  functions?: Record<string, FunctionSettings>;
}

interface CacheEntry<T> {
  ino: number | null;
  mtime: number;
  size: number;
  value: T;
  hash: string;
}

export interface Loaded<T> {
  value: T;
  hash: string;
}

const cache = new Map<string, CacheEntry<unknown>>();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loadJsonFile<T>(
  path: string,
  validate: (value: unknown) => T,
): Promise<Loaded<T> | null> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      cache.delete(path);
      return null;
    }
    throw error;
  }
  const mtime = stat.mtime?.getTime() ?? 0;
  const cached = cache.get(path) as CacheEntry<T> | undefined;
  if (cached && cached.ino === stat.ino && cached.mtime === mtime && cached.size === stat.size) {
    return { value: cached.value, hash: cached.hash };
  }
  const text = await Deno.readTextFile(path);
  const value = validate(JSON.parse(text));
  const hash = await sha256Hex(text);
  cache.set(path, { ino: stat.ino, mtime, size: stat.size, value, hash });
  return { value, hash };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string");
}

export function validateAppConfig(expectedApp: string) {
  return (value: unknown): AppConfig => {
    const config = value as AppConfig;
    if (!config || typeof config !== "object") throw new Error("app config must be an object");
    if (config.app !== expectedApp) throw new Error(`app config is for "${config.app}"`);
    if (typeof config.jwt_secret !== "string" || config.jwt_secret.length < 32) {
      throw new Error("jwt_secret must be a string of at least 32 chars");
    }
    if (!isStringRecord(config.env)) throw new Error("env must be a string record");
    return config;
  };
}

export function validateManifest(value: unknown): FunctionsManifest {
  if (!value || typeof value !== "object") throw new Error("functions.json must be an object");
  return value as FunctionsManifest;
}
