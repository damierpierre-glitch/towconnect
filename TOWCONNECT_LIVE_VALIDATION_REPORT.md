# TowConnect — Rapport de validation live (Phases 1 à 4)

Date : 2026-08-31
Aucune valeur de secret ne figure dans ce document — uniquement des noms de variables.

---

## Verdict

**READY FOR NEXT PHASE** — pour l'application. **Voir la mise à jour Phase 4.5 ci-dessous pour l'infrastructure.**

Les migrations `0005` → `0017` sont appliquées sur le projet Supabase `towconnect`, la suite RLS live passe intégralement (**78 assertions**), et le cœur transactionnel Stripe a été exercé de bout en bout en **mode sandbox** : autorisation, capture, refus, 3DS, annulation, idempotence webhook et reprise après refresh.

Quatre défauts réels ont été trouvés **par cette exécution live** — dont deux qui auraient cassé des parcours clients entiers en production — corrigés et re-vérifiés.

> ### ⚠️ Mise à jour Phase 4.5 (2026-08-31)
>
> La mise en service de l'infrastructure a été tentée et a **échoué à lever les blockers B1, B4 et B5** — verdict **NOT READY** côté infra. Elle a par ailleurs révélé un défaut plus grave que ceux visés :
>
> **Les deux Edge Functions rejettent tout appelant (401), y compris avec la clé service_role.** `cleanup-stale` était déployée depuis un jour et n'aurait rien fait à chaque exécution planifiée : le « filet de sécurité » décrit dans le rapport Phase 2.5 n'a jamais été opérationnel. Cause : elles s'authentifiaient contre `SUPABASE_SERVICE_ROLE_KEY`, que Supabase marque désormais **DEPRECATED**. Correctif écrit et secrets configurés ; **déploiement final restant à faire**.
>
> Deux corrections applicatives ont en revanche été menées à terme et vérifiées (migration `0017`) : cohérence estimation/dispatch, et suppression d'une écriture systématiquement annulée par rollback.
>
> Détail complet, actions restantes et commandes : **`TOWCONNECT_PHASE4_5_REPORT.md`**.

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

Aucun bloquant technique pour la suite. Restent :

- **B1 — Edge Functions.** ⚠️ *Mis à jour en Phase 4.5* : les deux sont désormais **déployées**, mais **non fonctionnelles** — elles rejettent tout appelant (401). Correctif écrit, secrets créés, déploiement final restant. Le filet de sécurité des timeouts n'existe donc toujours pas côté serveur ; le chemin principal (refus immédiat + nudge client) fonctionne. Voir `TOWCONNECT_PHASE4_5_REPORT.md` §1 et §10.
- **B2 — Décision business : taux de commission.** `commission_amount`/`partner_amount` restent `NULL`, volontairement.
- **B3 — Sécurité, à faire de votre côté.** Les identifiants en clair de `Infos.txt` (mot de passe Supabase, token Mapbox) devraient être **rotés** — ils ont traversé plusieurs sessions sur disque. Action sur vos comptes.
- **B4 — Webhook de production.** ⚠️ *Précisé en Phase 4.5* : le déploiement Vercel `towconnect-chi.vercel.app` **précède tout le travail des Phases 1-4**, qui est encore non commité — la route `/api/stripe/webhook` n'existe donc pas en ligne. Configurer l'endpoint suppose d'abord de décider du déploiement (push sur `main` + secrets de production).
- **B5 — `NEXT_PUBLIC_MAPBOX_TOKEN` vide.** ⚠️ *Toujours ouvert après Phase 4.5* : le token existe dans Vercel mais n'a pas pu être extrait (les boutons « Copy » n'écrivent pas dans le presse-papier depuis l'automatisation ; absent du bundle public car `/request` est derrière authentification ; `Infos.txt` non utilisé). La logique conditionnelle de destination reste validée, mais le géocodage — donc une course de remorquage complète avec destination — n'a pas pu être exercé.

## 15. Éléments à tester manuellement

1. **Compléter un challenge 3DS** (carte `4000 0027 6000 3184`) en cliquant « COMPLETE » : vérifier que `resumeAfterPaymentAction` re-vérifie côté serveur puis que le dispatch démarre. Comptes de test disponibles : `e2e-rider@towconnect-test.local` / `e2e-driver@towconnect-test.local`.
2. **Course avec destination** une fois le token Mapbox renseigné : vérifier `tow_distance_km` et la ligne « Distance » du reçu.
3. **Webhook livré par Stripe** après déploiement (vs. relais local).

### Données de test laissées en place

2 comptes `…@towconnect-test.local`, 5 courses (1 complétée + 4 annulées), 1 véhicule, 6 lignes `payments`, 4 événements webhook. Conservés **volontairement** pour permettre le point 1 ci-dessus. Pour les supprimer, il suffit de supprimer les deux comptes dans **Authentication → Users** : tout le reste disparaît en cascade (sauf `stripe_webhook_events`).

## 16. Limitations connues (non bloquantes)

- Le nudge client de la Phase 2.5 est **throttlé par le navigateur quand l'onglet est en arrière-plan** — constaté en live. Le cron `dispatch-tick` (B1) est précisément le filet prévu pour ce cas.
- `respond_to_dispatch_offer` marque l'offre `timeout` **puis** lève une exception sur une offre expirée : le `raise` annule cette écriture, l'offre reste donc `offered` jusqu'au balayage suivant. Sans conséquence (l'acceptation est bien refusée), mais le commentaire de `0007` laisse croire l'inverse.
- L'estimation affichée s'appuie sur `nearby_drivers()`, qui **ne filtre pas** sur la fraîcheur du heartbeat, alors que le dispatch le fait (2 min). Un prix peut donc être calculé à partir d'un chauffeur auquel le dispatch refusera ensuite d'offrir la course — constaté en live.
- Le remboursement d'un paiement **déjà capturé** n'est pas implémenté (recommandation Phase 5).
