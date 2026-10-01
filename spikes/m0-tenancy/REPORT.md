# Spike M0 : tenancy — rapport

Date : 2026-10-01. Images : `supabase/postgres:17.6.1.136`, `supabase/gotrue:v2.196.0`, `postgrest/postgrest:v14.17`, `caddy:2-alpine`. Machine : macOS, Docker Desktop 8 Go / 10 CPU.

## Verdict

**L'option B est validée.** Deux apps tournent sur un seul cluster Postgres, avec un GoTrue et un PostgREST chacune, servies en same-origin par Caddy (`http://app1.localhost:8080` et `http://app2.localhost:8080`).

- `supabase-js` fonctionne sans adaptation : signup, login, CRUD sous RLS.
- L'isolation tient au niveau HTTP : les JWT d'une app sont rejetés par l'autre.
- Elle tient aussi au niveau Postgres : chaque rôle LOGIN ne se connecte qu'à sa propre database.
- Le test e2e (`pnpm e2e`) passe 7/7, y compris après un teardown complet et une reconstruction à zéro.

Points clés :

- **Les noms de rôles fixes ne bloquent pas.** GoTrue fonctionne avec `app_<id>_auth_admin` et PostgREST avec `app_<id>_authenticator`. Il faut deux contournements : le `search_path` du rôle GoTrue, et le changement de propriétaire du schéma `auth` venu du template.
- **Le provisioning est rapide** : environ 2 s par app (rôles, database, 2 conteneurs, route Caddy), soit 18 apps en 38 s.
- **PostgREST est le premier poste mémoire.** Par défaut il prend environ 90 Mo sur une machine à 10 CPU, à cause de l'option RTS GHC `-N`. Avec `GHCRTS=-N2`, il descend à 25–45 Mo. Ce réglage est indispensable.
- **Pour 50 apps**, il faut prévoir environ 3,5–4,5 Go de RAM pour la couche tenancy et 250–350 connexions Postgres au pic. Supavisor n'est pas nécessaire à cette échelle, mais `max_connections` doit passer à 500.

## Ce qui a été construit

```
spikes/m0-tenancy/
  docker-compose.yml        # projet "m0" : db (54320) + caddy (8080, admin API sur 2020)
  caddy/caddy.json          # config bootstrap : route "apps" (subroute vide) + 404 par défaut
  sql/bootstrap.sql         # REVOKE CONNECT FROM PUBLIC sur postgres et template1
  sql/template.sql          # ajouts plateforme dans template_supabase (supabase_migrations)
  sql/demo-todos.sql        # migration de démo (table todos + RLS) utilisée par l'e2e
  scripts/up.sh             # démarre la stack, bootstrap, construit template_supabase
  scripts/init-template.sh  # clone "postgres" -> template_supabase (idempotent)
  scripts/create-app.sh     # provisioning d'une app (idempotent)
  scripts/delete-app.sh     # suppression symétrique d'une app
  scripts/teardown.sh       # supprime toutes les apps + la stack (--purge : données aussi)
  scripts/measure.sh        # docker stats + pg_stat_activity + tailles de DB
  scripts/scale-test.sh     # crée N apps jetables, charge, mesure, supprime
  scripts/gen-keys.mjs      # secret JWT + clés anon/service_role legacy (HS256) + mots de passe
  e2e/tenancy.test.ts       # node:test + @supabase/supabase-js + pg
  results/                  # sorties brutes des mesures
```

Utilisation :

```bash
cd spikes/m0-tenancy
pnpm install
scripts/up.sh
scripts/create-app.sh app1 && scripts/create-app.sh app2
pnpm e2e            # 7 tests
pnpm typecheck
scripts/measure.sh
scripts/scale-test.sh 18      # optionnel, ~3 min
scripts/teardown.sh [--purge]
```

### Provisioning d'une app (`create-app.sh <id>`)

1. **Secrets** (`apps/<id>/.env`, chmod 600) : secret JWT de 32 octets, clés `anon` et `service_role` au format legacy HS256, mots de passe des deux rôles. Le fichier est réutilisé s'il existe déjà, ce qui rend le script relançable.
2. **Rôles globaux**, créés en tant que `supabase_admin` :
   - `app_<id>_authenticator` : `LOGIN NOINHERIT CONNECTION LIMIT 20`, avec `GRANT anon, authenticated, service_role`. Il reprend les réglages de l'`authenticator` de l'image : `session_preload_libraries = supautils, safeupdate`, `statement_timeout`, `lock_timeout`.
   - `app_<id>_auth_admin` : `LOGIN NOINHERIT CONNECTION LIMIT 20`, avec `search_path = auth`. Il n'a **pas `CREATEROLE`**, contrairement à `supabase_auth_admin` : ce droit est inutile en pratique.
3. **Database** :
   - `CREATE DATABASE app_<id> TEMPLATE template_supabase OWNER postgres` ;
   - `REVOKE ALL ON DATABASE ... FROM PUBLIC` ;
   - `GRANT CONNECT, TEMPORARY` à l'authenticator et `GRANT CONNECT` à l'auth_admin.
4. **Dans la DB de l'app** :
   - `REASSIGN OWNED BY supabase_auth_admin TO app_<id>_auth_admin` ;
   - `DROP OWNED BY supabase_auth_admin` et `DROP OWNED BY supabase_storage_admin` ;
   - `GRANT USAGE, CREATE ON SCHEMA auth`.
5. **Conteneurs** `m0-<id>-auth` (GoTrue) et `m0-<id>-rest` (PostgREST) : réseau `m0`, labels `platform.app` et `platform.service`, `--memory 256m`, `restart unless-stopped`.
6. **Site statique placeholder** : `sites/<id>/index.html`.
7. **Route Caddy**, ajoutée via l'**API admin JSON** sans redémarrage ni rechargement (`POST /id/apps/handle/0/routes`, avec `@id: app-<id>`) :
   - match sur l'host `<id>.localhost` ;
   - `/auth/v1/*` vers GoTrue, préfixe retiré ;
   - `/rest/v1/*` vers PostgREST, préfixe retiré ;
   - tout le reste vers un `file_server` avec fallback SPA (`try_files {path} /index.html`) ;
   - un host inconnu reçoit un 404.

   Caddy tourne avec `--resume` : les routes ajoutées par l'API survivent à un redémarrage (vérifié).
8. **Vérification** : attente de `/auth/v1/health` et `/rest/v1/` à travers Caddy, puis écriture de `apps/<id>/app.json`.

`delete-app.sh` fait l'inverse, dans cet ordre :

1. `DELETE /id/app-<id>` sur Caddy ;
2. suppression des conteneurs par label ;
3. `DROP DATABASE ... WITH (FORCE)` ;
4. `DROP ROLE`.

Vérifié : après suppression, le host répond 404 et il ne reste ni rôle ni database.

## Point SPIKE : noms de rôles fixes

### Ce que fait l'image `supabase/postgres`

- Elle crée des **rôles globaux** aux noms fixes : `authenticator`, `supabase_auth_admin`, `supabase_storage_admin`, `anon`, `authenticated`, `service_role`, `dashboard_user`, `postgres`, `supabase_admin`, etc.
- Ses scripts d'init s'exécutent **uniquement dans la database `postgres`**. Ils y créent :
  - les schémas `auth`, `storage`, `realtime`, `extensions`, `graphql*` et `vault` ;
  - les event triggers `pgrst_ddl_watch` et `pgrst_drop_watch` ;
  - les default privileges pour `anon`, `authenticated` et `service_role`.
- Dans `auth`, ils créent déjà les premières tables GoTrue et les fonctions `auth.uid()`, `auth.role()` et `auth.email()`, **qui appartiennent à `supabase_auth_admin`** :
  - tables `users`, `refresh_tokens`, `instances`, `audit_log_entries` ;
  - table `schema_migrations`, avec 7 versions déjà enregistrées.
- `supautils.reserved_roles` protège les noms fixes : seul un superuser peut les modifier. Les rôles `app_*` ne sont **pas** réservés (voir plus bas).

### Construction de `template_supabase`

Le template est un **clone de la database `postgres` de l'image**, plus `sql/template.sql` qui ajoute `supabase_migrations.schema_migrations` au format de la CLI. On obtient ainsi exactement ce que donne `supabase start`, ce qui maximise la compatibilité des migrations écrites en local.

**Écueil** : `CREATE DATABASE ... TEMPLATE postgres` échoue tant qu'une session est ouverte sur la source, et les background workers `pg_net` et `pg_cron` y restent connectés en permanence.

**Contournement** (dans `init-template.sh`) :

1. `ALTER DATABASE postgres ALLOW_CONNECTIONS false` ;
2. `pg_terminate_backend` sur les sessions ouvertes sur `postgres` ;
3. `CREATE DATABASE` ;
4. `ALLOW_CONNECTIONS true`.

Les workers redémarrent seuls en environ 1 s (vérifié). Le template est ensuite marqué `IS_TEMPLATE true ALLOW_CONNECTIONS false`, si bien qu'aucune connexion parasite ne peut bloquer un futur clonage. Cette opération n'a lieu qu'une fois, à l'installation.

Le template transmet correctement :

- les extensions et les grants ;
- les default privileges : une table créée par `postgres` est automatiquement accessible à `anon`, `authenticated` et `service_role`, comme sur Supabase ;
- les event triggers. **Le rechargement automatique du cache de schéma PostgREST fonctionne** : une table `todos` créée après le démarrage de PostgREST est visible en moins de 200 ms.

### GoTrue avec un rôle non standard

Les migrations GoTrue (70 fichiers) ne référencent que le placeholder `Namespace` (`auth`) et le rôle global `postgres`, via des `grant select ... to postgres with grant option`. **Aucune ne mentionne `supabase_auth_admin`.**

Deux conditions ont été testées en les retirant tour à tour :

| Condition retirée | Erreur observée |
|---|---|
| `search_path = auth` sur le rôle (ou `&search_path=auth` dans l'URL) | `permission denied for schema public` : pop crée sa table `schema_migrations` dans `public` |
| Propriété des objets `auth.*` hérités du template | `relation "schema_migrations" already exists` : sans privilège, pop ne voit pas la table pré-créée dans information_schema et tente de la recréer |

**Contournement retenu :**

1. `ALTER ROLE app_<id>_auth_admin SET search_path = auth`, à l'image de `supabase_auth_admin`. Passer le paramètre dans l'URL fonctionne aussi.
2. Dans la DB de l'app : `REASSIGN OWNED BY supabase_auth_admin TO app_<id>_auth_admin`, puis `DROP OWNED BY supabase_auth_admin`.

Le `REASSIGN` conserve les ACL (le grantor est réécrit). `postgres` garde donc `SELECT ... WITH GRANT OPTION` et `REFERENCES` sur `auth.users`, et une FK `references auth.users` créée par `postgres` fonctionne.

Résultat : 77 versions dans `auth.schema_migrations`, et les 111 relations, 4 fonctions et 9 types de `auth` appartiennent à `app_<id>_auth_admin`. `CREATEROLE` n'est pas nécessaire.

### PostgREST avec un rôle non standard

Aucune dépendance au nom `authenticator` : PostgREST ne connaît que l'URI et `PGRST_DB_ANON_ROLE=anon`.

Un piège : `session_preload_libraries` doit être écrit comme une liste (`= supautils, safeupdate`) et non comme une chaîne entre quotes. Sinon : `FATAL: could not access file "supautils, safeupdate"`.

### Rôles restés globaux : pourquoi c'est acceptable

- **`anon`, `authenticated` et `service_role` sont partagés, comme prévu.** Ils sont NOLOGIN et les grants sont posés par database. Un `SET ROLE postgres` ou `SET ROLE app_app2_authenticator` depuis `app_app1_authenticator` est refusé (testé).
- **Les autres rôles de l'image** (`supabase_auth_admin`, `supabase_storage_admin`, `authenticator`…) existent toujours, mais ils **ne peuvent pas se connecter aux databases d'apps** : le `REVOKE ... FROM PUBLIC` leur retire `CONNECT`, et ils n'y possèdent plus rien.
- **`postgres` est un « super-tenant ».** Il possède chaque database d'app et a `CREATEROLE`, `BYPASSRLS` et `pg_read_all_data`. Il lit `auth.users` de toutes les apps. Il **peut aussi modifier les rôles `app_*`** (mot de passe, connection limit), puisqu'ils ne figurent pas dans `supautils.reserved_roles` (vérifié). Il doit rester réservé au control plane, jamais donné à un dev ni à Studio.

## Isolation vérifiée par l'e2e (`e2e/tenancy.test.ts`)

| Test | Résultat |
|---|---|
| Routage same-origin sur chaque host : `/`, une route SPA profonde, `/auth/v1/health`, `/rest/v1/` | OK |
| Signup (autoconfirm, session immédiate) puis login par mot de passe, sur app1 et app2 | OK |
| CRUD sous RLS (insert, update, select, delete) : bob ne voit ni ne modifie les todos d'alice ; un insert avec `user_id` usurpé est refusé (42501) ; anon voit 0 ligne et ne peut pas insérer | OK |
| `service_role` d'app1 ne voit que les données et les utilisateurs d'app1 (`auth.admin.listUsers`) ; les identifiants d'alice (app1) ne permettent pas de se connecter à app2 | OK |
| JWT d'app1 présentés à app2 : JWT utilisateur sur PostgREST → **401** `PGRST301` ; clés anon et service_role → 401 ; GoTrue `/user` → **403** `signature is invalid` ; API admin GoTrue avec la clé service_role d'app1 → refusé | OK |
| Connexions `pg` refusées en **42501** (pas de privilège CONNECT) : `app_app1_*` vers `app_app2`, `app_app2_*` vers `app_app1`, `app_app1_*` vers `postgres` et `template1`. `template_supabase` n'accepte aucune connexion | OK |
| `app_app1_authenticator` : `SET ROLE authenticated` accepté ; `SET ROLE postgres` ou `app_app2_authenticator` refusés ; `auth.users` illisible | OK |

## Mesures

Sorties brutes dans `results/` (`measure-2apps.txt` et `scale-*.txt`).

Le scale test porte sur 20 apps : app1, app2 et 18 apps jetables. Toutes sont chargées en même temps ; chaque app reçoit 1 signup, 3 logins et 200 GET `/rest/v1/` (8 en parallèle).

### RAM par conteneur (docker stats)

| Conteneur | Repos | Après charge |
|---|---|---|
| GoTrue | 11–15 Mo | 13–19 Mo (très stable) |
| PostgREST par défaut (`-N` : une capability GHC par CPU, 10 ici) | 57 Mo | **85–100 Mo** |
| PostgREST avec `GHCRTS=-N2` (réglage retenu) | 21–24 Mo | 32–45 Mo |
| PostgREST avec `GHCRTS=-N1` ou `-N2 -A1m` | 19–21 Mo | 23–25 Mo |
| Caddy (partagé) | 21 Mo | 33–40 Mo |
| Postgres, 2 apps | 110–210 Mo | – |
| Postgres, 20 apps (`shared_buffers` de 128 Mo inclus) | 315 Mo (40 connexions) | 730 Mo (80 connexions) |

Pour 20 apps sous charge, GoTrue totalise 261 Mo et PostgREST 627–645 Mo.

### Connexions Postgres par app (pg_stat_activity)

| Service | Repos | Pic |
|---|---|---|
| PostgREST (`PGRST_DB_POOL=3`) | 1 (LISTEN) juste après le démarrage, puis **4** (1 LISTEN + 3 du pool) dès qu'il a servi du trafic | 4 |
| GoTrue (`GOTRUE_DB_MAX_POOL_SIZE=3`) | **0** (aucune connexion gardée inactive) | **3** (rafale de 120 logins, 20 en parallèle) |
| Total par app | 1 à 4 | **7** |

Il faut ajouter environ 7 backends en arrière-plan pour le cluster (pg_cron, pg_net, autovacuum…).

**Constat : `PGRST_DB_POOL_MAX_IDLETIME` ne libère pas les connexions inactives dans PostgREST v14.17.** Testé avec la valeur par défaut (30 s) et à 5 s : les connexions étaient toujours là après 3 min, même après une nouvelle requête. Une app qui a servi du trafic garde donc `pool + 1` connexions en permanence.

Disque : environ 9,9 Mo par database d'app vide (le template fait 8,1 Mo).

## Extrapolation à 50 apps

| Poste | Hypothèse | Estimation |
|---|---|---|
| GoTrue | 50 × 13–19 Mo | 0,65–0,95 Go |
| PostgREST avec `-N2` | 50 × 32–45 Mo | 1,6–2,25 Go |
| PostgREST sans réglage, sur une VM 8 vCPU | 50 × ~75 Mo | ~3,7 Go |
| Postgres | 128 Mo de shared_buffers + ~200 connexions × ~5 Mo + caches catalogue par DB | 1,2–1,6 Go (davantage sous charge réelle) |
| Caddy | – | 0,05 Go |
| **Total couche tenancy (avec `-N2`)** | | **≈ 3,5–4,5 Go** |

Le plan estimait 2,5 à 3 Go pour GoTrue + PostgREST ; la mesure donne 2,3–3,2 Go avec `-N2`, donc cohérent. Une VM de 16 Go tient avec Storage, Realtime, Edge, Studio, Loki et le control plane. **Sans `GHCRTS`, PostgREST seul consommerait 4 à 5 Go.**

Connexions pour 50 apps :

| Situation | Calcul | Total |
|---|---|---|
| Repos, apps actives | 50 × 4 + 7 | ≈ **207** |
| Pic, toutes les apps sollicitées | 50 × 7 + 7 | ≈ **357** |
| Pic + Storage/Realtime (M5) + control plane | – | > **400** |

`max_connections=200` (valeur actuelle du spike) **ne suffit pas**.

## Recommandations pour le control plane

1. **Rôles et template** : reprendre tels quels `init-template.sh` (clone de `postgres` + `template.sql`) et la séquence SQL de `create-app.sh` dans `packages/sql`. Ces étapes sont idempotentes (`\gexec ... where not exists`, `REASSIGN` relançable).
2. **Rôle auth_admin** : sans `CREATEROLE`, avec `search_path = auth`, et `REASSIGN OWNED BY supabase_auth_admin` dans la DB de l'app. Même traitement en M5 pour `supabase_storage_admin` → `app_<id>_storage_admin` (le `DROP OWNED BY supabase_storage_admin` est déjà fait).
3. **Réserver `postgres` au control plane.** Pour `apply_migrations`, `execute_sql` et Studio, créer plutôt un rôle **`app_<id>_owner`** : LOGIN, propriétaire de la DB, avec `ALTER DEFAULT PRIVILEGES FOR ROLE app_<id>_owner IN SCHEMA public GRANT ... TO anon, authenticated, service_role`. `postgres`, lui, voit toutes les apps. À valider en M0bis.
4. **Protéger les rôles `app_*` contre `postgres`**, qui a `CREATEROLE`. Deux pistes : retirer `CREATEROLE` à `postgres` au bootstrap, ou ajouter les rôles `app_*` à `supautils.reserved_roles` (liste statique à générer ; vérifier si un motif est accepté).
5. **PostgREST** :
   - `GHCRTS=-N2` par défaut (configurable), `PGRST_DB_POOL=2–3` ;
   - ne pas compter sur `db-pool-max-idletime` ;
   - pour gagner 1 connexion par app, envisager `PGRST_DB_CHANNEL_ENABLED=false`. Le control plane, qui applique lui-même les migrations, déclencherait alors le rechargement du cache par `SIGUSR1` (`docker kill -s SIGUSR1`) ou par un `NOTIFY pgrst` ponctuel.
6. **GoTrue** : pool de 2–3. Il ne garde aucune connexion au repos.
7. **Postgres** :
   - `max_connections = 500` pour 50 apps ;
   - `CONNECTION LIMIT` par rôle (20 dans le spike), contre le voisin bruyant ;
   - `log_line_prefix` avec `db=%d user=%u` (déjà en place) pour attribuer les logs à une app ;
   - Supavisor **pas nécessaire avant environ 60 apps**. Au-delà, ou si Storage et Realtime sont gourmands, l'envisager en mode session pour PostgREST.
8. **Caddy** :
   - la structure `routes[0]` = subroute "apps", `routes[1]` = 404 permet d'ajouter ou retirer une app par `@id` sans toucher au reste ;
   - `--resume`, ou mieux, réappliquer la config au démarrage depuis le control plane, qui reste la source de vérité ;
   - l'API admin ne doit jamais être exposée (ici : `127.0.0.1:2020`, avec contrôle des `origins`).
9. **Clés** : le format legacy HS256 (anon et service_role signées avec le secret de l'app) fonctionne de bout en bout avec supabase-js 2.117, GoTrue 2.196 et PostgREST 14.17. Les clés publishable/secret n'ont pas été évaluées.
10. **Labels Docker** `platform.app` / `platform.service` : suffisants pour le nettoyage aujourd'hui, et pour Vector plus tard.

## Non couvert

- Storage, Realtime et Edge (M1, M5) ; Studio (M0bis).
- TLS (HTTP sur `:8080`, `automatic_https` désactivé) et l'endpoint `ask`.
- SMTP : `GOTRUE_MAILER_AUTOCONFIRM=true`.
- Mise à jour de GoTrue sur N databases. Les migrations tournent au démarrage de chaque conteneur, avec le rôle de l'app, donc une mise à jour revient à un recyclage app par app. Plausible, mais non testé.
- Charge réaliste : les mesures « sous charge » viennent d'un burst synthétique local.

## Infos de connexion (stack laissée démarrée)

Projet compose `m0`, réseau Docker `m0`.

| Élément | Valeur |
|---|---|
| App 1 | `http://app1.localhost:8080` : `/auth/v1`, `/rest/v1`, et statique depuis `sites/app1/` |
| App 2 | `http://app2.localhost:8080` |
| Postgres | `127.0.0.1:54320` (dans le réseau Docker : `db:5432`). Superuser `supabase_admin` ; `postgres` est owner des DB d'apps. Mot de passe des deux : `POSTGRES_PASSWORD` dans `spikes/m0-tenancy/.env` |
| Databases | `app_app1`, `app_app2`, et `template_supabase` (template, connexions interdites) |
| Rôles | `app_app1_authenticator` (PostgREST) et `app_app1_auth_admin` (GoTrue) ; idem `app_app2_*` |
| Secrets | `spikes/m0-tenancy/apps/<id>/.env` : `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `AUTHENTICATOR_PASSWORD`, `AUTH_ADMIN_PASSWORD` |
| Résumé non secret | `apps/<id>/app.json` : URL, DB, rôles, anon key |
| Conteneurs | `m0-db`, `m0-caddy`, `m0-app1-auth` (GoTrue :9999), `m0-app1-rest` (PostgREST :3000, admin :3001), idem `m0-app2-*` |
| Accès internes (réseau `m0`) | `http://m0-app1-auth:9999` et `http://m0-app1-rest:3000` |
| Caddy admin API | `http://localhost:2020`. Routes : `GET /id/apps/handle/0/routes`, avec `@id` = `app-<id>` |
| Import « external » dans Studio (M0bis) | `db_host=db` (ou `127.0.0.1`), `db_port=5432` (ou `54320`), `db_name=app_app1`, `db_user=postgres` (à remplacer par `app_<id>_owner`, recommandation 3), `public_url=http://app1.localhost:8080` ; `anon_key`, `service_key` et `jwt_secret` dans `apps/app1/.env` |

Les apps contiennent la table `public.todos` (avec RLS) et quelques utilisateurs créés par l'e2e.
