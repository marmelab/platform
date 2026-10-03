#!/usr/bin/env bash
# Builds the patched Realtime image (README.md): fetches the upstream sources of the patched files at the pinned tag,
# checks them against upstream.sha256, applies *.patch, and recompiles the touched modules over the upstream image.
#   patches/realtime/build.sh               tag plat/realtime:v<version>-platform<revision>
#   REALTIME_UPSTREAM_IMAGE=mirror.gcr.io/supabase/realtime:v2.134.10 patches/realtime/build.sh
set -euo pipefail
cd "$(dirname "$0")"

# Pinned upstream version: keep in sync with deploy/docker-compose.yml (image plat/realtime:v<version>-platform<rev>).
REALTIME_VERSION=2.134.10
# Bump when the patches change (a new image tag, so that `docker compose up` recreates the container).
PATCH_REVISION=1
UPSTREAM_IMAGE="${REALTIME_UPSTREAM_IMAGE:-supabase/realtime:v$REALTIME_VERSION}"
TAG="${TAG:-plat/realtime:v$REALTIME_VERSION-platform$PATCH_REVISION}"
RAW="https://raw.githubusercontent.com/supabase/realtime/v$REALTIME_VERSION"

ctx="$(mktemp -d)"
trap 'rm -rf "$ctx"' EXIT
mkdir -p "$ctx/src"
while read -r _ file; do
  mkdir -p "$ctx/src/$(dirname "$file")"
  curl -fsSL "$RAW/$file" -o "$ctx/src/$file"
done < upstream.sha256
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
(cd "$ctx/src" && sha256 --status -c "$OLDPWD/upstream.sha256") || { echo "upstream sources differ from upstream.sha256" >&2; exit 1; }
for patch in "$PWD"/*.patch; do (cd "$ctx/src" && git apply -p1 "$patch"); done
cp Dockerfile "$ctx/"

docker image inspect "$UPSTREAM_IMAGE" >/dev/null 2>&1 || docker pull "$UPSTREAM_IMAGE"
docker build --build-arg "REALTIME_IMAGE=$UPSTREAM_IMAGE" --build-arg "REALTIME_VERSION=$REALTIME_VERSION" \
  -t "$TAG" "$ctx"
echo "built $TAG from $UPSTREAM_IMAGE"
