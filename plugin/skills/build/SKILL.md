---
name: build
description: Create or change an app meant to run on the internal platform, following its target architecture (Vite + React + TypeScript single-page app, supabase-js, Postgres migrations with row level security, Supabase edge functions). Use when the user asks to build, create, start or extend an app "for the platform", or an internal tool for their team, before it is deployed with the deploy skill.
---

# Build an app for the platform

The platform hosts each app as one Supabase-style instance (Postgres, Auth, REST, Storage, Realtime, edge functions) and serves its static frontend at `https://<slug>.<domain>`. There is no other server: everything an app does fits in this architecture.

## Target architecture

```
package.json            # name = the app slug (^[a-z][a-z0-9-]{1,30}[a-z0-9]$), scripts dev / build / typecheck
index.html, vite.config.ts, tsconfig.json
src/                    # React + TypeScript, supabase-js; one file per screen, flat
  supabase.ts           # createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY)
supabase/
  config.toml           # for a local `supabase start` (optional)
  migrations/<YYYYMMDDHHMMSS>_<name>.sql
  functions/<name>/index.ts   # Deno, only for what the browser must not do
.env.example            # VITE_SUPABASE_URL=, VITE_SUPABASE_ANON_KEY=
.gitignore              # node_modules, dist, .env.local
```

- **Frontend**: Vite + React + TypeScript, plain CSS, no UI framework unless the user asks. A single-page app with client-side routing only (hash or history; the platform serves `index.html` for unknown paths). `npm run build` must run `tsc --noEmit && vite build`.
- **Data**: tables in `public`, created by migrations only. Every table has row level security enabled, with policies written for `authenticated` users from `auth.uid()`; nothing is readable by `anon` unless the user wants public data. A `profiles` table filled from `auth.users` by a trigger when the app needs to show other users (`security definer` function with `set search_path = ''`, not executable by `anon` or `authenticated`). Index the foreign keys. Never reference `user_metadata` in a policy.
- **Logic**: in the database (policies, constraints, triggers, RPC functions) when it protects data; in an edge function when it needs a secret, another service, or privileges the user does not have (read the secret with `Deno.env.get`; `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided). Call functions with `supabase.functions.invoke`. The `service_role` key never appears in the frontend.
- **Auth**: email and password with supabase-js. Users are usually invited by the app builder: an invitation link signs the person in and lands on the app with a session; the app must then ask them to choose a password (`supabase.auth.updateUser({ password })`, detected with the `type=invite` in the URL hash, or a user without a password set yet). Also handle `PASSWORD_RECOVERY` (reset link). Keep a "Create an account" button only if the user wants open sign-up.
- **Files**: Supabase Storage buckets, created in a migration with their policies. **Live updates**: Supabase Realtime on the tables that need it.

## Working method

1. Ask at most one question when the request is ambiguous about who sees what; otherwise choose the most private reasonable default and say so.
2. Write the migration first, then the frontend, then the functions.
3. Check with `npm install` and `npm run build`; fix every error. Initialize git (`git init -b main`) and commit.
4. Summarize for the user in plain words (what the app does, who sees what), without jargon, and offer to put it online: that is the `deploy` skill.
