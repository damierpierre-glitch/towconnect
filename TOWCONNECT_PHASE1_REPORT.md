# TowConnect — Phase 1 Report

Date : 2026-08-30

## Changements réalisés

1. **Véhicules enregistrés** — table `vehicles` (make/model/year/color/plate/province, `is_primary`), un seul véhicule principal garanti par index unique partiel en base. `requests.vehicle_id` (nullable, `on delete set null`) relie une course à un véhicule sans jamais altérer `vehicle_desc`, le snapshot historique existant.
2. **Interface "Mes véhicules"** (`/vehicles`) — lister, ajouter, modifier, supprimer, définir un véhicule principal. Formulaire inline, pas de modal. FR/EN. Lien ajouté dans `NavBar` pour le rôle `user`.
3. **Request Flow simplifié** — Hero marketing supprimé pour un client connecté : `/request` entre directement dans le formulaire. Type de panne en gros boutons tactiles (plus de `<select>`). Véhicule principal présélectionné automatiquement, changement en un tap via chips, ajout rapide inline si aucun véhicule.
4. **Localisation auto** — tentative de géolocalisation automatique au chargement du formulaire (réutilise la permission GPS existante), fallback texte non bloquant en cas de refus/échec, ré-détection manuelle toujours disponible.
5. **Reprise automatique d'intervention** — `getActiveRequest()` (server action) interroge la DB à chaque chargement de `/request` (source de vérité, filtrée RLS) ; si une course est en statut `pending/matched/en_route/arrived`, l'usager atterrit directement sur l'écran de suivi au lieu de perdre son flow après un refresh/fermeture.
6. **Préparation Smart Dispatch** — aucune réécriture de `StepDrivers.tsx`/`nearby_drivers()`/`accept_request()` ; le flux crée toujours la course via les mêmes fonctions, prêt à remplacer uniquement l'étape de sélection à la prochaine phase.

## Migrations créées

- `app/supabase/migrations/0005_vehicles.sql` — additive, n'altère aucune table/policy des migrations 0001-0004. Contient : table `vehicles` + RLS (owner CRUD + lecture admin), index unique partiel `vehicles_one_primary_per_user`, `requests.vehicle_id`.
- **Non appliquée** à un projet Supabase live dans cette session (voir "Problèmes restant connus").

## Fichiers principaux modifiés/créés

- `app/supabase/migrations/0005_vehicles.sql` (nouveau)
- `app/src/lib/supabase/types.ts` — type `Vehicle`, `ACTIVE_REQUEST_STATUSES`, `TowRequest.vehicle_id`, entrées `Database`
- `app/src/lib/actions/vehicles.ts` (nouveau) — CRUD + `setPrimaryVehicle`
- `app/src/lib/actions/requests.ts` — `createRequest` accepte `vehicleId`, nouveau `getActiveRequest()`
- `app/src/app/(user)/vehicles/page.tsx` + `VehiclesManager.tsx` (nouveaux)
- `app/src/app/(user)/request/page.tsx` — fetch véhicules + course active, server-side
- `app/src/app/(user)/request/RequestFlow.tsx` — suppression du Hero/idle, résumé via props
- `app/src/app/(user)/request/StepForm.tsx` — géoloc auto, gros boutons, sélecteur de véhicule
- `app/src/app/(user)/request/types.ts` — `vehicleId` sur `RequestFormData`
- `app/src/components/NavBar.tsx` — lien "Mes véhicules"
- `app/src/lib/i18n/dictionary.ts` — nouvelles clés FR/EN
- `app/scripts/rls-integration-test.ts` — 12 nouveaux tests RLS `vehicles`
- `app/README.md` — mention de la migration 0005

## Tests exécutés

| Test | Résultat |
|---|---|
| `npx tsc --noEmit` | ✅ 0 erreur |
| `npm run lint` | ✅ 0 erreur, 0 warning |
| `npm run build` (production) | ✅ compile, `/vehicles` généré comme route dynamique |
| `npm run test` (vitest — pricing) | ✅ 14/14 tests passent |
| `npm run test:integration` (RLS live) | ⚠️ **non exécuté** — voir ci-dessous |

## Problèmes restant connus

- **Test d'intégration RLS non exécuté contre une vraie instance.** `.env.local` ne contient que `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` (pas de `SUPABASE_SERVICE_ROLE_KEY`), et aucun `supabase` CLI local n'est installé dans cet environnement pour démarrer une instance jetable. Le script (`scripts/rls-integration-test.ts`) a été étendu avec 12 nouveaux cas couvrant `vehicles` (lecture/écriture/suppression propriétaire vs. tiers, auto-primary sur le premier véhicule, rejet DB d'un second véhicule principal, bascule primary via clear-puis-set) mais n'a pu être **lancé** — seulement relu attentivement contre la migration. À exécuter avec `SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY` d'un projet jetable avant mise en production.
- **Migration `0005_vehicles.sql` non appliquée** au projet Supabase configuré dans `.env.local` — je n'ai ni le rôle service ni les identifiants psql, et `Infos.txt` (mot de passe du dashboard) n'est pas un accès approprié pour un agent autonome à utiliser sans confirmation explicite. À exécuter manuellement dans le SQL Editor Supabase, comme les migrations précédentes.
- Le point de sécurité `Infos.txt` (mot de passe Supabase + token Mapbox en clair à la racine) signalé dans l'audit précédent reste non traité — hors périmètre de cette phase, toujours en attente de ta décision.

## Éléments maintenant prêts pour Smart Dispatch

- `nearby_drivers()`, `accept_request()` et les statuts `requests` sont inchangés et toujours le point d'entrée unique du matching — la prochaine phase peut remplacer `StepDrivers.tsx` par une offre automatique sans toucher au SQL existant.
- `RequestFormData` transporte déjà `vehicleId` jusqu'à `createRequest`, donc un futur dispatch peut utiliser le type/gabarit du véhicule pour affiner le matching sans nouvelle migration.
- `getActiveRequest()` + la reprise automatique donnent déjà à Smart Dispatch un mécanisme prêt à l'emploi pour ré-atterrir l'usager sur le bon écran pendant qu'une offre est en cours (pending → matched), sans travail de session supplémentaire.
