#!/usr/bin/env bash
# Builds Studio: Next.js on the host (standalone output), then a small runtime image that copies it.
# Docker Desktop has too little RAM for `next build` (~8 GB RSS), the host does it in ~2 min.
#   apps/studio/build.sh                      native platform, tag plat/studio:dev
#   PLATFORM=linux/amd64 apps/studio/build.sh
set -euo pipefail
cd "$(dirname "$0")"

TAG="${TAG:-plat/studio:dev}"
PLATFORM="${PLATFORM:-linux/$(docker version -f '{{.Server.Arch}}')}"

pnpm -C ../.. install --frozen-lockfile
[ -d .next ] && find .next -mindepth 1 -maxdepth 1 ! -name cache -exec rm -rf {} +
# No NEXT_PUBLIC_STUDIO_AUTH: Studio has no login of its own, the platform's forward auth is the only one.
env -u NEXT_PUBLIC_STUDIO_AUTH -u NEXT_PUBLIC_IS_PLATFORM \
  SKIP_ASSET_UPLOAD=1 NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_ENABLE_LOGS=false \
  NODE_OPTIONS=--max_old_space_size=8192 \
  pnpm exec next build

rm -rf .image && mkdir -p .image/apps/studio/.next
cp -R .next/standalone/. .image/
cp -R .next/static .image/apps/studio/.next/static
cp -R public .image/apps/studio/public
SHARP_VERSION="$(ls .image/node_modules/.pnpm | sed -n 's/^sharp@\([0-9.]*\).*/\1/p' | head -1)"

# platform.source: the git tree of apps/studio this image was built from (deploy/upgrade.sh rebuilds when it differs)
SOURCE="$(git rev-parse HEAD:apps/studio 2>/dev/null || echo unknown)"
docker build --platform "$PLATFORM" --build-arg "SHARP_VERSION=$SHARP_VERSION" --label "platform.source=$SOURCE" \
  -f Dockerfile.platform -t "$TAG" .image
echo "built $TAG ($PLATFORM)"
