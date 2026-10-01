# Jalon M2 : control plane + MCP minimal (rapport)

Date : 2026-10-01. Machine : macOS, Docker Desktop (8 Go partagés avec les stacks `m0` et `m0bis`, qui n'ont pas été touchées).

## Verdict

**Le critère de sortie de M2 est atteint.** Un client MCP (le SDK officiel) muni d'un PAT enchaîne tout le parcours sans action manuelle :
- `create_app` ;
- `apply_migrations` avec le linter ;
- le déploiement des fonctions, puis du front, par URL pré-signée ;
- `supabase-js` sous RLS, y compris l'appel d'une edge function qui relit les données de l'utilisateur ;
- le rollback, `get_logs` et le contrôle d'accès.

Résultats :
- **Test e2e** (`apps/control-plane/test/e2e.test.ts`) : 11/11 en environ 2,4 s depuis zéro (app supprimée puis recréée), et 1,4 s quand on le relance sur l'app existante (idempotence).
- **`pnpm -r typecheck`** passe sur les 3 projets.
- **`create_app`** prend environ 1,1 s à froid : rôles, DB clonée, GoTrue et PostgREST démarrés et en bonne santé, routes Caddy. Il prend environ 80 ms quand on le relance.
- **Les acquis de M0 et M1 ont été repris sans surprise.**
  - De M0 : le template, les rôles par app, `REASSIGN OWNED`, `GHCRTS=-N2` et les routes Caddy par l'API admin.
  - De M1 : le format `/config/apps/<app>.json`, `functions.json`, le gateway token et les volumes nommés.
  - Le main worker de `packages/edge-main-worker` est utilisé **tel quel**.

La stack `plat` reste démarrée avec l'app `demo` (table `todos` sous RLS, fonctions `hello` et `ping`, front « Demo v2 »), prête pour M3.

## Ce qui a été construit

```
package.json, pnpm-workspace.yaml, tsconfig.base.json
packages/shared/      schémas zod des entrées d'outils MCP + types (AppInfo, LintResult, LogLine)
packages/sql/         bootstrap.sql, template.sql (repris de M0), platform.sql (modèle de données),
                      lints.sql (linter), src/index.ts (SQL de provisioning par app, rôle owner inclus)
packages/edge-main-worker/   inchangé (M1)
apps/control-plane/
  Dockerfile          node:24, pnpm install --prod, exécution directe des .ts (type stripping)
  src/config.ts       env, URLs publiques et internes
  src/init.ts         bootstrap du cluster : REVOKE CONNECT, template_supabase, base platform
  src/apps.ts         provisioning idempotent (§4.2), accès user → app, edge config, delete symétrique
  src/orchestrator.ts interface Orchestrator + DockerOrchestrator (dockerode)
  src/router.ts       interface Router + CaddyRouter (API admin JSON)
  src/sql.ts          apply_migrations, linter, execute_sql
  src/deployments.ts  create/upload/finalize/list/rollback, extraction tar sécurisée
  src/secrets.ts      set_secrets / list_secrets (AES-GCM)
  src/logs.ts         get_logs (logs Docker)
  src/mcp.ts          les 13 outils MCP
  src/server.ts       Hono : /health, /mcp, PUT /uploads/:token
  src/cli.ts          init, create-user (→ PAT), delete-app
  test/e2e.test.ts    test de bout en bout (node:test + client MCP + supabase-js + tar)
  test/fixtures/      todos.sql, hello.ts (edge function de test)
deploy/
  docker-compose.yml  projet "plat" : db, caddy, edge, control-plane ; réseau "plat"
  caddy/caddy.json    bootstrap : serveur public :8100 (api + subroute "apps"), serveur interne :8180 ("internal-apps")
  install.sh          secrets → up --build → init → admin + PAT (deploy/.env.local)
```

### Topologie

| Conteneur | Rôle | Exposition |
|---|---|---|
| `plat-db` | `supabase/postgres:17.6.1.136`, `max_connections=500`, `log_line_prefix` avec `db=%d` | `127.0.0.1:54350` |
| `plat-caddy` | Point d'entrée ; `--resume` | `127.0.0.1:8100` (public) ; `127.0.0.1:2030` (admin) ; `:8180` interne uniquement |
| `plat-edge` | `supabase/edge-runtime:v1.76.2` + main worker M1 (bind mount en lecture seule) | Interne (`edge:9000`) |
| `plat-control-plane` | Hono + MCP ; socket Docker ; volumes `sites`, `functions`, `apps-config` et `uploads` en écriture | Via Caddy (`api.localhost:8100`) |
| `plat-<slug>-auth` / `plat-<slug>-rest` | GoTrue / PostgREST créés par le control plane ; 256 Mo ; labels `platform.app`, `platform.service`, `platform.managed`, `platform.config-hash` | Internes |

### Modèle de données (base `platform`)

| Table | Contenu |
|---|---|
| `users` | Utilisateurs de la plateforme |
| `tokens` | Hash sha256 du PAT, `last_used_at`, `revoked_at`, `expires_at` |
| `apps` | Secrets de l'app chiffrés en AES-256-GCM dans `secrets_enc` |
| `app_members` | Droits user → app |
| `app_secrets` | Secrets des fonctions, valeurs chiffrées |
| `deployments` | `frontend`, `functions` ou `migrations` ; version entière par app et par type ; statut `pending` → `uploaded` → `live`, `ready` ou `failed` |
| `uploads` | Hash du token, TTL, `used_at` |
| `audit_log` | Journal des actions |

Le schéma est appliqué de façon idempotente à chaque démarrage (`create table if not exists`).

### Provisioning (`create_app`)

1. **Ligne `apps`** au statut `provisioning`, avec des secrets générés : secret JWT, clés anon et service_role au format legacy HS256, trois mots de passe. Le créateur devient membre `owner`.
2. **Rôles globaux** : `app_<id>_authenticator` et `app_<id>_auth_admin` (séquence de M0), plus **`app_<id>_owner`**, nouveau. Puis `CREATE DATABASE app_<id> TEMPLATE template_supabase OWNER app_<id>_owner` et `REVOKE ALL ... FROM PUBLIC`.
3. **Dans la DB** : `REASSIGN OWNED BY supabase_auth_admin`, puis préparation du rôle owner.
4. **Conteneurs GoTrue et PostgREST** (`GHCRTS=-N2`, pools de 3). `ensure()` compare un hash de la spec : un conteneur identique n'est pas recréé.
5. **Fichiers** : `sites/<slug>/v0/index.html` (placeholder) avec `current → v0`, `functions/<slug>/` et `config/apps/<slug>.json`.
6. **Routes Caddy** `app-<slug>` (publique) et `app-<slug>-internal`.
7. **Attente** de `/health` (GoTrue) et de `/` (PostgREST), puis statut `running`. En cas d'erreur, l'app passe au statut `error` avec le message, et un nouvel appel à `create_app` reprend là où ça s'était arrêté.

Au démarrage, le control plane réapplique les routes Caddy et les configs edge de toutes les apps (`syncAll`) : la base reste la source de vérité. Redémarrer Caddy ou le control plane ne casse rien (vérifié).

### Rôle `app_<id>_owner` (recommandation 3 de M0)

- **Attributs** : `LOGIN INHERIT`, `CONNECTION LIMIT 15`, `statement_timeout = 60s`. Il est propriétaire de la base, du schéma `public` et de `supabase_migrations` (schéma et table).
- **Grants** :
  - `USAGE` sur `auth` et `extensions` ;
  - `SELECT, REFERENCES` sur `auth.users`, pour les FK et les policies ;
  - `EXECUTE` sur les fonctions de `auth`.
- **Default privileges** : `ALTER DEFAULT PRIVILEGES FOR ROLE app_<id>_owner IN SCHEMA public GRANT ALL ON TABLES, SEQUENCES, FUNCTIONS TO anon, authenticated, service_role`. On retrouve le comportement de `postgres` sur Supabase : une table créée par une migration est exposée, et c'est la RLS qui la protège.
- **Usages** : `apply_migrations`, `execute_sql` et `SUPABASE_DB_URL` dans les fonctions.
- **Limites** : il ne lit pas `pg_authid` et ne se connecte qu'à sa propre base (vérifié par l'e2e).
- La migration de démo (FK vers `auth.users`, `auth.uid()` dans les policies) passe sans modification avec ce rôle.

### Outils MCP

| Outil | Comportement |
|---|---|
| `whoami` | Email, rôle, URL de l'API, apps accessibles |
| `list_apps` / `get_app` | URL, `supabase_url`, anon key, versions live du front et des fonctions. **Jamais** la clé service_role |
| `create_app(name, slug?)` | Provisioning idempotent. Le slug est dérivé du nom s'il n'est pas fourni ; `api`, `admin`, `studio` et `www` sont réservés |
| `apply_migrations(app, migrations[{version,name?,sql}])` | Verrou consultatif. Les versions déjà présentes sont ignorées, les nouvelles appliquées **dans une seule transaction** (tout ou rien) et inscrites dans `supabase_migrations.schema_migrations` (format de la CLI). Puis `NOTIFY pgrst` et le linter |
| `execute_sql(app, sql, write=false)` | Rôle owner, 200 lignes max, timeout 15 s. En lecture : `BEGIN READ ONLY` puis requête nommée. Le protocole étendu n'accepte qu'**une seule instruction**, donc impossible de glisser un `COMMIT; DROP ...`. En écriture : transaction, journalisée dans `audit_log` |
| `create_deployment(app, kind)` | Version suivante ; URL `PUT /uploads/<token>` à usage unique (TTL 15 min, 200 Mo max) ; commande `howto` avec `tar` et `curl` |
| `finalize_deployment(id)` | Voir le détail ci-dessous |
| `list_deployments`, `rollback(app, kind, version?)` | Retour à la version `ready` précédente, ou à une version donnée (y compris en avant) |
| `set_secrets` / `list_secrets` | Valeurs chiffrées, jamais renvoyées. `null` supprime un secret. Préfixes `SUPABASE_`, `SB_`, `PLATFORM_` et `DENO_` refusés. La config edge est régénérée, et la requête suivante part sur un nouveau worker |
| `get_logs(app, service?, since_minutes, limit, query?)` | Fusionne, triés par horodatage : les logs Docker des conteneurs `platform.app=<slug>`, les lignes JSON de `plat-edge` dont `app` vaut le slug, et les lignes de `plat-db` qui contiennent `db=app_<id>` |

`finalize_deployment` procède ainsi :
1. **Il liste l'archive avant de l'extraire** et la refuse si elle contient un symlink, un hardlink, un device, un chemin absolu ou `..`. Le nombre d'entrées et la taille décompressée sont plafonnés.
2. **Il extrait** sans `preserveOwner`, en ignorant les fichiers `._*` de macOS.
3. **Il renomme** le résultat en `v<N>`, puis bascule `current` de façon atomique (symlink temporaire + `rename`).

Ce qui change selon le type de déploiement :
- **Frontend** : `index.html` doit se trouver à la racine de l'archive (ou sous `dist/`).
- **Functions** :
  - la racine est `supabase/functions`, `functions` ou la racine de l'archive ;
  - les noms sont validés et chaque fonction doit avoir un `index.ts` ;
  - `functions.json` est généré depuis `supabase/config.toml` (`verify_jwt`, `enabled`), avec `verify_jwt=true` par défaut ;
  - `config/apps/<slug>.json` est réécrit.

**Contrôle d'accès** : chaque outil résout l'app via `app_members`, et les admins voient tout. Une app inconnue et une app non autorisée renvoient la même erreur (« not found »).

**Transport** : le MCP est **stateless** (un `McpServer` par requête, lié à l'utilisateur du PAT) et répond en JSON (`enableJsonResponse`).

### Couverture du test e2e

| # | Vérifié |
|---|---|
| 1 | `whoami` (admin) et présence des 13 outils |
| 2 | `create_app("demo")` : URL `http://demo.localhost:8100`, anon key, pas de service key ; un deuxième appel donne le même résultat ; `/auth/v1/health` répond à travers Caddy |
| 3 | Migration `todos` + RLS : aucune alerte. Re-jeu : `applied: []`, `skipped: [version]`. Migration sans RLS : alerte `rls_disabled_in_public` (ERROR) sur `public.lint_probe`. Lot dont la 2ᵉ migration échoue : erreur explicite et **rien** d'appliqué. Puis nettoyage et vérification de la trace dans `schema_migrations` |
| 3b | `execute_sql` : un `CREATE` sans `write` est refusé (lecture seule) ; `commit; create ...` est refusé ; `pg_authid` est illisible |
| 4 | Secrets : seul le nom est lisible, un nom réservé est refusé. Déploiement : tar de `supabase/functions/{hello,ping}` + `config.toml`, upload par `fetch` en PUT, **réutilisation de l'URL → 404**, finalize → `functions.json` correct. Appels : `ping` (`verify_jwt=false`) → 200 sans JWT ; `hello` sans JWT → 401 |
| 4b | Une archive contenant un symlink est refusée ; une archive contenant `../outside.txt` aussi |
| 5 | Front v1 puis v2 : `/`, route SPA profonde (fallback), `Cache-Control: no-cache` sur le HTML et `immutable` sur `/assets/*`, `get_app.frontend_version` à jour |
| 6 | `supabase-js` : deux signups ; insert et select sous RLS (bob ne voit rien, anon non plus). `functions.invoke("hello")` : la fonction relit les todos de l'appelant via `SUPABASE_URL` avec son JWT, et voit le secret `GREETING` et la service key |
| 7 | `rollback` du front de v2 vers v1 (contenu servi et `list_deployments` à jour), puis retour en v2 |
| 8 | `get_logs` renvoie des lignes, dont gotrue. Avec `service=functions`, seulement des lignes edge où `app` vaut `demo`, dont l'appel à `hello` |
| 9 | Un PAT invalide reçoit HTTP 401 (et le `connect` du SDK est rejeté). Un `developer` non membre a `apps: []`, et `get_app`, `execute_sql`, `create_deployment`, `get_logs` et `create_app` (même slug) échouent tous |

### Mesures (`docker stats`, après l'e2e)

| Conteneur | RAM |
|---|---|
| `plat-control-plane` | ~100 Mo |
| `plat-db` (1 app) | ~120 Mo |
| `plat-edge` (2 fonctions chaudes) | ~100 Mo |
| `plat-caddy` | ~20 Mo |
| `plat-demo-auth` / `plat-demo-rest` | 15 Mo / 35 Mo |

## Écarts au plan et choix faits en autonomie

1. **`pg` brut plutôt que Drizzle ou Kysely.** Il y a une vingtaine de requêtes, et les helpers `one`/`many` suffisent. À reconsidérer avec l'API REST de l'admin (M4).
2. **Pas de file de jobs.** Le provisioning est synchrone dans l'appel MCP, ce qui reste acceptable à environ 1 s. L'idempotence (statut `error`, puis reprise par un nouveau `create_app`) remplace la reprise automatique.
3. **Le control plane se connecte en `supabase_admin` (superuser)**, à la base `platform` comme aux bases d'apps pour le provisioning. `postgres` n'est plus utilisé côté apps : le rôle owner le remplace.
4. **Dans les fonctions, `SUPABASE_URL` pointe sur une passerelle interne** (`http://caddy:8180/<slug>`), pas sur l'URL publique.
   - En dev, `demo.localhost` résout vers `127.0.0.1` dans le conteneur edge, donc l'URL publique y est injoignable.
   - Le serveur Caddy interne, non publié, route `/<slug>/{auth,rest,functions}/v1`.
   - L'URL publique reste disponible dans `SUPABASE_PUBLIC_URL`.
   - En production, ce choix est aussi plus robuste : ni hairpin NAT ni TLS en interne.
5. **`SUPABASE_DB_URL` utilise le rôle owner de l'app**, l'équivalent de la chaîne `postgres` de Supabase Cloud. Un rôle `_fn` dédié reste possible.
6. **Le linter se limite à 5 requêtes** réécrites d'après splinter : `rls_disabled_in_public`, `rls_enabled_no_policy`, `policy_exists_rls_disabled`, `security_definer_view`, `function_search_path_mutable`. Elles tournent avec le rôle owner. Le splinter complet n'est pas intégré.
7. **`execute_sql` en lecture n'accepte qu'une seule instruction** (protocole étendu). En écriture, plusieurs instructions sont acceptées.
8. **`rollback(app, kind, version?)` exige `kind`**, puisque front et fonctions sont versionnés séparément.
9. **Outils non faits** (hors de la liste demandée) : `list_tables`, `generate_types`, `configure_auth`, `stop_app` et `start_app`. La suppression d'une app existe (`deleteApp`, symétrique de `provision`), mais seulement en CLI.
10. **Sautés comme prévu** : Storage, Realtime, Studio, TLS (endpoint `ask`) et Loki.
11. **Le host de l'API est figé** (`api.localhost`) dans `deploy/caddy/caddy.json`. Il faudra le templater dans `install.sh` pour la production.

## Pièges rencontrés

- **L'API admin de Caddy refuse les appels faits avec `fetch` (undici)** : 403 `client is not allowed to access from origin ''`.
  - Cause : undici envoie `Sec-Fetch-Mode`, ce qui pousse Caddy à exiger un header `Origin` autorisé.
  - Correctif : envoyer `Origin: http://caddy:2019`, qui figure dans `admin.origins`.
  - En M0, curl n'envoyait pas ce header, d'où l'absence du problème.
- **Les tar de macOS contiennent des `._*` (AppleDouble).** La commande `howto` pose `COPYFILE_DISABLE=1`, et l'extraction ignore de toute façon `._*` et `__MACOSX`.
- **Node 24 exécute le TypeScript directement** (type stripping), y compris les paquets du workspace liés par symlink. Il n'y a pas de build, mais la syntaxe doit rester « effaçable » (`erasableSyntaxOnly` : ni enum, ni parameter properties).

## Dette et limites connues

- **Réseau** : l'edge partage le réseau de Postgres, GoTrue, PostgREST et du control plane (recommandation 8 de M1 non appliquée).
  - Une fonction peut joindre `db:5432`, mais avec les seuls identifiants owner de son app.
  - Elle peut aussi joindre `control-plane:3000`, protégé par PAT.
  - À corriger avec un réseau `edge` qui ne contient que Caddy.
- **Socket Docker monté dans le control plane** : c'est l'équivalent d'un accès root à l'hôte. Acceptable pour un prototype ; en production, il faudrait au minimum un proxy de socket filtrant.
- **`postgres` garde `CREATEROLE`** (recommandation 4 de M0 non appliquée).
- **Déploiements** : pas de préchauffage des fonctions avant la bascule (recommandation de M1), pas de nettoyage des anciennes versions de sites et de fonctions, pas de purge des archives d'upload jamais finalisées.
- **Migrations** :
  - une migration qui contient elle-même `BEGIN` / `COMMIT` casse l'atomicité du lot ;
  - `statements` est stocké comme un tableau à un seul élément, alors que la CLI découpe par instruction. Aucun impact sur `migration list` ; à vérifier pour `db pull` et `db diff`.
- **Tokens** : les colonnes `scopes` et `app_ids` existent mais ne sont pas appliquées. Pas de révocation par l'API (SQL seulement).
- **`get_logs`** relit les logs Docker avec un tail borné : pas d'historique au-delà de la rotation Docker, et un coût linéaire. Loki et Vector sont prévus pour ça.
- **Concurrence** :
  - deux `create_deployment` simultanés peuvent viser la même version (la contrainte d'unicité renvoie alors une erreur) ;
  - deux `finalize` concurrents sur un même couple app / type ne sont pas sérialisés.
- **Images** : l'orchestrateur ne les tire pas, elles sont supposées présentes.
- **Clé maître** : stockée dans `deploy/.env`, sans rotation ni rechiffrement des secrets.
- **`syncAll`** fait un appel admin par app au démarrage. Un `PATCH` global de la subroute serait plus propre à 50 apps.

## Recommandations pour la suite

1. **M3 (plugin)** :
   - `.mcp.json` en `type: http`, avec le header `Authorization: Bearer ${PLATFORM_TOKEN}` ;
   - la skill peut réutiliser la commande `howto` renvoyée par `create_deployment` ;
   - lire les versions depuis les noms de fichiers `supabase/migrations/<version>_<name>.sql` ;
   - **s'arrêter si le linter remonte un `ERROR`**.
2. **Préchauffage** : ajouter `/_internal/warm` au main worker et l'appeler dans `finalize_deployment` (functions) avant la bascule. Les `BOOT_ERROR` remontent alors avant la mise en ligne, et les dépendances `npm:` sont déjà téléchargées.
3. **Isolation** : mettre l'edge sur son propre réseau, et créer un rôle `_fn` limité pour `SUPABASE_DB_URL`.
4. **Cycle de vie** : ajouter `delete_app`, `stop_app` et `start_app` en MCP, et purger les anciennes versions (garder les N dernières). Une file de jobs deviendra utile avec les backups.
5. **Droits et admin** : appliquer `scopes` et `app_ids` dans `appForUser`, et exposer la gestion des users et des tokens en REST pour l'admin (M4).

## Infos de connexion (stack laissée démarrée)

| Élément | Valeur |
|---|---|
| MCP | `http://api.localhost:8100/mcp`, header `Authorization: Bearer <PAT>` |
| PAT admin | `deploy/.env.local` (`PLATFORM_TOKEN`), compte `admin@example.com` |
| App demo | `http://demo.localhost:8100` (front v2), `/auth/v1`, `/rest/v1`, `/functions/v1/{hello,ping}` |
| Postgres | `127.0.0.1:54350`, `supabase_admin` / `POSTGRES_PASSWORD` dans `deploy/.env` ; bases `platform`, `app_demo`, `template_supabase` |
| Caddy admin | `http://127.0.0.1:2030` |
| Relancer | `deploy/install.sh` (idempotent), puis `pnpm --filter @platform/control-plane e2e` |
| CLI | `docker exec plat-control-plane node src/cli.ts create-user <email> [admin\|developer]` (affiche un PAT) ; `... delete-app <slug>` |

## Correctifs post-M3

Date : 2026-10-01. Ils corrigent les deux défauts relevés par M3 (`spikes/m3-plugin/REPORT.md`, « Améliorations proposées > MCP / control plane », points 1 et 2).

### 1. Linter dans la transaction (`apply_migrations`)

- Le linter tourne **dans la transaction**, après les migrations, avec le rôle owner. Il tourne aussi au début de la transaction : seules les `ERROR` **nouvelles** (couple lint/objet absent avant le lot) bloquent. Les `ERROR` déjà présentes en base sont renvoyées dans `lints` sans bloquer, pour ne pas figer une app existante.
- **Au moins une `ERROR` nouvelle** : `ROLLBACK`. Rien n'est appliqué ni inscrit dans `schema_migrations`. L'outil renvoie une erreur MCP dont le corps est du JSON : `status: "rejected"`, `applied: []`, `would_apply`, `skipped`, `blocking_lints`, `lints` et un message. La tentative est journalisée (`apply_migrations_rejected`).
- **`accept_lints`** (optionnel) : une liste de noms de lints (`"security_definer_view"`) ou de couples `{ name, object }`. Les `ERROR` correspondantes ne bloquent plus, et elles sont journalisées dans `audit_log` (`details.accepted_lints`) et dans le manifeste du déploiement `migrations`.
- **`dry_run: true`** : applique, lance le linter, puis fait toujours un `ROLLBACK`. Il renvoie `status: "dry_run"`, `applied: []`, `would_apply`, `blocking_lints` et `lints`.
- Les `WARN` et `INFO` ne bloquent pas. Le schéma zod (`packages/shared`) porte les deux nouveaux paramètres.

### 2. Préchauffage avant la bascule (`finalize_deployment`, functions)

- **Main worker** : nouvel endpoint `POST /_internal/warm` avec le corps `{ app, version, function }`.
  - Il exige `X-Platform-Admin-Token` et refuse toute requête qui porte le gateway token, c'est-à-dire tout ce qui passe par Caddy.
  - Caddy renvoie en plus 404 sur `/functions/v1/_internal/*`, pour toutes les apps. Avant ce correctif, `/_internal/health` et `/_internal/metrics` étaient joignables à travers la route publique de chaque app (metrics restait protégé par le token).
  - Il résout la fonction dans `v<N>`, sans passer par `current`, crée le user worker avec l'env de l'app (même `servicePath` que la vraie requête), puis envoie une **requête CORS preflight** (`OPTIONS` avec `Origin` et `Access-Control-Request-Method`).
  - Choix documenté : le handler est bien appelé, mais avec une requête OPTIONS, que les fonctions Supabase traitent par convention sans effet de bord. C'est aussi ce que faisait déjà le smoke test de la skill.
  - Les erreurs de graphe de modules (import npm introuvable) sortent dès `userWorkers.create` (`InvalidWorkerCreation`, code `BOOT_ERROR`). Une exception levée au chargement du module sort au premier `fetch` (`InvalidWorkerResponse`, code `WARM_FAILED`).
  - Timeout : 45 s côté edge (`PLATFORM_WARM_TIMEOUT_MS`), 60 s côté control plane (`WARM_TIMEOUT_MS`).
- **Piège** : `worker.fetch()` exige le tag interne de la requête entrante (`streamRid`). Une `Request` synthétique échoue (`Cannot read properties of undefined (reading 'streamRid')`) tant qu'on ne lui applique pas `EdgeRuntime.applySupabaseTag(req, preflight)`.
- **Control plane** : après l'extraction en `v<N>` et avant `switchCurrent`, `finalize_deployment` préchauffe toutes les fonctions en parallèle. Si une seule échoue, le déploiement passe à `failed` avec l'erreur (par exemple `broken: BOOT_ERROR ... Could not find npm package '@supabase/supabase-js' matching '2.999.0'`), le répertoire `v<N>` est supprimé et `current` n'est pas touché. En cas de succès, la réponse contient `warm` (statut et durée par fonction). Le control plane reçoit `PLATFORM_EDGE_ADMIN_TOKEN` (compose).
- **Cache npm** : le préchauffage remplit `DENO_DIR` (volume `deno-cache`). L'e2e supprime `is-odd` du cache, déploie une fonction qui l'importe, vérifie que le paquet est revenu dans le cache **avant toute requête réelle**, puis que le premier appel public répond en moins de 1,5 s. Comme `forceCreate: false` et que le `servicePath` est le même, le worker préchauffé est même réutilisé s'il est encore en vie.

### Tests

- **e2e** : 13/13 en environ 2,3 s. Les nouveaux cas :
  - table sans RLS et vue `security definer` rejetées (objet absent de la base, version absente de `schema_migrations`) ;
  - `dry_run` ;
  - la même vue acceptée avec `accept_lints`, plus la trace dans `audit_log` ;
  - une fonction `npm:@supabase/supabase-js@2.999.0` : finalize échoue, `functions_version` inchangée, l'ancienne `ping` répond toujours ;
  - `/_internal/warm` et `/_internal/metrics` répondent 404 par la route publique, même avec le bon token.
- **Unitaires du main worker** : `deno test --allow-read --allow-write`, 5/5 (`parseVersion` et `resolveFunction` sur une version donnée en plus).
- **`pnpm -r typecheck`** passe.
- La stack a été reconstruite avec `deploy/install.sh`. `todo-app` (front et fonction `summary`) et `demo` répondent toujours.

### Reste à faire

- Une migration qui contient elle-même `COMMIT` échappe toujours au rollback, donc au linter bloquant.
- Le préchauffage appelle le handler sur `OPTIONS`. Une fonction qui fait des effets de bord quelle que soit la méthode les fera aussi au déploiement.
- Une fonction qui lit un secret au boot doit avoir ses secrets posés **avant** `finalize_deployment` (sinon `WARM_FAILED`), ce qui correspond déjà à la consigne de la skill.
