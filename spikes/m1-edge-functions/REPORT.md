# Spike M1 : Edge Functions multi-tenant (rapport)

**Verdict : critère de sortie M1 atteint.** Un seul conteneur `supabase/edge-runtime:v1.76.2`, piloté par un main worker maison d'environ 250 lignes sans dépendance, sert 2 apps (et 50 apps au test de charge) avec des env isolées, `verify_jwt` par fonction et par app, les imports `npm:` avec un cache persistant, et la bascule de version par symlink sans redémarrage. Les 12 tests d'intégration et les 4 tests unitaires passent.

La conception tient. Trois points restent à surveiller : la RAM par worker (environ 12 Mo, et une mémoire qui n'est pas entièrement rendue après la retraite des workers), l'ouverture réseau des fonctions vers le réseau Docker interne, et l'isolation par isolate V8 (pas par conteneur).

## 1. Ce qui a été construit

```
apps/edge-main-worker/        # main worker réutilisable (§10 du plan)
  index.ts        routeur : gateway token → app → fonction → JWT → user worker
  config.ts       lecture des JSON d'app / manifestes, cache invalidé par (inode, mtime, taille)
  resolve.ts      validation app/fonction, résolution de current via realpath, anti-évasion
  jwt.ts          vérification HS256 en WebCrypto (aucune dépendance)
  events/index.ts event worker : logs des fonctions → lignes JSON {app, function, …}
  main_test.ts    tests unitaires (deno test)
spikes/m1-edge-functions/
  docker-compose.yml   projet « m1 » : edge, caddy (:8090), controlplane (faux control plane)
  setup.ts             joue le control plane : génère runtime/ (configs, versions, Caddyfile, JWT)
  run.sh               reproductible : setup → publication dans les volumes → up → tests
  test.ts              12 tests d'intégration (curl)
  bench.ts, churn.ts   mesures RAM et latence
  fixtures/functions/  app1 (v1, v2) et app2 (v1) : hello, secure, env, deps, imports, probe, burn
```

Lancement : `./run.sh` (ajouter `FRESH=1` pour vider aussi le cache Deno), puis `deno run -A bench.ts 50` et `deno run -A churn.ts 6`.

### Flux d'une requête

1. `GET http://app1.localhost:8090/functions/v1/hello` arrive sur Caddy. Le site `app1.localhost` (une route par app, comme le générera le control plane) retire `/functions/v1` et **pose** (`header_up` = *set*, ce qui remplace toute valeur cliente) `X-Platform-App: app1` et `X-Platform-Gateway-Token: <secret>`.
2. Le main worker vérifie le gateway token en temps constant, puis valide le slug de l'app (`^[a-z0-9][a-z0-9-]{0,62}$`) et le nom de fonction (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, ce qui exclut `_shared`, `..` et `%2e`).
3. Il charge `/config/apps/app1.json`, mis en cache tant que l'inode, le mtime et la taille ne changent pas.
4. Il résout `realpath(/functions/app1/current)` → `/functions/app1/v1`, vérifie que le résultat reste sous `/functions/app1/`, puis que `realpath(<version>/hello/index.ts)` reste sous `<version>/hello/`.
5. Il lit `<version>/functions.json` (`verify_jwt` vaut `true` par défaut, comme sur Supabase) et, si besoin, vérifie le JWT HS256 avec le `jwt_secret` **de l'app**. Les `OPTIONS` (preflight CORS) passent sans JWT.
6. Il appelle `EdgeRuntime.userWorkers.create({ servicePath, maybeEntrypoint, envVars, memoryLimitMb, cpuTime*, workerTimeoutMs, permissions, context.supervisor.requestAbsentTimeoutMs })`, puis transmet la requête **après avoir retiré** les headers `X-Platform-*`.

**Clé de pool des workers.** L'edge runtime réutilise les workers par `servicePath`. Le main worker utilise donc comme `servicePath` un répertoire temporaire par couple *(répertoire réel de la version de la fonction, hash du JSON de l'app)*, nommé `/tmp/<app>.<fonction>.<rand>`, et passe le vrai fichier via `maybeEntrypoint` (même astuce que le main de la CLI Supabase). Conséquences :

- **une nouvelle version** donne un nouveau realpath, donc un nouveau worker dès la requête suivante ;
- **un nouveau secret** donne un nouveau hash, donc un nouveau worker avec les nouvelles env ;
- les anciens workers meurent après le délai d'inactivité.

## 2. Résultats des tests (`test.ts`, tous verts)

| Test | Résultat |
|---|---|
| Routage par host (app1 vs app2) ; `req.url` vu par la fonction = `http://app1.localhost:8090/hello` | OK |
| Host inconnu (`app3`, IP brute) → 404 Caddy ; fonction inconnue ou `_shared` → 404 | OK |
| Env de la fonction = exactement le JSON de l'app + `SUPABASE_FUNCTION_SLUG` + `SB_EXECUTION_ID` (injecté par le runtime). Aucune valeur d'app2, aucun `jwt_secret`, aucune variable `PLATFORM_*`, `PATH` ou `HOSTNAME` | OK |
| Header forgé depuis le host app1 : `X-Platform-App: app2` (casse variée, doublé, `X_Platform_App`, faux `X-Platform-Gateway-Token`) → toujours app1 | OK |
| `X-Forwarded-Host: app2…` envoyé par le client → ignoré (Caddy le réécrit) | OK |
| Path traversal (`../`, `%2F`, `%2e%2e`, `..;`, `--path-as-is`) → jamais de contenu d'app2, jamais de 200 | OK |
| JWT anon ou service_role d'app1 sur `app2/secure` → 401 `UNAUTHORIZED_JWT` ; JWT d'app2 → 200 ; sans header → 401 ; JWT expiré → 401 ; `alg: none` → 401 ; `verify_jwt=false` → 200 sans token | OK |
| `npm:zod` + `npm:@supabase/supabase-js` ; import map via `deno.json` par fonction (spécificateur nu `"zod"`) découvert automatiquement | OK |
| Sandbox (fonction « probe ») : lecture de `/config/apps/*.json`, des fonctions d'app2, de `/proc/self/environ` ou de `/main` → échec ; `/tmp` d'une autre app invisible ; `Deno.Command` interdit ; écriture dans `/functions` → échec ; API admin Caddy injoignable ; **appel direct du main worker** (`127.0.0.1:9000` ou `edge:9000`) avec `X-Platform-App: app2` → **403** (pas de gateway token) | OK |
| `/_internal/metrics` via le gateway sans token admin → 403 | OK |
| Bascule `current` → v2 (`ln -s v2 current.tmp && mv -T current.tmp current`) : la requête suivante sert v2, sans redémarrage ; app2 reste en v1 ; retour en v1 | OK |
| Réécriture atomique du JSON d'app1 (nouveau secret, nouveau `jwt_secret`) : prise en compte à la requête suivante ; l'ancien anon key devient invalide | OK |
| Limite CPU (boucle de 10 s, limites 1 s / 2 s) → 546 `WORKER_LIMIT` ; limite mémoire (150 Mo) → 546 ; app1 et app2 continuent de répondre | OK |

## 3. Mesures

Conditions : MacBook, Docker Desktop (VM de 8 Go, partagée avec le spike M0 qui tournait en parallèle), mesures faites avec curl à travers Caddy. Fonction `hello` triviale.

| Mesure | Valeur |
|---|---|
| RAM edge-runtime au repos (main + event worker) | **36 Mo** (Caddy : 14 Mo) |
| RAM avec 2 apps chaudes (environ 8 workers, dont un avec supabase-js) | 140 Mo |
| 50 apps configurées, aucun worker | 36 Mo (le coût d'une app sans trafic est nul) |
| 50 workers `hello` actifs | 636 Mo (≈ **12 Mo/worker**) ; 874 à 946 Mo en pic lors du test de churn |
| 100 workers actifs (50 apps × 2 fonctions) | 1 215 Mo |
| Après la retraite des workers inactifs (idle 10 s) | 263 Mo, sans retour à 36 Mo (mémoire non rendue par l'allocateur) |
| Churn : 6 cycles (50 démarrages à froid, puis retraite) | plancher après retraite 391 → 423 → 437 → 446 → 448 → 464 Mo (croissance lente, qui ralentit) |
| Cold start `hello` (création du worker) | 20 à 64 ms ; p50 = 32 ms, p95 = 56 ms sur 50 apps |
| Warm `hello` | p50 = **4 ms**, p95 = 5 à 6 ms (Caddy compris) |
| Cold start `deps` (zod + supabase-js), cache npm **vide** | **1,7 s à 7,1 s** (téléchargement depuis registry.npmjs.org, variable) |
| Cold start `deps`, cache présent (après redémarrage du conteneur) | 160 à 190 ms |
| Warm `deps` | p50 = 4 ms |
| Première requête après bascule de version | 22 à 25 ms (simple cold start) |
| 50 requêtes warm en parallèle (50 apps) | 130 ms au total |
| Taille du cache Deno (zod + supabase-js) | 15 Mo dans le volume `/deno-cache` (`DENO_DIR` est respecté) |

**Dimensionnement.** Le coût est proportionnel au **nombre de workers actifs**, pas au nombre d'apps. Pour 50 apps avec un trafic intermédiaire, prévoir **1 à 1,5 Go** pour le conteneur edge, avec `mem_limit` et un `--max-parallelism` borné, et une retraite des workers inactifs (30 à 60 s en production).

## 4. Points de sécurité

1. **Le gateway token est indispensable.** Les user workers partagent l'espace réseau du main worker : une fonction peut appeler `http://127.0.0.1:9000` en posant elle-même `X-Platform-App: app2`. Sans contrôle, ce serait une exécution cross-app triviale. Le main worker exige donc un `X-Platform-Gateway-Token` connu seulement de Caddy et du main worker (il n'est pas dans l'env des user workers). Le test le prouve : 403.
2. **Ne jamais transmettre `Deno.env` du main worker aux user workers**, contrairement à l'exemple officiel et à la CLI qui font `...Deno.env.toObject()`. Ici, l'env d'un worker se limite au JSON de l'app.
3. **Système de fichiers.** Par défaut, l'edge runtime compile la fonction et l'exécute sur un FS virtuel : une fonction ne voit pas le FS réel du conteneur, même sans restriction (vérifié en retirant les `permissions`). Le main worker ajoute quand même des `permissions` explicites en défense en profondeur (`allow_read` limité à la version de l'app et à `/tmp`, `allow_write` limité à `/tmp`, pas de `run`/`ffi`). `/tmp` est propre à chaque worker. Conséquence fonctionnelle : `Deno.readFile(new URL("./x", import.meta.url))` échoue. Les fichiers statiques devront être déclarés (`staticPatterns`, à alimenter depuis `static_files` du config.toml).
4. **Les volumes sont montés en lecture seule** dans l'edge (`/functions`, `/config/apps`, `/main`). Seul le control plane écrit.
5. **Résolution de chemins.** Une double whitelist (regex) et des vérifications de realpath empêchent `current` ou une fonction de pointer hors de l'app, même via un symlink malveillant dans une archive (test unitaire). Le control plane doit en plus **refuser les symlinks et les chemins absolus ou `..` dans les tar.gz** uploadés.
6. **JWT.** Le spike ne gère que HS256 avec le secret de l'app (format « legacy », cohérent avec §3.2). `alg: none` et les autres algorithmes sont refusés. Les nouvelles clés asymétriques (ES256 + JWKS) ne sont pas gérées : il faudra ajouter un JWKS par app si on les adopte.
7. **Logs non falsifiables.** L'event worker reçoit les logs avec un `service_path` posé par le runtime. Le préfixe `<app>.<fonction>.` (le `.` est interdit dans les deux regex) permet une attribution fiable. Le message utilisateur est encapsulé dans une chaîne JSON, ce qui empêche l'injection de fausses lignes.
8. **Réseau sortant ouvert** (`allow_net` total, nécessaire pour appeler `SUPABASE_URL` et des API externes). Une fonction peut joindre tout le réseau Docker de l'edge. **Recommandation :** placer l'edge sur un réseau qui ne contient que Caddy et l'egress Internet, sans Postgres, GoTrue, PostgREST ni le control plane, et faire passer les appels Supabase par `SUPABASE_URL` (Caddy). Sinon, une fonction compromise peut au minimum scanner les services internes. `deny_net` par nom d'hôte est contournable (IP), donc il ne suffit pas.
9. **Isolation par isolate V8**, pas par conteneur ni par processus. Une faille V8 ou edge-runtime casserait l'isolation entre apps. C'est acceptable pour du code de collaborateurs de confiance (§3.3) et doit être documenté pour le client.
10. **Endpoints internes.** `/_internal/health` est public et sans information. `/_internal/metrics` (qui liste les `servicePath`, donc les noms d'apps) exige `X-Platform-Admin-Token`.

## 5. Limites et pièges rencontrés

- **Docker Desktop (macOS) et les bind mounts.** Remplacer un symlink par `rename()` côté macOS laisse le conteneur avec une vue cassée (`EINVAL` en traversant `current/`), de façon persistante. C'est un artefact du partage de fichiers de Docker Desktop, sans rapport avec Linux. Le spike utilise des **volumes nommés**, écrits par un conteneur « controlplane », ce qui correspond de toute façon à l'architecture cible. Ne pas monter un **fichier** JSON seul en bind mount, car un rename change l'inode et le conteneur garde l'ancien fichier : il faut monter le **répertoire**.
- **Mémoire non rendue** après la retraite des workers (plancher d'environ 260 Mo, qui monte lentement avec le churn : +73 Mo en 6 cycles de 50 workers). C'est à surveiller sur la durée. Mitigations : `mem_limit` sur le conteneur, `--max-parallelism`, et au besoin un redémarrage planifié de l'edge (environ 3 s d'indisponibilité des fonctions, sans perte de cache npm).
- **Le premier appel d'une fonction avec des dépendances `npm:` neuves** coûte 2 à 7 s (téléchargement). Une erreur de résolution ne se voit qu'à ce moment-là (503 `BOOT_ERROR`). D'où la recommandation de préchauffage au déploiement (§6).
- **Proxy d'entreprise.** Avec `HTTPS_PROXY=http://proxy.invalid:3128`, le téléchargement npm échoue sur la résolution DNS **du proxy** : la variable est donc bien honorée par le runtime pour npm. Non testé : un vrai proxy avec authentification ou interception TLS (il faudrait sans doute `DENO_CERT`), et un miroir npm (`NPM_CONFIG_REGISTRY`).
- **Le retry sur `WorkerAlreadyRetired`** n'est fait que pour les requêtes sans body (un body streamé ne se rejoue pas), comme dans la CLI.
- Les répertoires `/tmp/<app>.<fn>.*` servant de clé de pool s'accumulent : un par couple (version, configuration). C'est négligeable, mais ils seront nettoyés au redémarrage.
- **Caddyfile** : le spike utilise un Caddyfile généré. En cible, le control plane posera la route équivalente via l'API admin JSON (voir §6).

## 6. Recommandations pour le control plane (M2)

### Fichier d'env par app : `/config/apps/<app>.json`

Un fichier par app, dans un **répertoire** monté en lecture seule dans l'edge :

```json
{
  "app": "app1",
  "jwt_secret": "<secret JWT de l'app, ≥ 32 caractères>",
  "env": {
    "SUPABASE_URL": "https://app1.example.com",
    "SUPABASE_ANON_KEY": "<jwt anon>",
    "SUPABASE_SERVICE_ROLE_KEY": "<jwt service_role>",
    "SUPABASE_DB_URL": "postgresql://app_app1_fn:…@postgres:5432/app_app1",
    "MY_SECRET": "valeur définie via set_secrets"
  },
  "limits": { "memory_mb": 150, "cpu_soft_ms": 1000, "cpu_hard_ms": 2000, "wall_clock_ms": 150000 }
}
```

- `app` doit correspondre au nom du fichier : le main worker le vérifie.
- `env` doit être un objet de chaînes. Les secrets d'app (`set_secrets`) y sont fusionnés. Le control plane doit **interdire** aux secrets utilisateur les préfixes `SUPABASE_` et `SB_`.
- `limits` est optionnel. Les valeurs par défaut viennent de l'env du conteneur (`PLATFORM_DEFAULT_*`).
- **Écriture atomique** : écrire `<app>.json.tmp` dans le même répertoire, `fsync`, puis `rename`. Fichier en `0600` côté hôte, le répertoire n'étant monté que dans l'edge.
- **Rechargement** : rien à faire. Le main worker fait un `stat` par requête (coût négligeable) et relit le fichier si l'inode, le mtime ou la taille change. La requête suivante part sur un nouveau worker avec les nouvelles env, et les anciens workers meurent à l'expiration du délai d'inactivité. Supprimer le fichier désactive les fonctions de l'app (404), ce qui est utile pour `stop_app`.
- **Alternative écartée pour V1** : un appel HTTP au control plane avec cache. Elle ajoute une dépendance de disponibilité et un secret de plus, alors que le fichier suffit.

### Déploiement des fonctions (`finalize_deployment`, kind=functions)

1. Extraire l'archive dans `/functions/<app>/<version>/` en refusant les symlinks, les chemins absolus et `..`. Les noms de fonctions doivent respecter `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, et `_shared/` est autorisé.
2. Générer `/functions/<app>/<version>/functions.json` depuis `supabase/config.toml` (`[functions.<nom>] verify_jwt = false`), avec `verify_jwt: true` par défaut :
   ```json
   { "functions": { "hello": { "verify_jwt": false }, "secure": {} } }
   ```
   Les `deno.json` par fonction sont pris en compte automatiquement par le runtime.
3. **Préchauffer** chaque fonction, ce qui télécharge les dépendances `npm:`/`jsr:` dans le cache et révèle les erreurs de boot **avant** la bascule. À ajouter : un endpoint interne `/_internal/warm` (protégé par le token admin) qui crée le worker sur la nouvelle version sans la publier.
4. Basculer : `ln -s <version> current.tmp && mv -T current.tmp current` (rename atomique). Le rollback repointe le symlink de la même façon.
5. Garder les N dernières versions et supprimer les plus anciennes après un délai supérieur au `wall_clock_ms`.

### Routage (API admin Caddy)

Une route par app, posée par le `Router`. Elle est équivalente au Caddyfile du spike :

```json
{
  "match": [{ "host": ["app1.example.com"] }],
  "handle": [{ "handler": "subroute", "routes": [{
    "match": [{ "path": ["/functions/v1/*"] }],
    "handle": [
      { "handler": "rewrite", "strip_path_prefix": "/functions/v1" },
      { "handler": "reverse_proxy", "upstreams": [{ "dial": "edge:9000" }],
        "headers": { "request": { "set": {
          "X-Platform-App": ["app1"],
          "X-Platform-Gateway-Token": ["{env.PLATFORM_GATEWAY_TOKEN}"] } } } }
    ]
  }]}]
}
```

L'app est un **littéral** de la route, jamais dérivée d'un placeholder du host. Le gateway token est généré par `install.sh` et passé à Caddy et à l'edge. Pour le faire tourner, il faudrait que le main worker accepte deux tokens pendant la transition.

### Conteneur edge

- Lancement : `start --main-service /main --event-worker /main/events --policy per_worker` avec `--max-parallelism`. Prévoir `mem_limit` de 1,5 à 2 Go pour 50 apps et `DENO_DIR=/deno-cache` sur un volume persistant.
- Env : `PLATFORM_GATEWAY_TOKEN`, `PLATFORM_ADMIN_TOKEN`, `PLATFORM_WORKER_IDLE_TIMEOUT_MS` (30000 recommandé ; 10000 dans le spike), `PLATFORM_DEFAULT_*`.
- **Logs** : l'event worker émet une ligne JSON par événement (`{"source":"function","app","function","execution_id","event","level","msg"}`, ainsi que `Boot`, `BootFailure`, `Shutdown` avec la raison `CPUTime`/`Memory`). Le main worker émet `{"source":"main","app","function","version","status","ms"}`. Vector peut les parser et ajouter le label `app` pour Loki, sans autre instrumentation.
- Réseau : un réseau dédié edge ↔ Caddy (voir §4.8).

## 7. Suites possibles (hors périmètre M1)

- `/_internal/warm` pour le préchauffage au déploiement, et `staticPatterns` alimentés depuis `static_files`.
- Gestion JWKS (clés asymétriques) si les nouvelles clés Supabase sont adoptées.
- Test longue durée du plancher mémoire, et test derrière un vrai proxy d'entreprise ou un miroir npm.
- Vérifier le comportement sur un hôte Linux natif (sans Docker Desktop) : bascule de symlink sur bind mount, et RAM.
