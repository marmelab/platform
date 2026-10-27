# __APP__

An app hosted on the company's platform: one Supabase-style instance (Postgres, Auth, REST, Storage, Realtime, edge functions), with its static frontend served at `https://__APP__.<domain>`. There is no other server: everything the app does fits in the architecture below.

The people who change this app are often not developers: use the `platform:build` skill to change it (it also runs a local preview) and `platform:deploy` to put it online.

## Target architecture

```
package.json            # name = the app slug (^[a-z][a-z0-9-]{1,30}[a-z0-9]$), scripts dev / build / typecheck
index.html, vite.config.ts, tsconfig.json
src/                    # React + TypeScript, supabase-js; one file per screen, flat
  supabase.ts           # createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY)
supabase/
  config.toml           # for the local preview (`supabase start`)
  migrations/<YYYYMMDDHHMMSS>_<name>.sql
  functions/<name>/index.ts   # Deno, only for what the browser must not do
.env.example            # VITE_SUPABASE_URL=, VITE_SUPABASE_ANON_KEY=
.gitignore              # node_modules, dist, .env.local
.claude/launch.json     # the dev server, for the preview pane of Claude Desktop
```

- **Frontend**: Vite + React + TypeScript, plain CSS, no UI framework unless the user asks. A single-page app with client-side routing only (hash or history; the platform serves `index.html` for unknown paths). `npm run build` must run `tsc --noEmit && vite build`.
- **Data**: tables in `public`, created by migrations only. Every table has row level security enabled, with policies written for `authenticated` users from `auth.uid()`; nothing is readable by `anon` unless the user wants public data. A `profiles` table filled from `auth.users` by a trigger when the app needs to show other users (`security definer` function with `set search_path = ''`, not executable by `anon` or `authenticated`). Index the foreign keys. Never reference `user_metadata` in a policy.
- **Logic**: in the database (policies, constraints, triggers, RPC functions) when it protects data; in an edge function when it needs a secret, another service, or privileges the user does not have (read the secret with `Deno.env.get`; `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided). Call functions with `supabase.functions.invoke`. The `service_role` key never appears in the frontend.
- **Auth**: email and password with supabase-js. Users are usually invited by the app builder: an invitation link signs the person in and lands on the app with a session; the app must then ask them to choose a password (`supabase.auth.updateUser({ password })`, detected with the `type=invite` in the URL hash, or a user without a password set yet). Also handle `PASSWORD_RECOVERY` (reset link). Keep a "Create an account" button only if the user wants open sign-up.
- **Files**: Supabase Storage buckets, created in a migration with their policies. **Live updates**: Supabase Realtime on the tables that need it.

## Deployment

- With CI, every push to the default branch deploys through `.github/workflows/platform.yml` (company checks, migrations with the security linter, functions, frontend, smoke test); pull requests are checked.
- A deployed migration is never edited nor rolled back: fix forward with a new migration.
- `.platform.json` holds the app slug and `acceptedLints`: add a lint there only with the explicit consent of the person who owns the app.
