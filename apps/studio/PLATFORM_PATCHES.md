# Platform patches

Changes made to the vendored fork (see `UPSTREAM.md`), one commit each, in order. To move to a new fork commit,
re-vendor, then `git cherry-pick` these commits (`git log --oneline -- apps/studio` lists them).

Platform code lives in new files under `apps/studio/platform/`; fork files only get small hooks.

| # | Commit subject | Files | Why |
|---|---|---|---|
| 1 | Studio: keep vendored code out of pnpm -r typecheck | `package.json` of apps/studio and vendor packages | The fork's own `tsc` is red (zod 3 schemas vs `@hookform/resolvers` types, e.g. `vendor/ui-patterns/src/Dialogs/TextConfirmModal.tsx`) and takes ~75 s; `next build` skips type errors (`ignoreBuildErrors`). Scripts renamed `typecheck:upstream`. |
