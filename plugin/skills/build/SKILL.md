---
name: build
description: Create or change an app meant to run on the internal platform, following its target architecture (Vite + React + TypeScript single-page app, supabase-js, Postgres migrations with row level security, Supabase edge functions). Use when the user asks to build, create, start or extend an app "for the platform", or an internal tool for their team, and when they want to try it before it goes online (preview, on their computer or from Claude Code on the web). The deploy skill then puts it online.
---

# Build an app for the platform

The people who use this skill are usually not developers: a team member who needs a tool and describes it in their own words. They judge the app by trying it, not by reading code. Keep every technical decision on your side, and keep the conversation about what the app does and who sees what.

The platform hosts each app as one Supabase-style instance (Postgres, Auth, REST, Storage, Realtime, edge functions) and serves its static frontend at `https://<slug>.<domain>`. There is no other server: everything an app does fits in this architecture.

The target architecture is in the project's `CLAUDE.md`, written from the plugin's template by `${CLAUDE_PLUGIN_ROOT}/template/init-app.sh <slug>` (run from the project folder). On a folder without `package.json` it also writes the app's skeleton (package, Vite and TypeScript config, supabase client, local preview config, `.claude/launch.json`); on an existing app it only adds what is missing. It never overwrites a file and prints the files it wrote.

## Talking to the user

- No jargon in messages, including the short status lines: no React, Vite, migration, RLS, policy, trigger, edge function, schema, commit, build, npm, port or file paths. Say "I'm setting up where the notes are stored", "only the author can see a note until they share it", "the app is ready to try".
- When a technical choice changes what users see or who can see what, explain the consequence in one sentence and ask a plain question ("Should colleagues see each other's notes by default, or only the ones shared with them?"). Otherwise decide, and do not mention it.
- Never ask the user to run a command, edit a file or install a tool. If something is missing on their machine (Docker for the preview), say what it is for in one sentence and offer to go on without it.
- Technical details only when the user asks for them.

## Working method

1. Ask at most one question when the request is ambiguous about who sees what; otherwise choose the most private reasonable default and say so.
2. Run `init-app.sh <slug>` (a new app: a short name from the request, `^[a-z][a-z0-9-]{1,30}[a-z0-9]$`, also its web address; an existing app: its `package.json` `name`), then read `CLAUDE.md` and follow it. Build on the skeleton's files instead of rewriting them. If the folder is not a git repository yet, `git init -b main`.
3. Once the app has its name, when the platform tools are available (`whoami` answers): `create_app` with the slug (idempotent), and `.platform.json` with `{ "app": "<slug>" }`. Then, if `whoami` `ci` is set and the project has no repository in `ci.github_org` yet (no remote, or the shared starter repository a session on the web opened), follow the **Repository** section of the deploy skill: the work is kept on GitHub from now on, and nothing deploys before the user asks. In a session on the web (`CLAUDE_CODE_REMOTE=true`) the platform tools are needed for the preview: without them, follow step 0 of the deploy skill.
4. Write the migration first, then the frontend, then the functions.
5. Check with `npm install` and `npm run build`; fix every error. Commit (do not push: the deploy skill does).
6. Preview, so the user tries the app before anyone else sees it:
   - `supabase start` (needs Docker; if Docker is not running, say so plainly and skip the preview). If another local project already uses the default ports, change the ports in `supabase/config.toml` (`[api]`, `[db]`, `[studio]`, `[inbucket]`, `[analytics]`, `shadow_port`) instead of stopping it. Migrations are applied at start; after a change, `supabase db reset`.
   - `.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from `supabase status -o env`.
   - Two demo accounts (e.g. `demo1@example.com` and `demo2@example.com`, a simple password) through the local auth admin API (`POST <API_URL>/auth/v1/admin/users` with the local service role key, `email_confirm: true`), and a sample record or two so the app does not open empty. Never use real addresses.
   - On their computer: start the dev server in the background: Claude Desktop shows it in its preview pane through `.claude/launch.json` (port 5173; change it only if Vite picked another one).
   - In a session on the web (no port forwarding there): `create_preview_token` for the app, then `PLATFORM_PREVIEW_TOKEN=<token> ${CLAUDE_PLUGIN_ROOT}/skills/build/scripts/preview.sh <url> <API_URL>` from the app's root (`url` from the token, `API_URL` from `supabase status -o env`). It starts the dev server and the platform's preview tunnel, and prints the preview link (`LOCAL`: not on the web; `NO_TUNNEL`: say the preview is not available right now and offer to put the app online to try it). It is safe to run again: do so, with a new token, when the user says the preview stopped working (the session's machine restarts without warning). Never show the token.
   - Tell the user how to try it: the preview link (or the local address), the demo accounts, and that this copy runs with made-up data, apart from the real app.
7. Summarize in plain words (what the app does, who sees what) and offer to put it online: that is the `deploy` skill. After changes requested from the preview, update the preview and ask again.
