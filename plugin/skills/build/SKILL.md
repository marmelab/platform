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
- Never mention tests, checks, reviews or reviewers, nor that something was fixed after one: the user sees the result. While they take a while, at most "I'm double-checking who can see what".

## Working method

1. Run `init-app.sh <slug>` (a new app: a short name from the request, `^[a-z][a-z0-9-]{1,30}[a-z0-9]$`, also its web address; an existing app: its `package.json` `name`), then read `CLAUDE.md` and follow it. Build on the skeleton's files instead of rewriting them. If the folder is not a git repository yet, `git init -b main`.
   - Load the `platform:guidelines` skill and follow it for all the code you write.
   - Note the base the reviewers will compare against: `git rev-parse HEAD`, or `4b825dc642cb6eb9a060e54bf8d69288fbee4904` (the empty tree) before the first commit.
   - An app made before the tests existed (no `test` script in `package.json`): bring in the test setup of `${CLAUDE_PLUGIN_ROOT}/template/app/` (`vitest.config.ts`, `supabase/tests/`, the `test` script and the test devDependencies of its `package.json`).
2. In a session on the web (`CLAUDE_CODE_REMOTE=true`), once the app has its name: `create_app` with the slug (idempotent), and `.platform.json` with `{ "app": "<slug>" }`; the preview needs them. Without the platform tools, follow step 0 of the deploy skill. Nothing goes to GitHub before the user deploys. On a computer, skip this step.
3. Size the change, for yourself:
   - **tweak**: wording, colors, layout, with no new data, rule or function. No review.
   - **screen**: a new or changed screen or flow, with no change to tables, policies, buckets or functions. The `platform:quality-reviewer` at step 6.
   - **data**: a table or column, a policy, a bucket, a function, sharing or sign-in. On an existing app, dispatch the `platform:analyst` now with the user's request in their words; on a new app's first build, list the access rules yourself (who reads, creates, changes, deletes what). Both `platform:security-reviewer` and `platform:quality-reviewer` at step 6.

   Then ask at most one question, when the request (or the analyst's open questions) leaves who sees what ambiguous; otherwise choose the most private reasonable default and say so. Build the access rules, edge cases and tests into the work.
4. Write the migration, then the screens, then the functions, each with its tests (data tests for the access rules, component tests for the flows). Run nothing before the change is complete: step 5 runs the tests once.
5. Check:
   - `npm install`.
   - `supabase start` (needs Docker; if Docker is not running, say so plainly and skip the preview, and run only `npx vitest run --project app` below: deployments run the rest). If another local project already uses the default ports, change the ports in `supabase/config.toml` (`[api]`, `[db]`, `[studio]`, `[inbucket]`, `[analytics]`, `shadow_port`) instead of stopping it. Migrations are applied at start; after a change, `supabase db reset` (it also removes the demo accounts: step 7 creates them again).
   - `npm test`, then `npm run build`; fix every failure in the code, and change a test only when the rule it states changed.
   - Commit (do not push: the deploy skill does).
6. Review, for a screen or data change: dispatch the reviewers of step 3 in parallel, in the background, each with the base of step 1, the access rules and flows of step 3, and the result of `npm test`; go on with step 7 while they run. On `BLOCK`, fix each blocking finding with the smallest change, run step 5 again, commit, and dispatch again only the reviewer that blocked, once. If it still blocks, do not offer to put the app online: tell the user what it means for the app's users in one plain sentence ("for now, a colleague could open someone else's notes"), and offer to keep working on it.
7. Preview, so the user tries the app before anyone else sees it (prepared while the reviews run, announced only once they passed):
   - `.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from `supabase status -o env`.
   - Two demo accounts (e.g. `demo1@example.com` and `demo2@example.com`, a simple password) through the local auth admin API (`POST <API_URL>/auth/v1/admin/users` with the local service role key, `email_confirm: true`), and a sample record or two so the app does not open empty. Never use real addresses.
   - On their computer: start the dev server in the background: Claude Desktop shows it in its preview pane through `.claude/launch.json` (port 5173; change it only if Vite picked another one).
   - In a session on the web (no port forwarding there): `create_preview_token` for the app, then `PLATFORM_PREVIEW_TOKEN=<token> ${CLAUDE_PLUGIN_ROOT}/skills/build/scripts/preview.sh <url> <API_URL>` from the app's root (`url` from the token, `API_URL` from `supabase status -o env`). It starts the dev server and the platform's preview tunnel, and prints the preview link (`LOCAL`: not on the web; `OLD_VITE_CONFIG`: the app was made before the preview existed: merge the `vite.config.ts` of `${CLAUDE_PLUGIN_ROOT}/template/app/` into the app's, keeping the app's own plugins and options, commit, and run it again; `NO_TUNNEL`: say the preview is not available right now, maybe because another member of the app is previewing it (one preview per app at a time), and offer to put the app online to try it). It is safe to run again: do so, with a new token, when the user says the preview stopped working (the session's machine restarts without warning). Never show the token.
   - Tell the user how to try it: the preview link (or the local address), the demo accounts, and that this copy runs with made-up data, apart from the real app. On the web, the link first asks for their platform account: only the app's members see the preview.
8. Summarize in plain words (what the app does, who sees what) and offer to put it online: that is the `deploy` skill. After changes requested from the preview, go through steps 3 to 7 again, then ask again.
