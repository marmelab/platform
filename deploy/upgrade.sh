#!/usr/bin/env bash
# Platform upgrade (journey A8, docs/INSTALL.md "Upgrading"). Run it from the new version's checkout (git pull first),
# on the host where deploy/install.sh installed the platform:
#   deploy/upgrade.sh [--yes] [--skip-backup] [--force-recycle] [--allow-db-restart]
#     --yes               no confirmation prompt
#     --skip-backup       no pre-upgrade backup (not recommended)
#     --force-recycle     recreate every app's GoTrue and PostgREST containers, even unchanged ones
#     --allow-db-restart  accept a new Postgres image (every app is down while the database restarts)
# Steps: pre-upgrade backup (every app, and dumps of the platform's own databases), rollback tags of the current images,
# new images (Studio and Realtime rebuilt when their sources changed, pinned upstream images pulled), `docker compose
# up` (the control plane's schema migrations and syncAll run at its start), rolling recycle of each app's GoTrue and
# PostgREST (a new container next to the old one, switched once ready: no downtime), Realtime tenant migrations when
# Realtime changed, security linter, verification report, rollback instructions. Everything is logged in
# deploy/upgrades/<timestamp>/.
set -euo pipefail
cd "$(dirname "$0")"

YES=0
BACKUP=1
FORCE_RECYCLE=0
ALLOW_DB_RESTART=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --skip-backup) BACKUP=0 ;;
    --force-recycle) FORCE_RECYCLE=1 ;;
    --allow-db-restart) ALLOW_DB_RESTART=1 ;;
    *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1 ;;
  esac
done

warn() { printf '\033[33mWARNING:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m== %s\033[0m (%s)\n' "$*" "$(date -u +%H:%M:%S)"; }
cli() { docker exec plat-control-plane node src/cli.ts "$@"; }
psql_platform() { docker exec plat-db psql -U supabase_admin -d platform -Atc "$1"; }
cp_health() {
  docker exec plat-control-plane node -e \
    "fetch('http://localhost:3000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null
}
image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }
container_image_id() { docker inspect -f '{{.Image}}' "$1" 2>/dev/null || true; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DIR="upgrades/$STAMP"
umask 077
mkdir -p "$DIR"
umask 022
exec > >(tee -a "$DIR/upgrade.log") 2>&1

# ------------------------------------------------------------------------------------------------------------------
step "Preflight"
[ -f .env ] || die "deploy/.env not found: install the platform with deploy/install.sh first"
[ "$(docker inspect -f '{{.State.Running}}' plat-control-plane 2>/dev/null)" = true ] ||
  die "the platform is not running (plat-control-plane): start it with deploy/install.sh"
cp_health || die "the control plane does not answer: fix it before upgrading (docker logs plat-control-plane)"
FROM="$(psql_platform "select version from platform_versions order by id desc limit 1" 2>/dev/null || true)"
FROM="${FROM:-before 0.7.0}"
TO="$(tr -d '[:space:]' < ../VERSION)"
COMMIT="$(git -C .. rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "upgrading the platform from $FROM to $TO (commit $COMMIT)"
if [ -n "$(git -C .. status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  warn "the checkout has uncommitted changes: they are deployed too"
fi
DB_IMAGE_WANTED="$(docker compose -p plat config --images 2>/dev/null | grep '^supabase/postgres:' | head -1)"
DB_IMAGE_RUNNING="$(docker inspect -f '{{.Config.Image}}' plat-db)"
if [ "$DB_IMAGE_WANTED" != "$DB_IMAGE_RUNNING" ]; then
  [ "${DB_IMAGE_WANTED%%.*}" = "${DB_IMAGE_RUNNING%%.*}" ] ||
    die "the Postgres major version changes ($DB_IMAGE_RUNNING -> $DB_IMAGE_WANTED): not supported by this script (dump and restore, docs/INSTALL.md)"
  [ "$ALLOW_DB_RESTART" = 1 ] ||
    die "the Postgres image changes ($DB_IMAGE_RUNNING -> $DB_IMAGE_WANTED): every app is down while it restarts; rerun with --allow-db-restart"
fi
APPS="$(psql_platform "select slug from apps where status in ('running', 'stopped', 'error') order by slug")"
echo "apps: $(echo "$APPS" | grep -c . || true)"
if [ "$YES" != 1 ]; then
  [ -t 0 ] || die "no terminal to confirm: rerun with --yes"
  read -r -p "Continue? [y/N] " answer
  [ "$answer" = y ] || [ "$answer" = Y ] || exit 1
fi

# ------------------------------------------------------------------------------------------------------------------
step "Pre-upgrade backup"
if [ "$BACKUP" = 1 ]; then
  # the platform's own databases: accounts, apps, releases, settings (encrypted secrets), Storage and Realtime tenants
  for db in platform platform_storage platform_realtime; do
    docker exec plat-db pg_dump --format=custom --host=localhost --username=supabase_admin "$db" > "$DIR/$db.dump"
    echo "$db: $DIR/$db.dump ($(du -h "$DIR/$db.dump" | cut -f1))"
  done
  chmod 600 "$DIR"/*.dump
  # every app: database, Storage files, live frontend and functions, secrets (manual backups, kept
  # backup_manual_retention_days; on the S3 target when configured)
  : > "$DIR/backups.txt"
  for slug in $APPS; do
    out="$(cli backup-app "$slug")" || die "the backup of $slug failed: nothing was changed (fix it, or rerun with --skip-backup)"
    id="$(printf '%s' "$out" | sed -n 's/^ *"id": "\([^"]*\)".*/\1/p' | head -1)"
    location="$(printf '%s' "$out" | sed -n 's/^ *"location": "\([^"]*\)".*/\1/p' | head -1)"
    echo "$slug $id $location" | tee -a "$DIR/backups.txt"
  done
else
  warn "--skip-backup: no pre-upgrade backup"
fi

# ------------------------------------------------------------------------------------------------------------------
step "Rollback tags of the current images"
: > "$DIR/images.before"
for container in $(docker ps -a --filter label=platform.service --format '{{.Names}}' | sort); do
  echo "$container $(docker inspect -f '{{.Config.Image}} {{.Image}}' "$container")" >> "$DIR/images.before"
done
for service in control-plane studio realtime; do
  image="$(docker inspect -f '{{.Config.Image}}' "plat-$service")"
  docker tag "$(container_image_id "plat-$service")" "${image%%:*}:rollback-$STAMP"
  echo "plat-$service: $image tagged ${image%%:*}:rollback-$STAMP"
done
REALTIME_BEFORE="$(container_image_id plat-realtime)"

# ------------------------------------------------------------------------------------------------------------------
step "New images"
STUDIO_SOURCE="$(git -C .. rev-parse HEAD:apps/studio 2>/dev/null || echo unknown)"
STUDIO_BUILT="$(docker image inspect -f '{{index .Config.Labels "platform.source"}}' plat/studio:dev 2>/dev/null || true)"
if [ "${STUDIO_BUILD:-0}" = 1 ] || [ "$STUDIO_SOURCE" != "$STUDIO_BUILT" ] || [ "$STUDIO_SOURCE" = unknown ]; then
  echo "Studio: sources changed ($STUDIO_BUILT -> $STUDIO_SOURCE), rebuilding"
  ../apps/studio/build.sh
else
  echo "Studio: unchanged"
fi
REALTIME_IMAGE="$(sed -n 's/^ *image: \(plat\/realtime:.*\)$/\1/p' docker-compose.yml)"
if [ "${REALTIME_BUILD:-0}" = 1 ] || ! docker image inspect "$REALTIME_IMAGE" >/dev/null 2>&1; then
  ../patches/realtime/build.sh
else
  echo "Realtime: $REALTIME_IMAGE present"
fi
# pinned upstream images (compose services and the per-app GoTrue and PostgREST): pulled when missing
for image in $(docker compose -p plat config --images | sort -u); do
  case "$image" in plat/*) continue ;; esac
  docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
done
docker compose -p plat build control-plane

# ------------------------------------------------------------------------------------------------------------------
step "Restart of the changed services"
# Recreates the services whose image or configuration changed. The control plane runs its idempotent schema
# migrations (packages/sql/platform.sql) and the template's at start, then syncAll (routes, edge configs, read-only
# flags, Studio registrations) and records the new version.
docker compose -p plat up -d
echo -n "waiting for the control plane"
for _ in $(seq 1 180); do
  if cp_health; then echo " ok"; break; fi
  echo -n "."
  sleep 1
done
cp_health || { echo; docker logs --tail 50 plat-control-plane; die "the control plane did not start: see the rollback below ($DIR/ROLLBACK.md)"; }

# ------------------------------------------------------------------------------------------------------------------
step "Rolling recycle of the apps' GoTrue and PostgREST"
RECYCLE_ARGS=()
[ "$FORCE_RECYCLE" = 1 ] && RECYCLE_ARGS=(--force)
cli recycle-apps ${RECYCLE_ARGS[@]+"${RECYCLE_ARGS[@]}"} | tee "$DIR/recycle.txt" || warn "some apps failed their recycle (see above): they keep their previous containers"

if [ "$(container_image_id plat-realtime)" != "$REALTIME_BEFORE" ]; then
  step "Realtime tenant migrations"
  # each tenant is recreated with the migrator role: its clients reconnect (SR-2)
  cli realtime-migrate --all || warn "realtime-migrate failed: rerun 'docker exec plat-control-plane node src/cli.ts realtime-migrate --all'"
fi

step "Security linter"
cli lint-apps --source upgrade | tee "$DIR/lints.txt" || warn "the linter failed for some apps"

# ------------------------------------------------------------------------------------------------------------------
step "Verification"
VERIFY_OK=1
cli verify | tee "$DIR/verify.txt" || VERIFY_OK=0
cli version > "$DIR/version.json"

cat > "$DIR/ROLLBACK.md" <<EOF
# Rollback of the upgrade $STAMP ($FROM -> $TO)

Pre-upgrade state: $DIR/images.before (images of every platform container), $DIR/backups.txt (app backups),
$DIR/platform.dump, $DIR/platform_storage.dump, $DIR/platform_realtime.dump (the platform's databases).

1. Go back to the previous code: \`git checkout <previous commit or tag>\` (this upgrade ran from $COMMIT).
2. Put the previous images back and restart:

       docker tag plat/control-plane:rollback-$STAMP plat/control-plane:dev
       docker tag plat/studio:rollback-$STAMP plat/studio:dev
       docker tag plat/realtime:rollback-$STAMP $(docker inspect -f '{{.Config.Image}}' plat-realtime)
       docker compose -p plat -f deploy/docker-compose.yml up -d --no-build
       docker exec plat-control-plane node src/cli.ts recycle-apps

   Upstream images (GoTrue, PostgREST, Storage...) follow the previous checkout's pinned tags.
3. Only if the new version changed the platform database in a way the previous one cannot read (release notes):

       docker exec -i plat-db pg_restore --clean --if-exists --username=supabase_admin --dbname=platform < $DIR/platform.dump

4. Only if an app's data was damaged: restore its pre-upgrade backup (admin console, Backups, or
   \`docker exec plat-control-plane node src/cli.ts restore-app <backup id> --confirm <slug>\`), ids in $DIR/backups.txt.
EOF

step "Summary"
echo "platform $(sed -n 's/^ *"version": "\([^"]*\)".*/\1/p' "$DIR/version.json" | head -1) (was $FROM)"
echo "report and logs: deploy/$DIR/ (upgrade.log, recycle.txt, lints.txt, verify.txt, ROLLBACK.md)"
if [ "$VERIFY_OK" = 1 ]; then
  echo "verification: OK"
else
  warn "verification FAILED (deploy/$DIR/verify.txt). To roll back, follow deploy/$DIR/ROLLBACK.md"
  exit 1
fi
