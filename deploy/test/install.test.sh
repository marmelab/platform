#!/usr/bin/env bash
# Checks how deploy/install.sh resolves its production values, without Docker: the --env-file / environment contract
# of infra/README.md (precedence: option, environment, value kept in deploy/.env, prompt). A copy of deploy/ runs
# with a fake docker on PATH that stops the installer at `docker compose up`, once deploy/.env is written.
# Usage: deploy/test/install.test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
failures=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; failures=$((failures + 1)); }
check() { local name="$1"; shift; if "$@" > "$tmp/out" 2>&1; then pass "$name"; else fail "$name"; cat "$tmp/out" >&2; fi; }

cp "$ROOT/deploy/install.sh" "$ROOT/deploy/docker-compose.yml" "$tmp"
mkdir -p "$tmp/bin"
cat > "$tmp/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
# image inspect: every image is present; compose up: stop here (deploy/.env is complete); anything else: ok
case "$1 ${2:-}" in "image inspect") exit 0 ;; esac
[ "$1" = compose ] && [[ " $* " == *" up "* ]] && exit 42
exit 0
DOCKER
chmod +x "$tmp/bin/docker"
# install [options]: runs the copied installer in production mode, expects the stop at compose up
install() { PATH="$tmp/bin:$PATH" "$tmp/install.sh" --production --non-interactive --skip-checks "$@"; [ $? = 42 ]; }
value() { sed -n "s/^$1=//p" "$tmp/.env" | tail -1; }
expect() { local name="$1" key="$2" want="$3"; local got; got="$(value "$key")"; if [ "$got" = "$want" ]; then pass "$name"; else fail "$name: $key=$got, expected $want"; fi; }

cat > "$tmp/infra.env" <<'ENV'
PLATFORM_DOMAIN=apps.example.com
ACME_EMAIL=ops@example.com
ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory
ADMIN_EMAIL=alice.admin@example.com
SMTP_HOST=email-smtp.eu-west-3.amazonaws.com
SMTP_PORT=2587
SMTP_USER=AKIAEXAMPLE
SMTP_PASSWORD=smtp+secret/with=base64
SMTP_SENDER_EMAIL=hello@apps.example.com
CI_ALLOWED_WORKFLOWS=example/platform/.github/workflows/deploy.yml@refs/heads/main
OIDC_ISSUER=https://github.example.com/_services/token
BACKUP_S3_ENDPOINT=https://s3.eu-west-3.amazonaws.com
BACKUP_S3_BUCKET=example-backups
BACKUP_S3_REGION=eu-west-3
BACKUP_S3_ACCESS_KEY_ID=AKIABACKUP
BACKUP_S3_SECRET_ACCESS_KEY=s3+secret/with=base64
ENV

# 1. First install from the env file alone: every key lands in deploy/.env, nothing is asked
check "install from --env-file" install --env-file "$tmp/infra.env"
expect "domain" PLATFORM_DOMAIN apps.example.com
expect "ACME email" ACME_EMAIL ops@example.com
expect "ACME CA" ACME_CA https://acme-staging-v02.api.letsencrypt.org/directory
expect "SMTP host" SMTP_HOST email-smtp.eu-west-3.amazonaws.com
expect "SMTP port" SMTP_PORT 2587
expect "SMTP user" SMTP_USER AKIAEXAMPLE
expect "SMTP password" SMTP_PASSWORD smtp+secret/with=base64
expect "SMTP sender" SMTP_SENDER_EMAIL hello@apps.example.com
expect "allowed workflows" CI_ALLOWED_WORKFLOWS example/platform/.github/workflows/deploy.yml@refs/heads/main
expect "OIDC issuer" OIDC_ISSUER https://github.example.com/_services/token
expect "S3 endpoint" BACKUP_S3_ENDPOINT https://s3.eu-west-3.amazonaws.com
expect "S3 bucket" BACKUP_S3_BUCKET example-backups
expect "S3 region" BACKUP_S3_REGION eu-west-3
expect "S3 access key" BACKUP_S3_ACCESS_KEY_ID AKIABACKUP
expect "S3 secret" BACKUP_S3_SECRET_ACCESS_KEY s3+secret/with=base64
check "the env file does not leak into the compose project" bash -c "! grep -q '^ADMIN_EMAIL=' '$tmp/.env'"
echo "PLATFORM_ADMIN_EMAIL=alice.admin@example.com" > "$tmp/.env.local" # what a completed first install leaves

# 2. An option wins over the env file
check "install with an option and the env file" install --env-file "$tmp/infra.env" --smtp-host relay.example.com --backup-s3-region us-east-1
expect "option over env file (SMTP host)" SMTP_HOST relay.example.com
expect "option over env file (S3 region)" BACKUP_S3_REGION us-east-1

# 3. The environment wins over the value kept in deploy/.env; a relative --env-file path is taken from the caller's directory
printf 'SMTP_HOST=other.example.com\nBACKUP_S3_BUCKET=other-backups\n' > "$tmp/other.env"
check "install with a relative --env-file" bash -c "cd '$tmp' && PATH='$tmp/bin:$PATH' ./install.sh --production --non-interactive --skip-checks --env-file other.env; [ \$? = 42 ]"
expect "env file over stored value (SMTP host)" SMTP_HOST other.example.com
expect "env file over stored value (S3 bucket)" BACKUP_S3_BUCKET other-backups
expect "stored value kept when the env file is silent (S3 endpoint)" BACKUP_S3_ENDPOINT https://s3.eu-west-3.amazonaws.com

# 4. Exported variables work like the env file; a stored value is kept without option, environment or prompt
SMTP_HOST=exported.example.com check "install with an exported variable" install
expect "exported variable over stored value" SMTP_HOST exported.example.com
check "install with nothing" install
expect "stored value kept (SMTP host)" SMTP_HOST exported.example.com
expect "stored value kept (domain)" PLATFORM_DOMAIN apps.example.com

# 5. A missing env file is refused
check "missing --env-file is refused" bash -c "PATH='$tmp/bin:$PATH' '$tmp/install.sh' --production --non-interactive --env-file '$tmp/none.env' 2>&1 | grep -q 'not found'"

echo
if [ "$failures" -gt 0 ]; then echo "$failures check(s) failed" >&2; exit 1; fi
echo "all checks passed"
