# Spike M0bis : Studio multi-head, rapport

Date : 2026-10-01.

Images :
- `ghcr.io/flamingrubberduck/supabase-studio-multi-head@sha256:24b2e1ba6ce1b6ed84266d5403d4af2a98ef941c066ef709a5b6d7e32a20ee89` : tag `latest`, commit `f88e4b4` du 2026-06-09, **linux/amd64 uniquement** ;
- `supabase/postgres-meta:v0.99.0` ;
- `supabase/gotrue:v2.196.0` ;
- `node:22-alpine`.

Base : stack `m0` (Postgres 17, Caddy). Machine : macOS Apple Silicon, Docker Desktop 8 Go. Studio y tourne en émulation amd64.

## Verdict

**Multi-head est viable pour la V1, mais pas tel quel.** Il faut un patch d'une ligne, une forward auth obligatoire, et accepter que plusieurs onglets restent inutilisables pour des projets importés en mode external.

- **Studio tourne sans Kong ni stack Supabase « par défaut ».** Il faut seulement un petit GoTrue pour le login de Studio lui-même. L'image publiée est compilée avec `NEXT_PUBLIC_STUDIO_AUTH=gotrue`, valeur figée au build.
- **Le partage d'un postgres-meta fonctionne.** Studio chiffre la chaîne de connexion du projet dans `x-connection-encrypted`.
- **Bug du mode external.** Les routes proxy `pg-meta/[ref]/tables|policies|…` ignorent la connexion du projet et tombent sur la **base par défaut de pg-meta**. Conséquences :
  - le table editor, la liste des tables et l'écran des policies apparaissent vides ;
  - pire, ils afficheraient une autre base si la connexion par défaut de pg-meta pointait sur une vraie base.

  **Corrigé ici par un patch `sed` d'une ligne** (`patch/Dockerfile`), avec un champ `pg_meta_conn` précalculé dans `projects.json`. Il faudra proposer ce patch en amont, ou le maintenir.
- **Isolation app1/app2 vérifiée** (API et UI) : chaque ref atteint sa propre base avec son propre rôle `app_<id>_owner`.
- **Studio n'a quasiment aucune authentification côté API.** `pg-meta/*/query`, `projects/import` et d'autres routes ne vérifient pas le login Studio. **La forward auth est la vraie barrière** : Studio ne doit jamais être joignable autrement.
- **RAM** : Studio environ 400 à 415 Mo (émulé), pg-meta 120 à 175 Mo, GoTrue de Studio 17 Mo, maquette de forward auth 16 Mo. Total **environ 0,55 à 0,6 Go, quel que soit le nombre d'apps**.

**Recommandation : garder multi-head comme cible**, derrière `StudioRegistry`, sous réserve de la validation juridique de la Sustainable Use License (hors périmètre de ce spike).

- Le périmètre utile est **la base de données** : tables, SQL, RLS, rôles, lecture des utilisateurs.
- **L'administration auth en écriture, Storage, Functions et Logs passent par nos propres écrans** (admin, MCP).
- Repli : le Studio officiel démarré à la demande.

## Grille : ce qui marche sur un projet importé en mode external

Méthode :
- tests par API : `scripts/check-api.sh` → `results/check-api.txt` ;
- navigateur headless : `scripts/ui-check.mjs` → `results/ui-check.json` et `screenshots/`.

| Fonction | Résultat | Détail |
|---|---|---|
| **Table editor, lecture** | OK **avec le patch** | Sans patch, l'éditeur affiche « Create a table » : la liste vient de `GET pg-meta/[ref]/tables`, qui part sur la base par défaut. Avec le patch, on voit `todos` et des lignes propres à chaque app (`app1-table-editor.png`, `app2-table-editor.png`). |
| **Table editor, édition** | OK | Les éditions passent en SQL par `POST pg-meta/[ref]/query`, correctement routé même sans patch. Testé : UPDATE, CREATE TABLE, DROP TABLE. Les default privileges de l'owner accordent bien les droits à anon, authenticated et service_role sur une nouvelle table. |
| **Éditeur SQL** | OK | `select current_user, current_database()` renvoie `app_app1_owner / app_app1` et `app_app2_owner / app_app2` (`*-sql-editor.png`). Le libellé « Role postgres » est cosmétique. |
| **Policies RLS** | OK **avec le patch** | La liste (`GET pg-meta/[ref]/policies`) a besoin du patch. Création et suppression en SQL : OK. |
| **Database > Tables** | OK **avec le patch** | Même cause que le table editor. |
| **Rôles** | Lecture OK, création refusée | La liste montre **tous les rôles du cluster** : depuis app1, on voit `app_app2_*`. C'est une fuite de noms, sans accès. `CREATE ROLE` est refusé (pas de `CREATEROLE`), et c'est voulu. |
| **Utilisateurs auth, liste** | OK | Lecture SQL de `auth.users` : 5 utilisateurs pour app1, 2 pour app2, aucun mélange. Il faut `BYPASSRLS` sur l'owner, car les tables `auth.*` ont la RLS activée sans aucune policy. |
| **Utilisateurs auth, création, invitation, suppression, magic link** | **KO** | Les routes `/api/platform/auth/[ref]/*` ignorent `[ref]` et appellent `SUPABASE_URL` et `SUPABASE_SERVICE_KEY` **globaux**, sans utiliser le `public_url` ni la `service_key` importés. Ici, ces variables sont volontairement non joignables, donc l'appel échoue franchement (« fetch failed »). Avec la configuration par défaut du fork, elles visent le GoTrue du projet par défaut : **un utilisateur créé « dans app1 » atterrirait ailleurs**. |
| **Navigateur Storage** | **KO** | Même défaut (`SUPABASE_URL` global) : erreur 500. De toute façon, pas de Storage avant M5. |
| **Edge functions** | Factice | La liste est lue dans un dossier **global** (`EDGE_FUNCTIONS_MANAGEMENT_FOLDER`), identique pour tous les projets. Aucun lien avec le runtime M1. |
| **Logs** | KO (vide) | Logflare global attendu. Sans lui, les résultats sont vides : inutilisable, comme prévu. |
| Settings et clés API | OK | `public_url` et `db_host` propres au projet. **La clé `service_role` de l'app est envoyée en clair au navigateur** (`api-keys/temporary`), comme dans Studio upstream. |

## Isolation (critère 4)

- **`x-connection-encrypted` pointe bien vers la bonne base.** Chaque ref résout vers `postgresql://app_<id>_owner@db/app_<id>`.
  - Depuis app1, `has_database_privilege('app_app2','connect')` vaut false.
  - `SET ROLE postgres` est refusé.
  - Les données du table editor, de `auth.users` et des policies diffèrent bien entre app1 et app2.
- **Une ref inconnue, ou `default`, utilise la connexion par défaut de pg-meta.** C'est le comportement du fork. D'où la règle appliquée : cette connexion pointe sur une base vide (`studio_meta_default`), avec un rôle sans privilège. Vérifié : `current_user = studio_meta_default`. **Ne jamais configurer pg-meta avec un rôle privilégié.**
- **Fuites résiduelles de métadonnées du cluster, sans accès aux données** :
  - `pg_database` liste toutes les bases ;
  - `pg_roles` liste tous les rôles `app_*` ;
  - l'écran des rôles affiche les connexions globales.

  Elles sont inhérentes à un cluster partagé, et acceptables tant que Studio reste réservé aux admins plateforme.
- `projects.json` (dans `data/studio/`) contient **en clair** le mot de passe de la base, la `service_key` et le `jwt_secret` de chaque app. Il est passé en chmod 600, et ce volume est à protéger comme un coffre de secrets.

## Accès derrière la forward auth (critère 6)

La maquette est en place. La route Caddy `studio.localhost:8080` (`@id: studio`) est ajoutée par l'API admin, à partir de `caddy/studio.Caddyfile` converti en JSON par `caddy adapt`. Elle fait ceci :

1. `/_sso/*` va vers `fwd-auth`, une page de login factice qui pose un cookie HMAC `platform_session`.
2. Tout le reste passe par `forward_auth` vers `fwd-auth:9000/verify` :
   - session valide : 200, avec `Remote-User` ;
   - pas de session et page HTML demandée : 302 vers `/_sso/login` (`screenshots/00-forward-auth-login.png`) ;
   - pas de session sinon : 401.
3. `/auth/v1/*` va vers le GoTrue de Studio, préfixe retiré. Le client GoTrue du navigateur utilise `<origin>/auth/v1`.
4. Le reste va vers Studio:3000. **Studio ne publie aucun port.**

Ce qui a été vérifié :
- sans session, `POST pg-meta/<ref>/query` reçoit **401** de Caddy ;
- avec une session SSO mais sans login Studio :
  - `GET /api/platform/projects` reçoit 401 (cette route vérifie le JWT Studio) ;
  - **`POST pg-meta/<ref>/query` reçoit 200** ;
  - `POST projects/import` est accepté.

Conséquences pour la cible :

- **La forward auth doit passer par un cookie, pas par l'en-tête `Authorization`.** Studio y met son propre Bearer GoTrue : du Basic auth casserait Studio.
- **Double login.** On passe par le SSO plateforme, puis par le login Studio (GoTrue). Studio ignore `Remote-User` : le fork n'a pas d'authentification par en-tête de confiance. Trois options :
  - (a) **retenue pour la V1** : accepter le double login, avec un seul compte admin Studio provisionné par le control plane (`POST /api/self-hosted/bootstrap`, comme le fait `up.sh`) ;
  - (b) patcher le fork pour qu'il fasse confiance à `Remote-User` ;
  - (c) faire générer une session GoTrue Studio par le control plane, puis l'injecter.
- **Studio réservé aux admins plateforme.** Les organisations, membres et rôles du fork ne protègent **pas** l'accès aux données, puisque les routes pg-meta ne vérifient rien. Synchroniser les droits app vers organisation Studio n'apporterait donc aucune isolation réelle. Le [SPIKE] du plan se tranche ainsi : **admins uniquement**.
- **Faille relevée dans le fork.** `POST /api/self-hosted/bootstrap` permet, **sans authentification**, de réinitialiser le mot de passe d'un admin existant à partir de son seul email. C'est une raison de plus pour ne jamais exposer Studio hors forward auth, ou pour bloquer ce chemin dans Caddy après le bootstrap.

## Rôle `app_<id>_owner` (recommandation 3 de M0)

Fichiers `sql/owner.sql` et `sql/owner-db.sql`, idempotents, appliqués par `register-app.sh`.

**Attributs du rôle**
- `LOGIN INHERIT NOCREATEROLE NOCREATEDB BYPASSRLS CONNECTION LIMIT 10`.
- `BYPASSRLS` comme le `postgres` de Supabase. Il est indispensable pour lire `auth.users` (RLS sans policy), et reste borné puisque le rôle ne se connecte qu'à sa propre base.

**Grants au niveau du cluster**
- `GRANT anon, authenticated, service_role ... WITH INHERIT FALSE, SET TRUE` : permet de se faire passer pour un rôle RLS sans hériter de ses droits.
- `GRANT app_<id>_owner TO postgres` : le control plane garde la main.
- L'owner est propriétaire de la base, donc aussi du schéma `public` (via `pg_database_owner`).
- `REVOKE ALL FROM PUBLIC`, puis `CONNECT, TEMPORARY, CREATE` pour l'owner seul.

**Dans la base de l'app**
- Les objets de `public` créés par `postgres` sont transférés à l'owner.
- `ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA public` reprend les grants Supabase vers anon, authenticated et service_role. Vérifié sur une table créée depuis Studio.
- `USAGE` sur `extensions`, `graphql`, `graphql_public` et `auth`.
- `SELECT` sur `auth.*`.
- `REFERENCES` et `TRIGGER` sur `auth.users`, pour les migrations qui créent une FK ou un trigger du type `handle_new_user`.

Le même rôle convient pour `apply_migrations` et `execute_sql` en M2.

`teardown.sh --purge` fait l'opération inverse (`REASSIGN` vers `postgres`, puis `DROP ROLE`). Vérifié : les bases des apps reviennent à `postgres`, et la stack m0 et ses apps restent saines.

## Mesures (critère 5)

Sorties brutes de `docker stats` dans `results/measure-*.txt`.

| Conteneur | RAM | Remarque |
|---|---|---|
| Studio multi-head (Next.js 16) | **404 à 415 Mo** | Après avoir parcouru toutes les pages des deux projets. Émulation amd64 sous Rosetta : en natif, probablement un peu moins. CPU nul au repos (un health poller tourne toutes les 30 s). |
| postgres-meta v0.99.0, partagé | **120 à 175 Mo** | Le pic arrive pendant la navigation. Ne garde **aucune** connexion Postgres au repos (0 dans `pg_stat_activity`). Il frôlait la limite de 256 Mo : prévoir 384 Mo. |
| GoTrue de Studio | 17 Mo | Aucune connexion au repos. |
| Maquette de forward auth (node) | 16 Mo | Remplacée par le control plane en cible. |
| **Total** | **environ 0,55 à 0,6 Go, fixe** | Ne dépend pas du nombre d'apps : chaque app ajoute seulement une entrée dans `projects.json`. |

À comparer avec le repli « Studio officiel à la demande » : environ 300 à 400 Mo de Studio, plus 100 à 150 Mo de pg-meta, **par app ouverte**.

Autres chiffres :
- reconstruction complète depuis zéro (`up.sh` puis deux `register-app.sh`, image déjà présente) : **18,6 s** ;
- `register-app.sh` seul : moins de 2 s ;
- image Studio : 370 Mo compressés.

## Problèmes rencontrés et choix

1. **Image publiée réutilisée, sans build Next.js.**
   - Le workflow `studio-docker-build.yml` publie l'image sur ghcr.io avec les tags `latest` et `sha-*`.
   - L'image est épinglée par digest. Le seul « build » est un `FROM` suivi d'un `sed` (`patch/Dockerfile`, environ 1 s).
   - Il n'y a pas d'image arm64 : il faudra la construire nous-mêmes si la production tourne sur ARM.
2. **`NEXT_PUBLIC_STUDIO_AUTH=gotrue` est figé dans l'image**, d'où le GoTrue dédié.
   - Le login HMAC (`DASHBOARD_PASSWORD`) n'est utilisable qu'avec une image recompilée sans cette variable.
   - Le GoTrue suit la recette M0 : base `studio_auth` clonée de `template_supabase`, rôle `studio_auth_admin`, `GOTRUE_DISABLE_SIGNUP=true`.
3. **Le mode external est partiel dans le fork** : routes pg-meta en GET, administration auth, storage, functions et logs. Le patch ne corrige que pg-meta, et il est fragile.
   - `importStoredProject` ne conserve que les champs qu'il connaît : il faut donc précalculer `pg_meta_conn` (AES au format crypto-js, OpenSSL `-md md5`) et l'écrire dans `projects.json` après l'import.
   - Le patch dépend d'une chaîne de code minifiée.
   - À **proposer en amont** sous une forme propre : chiffrer dans `getPgMetaProxyConfig` à partir de `db_host`.
4. **Le `public_url` des apps doit aussi se résoudre depuis le conteneur Studio** (health poller, routes serveur).
   - Dans le spike : `extra_hosts: appN.localhost:host-gateway`. En production, ce sera un vrai DNS.
   - Si une app est injoignable, le health poller déclenche un « failover ». Le tier Enterprise est activé automatiquement en l'absence de serveur de licence. Sans socket Docker monté, ce failover n'a aucun effet.
   - **Ne jamais monter `/var/run/docker.sock` dans Studio** : on n'utilise aucun mode de provisioning du fork.
5. **Variables du « projet par défaut » neutralisées.** `SUPABASE_URL`, `MULTI_HEAD_HOST` et `LOGFLARE_URL` pointent vers `unreachable.invalid`. Toute route qui ignore la ref échoue donc franchement au lieu de viser un autre backend. Le projet virtuel « (unused default) » reste listé, mais vide.
6. Studio affiche une étiquette « ENTERPRISE » : faute de serveur de licence, il se met au tier maximal. Sans conséquence ici.

## Recommandation (critère 7)

**1. Cible V1 : multi-head**, première implémentation de `StudioRegistry`.

Fonctionnement :
- `register(app)` : créer `app_<id>_owner`, appeler `POST /projects/import` en mode external, puis écrire `pg_meta_conn` ;
- `unregister` : retirer l'entrée de `projects.json`, puis supprimer le rôle owner ;
- `deepLink` : `/project/<ref>/editor`.

Conditions :
- **validation juridique de la Sustainable Use License**, hors périmètre de ce spike, avant toute distribution par Marmelab ;
- image **reconstruite par nos soins** : patch pg-meta, amd64 et arm64, et idéalement `NEXT_PUBLIC_STUDIO_AUTH` vide pour supprimer le GoTrue de Studio et le double login ;
- **forward auth par cookie obligatoire**, Studio réservé aux admins plateforme ;
- onglets auth (écriture), Storage, Functions et Logs **masqués, ou documentés comme non supportés**. Nos équivalents passent par l'admin shadcn et le MCP (`get_logs`, gestion des utilisateurs via l'API GoTrue de l'app).

Effort pour rendre Auth et Storage fonctionnels : il faudrait que les routes `auth/[ref]` et `storage/[ref]` utilisent le `public_url` et la `service_key` du projet. Environ dix fichiers sont concernés, tous avec le même motif `createClient(project.public_url, project.service_key)`. C'est faisable par patch, mais cela creuse l'écart avec le fork : **mieux vaut le proposer en amont que le maintenir**.

**2. Repli : Studio officiel (Apache 2.0), un par app, démarré à la demande.** À retenir si la licence bloque ou si le fork n'accepte pas les correctifs.
- Studio upstream en self-hosted a les mêmes limites hors Kong pour Auth et Storage.
- Mais un Studio par app peut faire pointer `SUPABASE_URL` vers le `public_url` de l'app : **Auth et Storage fonctionnent alors**.
- Coût : environ 0,5 Go par app ouverte, plus quelques secondes de démarrage.
- Le rôle `app_<id>_owner` et la forward auth se réutilisent tels quels.

**3. Pas de Studio : non recommandé.** Le table editor, le SQL et les policies RLS fonctionnent bien et ont une vraie valeur pour les admins, pour un coût fixe d'environ 0,6 Go.

## Mode d'emploi

Prérequis :
- la stack m0 démarrée avec app1 et app2 (`spikes/m0-tenancy/scripts/up.sh`, puis `create-app.sh app1` et `create-app.sh app2`) ;
- `jq`, `openssl` et Node 22 ou plus récent.

```bash
cd spikes/m0bis-studio
scripts/up.sh                 # .env (secrets), rôles et bases studio_*, conteneurs m0bis, route Caddy, admin Studio
scripts/register-app.sh app1  # app_app1_owner + import external + pg_meta_conn
scripts/register-app.sh app2
scripts/check-api.sh          # grille API + isolation → results/check-api.txt
pnpm install && pnpm ui       # captures headless → screenshots/, results/ui-check.json
scripts/measure.sh            # RAM + connexions
scripts/teardown.sh [--purge] # arrête m0bis et retire la route ; --purge : rôles, bases studio_*, owners, data/, .env
```

Dans le navigateur, ouvrir http://studio.localhost:8080. Il y a deux logins successifs, avec des identifiants différents :
1. page « Platform SSO » (login SSO factice) : `FWD_AUTH_USER` et `FWD_AUTH_PASSWORD` du `.env`. Les identifiants Studio y sont refusés (« invalid credentials ») ; chaque échec est tracé dans `docker logs m0bis-fwd-auth` ;
2. page « Welcome back » de Studio : `STUDIO_ADMIN_EMAIL` et `STUDIO_ADMIN_PASSWORD` ;
3. l'URL de chaque projet est dans `apps/<id>/studio.json` (capture : `screenshots/login-fixed.png`).

`up.sh` réaligne à chaque exécution le mot de passe et la confirmation d'email de l'admin Studio sur le `.env` (API admin du GoTrue de Studio), puis vérifie le login. Avant, le bootstrap ne s'exécutait qu'une fois : un `.env` régénéré laissait l'ancien mot de passe dans `studio_auth`. En cas de doute, relancer `scripts/up.sh`.

### Infos de connexion (stack laissée démarrée, environ 0,57 Go)

- **Projet compose** : `m0bis`, sur le réseau externe `m0`.
- **Conteneurs** :
  - `m0bis-studio` (port 3000, non publié) ;
  - `m0bis-meta` (8080) ;
  - `m0bis-auth` (9999) ;
  - `m0bis-fwd-auth` (9000).
- **URL** : `http://studio.localhost:8080`, route Caddy `@id: studio`.
- **Bases et rôles** :
  - `studio_auth`, avec le rôle `studio_auth_admin` ;
  - `studio_meta_default`, avec le rôle `studio_meta_default` sans privilège ;
  - `app_app1_owner` et `app_app2_owner`, propriétaires de `app_app1` et `app_app2`.
- **Secrets, non versionnés** :
  - `spikes/m0bis-studio/.env` ;
  - `apps/<id>/.env` (`OWNER_PASSWORD`) ;
  - `data/studio/projects.json`, qui contient les clés des apps en clair.

## Fichiers

```
spikes/m0bis-studio/
  docker-compose.yml        # projet m0bis : studio (image patchée), studio-meta, studio-auth, fwd-auth
  patch/Dockerfile          # FROM image publiée @digest + sed sur le proxy pg-meta (mode external)
  caddy/studio.Caddyfile    # source de la route studio (forward_auth), convertie en JSON par up.sh
  fwd-auth/server.mjs       # maquette de forward auth / SSO (cookie HMAC)
  sql/bootstrap.sql         # rôles et bases studio_auth / studio_meta_default
  sql/studio_auth.sql       # REASSIGN du schéma auth pour le GoTrue de Studio
  sql/owner.sql, owner-db.sql  # app_<id>_owner
  scripts/up.sh, register-app.sh, teardown.sh, check-api.sh, measure.sh, ui-check.mjs, gen-env.mjs, lib.sh
  results/                  # check-api.txt, ui-check.json, measure-*.txt
  screenshots/              # 00-forward-auth-login, 01-studio-sign-in, 02-projects, <app>-<page>.png
```
