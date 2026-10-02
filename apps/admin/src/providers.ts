// Data and auth providers: the stock ra-data-simple-rest provider on the same-origin admin API (/api), and the
// platform session cookie (POST /api/auth/login). Mutations carry X-Platform-Admin, which the API requires on cookie
// requests (CSRF guard, see apps/control-plane/src/admin/site.ts).
import { type AuthProvider, fetchUtils, HttpError } from "ra-core";
import simpleRestProvider from "ra-data-simple-rest";

export const API = "/api";

export const httpClient = (url: string, options: fetchUtils.Options = {}) => {
  const headers = new Headers(options.headers ?? { Accept: "application/json" });
  headers.set("X-Platform-Admin", "1");
  return fetchUtils.fetchJson(url, { ...options, headers, credentials: "same-origin" });
};

export const dataProvider = simpleRestProvider(API, httpClient);

/** Custom endpoints (app actions, logs, dashboard). */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { json } = await httpClient(`${API}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return json as T;
}

export interface Identity {
  id: string;
  email: string;
  fullName: string;
  role: string;
}

let identity: Identity | null = null;

async function me(): Promise<Identity> {
  const response = await fetch(`${API}/auth/me`, { credentials: "same-origin" });
  if (!response.ok) {
    identity = null;
    throw new HttpError("Not signed in", response.status);
  }
  identity = (await response.json()) as Identity;
  return identity;
}

async function post(path: string, body?: unknown) {
  return fetch(`${API}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Platform-Admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const authProvider: AuthProvider = {
  async login({ email, password }: { email: string; password: string }) {
    const response = await post("/auth/login", { email, password });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.message ?? `Sign in failed (${response.status})`);
    identity = json as Identity;
  },
  async logout() {
    identity = null;
    await post("/auth/logout").catch(() => undefined);
  },
  async checkAuth() {
    if (!identity) await me();
  },
  async checkError(error: { status?: number }) {
    if (error?.status === 401) {
      identity = null;
      throw error;
    }
  },
  async getIdentity() {
    return identity ?? (await me());
  },
};
