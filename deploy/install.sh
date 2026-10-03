#!/usr/bin/env bash
# Dev installer: generates secrets, builds Studio, starts the "plat" stack (the control plane image also builds the
# admin console, apps/admin), initialises the cluster
# (template_supabase + platform database) and creates the first admin with a PAT and a Studio password.
# Re-runnable: secrets and the admin credentials are kept in deploy/.env and deploy/.env.local.
#   STUDIO_BUILD=1 deploy/install.sh    rebuilds the Studio image even if it exists
#   REALTIME_BUILD=1 deploy/install.sh  rebuilds the patched Realtime image (patches/realtime) even if it exists
#   deploy/install.sh --seed (or SEED=1) also seeds the app builders alice and bob and their example apps
#                                        (apps/control-plane/scripts/seed.ts, idempotent)
set -euo pipefail
cd "$(dirname "$0")"

SEED="${SEED:-0}"
for arg in "$@"; do
  case "$arg" in
    --seed) SEED=1 ;;
    *) echo "usage: deploy/install.sh [--seed]" >&2; exit 1 ;;
  esac
done

ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
API_URL="http://api.localhost:8100"
STUDIO_URL="http://studio.localhost:8100"
ADMIN_URL="http://admin.localhost:8100"

umask 077
touch .env
add_secret() {
  grep -q "^$1=" .env || { echo "$1=$(openssl rand -hex "$2")" >> .env; echo "secret $1 generated in deploy/.env"; }
}
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
# Local installs: builders may still deploy from their machine with their PAT (the e2e suites, the seed and the
# deploy skill rely on it). Production installs should use DIRECT_DEPLOY=admins (publishing through CI only).
grep -q '^DIRECT_DEPLOY=' .env || { echo "DIRECT_DEPLOY=everyone" >> .env; echo "DIRECT_DEPLOY=everyone written to deploy/.env"; }
# Local installs only (SEC-10): the CI e2e suite makes the CI API trust its fake OIDC issuer (inline oidc_jwks setting).
grep -q '^ALLOW_TEST_OIDC_JWKS=' .env || { echo "ALLOW_TEST_OIDC_JWKS=1" >> .env; echo "ALLOW_TEST_OIDC_JWKS=1 written to deploy/.env"; }
# Local installs only (M6): every email goes to the mailpit catcher (http://localhost:8025), started with the "mail"
# compose profile. Production installs set SMTP_* to the company relay and leave COMPOSE_PROFILES unset.
add_value() { grep -q "^$1=" .env || { echo "$1=$2" >> .env; echo "$1=$2 written to deploy/.env"; }; }
add_value COMPOSE_PROFILES mail,sso-test,s3-test
# installs from before M6 part 2 and M7: add the mock IdP's and the test S3 store's profiles
if grep -Eq '^COMPOSE_PROFILES=mail(,sso-test)?$' .env; then
  sed -i.bak -E 's/^COMPOSE_PROFILES=mail(,sso-test)?$/COMPOSE_PROFILES=mail,sso-test,s3-test/' .env && rm -f .env.bak
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
# company SSO. The apps' GoTrue join its network and trust its CA; nothing uses it until an admin enables SSO with it
# (see README.md, "Company SSO"). Production installs leave these unset.
add_value SSO_TEST_NETWORK plat-sso-test
add_value SSO_TEST_CA_VOLUME plat_idp-ca
umask 022

if [ "${STUDIO_BUILD:-0}" = 1 ] || ! docker image inspect plat/studio:dev >/dev/null 2>&1; then
  ../apps/studio/build.sh
fi

# Patched Realtime image (patches/realtime): the upstream image with the "broadcast changes" slot named per tenant
REALTIME_IMAGE="$(sed -n 's/^ *image: \(plat\/realtime:.*\)$/\1/p' docker-compose.yml)"
if [ "${REALTIME_BUILD:-0}" = 1 ] || ! docker image inspect "$REALTIME_IMAGE" >/dev/null 2>&1; then
  ../patches/realtime/build.sh
fi

docker compose -p plat up -d --build

echo -n "waiting for the control plane"
for _ in $(seq 1 120); do
  if curl -fsS "$API_URL/health" >/dev/null 2>&1; then echo " ok"; break; fi
  echo -n "."
  sleep 1
done
curl -fsS "$API_URL/health" >/dev/null || { echo; docker logs --tail 50 plat-control-plane; exit 1; }

docker exec plat-control-plane node src/cli.ts init

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
fi
if ! grep -q '^PLATFORM_ADMIN_PASSWORD=' .env.local; then
  ADMIN_EMAIL_SAVED="$(sed -n 's/^PLATFORM_ADMIN_EMAIL=//p' .env.local)"
  PASSWORD="$(docker exec plat-control-plane node src/cli.ts set-password "${ADMIN_EMAIL_SAVED:-$ADMIN_EMAIL}" --generate)"
  echo "PLATFORM_ADMIN_PASSWORD=$PASSWORD" >> .env.local
  echo "Password of the admin (Studio, admin console) saved in deploy/.env.local (PLATFORM_ADMIN_PASSWORD)"
fi
echo
echo "MCP endpoint: $API_URL/mcp  (Authorization: Bearer \$PLATFORM_TOKEN)"
echo "Studio:       $STUDIO_URL  (admin: PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD from deploy/.env.local)"
echo "Admin:        $ADMIN_URL  (same credentials; admins only)"
grep -q '^SMTP_HOST=mailpit$' .env && echo "Emails:       http://localhost:8025  (mailpit: every email sent by the platform and its apps)"

if [ "$SEED" = 1 ]; then
  node ../apps/control-plane/scripts/seed.ts
fi
