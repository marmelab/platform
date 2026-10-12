// Filter, sort and paginate the small admin resources in memory. No imports: unit-tested on its own.

export interface ListParams {
  sort: { field: string; order: "ASC" | "DESC" } | null;
  range: [number, number];
  filter: Record<string, unknown>;
}

const get = (row: Record<string, unknown>, path: string) =>
  path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | null)?.[key], row);

function compare(a: unknown, b: unknown) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  // timestamptz columns come back as Date: String() would sort them by weekday name
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
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

