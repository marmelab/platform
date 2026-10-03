#!/usr/bin/env bash
# Platform installer (journey A1, docs/INSTALL.md). Generates the secrets, builds the Studio and Realtime images, starts
# the "plat" compose project (the control plane image also builds the admin console), initialises the cluster
# (template_supabase + platform database) and creates the first admin. Re-runnable: the secrets and settings are kept
# in deploy/.env, the admin credentials in deploy/.env.local (both readable by their owner only).
#
# Local mode (default): http://<host>.localhost:8100, DIRECT_DEPLOY=everyone, test services (Mailpit, mock IdP, test
# S3 store) and the test-only flags the e2e suites need.
#   deploy/install.sh [--seed]
#     --seed (or SEED=1)  also seeds the app builders alice and bob and their example apps (apps/control-plane/scripts/seed.ts)
#
# Production mode: https://{api,admin,studio,<app>}.<domain>, certificates obtained on demand by Caddy (Let's Encrypt)
# for the hosts the control plane approves, DIRECT_DEPLOY=admins, no test service or flag.
#   deploy/install.sh --production --domain platform.example.com --acme-email ops@example.com --admin-email me@example.com
#     --internal-tls               Caddy's internal CA instead of Let's Encrypt (tests, private networks)
#     --acme-ca <url>              ACME directory, e.g. https://acme-staging-v02.api.letsencrypt.org/directory
#     --smtp-host <host> --smtp-port <port> --smtp-user <user> --smtp-password-file <file> --smtp-sender <email>
#     --github-org <org> [--platform-repo platform] [--workflow-ref refs/heads/main]   (sets CI_ALLOWED_WORKFLOWS)
#     --ci-allowed-workflows <list>  the full CI_ALLOWED_WORKFLOWS value instead
#     --oidc-issuer <url>          GitHub Enterprise Server: https://<host>/_services/token
#     --backup-s3-endpoint <url> --backup-s3-bucket <name> --backup-s3-region <region>
#     --backup-s3-access-key <id> --backup-s3-secret-file <file>
#     --non-interactive            never prompt (unset optional values stay unset)
#     --skip-checks                skip the prerequisites check (not recommended)
#   A value given once is kept in deploy/.env: re-run deploy/install.sh (no option needed) to apply a code update
#   or a change made by hand in deploy/.env, or with options to change them. deploy/upgrade.sh upgrades a platform.
#   --local switches an install back to the local mode.
# Environment: STUDIO_BUILD=1 rebuilds the Studio image, REALTIME_BUILD=1 the patched Realtime image (patches/realtime).
set -euo pipefail
cd "$(dirname "$0")"

usage() { sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1; }

SEED="${SEED:-0}"
MODE=""
INTERACTIVE=1
[ -t 0 ] || INTERACTIVE=0
SKIP_CHECKS=0
# options with a value land in OPT_<NAME> (--smtp-host -> OPT_SMTP_HOST); no associative array: macOS ships bash 3.2
while [ $# -gt 0 ]; do
  case "$1" in
    --seed) SEED=1 ;;
    --production) MODE=production ;;
    --local) MODE=local ;;
    --internal-tls) OPT_TLS_MODE=internal ;;
    --non-interactive) INTERACTIVE=0 ;;
    --skip-checks) SKIP_CHECKS=1 ;;
    --domain|--acme-email|--acme-ca|--admin-email|--smtp-host|--smtp-port|--smtp-user|--smtp-password-file|--smtp-sender|\
    --github-org|--platform-repo|--workflow-ref|--ci-allowed-workflows|--oidc-issuer|--backup-s3-endpoint|\
    --backup-s3-bucket|--backup-s3-region|--backup-s3-access-key|--backup-s3-secret-file)
      [ $# -ge 2 ] || usage
      name="$(printf '%s' "${1#--}" | tr 'a-z-' 'A-Z_')"
      printf -v "OPT_$name" '%s' "$2"
      shift ;;
    -h|--help) usage ;;
    *) echo "unknown option $1" >&2; usage ;;
  esac
  shift
done

umask 077
touch .env
chmod 600 .env
get_value() { sed -n "s/^$1=//p" .env | tail -1; }
# set_value KEY VALUE: adds or replaces; remove_value KEY: deletes; add_value KEY VALUE: only when missing
set_value() {
  local tmp
  tmp="$(mktemp .env.XXXXXX)"
  grep -v "^$1=" .env > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  mv "$tmp" .env
}
remove_value() {
  grep -q "^$1=" .env || return 0
  local tmp
  tmp="$(mktemp .env.XXXXXX)"
  grep -v "^$1=" .env > "$tmp" || true
  mv "$tmp" .env
  echo "$1 removed from deploy/.env"
}
add_value() { grep -q "^$1=" .env || { set_value "$1" "$2"; echo "$1=$2 written to deploy/.env"; }; }
add_secret() {
  grep -q "^$1=" .env || { set_value "$1" "$(openssl rand -hex "$2")"; echo "secret $1 generated in deploy/.env"; }
}
warn() { printf '\033[33mWARNING:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
ask() { # ask VAR "question" [default]: prompts only in interactive mode, keeps an existing value
  local current="${!1:-}" answer
  [ -n "$current" ] && return 0
  [ "$INTERACTIVE" = 1 ] || { printf -v "$1" '%s' "${3:-}"; return 0; }
  read -r -p "$2${3:+ [$3]}: " answer
  printf -v "$1" '%s' "${answer:-${3:-}}"
}

# The mode: the option, else the one recorded by the previous run, else local.
PREVIOUS_MODE="$(get_value PLATFORM_MODE)"
MODE="${MODE:-${PREVIOUS_MODE:-local}}"
if [ "$MODE" = production ] && [ "$SEED" = 1 ]; then die "--seed is for local installs only"; fi

# --------------------------------------------------------------------------------------------------------------
# Prerequisites (production): Docker, memory, disk, ports, DNS
check_prerequisites() {
  local domain="$1" ok=1
  command -v docker >/dev/null || die "docker is not installed"
  command -v openssl >/dev/null || die "openssl is not installed"
  command -v curl >/dev/null || die "curl is not installed"
  local docker_version compose_version
  docker_version="$(docker version -f '{{.Server.Version}}' 2>/dev/null)" || die "the Docker daemon is not reachable"
  [ "${docker_version%%.*}" -ge 24 ] 2>/dev/null || { warn "Docker $docker_version: 24 or later is required"; ok=0; }
  compose_version="$(docker compose version --short 2>/dev/null)" || die "the Docker compose plugin (docker compose) is missing"
  case "$compose_version" in v1.*|1.*) warn "docker compose $compose_version: 2.20 or later is required"; ok=0 ;; esac
  local mem_kb mem_gb
  mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  mem_gb=$((mem_kb / 1024 / 1024))
  if [ "$mem_gb" -lt 7 ]; then warn "${mem_gb} GB of RAM: at least 8 GB are needed (16 GB recommended for 50 apps)"; ok=0
  elif [ "$mem_gb" -lt 15 ]; then warn "${mem_gb} GB of RAM: 16 GB are recommended for 50 apps"; fi
  local docker_root disk_gb
  docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  disk_gb="$(df -Pk "$docker_root" 2>/dev/null | awk 'NR == 2 {print int($4 / 1024 / 1024)}')"
  if [ "${disk_gb:-0}" -lt 20 ]; then warn "${disk_gb:-?} GB free for Docker ($docker_root): 20 GB or more are needed (images ~6 GB, databases, backups)"; ok=0; fi
  for port in 80 443; do
    local holder=""
    if command -v ss >/dev/null; then holder="$(ss -Hltn "sport = :$port" 2>/dev/null | head -1)"; fi
    if [ -n "$holder" ] && ! docker port plat-caddy 2>/dev/null | grep -q ":$port\$"; then
      warn "port $port is already in use on this host: stop that service (the platform's Caddy needs 80 and 443)"; ok=0
    fi
  done
  # DNS: the platform hosts and a random name under the domain (wildcard record)
  local probe="dns-check-$RANDOM$RANDOM.$domain" address host
  for host in "api.$domain" "admin.$domain" "studio.$domain" "$probe"; do
    address="$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR == 1 {print $1}')"
    if [ -z "$address" ]; then
      if [ "$host" = "$probe" ]; then
        warn "no wildcard DNS record: $host does not resolve. Create *.$domain (A record) pointing to this host's public address, or every app's URL will fail (docs/INSTALL.md, DNS)"
      else
        warn "$host does not resolve: create *.$domain (A record) pointing to this host (docs/INSTALL.md, DNS)"
      fi
      ok=0
    fi
  done
  [ "$ok" = 1 ] && echo "prerequisites: ok (Docker $docker_version, compose $compose_version, ${mem_gb} GB RAM, ${disk_gb} GB free)"
  if [ "$ok" = 0 ] && [ "$INTERACTIVE" = 1 ]; then
    read -r -p "Some prerequisites are not met (see above). Continue anyway? [y/N] " answer
    [ "${answer:-n}" = y ] || [ "${answer:-n}" = Y ] || exit 1
  fi
  return 0
}

# --------------------------------------------------------------------------------------------------------------
# Secrets (both modes): generated once, kept in deploy/.env
add_secret POSTGRES_PASSWORD 16
add_secret PLATFORM_MASTER_KEY 32
add_secret PLATFORM_GATEWAY_TOKEN 32
add_secret PLATFORM_EDGE_ADMIN_TOKEN 32
add_secret PLATFORM_STUDIO_HEADER_SECRET 32
add_secret PLATFORM_STUDIO_CONFIG_TOKEN 32
add_secret PG_META_CRYPTO_KEY 32
add_secret STUDIO_META_DEFAULT_PASSWORD 16
# Storage and Realtime (M5). REALTIME_DB_ENC_KEY: 16 characters (AES-128 key of the tenants' database settings)
add_secret STORAGE_DB_PASSWORD 16
add_secret STORAGE_ADMIN_KEY 32
add_secret STORAGE_ENCRYPTION_KEY 32
add_secret REALTIME_DB_PASSWORD 16
add_secret REALTIME_API_JWT_SECRET 32
add_secret REALTIME_DB_ENC_KEY 8
add_secret REALTIME_SECRET_KEY_BASE 32
# Connection pooler (apps/control-plane/README.md, "Connection pooler"): its auth_query role and its admin console user
add_secret POOLER_AUTH_PASSWORD 16
add_secret POOLER_ADMIN_PASSWORD 16

# Values of the production mode, removed when switching back to the local mode
PRODUCTION_KEYS=(PLATFORM_DOMAIN PUBLIC_SCHEME PUBLIC_PORT TLS_MODE ACME_EMAIL ACME_CA CADDY_HTTP_PUBLISH CADDY_HTTP_PORT
  CADDY_HTTPS_PUBLISH STUDIO_PUBLIC_URL)
# Values of the local mode (test services and test-only flags), removed by the production mode
LOCAL_KEYS=(ALLOW_TEST_OIDC_JWKS SSO_TEST_NETWORK SSO_TEST_CA_VOLUME S3_TEST_SECRET_KEY)

if [ "$MODE" = local ]; then
  if [ "$PREVIOUS_MODE" = production ]; then
    echo "switching this install from the production mode to the local mode"
    for key in "${PRODUCTION_KEYS[@]}"; do remove_value "$key"; done
    set_value DIRECT_DEPLOY everyone
    remove_value COMPOSE_PROFILES
    remove_value ADMIN_URL
  fi
  set_value PLATFORM_MODE local
  # Local installs: builders may still deploy from their machine with their PAT (the e2e suites, the seed and the
  # deploy skill rely on it). Production installs use DIRECT_DEPLOY=admins (publishing through CI only).
  add_value DIRECT_DEPLOY everyone
  # Local installs only (SEC-10): the CI e2e suite makes the CI API trust its fake OIDC issuer (inline oidc_jwks setting).
  add_value ALLOW_TEST_OIDC_JWKS 1
  # Local installs only (M6): every email goes to the mailpit catcher (http://localhost:8025), started with the "mail"
  # compose profile; the mock IdP (sso-test) and the test S3 store (s3-test) of the e2e suites.
  add_value COMPOSE_PROFILES mail,sso-test,s3-test
  # installs from before M6 part 2 and M7: add the mock IdP's and the test S3 store's profiles
  if grep -Eq '^COMPOSE_PROFILES=mail(,sso-test)?$' .env; then
    set_value COMPOSE_PROFILES mail,sso-test,s3-test
    echo "COMPOSE_PROFILES=mail,sso-test,s3-test written to deploy/.env"
  fi
  # Local installs only (M7): secret key of the test S3 store (compose service s3, profile s3-test, access key
  # platform-test), the off-site backup target of the e2e suites
  add_secret S3_TEST_SECRET_KEY 24
  add_value SMTP_HOST mailpit
  add_value SMTP_PORT 1025
  add_value SMTP_SENDER_EMAIL noreply@platform.localhost
  add_value SMTP_SENDER_NAME Platform
  # Local installs only (M6 part 2): the mock OpenID Connect provider (compose service idp, profile sso-test) for the
  # company SSO. The apps' GoTrue join its network and trust its CA; nothing uses it until an admin enables SSO with it.
  add_value SSO_TEST_NETWORK plat-sso-test
  add_value SSO_TEST_CA_VOLUME plat_idp-ca
  ADMIN_EMAIL="${OPT_ADMIN_EMAIL:-${ADMIN_EMAIL:-admin@example.com}}"
  API_URL="http://api.localhost:8100"
  STUDIO_URL="http://studio.localhost:8100"
  ADMIN_URL="http://admin.localhost:8100"
else
  # ---------------------------------------------------------------------------------------------------------------
  # Production mode
  DOMAIN="${OPT_DOMAIN:-$(get_value PLATFORM_DOMAIN)}"
  ask DOMAIN "Platform domain (apps on <app>.<domain>, admin console on admin.<domain>)"
  [ -n "$DOMAIN" ] || die "--domain is required in production mode"
  [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "invalid domain: $DOMAIN"
  [ "$DOMAIN" != localhost ] || die "use the local mode for localhost"
  [ "$SKIP_CHECKS" = 1 ] || check_prerequisites "$DOMAIN"

  if [ "$PREVIOUS_MODE" != production ] && [ -n "$PREVIOUS_MODE" ]; then
    echo "switching this install from the local mode to the production mode"
  fi
  set_value PLATFORM_MODE production
  set_value PLATFORM_DOMAIN "$DOMAIN"
  set_value PUBLIC_SCHEME https
  set_value PUBLIC_PORT 443
  set_value STUDIO_PUBLIC_URL "https://studio.$DOMAIN"
  # Caddy: HTTPS on 443 and the HTTP -> HTTPS redirect on 80, on every interface
  set_value CADDY_HTTP_PUBLISH 80
  set_value CADDY_HTTP_PORT 80
  set_value CADDY_HTTPS_PUBLISH 443
  TLS="${OPT_TLS_MODE:-$(get_value TLS_MODE)}"
  set_value TLS_MODE "${TLS:-acme}"
  ACME_EMAIL="${OPT_ACME_EMAIL:-$(get_value ACME_EMAIL)}"
  if [ "${TLS:-acme}" = acme ]; then
    ask ACME_EMAIL "Email for Let's Encrypt (expiry and incident notices)"
    [ -n "$ACME_EMAIL" ] || warn "no --acme-email: Let's Encrypt cannot warn you about certificate problems"
  fi
  [ -n "$ACME_EMAIL" ] && set_value ACME_EMAIL "$ACME_EMAIL"
  [ -n "${OPT_ACME_CA:-}" ] && set_value ACME_CA "${OPT_ACME_CA}"
  # Production defaults: publishing through CI only, no test service, no test-only flag (SEC-10)
  set_value DIRECT_DEPLOY admins
  for key in "${LOCAL_KEYS[@]}"; do remove_value "$key"; done
  remove_value COMPOSE_PROFILES
  if [ "$(get_value SMTP_HOST)" = mailpit ]; then
    for key in SMTP_HOST SMTP_PORT SMTP_SENDER_EMAIL SMTP_SENDER_NAME; do remove_value "$key"; done
  fi

  # SMTP (M6): the company relay, for every app's emails and the platform's own
  SMTP_HOST="${OPT_SMTP_HOST:-$(get_value SMTP_HOST)}"
  ask SMTP_HOST "SMTP relay host (empty: no email; sign-ups are then confirmed automatically)"
  if [ -n "$SMTP_HOST" ]; then
    set_value SMTP_HOST "$SMTP_HOST"
    SMTP_PORT="${OPT_SMTP_PORT:-$(get_value SMTP_PORT)}"
    ask SMTP_PORT "SMTP port (465: implicit TLS, otherwise STARTTLS)" 587
    set_value SMTP_PORT "${SMTP_PORT:-587}"
    SMTP_USER="${OPT_SMTP_USER:-$(get_value SMTP_USER)}"
    ask SMTP_USER "SMTP user (empty: no authentication)"
    [ -n "$SMTP_USER" ] && set_value SMTP_USER "$SMTP_USER"
    if [ -n "${OPT_SMTP_PASSWORD_FILE:-}" ]; then
      set_value SMTP_PASSWORD "$(tr -d '\r\n' < "${OPT_SMTP_PASSWORD_FILE}")"
    elif [ -n "$SMTP_USER" ] && [ -z "$(get_value SMTP_PASSWORD)" ] && [ "$INTERACTIVE" = 1 ]; then
      read -r -s -p "SMTP password: " SMTP_PASSWORD; echo
      set_value SMTP_PASSWORD "$SMTP_PASSWORD"
    fi
    SMTP_SENDER="${OPT_SMTP_SENDER:-$(get_value SMTP_SENDER_EMAIL)}"
    ask SMTP_SENDER "Sender address of the emails" "noreply@$DOMAIN"
    set_value SMTP_SENDER_EMAIL "${SMTP_SENDER:-noreply@$DOMAIN}"
    add_value SMTP_SENDER_NAME Platform
  else
    warn "no SMTP: app sign-ups are confirmed without email, invitations return their link (TECH_DEBT CP-16)"
  fi

  # GitHub OIDC (M3bis): the reusable workflows allowed to deploy
  CI_ALLOWED="${OPT_CI_ALLOWED_WORKFLOWS:-}"
  if [ -z "$CI_ALLOWED" ] && [ -n "${OPT_GITHUB_ORG:-}" ]; then
    CI_ALLOWED="${OPT_GITHUB_ORG}/${OPT_PLATFORM_REPO:-platform}/.github/workflows/deploy.yml@${OPT_WORKFLOW_REF:-refs/heads/main}"
  fi
  CI_ALLOWED="${CI_ALLOWED:-$(get_value CI_ALLOWED_WORKFLOWS)}"
  if [ -z "$CI_ALLOWED" ] && [ "$INTERACTIVE" = 1 ]; then
    read -r -p "GitHub organization of the company (empty: set CI_ALLOWED_WORKFLOWS later): " ORG
    if [ -n "$ORG" ]; then
      read -r -p "Repository of the plugin marketplace and the reusable workflow [platform]: " REPO
      CI_ALLOWED="$ORG/${REPO:-platform}/.github/workflows/deploy.yml@refs/heads/main"
    fi
  fi
  if [ -n "$CI_ALLOWED" ]; then set_value CI_ALLOWED_WORKFLOWS "$CI_ALLOWED"
  else warn "CI_ALLOWED_WORKFLOWS is empty: no CI deployment is accepted until you set it (docs/INSTALL.md, GitHub)"; fi
  [ -n "${OPT_OIDC_ISSUER:-}" ] && set_value OIDC_ISSUER "${OPT_OIDC_ISSUER}"

  # Backups (M7): an S3-compatible bucket, or the backups volume only
  S3_BUCKET="${OPT_BACKUP_S3_BUCKET:-$(get_value BACKUP_S3_BUCKET)}"
  ask S3_BUCKET "S3 bucket for the backups (empty: backups stay on this host, copy them elsewhere)"
  if [ -n "$S3_BUCKET" ]; then
    set_value BACKUP_S3_BUCKET "$S3_BUCKET"
    S3_ENDPOINT="${OPT_BACKUP_S3_ENDPOINT:-$(get_value BACKUP_S3_ENDPOINT)}"
    ask S3_ENDPOINT "S3 endpoint (e.g. https://s3.eu-west-3.amazonaws.com)"
    [ -n "$S3_ENDPOINT" ] && set_value BACKUP_S3_ENDPOINT "$S3_ENDPOINT"
    S3_REGION="${OPT_BACKUP_S3_REGION:-$(get_value BACKUP_S3_REGION)}"
    ask S3_REGION "S3 region" us-east-1
    set_value BACKUP_S3_REGION "${S3_REGION:-us-east-1}"
    S3_KEY="${OPT_BACKUP_S3_ACCESS_KEY:-$(get_value BACKUP_S3_ACCESS_KEY_ID)}"
    ask S3_KEY "S3 access key id"
    [ -n "$S3_KEY" ] && set_value BACKUP_S3_ACCESS_KEY_ID "$S3_KEY"
    if [ -n "${OPT_BACKUP_S3_SECRET_FILE:-}" ]; then
      set_value BACKUP_S3_SECRET_ACCESS_KEY "$(tr -d '\r\n' < "${OPT_BACKUP_S3_SECRET_FILE}")"
    elif [ -z "$(get_value BACKUP_S3_SECRET_ACCESS_KEY)" ] && [ "$INTERACTIVE" = 1 ]; then
      read -r -s -p "S3 secret access key: " S3_SECRET; echo
      set_value BACKUP_S3_SECRET_ACCESS_KEY "$S3_SECRET"
    fi
  else
    warn "no S3 bucket: backups stay on this host's backups volume (copy them elsewhere, docs/INSTALL.md)"
  fi

  ADMIN_EMAIL="${OPT_ADMIN_EMAIL:-}"
  if ! grep -q '^PLATFORM_ADMIN_EMAIL=' .env.local 2>/dev/null; then
    ask ADMIN_EMAIL "Email of the first admin"
    [ -n "$ADMIN_EMAIL" ] || die "--admin-email is required for the first admin"
  fi
  API_URL="https://api.$DOMAIN"
  STUDIO_URL="https://studio.$DOMAIN"
  ADMIN_URL="https://admin.$DOMAIN"
fi
umask 022

# --------------------------------------------------------------------------------------------------------------
# Images and startup
if [ "${STUDIO_BUILD:-0}" = 1 ] || ! docker image inspect plat/studio:dev >/dev/null 2>&1; then
  ../apps/studio/build.sh
fi

# Patched Realtime image (patches/realtime): the upstream image with the "broadcast changes" slot named per tenant
REALTIME_IMAGE="$(sed -n 's/^ *image: \(plat\/realtime:.*\)$/\1/p' docker-compose.yml)"
if [ "${REALTIME_BUILD:-0}" = 1 ] || ! docker image inspect "$REALTIME_IMAGE" >/dev/null 2>&1; then
  ../patches/realtime/build.sh
fi

if [ "$MODE" = production ]; then
  # test services of a former local install (compose profiles): stopped and removed
  docker compose -p plat --profile mail --profile sso-test --profile s3-test rm -sf mailpit idp s3 >/dev/null 2>&1 || true
fi
docker compose -p plat up -d --build

cp_health() {
  docker exec plat-control-plane node -e \
    "fetch('http://localhost:3000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null
}
echo -n "waiting for the control plane"
for _ in $(seq 1 180); do
  if cp_health; then echo " ok"; break; fi
  echo -n "."
  sleep 1
done
cp_health || { echo; docker logs --tail 50 plat-control-plane; exit 1; }

docker exec plat-control-plane node src/cli.ts init

if [ "$MODE" = production ]; then
  # test-only settings a former local install may have left in the database (SEC-10)
  docker exec plat-control-plane node src/cli.ts unset-setting oidc_jwks >/dev/null
  settings="$(docker exec plat-control-plane node src/cli.ts settings)"
  grep -q '"directDeploy": "everyone"' <<<"$settings" &&
    warn "the direct_deploy setting (database) overrides DIRECT_DEPLOY=admins: run 'docker exec plat-control-plane node src/cli.ts unset-setting direct_deploy'"
fi

umask 077
touch .env.local
if ! grep -q '^PLATFORM_TOKEN=' .env.local; then
  TOKEN="$(docker exec plat-control-plane node src/cli.ts create-user "$ADMIN_EMAIL" admin install)"
  {
    echo "PLATFORM_URL=$API_URL/mcp"
    echo "PLATFORM_ADMIN_EMAIL=$ADMIN_EMAIL"
    echo "PLATFORM_TOKEN=$TOKEN"
  } >> .env.local
  echo "Admin $ADMIN_EMAIL created, personal access token saved in deploy/.env.local (PLATFORM_TOKEN)"
elif ! grep -qx "PLATFORM_URL=$API_URL/mcp" .env.local; then
  sed -i.bak "s#^PLATFORM_URL=.*#PLATFORM_URL=$API_URL/mcp#" .env.local && rm -f .env.local.bak
fi
if ! grep -q '^PLATFORM_ADMIN_PASSWORD=' .env.local; then
  ADMIN_EMAIL_SAVED="$(sed -n 's/^PLATFORM_ADMIN_EMAIL=//p' .env.local)"
  PASSWORD="$(docker exec plat-control-plane node src/cli.ts set-password "${ADMIN_EMAIL_SAVED:-$ADMIN_EMAIL}" --generate)"
  echo "PLATFORM_ADMIN_PASSWORD=$PASSWORD" >> .env.local
  echo "Password of the admin (Studio, admin console) saved in deploy/.env.local (PLATFORM_ADMIN_PASSWORD)"
fi
umask 022

if [ "$MODE" = production ]; then
  # HTTPS through Caddy, from this host (the public DNS may not point here yet): the certificate is obtained now
  CACERT=()
  if [ "$(get_value TLS_MODE)" = internal ]; then
    docker cp plat-caddy:/data/caddy/pki/authorities/local/root.crt caddy-root.crt >/dev/null 2>&1 &&
      CACERT=(--cacert caddy-root.crt) && echo "Caddy's internal CA: deploy/caddy-root.crt (trust it on the clients)"
  fi
  https_ok=0
  for _ in $(seq 1 30); do
    if curl -fsS "${CACERT[@]}" --resolve "api.$DOMAIN:443:127.0.0.1" "https://api.$DOMAIN/health" >/dev/null 2>&1; then
      https_ok=1; break
    fi
    sleep 2
  done
  if [ "$https_ok" = 1 ]; then echo "HTTPS: https://api.$DOMAIN answers with a valid certificate"
  else warn "https://api.$DOMAIN does not answer with a valid certificate yet: check the DNS records and that ports 80 and 443 are reachable from the Internet (Let's Encrypt validates through them), then 'docker logs plat-caddy'"; fi
fi

echo
echo "MCP endpoint: $API_URL/mcp  (Authorization: Bearer \$PLATFORM_TOKEN)"
echo "Studio:       $STUDIO_URL  (admin: PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD from deploy/.env.local)"
echo "Admin:        $ADMIN_URL  (same credentials; admins only)"
grep -q '^SMTP_HOST=mailpit$' .env && echo "Emails:       http://localhost:8025  (mailpit: every email sent by the platform and its apps)"
if [ "$MODE" = production ]; then
  echo
  echo "Next steps (docs/INSTALL.md): copy deploy/.env (PLATFORM_MASTER_KEY) to a safe place outside this host, publish"
  echo "the plugin marketplace and the reusable workflow, set the organization variable PLATFORM_URL=$API_URL, then"
  echo "sign in to $ADMIN_URL and change the admin password."
fi

if [ "$SEED" = 1 ]; then
  node ../apps/control-plane/scripts/seed.ts
fi
