# Upstream

Vendored copy of **supabase-studio-multi-head**, a fork of the Supabase Studio monorepo.

| | |
|---|---|
| Repository | https://github.com/flamingrubberduck/supabase-studio-multi-head |
| Commit | `f88e4b4e6ba2f331ab1b2466cf7d120aaf9d47a2` (2026-06-09, "security: backport escape and keyboard safety fixes from upstream") |
| License | `LICENSE` (Sustainable Use License, copied from the fork root) |

## How this tree was produced

```bash
git clone https://github.com/flamingrubberduck/supabase-studio-multi-head studio-mh
cd studio-mh && git checkout f88e4b4e6ba2f331ab1b2466cf7d120aaf9d47a2
rm .npmrc                              # contains a Windows-only script-shell, breaks npx/pnpm on macOS/Linux
npx -y turbo@2.9.3 prune studio        # same pruning as the fork's apps/studio/Dockerfile
rsync -a out/ <platform>/apps/studio/ \
  --exclude node_modules --exclude apps/studio/.github/ \
  --exclude apps/studio/tests/ --exclude apps/studio/__mocks__/ \
  --exclude '*.test.ts' --exclude '*.test.tsx' --exclude '*.spec.ts' --exclude '*.spec.tsx' \
  --exclude '*.stories.ts' --exclude '*.stories.tsx' --exclude '__tests__/'
cp LICENSE <platform>/apps/studio/LICENSE
```

Layout (unchanged from the pruned monorepo):

```
apps/studio/                 pruned monorepo root (package.json, pnpm-workspace.yaml, pnpm-lock.yaml, patches/)
apps/studio/apps/studio/     the Next.js "studio" app
apps/studio/packages/        workspace dependencies of studio: ai-commands, api-types, build-icons, common,
                             config, dev-tools, eslint-config-supabase, icons, pg-meta, shared-data, tsconfig,
                             ui, ui-patterns
```

## Excluded from the fork

Not needed to build or run Studio:

- the rest of the monorepo (apps/design-system, apps/ui-library, apps/learn, apps/lite-studio, packages/generator,
  packages/marketing, docs/, docker/, multihead/, supabase/, the duplicated studio sources at the fork root);
- unit tests, mocks and fixtures (`*.test.ts(x)`, `*.spec.ts(x)`, `__tests__/`, `apps/studio/tests/`,
  `apps/studio/__mocks__/`), storybook stories (`*.stories.ts(x)`), the CI workflows (`apps/studio/.github/`).
  `apps/studio/evals/` is kept: `lib/ai` imports `@/evals/output`;
- the root `.npmrc` (Windows `script-shell`).

The root `pnpm-workspace.yaml` of the platform excludes `apps/studio`: this tree is its own pnpm workspace.

Platform modifications are listed in `PLATFORM_PATCHES.md`.
