# To be run in the root of the turbo monorepo
# NOTE: It's highly recommended to use the new builder, Buildkit. https://docs.docker.com/build/buildkit/
## USAGE:
# Build:        docker build . -f apps/studio/Dockerfile --target production -t studio:latest
# Run:          docker run -p 3000:3000 supabase/studio
# Deploy:       docker push supabase/studio:latest
# Clean build:
#    docker builder prune
#    docker build . -f apps/studio/Dockerfile --target production -t studio:latest --no-cache

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Fixes issues with Sentry CLI and SSL certificates during build
# TODO: Git is added because it's needed to build libpg, remove it once they publish a binary on the S3 bucket
RUN apt-get update -qq && \
  apt-get install -y --no-install-recommends \
  git \
  python3 \
  ca-certificates \
  build-essential && \
  rm -rf /var/lib/apt/lists/* && \
  update-ca-certificates

RUN npm install -g pnpm@10.24.0

WORKDIR /app

# Prune unneeded dependencies with turbo (from apps/ for example)
FROM base AS turbo
COPY . .

RUN pnpm dlx turbo@2.9.3 prune studio --docker

# Install dev dependencies (only if needed)
FROM base AS deps
COPY --from=turbo /app/out/json ./
COPY --from=turbo /app/out/pnpm-lock.yaml ./
COPY ./patches/ ./patches

# No need to clean cache because production uses standalone build
RUN pnpm install --frozen-lockfile

# dev contains dependencies and source code not compiled
FROM deps AS dev
COPY --from=turbo /app/out/full ./
ENTRYPOINT ["docker-entrypoint.sh"]
EXPOSE 8082
CMD ["pnpm", "dev:studio"]

# Compile Next.js
FROM dev AS builder

# Multi-head always uses GoTrue-backed Studio auth.
# NEXT_PUBLIC_* vars must be present at build time to be inlined into client bundles.
ARG NEXT_PUBLIC_STUDIO_AUTH=gotrue
ENV NEXT_PUBLIC_STUDIO_AUTH=${NEXT_PUBLIC_STUDIO_AUTH}

RUN pnpm --filter studio exec next build

# Locate the Docker Compose plugin — its path varies across docker:cli versions.
# Copy it to a fixed location so the production COPY below always works.
FROM docker:27-cli AS docker-tools
RUN set -e; \
    plugin=$(find /usr -name docker-compose -type f 2>/dev/null | head -1); \
    [ -n "$plugin" ] || { echo "ERROR: docker-compose not found in docker:27-cli"; exit 1; }; \
    cp "$plugin" /docker-compose

# Copy only compiled code and dependencies
FROM base AS production
COPY --from=builder /app/apps/studio/public ./apps/studio/public
COPY --from=builder /app/apps/studio/.next/standalone ./
COPY --from=builder /app/apps/studio/.next/static ./apps/studio/.next/static

# Docker CLI — required for multi-head stack orchestration (spawning new projects).
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-tools /docker-compose /usr/local/lib/docker/cli-plugins/docker-compose

# Bake the Supabase compose template + init volumes into the image so Studio can
# spawn new project stacks without requiring a host-mounted docker/ directory.
# Users who want to override can still bind-mount SUPABASE_COMPOSE_FILE.
COPY docker/docker-compose.yml /app/supabase-docker/docker-compose.yml
COPY docker/volumes/           /app/supabase-docker/volumes/

# Default compose template path — overridable via environment variable
ENV SUPABASE_COMPOSE_FILE=/app/supabase-docker/docker-compose.yml

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
HEALTHCHECK --interval=5s --timeout=5s --retries=3 CMD node -e "fetch('http://localhost:3000/api/platform/profile').then((r) => {if (r.status !== 200) throw new Error(r.status)})"
CMD ["node", "apps/studio/server.js"]
