const APP_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FUNCTION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const VERSION_RE = /^v[0-9]{1,9}$/;

export function isValidAppSlug(app: string | null): app is string {
  return !!app && APP_RE.test(app);
}

export function isValidFunctionName(name: unknown): name is string {
  return typeof name === "string" && FUNCTION_RE.test(name);
}

/** Accepts 3, "3" or "v3" and returns the version directory name ("v3"). */
export function parseVersion(version: unknown): string | null {
  const dir = typeof version === "number"
    ? `v${version}`
    : typeof version === "string"
    ? version.replace(/^(?!v)/, "v")
    : "";
  return VERSION_RE.test(dir) ? dir : null;
}

export function parseFunctionName(pathname: string): string | null {
  const name = pathname.split("/")[1] ?? "";
  return FUNCTION_RE.test(name) ? name : null;
}

export interface ResolvedFunction {
  versionDir: string;
  functionDir: string;
  entrypoint: string;
}

function isInside(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

async function realPathOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.realPath(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

export async function resolveFunction(
  functionsRoot: string,
  app: string,
  functionName: string,
  version = "current",
): Promise<ResolvedFunction | null> {
  const appRoot = await realPathOrNull(`${functionsRoot}/${app}`);
  if (!appRoot) return null;
  const versionDir = await realPathOrNull(`${appRoot}/${version}`);
  if (!versionDir || !isInside(versionDir, appRoot)) return null;
  const entrypoint = await realPathOrNull(`${versionDir}/${functionName}/index.ts`);
  if (!entrypoint || !isInside(entrypoint, `${versionDir}/${functionName}`)) return null;
  return { versionDir, functionDir: `${versionDir}/${functionName}`, entrypoint };
}
