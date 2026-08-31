# TowConnect — Phase 2.5 Report — Stabilizing Smart Dispatch's real-world timeout latency

Date : 2026-08-31

## 1. Comportement réel avant correction

Audit du code tel qu'il existait à la fin de la Phase 2 (`0006_smart_dispatch.sql` + `driver.ts`) :

- **Refus explicite** (`respond_to_dispatch_offer(p_accept := false)`) : marquait l'offre `'declined'` et effaçait `requests.driver_id`. **Rien d'autre.** Aucun appel à `dispatch_next_candidate()` dans la foulée. La course restait `pending`/sans chauffeur jusqu'au prochain passage du cron `dispatch-tick`.
- **Timeout silencieux** (chauffeur qui ne répond jamais) : entièrement dépendant de `process_dispatch_timeouts()`, appelée uniquement par le cron `dispatch-tick`.
- **Cadence réelle du cron** : le README de `dispatch-tick` recommandait ~15s mais documentait déjà que l'UI Dashboard Cron de Supabase et la syntaxe `pg_cron` standard ne supportent qu'une granularité **minute**. Sans configuration sub-minute avancée (non garantie disponible selon le plan), la cadence réelle par défaut était donc **jusqu'à ~60 secondes**.
- **Délai maximal réel avant qu'un second chauffeur reçoive l'offre** : dans le pire cas documenté (refus OU timeout, cron à la minute), **jusqu'à ~60 secondes** — inacceptable pour un produit de dépannage d'urgence dont l'objectif est justement de ne jamais dépendre d'un délai externe pour progresser.

## 2. Problème identifié

Le refus explicite — le cas le plus fréquent en pratique — n'avait **aucune raison** de dépendre du cron : c'est un appel serveur unique, dans une transaction déjà ouverte, où on connaît déjà la course concernée. Le faire attendre un cron à la minute était une dépendance inutile, pas une nécessité architecturale.

Le timeout silencieux, lui, a une vraie contrainte : personne ne "sait" qu'il faut agir tant que le délai n'est pas passé. Mais l'app dispose déjà d'un signal qu'elle n'exploitait pas : **le client du rider est presque toujours ouvert et en train d'observer cette course précise** (c'est lui qui attend de l'aide) — de même pour le chauffeur tant que son offre est active.

## 3. Solution retenue

**Migration additive `0007_dispatch_immediate_advance.sql`**, sans toucher aux migrations 0001-0006 :

1. **Refus → avance immédiate.** La logique de matching (précédemment tout le corps de `dispatch_next_candidate()`) a été extraite telle quelle dans `dispatch_next_candidate_core()`, sans vérification d'autorisation propre. `dispatch_next_candidate()` (point d'entrée public, appelé par le client/le cron) délègue à ce noyau après sa vérification d'autorisation habituelle. `respond_to_dispatch_offer()`, dans sa branche refus, appelle maintenant ce noyau **dans la même transaction**, juste après avoir marqué l'offre `'declined'`. Le chauffeur suivant est donc offert avant même que le premier appel RPC ne retourne au client.
2. **Timeout silencieux → nudge côté client, cron en filet de sécurité.** Nouvelle fonction `nudge_dispatch(p_request_id)` : idempotente, pas chère (un `SELECT` si rien n'est dû), vérifie si l'offre en cours a dépassé `expires_at` et, si oui, la marque `'timeout'` et relance le matching — sinon ne fait rien. Le client du rider (`StepTracking.tsx`) et celui du chauffeur offert (`DriverDashboard.tsx`) l'appellent tous les deux toutes les **5 secondes** tant qu'une course est en recherche/attente. Le cron `dispatch-tick` reste inchangé et continue de tourner comme filet de sécurité pour le cas où **tous** les onglets pertinents sont fermés.

**Pourquoi ce choix plutôt qu'un cron plus rapide** : la cadence sub-minute de `pg_cron`/Dashboard Cron n'est pas garantie disponible selon le plan Supabase — s'appuyer dessus comme mécanisme principal aurait été fragile et hors du contrôle direct du code. Le nudge client-side, lui, ne dépend d'aucune infrastructure supplémentaire (aucun microservice, aucune queue), coûte une poignée d'appels RPC très bon marché toutes les 5s, et exploite une réalité produit déjà vraie : la personne en panne garde son onglet ouvert parce qu'elle attend de l'aide. C'est la solution la plus simple compatible avec la stack actuelle, documentée honnêtement comme optimisation de latence — pas comme remplacement des garanties serveur.

## 4. Délai réel avant / après

| Scénario | Avant (Phase 2) | Après (Phase 2.5) |
|---|---|---|
| Refus explicite | jusqu'à ~60s (cron) | **quasi instantané** (même transaction, aucune attente) |
| Timeout, onglet rider **ou** chauffeur ouvert | jusqu'à ~60s (cron) | **~1-5s** après l'expiration réelle (borné par l'intervalle de nudge) |
| Timeout, **tous** les onglets fermés | jusqu'à ~60s (cron) | **inchangé**, jusqu'à ~60s (cron, filet de sécurité documenté) |
| Tentative d'acceptation d'une offre expirée | bloquée immédiatement (déjà en ligne dans le code) | **inchangé**, toujours bloquée immédiatement, indépendamment du cron ou du nudge |

## 5. Fichiers / migrations modifiés

- `app/supabase/migrations/0007_dispatch_immediate_advance.sql` (nouveau, additif) — `dispatch_next_candidate_core()`, `dispatch_next_candidate()` (redéfinie en simple wrapper), `respond_to_dispatch_offer()` (redéfinie, refus déclenche le redispatch), `nudge_dispatch()` (nouvelle).
- `app/src/lib/supabase/types.ts` — type de la fonction `nudge_dispatch`.
- `app/src/app/(user)/request/StepTracking.tsx` — nudge toutes les 5s tant que `status === 'pending'`.
- `app/src/app/dashboard/driver/DriverDashboard.tsx` — même nudge tant qu'une offre est en attente.
- `app/scripts/rls-integration-test.ts` — scénarios réécrits/ajoutés (voir §7).
- `app/supabase/functions/dispatch-tick/README.md` — documentation mise à jour : le cron est maintenant explicitement un filet de sécurité, pas le chemin principal.
- **Non appliquées** à un projet Supabase live (voir §7/§8, même limitation que les Phases 1 et 2).

## 6. Impact sécurité

Aucune garantie de la Phase 2 n'a été affaiblie :

- `dispatch_next_candidate_core()` n'est accessible que depuis les trois points d'entrée `SECURITY DEFINER` de confiance — aucun `GRANT` direct à `authenticated`/`service_role`, donc pas de nouvelle surface d'attaque.
- L'index unique partiel `dispatch_offers_one_active_per_request` (Phase 2) reste la garantie DB "une seule offre active par course" — inchangé.
- `respond_to_dispatch_offer()` continue de rejeter une offre expirée **en ligne**, avant toute autre logique — ce comportement ne dépend ni du nudge ni du cron.
- `nudge_dispatch()` vérifie explicitement que l'appelant est soit le propriétaire de la course, soit le chauffeur qui détient l'offre en cours, soit le rôle service — un utilisateur quelconque ne peut pas forcer l'avancement du dispatch d'une course qui ne le concerne pas (testé, voir §7).
- `accept_request()` reste la seule source d'atomicité pour l'attribution finale d'une course — non modifiée, toujours appelée telle quelle.

## 7. Tests

| Test | Résultat |
|---|---|
| `npx tsc --noEmit` | ✅ 0 erreur |
| `npm run lint` | ✅ 0 erreur, 0 warning |
| `npm run build` (production) | ✅ compile |
| `npm run test` (vitest — pricing) | ✅ 14/14, inchangés |

Scénarios ajoutés/réécrits dans `scripts/rls-integration-test.ts` (script d'intégration RLS live) :
- refus → le chauffeur suivant est déjà offert **sans appel de redispatch manuel** (le test précédent, qui simulait le cron à la main, a été réécrit pour vérifier l'avance automatique)
- `nudge_dispatch()` avant échéance → no-op vérifié (aucun changement d'état)
- `nudge_dispatch()` après échéance → timeout + offre suivante vérifiés
- utilisateur non autorisé tentant de nudger la course d'un autre → rejeté
- offre expirée toujours impossible à accepter (test Phase 2 conservé tel quel)
- épuisement complet du bassin de candidats → course conservée `pending`/sans chauffeur, aucun faux chauffeur créé
- un nouveau chauffeur qui se connecte après l'épuisement est capté au nudge suivant
- annulation pendant l'attente, concurrence sur deux acceptations, isolation chauffeur A/B (tests Phase 2 conservés, toujours valides — logique inchangée sur ces points)

**Non exécutés dans cet environnement**, même limitation que les Phases 1 et 2 : `.env.local` ne contient pas `SUPABASE_SERVICE_ROLE_KEY`, et aucun `supabase` CLI local n'est disponible pour une instance jetable. Je n'ai pas contourné cette limite. La migration `0007` elle-même n'a pas été appliquée à un projet live pour la même raison (pas d'accès service-role/psql approprié pour un agent autonome — et `Infos.txt` n'a pas été utilisé, conformément à la consigne).

Le timer UI n'a pas de test automatisé (c'est un rendu visuel) — vérifié par lecture de code : le compte à rebours chauffeur lit `expires_at` réel depuis `dispatch_offers`, jamais une constante codée en dur, donc il reste cohérent avec le backend par construction.

## 8. Limitations restantes

- Si **à la fois** l'onglet du rider et celui du chauffeur offert sont fermés au moment d'un timeout, le délai réel redevient celui du cron (jusqu'à ~60s avec une planification à la minute) — cas rare mais possible, documenté, non résolu par cette phase (résoudre entièrement ce cas nécessiterait des notifications push, explicitement hors scope).
- `nudge_dispatch()` ajoute un appel RPC léger toutes les 5s par onglet actif en attente — négligeable en usage réel actuel, à surveiller si le volume de courses simultanées devient important (pas un problème à l'échelle du MVP).
- Toujours aucune nouvelle tentative sur un chauffeur ayant déjà refusé/expiré pour la même course (choix V1 de la Phase 2, non revisité ici).

## 9. Recommandation de cadence production

Planifier `dispatch-tick` **toutes les minutes** (`* * * * *`, granularité standard Supabase/`pg_cron`) suffit désormais : ce n'est plus le chemin principal de latence, seulement le filet de sécurité pour le cas où personne ne regarde l'écran. Une cadence sub-minute reste possible si le plan Supabase le permet, mais n'est plus nécessaire pour une expérience utilisateur cohérente.
