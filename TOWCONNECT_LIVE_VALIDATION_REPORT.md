# TowConnect — Rapport de validation live (Phases 1 à 4)

Date : 2026-08-31
Aucune valeur de secret ne figure dans ce document — uniquement des noms de variables.

---

## Verdict

**READY FOR NEXT PHASE** — pour l'application. **Voir la mise à jour Phase 4.5 ci-dessous pour l'infrastructure.**

Les migrations `0005` → `0017` sont appliquées sur le projet Supabase `towconnect`, la suite RLS live passe intégralement (**78 assertions**), et le cœur transactionnel Stripe a été exercé de bout en bout en **mode sandbox** : autorisation, capture, refus, 3DS, annulation, idempotence webhook et reprise après refresh.

Quatre défauts réels ont été trouvés **par cette exécution live** — dont deux qui auraient cassé des parcours clients entiers en production — corrigés et re-vérifiés.

> ### ✅ Mise à jour Phase 4.5 (2026-09-01) — infrastructure en service
>
> Verdict infra : **PRODUCTION INFRA READY**. Les trois blockers (B1 Edge Functions, B4 webhook distant, B5 Mapbox) sont **levés et vérifiés en conditions live**, et le scheduler tourne.
>
> Ce que la version précédente de cet encadré annonçait comme « à faire » est fait : les deux Edge Functions sont redéployées et authentifient le scheduler par `x-cron-secret` ; elles sont vérifiées non pas sur un HTTP 200 mais sur leur **effet réel en base** (offre expirée → `timeout` → candidat suivant, sans aucun onglet ouvert). Le scheduler exécute les deux jobs chaque minute — `net._http_response` montre **10 réponses 200, aucun 401**.
>
> Le code des Phases 1 à 4.5 est commité et déployé, les variables d'environnement Vercel sont configurées, et le webhook Stripe sandbox pointe sur le déploiement réel : **Stripe → Vercel → base** est vérifié avec de vrais événements.
>
> Quatre défauts supplémentaires ont été trouvés **en validant**, dont un sérieux : le webhook enregistrait un challenge 3D Secure comme un paiement `failed`, écrasant le `requires_action` correct écrit par l'application — le client était informé d'un échec pendant que le challenge était encore à l'écran. Corrigé, testé unitairement et asserté contre l'endpoint déployé.
>
> Détail complet, preuves et ce qui reste : **`TOWCONNECT_PHASE4_5_REPORT.md`**.

---

## 1. Migrations réellement appliquées

État constaté avant intervention : `0001`-`0004` présentes, **`0005` à `0015` toutes absentes**. Base quasi vierge (1 compte auth, 0 requête) — sûr pour les tests.

Appliquées une par une via le SQL Editor, chacune vérifiée (`Success. No rows returned`) :

| Migration | Résultat |
|---|---|
| `0005_vehicles` | ✅ |
| `0006_smart_dispatch` | ✅ |
| `0007_dispatch_immediate_advance` | ✅ |
| `0008_messages` | ✅ |
| `0009_in_progress_status` | ✅ (exécutée **seule** — `ALTER TYPE ADD VALUE`) |
| `0010_request_status_guard` | ✅ |
| `0011_in_progress_active_job` | ✅ (confirmation « opérations destructives » : `drop index`/`drop policy` immédiatement recréés, aucune donnée touchée) |
| `0012_destination_and_pricing_snapshot` | ✅ |
| `0013_payments` | ✅ |
| `0014_request_field_lockdown` | ✅ |
| `0015_fix_nudge_dispatch_guard` | ✅ |
| **`0016_guard_driver_fields_service_role`** | ✅ **nouvelle** — voir §11 F1 |

Vérification finale : les 12 marqueurs d'objets (tables, triggers, fonctions, valeur d'enum, prédicat d'index) renvoient tous `true`.

## 2. Environnement Supabase validé

- Projet `towconnect` (`cnwkchbuuzfquxckfwdw`, ca-central-1, Postgres 17.6.1), branche `main`.
- `app/.env.local` renseigné avec les vraies valeurs : URL, clé anon, **clé service_role** (identité confirmée par décodage du claim `role` du JWT, jamais affichée).
- Les clés ont transité par le presse-papier du dashboard → `.env.local` sans passer par la conversation.
- `.gitignore` couvre `.env.local` **et** `Infos.txt` (vérifié via `git check-ignore`).

## 3. Tests RLS exécutés et résultats

`npm run test:integration` contre le projet réel : **73 assertions, 100 % au vert** (« All RLS invariants held »).

Couverture : requests, vehicles (+ unicité du véhicule principal), Smart Dispatch (meilleur candidat, exclusion offline/stale/occupé, accept/decline/timeout séquentiels, concurrence, offre expirée, offre dupliquée), `nudge_dispatch` (autorisation, no-op, avance), messages (isolation tiers, anti-usurpation, requête non attribuée, lecture admin), transitions de statut (chaîne valide, saut et retour arrière rejetés), verrouillage des champs `requests`, isolation `payments`, registre d'idempotence webhook, protection `stripe_customer_id`.

| Test | Résultat |
|---|---|
| `npx tsc --noEmit` | ✅ |
| `npm run lint` | ✅ 0 erreur, 0 warning |
| `npm run build` | ✅ |
| `npm run test` (vitest) | ✅ 27/27 |
| `npm run test:integration` | ✅ **73/73** |

## 4. Stripe test configuré

Compte **Sandbox** (`acct_1SdJAR2Qby3mUWv8`, bandeau « You're testing in a sandbox »). `STRIPE_SECRET_KEY` et `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (toutes deux `*_test_*`) écrites dans `.env.local`. Contrôle automatique : `livemode: false` sur chaque PaymentIntent, et une garde refuse toute clé `sk_live_`/`pk_live_`. **Aucun passage en live, aucune transaction réelle.**

## 5. Webhook configuré

Pas de Stripe CLI disponible, et Stripe ne peut pas atteindre `localhost`. Plutôt que d'installer un binaire, j'ai utilisé l'équivalent exact de `stripe listen` sans le tunnel : **récupérer les vrais objets `Event` générés par Stripe** pour nos PaymentIntents (`stripe.events.list`), puis les relayer vers `/api/stripe/webhook` signés avec un `STRIPE_WEBHOOK_SECRET` local généré aléatoirement. La vérification de signature étant du HMAC local, le chemin testé est identique à une livraison Stripe réelle.

## 6. Paiements testés

Parcours nominal complet dans l'app réelle (client dans un navigateur, chauffeur dans un autre) :

demande → estimation → confirmation → **autorisation** → dispatch → acceptation chauffeur → messagerie → en route → arrivé → intervention → **complétion** → **capture** → reçu.

| Vérification | Résultat |
|---|---|
| PaymentIntent créé | ✅ |
| `capture_method: manual` | ✅ |
| Statut `requires_capture` avant complétion, `amount_received: 0` | ✅ |
| Montant exact | ✅ `4898` puis `11441` = **exactement** `price_estimate` serveur |
| Capture après `completed` | ✅ `succeeded`, `amount_received: 11441` |
| `payments.status` : `authorized` → `captured` | ✅ |
| Une seule ligne `payments` / un seul PaymentIntent | ✅ pas de double paiement |
| Reçu visible | ✅ décomposition figée 45,00 + 69,41 = **114,41**, statut « Payé », référence `pi_…` non sensible |

Note : les deux courses ont des montants différents (48,98 puis 114,41) parce que le tableau de bord chauffeur, une fois ouvert, ping sa **vraie** géolocalisation toutes les 20 s — le chauffeur est passé de la position seedée à sa position réelle (30,85 km). Comportement correct, et cohérent dans les deux cas (`base 45 + distance × 2,25`).

## 7. 3DS testé

Carte `pm_card_authenticationRequired`. **Un défaut bloquant a été trouvé ici** (§11 F2). Après correction :

- `payments.status = requires_action` ✅ (au lieu de `failed`)
- `stripe_payment_intent_id` enregistré ✅ (au lieu de `null`)
- Le **challenge « 3D Secure 2 Test Page » de Stripe s'affiche** ✅
- **`dispatch offers: 0`** — aucun chauffeur envoyé tant que le paiement n'est pas résolu ✅

Non validé : le clic « COMPLETE » dans le challenge, l'iframe 3DS étant cross-origin et non pilotable depuis cette surface d'automatisation (même limite que le PaymentElement Stripe). Le tronçon post-challenge (`resumeAfterPaymentAction` → re-vérification serveur → dispatch) reste à confirmer manuellement — voir §15.

## 8. Paiement refusé testé

Carte `pm_card_chargeCustomerFail` :

- UI : « **Paiement refusé** — Vérifiez votre moyen de paiement puis réessayez — aucun remorqueur ne sera envoyé tant que ce n'est pas résolu. » Aucune erreur Stripe brute exposée ✅
- `payments.status = failed`, `failure_reason = card_declined` ✅
- **`dispatch offers: 0`** — invariant critique tenu ✅
- « Réessayer » avec une carte valide : autorisation à **`11439` = le snapshot serveur**, jamais un montant venu du navigateur ✅, et **une seule** autorisation capturable (pas de double blocage) ✅

## 9. Idempotence testée

Avec de **vrais événements Stripe** relayés vers l'endpoint local :

| Scénario | Résultat |
|---|---|
| Signature forgée | ✅ `400 Invalid signature` |
| Signature d'un autre secret | ✅ `400` |
| Corps altéré, signature bien formée | ✅ `400` |
| Livraison authentique | ✅ `200`, statut mis à jour |
| **Rejeu du même `event.id`** | ✅ `200 {deduplicated: true}`, **statut inchangé** (aucun retraitement) |
| Registre `stripe_webhook_events` | ✅ exactement 1 ligne |

Également : aucune double capture (garde `status !== 'authorized'` + `idempotencyKey` Stripe), aucun double PaymentIntent.

## 10. Reprise après refresh testée

Rechargement de `/request` pendant une course active : l'app restaure l'intervention depuis la base, y compris l'indice « Ça prend un peu plus de temps que prévu ». ✅

Ce test a révélé un écart (§11 F4), corrigé : une demande dont le paiement a échoué était restaurée en « Recherche… » alors qu'aucun dispatch n'aurait jamais lieu.

## 11. Problèmes trouvés

**F1 — 🔴 Le rôle service ne pouvait pas approuver un chauffeur.**
`guard_driver_privileged_fields()` (migration `0003`, antérieure à ces phases) décide « est-ce un admin ? » via `auth.uid()`, qui est `NULL` sous le rôle service — donc la seule identité qui agit légitimement comme le système était la seule à être bloquée. Invisible jusqu'ici car le flux admin de l'app tourne sous la session d'un utilisateur admin. Conséquence immédiate : le harnais RLS produisait des chauffeurs jamais approuvés ni en ligne, et **~12 assertions Smart Dispatch échouaient en cascade** pour ce qui ressemblait à des bugs de dispatch.

**F2 — 🔴 Toute carte exigeant le 3DS était traitée comme un refus définitif.**
Sur un `confirm` off-session, Stripe lève `authentication_required` mais laisse le PaymentIntent à `payment_intent.status = 'requires_payment_method'` — **pas** `'requires_action'`. Le test du catch ne matchait donc jamais. En production : tout client dont la banque impose l'authentification forte (SCA) voyait « Paiement refusé » et **ne pouvait jamais commander**, y compris en réessayant.

**F3 — 🟠 L'annulation ne libérait pas les fonds autorisés.**
`cancelRequest` passait la course à `cancelled` mais laissait le PaymentIntent à `requires_capture` : la carte du client restait bloquée (114,39 $ constatés) jusqu'à l'expiration Stripe (plusieurs jours), et la ligne `payments` restait `authorized` sans jamais se réconcilier.

**F4 — 🟠 Reprise trompeuse après un échec de paiement.**
Une demande au paiement non résolu reste `pending`, donc « active » : au rechargement, le client atterrissait sur « Recherche du meilleur remorqueur… » — pour une course où le dispatch n'a jamais démarré et ne démarrera jamais. Attente infinie, aucune action possible.

**F5 — 🟠 `.env.local` corrompu par un BOM.** `Set-Content -Encoding UTF8` (PowerShell 5.1) écrit un BOM ; la première variable devenait invisible au parsing — cela aurait aussi cassé l'app.

**F6 — 🟠 `npm run test:integration` ne lisait jamais les variables.** Le script faisait `import 'dotenv/config'`, qui ne lit que `.env`, alors que les credentials vivent dans `.env.local`.

**F7 — 🟡 Défauts du harnais de test** (révélés par la première exécution réelle) : pas de gestion de la limite de débit auth ; absence d'isolation entre blocs (les chauffeurs d'un bloc restaient candidats pour les suivants) ; assertions au mauvais niveau (auto-primary est applicatif, pas DB) ; contrainte d'offre dupliquée testée *après* acceptation ; `NULL` composite renvoyé par PostgREST comme ligne de `NULL` ; messages d'échec affichés à côté des ✓.

## 12. Corrections effectuées

| # | Correction |
|---|---|
| F1 | **`0016_guard_driver_fields_service_role.sql`** — exempte `auth.role() = 'service_role'`, alignant `0003` sur le motif déjà utilisé par `0013` et `0014`. Non affaiblissant : la clé service est server-only et contourne déjà RLS. |
| F2 | `authorizeRequestPayment` détecte désormais `code === 'authentication_required'` (et non le seul statut du PI), enregistre le PI, et renvoie `clientSecret` + `paymentMethodId` — ce dernier nécessaire car le PI retombe à `requires_payment_method` et la reprise on-session doit renommer la carte. Plomberie ajoutée dans `CreateRequestResult`, `RequestFlow` et `StepPayment`. |
| F3 | Nouveau `cancelRequestPayment()` (annule le PI **non capturé** uniquement — un paiement déjà capturé exige un remboursement, hors périmètre) branché dans `cancelRequest`, en best-effort pour ne jamais empêcher une annulation. |
| F4 | `request/page.tsx` charge le paiement de la course reprise ; si son statut est non résolu **et** que la course est encore `pending` sans chauffeur, `RequestFlow` démarre sur l'étape paiement (réessayer / annuler) au lieu du suivi. |
| F5 | `.env.local` réécrit en UTF-8 sans BOM. |
| F6 | Le script charge `.env.local` puis `.env`. |
| F7 | Harnais durci : attente/reprise sur limite de débit ; `retirePreviousDrivers()` met hors ligne **tous** les chauffeurs avant chaque bloc de dispatch ; échec bruyant si l'approbation d'un chauffeur de test échoue ; assertions recadrées sur la bonne couche ; contrainte d'offre dupliquée testée avec une offre réellement en cours ; helper `noOfferMade()` ; `detail` affiché uniquement sur échec. |

Également : `Infos.txt` ajouté à `.gitignore` (fichier conservé), et **limite de débit auth restaurée à 30** après l'avoir montée temporairement à 300 pour la suite de tests.

## 13. Vérification sécurité

| Contrôle | Résultat |
|---|---|
| Aucun secret dans le diff / fichiers non suivis | ✅ (seul « match » : ce rapport décrivant les motifs de recherche) |
| Aucune clé Stripe dans le bundle client | ✅ build avec valeurs sentinelles : 0 occurrence de la clé secrète / service-role / webhook ; la clé **publiable** y apparaît bien (contrôle positif) |
| Service-role côté serveur uniquement | ✅ `server-only`, importé seulement par la route webhook et les actions `'use server'` |
| Client ne peut pas modifier `payment_status` | ✅ testé live |
| Chauffeur ne voit pas les données de paiement | ✅ testé live |
| Montant navigateur ignoré / prix = snapshot serveur | ✅ testé live (création **et** reprise) |
| Webhook invalide rejeté | ✅ 3 variantes testées |
| Chauffeur ne peut modifier les champs protégés | ✅ 5 champs testés live |
| Aucun dispatch sans paiement autorisé | ✅ testé sur refus **et** 3DS |
| `.env.local` / `Infos.txt` ignorés par Git | ✅ |
| Stripe strictement en sandbox | ✅ `livemode: false` |

## 14. Blockers restants

**B1, B4 et B5 sont levés en Phase 4.5.** Ce qui reste :

- **B1 — Edge Functions.** ✅ *Levé en Phase 4.5.* Redéployées avec l'authentification `x-cron-secret`, planifiées chaque minute, et vérifiées sur leur **effet en base** — pas seulement sur un HTTP 200. `npm run verify:functions` (17/17) et `npm run verify:scheduler` le rejouent à volonté.
- **B2 — Décision business : taux de commission.** Toujours ouvert. `commission_amount`/`partner_amount` restent `NULL`, volontairement.
- **B3 — Sécurité, à faire de votre côté.** Toujours ouvert, et c'est le point le plus urgent. Les identifiants en clair d'`Infos.txt` (mot de passe Postgres, token Mapbox) devraient être **rotés** : le fichier est hors de Git, mais il est sur le disque et a traversé plusieurs sessions.
- **B4 — Webhook de production.** ✅ *Levé en Phase 4.5.* Le code des Phases 1-4.5 est déployé, l'endpoint sandbox pointe dessus, et le trajet **Stripe → Vercel → base** est vérifié avec de vrais événements (`npm run verify:webhook`, 7/7).
- **B5 — `NEXT_PUBLIC_MAPBOX_TOKEN`.** ✅ *Levé en Phase 4.5.* Token récupéré depuis Vercel (jamais depuis `Infos.txt`) ; le géocodage fonctionne sur le déploiement et une course de remorquage complète avec destination a été exercée de bout en bout.

## 15. Éléments à tester manuellement

1. **Compléter un challenge 3DS** en cliquant « COMPLETE » : la seule action restant à un humain — l'iframe Stripe n'accepte pas de clic automatisé. **Non bloquant** : l'affichage du challenge, l'invariant « aucune offre de dispatch tant que le paiement n'est pas résolu » et le traitement webhook du cas SCA sont tous vérifiés en Phase 4.5.
2. ~~Course avec destination~~ — ✅ fait en Phase 4.5 : `tow_distance_km = 1.57`, prix serveur 49,50 $ = montant Stripe au cent près, reçu affichant destination **et** distance.
3. ~~Webhook livré par Stripe après déploiement~~ — ✅ fait en Phase 4.5.

### Données de test

Les comptes jetables créés pendant la Phase 4.5 ont été **supprimés**, avec leurs courses, offres et paiements, et toute autorisation Stripe encore ouverte a été annulée. État final vérifié : **0 chauffeur en ligne, 0 course en attente, 0 offre ouverte**.

Les données antérieures (comptes `…@towconnect-test.local` et leurs courses) sont **laissées intactes** : elles ne sont pas les miennes à supprimer. Pour les retirer, supprimer les deux comptes dans **Authentication → Users** suffit — tout le reste part en cascade, sauf `stripe_webhook_events`.

## 16. Limitations connues (non bloquantes)

- Le nudge client de la Phase 2.5 est **throttlé par le navigateur quand l'onglet est en arrière-plan** — constaté en live. Le cron `dispatch-tick` est précisément le filet prévu pour ce cas, et il est désormais réellement opérationnel (Phase 4.5).
- ~~`respond_to_dispatch_offer` marque l'offre `timeout` puis lève une exception qui annule cette écriture~~ — corrigé par la migration `0017` : l'écriture systématiquement annulée est retirée, et `acceptRequest()` déclenche immédiatement `nudge_dispatch()` dans une transaction séparée, de sorte que l'offre périmée est réellement soldée.
- ~~L'estimation s'appuie sur `nearby_drivers()`, qui ne filtre pas sur la fraîcheur du heartbeat alors que le dispatch le fait~~ — corrigé par la migration `0017` : la règle est remontée dans `nearby_drivers()` elle-même, point de passage unique de l'estimation, du prix serveur et de la recherche de candidat. Vérifié en live pendant la Phase 4.5 : un chauffeur au heartbeat périmé fait basculer le flow sur « aucun remorqueur disponible » au lieu de produire un prix invalide.
- Le remboursement d'un paiement **déjà capturé** n'est pas implémenté (recommandation Phase 5).
