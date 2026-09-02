# TowConnect — Phase 7 Report
## Monétisation, économie partenaire et Stripe Connect (sandbox)

**Date :** 2026-09-02
**Portée :** modèle économique, configuration de la commission, rémunération partenaire gelée, suppléments, annulations, remboursements, grand livre partenaire, versements, Stripe Connect en mode test.
**Statut Stripe :** **sandbox uniquement.** Aucune transaction réelle. Aucune clé live acceptée.

---

## 0. Le fait le plus important de cette phase

**Aucun taux de commission n'a été configuré, et rien dans le code n'en suppose un.**

`pricing_configured()` retourne `false` sur le projet live. Il n'existe aucune configuration active. Toutes les colonnes monétaires nouvelles sont `NULL`, et `NULL` veut dire *« personne n'a pris cette décision »*, ce qui n'est pas la même chose que zéro.

Concrètement :

* le simulateur admin s'ouvre avec **tous les champs vides** — aucun `15`, aucun `20`, aucun placeholder ;
* la carte d'offre chauffeur n'affiche **rien** à la place de « Vous recevrez », jamais « 0 $ » ;
* l'écran revenus chauffeur dit explicitement qu'aucun montant n'est enregistré et pourquoi ;
* la vue finance admin **exclut** des totaux les courses sans économie gelée, au lieu de les compter comme des zéros ;
* activer une configuration sans commission est **refusé par la base** (`pricing_config_active_needs_commission`), vérifié par `verify:phase7`.

La décision du taux reste entière, et l'outil pour la prendre existe maintenant.

---

## 1. Ce qui a été construit

### 1.1 Migrations (0033 → 0039, toutes appliquées et vérifiées par effet DB)

| # | Fichier | Contenu |
| --- | --- | --- |
| 0033 | `pricing_configs_and_economic_snapshot.sql` | Enum `pricing_config_status`, table `pricing_configs` versionnée, index d'unicité « une seule active », contrainte « une active doit avoir une commission », `pricing_config_audit` + trigger, `active_pricing_config()`, snapshot économique sur `requests`, réécriture de `request_provider_compensation()` en **lecture du montant gelé uniquement** |
| 0034 | `stripe_connect_accounts.sql` | État Connect sur `companies` + trigger interdisant à une entreprise d'écrire ses propres drapeaux |
| 0035 | `provider_ledger_and_payouts.sql` | `provider_payouts`, `provider_ledger_entries` (append-only), `provider_balances()` dérivée |
| 0036 | `refunds.sql` | `refunds` admin-only + lecture client, `refund_authorizers` (rôle finance futur préparé **en donnée**, pas en enum) |
| 0037 | `supplement_and_cancellation_economics.sql` | `request_supplements.payment_state` + trigger, colonnes d'annulation sur `requests`, `request_total_customer_price()`, `request_total_provider_compensation()` |
| 0038 | `provider_balances_authorization.sql` | Autorisation manquante sur `provider_balances()` |
| 0039 | `null_safe_authorization_guards.sql` | **Correctif de sécurité** — voir §4 |

### 1.2 Code

| Fichier | Rôle |
| --- | --- |
| `src/lib/economics.ts` | Le modèle économique pur. Une seule source d'arithmétique, utilisée par le serveur *et* par le simulateur admin, donc le tableau ne peut pas diverger de la réalité |
| `src/lib/economics.test.ts` | 27 tests : identité économique, planchers, plafonds, minimum partenaire, suppléments comptés une seule fois, annulations |
| `src/lib/stripe/mode.ts` | Le garde sandbox, isolé pour être testable |
| `src/lib/stripe/mode.test.ts` | 3 tests : une clé non classifiable n'est **jamais** traitée comme une clé de test |
| `src/lib/stripe/connect.ts` | Comptes Express, Account Links, lecture du compte |
| `src/lib/actions/economics.ts` | Brouillons, activation explicite, audit, simulation, **gel des économies à l'acceptation** |
| `src/lib/actions/connect.ts` | Onboarding hébergé par Stripe, rafraîchissement du statut |
| `src/lib/actions/finance.ts` | Remboursements, grand livre, versements, suppléments, annulations, vue admin |
| `src/app/dashboard/admin/economics` | Simulateur + versions + journal |
| `src/app/dashboard/admin/finance` | Soldes partenaires, versements, remboursements |
| `src/app/dashboard/business` (onglet Finances) | Solde, grand livre, versements, onboarding Connect — **propriétaire/admin seulement** |
| `src/app/dashboard/driver/earnings` | Revenus réels issus du grand livre |
| `src/app/(user)/history/[id]` | Reçu client enrichi (suppléments, annulation, remboursement) |

---

## 2. Les décisions de conception, et pourquoi

### 2.1 La rémunération est **gelée**, jamais recalculée

`request_provider_compensation()` retournait auparavant un calcul à la volée. Elle retourne maintenant **uniquement** `requests.partner_amount`, écrit une seule fois, à l'acceptation, par `freezeRequestEconomics()` avec le rôle service.

Un changement de commission demain ne peut pas modifier la paie d'une course acceptée hier. La course garde aussi `pricing_config_id` et `pricing_config_version`, donc on peut toujours répondre à « pourquoi ai-je été payé ça ? ».

### 2.2 Le grand livre est **append-only**, même pour le rôle service

`provider_ledger_entries` refuse `UPDATE` catégoriquement et refuse `DELETE` tant que l'entreprise existe (le seul chemin de sortie est la cascade de suppression de l'entreprise, testée). Une correction est **une nouvelle écriture**.

Conséquence assumée : `available_at` est décidé à l'insertion et jamais révisé. Un encaissement qui n'aboutit que plus tard est traité par `releaseHeldEarnings()`, qui écrit une **paire** d'écritures (annulation + re-crédit disponible) plutôt que de modifier l'originale. Le solde finit juste, et l'historique raconte encore ce qui s'est passé.

Les soldes sont **dérivés** (`provider_balances()`), jamais stockés : il n'existe aucun solde qui puisse contredire les mouvements qui l'ont produit.

### 2.3 Un supplément approuvé est une promesse, pas un paiement

L'autorisation prise à la confirmation couvre `price_estimate` et rien de plus. À l'approbation, `settleApprovedSupplement()` tente d'augmenter l'autorisation existante. Si Stripe refuse, le supplément est marqué **`uncollected` avec la raison**, et **rien n'est crédité** au partenaire.

Créditer une promesse, c'est payer un partenaire pour de l'argent qui n'est jamais arrivé.

La part partenaire d'un supplément est calculée en **recalculant la course entière au nouveau total et en soustrayant ce qui est déjà crédité** — pas en découpant le supplément isolément, ce qui appliquerait les planchers une deuxième fois.

### 2.4 Une annulation ne charge rien tant qu'aucune politique n'existe

`settleCancellationEconomics()` lit la configuration **gelée sur la course**. Si aucune politique d'annulation n'y figure, `cancellation_fee_charged` et `cancellation_compensation` restent `NULL` et l'autorisation est simplement relâchée. Facturer un vrai client selon une règle que personne n'a écrite n'est pas envisageable.

Quand des frais existent, ils sont encaissés **en capture partielle de la même autorisation** — et dans ce cas l'autorisation n'est pas annulée : capturer et annuler la même empreinte s'excluent.

### 2.5 Stripe Connect : nous ne voyons jamais les données bancaires

Comptes **Express**, onboarding sur le flux hébergé de Stripe. TowConnect ne reçoit ni numéro de compte, ni carte, ni pièce d'identité. Ce que nous stockons, ce sont les **réponses de Stripe** (`charges_enabled`, `payouts_enabled`, exigences restantes) — et une entreprise ne peut pas les écrire elle-même : le trigger 0034 refuse. Une entreprise qui pourrait activer ses propres versements n'aurait pas besoin de s'inscrire.

Le retour depuis Stripe **ne vaut pas approbation** : la page relit le compte auprès de Stripe plutôt que de croire la redirection.

### 2.6 Le garde sandbox est une propriété du code

`assertSandbox()` est appelé avant chaque appel Connect, chaque remboursement, chaque capture de frais d'annulation. Une clé `sk_live_` fait lever `LiveModeRefused`. Une clé **non classifiable** est refusée aussi — une clé qu'on ne sait pas classer est une clé avec laquelle on ne doit pas dépenser.

---

## 3. Tableau de simulation économique

**Toutes les lignes ci-dessous sont hypothétiques.** Aucune de ces configurations n'est active, aucune n'est enregistrée, aucune n'est une recommandation. Coût de traitement modélisé : 2,9 % + 0,30 $ (tarif carte canadien publié par Stripe — un coût subi, pas un taux que nous fixons).

Généré par `npx tsx scripts/simulate-economics.ts`.

| Scénario | Client | Partenaire | Traitement | TowConnect | Marge % |
| --- | ---: | ---: | ---: | ---: | ---: |
| Rien de configuré | 60,00 $ | — | — | — | — |
| Rien de configuré | 100,00 $ | — | — | — | — |
| Rien de configuré | 300,00 $ | — | — | — | — |
| 10 % | 60,00 $ | 54,00 $ | 2,04 $ | 3,96 $ | 6,6 % |
| 10 % | 100,00 $ | 90,00 $ | 3,20 $ | 6,80 $ | 6,8 % |
| 10 % | 300,00 $ | 270,00 $ | 9,00 $ | 21,00 $ | 7,0 % |
| 15 % | 60,00 $ | 51,00 $ | 2,04 $ | 6,96 $ | 11,6 % |
| 15 % | 100,00 $ | 85,00 $ | 3,20 $ | 11,80 $ | 11,8 % |
| 15 % | 300,00 $ | 255,00 $ | 9,00 $ | 36,00 $ | 12,0 % |
| 20 % | 60,00 $ | 48,00 $ | 2,04 $ | 9,96 $ | 16,6 % |
| 20 % | 100,00 $ | 80,00 $ | 3,20 $ | 16,80 $ | 16,8 % |
| 20 % | 300,00 $ | 240,00 $ | 9,00 $ | 51,00 $ | 17,0 % |
| 25 % | 60,00 $ | 45,00 $ | 2,04 $ | 12,96 $ | 21,6 % |
| 25 % | 100,00 $ | 75,00 $ | 3,20 $ | 21,80 $ | 21,8 % |
| 25 % | 300,00 $ | 225,00 $ | 9,00 $ | 66,00 $ | 22,0 % |
| 15 % + 2 $ fixe | 60,00 $ | 49,00 $ | 2,04 $ | 8,96 $ | 14,9 % |
| 15 % + 2 $ fixe | 300,00 $ | 253,00 $ | 9,00 $ | 38,00 $ | 12,7 % |
| 20 % plafonné à 40 $ | 250,00 $ | 210,00 $ | 7,55 $ | 32,45 $ | 13,0 % |
| 20 % plafonné à 40 $ | 300,00 $ | 260,00 $ | 9,00 $ | 31,00 $ | 10,3 % |
| **20 %, plancher partenaire 70 $** | **60,00 $** | **70,00 $** | **2,04 $** | **−12,04 $** | **−20,1 %** |
| 20 %, plancher partenaire 70 $ | 80,00 $ | 70,00 $ | 2,62 $ | 7,38 $ | 9,2 % |
| 20 %, plancher partenaire 70 $ | 300,00 $ | 240,00 $ | 9,00 $ | 51,00 $ | 17,0 % |

**Le tableau complet (8 scénarios × 7 montants) est produit par le script.**

Trois observations factuelles, sans jugement de valeur — aucun seuil de « bonne marge » n'a été établi, et en inventer un serait pris pour une décision :

1. **Le coût de traitement mord davantage sur les petits montants.** À 10 % de commission sur une course de 60 $, Stripe prend plus de la moitié de la marge brute.
2. **Un plafond de commission inverse la courbe.** À 20 % plafonné à 40 $, la marge en pourcentage *diminue* à mesure que la course grossit.
3. **Un plancher partenaire peut rendre la marge négative** sur les petites courses. Le simulateur le signale (`margin_negative`) plutôt que de le masquer — c'est exactement le genre de configuration qui doit être vue avant activation, pas découverte en production.

**Contrôle d'intégrité :** `client = partenaire + traitement + marge` sur chaque ligne des 8 scénarios × 7 montants. Dérive maximale mesurée : **0,0000 $**.

---

## 4. Une faille de sécurité trouvée et corrigée pendant cette phase

Le test RLS Phase 7 a échoué sur un point : *« un propriétaire d'entreprise ne peut pas lire les soldes d'une autre entreprise »*. Il pouvait.

**Cause racine.** Tous les gardes `SECURITY DEFINER` de ce projet sont écrits ainsi :

```sql
if auth.role() <> 'service_role' and not is_admin() and ... then raise ... end if;
```

Cela se lit comme étanche. Ça ne l'est pas. `auth.role()` retourne `NULL` quand la revendication de rôle n'est pas là où la fonction la cherche, et en SQL `NULL <> 'service_role'` vaut `NULL`, pas `true`. `NULL and false` vaut `NULL`. `if NULL then` ne se déclenche pas. **La seule branche qui existe pour refuser la requête ne fait rien, et la fonction retourne la donnée.**

Une fonction `SECURITY DEFINER` contourne la RLS de la table par conception, donc il n'y a pas de deuxième filet.

**Portée.** La même forme existait sur quatre fonctions : `provider_balances()`, `request_provider_compensation()`, `request_total_customer_price()`, `request_total_provider_compensation()`. Les trois dernières viennent de phases antérieures et n'avaient pas de test qui pointait dessus.

**Correctif (0039).** Chaque terme est rendu null-safe : `coalesce(auth.role(), '') <> 'service_role'`, `not coalesce(is_admin(), false)`, etc. Un garde qui ne peut pas trancher doit refuser, jamais autoriser.

**Vérification.** Le test RLS passe désormais, et il passe pour la bonne raison : la lecture croisée retourne une erreur, la lecture propre retourne les données.

---

## 5. Résultats de validation

| Commande | Résultat |
| --- | --- |
| `npx tsc --noEmit` | ✅ aucune erreur |
| `npm run lint` | ✅ aucune erreur, aucun avertissement |
| `npm run build` | ✅ compilé, 27 routes générées |
| `npm run test` | ✅ **60 tests**, 6 fichiers |
| `npm run test:integration` | ✅ **178 assertions RLS** |
| `npm run verify:phase6` | ✅ 37 vérifications |
| `npm run verify:phase6_1` | ✅ 32 vérifications |
| `npm run verify:phase7` | ✅ **24 vérifications** |

### 5.1 Les invariants RLS Phase 7 (tous verts)

1. Un chauffeur ne peut pas lire le grand livre d'une autre entreprise.
2. Un propriétaire lit son propre grand livre et pas celui d'une autre entreprise.
3. Un propriétaire ne peut pas écrire sa propre écriture de grand livre.
4. Une écriture ne peut pas être modifiée, **même par le rôle service**.
5. Un propriétaire ne peut pas lire les soldes d'une autre entreprise. *(l'invariant qui a révélé §4)*
6. Un chauffeur ne peut pas créer une configuration tarifaire.
7. Ni un client ni un chauffeur ne peut émettre un remboursement.
8. Une entreprise ne peut pas activer ses propres versements Stripe.
9. Un chauffeur ne peut pas marquer le paiement d'un supplément comme réglé.
10. Un chauffeur ne peut pas écrire sa propre rémunération gelée.

### 5.2 Ce que `verify:phase7` prouve par effet en base

* les six tables existent ; `companies` porte son état Connect ;
* au plus une configuration active ; `pricing_configured()` est d'accord avec la donnée ;
* **aucune commission active** ;
* une configuration sans commission **ne peut pas** être activée ;
* le rôle service peut ajouter au grand livre, ne peut pas le modifier, ne peut pas le supprimer ;
* la modification refusée **n'a réellement pas eu lieu** (relecture de la valeur) ;
* une écriture sans `available_at` compte comme *en attente*, pas *disponible* ;
* supprimer une entreprise fait bien disparaître son grand livre par cascade ;
* aucune course ne porte une rémunération issue d'aucune configuration ;
* aucun résidu de sonde.

---

## 6. Ce qui n'a pas été fait, et pourquoi

* **Aucun taux configuré.** C'est une décision d'affaires, explicitement hors mandat.
* **Aucune transaction réelle, aucune clé live.** Refusé par le code, pas seulement par convention.
* **Aucun versement automatique.** `preparePayout()` *prépare* : elle écrit une écriture négative et une ligne `pending`. Envoyer réellement l'argent reste une décision séparée, ultérieure.
* **Géométries réglementaires Québec** : hors mandat de cette phase, comme demandé. Elles restent inactives, avec leurs trois sources citées en base.
* **Rôle finance** : préparé comme **donnée** (`refund_authorizers` + `is_refund_authorizer()`), pas comme valeur d'enum. Accorder l'accès finance plus tard sera une insertion de ligne, pas une migration.

### 6.1 Limites connues, énoncées franchement

* **`incrementAuthorization` n'est pas universellement disponible.** Stripe ne permet d'augmenter une autorisation que sur certaines autorisations carte éligibles. Quand ce n'est pas possible, le supplément est marqué `uncollected` avec la raison et **rien n'est crédité**. Le chemin « collecter séparément » (deuxième PaymentIntent) n'est pas construit — il n'était pas au mandat, et le construire à moitié aurait été pire.
* **La libération d'un gain retenu passe par une paire d'écritures.** C'est le prix de l'immuabilité, assumé : le grand livre reste lisible, mais un audit y verra deux lignes là où un système modifiable en aurait montré une.
* **Les scénarios de simulation modélisent le tarif carte canadien publié par Stripe.** Ce n'est pas le tarif négocié de TowConnect, qui n'existe pas encore. Le champ « frais de traitement » du simulateur est là pour être renseigné quand il existera.
* **`freezeRequestEconomics()` est best-effort à l'acceptation.** Un échec laisse `partner_amount` à `NULL` — donc « non configuré », pas un montant inventé — mais aucune reprise automatique n'existe. Un job de réconciliation serait la suite logique.

---

## 7. Scénarios de test manuels

À exécuter en mode test Stripe, une fois une configuration activée depuis `/dashboard/admin/economics`.

| # | Scénario | Attendu |
| --- | --- | --- |
| 1 | Ouvrir `/dashboard/admin/economics` sans configuration | Tous les champs vides, tableau en « — », bouton *Activer* absent |
| 2 | Saisir 20 % + 2,9 %/0,30 $, sans enregistrer | Le tableau se recalcule immédiatement ; l'identité tient sur chaque ligne |
| 3 | Saisir un plancher partenaire de 70 $ | Avertissement *marge négative* à 60 $, sans verdict du type « trop bas » |
| 4 | Enregistrer le brouillon puis l'activer | Une seule version active ; la précédente passe en `archived` ; le journal montre les deux actions |
| 5 | Créer une course, l'accepter comme chauffeur | La carte d'offre affiche « Vous recevrez X » **avant** l'acceptation ; après acceptation, `economics_frozen_at` est renseigné |
| 6 | Changer la commission, puis compléter la course acceptée avant | La rémunération **ne bouge pas** ; le grand livre crédite le montant gelé |
| 7 | Proposer un supplément, l'approuver côté client | `payment_state` passe à `authorized` (ou `uncollected` avec raison) ; le reçu client montre la ligne |
| 8 | Annuler une course après acceptation | Frais et compensation appliqués **seulement** si la politique existe ; sinon l'empreinte est relâchée |
| 9 | Émettre un remboursement partiel depuis `/dashboard/admin/finance` | Ligne `refunds`, écriture négative `refund_reversal` proportionnelle, reçu client mis à jour |
| 10 | Onboarder une entreprise via Connect, revenir | Le statut est relu **auprès de Stripe** ; l'onglet Finances n'apparaît pas pour un répartiteur |

---

## 8. KPI à suivre une fois un taux activé

| KPI | Source | Pourquoi |
| --- | --- | --- |
| Marge nette par course | `requests.commission_amount` | La seule mesure qui compte réellement |
| Marge en % du prix client | dérivée | Révèle l'effet des plafonds sur les grosses courses |
| Part du coût de traitement dans la marge brute | `payment_processing_cost` | Mord surtout sur les petites courses |
| Rémunération médiane partenaire | `provider_ledger_entries` | Un partenaire mal payé part |
| Courses sans économie gelée | `partner_amount is null` | Doit tendre vers zéro après activation |
| Suppléments `uncollected` | `request_supplements.payment_state` | Chaque ligne est de l'argent promis et non perçu |
| Solde disponible non versé | `provider_balances()` | De l'argent dû qui dort |
| Taux de remboursement | `refunds` | Signal qualité autant que financier |
| Entreprises `connect_payouts_enabled = false` | `companies` | Elles ne peuvent pas être payées |

---

## 9. Verdict

Le socle économique est en place, testé, et **délibérément vide de toute décision commerciale**. La faille null-safe découverte en chemin touchait trois fonctions antérieures à cette phase et est corrigée sur les quatre.

Toute la batterie de validation est verte : 60 tests unitaires, 178 assertions RLS, 37 + 32 + 24 vérifications d'effet en base, `tsc`, `lint` et `build` propres.

**SAFE TO START PHASE 8**
