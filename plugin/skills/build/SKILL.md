---
name: build
description: Create or change an app meant to run on the internal platform, following its target architecture (Vite + React + TypeScript single-page app, supabase-js, Postgres migrations with row level security, Supabase edge functions). Use when the user asks to build, create, start or extend an app "for the platform", or an internal tool for their team, and when they want to try it on their computer before it goes online (local preview). The deploy skill then puts it online.
---

# Build an app for the platform

The people who use this skill are usually not developers: a team member who needs a tool and describes it in their own words. They judge the app by trying it, not by reading code. Keep every technical decision on your side, and keep the conversation about what the app does and who sees what.

The platform hosts each app as one Supabase-style instance (Postgres, Auth, REST, Storage, Realtime, edge functions) and serves its static frontend at `https://<slug>.<domain>`. There is no other server: everything an app does fits in this architecture.

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

## Talking to the user

- No jargon in messages, including the short status lines: no React, Vite, migration, RLS, policy, trigger, edge function, schema, commit, build, npm, port or file paths. Say "I'm setting up where the notes are stored", "only the author can see a note until they share it", "the app is ready to try".
- When a technical choice changes what users see or who can see what, explain the consequence in one sentence and ask a plain question ("Should colleagues see each other's notes by default, or only the ones shared with them?"). Otherwise decide, and do not mention it.
- Never ask the user to run a command, edit a file or install a tool. If something is missing on their machine (Docker for the preview), say what it is for in one sentence and offer to go on without it.
- Technical details only when the user asks for them.

## Working method

1. Ask at most one question when the request is ambiguous about who sees what; otherwise choose the most private reasonable default and say so.
2. Write the migration first, then the frontend, then the functions.
3. Check with `npm install` and `npm run build`; fix every error. Initialize git (`git init -b main`) and commit.
4. Local preview, so the user tries the app before anyone else sees it:
   - `supabase start` (needs Docker; if Docker is not running, say so plainly and skip the preview). If another local project already uses the default ports, change the ports in `supabase/config.toml` (`[api]`, `[db]`, `[studio]`, `[inbucket]`, `[analytics]`, `shadow_port`) instead of stopping it. Migrations are applied at start; after a change, `supabase db reset`.
   - `.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from `supabase status -o env`.
   - Two demo accounts (e.g. `demo1@example.com` and `demo2@example.com`, a simple password) through the local auth admin API (`POST <API_URL>/auth/v1/admin/users` with the local service role key, `email_confirm: true`), and a sample record or two so the app does not open empty. Never use real addresses.
   - `.claude/launch.json` (`{"version": "0.0.1", "configurations": [{"name": "<slug>", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": <vite port>}]}`): Claude Desktop shows the app in its preview pane. Start the dev server in the background.
   - Tell the user how to try it: the preview (or the local address), the demo accounts, and that this copy runs only on their computer with made-up data.
5. Summarize in plain words (what the app does, who sees what) and offer to put it online: that is the `deploy` skill. After changes requested from the preview, update the preview and ask again.
