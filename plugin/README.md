# Plugin Claude Code « platform »

Déploie une app Vite + Supabase (migrations, edge functions, front statique) sur la plateforme, depuis Claude Code : « déploie l'app sur la plateforme ».

Contenu :

```
plugin/
  .claude-plugin/plugin.json
  .mcp.json                      # serveur MCP "platform" (HTTP), URL et token par variables d'env
  skills/deploy/SKILL.md         # workflow de déploiement
  skills/deploy/scripts/
    migrations.sh                # supabase/migrations/*.sql -> JSON pour apply_migrations
    pack.sh                      # tar.gz du dist/ ou de supabase/functions (+ config.toml), COPYFILE_DISABLE=1
    upload.sh                    # pack.sh + curl PUT vers l'URL pré-signée
```

Le marketplace (`platform-local`) est déclaré dans `.claude-plugin/marketplace.json` à la racine du repo.

## Installation

1. Récupérer un token (PAT) auprès d'un admin de la plateforme, puis l'exporter dans le shell qui lance Claude Code (par exemple dans `~/.zshrc`) :

   ```bash
   export PLATFORM_TOKEN=plat_...
   # optionnel, par défaut http://api.localhost:8100/mcp
   export PLATFORM_URL=https://api.<domaine>/mcp
   ```

2. Ajouter le marketplace et installer le plugin :

   ```bash
   claude plugin marketplace add /chemin/vers/platform     # ou l'URL git du repo
   claude plugin install platform@platform-local
   ```

   Dans une session interactive : `/plugin marketplace add <chemin ou URL>` puis `/plugin install platform@platform-local`.

3. Vérifier : `/mcp` doit lister `plugin:platform:platform` à l'état « connected ». Sinon, vérifier que `PLATFORM_TOKEN` est bien exporté dans l'environnement de Claude Code.

Pour tester sans installer : `claude --plugin-dir /chemin/vers/platform/plugin`.

## Utilisation

Dans un repo Vite + supabase-js (voir `examples/todo-app`) :

```
> déploie l'app sur la plateforme
```

La skill `platform:deploy` :

1. lit `.platform.json` (ou crée l'app avec `create_app`, écrit le fichier et le committe) ;
2. vérifie que c'est une SPA Vite ;
3. relit les nouvelles migrations (arrêt avant application si une table `public` est créée sans RLS), puis `apply_migrations` ; arrêt si le linter remonte un `ERROR`, sauf consentement explicite ;
4. déploie `supabase/functions` (archive + URL pré-signée + `finalize_deployment`) ;
5. build avec `VITE_SUPABASE_URL` et `VITE_SUPABASE_ANON_KEY` issus de `get_app` ;
6. déploie `dist/` ;
7. vérifie l'URL et affiche le récapitulatif ; en cas d'erreur, `get_logs` et diagnostic.

Conventions attendues dans le repo :

- `supabase/migrations/<version>_<name>.sql` (version numérique, ex. `20261001100000_create_todos.sql`) ;
- `supabase/functions/<nom>/index.ts`, `supabase/config.toml` (`[functions.<nom>] verify_jwt`) ;
- le front lit `import.meta.env.VITE_SUPABASE_URL` et `VITE_SUPABASE_ANON_KEY` ;
- `.platform.json` à la racine : `{ "app": "<slug>", "url": "..." }`, à committer.

## Usage headless (CI, tests)

```bash
PLATFORM_TOKEN=... claude -p "déploie l'app sur la plateforme" \
  --plugin-dir /chemin/vers/platform/plugin \
  --allowedTools "mcp__plugin_platform_platform__*" "Bash(npm *)" "Bash(git *)" "Bash(curl *)" \
                 "Bash(/chemin/vers/platform/plugin/skills/deploy/scripts/*)" Read Write Edit Glob Grep Skill
```
