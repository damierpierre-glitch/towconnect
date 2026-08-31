# TowConnect — Phase 3 Report — Communication & Tracking Premium

Date : 2026-08-31

## 1. Architecture messagerie

Table `messages` : une ligne = un message lié à une `request`. Chaque message est soit du texte libre (`body`), soit un message rapide (`template_key`, résolu en texte localisé **côté client** via `resolveMessageText()` dans `lib/constants.ts` — jamais stocké déjà traduit, donc le client et le chauffeur voient chacun le message dans leur propre langue). Un `check` contraint qu'un message ait toujours l'un des deux.

Composant `Chat.tsx` unique, réutilisé tel quel dans `StepTracking` (client) et `DriverDashboard` (chauffeur) — même modèle de données, même RLS, même canal Realtime ; seul l'ensemble de messages rapides proposés diffère par rôle.

## 2. Migration créée

- `0008_messages.sql` — table `messages` + RLS + ajout à la publication Realtime.
- `0009_in_progress_status.sql` — ajoute la valeur d'enum `in_progress` (isolée dans sa propre migration, cf. contrainte Postgres déjà documentée en 0002 pour `expired`).
- `0010_request_status_guard.sql` — trigger serveur empêchant un chauffeur de sauter ou d'inverser un statut d'intervention.
- `0011_in_progress_active_job.sql` — **correctif découvert pendant cette phase** : l'ajout de `in_progress` avait laissé trois définitions préexistantes (index unique "un seul job actif", policy de lecture `driver_profiles` par le client, exclusion des chauffeurs occupés dans Smart Dispatch) sans ce nouveau statut, ce qui aurait permis à un chauffeur en intervention (`in_progress`) d'être double-réservé ou de recevoir une nouvelle offre. Corrigé par redéfinition additive (`DROP+CREATE`/`CREATE OR REPLACE`), sans toucher aux fichiers 0002/0006/0007.
- Toutes **non appliquées** à un projet Supabase live (même limitation que les phases précédentes, voir §9).

## 3. RLS

`messages` : lecture/écriture réservées aux deux participants de la request (`user_id`/`driver_id` de `requests`) + lecture admin (`public.is_admin()`). Une request non attribuée (`driver_id = null`) ne peut structurellement pas être écrite par un chauffeur quelconque : leur `auth.uid()` n'égalera jamais `null`. Aucune policy UPDATE/DELETE — un message est immuable une fois envoyé, comme `request_events`. `sender_id = auth.uid()` est vérifié dans la policy INSERT, donc un participant ne peut pas usurper l'identité de l'autre.

Transitions de statut : nouveau trigger `guard_request_status_transition` — ne s'applique qu'aux mises à jour faites par le chauffeur assigné lui-même (`auth.uid() = old.driver_id`), laisse passer sans contrainte la transition `pending → matched` (déjà gérée atomiquement par `accept_request()`), puis n'autorise que l'étape suivante exacte de la chaîne `matched → en_route → arrived → in_progress → completed`. Toute tentative de saut ou de retour en arrière est rejetée côté serveur, indépendamment de l'UI.

## 4. Expérience client

`StepTracking` restructuré : gros titre principal ("**Marc** arrive dans ~9 min", calculé en temps réel à partir de la position GPS live du chauffeur — jamais une estimation figée), puis carte, puis carte d'identité chauffeur (prénom/nom, ⭐ note, type de véhicule, plaque — uniquement les champs réellement disponibles, rien d'inventé, aucune "entreprise" affichée puisque ce champ n'existe pas encore dans le modèle de données), puis chat (messages rapides + texte libre), puis détails (prix, jauge de statuts incluant "Intervention en cours"). Appel téléphonique conservé mais relégué en option secondaire dans la carte d'identité, plus jamais l'action principale.

## 5. Expérience chauffeur

`DriverDashboard` : nouveau bouton "Commencer l'intervention" (arrivé → en cours) et "Terminer" désormais depuis `in_progress` (plus depuis `arrived` directement — cohérent avec le nouveau statut). Chat identique intégré dans la carte de course active. Aucune action non valide pour l'état courant n'est affichée — et, indépendamment de l'UI, le trigger serveur bloque toute tentative de contournement.

## 6. Statuts d'intervention

`pending`(recherche) → `matched`(confirmé) → `en_route` → `arrived` → **`in_progress`** *(nouveau)* → `completed`, plus `cancelled`/`expired` inchangés. Un seul statut ajouté — celui qui manquait réellement pour distinguer "arrivé sur les lieux" de "travail en cours", ce que la liste d'actions chauffeur demandée par cette phase rendait nécessaire. Aucune sous-étape "en route vers destination" ajoutée au schéma : aucune donnée de destination n'existe dans le modèle (`requests` n'a qu'un point de panne), et l'ajouter aurait dépassé le périmètre strict de cette phase — le message rapide "Nous sommes en route vers la destination" reste néanmoins disponible (c'est juste du texte, pas un statut).

## 7. Realtime

Messages : `postgres_changes` INSERT sur `messages` filtré par `request_id`, avec re-fetch complet à chaque `SUBSCRIBED` (pas seulement au montage) — récupère automatiquement les messages manqués pendant une déconnexion/reconnexion, sans logique de reconnexion manuelle. Déduplication par `id` dans un `Set` : le message retourné directement par l'action serveur `sendMessage()` ET l'écho Realtime du même insert ne créent jamais un doublon visuel. Bouton d'envoi désactivé pendant l'envoi (empêche un double-clic de créer deux messages), échec affiché clairement avec un bouton "Réessayer" qui renvoie exactement le même texte.

## 8. Reprise après refresh

Aucun changement nécessaire à la mécanique de reprise de la Phase 1 : `StepTracking` se remonte avec le `requestId` réel, et `Chat` (comme le reste du composant) requête simplement l'état actuel depuis la DB au montage — messages, statut, chauffeur assigné réapparaissent identiques après un refresh ou une fermeture/réouverture, sans état React à reconstruire manuellement.

## 9. Tests exécutés

| Test | Résultat |
|---|---|
| `npx tsc --noEmit` | ✅ 0 erreur |
| `npm run lint` | ✅ 0 erreur, 0 warning |
| `npm run build` (production) | ✅ compile |
| `npm run test` (vitest — pricing) | ✅ 14/14, inchangés |

Scénarios ajoutés dans `scripts/rls-integration-test.ts` : envoi/lecture par les deux participants, isolation d'un tiers (client B), isolation d'un chauffeur non assigné, usurpation de `sender_id` bloquée, request non attribuée non contactable par un chauffeur quelconque, lecture admin via une vraie session `role='admin'` (pas le client service-role, qui contourne RLS par nature) ; transitions valides (chaîne complète `matched→…→completed`), saut d'état rejeté, retour en arrière rejeté, chauffeur non assigné ne peut pas toucher une autre course ; `in_progress` traité comme job actif (exclu du dispatch, double-réservation rejetée par l'index unique, profil chauffeur toujours lisible par le client).

## 10. Tests non exécutés

Même limitation que les Phases 1, 2 et 2.5 : `.env.local` ne contient pas `SUPABASE_SERVICE_ROLE_KEY`, aucun `supabase` CLI local disponible pour une instance jetable. Je n'ai pas contourné cette limite. Les migrations `0008` à `0011` n'ont pas été appliquées à un projet live pour la même raison (pas d'accès service-role/psql approprié pour un agent autonome ; `Infos.txt` n'a pas été utilisé).

## 11. Limitations connues

- Pas de pièces jointes/photo/audio (hors scope explicite de cette phase).
- Pas d'indicateur de lecture : `messages.read_at` existe dans le schéma mais n'est câblé nulle part côté app cette phase (préparé, pas implémenté — décision volontaire pour rester simple).
- "Entreprise du chauffeur" non affichée : le champ n'existe pas dans `driver_profiles`, donc rien n'est montré plutôt que d'inventer une valeur.
- Pas de destination/étape "en route vers destination" au niveau du schéma — seul un message rapide texte existe pour ce cas, cohérent avec le périmètre strict demandé.
- Le trigger de transition de statut ne contraint que la colonne `status` elle-même ; il ne verrouille pas les autres colonnes de `requests` contre une écriture par le chauffeur assigné (limitation préexistante à cette phase, non aggravée mais non corrigée non plus — signalée comme recommandation Phase 4).

## 12. Éléments à tester manuellement

Une fois les migrations `0008`-`0011` appliquées :
1. Course complète client/chauffeur avec échange de messages rapides et texte libre des deux côtés — vérifier l'absence de doublon et l'auto-scroll.
2. Couper la connexion réseau du navigateur pendant le chat, la rétablir — vérifier que les messages manqués apparaissent sans refresh manuel.
3. Tenter d'envoyer un message avec le champ vide (bouton doit rester désactivé) puis avec une connexion coupée (vérifier l'état d'échec + retry).
4. Faire progresser une course chauffeur jusqu'à "Intervention en cours" puis "Terminer" — vérifier l'affichage `StatusTracker` et le titre principal à chaque étape.
5. Rafraîchir le navigateur du client à chaque étape (recherche, offre, en route, arrivé, en cours) — vérifier la reprise exacte, y compris les messages déjà échangés.

## 13. Recommandations Phase 4

- Verrouiller au niveau colonne (via trigger, comme `guard_driver_privileged_fields`) les champs de `requests` qu'un chauffeur assigné ne devrait jamais pouvoir modifier autrement que `status` (ex. `price_estimate`, `lat`/`lng`), actuellement seulement protégés par convention côté app.
- Si le paiement (Stripe) est introduit, envisager d'ajouter une étape "reçu"/"facture" qui pourrait naturellement réutiliser le même modèle de message pour la confirmation post-paiement.
- Read receipts (`messages.read_at`) si le produit en a besoin — la colonne est déjà prête.
