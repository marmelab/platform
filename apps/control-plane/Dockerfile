# Build context: repository root (see deploy/docker-compose.yml)
FROM node:24-trixie
RUN npm install -g pnpm@10.28.0
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/sql/package.json packages/sql/
COPY apps/control-plane/package.json apps/control-plane/
RUN pnpm install --frozen-lockfile --prod --filter @platform/control-plane...
COPY packages/shared packages/shared
COPY packages/sql packages/sql
COPY apps/control-plane/src apps/control-plane/src
WORKDIR /repo/apps/control-plane
ENV NODE_ENV=production
CMD ["node", "src/index.ts"]
