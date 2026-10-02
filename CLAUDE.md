# Plateforme d'hébergement d'apps Supabase

Plan de référence : [PLAN_1.md](PLAN_1.md). Rapports des jalons : `spikes/*/REPORT.md`.

## Personas

1. **App users** : utilisateurs des apps déployées. Anonymes, ou authentifiés via le GoTrue de l'instance de l'app.
2. **App builders** : créent, modifient et inspectent leurs instances d'app, gèrent leurs utilisateurs. Ils accèdent à Studio pour leurs apps uniquement. Côté modèle : `users.role = 'developer'` + `app_members`.
3. **Admins** : voient toutes les apps et gèrent les app builders. Côté modèle : `users.role = 'admin'`.

Parcours principaux et décisions produit associées : [docs/USER_JOURNEYS.md](docs/USER_JOURNEYS.md).

## Décisions

- **Studio** : le code de supabase-studio-multi-head est vendoré dans `apps/studio/` et modifié pour que les app builders n'accèdent qu'à leurs apps. Un Studio officiel par app est écarté (trop de RAM par instance ouverte). La licence (Sustainable Use License) n'est pas bloquante tant qu'on ne vise pas la revente.
