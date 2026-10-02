# User journeys

Légende : ✅ fait · 🟡 partiel · ❌ absent. Le jalon renvoie à [PLAN_1.md](../PLAN_1.md) §11 ; M0ter désigne l'intégration de Studio pour les builders ([rapport](../spikes/m0ter-studio-builders/REPORT.md)).

## Personas

- **App users** : utilisent les apps déployées, en anonyme ou avec un compte du GoTrue de l'app.
- **App builders** : créent, modifient et inspectent leurs apps, et gèrent leurs utilisateurs. Ils ne voient que leurs apps.
- **Admins** : voient toutes les apps et gèrent les builders.

## Décisions produit

| Sujet | Décision |
|---|---|
| Login web (Studio, admin) | Comptes locaux (email et mot de passe) gérés par la plateforme. Pas de SSO pour les builders et les admins. |
| Création d'apps | Libre, avec un quota par builder que l'admin peut modifier. |
| Rôles dans une app | **Owner** : tout, y compris gérer les membres, arrêter et supprimer l'app. **Collaborateur** : déployer, inspecter, gérer les utilisateurs de l'app. |
| Visibilité | Un builder ne voit que les apps dont il est membre. Pas de catalogue. |
| Configuration de l'auth d'une app | Partagée. Le builder gère le signup, les URLs de redirection et les providers simples. L'admin configure une fois le SSO d'entreprise ; le builder l'active sur son app d'un clic. |
| Gestion des utilisateurs d'une app | Dans Studio (onglet Auth) et par des outils MCP. |
| Environnements | Une seule instance par app, définitivement. Le staging, c'est le `supabase start` local du builder. |
| Alertes | Dashboard admin, plus un email à l'owner de l'app concernée. |
| Apps abandonnées | Après N jours sans trafic ni déploiement, l'app est signalée à l'admin et à l'owner. L'admin décide : mise en sommeil, ou suppression après un backup final. |
| Builders sans Claude Code | Non supportés en V1. L'API REST et le MCP restent génériques, pour ouvrir à d'autres clients plus tard. |
| Domaine personnalisé | Jamais. Les apps sont servies uniquement sur `<app>.<domaine>`. |
| Studio | Ouvert aux builders pour leurs apps, via le fork multi-head vendoré (voir [CLAUDE.md](../CLAUDE.md)). |

## Parcours des app builders

### B1. Onboarding
Déclencheur : un collaborateur veut héberger sa première app.
1. Un admin crée son compte (email + mot de passe) et lui émet un PAT.
2. Le builder installe le plugin : `claude plugin marketplace add <repo>`, puis `claude plugin install platform@platform-local`.
3. Il renseigne son token (`PLATFORM_TOKEN`).
4. Il se connecte à Studio avec ses identifiants.

Canal : admin, puis Claude Code + MCP, et Studio.
État : 🟡. La CLI `create-user` existe, et les comptes locaux avec mot de passe sont faits (M0ter). Il manque l'écran admin pour les comptes et les tokens (M4), la transmission sécurisée du PAT, et le stockage du token dans le trousseau (`userConfig` sensible).

### B2. Premier déploiement
Déclencheur : « déploie l'app sur la plateforme » dans un repo Vite + Supabase.
1. `create_app` (dans la limite du quota), puis écriture et commit de `.platform.json`.
2. `apply_migrations` : le linter tourne dans la transaction et rejette toute nouvelle `ERROR`.
3. Secrets, puis fonctions. Chaque fonction est préchauffée avant la bascule.
4. Build avec les variables renvoyées par `get_app`, puis déploiement du front.
5. Smoke test, puis affichage de l'URL et du lien Studio.

Canal : Claude Code + MCP.
État : ✅ M3 (environ 45 s). Le quota n'est pas encore appliqué ❌.

### B3. Itération
Déclencheur : le builder modifie le schéma ou le front, puis redemande un déploiement.
1. Seules les nouvelles migrations sont appliquées. `dry_run` est possible, et `accept_lints` n'est utilisé qu'avec le consentement explicite du builder.
2. Nouvelles versions des fonctions et du front.
3. `rollback` du front ou des fonctions si besoin.

Canal : Claude Code + MCP.
État : 🟡. Il manque `list_migrations` et le hash de bundle (les fonctions inchangées sont redéployées). Une migration qui contient elle-même un `COMMIT` échappe au rollback.

### B4. Débogage en production
Déclencheur : un utilisateur signale un bug, ou une alerte arrive.
1. Le builder décrit le symptôme à Claude.
2. `get_logs`, puis `execute_sql` en lecture.
3. Diagnostic, puis correctif (B3) ou `rollback`.
4. En option, inspection dans Studio (tables, SQL, RLS).

Canal : Claude Code + MCP, et Studio.
État : 🟡. `get_logs` lit les logs Docker sans historique (Loki n'est pas fait). Studio est ✅ (M0ter). Les alertes sont ❌.

### B5. Gestion des utilisateurs de l'app
Déclencheur : inviter, supprimer ou débloquer un compte, compter les inscrits.
1. Dans Studio : Auth > Users, pour lister, créer, inviter et supprimer.
2. Ou dans Claude : outils MCP dédiés.

Canal : Studio et MCP.
État : 🟡. Studio est ✅ (M0ter). Les outils MCP (`list_auth_users`, `invite_user`, `delete_user`) sont ❌.

### B6. Auth et SSO d'une app
Déclencheur : une app interne réservée aux salariés, ou une app publique.
1. `configure_auth` : signup on/off, domaine email autorisé, URLs de redirection, providers simples.
2. Activation du SSO d'entreprise de la plateforme (configuré par l'admin, A7).
3. Expéditeur et templates d'email.

Canal : Claude Code + MCP.
État : ❌ M6.

### B7. Partage d'une app
Déclencheur : un collègue doit co-maintenir l'app.
1. L'owner ajoute le collègue comme collaborateur.
2. Le collègue clone le repo (`.platform.json` est commité) et déploie avec son propre PAT.
3. L'app apparaît dans son `whoami` et dans son Studio.

Canal : à trancher (MCP pour l'owner, ou admin).
État : ❌. `app_members.role` existe, mais aucun outil ni écran ne gère les membres.

### B8. Arrêt et suppression
Déclencheur : projet terminé, ou signalement d'abandon.
1. `stop_app` : les conteneurs sont arrêtés et une page de maintenance est servie.
2. Backup final.
3. `delete_app` : opération symétrique du provisioning.

Canal : Claude Code + MCP (owner), ou admin.
État : 🟡. Seul `cli.ts delete-app` existe, côté admin. Le reste est ❌.

## Parcours des admins

### A1. Installation
1. Prérequis : une VM de 16 Go ou plus, un DNS wildcard, les ports 80 et 443, un SMTP, un S3.
2. `install.sh` : secrets, démarrage, initialisation, premier admin.
3. Domaine et TLS à la demande.
4. Publication du marketplace de plugins interne.

Canal : shell.
État : 🟡. `install.sh` fonctionne en local, mais `api.localhost` est figé, et il n'y a ni TLS `ask`, ni Loki.

### A2. Builders, tokens et quotas
1. Créer un builder (email, mot de passe).
2. Émettre ou révoquer un PAT, consulter `last_used_at`.
3. Ajuster son quota d'apps.
4. Désactiver le compte.

Canal : admin.
État : 🟡 CLI / ❌ M4.

### A3. Supervision et alertes
1. Dashboard : apps par statut, ressources de la VM, taille du cluster.
2. Apps en erreur, `BOOT_ERROR`, `accept_lints` audités, backups ratés.
3. Alertes par email aux owners.
4. Journal d'audit.

Canal : admin et email.
État : ❌ M4/M7. Les données existent en partie (`apps.status`, `audit_log`).

### A4. Backups et restauration
Backup quotidien de chaque base vers S3, avec rétention, suivi des échecs et restauration vers la même app.

Canal : admin.
État : ❌ M7.

### A5. Reprise d'une app orpheline
Déclencheur : départ d'un collaborateur.
1. Désactiver son compte et révoquer ses tokens.
2. Lister ses apps.
3. Pour chacune : transférer l'ownership à un autre builder, la mettre en sommeil ou la supprimer.

Canal : admin.
État : ❌ M4. Le code source vit dans le repo du builder, pas sur la plateforme.

### A6. Apps abandonnées
1. Après N jours sans trafic ni déploiement, l'app est signalée à l'admin et à l'owner.
2. L'admin décide : mise en sommeil ou suppression après un backup final.

Canal : admin et email.
État : ❌.

### A7. SSO d'entreprise de la plateforme
L'admin configure une fois les providers OIDC et SAML de l'entreprise. Les builders les activent ensuite sur leurs apps (B6).

Canal : admin.
État : ❌ M6.

### A8. Mise à jour de la plateforme
1. Migration du control plane.
2. Recyclage des conteneurs GoTrue et PostgREST, app par app.
3. Rebuild de Studio : rejouer les patches documentés dans `apps/studio/PLATFORM_PATCHES.md`.

Canal : shell.
État : ❌ M7. La procédure de mise à jour de Studio est documentée (M0ter).

## Parcours des app users

### U1. Inscription et connexion par email
Signup, confirmation par email, login, puis accès aux données sous RLS.
État : 🟡. Signup, login et RLS sont vérifiés. La confirmation est automatique tant qu'il n'y a pas de SMTP (M6).

### U2. Connexion par SSO d'entreprise
« Se connecter avec Entra ID / Google », création du compte au premier login, refus si le domaine n'est pas autorisé.
État : ❌ M6.

### U3. Accès anonyme
SPA et requêtes avec la clé anon, limitées par les policies `anon`. Fonctions avec `verify_jwt=false`.
État : ✅.

### U4. Réinitialisation du mot de passe
Email envoyé par le SMTP mutualisé, puis page de reset dans l'app.
État : ❌ M6.

## Questions ouvertes

1. **Gestion des membres d'une app (B7)** : l'owner passe-t-il par un outil MCP (`add_member`, `remove_member`), par l'admin, ou par les deux ?
2. **Seuils** : valeur par défaut du quota d'apps par builder, et nombre de jours avant le signalement d'une app abandonnée.
