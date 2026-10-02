# Control plane (M2)

Node 24 + TypeScript (exécuté directement, sans build, grâce au type stripping), Hono, `pg`, dockerode, SDK MCP (Streamable HTTP, mode stateless).

## Démarrer

```bash
deploy/install.sh          # génère deploy/.env, lance le projet compose "plat", init le cluster, crée l'admin
```

Le script se relance sans risque. Au premier passage il affiche le PAT de l'admin (`admin@example.com`, modifiable avec `ADMIN_EMAIL=`), et l'enregistre aussi dans **`deploy/.env.local`** (gitignoré) :

```
PLATFORM_URL=http://api.localhost:8100/mcp
PLATFORM_ADMIN_EMAIL=admin@example.com
PLATFORM_TOKEN=plat_...
```

Après une modification du code : `docker compose -p plat -f deploy/docker-compose.yml up -d --build control-plane`.

## MCP

- URL : `http://api.localhost:8100/mcp`, avec le header `Authorization: Bearer <PAT>`.
- Claude Code : `claude mcp add --transport http platform http://api.localhost:8100/mcp --header "Authorization: Bearer $PLATFORM_TOKEN"`
- Outils : `whoami`, `list_apps`, `get_app`, `create_app`, `apply_migrations`, `execute_sql`, `create_deployment`, `finalize_deployment`, `list_deployments`, `rollback`, `set_secrets`, `list_secrets`, `get_logs`.
- Les archives ne passent pas par MCP : `create_deployment` renvoie une URL `PUT http://api.localhost:8100/uploads/<token>` (usage unique, 15 min) et une commande `tar` + `curl` prête à l'emploi.

## Apps

Chaque app `<slug>` est servie sur `http://<slug>.localhost:8100` : `/` (statique, fallback SPA), `/auth/v1`, `/rest/v1`, `/functions/v1`.

## Studio

`http://studio.localhost:8100` : Studio multi-head (`apps/studio`), ref de projet = slug de l'app, lien profond `studio_url` dans `get_app`. Login plateforme sur `/_platform/login` (compte local avec mot de passe), puis forward auth (`/studio/verify` sur le listener interne `:3001`) : un builder ne voit que les apps dont il est membre, un admin voit tout. Détails : `spikes/m0ter-studio-builders/REPORT.md`.

## CLI d'administration (dans le conteneur)

```bash
docker exec plat-control-plane node src/cli.ts create-user bob@example.com developer   # affiche un nouveau PAT
docker exec plat-control-plane node src/cli.ts delete-app demo
docker exec plat-control-plane node src/cli.ts set-password bob@example.com --generate         # affiche un mot de passe Studio
docker exec -i plat-control-plane node src/cli.ts set-password bob@example.com < password.txt  # ou le lit sur stdin
docker exec plat-control-plane node src/cli.ts add-member demo bob@example.com developer
docker exec plat-control-plane node src/cli.ts init                                     # idempotent, fait aussi au démarrage
```

## Tests

```bash
pnpm -r typecheck
pnpm --filter @platform/control-plane test        # politique d'accès Studio (unitaire)
pnpm --filter @platform/control-plane e2e         # nécessite la stack démarrée et deploy/.env.local
pnpm --filter @platform/control-plane e2e:studio  # Studio : login, filtrage, isolation (crée alice et bob)
```

## Accès techniques (dev)

| Élément | Valeur |
|---|---|
| Postgres | `127.0.0.1:54350`, `supabase_admin` / `POSTGRES_PASSWORD` de `deploy/.env` ; base `platform` |
| Caddy admin | `http://127.0.0.1:2030` (routes `app-<slug>` et `app-<slug>-internal`) |
| Volumes | `plat_sites`, `plat_functions`, `plat_apps-config`, `plat_uploads`, `plat_deno-cache`, `plat_db-data` |
| Conteneurs | `plat-db`, `plat-caddy`, `plat-edge`, `plat-control-plane`, `plat-studio`, `plat-studio-meta`, et par app `plat-<slug>-auth` et `plat-<slug>-rest` |
