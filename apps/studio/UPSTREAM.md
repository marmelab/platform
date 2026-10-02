# Upstream

Vendored copy of **supabase-studio-multi-head**, a fork of the Supabase Studio monorepo.

| | |
|---|---|
| Repository | https://github.com/flamingrubberduck/supabase-studio-multi-head |
| Commit | `f88e4b4e6ba2f331ab1b2466cf7d120aaf9d47a2` (2026-06-09, "security: backport escape and keyboard safety fixes from upstream") |
| License | `LICENSE` (Sustainable Use License, copied from the fork root) |

## Path mapping

| Fork | Platform |
|---|---|
| `apps/studio/` (the Next.js app) | `apps/studio/` |
| `packages/{ai-commands,api-types,build-icons,common,config,dev-tools,eslint-config-supabase,icons,pg-meta,shared-data,tsconfig,ui,ui-patterns}/` | `packages/<same name>/` |
| `patches/react-data-grid.patch` | `patches/react-data-grid.patch` |
| `pnpm-workspace.yaml`: `catalog`, `ignoredBuiltDependencies`, `onlyBuiltDependencies`, `overrides`, `patchedDependencies` | root `pnpm-workspace.yaml` (merged) |
| `pnpm-lock.yaml`: importers `apps/studio` and `packages/*` | root `pnpm-lock.yaml` (merged, same resolved versions) |
| `LICENSE` | `apps/studio/LICENSE` |

The relative paths inside the app (`../../packages/ui/...` in `tsconfig.json`, `tailwind.config.js`, ...) are the same
as in the fork, since both monorepos put the app in `apps/` and its dependencies in `packages/`.

## Not vendored

Not needed to build or run Studio:

- the rest of the fork's monorepo (apps/design-system, apps/ui-library, apps/learn, apps/lite-studio,
  packages/generator, packages/marketing, docs/, docker/, multihead/, supabase/, the duplicated studio sources and
  `package.json` at the fork root, `turbo.jsonc`, the CI workflows);
- unit tests, mocks and fixtures (`*.test.ts(x)`, `*.spec.ts(x)`, `__tests__/`, `apps/studio/tests/`,
  `apps/studio/__mocks__/`) and storybook stories (`*.stories.ts(x)`). `apps/studio/evals/` is kept:
  `lib/ai` imports `@/evals/output`;
- the root `.npmrc` (Windows-only `script-shell`);
- `minimumReleaseAge` / `minimumReleaseAgeExclude` from the fork's `pnpm-workspace.yaml`: in a single workspace it
  would also block the platform's own fresh dependencies (e.g. `pg-cloudflare` for the control plane).

## Updating to a new fork commit

```bash
git clone https://github.com/flamingrubberduck/supabase-studio-multi-head studio-mh && cd studio-mh
git checkout <new sha> && rm .npmrc && npx -y turbo@2.9.3 prune studio
EXCLUDES=(--exclude node_modules --exclude .github/ --exclude tests/ --exclude __mocks__/ --exclude turbo.jsonc
  --exclude '*.test.ts' --exclude '*.test.tsx' --exclude '*.spec.ts' --exclude '*.spec.tsx'
  --exclude '*.stories.ts' --exclude '*.stories.tsx' --exclude '__tests__/')
# on a branch started from the vendoring commits (before PLATFORM_PATCHES.md), replace the vendored files:
rsync -a --delete "${EXCLUDES[@]}" --exclude UPSTREAM.md --exclude PLATFORM_PATCHES.md --exclude LICENSE \
  --exclude Dockerfile.platform --exclude build.sh --exclude platform/ out/apps/studio/ <platform>/apps/studio/
for p in out/packages/*; do rsync -a --delete "${EXCLUDES[@]}" "$p/" "<platform>/packages/$(basename "$p")/"; done
cp out/patches/* <platform>/patches/ && cp LICENSE <platform>/apps/studio/LICENSE
```

Then merge `out/pnpm-workspace.yaml` into the root one (same keys as above), run `pnpm install` (the lockfile keeps
the fork's resolved versions for unchanged specifiers), commit, and re-apply the commits listed in
`PLATFORM_PATCHES.md` (`git cherry-pick` or `git rebase --onto`).
