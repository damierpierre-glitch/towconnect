# TowConnect — Phase 7.1 Report
## Validation financière end-to-end en sandbox Stripe

**Date :** 2026-09-02
**Portée :** exécuter réellement la chaîne financière Phase 7 — autorisation, gel, encaissement, grand livre, suppléments, remboursements, annulations, versements, permissions — puis réconcilier au cent près.
**Statut Stripe :** **sandbox uniquement.** Clé `sk_test_`. Aucune transaction réelle, aucune clé live.

---

## 0. Résultat en une ligne

**97 assertions exécutées réellement, 0 échec, 1 action humaine restante.**

Ce que cette phase a produit de plus utile n'est pas une case verte : ce sont **deux défauts financiers réels** qu'aucun test unitaire ni vérification de schéma ne pouvait attraper, parce que les deux exigent le vrai timing de Stripe et un vrai cycle de vie d'entreprise pour apparaître.

---

## 1. Comment la validation a été faite

### 1.1 Le harnais exécute le vrai code applicatif

`app/scripts/finance-e2e.ts` **importe et appelle les vraies server actions** — `createRequest`, `acceptRequest`, `advanceRequestStatus`, `proposeSupplement`, `respondToSupplement`, `issueRefund`, `preparePayout`, `startConnectOnboarding` — en agissant successivement comme six utilisateurs réellement inscrits et connectés.

Trois modules propres à Next sont remplacés via `tsconfig.e2e.json` :

| Module | Remplacé par | Pourquoi |
| --- | --- | --- |
| `server-only` | module vide | protection de build (empêcher le code serveur d'atteindre un bundle client) — sans objet dans un script Node, et elle empêcherait le harnais de tester le code même |
| `next/cache` | enregistreur d'appels | il n'y a pas de cache à revalider ici |
| `@/lib/supabase/server` | client construit à partir du jeton d'accès de l'acteur courant | il n'existe pas de requête Next d'où lire des cookies |

**Seul le transport change.** Chaque action tourne comme un utilisateur authentifié réel contre la vraie base : les policies RLS, les gardes `SECURITY DEFINER` et les triggers se déclenchent exactement comme en production. Une action refusée dans l'application est refusée ici — c'est précisément ce que démontre la section Permissions.

### 1.2 Ce qui est réel dans ce run

* de vraies cartes autorisées, encaissées et remboursées chez Stripe (mode test) ;
* de vrais PaymentIntents, avec leurs `status` relus **chez Stripe**, pas chez nous ;
* de vraies sessions Supabase (jetons d'accès obtenus par `signInWithPassword`) ;
* de vrais webhooks livrés par Stripe à l'endpoint déployé pendant le run ;
* un rejeu de webhook **signé correctement** contre la vraie route `/api/stripe/webhook`.

### 1.3 Ce qui a été fait par API plutôt que par l'interface

L'enregistrement de la carte du client passe normalement par Stripe Elements, une iframe. Le coffre-fort est celui de **Stripe**, pas le nôtre : le harnais attache un `pm_card_visa` de test via l'API Stripe et écrit `profiles.stripe_customer_id`, ce qui aboutit exactement au même état « carte enregistrée » que l'application produirait. Aucun numéro de carte ne transite par TowConnect, ni dans l'application ni ici.

---

## 2. Résultat par scénario

| § | Scénario | Statut | Preuve Stripe | Preuve DB |
| --- | --- | --- | --- | --- |
| 1 | Configuration économique temporaire (fixture) | **Exécuté** | — | brouillon créé, activé, `pricing_configured()` → `true`, 2+ lignes d'audit |
| 2 | Stripe Connect Express | **Non exécutable** | `accounts.create` refusé : *« You can only create new accounts if you've signed up for Connect »* | aucune — voir §6 |
| 3 | Course avec économie réelle | **Exécuté** | PaymentIntent `requires_capture`, montant 4500 | `partner_amount` 36,90 $ · `commission_amount` 6,49 $ · `payment_processing_cost` 1,61 $ · `pricing_config_id`/`version` · `economics_frozen_at` |
| 4 | Immutabilité du prix partenaire | **Exécuté** | — | v2 à 40 % activée puis désactivée : la course reste à 36,90 $ et pointe toujours v1 |
| 5 | Complétion + capture + ledger | **Exécuté** | PaymentIntent `succeeded` | 1 seule écriture `earning` = 36,90 $, `available_at` renseigné ; rejeu → toujours 1 |
| 6 | Supplément | **Exécuté (chemin B)** | `incrementAuthorization` refusé par Stripe | `payment_state = uncollected` avec la raison ; **aucune** écriture ledger |
| 7 | Remboursement partiel | **Exécuté** | Refund Stripe 1800 | ligne `refunds` `succeeded` ; 1 écriture `refund_reversal` = −14,76 $ ; paiement reste `captured` |
| 7b | Rejeu webhook / idempotence | **Exécuté** | événement `charge.refunded` réel relu chez Stripe | 1ʳᵉ livraison acceptée, 2ᵉ `deduplicated` ; aucune écriture en double |
| 8 | Remboursement total | **Exécuté** | Refund Stripe 4500 | paiement `refunded` ; net partenaire 0,00 $ |
| 9 | Annulation avant / après matching | **Exécuté** | PaymentIntents `canceled` | avant : 0/0 **décidés** ; après : `NULL` (aucune politique) ; aucune écriture ledger |
| 10 | Versement | **Exécuté (préparation seule)** | aucun appel Stripe — voir §5 | ligne `pending`, écriture ledger −22,14 $, solde disponible → 0, second versement refusé |
| 11 | Permissions (6 rôles) | **Exécuté** | — | 13 assertions, toutes vertes |
| 12 | Réconciliation | **Exécuté** | — | dérive maximale **0,0000 $** |
| 13 | Injection de fautes | **Exécuté** | clé live / non classifiable refusées avant tout appel | 8 assertions |
| 14 | Nettoyage | **Exécuté** | autorisations ouvertes annulées | `pricing_configured()` → `false`, 0 fixture restante |

---

## 3. Les deux défauts trouvés — et corrigés

### 3.1 Un webhook tardif « dé-encaissait » un paiement encaissé

**Observé.** Premier run : Stripe disait `succeeded`, notre ligne `payments` disait `authorized`. La capture avait pourtant réussi.

**Cause.** Stripe ne garantit pas l'ordre de livraison. `payment_intent.amount_capturable_updated` est arrivé **après** que la capture ait abouti, et le handler écrivait `'authorized'` sans regarder l'état courant. Un paiement encaissé redevenait « autorisé » — c'est-à-dire, pour le support et pour la comptabilité, de l'argent encore dû.

**Correctif.** L'écriture est rendue monotone : un signal d'autorisation ne s'applique plus que tant que le paiement est encore pré-capture.

```
.eq('stripe_payment_intent_id', intent.id)
.in('status', ['requires_payment_method', 'requires_action', 'authorized']);
```

**Vérification.** Le run suivant : *« ✓ our payments row settles on captured »*, avec la ligne relue en boucle plutôt qu'une seule fois, et la liste des événements réellement livrés imprimée comme preuve.

### 3.2 Une entreprise ayant reçu un versement ne pouvait plus jamais être supprimée

**Observé.** Le nettoyage du harnais échouait ; deux entreprises fixtures restaient en base, impossibles à supprimer.

**Cause.** Trois clés étrangères formaient un cycle que rien ne pouvait rompre :

```
provider_payouts.company_id        -> companies          ON DELETE RESTRICT
provider_ledger_entries.company_id -> companies          ON DELETE CASCADE
provider_ledger_entries.payout_id  -> provider_payouts   ON DELETE RESTRICT
```

et le trigger append-only du grand livre refuse tout `DELETE` direct. L'entreprise était bloquée par son versement, le versement par son écriture, et l'écriture ne pouvait sortir que par la cascade de l'entreprise — bloquée. **Une entreprise ayant reçu un seul versement était permanente.**

C'est exactement la même erreur que la première version de 0035, une table plus loin : une règle d'immuabilité écrite sans se demander comment la ligne sort légitimement.

**Correctif — migration 0040.** Les versements cascadent avec leur entreprise ; la référence au versement passe de `RESTRICT` à `NO ACTION`, ce qui refuse toujours la suppression isolée d'un versement qui orphelinerait une écriture, mais laisse la cascade de l'entreprise faire son travail dans la même instruction.

**Vérification.** `verify:phase7` (24/24) inclut « deleting a company cascades its ledger away » ; le run 7.1 supprime désormais ses entreprises fixtures sans résidu.

---

## 4. Une limite confirmée, et pourquoi elle n'a pas été « corrigée »

### L'autorisation incrémentale n'est pas disponible sur ce compte Stripe

Le chemin A du §6 (augmenter l'empreinte existante pour couvrir un supplément approuvé) exige que `request_incremental_authorization` soit demandé **à la création** du PaymentIntent. Le harnais a donc essayé de l'ajouter.

Stripe a refusé **la création du paiement elle-même** :

> This account is not eligible for the requested card features.

Demander cette option ne se dégrade pas gracieusement : elle casse **toutes** les autorisations sur ce compte. L'option a donc été retirée, et le code porte maintenant l'explication et la preuve à l'endroit exact où quelqu'un se posera la question.

**Conséquence, énoncée plutôt que masquée :** un supplément approuvé prend systématiquement le chemin `uncollected`, avec la raison de Stripe enregistrée, et **le partenaire n'est crédité de rien**. C'est le comportement sûr — mais cela veut dire que, en l'état, un supplément approuvé par le client n'est jamais encaissé. Le collecter demanderait une charge séparée, que Phase 7 n'a pas construite.

---

## 5. `payout prepared internally` ≠ `payout executed by Stripe`

La distinction demandée, sans ambiguïté :

| | |
| --- | --- |
| **Ce qui est implémenté** | `preparePayout()` écrit une ligne `provider_payouts` en `pending` et une écriture ledger négative. Le solde disponible tombe, le total versé monte. |
| **Ce qui n'est pas implémenté** | Aucun appel `transfers.create` ni `payouts.create`. Aucun argent ne quitte quoi que ce soit. `stripe_transfer_id` reste `NULL`, et le harnais l'assère explicitement. |
| **Testé réellement** | préparation, écriture ledger correspondante, effet exact sur le solde, refus d'un second versement du même argent, et reversal produisant une **nouvelle** écriture positive. |

Le webhook sait déjà traiter `transfer.created`, `transfer.reversed`, `payout.paid` et `payout.failed` — ce code existe mais **n'a pas pu être exercé**, faute de Connect (voir §6).

---

## 6. Financial Reconciliation

Identité vérifiée sur chaque course terminée :

```
prix client = rémunération partenaire + marge TowConnect + coût de traitement
```

| Course | Client | Partenaire | TowConnect | Traitement | Somme | Dérive |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Principale | 45,00 $ | 36,90 $ | 6,49 $ | 1,61 $ | 45,00 $ | **0,0000 $** |
| Remboursée en totalité | 45,00 $ | 36,90 $ | 6,49 $ | 1,61 $ | 45,00 $ | **0,0000 $** |
| Annulée après matching | 45,00 $ | 36,90 $ | 6,49 $ | 1,61 $ | 45,00 $ | **0,0000 $** |

Net partenaire après ajustements :

| Course | Gelé | Remboursé au client | Reprise proportionnelle | Net ledger | Attendu |
| --- | ---: | ---: | ---: | ---: | ---: |
| Principale | 36,90 $ | 18,00 $ | −14,76 $ | **22,14 $** | 22,14 $ |
| Remboursée en totalité | 36,90 $ | 45,00 $ | −36,90 $ | **0,00 $** | 0,00 $ |
| Annulée après matching | 36,90 $ | — | — | **0,00 $** | 0,00 $ (jamais complétée) |

La reprise est **proportionnelle** : 18,00 $ × (36,90 / 45,00) = 14,76 $. TowConnect rend aussi sa marge sur la portion remboursée. L'écriture d'origine n'est jamais modifiée — c'est une écriture négative supplémentaire.

**`npm run verify:finance`** (nouveau) a été exécuté **pendant** le run, contre les données fixtures vivantes, et à nouveau après le nettoyage : **13/13** les deux fois. Il vérifie l'identité sur chaque course tarifée, l'égalité solde ↔ écritures, l'absence de double crédit, l'absence de versement supérieur aux gains, la présence d'une reprise pour chaque remboursement, et qu'aucun supplément non collecté n'a crédité un partenaire.

---

## 7. Permissions — 13 assertions avec de vraies sessions

| Acteur | Refusé | Autorisé |
| --- | --- | --- |
| Chauffeur | soldes de sa compagnie, remboursement, versement, vue finance plateforme | — |
| Répartiteur | remboursement, versement, soldes de sa compagnie | (opérationnel, hors finance) |
| Propriétaire compagnie A | soldes/grand livre d'une **autre** compagnie | ses propres soldes et son propre grand livre |
| Propriétaire compagnie B | soldes de la compagnie A (0 ligne visible) | — |
| Client | remboursement | son reçu |
| Admin TowConnect | — | vue finance, remboursements, versements |

---

## 8. Injection de fautes

| Faute | Comportement observé |
| --- | --- |
| Clé Stripe **live** | refus **avant** tout appel réseau (`LiveModeRefused`) |
| Clé non classifiable | refus |
| Aucune clé | refus |
| Compte Connect incomplet | non observable — Connect indisponible (§9) |
| Versement > solde | refusé |
| Remboursement sur paiement jamais encaissé | refusé |
| Remboursement sans raison | refusé |
| Remboursement au-delà du restant | refusé |
| Webhook dupliqué | dédupliqué, aucune écriture en double |
| Supplément non collectable | enregistré `uncollected` avec la raison, aucun crédit |
| Versement annulé | nouvelle écriture positive, la ligne d'origine intacte |

Aucun état financier n'a disparu silencieusement : chaque refus laisse soit une erreur remontée à l'appelant, soit une ligne portant sa raison.

---

## 9. Remaining Human Actions

### 9.1 Activer Stripe Connect sur le compte plateforme — **bloquant pour §2 et §10-Stripe**

**Ce que Stripe répond aujourd'hui :**

> You can only create new accounts if you've signed up for Connect, which you can do at https://dashboard.stripe.com/connect.

**Action, une seule fois, par un humain :** ouvrir <https://dashboard.stripe.com/connect> en **mode test**, compléter l'inscription Connect de la plateforme.

**Ce que cela débloquera immédiatement**, sans changement de code : création du compte Express, Account Link, `refresh_url`/`return_url`, onboarding incomplet, relecture du statut, `charges_enabled`, `payouts_enabled`, `requirements`, et les webhooks `account.updated` / `transfer.*` / `payout.*`.

**Non simulé.** Aucune de ces assertions n'est marquée verte : la section est rapportée `⊘ non exécutable`.

### 9.2 Terminer l'onboarding Express dans le formulaire hébergé

Même une fois Connect activé, les champs d'identité et le compte bancaire d'un compte **Express** ne peuvent pas être renseignés par l'API : Stripe les collecte sur son propre formulaire. Il faudra ouvrir l'Account Link dans un navigateur et saisir les valeurs de test documentées par Stripe. C'est la seule étape manuelle restante de la chaîne Connect.

### 9.3 Décider si un supplément approuvé doit pouvoir être encaissé

Voir §4. Aujourd'hui il ne l'est jamais. Deux options existent — demander l'éligibilité à l'autorisation incrémentale auprès de Stripe, ou construire une charge séparée — et le choix est commercial autant que technique.

### 9.4 Décider du taux de commission

Toujours entièrement ouvert. Aucune décision n'a été prise ni enregistrée.

---

## 10. Observations mineures, sans correctif

* **`getConnectAvailability()` répond « disponible » alors que Stripe refuse.** Elle n'inspecte que le mode de la clé ; savoir si la plateforme est inscrite à Connect exige un appel à Stripe. L'action elle-même échoue proprement avec le message de Stripe, donc l'utilisateur n'est jamais bloqué en silence — mais le badge peut être optimiste.
* **Un compte admin ayant activé une configuration ne peut pas être supprimé** (`pricing_configs.created_by/activated_by` → `profiles`, `NO ACTION`). C'est cohérent avec un journal d'audit — l'attribution prime sur le rangement — mais cela a une conséquence d'offboarding réelle. Le harnais retire d'abord le rôle `admin` avant toute tentative, pour qu'aucun compte fixture ne conserve de privilège.
* **`pricing_config_audit` n'a aucune clé étrangère**, délibérément : le journal survit aux lignes qu'il décrit. C'est ce qui a permis de supprimer les configurations fixtures **tout en gardant la preuve** que leur activation avait bien été journalisée.

---

## 11. État final de la base

| | |
| --- | --- |
| Configurations économiques actives | **0** |
| `pricing_configured()` | **`false`** |
| Configurations enregistrées (toutes versions) | **0** — les 10 versions fixtures ont été supprimées, pour que la première vraie configuration soit la v1 |
| Écritures de grand livre | 0 |
| Versements | 0 |
| Remboursements | 0 |
| Suppléments | 0 |
| Entreprises fixtures | 0 |
| Comptes fixtures | 0 |
| Comptes avec `role = 'admin'` | 1 (le compte réel du projet) |
| Autorisations Stripe ouvertes | 0 — toutes annulées, encaissées ou remboursées |
| **Journal d'audit conservé** | **55 lignes** |
| **Événements webhook conservés** | **89 lignes** |

Les deux dernières lignes sont conservées volontairement : ce sont les preuves que l'activation a été journalisée et que Stripe a bien atteint l'endpoint.

---

## 12. Régression

| Commande | Résultat |
| --- | --- |
| `npx tsc --noEmit` | ✅ |
| `npm run lint` | ✅ aucun avertissement |
| `npm run build` | ✅ |
| `npm run test` | ✅ 60 tests |
| `npm run test:integration` | ✅ **178 assertions RLS** — inchangées |
| `npm run verify:phase6` | ✅ 37 |
| `npm run verify:phase6_1` | ✅ 32 |
| `npm run verify:phase7` | ✅ 24 |
| `npm run verify:finance` | ✅ **13** (nouveau) |
| `npm run test:finance` | ✅ **97 exécutées, 0 échec, 1 action humaine** (nouveau) |

---

## PHASE 7.1 FINANCIAL VALIDATION COMPLETE

* **Connect E2E** — ⊘ **non exécutable** : Stripe Connect n'est pas activé sur le compte plateforme. Le code de création de compte, d'Account Link et de relecture de statut n'a donc pas pu être exercé. Rien n'a été simulé.
* **Course + frozen economics** — ✅ exécuté réellement. Prix client 45,00 $ ; 36,90 $ / 6,49 $ / 1,61 $ gelés à l'acceptation, avec `pricing_config_id`, version et horodatage. Un changement de taux à 40 % n'a rien reprisé.
* **Ledger** — ✅ exécuté réellement. Une seule écriture par course, égale au montant gelé, payable seulement après encaissement ; rejeu sans double crédit ; soldes dérivés réconciliés exactement.
* **Supplements** — ✅ exécuté (chemin `uncollected`). Le chauffeur ne peut pas auto-approuver ; le client n'est pas débité sans approbation ; un supplément non collecté ne crédite rien. Le chemin « autorisation incrémentale » est **indisponible sur ce compte Stripe** (§4).
* **Refunds** — ✅ exécuté réellement, partiel **et** total. Reprise partenaire proportionnelle par écriture négative, écriture d'origine intacte, rejeu de webhook dédupliqué.
* **Payout status** — ✅ **`payout prepared internally`**. ❌ **pas** `payout executed by Stripe` : aucun appel `transfers.create`/`payouts.create` n'existe dans Phase 7.
* **Tests** — 97 assertions E2E, 178 RLS, 60 unitaires, 37 + 32 + 24 + 13 vérifications d'effet en base. `tsc`, `lint`, `build` propres.
* **Commission active finale : `NO`**
* **Blockers** — un seul, externe et non technique : **activer Stripe Connect en mode test sur le compte plateforme**. Il bloque la validation Connect et tout versement réel, mais rien d'autre de la chaîne financière.

**Verdict : SAFE TO START PHASE 8**

— avec la réserve explicite que la partie **Connect / versement réel** de Phase 7 reste **non validée end-to-end** tant que le point 9.1 n'est pas fait, et que la collecte d'un supplément approuvé est aujourd'hui **impossible** sur ce compte (§4). Ni l'une ni l'autre n'empêche Phase 8 ; les deux doivent être portées comme dette connue, pas découvertes plus tard.
