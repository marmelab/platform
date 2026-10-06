# Installation and upgrades

How to install the platform on a company's VM (journey A1 in [USER_JOURNEYS.md](USER_JOURNEYS.md)), connect it to the
company's GitHub organization, and upgrade it (A8). For a local development install, the README's "Getting started" is
enough (`deploy/install.sh`, local mode).

## 1. What gets installed

One Docker compose project (`plat`) on one VM: Postgres (one database per app), Caddy (the only entry point, HTTPS),
the control plane (API, MCP server, admin console), the shared Storage, Realtime and edge functions runtimes, a
connection pooler, Studio, and one GoTrue and one PostgREST container per app. Hosts, for a domain `<domain>`:

| Host | Serves |
|---|---|
| `api.<domain>` | MCP endpoint (`/mcp`) for Claude Code, CI deployment API (`/ci`) for GitHub Actions |
| `admin.<domain>` | Admin console (admins only) |
| `studio.<domain>` | Studio (builders see their own apps) |
| `<app>.<domain>` | Each app: frontend, `/auth/v1`, `/rest/v1`, `/storage/v1`, `/realtime/v1`, `/functions/v1` |

Certificates are obtained by Caddy from Let's Encrypt **on demand**, the first time a host is visited, and only for
the hosts above that exist: Caddy asks the control plane before requesting a certificate (`ask` endpoint), so a random
name under the wildcard DNS record gets no certificate. No DNS API access is needed.

## 2. Prerequisites

**VM**

| | Minimum | Recommended (about 50 apps) |
|---|---|---|
| OS | Linux x86_64 or arm64 with Docker Engine 24+ and the compose plugin 2.20+ | |
| RAM | 8 GB | 16 GB |
| CPU | 4 vCPU | 8 vCPU |
| Disk | 40 GB free for Docker | 100 GB+ (databases, Storage files, backups on the VM) |

The installer also needs `git`, `curl` and `openssl`, and builds two images on the VM: Studio (Node.js 24 and pnpm on
the host; the Next.js build needs about 8 GB of RAM for two minutes, TECH_DEBT STU-9: on a smaller VM, build the image
elsewhere and `docker load` it as `plat/studio:dev`) and the patched Realtime image (downloads its sources from GitHub).

**Other services**

- A **DNS zone** where you can create a wildcard record (section 3).
- An **SMTP relay** (company relay, Brevo, Scaleway TEM, SES...) for the apps' emails (sign-up confirmation, password
  reset, invitations) and the platform's own (welcome, backup failures, abandoned apps). Without SMTP, app sign-ups are
  confirmed without email and invitation links are returned to the builder (TECH_DEBT CP-16).
- An **S3-compatible bucket** for the backups (optional: without it, backups stay on the VM's `backups` volume, and you
  must copy them elsewhere).
- A **GitHub organization** (github.com, or GitHub Enterprise Server 3.5+ with Actions OIDC) holding the apps' repositories.
  The API must be reachable by the GitHub Actions runners: from the Internet for GitHub-hosted runners, or use
  self-hosted runners inside the company network.

## 3. DNS

Use a dedicated domain or subdomain, for example `apps.example.com`, and create one wildcard record pointing to the VM's
public address:

```
*.apps.example.com.   300   IN   A   203.0.113.10
```

It covers `api.`, `admin.`, `studio.` and every app. If the zone has CAA records, allow `letsencrypt.org`. The
installer checks that `api.<domain>`, `admin.<domain>`, `studio.<domain>` and a random name under the domain resolve,
and warns otherwise: a missing wildcard record breaks every app URL even when the platform hosts work.

## 4. Firewall

| Direction | Port | For |
|---|---|---|
| Inbound | 443/tcp | Everyone: browsers, Claude Code (MCP), GitHub Actions runners (deployments) |
| Inbound | 80/tcp | Redirect to HTTPS, and Let's Encrypt's HTTP challenge (must be reachable from the Internet with ACME) |
| Inbound | 22/tcp | Administration, from the company network only |
| Outbound | 443/tcp | Docker registries (images), GitHub (`token.actions.githubusercontent.com` for the OIDC keys, `raw.githubusercontent.com` for the Realtime build), npm registry (image builds, `npm:` imports of edge functions), Let's Encrypt, the S3 endpoint, the company IdP (SSO) |
| Outbound | SMTP port (587 or 465) | The SMTP relay |

Nothing else is published: Postgres and the Caddy admin API listen on the VM's loopback only (`127.0.0.1:54350` and
`127.0.0.1:2030`, TECH_DEBT RT-3). Behind a corporate proxy, see TECH_DEBT DEP-3 (`HTTPS_PROXY`,
`NODE_USE_ENV_PROXY=1`, the proxy's CA for the image builds and the edge runtime). Docker Hub's anonymous pull limit can
break the first install: log in (`docker login`) or configure a registry mirror (TECH_DEBT DEP-4).

## 5. Install

```bash
git clone <platform repository> /opt/platform && cd /opt/platform
deploy/install.sh --production --domain apps.example.com \
  --acme-email ops@example.com --admin-email alice.admin@example.com
```

Without the other options, the installer asks for the SMTP relay, the GitHub organization and the S3 bucket (empty
answers leave them unset; `--non-interactive` never asks). Everything can be given as options for an unattended
install:

```bash
deploy/install.sh --production --non-interactive --domain apps.example.com \
  --acme-email ops@example.com --admin-email alice.admin@example.com \
  --smtp-host smtp.example.com --smtp-port 587 --smtp-user platform --smtp-password-file /root/smtp-password \
  --smtp-sender noreply@apps.example.com \
  --github-org example --platform-repo platform --workflow-ref refs/heads/main \
  --backup-s3-endpoint https://s3.eu-west-3.amazonaws.com --backup-s3-bucket example-platform-backups \
  --backup-s3-region eu-west-3 --backup-s3-access-key AKIA... --backup-s3-secret-file /root/s3-secret
```

| Option | Default | |
|---|---|---|
| `--domain` | required | apps on `<app>.<domain>`, `api.`, `admin.`, `studio.` |
| `--acme-email` | none | Let's Encrypt account email (expiry notices) |
| `--acme-ca` | Let's Encrypt production | ACME directory, e.g. Let's Encrypt staging while testing |
| `--internal-tls` | off | Caddy's own CA instead of ACME: tests, or a private network whose clients trust that CA (`deploy/caddy-root.crt`) |
| `--admin-email` | required on the first run | the first admin account |
| `--smtp-*` | none | the platform SMTP (section 8) |
| `--github-org`, `--platform-repo`, `--workflow-ref` | none, `platform`, `refs/heads/main` | sets `CI_ALLOWED_WORKFLOWS` to `<org>/<repo>/.github/workflows/deploy.yml@<ref>` |
| `--ci-allowed-workflows` | none | the full value instead (comma-separated) |
| `--oidc-issuer` | `https://token.actions.githubusercontent.com` | GitHub Enterprise Server: `https://<host>/_services/token` |
| `--backup-s3-*` | none | the backups bucket (section 9) |
| `--skip-checks` | | skips the prerequisites check |

What it does:

1. checks the prerequisites (Docker and compose versions, RAM, disk, ports 80 and 443 free, DNS records) and asks
   before going on when something is missing;
2. generates the secrets (database passwords, `PLATFORM_MASTER_KEY`, tokens) into `deploy/.env` (mode 600), once;
3. writes the production settings into `deploy/.env`: `PLATFORM_MODE=production`, `PLATFORM_DOMAIN`,
   `PUBLIC_SCHEME=https`, `TLS_MODE=acme` (or `internal`), `DIRECT_DEPLOY=admins` (builders publish through CI only,
   admins directly as an audited exception), and none of the local test services or flags (no Mailpit, mock IdP or
   test S3 store, no `ALLOW_TEST_OIDC_JWKS`);
4. builds the Studio and Realtime images, starts the stack, initialises the cluster;
5. creates the first admin with a generated password and a PAT, saved in `deploy/.env.local` (mode 600);
6. checks `https://api.<domain>/health` through Caddy from the VM, which also obtains the first certificate.

Re-running `deploy/install.sh` (no option needed: the values are kept in `deploy/.env`) applies a change made in
`deploy/.env` or a code update; options given again replace the stored values. Settings can also be changed at runtime
with the CLI (`docker exec plat-control-plane node src/cli.ts set-setting <key> <value>`, see the control plane
README, "Settings"): a database setting overrides the environment.

## 6. First login

1. Read the admin's credentials: `cat deploy/.env.local` (`PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`,
   `PLATFORM_TOKEN`).
2. Sign in to `https://admin.<domain>`. On the Users screen, give yourself a new password, then delete
   `PLATFORM_ADMIN_PASSWORD` from `deploy/.env.local`. Keep the PAT for your own Claude Code (admin deployments) or
   revoke it on the Tokens screen.
3. Optionally configure the company SSO (SSO screen, OpenID Connect): builders then sign in to Studio with it.
4. Create the builders' accounts (Users). They need no token: Claude Code signs them in through the browser, on the
   platform's login page (password or company SSO). With SMTP, each new account gets a welcome email. PATs (Tokens:
   the value is shown once) are for admins, scripts and tests.
5. The dashboard shows the platform version, the apps, the backups and the security linter's alerts.

## 7. GitHub organization

Deployments go through the company's GitHub Actions (PLAN_1 §5.1 and §6.2). In the organization:

1. **Create the internal platform repository** (for example `example/platform`, internal or private). It is both the
   Claude Code plugin marketplace and the home of the reusable deploy workflow. Copy into it, from this repository:
   `plugin/` (resolving its symlinks, `cp -RL`), `.claude-plugin/marketplace.json`, `packages/deploy-cli/`, and
   `ci/.github/workflows/deploy.yml` as `.github/workflows/deploy.yml` (TECH_DEBT CI-2: the publication is manual for
   now). Replace the `YOUR-ORG/platform` placeholders, and set the default URL of `plugin/.mcp.json` to
   `https://api.<domain>/mcp`.
2. **Add the company checks** to the workflow's `company-checks` job (dependency audit, secret scanning, SAST: the
   checks the company already runs). This is what every deployment goes through.
3. **Open the repository's Actions access** to the organization: Settings > Actions > General > Access, "Accessible
   from repositories in the organization", so that app repositories can call the reusable workflow.
4. **Allow the workflow on the platform**: `CI_ALLOWED_WORKFLOWS=<org>/platform/.github/workflows/deploy.yml@refs/heads/main`
   (installer option `--github-org`). Pin a branch or a tag the security team controls: the platform accepts a
   deployment only from that exact `job_workflow_ref`, which proves that the company checks ran.
5. **Set the organization variable** `PLATFORM_URL=https://api.<domain>` (Settings > Secrets and variables > Actions >
   Variables). It is also the OIDC audience the platform expects.
6. **Branch protection**: the platform only deploys from an app's protected default branch (`ref_protected`). Use
   organization rulesets to require pull requests and reviews on the default branch of every repository, or let the
   `deploy` skill set a minimal protection per repository.
7. **Builders** install the plugin: `claude plugin marketplace add <org>/platform`, then
   `claude plugin install platform@platform-local`, and have the GitHub CLI logged in. At the first use, Claude Code
   asks them to sign in (`/mcp`, then Authenticate): the browser opens on the platform's login page, then a consent
   page. Admins who prefer a PAT export `PLATFORM_TOKEN` before starting Claude Code.

GitHub Enterprise Server: install with `--oidc-issuer https://<host>/_services/token`; the control plane must reach
that host.

## 8. Email (SMTP)

The installer writes `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SENDER_EMAIL` into `deploy/.env`.
Every app's GoTrue sends through it (sender: the app's name and the platform's address; a builder can change the
address within the same domain), and the platform sends its own emails. Use a sender domain with SPF and DKIM set up
for the relay. To change it later: `deploy/install.sh --smtp-host ...`, or the `smtp_*` settings with the CLI
(each running app's GoTrue is then recreated, without downtime). Details: control plane README, "Email".

## 9. Backups, S3 and the master key

- Every app is backed up daily at `BACKUP_HOUR` (02:00 UTC by default): database dump, Storage files, live frontend and
  functions, and the app's keys and function secrets encrypted with `PLATFORM_MASTER_KEY`. Retention: 7 daily, 4
  weekly, manual backups 30 days, final backups of deleted apps 90 days. Failures show on the dashboard and are emailed
  to the admins. Restores: admin console (app page, Backups) or CLI `restore-app` (control plane README, "Backups").
- **Use an S3 bucket** in another location than the VM (`--backup-s3-*`): give the platform a key limited to that
  bucket, and turn on the bucket's server-side encryption and versioning or object lock if available. Backups are not
  encrypted client-side (TECH_DEBT CP-19).
- **Keep a copy of `deploy/.env` outside the VM** (password manager, vault), and update it if you change it.
  `PLATFORM_MASTER_KEY` decrypts the apps' keys and secrets, in the platform database and in every backup: without it,
  a restored app gets new keys (its deployed frontend breaks) and loses its function secrets (TECH_DEBT CP-22). The
  other secrets of `deploy/.env` (database password...) are needed to restart the stack as it was.
- The platform's own database (accounts, apps, releases, settings) is dumped by `deploy/upgrade.sh` before each
  upgrade; for a daily copy, schedule `docker exec plat-db pg_dump -Fc -U supabase_admin platform` on the VM.

## 10. Hardening checklist

- [ ] Only ports 80 and 443 open to the Internet (22 from the company network); `ss -ltn` shows Postgres and the Caddy
      admin API on 127.0.0.1 only.
- [ ] `deploy/.env` and `deploy/.env.local` are mode 600, owned by root, and copied to a vault (section 9);
      `PLATFORM_ADMIN_PASSWORD` removed from `deploy/.env.local` after the first login.
- [ ] `docker exec plat-control-plane node src/cli.ts settings`: `directDeploy` is `admins`, `oidcJwks` is null,
      `ciAllowedWorkflows` pins a ref, the SMTP and backups are as expected.
- [ ] `deploy/.env` has no `ALLOW_TEST_OIDC_JWKS`, `SSO_TEST_*` or `COMPOSE_PROFILES` (the installer removes them).
- [ ] Backups go to S3 and a restore was tried once (Backups screen, on a test app).
- [ ] The admin accounts use the company SSO or strong passwords; the SSO screen's "password sign-in for admins only"
      is on once SSO works (break-glass).
- [ ] The VM's Docker socket is only reachable by root (the control plane mounts it, TECH_DEBT SEC-2).
- [ ] Unattended OS security updates, and Docker Engine updates, are scheduled.
- [ ] The dashboard is checked regularly (failed backups, apps in error, ERROR lints); the admins receive the
      platform's emails.
- [ ] Known limitations reviewed: TECH_DEBT SEC-1 (edge functions share the internal network), SEC-4, SEC-9 (no key
      rotation).

## 11. Upgrading (A8)

From the new version's checkout (`git pull` or `git checkout <tag>` in the platform directory):

```bash
deploy/upgrade.sh            # asks for confirmation; --yes for unattended runs
```

It takes a pre-upgrade backup of every app and dumps the platform's own databases, tags the current control plane,
Studio and Realtime images `rollback-<timestamp>`, builds or pulls the new images (Studio is rebuilt when
`apps/studio` changed, Realtime when its pinned version changed), restarts the changed services with `docker compose up`
(the control plane runs its idempotent schema migrations at start: `packages/sql/platform.sql` and the template's,
then `syncAll`), recycles each app's GoTrue and PostgREST one app at a time, re-applies Studio's policies on
`auth.users` and Storage's tenant migrations, runs `realtime-migrate --all` when Realtime changed, runs the security
linter on every app, and verifies the result (`verify`: shared services, each app's containers, GoTrue, PostgREST,
routes and Storage tenant). The log, the reports and the rollback instructions are written to
`deploy/upgrades/<timestamp>/` (`ROLLBACK.md`).

**Downtime.** An app's GoTrue or PostgREST container is replaced without downtime: the new container starts next to the
old one with the same network alias, the old one is stopped only once the new one answers its readiness check, and
Caddy connects to whichever answers (a container that never gets ready is removed, the old one keeps serving). The
control plane itself restarts in a few seconds (MCP, CI API, admin console and Studio sign-in unavailable meanwhile;
the apps keep serving). A new Postgres image restarts the database (every app down for its restart: the script refuses
it without `--allow-db-restart`; a major Postgres upgrade is not supported by the script). A new Caddy image restarts
Caddy (a few seconds for everyone); a new Realtime image reconnects the realtime clients.

Measured: no failed app request during an upgrade, about 2.5 s without the API (see
[Measured downtime](#measured-downtime)).

**Rollback.** Follow `deploy/upgrades/<timestamp>/ROLLBACK.md`: previous checkout, `docker tag` of the
`rollback-<timestamp>` images, `docker compose up -d --no-build`, `recycle-apps`; the platform database dump and the
apps' pre-upgrade backups are there if data must go back too.

The running version is recorded in the platform database at every start (`platform_versions`: the `VERSION` file
and the images of every platform container) and shown on the admin dashboard; `docker exec plat-control-plane node
src/cli.ts version` prints it.

### Measured downtime

On the development VM (Linux, Docker 29, 15 GB RAM), production mode with Caddy's internal CA and a fake domain in
`/etc/hosts`, two apps (`todo-app`, `notes-app`). A client per app and endpoint sent a request every 50 ms, over HTTPS
through Caddy, to `/auth/v1/health` (GoTrue), `/rest/v1/` (PostgREST) and `/` (static frontend); a request failed on
a 5xx, a network error or no answer within 3 s. Upgrade simulated by bumping `VERSION` (control plane image rebuilt
and restarted) with `--force-recycle` (each app's GoTrue and PostgREST recreated even though unchanged).

| Scenario | App requests | Failed | Longest outage per app | API (`api.<domain>`) |
|---|---|---|---|---|
| `upgrade.sh --yes --force-recycle`, 0.7.0 -> 0.7.1 (26 s in all, recycle 1.6 to 1.9 s per app) | ~27,000 | 0 | 0 ms | — |
| Same, second run, API also probed | ~10,800 | 1 (`notes-app` `/rest/v1/`, HTTP 502) | 66 ms | 26 failed, 2.4 s (control plane restart) |
| Rollback (previous control plane image, `up -d --no-build`, `recycle-apps`) | ~6,700 | 0 | 0 ms | 2 failed, 3.1 s |
| 5 x `recycle-apps --force` (10 replacements per app) after Caddy retries were added to the GoTrue and PostgREST upstreams | ~6,600 | 0 | 0 ms | — |

The one failed request of the second run hit an old PostgREST container on a pooled connection while it stopped;
Caddy now retries such requests on the new container (`load_balancing.retries` on the app upstreams), and no request
failed afterwards. Not measured: a real version change of GoTrue, PostgREST or Storage (their new migrations run at the
new container's start, before the switch), a Caddy or Postgres image change (both restart: a few seconds for every
app), and more than two apps (the recycle is sequential: about 2 s per app).

## 12. Switching a local install to production

`deploy/install.sh --production --domain ...` on an existing local install keeps its data and secrets, removes the
test services and flags and switches to HTTPS; `deploy/install.sh --local` switches back. A production platform should
still start from a fresh VM: local installs have test accounts (`--seed`) and `DIRECT_DEPLOY=everyone` releases in
their history.
