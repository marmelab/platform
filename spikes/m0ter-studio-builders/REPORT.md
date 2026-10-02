# M0ter : Studio multi-head pour les app builders

Date : 2026-10-02. Base : la stack `plat` et le fork au commit `f88e4b4`. Machine : 32 Go, dont 8 Go pour Docker Desktop.

## Verdict

**Studio est intégré à la plateforme, et chaque builder n'y accède qu'à ses apps.**

- **Un seul login**, celui de la plateforme : `studio.localhost:8100/_platform/login`. Studio n'a plus de GoTrue à lui ni de second login.
- **Double barrière**, testée barrière par barrière :
  - la forward auth du control plane, avec une liste blanche de routes et un contrôle de la ref ;
  - un garde dans Studio, qui vérifie l'identité signée par HMAC, la ref et les fonctions interdites.
- **Ce qui marche sur la bonne app** : table editor, éditeur SQL, policies, et Auth > Users en écriture.
- **Storage** vise le bon projet et échoue proprement.
- **Plus de `projects.json`.**
- **RAM** : Studio environ 240 Mo en natif, contre environ 410 Mo en émulation dans M0bis.

## Architecture

Caddy sert l'hôte `studio.localhost`. La route `studio` est poussée par le control plane au démarrage. Pour chaque requête :

1. Caddy supprime les en-têtes `X-Platform-*` envoyés par le client.
2. Les chemins `/_platform/*` partent vers `control-plane:3000` (login et logout).
3. Tout le reste passe d'abord par `forward_auth` vers `control-plane:3001/studio/verify` :
   - le control plane lit le cookie, retrouve les apps de l'utilisateur et applique la politique sur l'URI brute ;
   - si l'accès est autorisé, il répond 200 avec `X-Platform-User`, `X-Platform-Role`, `X-Platform-Apps` et `X-Platform-Signature` (HMAC horodaté) ;
   - sinon : 302 vers le login, 401, 403 ou 400.
4. La requête arrive à `studio:3000`, qui ne publie aucun port :
   - `proxy.ts` appelle `platformGuard` ;
   - `apiWrapper` appelle `withPlatformRequest`, qui place l'identité dans un AsyncLocalStorage, renvoie 403 si la ref est étrangère et rafraîchit la config des projets (cache de 2 s) ;
   - `projectsStore` ne renvoie que les projets de cette identité ;
   - pg-meta passe par `studio-meta`, avec la connexion de l'owner du projet (`x-connection-encrypted`) ;
   - les routes Auth et Storage appellent `http://caddy:8180/<slug>` avec la service key de l'app.

**Projets et liens.**
- La ref Studio est le slug de l'app.
- `get_app` renvoie `studio_url`.
- Slugs réservés : `api`, `admin`, `studio`, `www`, `default`.

**Comptes et sessions.**
- Le mot de passe est stocké dans `users.password_hash`, hashé en scrypt (N=16384).
- Table `sessions` : hash sha256 du jeton, durée 12 h.
- Cookie `platform_session` : HttpOnly, SameSite=Lax, host-only, Secure si le site est en https.
- Un compte inconnu coûte le même temps de scrypt qu'un mauvais mot de passe.

**Listener interne `:3001`.**
- Il porte `/studio/verify` et `/internal/studio/projects`, et n'est jamais routé publiquement.
- `/_platform/*` n'est servi que si le Host est celui de Studio.

**`StudioRegistry` (implémentation `MultiHeadStudio`).**

| Méthode | Appelée par | Rôle |
|---|---|---|
| `register` | `provision`, donc `create_app` | Ajoute à l'owner les droits dont Studio a besoin |
| `unregister` | `deleteApp` | Rien à faire : la config est tirée par Studio |
| `syncAll` | démarrage du control plane | Pousse la route Caddy et enregistre chaque app ; c'est ce backfill qui a fait apparaître `demo` et `todo-app` |
| `deepLink` | `get_app` | Lien `studio_url` |
| `projects` | endpoint interne | Config servie à Studio |

**Secrets : option (i).**
- Studio appelle `GET /internal/studio/projects` avec un Bearer `PLATFORM_STUDIO_CONFIG_TOKEN`, comparé à temps constant.
- Le cache dure 2 s. Si le control plane ne répond plus, la config reste servie 30 s au plus, puis la liste devient vide.
- Rien n'est écrit sur disque.
- Le `jwt_secret` n'est pas transmis : Studio ne s'en sert que pour l'afficher.

**Owner, par rapport à M0bis.** `register` ajoute :
- `NOBYPASSRLS` (le `BYPASSRLS` du premier jet est retiré, y compris sur `demo` et `todo-app` via `syncAll`) ;
- `GRANT anon, authenticated, service_role WITH INHERIT FALSE, SET TRUE` ;
- `USAGE` sur `graphql` et `graphql_public` ;
- `SELECT` sur `auth.users` et `auth.identities` seulement (le `SELECT` sur toutes les tables `auth` et les default privileges de `auth_admin` sont révoqués) ;
- `TRIGGER` sur `auth.users` (`REFERENCES` vient du provisioning).

Les tables `auth.*` ont la RLS activée sans policy. L'owner les lit donc par une policy dédiée, créée dans la base de l'app par `supabase_admin` :

| Table | Policy | Lue par |
|---|---|---|
| `auth.users` | `platform_owner_read FOR SELECT TO app_<id>_owner USING (true)` | pg-meta : liste, détail et comptage des utilisateurs (Auth > Users) |
| `auth.identities` | idem | pg-meta : colonne « providers » de la liste et du détail |

Les autres tables `auth` (`sessions`, `refresh_tokens`, `mfa_*`, `one_time_tokens`, `flow_state`, `sso_*`, `saml_*`, `audit_log_entries`, `oauth_*`, `webauthn_*`…) renvoient `permission denied`. Studio ne les lit pas en SQL : les écritures d'utilisateurs (création, suppression, facteurs MFA) passent par l'API GoTrue avec la service key. Les FK vers `auth.users` (contrôles RI, qui ignorent la RLS) et les triggers sur `auth.users` n'ont besoin que de `REFERENCES` et `TRIGGER`. `anon`, `authenticated`, `service_role` et `app_<id>_authenticator` n'y gagnent rien : la policy ne vise que l'owner.

La RLS reste activée sur ces tables (réactivée par `register` si besoin). Les policies survivent à un redémarrage de GoTrue, qui ne rejoue que les migrations nouvelles. Une migration GoTrue qui recréerait une table les perdrait : `register` (création d'app, `syncAll` au démarrage du control plane) les recrée si elles manquent, et c'est une étape de la mise à jour (A8 dans `docs/USER_JOURNEYS.md`). Pour la même raison, `provision` appelle `register` une fois GoTrue sain, quand `auth.identities` existe.

Conséquence : `execute_sql` et `SUPABASE_DB_URL` ne contournent plus la RLS hors des tables possédées par l'owner. Comportement assumé : l'owner, propriétaire des tables de `public`, n'est pas soumis à leur RLS (sauf `FORCE ROW LEVEL SECURITY`), comme le `postgres` de Supabase. `SET ROLE service_role` (qui a `BYPASSRLS`) n'ouvre rien de plus dans `auth`, faute de privilèges sur ces tables. Une vue ou une fonction `SECURITY DEFINER` de l'owner qui lit `auth.users` expose toutes les lignes, comme avant ; le lint 0002 le signale.

**postgres-meta partagé.** Sa connexion par défaut pointe sur la base vide `studio_meta_default`, avec un rôle du même nom sans aucun privilège. Les deux sont créés par `init`.

## Patches (`apps/studio/PLATFORM_PATCHES.md`)

Le code plateforme est dans `apps/studio/platform/` (`identity.ts`, `guard.ts`, `projects.ts`, `projectApi.ts`). Les fichiers du fork ne reçoivent que de petits points d'accroche.

| # | Patch | Fichiers |
|---|---|---|
| 1 | Garder le code du fork hors de `pnpm -r typecheck` | scripts renommés `typecheck:upstream` |
| 2 | Build sur l'hôte | `outputFileTracingRoot`, `build.sh`, `Dockerfile.platform` |
| 3 | Identité signée et garde | hook dans `proxy.ts` |
| 4 | Projets lus depuis le control plane et filtrés par identité | `apiWrapper.ts`, `projectsStore.ts`, `instrumentation.ts` (health poller coupé), profil |
| 5 | Correctif propre du proxy pg-meta | `pgMetaProxy.ts`, `query.ts` |
| 6 | Routes Auth et Storage par projet | 17 routes plus `api/rest.ts` |

## Routes de Studio et leur traitement

Studio compte 124 routes dans `pages/api` et 2 dans `app/api`. La politique est dans `apps/control-plane/src/studio/policy.ts` : liste blanche, et refus par défaut de tout le reste.

**Routes de projet autorisées pour les membres de l'app** (les admins ont accès à toutes les apps) :
- `pg-meta`, `auth`, `storage` et `database` sous `/<ref>/` : toutes méthodes ;
- `projects/<ref>/{content,api,run-lints}` : toutes méthodes ;
- `projects/<ref>/…` (settings, api-keys, config, etc.) : **GET seulement** ;
- `props/project/<ref>` : GET ;
- `v1/projects/<ref>/{types/typescript,api-keys,database/migrations}` : GET.

**Refusées à tout le monde, admins compris :**
- `projects/<ref>/{failover,cluster-failover,replica,standby,migrate,pocketbase-migrate,db-password,analytics,billing}` ;
- `v1/projects/<ref>/functions*`, parce que le dossier de fonctions du fork est commun à tous les projets ;
- `POST` sur `projects`, `projects/import`, `PATCH` et `DELETE` sur un projet ;
- `/api/self-hosted/*` ;
- `license`, `integrations`, `mcp`, `ai`, `edge-functions`, `connect`, `content`, `generate-attachment-url`, `check-cname`.

**Lectures sans données de projet :**
- organisations, profil, notifications, `props/org` : GET seulement ;
- les projets d'organisation sont filtrés et le profil affiche l'utilisateur plateforme ;
- les routes utilitaires (heure, IP, version, incidents) sont autorisées.

**Pages :**
- `/project/<ref>` et `/_next/data/…/project/<ref>` : membres seulement ; sinon page HTML « Access denied » ;
- `/new`, `/setup`, `/sign-in`, `/sign-up` : refusées ;
- toutes les autres pages exigent une session.

**Rejets avant analyse (400)** : un segment `..` ou `.`, `//`, `\`, `%2e`, `%2f`, `%5c`, `%00`, et une casse différente sur `/api`, `/project` ou `/_next`.

**Format de la ref** : elle doit correspondre exactement à `^[a-z][a-z0-9-]{1,30}[a-z0-9]$`. Sinon 403.

## Tests

**e2e Studio : 10/10, en environ 4 s.** Il vérifie :
- le login : un mauvais mot de passe renvoie 401 sans cookie ;
- sans session : l'API répond 401, une page redirige vers le login, un cookie forgé reçoit 401 ;
- les listes filtrées : alice voit `[demo]`, bob `[todo-app]`, l'admin les deux ;
- alice sur demo :
  - la requête pg-meta répond `app_demo_owner/app_demo` ;
  - `GET tables` renvoie `todos`, preuve que le bug pg-meta est corrigé.
- alice sur todo-app, toujours refusée :
  - par l'URL ;
  - avec des en-têtes `X-Platform-Apps` ou `X-Platform-Role` forgés ;
  - avec la ref encodée (`todo%2Dapp`, `%74odo-app`) ;
  - en majuscules (`TODO-APP`) ;
  - avec `..` en clair ou encodé (`%2e%2e`) ;
  - avec `/API/…` ;
  - sur la page, la route auth et les types.
- bob est refusé sur demo ;
- le garde de Studio, appelé seul et directement depuis le réseau : 401 sans identité, 401 si les apps ont été modifiées après signature, 401 si la signature a expiré, 403 sur une ref étrangère, 200 sur la sienne ;
- bootstrap, import, création et suppression de projet, failover : refusés à alice et à l'admin ;
- l'admin interroge les deux apps ;
- un utilisateur auth créé par alice sur demo :
  - il est présent dans le GoTrue de demo, vérifié avec la service key de demo ;
  - il est absent de celui de todo-app ;
  - il est visible en SQL, puis supprimé.
- storage : erreur JSON propre sur demo, 403 sur todo-app ;
- le logout ramène à 401.

**Autres suites** :

| Suite | Résultat |
|---|---|
| Politique d'accès en unitaire | 4/4 |
| e2e du control plane (M2) | 13/13 |
| `deno test` du main worker | 5/5 |
| `pnpm -r typecheck` | vert |
| demo et todo-app (front, fonctions) | OK |

**Parcours navigateur.** Le panneau fait environ 800 px de large, donc Studio s'affiche en mise en page mobile. Les captures sont dans `screenshots/` :

| Capture | Ce qu'elle montre |
|---|---|
| `01-login` | Page de login de la plateforme |
| `02-organizations-alice` | « 1 project » |
| `03-projects-alice-demo-only` | Seul demo apparaît |
| `04-table-editor-todos` | Lignes de `todos` et 4 policies RLS |
| `05-sql-editor` | `app_demo_owner` / `app_demo`, 8 todos |
| `06-auth-create-user-dialog` | Formulaire de création d'utilisateur |
| `07-auth-user-created` | 17 utilisateurs ; présent dans `app_demo`, absent de `app_todo_app` ; supprimé ensuite |
| `08-todo-app-denied` | « no access to project "todo-app" » |

Seules requêtes refusées pendant le parcours : `GET /api/platform/integrations/*`, sans effet visible.

## Build

- **Commandes** :
  - `apps/studio/build.sh` (ou `PLATFORM=linux/amd64 apps/studio/build.sh`) ;
  - `STUDIO_BUILD=1 deploy/install.sh` pour reconstruire Studio puis la stack.
- **Étapes** : `pnpm install --frozen-lockfile` à la racine, puis `next build` sur l'hôte (85 à 100 s, 8,3 Go de RSS).
- **Variables de build** : `NEXT_PUBLIC_STUDIO_AUTH` et `NEXT_PUBLIC_IS_PLATFORM` absentes ; `SKIP_ASSET_UPLOAD=1` ; télémétrie désactivée.
- **Sentry** est inactif : `withSentryConfig` n'est appliqué que pour `IS_PLATFORM`, et aucun DSN n'est fourni.
- **Image** :
  - elle part de la sortie standalone et de `node:22-slim`, puis installe `sharp` pour la plateforme cible ;
  - les deux architectures ont été vérifiées : arm64 charge `sharp`, et amd64 se construit et contient `sharp-linux-x64` ;
  - taille : 1,13 Go.
- **Échecs rencontrés et corrigés**, sans revenir à l'image publiée :
  - `@/evals/output` est importé par `lib/ai` : le dossier `evals/` est conservé ;
  - la sortie standalone s'enracinait dans `~` à cause d'un `~/package-lock.json` : corrigé par `outputFileTracingRoot` ;
  - les chemins `../../packages/ui` pointent maintenant vers `vendor/ui` ;
  - `node:async_hooks` se retrouvait dans un bundle client : remplacé par `process.getBuiltinModule` avec une initialisation paresseuse ;
  - le nettoyage de `.next` échouait parfois en `ENOTEMPTY` : `build.sh` vide maintenant `.next`, sauf le cache.

## RAM

| Conteneur | RAM |
|---|---|
| `plat-studio` | environ 240 Mo |
| `plat-studio-meta` | environ 130 Mo |
| `plat-control-plane` | environ 160 Mo |

Le surcoût de Studio est donc d'environ 0,37 Go, fixe quel que soit le nombre d'apps.

Les stacks compose m0bis et m0 sont arrêtées, données et volumes conservés. Les conteneurs `m0-app{1,2}-{auth,rest}`, créés hors compose par les scripts de M0, tournent encore (environ 110 Mo).

## Dette

| Sujet | Situation | Effort estimé |
|---|---|---|
| Snippets SQL | Désactivés, le dossier du fork étant commun à tous | 0,5 j (un dossier par ref) |
| Storage | 500 JSON tant que M5 n'existe pas | Ajouter `/storage/v1` aux routes internes de Caddy avec M5 |
| Functions et Logs | Fonctions refusées, logs vides (Logflare global) | 2 à 3 j |
| GraphiQL | `api/graphql.ts` utilise encore `SUPABASE_URL` global | 1 h |
| Clé `service_role` | Affichée par Settings > API keys, comme Studio upstream. Sans `BYPASSRLS` sur l'owner, elle donne plus que la base : l'API admin de GoTrue (toutes les tables `auth` en lecture et écriture) et PostgREST en `service_role` | 0,5 j pour la masquer |
| Policies `auth` de l'owner | Recréées par `register` si une migration GoTrue recrée `auth.users` ou `auth.identities` ; entre la migration et le prochain `syncAll`, Auth > Users est vide | Rejouer `syncAll` après chaque mise à jour de GoTrue (A8) |
| Métadonnées du cluster | `pg_database` et `pg_roles` laissent voir les noms des autres apps | Non trivial |
| Typecheck du fork | Rouge en amont | Suivre l'amont |
| Workspace unique | `node_modules` de 1,9 Go ; les overrides du fork s'appliquent à tout le workspace ; le réglage `minimumReleaseAge` du fork a été retiré | — |
| Cookie de session | Transmis à Studio, et à pg-meta via `constructHeaders` | 1 h (le supprimer dans Caddy) |
| Forward auth | 2 requêtes SQL par requête Studio ; pas de limite de tentatives de login ; pas de jeton CSRF | 0,5 j |
| Révocation | Une app retirée reste visible 2 s au plus (cache) | — |
| UI du fork | « New project », « New organization » et le libellé Enterprise restent visibles et répondent 403 | 0,5 à 1 j |
| Réseau | Studio et le port 3001 sont joignables depuis l'edge (dette M2) ; protégés par la signature et le token | Réseau `edge` séparé |
| Image | Élagage de `.image` possible | 0,5 j |

## Mettre à jour le fork

La procédure détaillée est dans `apps/studio/UPSTREAM.md` :
1. Lancer `turbo prune studio` sur le nouveau commit, après `rm .npmrc`.
2. Faire un rsync vers `apps/studio` et `apps/studio/vendor/*`, en excluant les fichiers de la plateforme.
3. Fusionner le `pnpm-workspace.yaml` du fork, puis lancer `pnpm install`.
4. Rejouer par cherry-pick les 6 commits de `PLATFORM_PATCHES.md`.
5. Lancer `build.sh`, puis `e2e:studio`.

## Fichiers

- `apps/studio/` : le fork vendoré, avec :
  - `UPSTREAM.md`, `PLATFORM_PATCHES.md`, `build.sh`, `Dockerfile.platform` ;
  - `platform/` : le code plateforme ;
  - `vendor/` : les paquets du fork.
- Control plane :
  - `apps/control-plane/src/sessions.ts` ;
  - `apps/control-plane/src/studio/` : `policy.ts`, `registry.ts`, `routes.ts`, `pages.ts` ;
  - tests : `apps/control-plane/test/studio-policy.test.ts`, `apps/control-plane/test/studio.e2e.test.ts`.
- `packages/sql` : schéma (`sessions`, `password_hash`, `studio_id`), `studioClusterSql`, `studioDatabaseSql`, `studio_meta_default`.
- `deploy/docker-compose.yml` (services `studio` et `studio-meta`) et `deploy/install.sh`.

Quatre nouveaux secrets sont ajoutés à `deploy/.env` par `install.sh` s'ils manquent : `PLATFORM_STUDIO_HEADER_SECRET`, `PLATFORM_STUDIO_CONFIG_TOKEN`, `PG_META_CRYPTO_KEY`, `STUDIO_META_DEFAULT_PASSWORD`.
