// ra-data-simple-rest conventions (https://github.com/marmelab/react-admin/tree/master/packages/ra-data-simple-rest):
//   GET /<resource>?sort=["field","ASC"]&range=[0,24]&filter={"q":"x"}  -> array + `Content-Range: <resource> 0-24/319`
//   GET /<resource>/<id>, POST /<resource>, PUT /<resource>/<id>, DELETE /<resource>/<id>  -> the record
// getMany sends filter={"id":[...]}, getManyReference filter={"<target>":<id>}.
import type { Context } from "hono";
import { UserError } from "../apps.ts";

export { includes, listInMemory, type ListParams } from "./list.ts";
import type { ListParams } from "./list.ts";

export class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 405 | 409;

  constructor(status: HttpError["status"], message: string) {
    super(message);
    this.status = status;
  }
}

function json<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new HttpError(400, `invalid JSON in query: ${value}`);
  }
}

const MAX_PAGE = 500;

export function listParams(c: Context): ListParams {
  const sort = json<unknown[] | null>(c.req.query("sort"), null);
  const range = json<unknown[]>(c.req.query("range"), [0, 24]);
  const filter = json<Record<string, unknown>>(c.req.query("filter"), {});
  const start = Math.max(0, Number(range[0]) || 0);
  const end = Math.max(start, Math.min(Number(range[1]) || 0, start + MAX_PAGE - 1));
  return {
    sort: Array.isArray(sort) && typeof sort[0] === "string"
      ? { field: sort[0], order: String(sort[1]).toUpperCase() === "DESC" ? "DESC" : "ASC" }
      : null,
    range: [start, end],
    filter: filter && typeof filter === "object" && !Array.isArray(filter) ? filter : {},
  };
}

/** Sends one page with the Content-Range header the simple-rest data provider reads. */
export function page<T>(c: Context, resource: string, rows: T[], total: number, range: [number, number]) {
  const [start] = range;
  const end = rows.length ? start + rows.length - 1 : start;
  c.header("Content-Range", `${resource} ${start}-${end}/${total}`);
  return c.json(rows);
}

export const truthy = (value: unknown) => value === true || value === "true" || value === 1 || value === "1";

/** Maps domain errors to HTTP: UserError (guards, validation) 400, a stopped app 409. `{message}` is what react-admin shows. */
export function errorResponse(c: Context, error: unknown) {
  if (error instanceof HttpError) return c.json({ message: error.message }, error.status);
  if (error instanceof UserError) {
    const stopped = (error as { code?: string }).code === "APP_STOPPED";
    return c.json({ message: error.message, ...(stopped ? { code: "APP_STOPPED" } : {}) }, stopped ? 409 : 400);
  }
  if (error && typeof error === "object" && "issues" in error) {
    const issues = (error as { issues: { path: PropertyKey[]; message: string }[] }).issues;
    return c.json({ message: issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, 400);
  }
  console.error("admin api error", error);
  return c.json({ message: "internal error" }, 500);
}
