# TowConnect — Phase 4 Report — Cœur transactionnel (destination, pricing, Stripe, reçu)

Date : 2026-08-31

## 1. Modèle destination

Audit des types de service existants (`PROBLEM_TYPES`) : aucun n'était explicitement "remorquage", mais deux impliquent réellement qu'un véhicule doive être déplacé — `mechanical` (panne non réparable sur place) et `accident` (véhicule généralement non conduisible). Les autres (`battery`, `out_of_gas`, `lockout`, `flat_tire`, `stuck_snow`, `other`) correspondent aux services sur place nommés explicitement dans le brief. Chaque entrée de `PROBLEM_TYPES` porte désormais un flag `requiresDestination: boolean` (`problemRequiresDestination()`), testé unitairement — aucune logique de nom de service inventée.

`requests` gagne `destination_address`, `destination_lat`, `destination_lng` (nullable, remplis uniquement pour les services concernés) et `tow_distance_km` (calculé, jamais saisi). L'étape destination n'apparaît dans `StepForm` que si le type de panne le requiert — aucune étape morte affichée pour les autres cas.

## 2. Pricing

`pricing.ts` conservé : `estimatePrice()` inchangé (mêmes tests, même comportement). Ajout additif de `estimatePriceBreakdown()` qui décompose base/distance/supplément et facture la distance de remorquage (pickup → destination) au **même taux au km** que la distance d'approche du chauffeur — un choix simple et documenté (pas deux tarifs différents), à revisiter si le business le souhaite plus tard.

**Correctif de confiance critique** : avant cette phase, `createRequest()` acceptait un prix calculé **côté client** (`StepEstimate`) et le stockait tel quel — un navigateur manipulé aurait pu envoyer n'importe quel montant. Le prix autoritaire est désormais **recalculé côté serveur** dans `createRequest()` : nouvel appel à `nearby_drivers()` (même source PostGIS fiable que Smart Dispatch) + `estimatePriceBreakdown()`, exécutés dans l'action serveur. L'estimation affichée avant confirmation reste un aperçu côté client (même formule, pour la réactivité UX) mais n'est **jamais** ce qui est facturé.

## 3. Protections DB ajoutées

- `0014_request_field_lockdown.sql` : un remorqueur assigné ne peut modifier que `status` sur sa course. Prix, destination, pickup, véhicule, `user_id`, `driver_id` sont bloqués par un trigger serveur (`guard_request_protected_fields`), avec l'échappatoire `towconnect.internal_update` déjà utilisée en 0003/0007 pour les écritures internes légitimes (ex. `respond_to_dispatch_offer()` effaçant `driver_id` lors d'un refus).
- `0013_payments.sql` : `payments` n'a **aucune** policy INSERT/UPDATE pour `authenticated` — toute écriture passe par le client service-role (`lib/supabase/admin.ts`), utilisé uniquement après une réponse Stripe réelle vérifiée.
- `profiles.stripe_customer_id` verrouillé par trigger (`guard_stripe_customer_id`) — un utilisateur ne peut pas pointer son compte vers l'identité Stripe de quelqu'un d'autre.

## 4. Architecture Stripe

- `stripe` (SDK serveur), `@stripe/stripe-js` + `@stripe/react-stripe-js` (client), `server-only` installés.
- `lib/stripe/server.ts` / `lib/stripe/client.ts` : mêmes patrons "optionnel tant que non configuré" que `NEXT_PUBLIC_MAPBOX_TOKEN` — `getStripe()` lève une erreur claire seulement si réellement appelé sans clé ; le build et toutes les autres fonctionnalités marchent sans aucune clé Stripe.
- `lib/supabase/admin.ts` : client Supabase service-role, réservé au code serveur de paiement, jamais importable côté client (`server-only`).
- Un `stripe_customer_id` persistant par compte (`ensureStripeCustomer()`), jamais l'email seul. Aucun numéro de carte/CVC ne transite ni ne se stocke côté TowConnect — uniquement via `PaymentElement`/`SetupIntent` de Stripe.

## 5. Stratégie authorization/capture

**Autoriser à la confirmation, capturer à la complétion** — modèle marketplace standard (Uber/Lyft-like), choisi explicitement selon la préférence produit du brief :
1. À la confirmation (`createRequest`), un `PaymentIntent` `capture_method: 'manual'` est créé et confirmé avec la carte par défaut du client (`authorizeRequestPayment`). Succès → dispatch démarre. Échec/`requires_action` → dispatch **ne démarre pas** tant que le paiement n'est pas résolu (nouvel écran `StepPayment`).
2. À la complétion (`advanceRequestStatus(..., 'completed')`), le `PaymentIntent` est capturé (`captureRequestPayment`) — jamais avant, jamais aveuglément. Le statut opérationnel et le paiement restent découplés : un souci de paiement ne bloque jamais le chauffeur qui a fini son travail.
3. Un défi 3DS (`requires_action`) est résolu côté client via `stripe.confirmCardPayment`, puis re-vérifié **côté serveur** (`resumeAfterPaymentAction` → `finalizeAuthorization`, qui interroge Stripe directement) avant de lancer le dispatch — jamais sur la seule foi d'un callback navigateur "succès".

## 6. Modèle de paiement

Table `payments`, distincte de `requests.status` (statut opérationnel) — `payment_status` : `requires_payment_method → requires_action → authorized → captured`, ou `failed`/`canceled`/`refunded`. Une ligne par tentative ; `stripe_payment_intent_id` unique (idempotence). Le montant est toujours celui de `requests.price_estimate` au moment de l'appel serveur — jamais un nombre venu du navigateur, y compris au retry (`retryRequestPayment` ne prend plus de paramètre `amount`).

## 7. Webhook

`POST /api/stripe/webhook` : signature vérifiée (`stripe.webhooks.constructEvent`), rejet immédiat si invalide/absente. Idempotence via `stripe_webhook_events` (contrainte unique sur `stripe_event_id`) — un événement déjà vu est ignoré (retour 200 sans retraitement). Gère `payment_intent.amount_capturable_updated`/`.processing` (→ `authorized`), `.succeeded` (→ `captured`), `.payment_failed` (→ `failed`), `.canceled` (→ `canceled`), `charge.refunded` (→ `refunded`). Stripe reste la source de vérité : les mises à jour optimistes faites par `payments.ts` juste après un appel Stripe sont toujours écrasées/confirmées par l'événement webhook correspondant.

## 8. Reçu / historique

`/history` (liste des interventions `completed` du client) → `/history/[id]` (reçu : service, date, départ, destination si applicable, chauffeur si connu, décomposition du prix figé, statut de paiement, référence de transaction non sensible — l'id du `PaymentIntent`, jamais de données de carte). `StepTracking` affiche un bouton "Reçu" une fois la course `completed`. Pas de PDF cette phase, page numérique uniquement, comme demandé.

## 9. Commission / payout : préparé vs actif

**Préparé, non activé** : `requests.commission_amount`/`partner_amount` et `payments.commission_amount`/`partner_amount` existent, nullable, jamais calculés — choisir un taux de commission est une décision business, pas technique, et le brief interdit explicitement d'en inventer un. Documenté en commentaire SQL directement sur les colonnes.

**Stripe Connect : non implémenté, délibérément.** Aucun compte connecté, aucun transfert. Justification : (a) le rôle Business/partenaire n'existe pas encore dans le modèle de données (pas de notion d'entreprise de remorquage, seulement des `driver_profiles` individuels) — construire des payouts Connect sans destinataire structuré aurait été fabriquer un faux système de versement ; (b) aucun taux de commission n'est décidé, donc aucun montant de transfert ne serait calculable de toute façon. La table `payments` est structurée pour accueillir cette logique plus tard (colonnes déjà présentes) sans nouvelle migration de schéma majeure.

## 10. Sécurité

- Champs protégés d'une request : verrouillés côté DB (trigger), pas seulement côté UI.
- `payments` : aucune policy write pour `authenticated` — un client ne peut structurellement pas marquer son propre paiement payé.
- Le chauffeur n'a **aucune** policy sur `payments` — ne voit jamais les données de paiement du client.
- `stripe_customer_id` verrouillé par trigger.
- Webhook : signature vérifiée, événement dupliqué rejeté par contrainte unique.
- Montant facturé toujours recalculé/lu côté serveur (création et retry) — jamais un nombre du navigateur.

## 11. Tests

| Test | Résultat |
|---|---|
| `npx tsc --noEmit` | ✅ 0 erreur |
| `npm run lint` | ✅ 0 erreur, 0 warning |
| `npm run build` (production, **sans clés Stripe**) | ✅ compile, toutes les routes générées y compris `/api/stripe/webhook`, `/payment-methods`, `/history` |
| `npm run test` (vitest) | ✅ 22/22 (14 pricing existants + 4 nouveaux `estimatePriceBreakdown` + 4 nouveaux `problemRequiresDestination`) |

Scénarios ajoutés dans `scripts/rls-integration-test.ts` : verrouillage des champs (prix/destination/pickup/véhicule/`user_id` rejetés, `status` toujours permis), isolation `payments` (propriétaire lit, autre client ne lit pas, chauffeur assigné ne lit pas), un client ne peut pas s'auto-marquer "payé" ni insérer directement une ligne `payments`, idempotence du journal webhook (même `stripe_event_id` rejeté deux fois), verrouillage de `stripe_customer_id`.

## 12. Tests non exécutés

- **Toute la Phase 4 (migrations 0012-0014, tests RLS)** : `.env.local` ne contient pas `SUPABASE_SERVICE_ROLE_KEY`, aucun `supabase` CLI local — même limitation documentée depuis la Phase 1. Non contourné.
- **Tout appel Stripe réel** : `STRIPE_SECRET_KEY` absent dans cet environnement. Le code d'intégration (autorisation, capture, webhook, SetupIntent) n'a **jamais été exécuté contre l'API Stripe réelle** — seule sa cohérence de compilation/type est vérifiée. Les tests RLS de `payments` contournent volontairement Stripe (le service-role fabrique directement des lignes `payments`), donc n'exercent pas le SDK Stripe lui-même.

## 13. Limitations connues

- Prix de remorquage : un seul taux au km pour l'approche et le remorquage — pourrait diverger si le business le souhaite.
- Pas de vérification manuelle possible du flux 3DS/webhook réel sans clés Stripe de test.
- Commission/payout : schéma prêt, logique de calcul et Stripe Connect explicitement non construits (voir §9).
- Le verrouillage de champs (0014) ne couvre que `requests` — pas de nouvelle revue des autres tables cette phase.
- Historique/reçu limité aux interventions `completed` — pas d'écran pour une intervention annulée avec paiement partiellement traité (edge case rare, non géré spécifiquement).

## 14. Variables/env manquantes

`STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` — toutes documentées (placeholders vides, aucune valeur) dans `.env.local.example`. Aucun secret n'a été inventé ni ajouté au dépôt.

## 15. Étapes manuelles nécessaires

1. Appliquer les migrations `0012` à `0014` (SQL Editor Supabase, dans l'ordre) sur un projet réel.
2. Créer un compte Stripe (mode test), configurer les clés + le webhook (`README.md` §5).
3. Renseigner `.env.local` avec les vraies valeurs (jamais commit).
4. Exécuter `npm run test:integration` avec un `SUPABASE_SERVICE_ROLE_KEY` jetable pour valider les invariants RLS de cette phase.
5. Tester manuellement un paiement de bout en bout avec une carte de test Stripe (`4242 4242 4242 4242`) et une carte déclenchant 3DS (`4000 0027 6000 3184`) une fois les clés en place.
6. Décider du taux de commission TowConnect avant d'activer `commission_amount`/`partner_amount` (décision business, hors code).

## 16. Recommandations Phase 5

- Une fois un taux de commission décidé : calculer/persister `commission_amount`/`partner_amount` à la capture (petit ajout, schéma déjà prêt).
- Rôle Business + Stripe Connect (Express) pour verser réellement les partenaires, seulement une fois le rôle Business construit.
- Remboursements (`stripe.refunds.create`) et annulation avec remboursement partiel si une course payée est annulée après capture — non couvert cette phase.
- Reçu téléchargeable (PDF) si le produit en a besoin.
