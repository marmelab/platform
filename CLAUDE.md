# Supabase app hosting platform

Reference plan: [PLAN_1.md](PLAN_1.md). Milestone reports: `spikes/*/REPORT.md`.

Main user journeys and the related product decisions: [docs/USER_JOURNEYS.md](docs/USER_JOURNEYS.md).
Tech debt and known limitations: [docs/TECH_DEBT.md](docs/TECH_DEBT.md).

## Conventions

- Documentation (`docs/`, READMEs, this file) is written in English.
- When you accept or pay off tech debt, update `docs/TECH_DEBT.md`.

## Personas

1. **App users**: use the apps deployed on the platform. Anonymous, or authenticated through the app instance's GoTrue.
2. **App builders**: create, modify and inspect their app instances, and manage their users. They access Studio for their own apps only. Data model: `users.role = 'developer'` + `app_members`.
3. **Admins**: see all apps and manage app builders. Data model: `users.role = 'admin'`.

## Decisions

- **Studio**: the supabase-studio-multi-head code is vendored in `apps/studio/` and modified so that app builders only access their own apps. One official Studio per app is ruled out (too much RAM per open instance). The license (Sustainable Use License) is not a blocker as long as we don't aim to resell the product.
- **Deployment**: always through GitHub Actions, from the default branch of the app's linked repo in the company GitHub organization, via a reusable workflow maintained by the admin (company security checks first). CI authenticates with GitHub OIDC. The `deploy` skill sets up the repo, the workflow and the function secrets, then pushes. Direct deployment from a local machine (`platform-deploy` with a PAT) stays available, governed by the `DIRECT_DEPLOY` platform setting: `admins` (production target: builders go through CI, admins deploy directly as an audited exception with the `admin-deploy` skill) or `everyone` (local installs and e2e tests, which must run without GitHub). The platform never hosts or displays source code: the admin reads it on GitHub. Details: [docs/USER_JOURNEYS.md](docs/USER_JOURNEYS.md), [PLAN_1.md](PLAN_1.md) §5.1 and §6.
