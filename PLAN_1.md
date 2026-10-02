# Plateforme d'hébergement d'apps Supabase pour équipes Claude Code — Plan

> Document de cadrage destiné à servir de plan pour une session de développement.
> Les points marqués **[SPIKE]** sont des hypothèses à valider en premier.

## 1. Vision

Les PME qui équipent leurs collaborateurs de Claude Code se retrouvent avec des dizaines d'apps (SPA + backend Supabase) sans endroit sérieux où les héberger. La plateforme fournit, **installée chez le client (self-hosted)** sur une VM :

- des « instances Supabase » créées à la volée (Postgres, Auth, REST, Storage, Realtime, Edge Functions) ;
- l'hébergement statique des SPA ;
- **aucune UI pour les devs** : un serveur MCP + une skill Claude Code (« Claude, déploie l'app sur la plateforme ») ;
- un **déploiement toujours fait par la CI GitHub** de l'entreprise, après ses contrôles (sécurité, revue) : la skill installe le job, elle ne déploie pas elle-même. Le déploiement direct depuis le poste reste possible quand la plateforme l'autorise (réglage `DIRECT_DEPLOY`, §6.3) : installations locales et tests e2e sans GitHub ;
- une **interface d'administration** (shadcn-admin-kit) pour gérer comptes, tokens, apps, instances.

Cible de dimensionnement : **40 à 60 apps** par installation (plusieurs apps par collaborateur), une seule VM.

## 2. Décisions actées

| Sujet | Décision |
|---|---|
| Distribution | Self-hosted chez le client (docker compose + installeur) |
| Tenancy | **Option B mutualisée** : un cluster Postgres, une *database* par app, services Supabase partagés quand ils sont multi-tenant |
| Admin | **shadcn-admin-kit** (Marmelab) |
| Edge Functions | **Dans le MVP** (la logique métier y vit, pas dans des procédures stockées) |
| Auth des apps | Supabase Auth (GoTrue), apps internes et publiques, SSO entreprise via SAML / OAuth (Entra ID, Google, Keycloak…) |
| Interface dev | MCP distant + skill, packagés en **plugin Claude Code** |
| Build front | **Dans la CI** (GitHub Actions), upload du `dist/` |
| Chemin de déploiement | **Toujours la CI GitHub**, depuis la branche par défaut du repo lié à l'app, via un workflow réutilisable maintenu par l'admin. Déploiement direct réglé par `DIRECT_DEPLOY` (§6.3) : `admins` en production (exception auditée), `everyone` pour une installation locale (le déploiement depuis le poste reste possible, les tests e2e tournent sans GitHub) |
| Code source | Chaque app est liée à un repo de l'organisation GitHub de l'entreprise. L'admin lit le code sur GitHub : **pas d'interface de code dans la plateforme** |
| Auth de la CI | **OIDC GitHub** : pas de secret de déploiement longue durée (§5.1) |
| Langage | TypeScript partout (Deno pour le main worker des Edge Functions) |

## 3. Architecture cible

```
                         ┌──────────────────────────── VM client ─────────────────────────────┐
 Claude Code ──MCP/HTTPS──► Caddy (TLS on-demand, routage par host + path)                      │
 (plugin: skill + .mcp.json)   │                                                               │
 GitHub Actions ─HTTPS+OIDC─►  │  (déploiements, §5.1)                                        │
 Navigateurs ──HTTPS───────►   ├── admin.<domaine>        → Admin (shadcn-admin-kit, statique)  │
                               ├── api.<domaine>          → Control plane (API REST + /mcp)     │
                               ├── studio.<domaine>       → Studio multi-head (1 instance)      │
                               └── <app>.<domaine>                                              │
                                     /                    → fichiers statiques /sites/<app>/current
                                     /auth/v1/*           → GoTrue <app>        (1 conteneur/app)
                                     /rest/v1/*           → PostgREST <app>     (1 conteneur/app)
                                     /storage/v1/*        → Storage (multi-tenant, partagé)
                                     /realtime/v1/*       → Realtime (multi-tenant, partagé)
                                     /functions/v1/*      → Edge Runtime (partagé, main worker routeur)
                                                                                                │
   Postgres (image supabase/postgres) : 1 database par app + 1 database "platform"             │
   Loki + Vector (logs)   ·   postgres-meta partagé (utilisé par Studio)                        │
   Backups pg_dump → S3 du client                                                               │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Point clé** : l'API Supabase de chaque app est servie **sur le même origin que la SPA** (`SUPABASE_URL = https://<app>.<domaine>`). On n'a pas de CORS à gérer, et `supabase-js` fonctionne tel quel grâce aux préfixes `/auth/v1`, `/rest/v1`, etc.

### 3.1 Postgres mutualisé

- Une **database template** `template_supabase`, préparée une fois : extensions, schémas (`auth`, `storage`, `extensions`, `supabase_migrations`…), grants standard. Créer une app revient à `CREATE DATABASE app_<id> TEMPLATE template_supabase`, en quelques secondes.
- **Les rôles Postgres sont globaux au cluster.** Les rôles NOLOGIN `anon`, `authenticated` et `service_role` sont partagés, ce qui ne pose pas de problème car les grants sont par objet, donc par database. Les rôles **LOGIN sont par app** (`app_<id>_authenticator`, `app_<id>_auth_admin`, `app_<id>_storage_admin`), avec `REVOKE CONNECT ... FROM PUBLIC` sur chaque database. **[SPIKE]** Vérifier que GoTrue, Storage et les migrations du template ne présupposent pas des noms de rôles fixes (`supabase_auth_admin`, `authenticator`).
- Migrations applicatives suivies dans `supabase_migrations.schema_migrations`, **la même table que la CLI Supabase**, pour garder la compatibilité avec le workflow local `supabase start` / `supabase migration new`.
- **Connexions** : environ 50 apps × (pool PostgREST + GoTrue + Storage + Realtime) risque de saturer `max_connections`. Pools PostgREST petits (3 à 5). Prévoir Supavisor en mode multi-tenant si nécessaire. **[SPIKE]** Mesurer.
- `log_line_prefix` avec `%d` pour attribuer les logs Postgres à une app.

### 3.2 Services par app vs partagés

| Service | Mode | Notes |
|---|---|---|
| GoTrue | 1 conteneur / app | Léger (quelques dizaines de Mo). Lance ses migrations dans la DB de l'app. Config SMTP, providers et SSO par app |
| PostgREST | 1 conteneur / app | Mono-database par conception. Secret JWT propre à l'app |
| Storage API | Partagé, mode multi-tenant | Tenants enregistrés via l'API admin de Storage. Backend fichier local en V1 (S3 client en option). **[SPIKE]** Maturité du mode multi-tenant en self-hosted |
| Realtime | Partagé, multi-tenant | Tenants enregistrés via l'API Realtime. **[SPIKE]** Idem |
| Edge Runtime | Partagé | Voir 3.3 |
| Studio | 1 instance partagée (fork multi-head) | Voir 3.6 |
| postgres-meta | 1 instance partagée | Connexion cible passée en header chiffré par Studio |

Estimation mémoire : 50 apps × (GoTrue + PostgREST) ≈ 2,5 à 3 Go, plus les services partagés et Postgres. Une VM de 16 Go doit tenir. **[SPIKE]** Mesurer.

Chaque app a son propre **secret JWT**, et les clés `anon` et `service_role` sont générées à la création. Utiliser le format de clés « legacy » JWT, le mieux supporté en self-hosted. **[SPIKE]** Statut des nouvelles clés publishable/secret en self-hosted.

### 3.3 Edge Functions multi-tenant (MVP)

- Un seul conteneur `supabase/edge-runtime`, avec un **main worker maison** (Deno, TS) qui :
  1. lit l'app cible depuis un header injecté par Caddy (`X-Platform-App`), jamais depuis la requête cliente ;
  2. résout `/functions/<app>/current/<fonction>/index.ts` ;
  3. crée un **user worker** avec les variables d'env de l'app (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, plus les secrets définis via `set_secrets`), des limites mémoire et CPU, et un timeout.
- Les env par app sont lues depuis un fichier JSON monté en lecture seule, que le control plane régénère, ou via un appel interne au control plane avec cache.
- Les déploiements sont versionnés comme le front (`/functions/<app>/<version>/`, symlink `current`).
- Les dépendances `npm:` / `jsr:` sont téléchargées au premier appel, d'où un cache Deno persistant à prévoir. **[SPIKE]** Comportement derrière un proxy d'entreprise.
- Isolation par isolate V8, pas par conteneur. C'est acceptable pour du code écrit par des collaborateurs de confiance, mais à documenter.
- La vérification JWT (`verify_jwt`) se configure par fonction via `supabase/config.toml` ou `deno.json`, comme sur Supabase Cloud.

### 3.4 Front statique

- Upload d'un `tar.gz` du `dist/` dans `/sites/<app>/<version>/`, puis bascule atomique du symlink `current`. Le rollback revient à repointer le symlink.
- Caddy sert les fichiers avec un fallback SPA (`try_files {path} /index.html`), un cache long sur les assets hashés et `no-cache` sur `index.html`.
- Les variables de build (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) sont fournies par `get_app` et injectées au build par la skill. La clé `service_role` n'apparaît **jamais** dans le front.

### 3.5 Routage et TLS

- **Caddy** est le point d'entrée unique, configuré par le control plane via son **API admin JSON**. Ajouter ou retirer une app ne demande aucun redémarrage.
- **TLS on-demand** avec un endpoint `ask` sur le control plane, qui n'autorise que les hosts d'apps connues. On évite ainsi la dépendance à une API DNS chez le client : il suffit d'un enregistrement DNS wildcard `*.<domaine>` qui pointe vers la VM. Les domaines custom deviennent possibles plus tard.
- Une app arrêtée sert une page de maintenance.

### 3.6 Supabase Studio : fork multi-head

Le Studio officiel est open source (Apache 2.0) mais **mono-projet en self-hosted**. Plutôt que de démarrer un Studio par app à la demande, sans garantie sur le nombre d'instances simultanées, on part du fork **[supabase-studio-multi-head](https://github.com/flamingrubberduck/supabase-studio-multi-head)** : **une seule instance** qui gère plusieurs projets.

**Ce qu'une première lecture du code a établi :**

- **Le fork sait enregistrer des projets existants sans créer de conteneurs** : `POST /api/platform/projects/import`, en mode « remote/external » (`db_host`, `db_port`, `db_user`, `db_name`, `db_password`, `public_url`, `anon_key`, `service_key`, `jwt_secret`). C'est le point d'intégration : **notre control plane provisionne l'app (option B), puis l'enregistre dans Studio.** Les apps sont stockées dans un `projects.json` sous `STUDIO_DATA_DIR`.
- **postgres-meta peut être partagé** : Studio passe la chaîne de connexion cible dans le header `x-connection-encrypted` (clé `PG_META_CRYPTO_KEY`). Le SPIKE de la version précédente est donc levé côté principe.
- **On n'utilise pas les modes de provisioning du fork :**
  - le mode `stack` crée une stack Docker Compose complète par projet, ce qui correspond à l'option A écartée ;
  - le mode `embedded` crée seulement une database avec trois extensions. Elle **partage le GoTrue, le PostgREST, le Kong et les clés de la stack par défaut**, qui pointent vers une autre database. Ce n'est pas un backend d'app utilisable. Notre provisioning (§4.2) reste indispensable.
- **Fonctions du fork qu'on ignore** : backups (ils font un `docker exec` dans le conteneur Postgres du projet, ce qui ne colle pas à des projets externes), réplicas et failover (payants), PocketBase, Authelia. Nos backups restent dans le control plane (§3.9).

**Licence : point bloquant potentiel.** Les ajouts multi-head ne sont pas en Apache 2.0 mais sous une **« Sustainable Use License »** (seul le code upstream reste Apache) :
- gratuit tant que l'ARR directement attribuable au produit qui l'incorpore reste sous 2 M$ ;
- interdit de l'offrir en service hébergé ou managé qui concurrence l'auteur ;
- autorisé : usage interne, prestations de conseil, personnalisation ou support, et hébergement pour ses clients directs **tant que les fonctions multi-head ne sont pas le cœur de l'offre payante revendue**.

Pour une installation chez le client à usage interne, ça semble passer. Pour Marmelab qui distribue un produit l'intégrant, **validation juridique nécessaire** avant d'aller au-delà du spike. Ce n'est pas du logiciel libre au sens OSI : à signaler aux clients sensibles à ce point.

**Maturité :** environ 70 commits entre avril et juin 2026, un mainteneur principal, dernier commit le 9 juin 2026. Les correctifs de sécurité upstream sont rétroportés à la main. Un serveur de licence existe pour les tiers payants (non utilisés ici).

**Conséquences de conception :**
- Studio reste un **composant optionnel et remplaçable** derrière une interface `StudioRegistry` (`register(app)`, `unregister(app)`, `deepLink(app)`). Implémentations possibles :
  1. **multi-head** (cible V1) ;
  2. **repli** : Studio officiel démarré à la demande, une instance par app (l'ancien plan), si la licence ou la maturité bloquent ;
  3. Studio officiel multi-projets si la proposition upstream (`SUPABASE_PROJECTS` / `SUPABASE_PROJECTS_FILE`) est mergée.
- **Image épinglée** sur un tag précis et reconstruite par nous si besoin (attention : `NEXT_PUBLIC_GOTRUE_URL` est figé au build).
- **Accès** : Studio sur `studio.<domaine>` derrière la forward auth du control plane (SSO admin). Le fork a sa propre notion d'organisations, membres et rôles. **[SPIKE]** Choisir entre réserver Studio aux admins plateforme ou synchroniser les droits app → organisation Studio.
- **[SPIKE]** Vérifier que Studio fonctionne sans la stack Supabase « par défaut » (Kong, GoTrue de Studio) que le fork suppose, ou en fournir une minimale (auth Studio en basic auth derrière la forward auth).
- **[SPIKE]** Vérifier, sur un projet importé en mode externe, ce qui marche réellement : table editor, éditeur SQL, policies RLS, rôles, gestion des utilisateurs auth (GoTrue admin via `public_url` + service key), navigateur Storage, edge functions, logs (onglet Logs probablement inutilisable sans Logflare).
- Fonctions Studio peu utiles en self-hosted (logs Logflare, etc.) : à masquer ou ignorer.

### 3.7 Auth des apps, SSO et emails

- **SMTP mutualisé** (relais du client ou Brevo, Scaleway TEM…) injecté par défaut dans chaque GoTrue, avec un expéditeur et des templates par app.
- **SSO** :
  - OAuth / OIDC via les providers GoTrue (Azure/Entra ID, Google, Keycloak, WorkOS…), configurés par app ;
  - SAML 2.0 via GoTrue (activation par env, providers ajoutés par l'API admin GoTrue). **[SPIKE]** Valider le SAML en self-hosted et le support de providers OIDC génériques.
  - Côté admin : un **« SSO d'entreprise » défini une fois au niveau de la plateforme** et activable en un clic sur une app. C'est le cas typique d'une app interne.
- Pour les apps internes, option complémentaire : restreindre l'inscription à un domaine email ou désactiver le signup.

### 3.8 Logs

- Vector collecte les logs Docker (labels `platform.app=<id>`, `platform.service=<gotrue|postgrest|…>`), les logs d'accès Caddy, les logs Postgres (préfixe `%d`) et les logs Edge Runtime (préfixés par app par le main worker), puis les envoie à **Loki**.
- Ces logs sont exposés dans l'admin (vue logs par app) et via l'outil MCP `get_logs`, indispensable pour que Claude Code débogue en autonomie.

### 3.9 Sauvegardes

- `pg_dump` quotidien par database vers le S3 du client, avec rétention configurable, plus une archive des fichiers Storage.
- Restauration depuis l'admin (vers la même app ou une nouvelle app). Utile aussi pour cloner un environnement.

## 4. Control plane

- **Stack** : Node + TypeScript, **Hono**, Postgres (database `platform` du même cluster), Drizzle ou Kysely, **dockerode** pour piloter les conteneurs.
- **Abstraction `Orchestrator`** (create, start, stop, remove, status, stats) avec une implémentation Docker en V1. Nomad ou K8s possibles plus tard.
- **Abstraction `Router`** (Caddy admin API).
- **Secrets** (JWT secrets, service keys, secrets d'app) chiffrés au repos (AES-GCM, clé maître dans l'env de la VM).
- **Jobs** (provisioning, backups) : file simple en base (pg-boss ou équivalent).

### 4.1 Modèle de données (database `platform`)

- `users` (id, email, nom, rôle `admin | developer`, actif)
- `tokens` (id, user_id, nom, hash, scopes, apps autorisées optionnelles, expires_at, last_used_at, revoked_at)
- `apps` (id, slug, nom, owner_id, statut `provisioning | running | stopped | error | deleted`, db_name, studio_ref, github_repo `owner/nom`, github_repo_id, default_branch, created_at)
- `app_members` (app_id, user_id, rôle)
- `app_secrets` (app_id, clé, valeur chiffrée), pour les edge functions
- `app_auth_config` (app_id, providers, SSO, SMTP override, signup policy)
- `releases` (id, app_id, source `ci | direct`, statut `running | succeeded | failed`, commit_sha, ref, ci_run_id, ci_run_url, github_actor, created_by (PAT d'un déploiement direct), admin_exception, reason, started_at, finished_at) : un run de CI (une tentative) = une release, qui regroupe ses déploiements ; un déploiement direct crée une release `direct`, marquée `admin_exception` quand c'est un admin alors que `DIRECT_DEPLOY=admins`
- `settings` (clé, valeur) : réglages plateforme modifiés à chaud (CLI), prioritaires sur l'env du control plane
- `deployments` (id, app_id, release_id, kind `frontend | functions | migrations`, version, statut, created_by, created_at, manifest)
- `app_metrics` (app_id, heure, requêtes, réponses 5xx, taille DB, mémoire des conteneurs) : échantillonné par le control plane pour la vue apps de l'admin (§8)
- `uploads` (id, deployment_id, token à usage unique, expires_at)
- `sso_providers` (niveau plateforme)
- `audit_log` (qui, quoi, quand, sur quelle app)

### 4.2 Provisioning d'une app (`create_app`)

1. Créer les rôles LOGIN de l'app et `CREATE DATABASE ... TEMPLATE template_supabase`.
2. Générer le secret JWT et les clés anon et service_role.
3. Démarrer les conteneurs GoTrue et PostgREST (labels, réseau interne, limites mémoire).
4. Enregistrer le tenant dans Storage et Realtime.
5. Créer `/sites/<app>/` et `/functions/<app>/` avec une page placeholder.
6. Ajouter les routes Caddy.
7. Enregistrer l'app dans Studio (`StudioRegistry.register`, soit `POST /api/platform/projects/import` côté multi-head) et stocker le `studio_ref`.
8. Statut `running`, puis renvoyer URL et anon key.

Chaque étape doit être idempotente, avec reprise sur erreur et une opération `delete` symétrique.

## 5. Serveur MCP

- Exposé en **Streamable HTTP** sur `https://api.<domaine>/mcp`, auth par header `Authorization: Bearer <token>`. Le token est un PAT créé par un admin, stocké hashé en base.
- Le SDK MCP TypeScript officiel est monté dans le control plane, et chaque outil vérifie les droits user → app.

| Outil | Description |
|---|---|
| `whoami` | Utilisateur, apps accessibles |
| `list_apps` / `get_app` | Statut, URL, `SUPABASE_URL`, anon key, dernière version |
| `create_app(name)` | Provisioning (§4.2) |
| `link_repo(app, repo, repository_id, default_branch)` | Lie l'app à son repo GitHub (propriétaire de l'app ; changement audité) |
| `apply_migrations(app, migrations[], dry_run?, release_id?)` | Contenu SQL des fichiers `supabase/migrations/*`. N'applique que les nouvelles, dans une transaction. Lance ensuite le **linter de sécurité** (§7) et renvoie ses alertes. Avec `DIRECT_DEPLOY=admins`, un builder n'a que le `dry_run` ; l'application réelle passe par la CI (§5.1) |
| `execute_sql(app, sql, write=false)` | Lecture seule par défaut. L'écriture est explicite et journalisée |
| `list_tables(app)` / `generate_types(app)` | Introspection, génération des types TS de la base |
| `create_deployment(app, kind, release_id?)` | Renvoie une **URL d'upload pré-signée** (usage unique, TTL court). Admins seulement si `DIRECT_DEPLOY=admins` |
| `finalize_deployment(deployment_id)` | Vérifie, extrait, bascule `current`, recharge les fonctions. Admins seulement si `DIRECT_DEPLOY=admins` |
| `begin_release(app, commit_sha?, reason?)` / `finish_release(release_id, statut)` | Déploiement direct : regroupe les publications suivantes dans une release `direct`. Sans release, chaque publication est sa propre release |
| `list_deployments` / `rollback(app, version)` | Historique (avec commit et run de CI) et retour arrière vers une version déjà déployée par la CI |
| `set_secrets(app, secrets)` / `list_secrets(app)` | Secrets des edge functions (valeurs jamais renvoyées) |
| `configure_auth(app, …)` | Providers, SSO plateforme on/off, signup, URLs de redirection |
| `get_logs(app, service?, since?, query?)` | Requête Loki filtrée |
| `stop_app` / `start_app` | Pour le propriétaire de l'app |

**Les fichiers ne passent pas par les arguments MCP**, qui provoqueraient une inflation du contexte. Le `dist/` et `supabase/functions/` sont archivés et envoyés par `curl` vers l'URL pré-signée.

**Droits par identité**, selon le réglage `DIRECT_DEPLOY` (§6.3) : avec `admins` (production), un PAT de builder n'a plus accès aux outils qui publient (`apply_migrations` hors `dry_run`, `create_deployment`, `finalize_deployment`, `begin_release`) : l'appel est refusé avec un message qui renvoie vers la CI. Il garde la lecture, les logs, `execute_sql`, `set_secrets`, `configure_auth`, la gestion des membres, `rollback` et `stop_app` / `start_app`. Les admins gardent tout. Avec `everyone` (installation locale), les builders gardent aussi les outils qui publient.

### 5.1 API de déploiement pour la CI

- Mêmes opérations que les outils MCP de déploiement, exposées en REST sur `api.<domaine>/ci/apps/<app>/…` (`GET` = `get_app`, `migrations`, `release` et `release/finish`, `deployments` et `deployments/<id>/finalize` ; détail dans `apps/control-plane/README.md`) et appelées par un **CLI de déploiement** (`platform-deploy`, TypeScript), lui-même appelé par le workflow réutilisable (§6.2). L'admin l'utilise aussi pour un déploiement direct, avec son PAT (MCP).
- Auth : **token OIDC GitHub** (`permissions: id-token: write`, audience = URL de la plateforme). Le control plane vérifie la signature (JWKS de l'émetteur configuré : github.com ou GHES) et les claims :
  - `repository_id` = `apps.github_repo_id` (stable même si le repo est renommé) ;
  - pour publier : `ref` = branche par défaut de l'app et `ref_protected = true` ;
  - `job_workflow_ref` dans la liste des workflows réutilisables autorisés par l'admin (`CI_ALLOWED_WORKFLOWS` : une entrée `…/deploy.yml@refs/heads/main` exige cette ref exacte, une entrée sans `@` accepte toutes les refs du fichier ; épingler une ref en production). C'est ce qui garantit que les contrôles de l'entreprise ont tourné : modifier le workflow du repo de l'app ne suffit pas à les contourner.
  - signature vérifiée avec `jose` (JWKS de l'émetteur mis en cache), `iss`, `aud` (par défaut l'URL de l'API), `exp`.
- Mode **check** (pull requests, n'importe quelle ref du repo lié) : `get_app` et `apply_migrations` en `dry_run` seulement.
- Chaque run crée une `release` (commit, run, acteur GitHub), identifiée par `run_id` et `run_attempt` du token : un token d'un autre run ne peut pas y publier. Les lints acceptés viennent de `.platform.json` (`acceptedLints`), donc de la revue de code, et restent audités.
- Une app arrêtée (`stop_app`) refuse toute publication par la CI ; `get_app` et le `dry_run` restent possibles.
- Les secrets des fonctions restent sur la plateforme (`set_secrets` par le builder) : rien à stocker dans GitHub. Repli sans OIDC (vieux GHES, autre forge) : un token de déploiement par app en secret d'environnement GitHub restreint à la branche par défaut. Hors V1.

## 6. Plugin Claude Code, CI et déploiement

```
plugin/
  .claude-plugin/plugin.json
  .mcp.json                     # url: https://api.<domaine>/mcp, headers: Authorization: Bearer ${PLATFORM_TOKEN}
  skills/deploy/SKILL.md        # mise en place de la CI, puis push et suivi du run
  skills/admin-deploy/SKILL.md  # déploiement direct, admins seulement (§6.3)
ci/
  .github/workflows/deploy.yml  # workflow réutilisable maintenu par l'admin (§6.2)
packages/deploy-cli/            # platform-deploy : migrations, fonctions, build, front, smoke test
```

Le plugin et le workflow réutilisable sont publiés dans le **même repo interne** de l'entreprise (le marketplace de plugins), dont l'accès Actions est ouvert aux autres repos de l'organisation.

### 6.1 Skill `deploy` (builder)

« Déploie l'app sur la plateforme » ne déploie plus depuis le poste : la skill vérifie et installe ce qui manque, puis laisse la CI publier.

1. Lire `.platform.json` à la racine du repo (id de l'app, `acceptedLints`). S'il est absent, `create_app` puis écriture du fichier.
2. Vérifier que le projet est une SPA (Vite) et localiser `supabase/migrations` et `supabase/functions`.
3. Repo GitHub : s'il n'y a pas de remote dans l'organisation de l'entreprise, le créer (`gh repo create`). `link_repo` avec `owner/nom`, `repository_id` et la branche par défaut.
4. Secrets des fonctions : repérer les `Deno.env.get(...)`, comparer avec `list_secrets`, demander les valeurs manquantes à l'utilisateur, `set_secrets`.
5. CI, seulement si absent : `.github/workflows/platform.yml` qui appelle le workflow réutilisable sur `push` (branche par défaut) et `pull_request`, avec `id-token: write` ; variable `PLATFORM_URL` au niveau du repo si elle n'existe pas au niveau de l'organisation.
6. Revue préalable des nouvelles migrations, et `apply_migrations` en `dry_run` : remonter les lints, **stopper si des tables sont exposées sans RLS**. Ajouter un lint à `acceptedLints` seulement avec le consentement explicite de l'utilisateur.
7. Commit et push (ou PR si la branche par défaut est protégée), puis `gh run watch`. Afficher l'URL de l'app, le lien Studio et le lien du run. En cas d'échec : logs du run (`gh run view --log-failed`), `get_logs`, diagnostic.

Distribution : un marketplace de plugins interne au client (repo Git), installé en une commande. L'admin fournit le token et le dev le place dans `PLATFORM_TOKEN`. Le dev a aussi besoin du CLI `gh` connecté.

Le dev local reste standard (`supabase start` avec la CLI officielle). Les migrations sont le contrat entre le local et la plateforme.

### 6.2 Workflow réutilisable

Entrée `mode: deploy | check`. Étapes :

1. **Contrôles de l'entreprise**, définis par l'admin : analyse de dépendances, scan de secrets, SAST, etc. Ce sont ceux de la CI existante du client ; la plateforme n'en impose pas de liste.
2. `npm ci`, puis `platform-deploy` avec le token OIDC :
   - `check` : `dry_run` des migrations et lints, build ; résultat en résumé du run et en commentaire de PR ;
   - `deploy` : migrations (rejet de tout nouveau lint `ERROR` absent d'`acceptedLints`), fonctions (préchauffées avant bascule), build avec les variables de `get_app`, front, smoke test.

Les revues obligatoires et les checks requis restent configurés par le client sur GitHub (protection de branche, rulesets). La plateforme vérifie `ref_protected` mais pas le détail des règles.

### 6.3 Déploiement direct par un admin (exception)

Le réglage plateforme **`DIRECT_DEPLOY`** (env du control plane, modifiable à chaud par la CLI `set-setting`) décide qui peut publier avec un PAT :

- `admins` (**à utiliser en production**, valeur par défaut si absent) : seuls les admins publient en direct, et chaque release directe d'un admin est marquée `admin_exception` (l'exception auditée ci-dessous) ;
- `everyone` : tout membre de l'app publie avec son PAT, comme en M3. `install.sh` l'écrit dans `deploy/.env` pour une installation locale : les tests e2e, le seed et la skill `deploy` actuelle tournent sans GitHub.

Skill `admin-deploy`, pour une urgence (CI en panne), une app sans CI ou une reprise d'app (A5) :

- réservée aux PAT d'admin quand `DIRECT_DEPLOY=admins` ; demande une **raison** (`begin_release`) ;
- lance le même `platform-deploy` que la CI, depuis un checkout local du repo lié ; refuse un arbre modifié ou un commit absent du repo distant ;
- crée une `release` `source = direct` (`admin_exception`, raison, compte de l'admin), auditée ; l'app est signalée « déployée hors CI » dans l'admin jusqu'au prochain déploiement par la CI.

## 7. Garde-fous de sécurité

- **CI comme seul chemin de publication** (avec `DIRECT_DEPLOY=admins`, hors exception admin) : contrôles de sécurité de l'entreprise et revue de code avant tout déploiement, garantis par les claims OIDC (`repository_id`, `ref_protected`, `job_workflow_ref`, §5.1). Le code déployé est toujours un commit du repo lié, consultable par l'admin sur GitHub.
- **Linter** après chaque `apply_migrations` : tables du schéma `public` sans RLS, policies `USING (true)` sur des tables sensibles, fonctions `SECURITY DEFINER` exposées, etc. On s'appuie sur **splinter**, le linter open source de Supabase. Résultat visible dans le retour MCP, sur la PR et dans l'admin.
- **Changements de schéma hors CI : acceptés et détectés.** L'éditeur SQL de Studio et `execute_sql(write=true)` agissent avec le rôle owner et peuvent modifier le schéma hors CI. On les garde (corrections de données, urgences), mais un event trigger DDL (dans `template_supabase`) journalise tout changement fait hors d'une release, et l'app est signalée dans l'admin.
- La clé `service_role` n'est jamais renvoyée par `get_app` (seulement injectée dans les edge functions).
- `execute_sql` en écriture : flag explicite et journalisation dans `audit_log`.
- Isolation réseau : seuls Caddy et le control plane sont exposés, les conteneurs d'app sont sur un réseau interne.
- Limites mémoire et CPU par conteneur et par user worker.

## 8. Admin (shadcn-admin-kit)

SPA statique servie sur `admin.<domaine>`, data provider REST vers le control plane (endpoints compatibles avec le format attendu par le data provider choisi).

Auth de l'admin : comptes locaux en V1, SSO entreprise (OIDC) ensuite.

Écrans :
- **Dashboard** : nombre d'apps par statut, RAM/CPU/disque de la VM, taille du cluster Postgres, alertes (apps en erreur, linter, backups ratés).
- **Utilisateurs** : CRUD, rôle, activation.
- **Tokens** : création (valeur affichée une seule fois), révocation, dernière utilisation, scopes.
- **Apps** : liste de **toutes les apps**, filtrable et triable : nom et URL, statut, propriétaire (nom et email), **lien vers le repo GitHub**, dernier déploiement (date, commit, auteur, lien du run, source CI ou admin, résultat), **aperçu de la charge** (requêtes et 5xx sur 24 h avec sparkline 7 jours, taille DB, mémoire des conteneurs, depuis `app_metrics`), drapeaux (déployée hors CI, schéma modifié hors CI, lints acceptés, abandonnée). La fiche app comprend :
  - statut des services, actions **Stop / Start / Supprimer** ;
  - releases (commit, run de CI, diff GitHub depuis la précédente) et leurs déploiements (front, fonctions, migrations) avec **rollback** ;
  - edge functions, secrets (noms seulement) ;
  - config auth et SSO ;
  - **logs** (Loki) ;
  - résultats du linter de sécurité ;
  - backups et restauration ;
  - lien **« Ouvrir dans Studio »** (deep link vers le projet dans Studio multi-head).
- **SSO plateforme** : providers SAML et OIDC partagés.
- **Journal d'audit**.

## 9. Installation chez le client

- Repo `deploy/` contenant un `docker-compose.yml` pour le socle (Postgres, Caddy, control plane, admin, Storage, Realtime, Edge Runtime, Studio multi-head, postgres-meta, Loki, Vector) et un script `install.sh`, qui vérifie les prérequis, génère les secrets, initialise la database template et crée le premier admin.
- Prérequis client : une VM Linux (16 Go+ recommandés pour 50 apps), un DNS wildcard `*.<domaine>`, des ports 80/443, un SMTP, un bucket S3 pour les backups (optionnel), une **organisation GitHub** (github.com ou GHES avec OIDC). L'API doit être joignable par les runners GitHub Actions (sinon, runners auto-hébergés dans le réseau du client), et le control plane doit joindre l'émetteur OIDC.
- Configuration GitHub à l'installation : publication du repo interne (marketplace + workflow réutilisable), ajout des contrôles de l'entreprise au workflow, liste des `job_workflow_ref` autorisés (`CI_ALLOWED_WORKFLOWS`), `DIRECT_DEPLOY=admins`, variable d'organisation `PLATFORM_URL`.
- **Versions des composants Supabase épinglées**, alignées sur une release du `docker-compose` officiel Supabase. Les mises à jour de la plateforme passent par un script de migration du control plane, puis par un recyclage progressif des conteneurs GoTrue et PostgREST app par app.
- **[SPIKE]** Vérifier les licences des composants redistribués (GoTrue, PostgREST, Storage, Realtime, Edge Runtime, postgres-meta), et faire valider juridiquement la **Sustainable Use License** de Studio multi-head (§3.6).

## 10. Structure du monorepo

```
apps/
  control-plane/      # Hono + MCP + orchestrateur + jobs
  admin/              # shadcn-admin-kit
  edge-main-worker/   # main worker Deno pour l'edge runtime
packages/
  shared/             # types, schémas zod partagés API/MCP/admin
  sql/                # template_supabase, rôles, linter
  deploy-cli/         # platform-deploy, utilisé par la CI et par les admins
plugin/               # plugin Claude Code (skills deploy et admin-deploy + .mcp.json)
ci/                   # workflow réutilisable de déploiement, publié avec le plugin
deploy/               # docker-compose, Caddy bootstrap, install.sh
examples/todo-app/    # app de test end-to-end (Vite + supabase-js + 1 edge function)
```

## 11. Jalons

| # | Jalon | Critère de sortie |
|---|---|---|
| M0 | **Spike tenancy** | 2 apps sur 1 cluster, GoTrue et PostgREST par app, routage same-origin, `supabase-js` OK (signup, login, CRUD sous RLS) ; rôles par app validés ; mesure RAM et connexions |
| M0bis | **Spike Studio multi-head** | Studio multi-head + postgres-meta partagé, sans stack Supabase par défaut ; les 2 apps de M0 enregistrées via `/api/platform/projects/import` ; grille de ce qui marche (table editor, SQL, RLS, users auth, Storage, functions, logs) ; RAM mesurée ; accès derrière forward auth. Décision : multi-head, repli à la demande, ou pas de Studio |
| M1 | **Spike Edge Functions multi-tenant** | Main worker qui route 2 apps, env isolées, `verify_jwt`, import `npm:` |
| M2 | **Control plane + MCP minimal** | `create_app`, `get_app`, `apply_migrations`, `create/finalize_deployment` (front + fonctions), `get_logs` |
| M3 | **Plugin Claude Code** | Sur `examples/todo-app`, « déploie l'app sur la plateforme » fonctionne de bout en bout depuis un repo vierge (déploiement direct depuis le poste, remplacé par M3bis) |
| M3bis | **Déploiement par la CI** | OIDC GitHub vérifié par le control plane (repo, branche protégée, workflow autorisé), `platform-deploy`, workflow réutilisable (modes check et deploy), skill `deploy` réécrite (repo, `link_repo`, secrets, workflow), skill `admin-deploy`, releases avec commit et run, event trigger DDL qui signale les changements de schéma hors release ; outils de publication retirés aux PAT de builder quand `DIRECT_DEPLOY=admins`. Volet control plane fait (OIDC, `link_repo`, releases, API `/ci/*`, `DIRECT_DEPLOY`). Critère : sur `examples/todo-app`, « déploie l'app sur la plateforme » depuis un repo vierge aboutit à un déploiement par GitHub Actions, et un push d'un workflow modifié pour sauter les contrôles est refusé |
| M4 | **Admin shadcn-admin-kit** | Users, tokens, vue de toutes les apps (propriétaire, repo, dernier déploiement, charge), stop/start/delete, releases, rollback, logs |
| M5 | **Storage + Realtime multi-tenant** | Upload de fichiers et abonnement realtime fonctionnels sur 2 apps |
| M6 | **Auth avancée** | SMTP, SSO plateforme (OIDC puis SAML), politique de signup |
| M7 | **Exploitation** | Backups et restauration, linter de sécurité, intégration Studio (enregistrement auto, deep links, droits), installeur, doc d'installation |

## 12. Risques et questions ouvertes

- **Rôles Postgres globaux** et présupposés de noms de rôles dans les composants Supabase (M0).
- **Nombre de connexions** Postgres à 50+ apps (M0, recours à Supavisor).
- **Maturité du multi-tenant** Storage et Realtime en self-hosted (M5). Plan B : un conteneur Storage par app, démarré seulement si l'app utilise Storage.
- **Voisin bruyant** : une app qui charge le cluster impacte toutes les autres. Mitigation par `statement_timeout` par rôle, limites de connexions par database et monitoring.
- **Mises à jour Supabase** : compatibilité des migrations GoTrue et Storage sur 50 databases. Procédure de mise à jour à outiller.
- **Isolation des edge functions** (isolates et non conteneurs) : à documenter auprès des clients.
- **Studio multi-head** : licence non libre (Sustainable Use License) à valider juridiquement, projet jeune à mainteneur unique, dérive par rapport à Studio upstream. Mitigation : composant optionnel derrière `StudioRegistry`, image épinglée, repli sur le Studio officiel à la demande.
- **Dépendance à GitHub** : un incident GitHub Actions bloque les déploiements (repli : déploiement admin, §6.3). Les clients sur une autre forge ne sont pas couverts en V1.
- **Accessibilité depuis la CI** : une plateforme interne n'est pas joignable par les runners hébergés par GitHub. À vérifier avant chaque installation.
- **Concurrence** : regarder **Nubase** (open source, Supabase-like multi-projets self-hosted avec MCP pour agents de code) avant de démarrer, pour se différencier ou s'en inspirer.
- **Nom du produit** : à définir.
