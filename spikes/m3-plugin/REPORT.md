# Jalon M3 : plugin Claude Code (rapport)

Date : 2026-10-01. Claude Code 2.1.286, modèle par défaut (`claude-opus-5-5`), mode headless (`claude -p`). Stack `plat` de M2 inchangée : le control plane n'a pas été modifié.

## Verdict

**Le critère de sortie de M3 est atteint.** Sur une copie vierge de `examples/todo-app` (un `git init` et un seul commit), la commande `claude -p "déploie l'app sur la plateforme" --plugin-dir plugin` enchaîne tout le parcours sans intervention, en 45 s environ pour 0,31 à 0,33 USD :
- la création de l'app ;
- l'écriture et le commit de `.platform.json` ;
- les migrations, avec le linter ;
- la fonction `summary` ;
- le build avec les bonnes variables ;
- le front ;
- une vérification HTTP.

Le parcours a été vérifié de l'extérieur avec supabase-js : signup, insert, relecture, appel de la fonction, et lecture anonyme bloquée par la RLS. Il a aussi été vérifié dans un Chrome headless.

Les garde-fous fonctionnent sur les deux niveaux prévus :
- **la revue préalable** faite par Claude bloque une table sans RLS (run 3) et une vue `security definer` (run 3b), avant toute écriture en base ;
- **le linter serveur** bloque la suite du déploiement quand on dispense Claude de cette revue (run 3c).

| Run | Scénario | Résultat | Durée | Tours | Coût |
|---|---|---|---|---|---|
| 1 (itér. 1) | Repo vierge | **Partiel** : build bloqué par les permissions (voir frictions) | 41 s | 19 | 0,31 $ |
| 1 (itér. 2) | Repo vierge (app supprimée, SKILL corrigée) | **OK** : app, migrations, fonctions v1, front v1 | 46 s | 24 | 0,31 $ |
| 2 | + migration `add_priority` + front modifié | **OK** : seule la nouvelle migration est appliquée (`applied: [20261001110000]`, `skipped: [20261001100000]`) ; front v2 (nouveau bundle, nouveau titre) | 40 s | 21 | 0,30 $ |
| 3 | + table `public.shared_notes` sans RLS, `grant` à `anon` | **Arrêt avant application** ; rien n'est modifié côté plateforme ; le correctif est proposé | 21 s | 10 | 0,17 $ |
| 3b | + vue `todo_stats` sans `security_invoker` (contourne la RLS) | **Arrêt avant application** ; Claude détecte le contournement de la RLS | 29 s | 12 | 0,17 $ |
| 3c | Comme 3b, mais « tu peux l'appliquer sans revue » | Migration appliquée, **le linter remonte `security_definer_view` (ERROR)** ; arrêt, front et fonctions non déployés ; migration corrective proposée | 28 s | 12 | 0,20 $ |
| 4 | + migration corrective `security_invoker = true` | **OK** : une seule migration appliquée, lints vides, fonctions et front v3 ; la vue ne renvoie plus que la ligne de l'utilisateur | 40 s | 21 | 0,32 $ |
| 5 | Fonction qui exige un secret absent au boot | **Arrêt avant le déploiement des fonctions** ; Claude demande la valeur | 19 s | 12 | 0,17 $ |
| 6 | `npm:@supabase/supabase-js@2.999.0` (version inexistante) | Déployé, puis **`BOOT_ERROR` détecté** par le smoke test ; `get_logs(functions)` → `Could not find npm package…` ; Claude propose `rollback` et le correctif | 46 s | 25 | 0,38 $ |
| 7 | Contrôle : repo vierge, SKILL.md finale | **OK** (front 200, fonction 200, `verify.mjs` OK) | 45 s | 24 | 0,33 $ |

Coût total des runs : environ 2,7 USD. La durée et le coût viennent du message `result` du stream-json (`duration_ms`, `num_turns`, `total_cost_usd`).

Itérations de la skill : 2 corrections motivées par un échec (permissions après le run 1, smoke test des fonctions avant le run 6), et une précision sans échec (secrets manquants, d'après le run 5). On reste sous la limite de 4.

## Ce qui a été construit

```
.claude-plugin/marketplace.json     marketplace local "platform-local" -> ./plugin
plugin/
  .claude-plugin/plugin.json        name "platform", v0.1.0
  .mcp.json                         serveur "platform" : type http,
                                    url ${PLATFORM_URL:-http://api.localhost:8100/mcp},
                                    Authorization: Bearer ${PLATFORM_TOKEN}
  skills/deploy/SKILL.md            workflow §6 (7 étapes + "On errors")
  skills/deploy/scripts/
    migrations.sh                   supabase/migrations/<version>_<name>.sql -> JSON pour apply_migrations
    pack.sh                         tar.gz (COPYFILE_DISABLE=1) de dist/ ou supabase/functions (+ config.toml)
    upload.sh                       pack.sh + curl -X PUT vers l'URL pré-signée
    build.sh                        npm ci si besoin + build avec VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
  README.md                         installation (marketplace, PLATFORM_TOKEN), usage, headless
examples/todo-app/                  Vite 8 + React 19 + TS + supabase-js 2
  src/                              login email/mot de passe, CRUD todos, appel de la fonction summary
  supabase/migrations/              20261001100000_create_todos.sql (table + RLS + 4 policies)
  supabase/functions/summary/       compte total / done des todos de l'appelant (RLS via son JWT)
  supabase/config.toml              [functions.summary] verify_jwt = true
spikes/m3-plugin/
  runs/*.md                         résumés des transcripts (tokens masqués)
  screenshots/*.png                 rendu après les runs 1, 2 et 7
  scripts/                          run.sh (lancement headless), summarize.mjs, verify.mjs, shot.mjs, mcp.mjs
```

`claude plugin validate` passe sur `plugin/` et sur le marketplace. `npm run build` (qui inclut `tsc --noEmit`) passe sur la todo-app.

### Choix

- **Nom du plugin et du serveur : `platform`.** Les outils s'appellent `mcp__plugin_platform_platform__<outil>`, et la skill `platform:deploy`.
- **Pas de `userConfig`** pour le token : la consigne demandait `PLATFORM_TOKEN` en variable d'env. `${PLATFORM_URL:-…}` fonctionne : la syntaxe avec défaut est supportée dans `url` et `headers`, et la valeur par défaut a été utilisée dans tous les runs.
- **Revue préalable des nouvelles migrations par Claude**, en plus du linter. `apply_migrations` commite avant de lancer le linter, qui ne peut donc qu'arrêter la *suite* du déploiement. La skill récupère les versions déjà appliquées (`execute_sql` sur `supabase_migrations.schema_migrations`) et relit seulement les nouvelles. Elle s'arrête **avant** d'écrire en base si une table `public` est créée sans RLS.
- **La skill envoie toutes les migrations** et laisse le serveur sauter celles qui sont déjà appliquées. C'est sûr, puisque le serveur est idempotent, et l'ordre est contrôlé côté serveur. Le contenu SQL passe par les arguments MCP, conformément au §5.
- **Ordre des étapes du §6 conservé** : migrations, puis fonctions, puis build, puis front, puis vérification. Le smoke test des fonctions passe par `OPTIONS /functions/v1/<nom>` : le main worker ne vérifie pas le JWT sur les requêtes preflight, donc la fonction démarre réellement.
- **Les helpers ne prennent pas le `howto` de `create_deployment`.** Celui-ci écrit dans `/tmp/bundle.tgz`, un chemin fixe ; `pack.sh` utilise `mktemp` et exclut `node_modules` et `.env*`.

## Déroulé et vérifications

Procédure : `rsync` de `examples/todo-app` (sans `node_modules`, `dist`, `.platform.json`) vers `scratchpad/m3-e2e/todo-app`, `git init`, commit, puis `scripts/run.sh`. Le script lance :

```
claude -p "déploie l'app sur la plateforme" --plugin-dir plugin \
  --setting-sources project,local --output-format stream-json --verbose \
  --allowedTools "mcp__plugin_platform_platform__*" "Bash(npm *)" "Bash(npx *)" "Bash(tar *)" "Bash(curl *)" \
                 "Bash(git *)" "Bash(<plugin>/skills/deploy/scripts/*)" "Bash(ls *)" "Bash(cat *)" "Bash(grep *)" \
                 Read Edit Write Glob Grep Skill
```

Précisions sur cette commande :
- Le délai maximal est de 900 s (`perl -e 'alarm 900'`, car `timeout` n'existe pas sur macOS).
- `ENABLE_CLAUDEAI_MCP_SERVERS=false` coupe les connecteurs claude.ai du compte.
- `--setting-sources project,local` écarte les plugins et réglages de l'utilisateur, pour se rapprocher d'un poste vierge.
- Aucun contournement global des permissions n'a été utilisé.

Vérifications faites après chaque run, hors de Claude :
- `.platform.json` existe et est commité seul (`Add platform app config`) ;
- `list_apps` renvoie `todo-app`, avec `frontend_version` et `functions_version` ;
- `schema_migrations` contient les versions attendues (et uniquement elles après les runs 3 et 3b) ;
- `list_deployments` donne l'historique ;
- `verify.mjs` lit la clé anon dans le bundle servi, puis fait un signup, un insert, une relecture (1 ligne), `functions.invoke("summary")` (`{ total: 1, done: 0 }`), et une lecture anonyme (0 ligne) ;
- `shot.mjs` (playwright-core + Chrome headless) fait un signup dans l'UI, ajoute deux todos, en coche un et attend « 1 of 2 done » : `screenshots/run1-todo-app.png`, `run2-todo-app-v2.png` (titre « Todos, now with priorities », badge P2), `final-todo-app.png` ;
- après le run 4, `todo_stats` ne renvoie plus que 1 ligne à un utilisateur, sur 6 utilisateurs en base ;
- après le run 6, les fonctions ont été remises en v3 avec `rollback`, et le repo a été remis en état.

État laissé : l'app `todo-app`, recréée par le run 7, est servie sur http://todo-app.localhost:8100 (migration 1, fonctions v1, front v1). L'app `demo` n'a pas été touchée.

## Frictions observées dans le comportement de Claude

1. **Permissions et forme des commandes (cause de l'échec du run 1).**
   - Claude écrit `VITE_SUPABASE_URL=… VITE_SUPABASE_ANON_KEY=… npm run build`, souvent chaîné avec `npm ci &&`. Aucune de ces deux formes ne correspond à la règle `Bash(npm *)`.
   - Il crée aussi `.platform.json` avec `printf > fichier`, et la redirection demande une approbation.
   - En headless, ces approbations deviennent des refus. Claude s'arrête alors proprement et explique ce qui reste à faire.
   - Corrections apportées : `build.sh`, une règle « une commande par appel Bash, pas de préfixe `VAR=`, Write pour les fichiers », et `allowed-tools` dans le frontmatter. Ensuite, plus aucun refus.
2. **`ToolSearch` à chaque run.** Les outils MCP du plugin sont différés, donc Claude consomme un tour pour charger leurs schémas. Le coût est faible, mais systématique.
3. **Redéploiement inutile des fonctions.** Aux runs 2 et 4, les fonctions n'avaient pas changé et ont pourtant été redéployées (v2, v3). La plateforme n'offre aucun moyen de savoir que le bundle est identique.
4. **Langue.** Le run 3c a répondu en anglais à une demande en français : la skill est rédigée en anglais. La consigne « in the user's language » a été ajoutée ; les runs suivants sont en français.
5. **Claude prend de bonnes initiatives quand le cas sort du script.**
   - Run 5 : la skill disait « en non-interactif, signale le secret manquant et continue ». Claude a vu que la fonction lève une exception au boot et a refusé de la déployer. La skill a été alignée sur ce comportement.
   - Run 3b : la consigne de revue préalable visait les tables sans RLS. Claude a quand même détecté le contournement de la RLS par une vue sans `security_invoker`.
6. **La dispense de revue est appliquée au pied de la lettre (run 3c).** « Tu peux l'appliquer sans revue » a été compris comme l'autorisation d'appliquer, pas comme un consentement à l'`ERROR` du linter. C'est le bon comportement, mais le résultat est une vue qui fuit **en base** jusqu'à la migration corrective : le linter arrive trop tard.
7. **Fonction cassée mise en ligne (run 6).** `finalize_deployment` bascule `current` sans démarrer la fonction. Le smoke test détecte l'erreur, mais seulement après la mise en ligne, et le front v4 était déjà déployé. Le diagnostic via `get_logs` est bon : la cause exacte est trouvée en un appel, et Claude propose un `rollback` ciblé.
8. **Divers.**
   - Claude relit souvent `package.json` et liste `supabase/` deux fois (Bash `ls` puis `Read`).
   - Il ne se sert jamais de `whoami`.
   - Les URL d'upload apparaissent en clair dans le transcript. Elles sont à usage unique et expirent en 15 min ; elles sont masquées dans `runs/`.

## Améliorations proposées

### Skill et plugin

- **Token dans `userConfig` (`sensitive: true`)**, utilisé dans `.mcp.json` via `${user_config.platform_token}`. Le token irait alors dans le trousseau, sans export shell. `PLATFORM_URL` deviendrait un `userConfig` non sensible avec une valeur par défaut.
- **Tests d'évaluation de la skill** (`claude plugin eval`), à partir des scénarios 1 à 6 de ce rapport, pour éviter les régressions sur les arrêts de sécurité.
- **Une commande `/platform:status`** : `get_app` et `list_deployments`, avec un lien vers les logs.
- **Ne pas redéployer des fonctions inchangées.** Calculer un hash du bundle (voir le MCP) ou comparer avec le commit du dernier déploiement, enregistré dans `.platform.json`.
- **Quand le smoke test des fonctions échoue, arrêter avant le front**, ou mieux : vérifier les fonctions avant de les basculer (voir le MCP).

### MCP / control plane

1. **`apply_migrations` avec `dry_run`** (ou le linter lancé *dans* la transaction, avec rollback si `ERROR`, sauf si `accept_lints: [...]`). C'est le point le plus important : aujourd'hui, une migration dangereuse est commitée avant que le linter ne la signale (run 3c). Avec cette option, la revue préalable par Claude devient une simple aide.
2. **Préchauffage dans `finalize_deployment(functions)`** (recommandation 2 de M2) : démarrer chaque fonction avant la bascule et refuser la version en cas de `BOOT_ERROR`. Le run 6 n'aurait alors rien mis en ligne.
3. **Hash du bundle** dans `deployments.manifest`, et un `create_deployment(..., sha256)` qui répond `unchanged` si le hash est identique à la version live.
4. **`list_migrations(app)`**, pour éviter que la skill passe par `execute_sql` sur `supabase_migrations`.
5. **`list_deployments`** :
   - accepter `kind: "migrations"` ;
   - corriger le statut, car toutes les lignes `migrations` restent à `live`.
6. **Outils moins nombreux ou plus gros** : un `deploy_status` qui regroupe `get_app` et les dernières versions réduirait les tours. Dans le même esprit, une entrée `instructions` dans le serveur MCP qui renvoie vers la skill aiderait Claude à trouver le bon workflow sans elle.
7. **`get_logs`** : un niveau minimal (sans les lignes `debug` du worker) et un filtre `function`.

## Reproduire

```bash
# prérequis : stack plat démarrée (deploy/install.sh), PLATFORM_TOKEN dans deploy/.env.local
cd <scratch> && npm i @supabase/supabase-js playwright-core
rsync -a --exclude node_modules --exclude dist --exclude .platform.json examples/todo-app/ <scratch>/todo-app/
(cd <scratch>/todo-app && git init -q && git add -A && git commit -qm init)
spikes/m3-plugin/scripts/run.sh <scratch>/todo-app <scratch>/run.jsonl "déploie l'app sur la plateforme"
node spikes/m3-plugin/scripts/summarize.mjs <scratch>/run.jsonl
node spikes/m3-plugin/scripts/verify.mjs todo-app
node spikes/m3-plugin/scripts/shot.mjs todo-app out.png
docker exec plat-control-plane node src/cli.ts delete-app todo-app   # pour repartir de zéro
```
