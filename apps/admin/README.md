# Admin console

Single-page app for platform admins (PLAN_1 §8, milestone M4), built with [shadcn-admin-kit](https://github.com/marmelab/shadcn-admin-kit) (react-admin's headless core `ra-core` with shadcn/ui components, Vite, React 19, Tailwind 4). It talks to the control plane's admin REST API with the stock `ra-data-simple-rest` data provider.

- URL: http://admin.localhost:8100 (`admin.<domain>`), same origin as its API (`/api`).
- Sign in with a platform account that has the `admin` role: `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` from `deploy/.env.local` on a local install. App builders are refused.
- Screenshots of the main screens: [screenshots/](screenshots/).

## Screens

| Screen | What |
|---|---|
| Dashboard | Apps by status, flagged apps (deployed outside CI, accepted lints, abandoned), requests and 5xx of every app over 24 h with a 7-day sparkline, memory of the app containers, accounts and active tokens, Postgres cluster size, host memory, CPU load and volumes disk, failures of the last 7 days (releases, deployments, apps in error) |
| Apps | Every app, sortable and paginated, with search (slug, name, owner, repository), status filter and flag filters. Columns: name and URL, status, owners (name and email), GitHub repository link, last release (date, result, source CI / direct / admin exception, commit link, author, run link), flags (including **abandoned**), requests and 5xx over 24 h with a 7-day sparkline (requests per day, 5xx at the bottom of each bar), database size and memory of the app's containers |
| App page | Tabs. **Overview**: status, URL, "Open in Studio" deep link, repository, owners, live versions, services (containers), flags, last release, **Load** (requests and 5xx over 24 h with the error rate, database size, memory, last request, and a chart of requests per hour over 7 days with 5xx stacked, hover readout and a table view), **Auth** (read-only, M6: sign-up open or invitations only, email confirmation, allowed email domains, site and extra redirect URLs, sender of the app's emails; changed by the builders with `configure_auth`), actions **Stop**, **Start**, **Delete** (typed confirmation, final backup checkbox). **Releases**: releases with commit, diff since the previous release on GitHub, author, run link, their deployments; deployments with **Roll back to this version**. **Members**: add an existing account, switch owner / collaborator, remove (the last owner cannot be removed). **Secrets**: names only. **Schema changes**: DDL outside releases (or every recorded change). **Logs**: last hour of Docker logs per service. **Audit**: the app's audit entries |
| Users | Create (email, name, role, optional password; with the platform SMTP, an active account gets a welcome email without any secret), edit (name, role, active, new password), delete (refused while the account is the last owner of an app). The edit page lists the account's apps, tokens and audit entries |
| Tokens | Every PAT with its owner, status, last use and expiry; create one for a user (the value is shown once), revoke |
| Audit log | Every audit entry, with search and filters by app, action and user |

## How it is built and served

- The components come from the shadcn-admin-kit `admin` registry item (`src/components/admin`, `src/components/ui`, `src/lib`, `src/hooks`): like any shadcn registry, the code is copied into the app and is ours to change. The documented setup is `npx shadcn@latest init --template vite --preset vega https://marmelab.com/shadcn-admin-kit/r/admin.json`; the registry hosts (`ui.shadcn.com`, `marmelab.com`) were not reachable from the environment where this app was created, so the same files were taken from the kit's repository (commit `114f3e3`, files listed in its `registry.json`, `base-vega` style). Changes to the kit's files: the sidebar brand ("Platform admin"). Update or add components with `npx shadcn@latest add <url>` when the registry is reachable (see `components.json`).
- Our code: `src/App.tsx` (resources), `src/providers.ts` (data and auth providers), `src/resources/*` (screens), `src/resources/charts.tsx` (load sparkline and hourly chart: plain SVG, colors from the `--viz-requests` / `--viz-errors` tokens of `src/index.css`, light and dark steps of a colorblind-checked categorical pair).
- `pnpm --filter @platform/admin build` writes `dist/`. The control plane image builds it in a first Docker stage and copies it to `/repo/apps/admin/dist` (`ADMIN_STATIC_DIR`); the control plane serves it on the admin host with a strict CSP (`script-src 'self'`). `deploy/install.sh` builds the control plane image, so it builds the console too.
- Caddy proxies the admin host to the control plane (route `admin`, installed at control plane startup like the Studio route). The control plane only serves the SPA and `/api/*` on that host: MCP, the CI API and uploads are not reachable there.
- shadcn-admin-kit's usage telemetry (an image loaded from marmelab.com) is disabled (`disableTelemetry`), and the CSP would block it anyway.

## Authentication

The console uses the platform's browser sessions (the `sessions` table and `platform_session` cookie of Studio's `/_platform/login`): `POST /api/auth/login` checks the password and opens a session for admins only. The cookie is host-only on the admin host, `HttpOnly`, `SameSite=Strict`; a Domain cookie would also be sent to every `<app>.<domain>`, whose functions are written by builders. Signing in to Studio and to the console are therefore separate. Details and the CSRF protection: [control plane README](../control-plane/README.md#admin-rest-api).

## Development

```bash
pnpm --filter @platform/admin dev          # Vite dev server on :5173, /api proxied to admin.localhost:8100 (running stack)
pnpm --filter @platform/admin typecheck
pnpm --filter @platform/admin build
```

The dev proxy presents itself as the admin host (`Host` and `Origin` headers), so the session cookie and the API's Origin check work on `http://localhost:5173`. The console served on admin.localhost:8100 only changes when the control plane image is rebuilt (`docker compose -p plat -f deploy/docker-compose.yml up -d --build control-plane`).

## Tests

```bash
pnpm e2e:admin                                   # admin REST API (control plane), then this smoke test
pnpm --filter @platform/admin e2e:admin          # smoke test only: Chromium through Playwright
pnpm --filter @platform/admin screenshots        # same, and saves the screens into screenshots/
```

The smoke test signs in as the admin, finds a disposable app (created by a disposable builder through MCP, with 12 real requests counted by a forced metrics sample on top of a synthetic 7-day history written into `app_metrics`) in the apps list with its load, opens its page and its load chart, stops and starts it, and walks through the tabs and the other screens. Everything is deleted at the end of the run (`apps/control-plane/test/disposable.ts`). Playwright is pinned to the version whose Chromium is installed (`PLAYWRIGHT_BROWSERS_PATH`); install the browser with `pnpm --filter @platform/admin exec playwright install chromium` if needed.
