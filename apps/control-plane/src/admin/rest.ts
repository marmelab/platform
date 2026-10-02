// ra-data-simple-rest conventions (https://github.com/marmelab/react-admin/tree/master/packages/ra-data-simple-rest):
//   GET /<resource>?sort=["field","ASC"]&range=[0,24]&filter={"q":"x"}  -> array + `Content-Range: <resource> 0-24/319`
//   GET /<resource>/<id>, POST /<resource>, PUT /<resource>/<id>, DELETE /<resource>/<id>  -> the record
// getMany sends filter={"id":[...]}, getManyReference filter={"<target>":<id>}.
import type { Context } from "hono";
import { UserError } from "../apps.ts";

export interface ListParams {
  sort: { field: string; order: "ASC" | "DESC" } | null;
  range: [number, number];
  filter: Record<string, unknown>;
}

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

const get = (row: Record<string, unknown>, path: string) =>
  path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | null)?.[key], row);

function compare(a: unknown, b: unknown) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

/**
 * Filters, sorts and paginates rows in memory: for the small resources (users, tokens, apps, members...), whose full
 * list is one query anyway. `custom` handles the filters that are not plain equality (`q`, flags...); other keys
 * compare the field (an array value means "one of").
 */
export function listInMemory<T extends Record<string, unknown>>(
  rows: T[],
  params: ListParams,
  custom: Record<string, (row: T, value: unknown) => boolean> = {},
  defaultSort?: ListParams["sort"],
) {
  let result = rows.filter((row) =>
    Object.entries(params.filter).every(([key, value]) => {
      if (value === undefined || value === "" || value === null) return true;
      if (custom[key]) return custom[key](row, value);
      const field = get(row, key);
      if (Array.isArray(value)) return value.map(String).includes(String(field));
      return String(field) === String(value);
    })
  );
  const sort = params.sort ?? defaultSort;
  if (sort) {
    const direction = sort.order === "DESC" ? -1 : 1;
    // nulls last in both directions
    result = [...result].sort((a, b) => {
      const [x, y] = [get(a, sort.field), get(b, sort.field)];
      if (x === null || x === undefined || y === null || y === undefined) return compare(x, y);
      return compare(x, y) * direction;
    });
  }
  const [start, end] = params.range;
  return { rows: result.slice(start, end + 1), total: result.length };
}

export const includes = (haystack: unknown, needle: unknown) =>
  String(haystack ?? "").toLowerCase().includes(String(needle).toLowerCase());

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
