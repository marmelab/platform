# Build context: repository root (see deploy/docker-compose.yml)
# Admin SPA (apps/admin): static files, served by the control plane on admin.<domain>
FROM node:24-trixie AS admin
RUN npm install -g pnpm@10.28.0
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches patches
COPY apps/admin/package.json apps/admin/
RUN pnpm install --frozen-lockfile --filter @platform/admin...
COPY apps/admin apps/admin
RUN pnpm --filter @platform/admin build

FROM node:24-trixie
RUN npm install -g pnpm@10.28.0
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches patches
COPY packages/shared/package.json packages/shared/
COPY packages/sql/package.json packages/sql/
COPY apps/control-plane/package.json apps/control-plane/
RUN pnpm install --frozen-lockfile --prod --filter @platform/control-plane...
COPY packages/shared packages/shared
COPY packages/sql packages/sql
COPY apps/control-plane/src apps/control-plane/src
COPY VERSION ./
COPY --from=admin /repo/apps/admin/dist apps/admin/dist
WORKDIR /repo/apps/control-plane
ENV NODE_ENV=production
CMD ["node", "src/index.ts"]
