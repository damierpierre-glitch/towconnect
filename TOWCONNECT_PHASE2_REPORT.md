# TowConnect — Phase 2 Report — Smart Dispatch V1

Date : 2026-08-30

## 1. Architecture Smart Dispatch retenue

Une course reste "en recherche" tant qu'elle est `status='pending'` avec `requests.driver_id = null` — exactement la sémantique déjà utilisée par l'ancien flux manuel, simplement automatisée. `dispatch_offers` (nouvelle table) est un pur journal/verrou d'audit ("qui a été offert quoi et quand") ; **le client ne le lit jamais directement** pour piloter l'UI — il observe la ligne `requests` (déjà en Realtime depuis l'origine du projet), ce qui suffit à distinguer recherche / offre en cours / confirmé.

Toute écriture sur `dispatch_offers` passe par une fonction `SECURITY DEFINER` (`dispatch_next_candidate`, `respond_to_dispatch_offer`, `process_dispatch_timeouts`) — **aucune policy INSERT/UPDATE/DELETE n'existe pour `authenticated`**, donc un chauffeur ou un client ne peut structurellement pas fabriquer ou modifier une offre, RLS l'en empêche par absence de policy, pas seulement par convention côté app.

`nearby_drivers()`, `accept_request()`, `cleanup_stale()`, les migrations 0001-0005 et RLS existant sont **inchangés**. Le premier appel de dispatch se fait de façon synchrone juste après la création de la course (latence minimale), puis une Edge Function `dispatch-tick` (même patron que `cleanup-stale`) reprend la main pour les timeouts et les redispatchs suivants.

## 2. Migrations créées

- `app/supabase/migrations/0006_smart_dispatch.sql` (additive) :
  - table `dispatch_offers` (+ enum `dispatch_offer_status`, RLS lecture seule pour le chauffeur concerné et l'admin)
  - index unique partiel `dispatch_offers_one_active_per_request` — au plus une offre `'offered'` par course, garanti en base
  - `dispatch_next_candidate(p_request_id)` — trouve et offre le meilleur candidat
  - `respond_to_dispatch_offer(p_request_id, p_accept)` — accepter/refuser, appelle `accept_request()` existant pour la branche acceptation
  - `process_dispatch_timeouts()` — balaie les offres expirées, redispatch les courses redevenues sans chauffeur (appelée par le cron)
  - trigger `expire_offer_on_cancel` — annulation pendant une offre en cours = offre résolue immédiatement
- **Non appliquée** à un projet Supabase live (voir §9).

## 3. Scoring V1

Formule dans `dispatch_next_candidate()`, documentée en commentaires SQL :

```
score = 0.65 × (1 − distance / rayon_du_palier)   -- ETA/distance, dominant
      + 0.20 × (rating / 5.0)                      -- note, départage seulement
      + 0.15 si véhicule compatible (accident → flatbed/heavy_duty)  -- bonus, jamais une pénalité
```

Paliers de recherche réutilisés à l'identique (15 / 40 / 350 km, comme l'ancien `StepDrivers`). Exclusions **avant** le scoring, pas de pénalité : chauffeur déjà offert pour cette course (pas de nouvelle tentative sur le même chauffeur en V1), heartbeat > 2 min (plus strict que le seuil `cleanup_stale` de 3 min, sans y toucher), chauffeur déjà sur une course active ailleurs. Aucun ML, aucun poids appris — constantes fixes et documentées, comme demandé.

## 4. Logique d'offre / timeout

`request créée → dispatch_next_candidate() → offre 'offered' (fenêtre 18s) → accept/decline/timeout`. `respond_to_dispatch_offer()` vérifie `expires_at` **en ligne, à chaque appel** — une offre expirée est bloquée immédiatement, indépendamment du cron. `process_dispatch_timeouts()` (appelée par `dispatch-tick`, idéalement toutes les ~15s) balaie les offres silencieusement abandonnées (onglet fermé, perte réseau) et relance le dispatch. Réutilise `accept_request()` tel quel pour l'acceptation — mécanisme atomique non modifié.

## 5. Expérience client

`StepDrivers.tsx` (sélection manuelle) est **supprimé**, remplacé par `StepEstimate.tsx` (un seul prix/ETA estimé avant confirmation, basé sur le chauffeur le plus proche réel — jamais de prix fictif) puis `StepTracking.tsx` étendu pour piloter tout l'après-confirmation depuis la seule ligne `requests` :
- `pending` + pas de chauffeur → "Recherche du meilleur remorqueur…"
- `pending` + chauffeur assigné → "Contact avec un chauffeur disponible…" (aucune donnée personnelle affichée avant acceptation)
- `matched`/`en_route`/`arrived` → écran de suivi existant, inchangé
Aucun jargon technique visible. Annulation possible à tout moment via `cancelRequest()` existant.

## 6. Expérience chauffeur

`DriverDashboard.tsx` (carte "nouvelle demande" existante, inchangée dans sa structure) reçoit : un compte à rebours visible (`Xs`) lu depuis `expires_at`, un champ ETA calculé côté client à partir de la position connue du chauffeur, et un second canal Realtime sur `dispatch_offers` (le canal `requests` existant ne recevrait pas l'événement "mon offre vient d'expirer" — le `driver_id` de la nouvelle ligne ne correspond plus au filtre). Boutons Accepter/Refuser inchangés (mêmes actions `acceptRequest`/`declineRequest`, désormais routées via `respond_to_dispatch_offer`).

## 7. Sécurité / RLS

- Aucune policy write sur `dispatch_offers` pour `authenticated` → fabrication/modification d'offre structurellement impossible.
- Index unique partiel → deux offres `'offered'` simultanées pour la même course, impossible en base.
- `respond_to_dispatch_offer()` filtre `driver_id = auth.uid()` → un chauffeur B ne peut jamais agir sur l'offre d'un chauffeur A (vérifié en profondeur : même le chemin de repli sans ligne d'offre retombe sur le même filtre dans `accept_request()`/la mise à jour brute).
- Chauffeur hors-ligne, heartbeat périmé, ou déjà sur une course active → jamais candidat, filtré avant l'offre.
- Annulation pendant une offre en cours → offre résolue immédiatement par trigger.

## 8. Tests exécutés

| Test | Résultat |
|---|---|
| `npx tsc --noEmit` | ✅ 0 erreur |
| `npm run lint` | ✅ 0 erreur, 0 warning |
| `npm run build` (production) | ✅ compile |
| `npm run test` (vitest — pricing) | ✅ 14/14, inchangés |

## 9. Tests non exécutables et pourquoi

Le cœur de Smart Dispatch (scoring, exclusions, atomicité des offres, RLS) vit délibérément en SQL/PL-pgSQL, pas en TypeScript — sa vérification réelle est donc le script d'intégration (`scripts/rls-integration-test.ts`), pas des tests unitaires vitest. J'ai ajouté ~15 scénarios couvrant explicitement les 14 points demandés (meilleur candidat, exclusion offline/stale, accept/decline/timeout séquentiel, tentative concurrente, offre expirée, chauffeur B bloqué, écriture directe bloquée côté client, aucune disponibilité, annulation pendant dispatch).

**Non exécutés dans cet environnement** : `.env.local` ne contient toujours que `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` (pas de `SUPABASE_SERVICE_ROLE_KEY`), et aucun `supabase` CLI local n'est disponible pour une instance jetable. Conformément à la consigne, je n'ai pas contourné cette limite ni utilisé `Infos.txt` — les tests sont écrits et relus attentivement contre la migration, mais **jamais lancés**. La migration `0006_smart_dispatch.sql` elle-même n'a pas été appliquée à un projet live pour la même raison (pas d'accès service-role/psql approprié pour un agent autonome).

## 10. Limitations connues

- **Cadence du cron** : la fenêtre d'offre est de 18s, mais l'UI Dashboard Cron de Supabase / `pg_cron` standard n'offre qu'une granularité minute. Un chauffeur qui abandonne silencieusement peut donc bloquer une course jusqu'à ~1 min avant redispatch (documenté dans `dispatch-tick/README.md`) — l'acceptation d'une offre expirée reste bloquée immédiatement dans tous les cas, ce n'est qu'un délai de progression, pas une faille.
- **Pas de nouvelle tentative sur un chauffeur qui a refusé/expiré** pour la même course (choix V1 volontairement simple). Si le bassin de chauffeurs proches est très petit (1-2), une course peut épuiser tous les candidats disponibles à ce moment — elle reste vivante et sera relancée par `dispatch-tick` si/quand un nouveau chauffeur passe en ligne, ou expirera via `cleanup_stale()` (10 min, inchangé).
- **Étape d'estimation** (`StepEstimate.tsx`) calcule le prix via le chauffeur réel le plus proche à l'instant de la confirmation ; le chauffeur effectivement assigné par Smart Dispatch peut différer légèrement (rating/compatibilité), donc l'ETA affiché à l'estimation peut différer de quelques minutes du chauffeur réellement assigné. Le prix, lui, est figé à la confirmation (comme avant) et ne change jamais après coup.
- Si aucun chauffeur n'est trouvé dès l'étape d'estimation (avant confirmation), la demande n'est pas créée — seul un nouvel essai est proposé. Le vrai filet de sécurité "aucune disponibilité après confirmation" (course conservée, retentée par le cron) fonctionne, lui, sans blocage.

## 11. Éléments à tester manuellement

Une fois `0006_smart_dispatch.sql` appliqué et `dispatch-tick` déployé/planifié :
1. Créer une course avec un seul chauffeur approuvé/en ligne à proximité → vérifier l'offre + le compte à rebours chauffeur.
2. Refuser l'offre → vérifier que le client reste sur "Recherche…" et qu'un second chauffeur (s'il existe) reçoit l'offre après le prochain tick.
3. Laisser une offre expirer sans réponse → vérifier `dispatch_offers.status='timeout'` et le redispatch.
4. Fermer l'onglet client pendant "Recherche…"/"Contact…"/"En route" et rouvrir `/request` → vérifier la reprise sur le bon écran.
5. Annuler pendant qu'une offre est en cours → vérifier que le chauffeur voit disparaître la demande rapidement.
6. Exécuter `npm run test:integration` avec un vrai `SUPABASE_SERVICE_ROLE_KEY` jetable.

## 12. Prochaines recommandations

- Exécuter le test d'intégration RLS complet (Phase 1 + Phase 2) dès qu'une instance jetable est disponible, avant toute mise en production.
- Envisager, si le volume de refus/timeouts s'avère significatif en usage réel, d'autoriser une seconde offre à un chauffeur qui a décliné après un délai plus long (actuellement hors scope V1, par design).
- Confirmer la cadence réelle disponible pour `dispatch-tick` sur le plan Supabase choisi, et ajuster `dispatch_offer_window()` (actuellement 18s) en conséquence si la cadence minimale est d'une minute.
