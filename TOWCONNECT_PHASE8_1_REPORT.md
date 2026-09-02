# TowConnect — Phase 8.1 Report
## Pre-Phase-9 hardening

**Date :** 2026-09-02
**Portée :** fermer trois dettes connues avant d'ajouter les différenciateurs premium — la règle grand-père des capacités admin, l'onboarding Connect Express, et un supplément approuvé qui n'était jamais encaissable.
**Hors périmètre, respecté :** Safety Link, notifications push, parrainage, fidélité, abonnements, heatmap, IA dispatch. Aucune commission choisie. Stripe reste en sandbox.

---

## 0. Résultat

| Dette | État |
| --- | --- |
| 1. Règle grand-père des capacités admin | ✅ **fermée** — `aucune capacité = aucun accès` |
| 2. Onboarding Connect Express | ⏸️ **prêt, en attente de votre action** — voir §3 |
| 3. Supplément non encaissable | ✅ **fermée** — encaissé sur un PaymentIntent séparé, vérifié bout en bout |

**Le défaut réel trouvé en chemin :** la première version du crédit de supplément payait au partenaire la part de **toute la course** au lieu de celle du supplément — 57,40 $ au lieu de 20,50 $. Détaillé en §5.

---

## 1. Capacités admin — la règle grand-père est supprimée

### 1.1 Ce qu'elle faisait, et pourquoi elle ne pouvait pas rester

`has_admin_capability()` traitait « cet admin ne détient aucune attribution » comme « cet admin détient tout ». C'était une **stratégie de migration**, pas un modèle de permissions : elle a permis d'introduire les rôles fins en Phase 8 sans verrouiller les gens qui font tourner la plateforme, et elle a fonctionné.

Elle avait aussi une conséquence que personne ne choisirait délibérément : **retirer la dernière capacité de quelqu'un lui donnait l'accès complet.** Un administrateur qu'on restreignait jusqu'à zéro devenait un administrateur qui pouvait tout. Un moindre privilège qui s'inverse à zéro n'est pas un moindre privilège.

### 1.2 La migration, dans l'ordre — et l'ordre est toute la migration

**Étape 1 — rendre explicite l'accès implicite.** Recensement puis attribution.

```
avant : 1 compte role='admin' — damier.pierre@gmail.com — 0 attribution
```

```sql
insert into admin_grants (profile_id, capability, note)
select p.id, 'super_admin', 'Granted by migration 0044: made explicit what the
       grandfather rule was giving implicitly.'
from profiles p where p.role = 'admin'
on conflict do nothing;
```

**Vérifié en base avant de continuer :**

```
damier.pierre@gmail.com | super_admin | 2026-09-02 12:49:12+00
```

`granted_by` est `NULL` : personne n'a pris cette décision, la migration l'a prise, et mettre un nom dessus serait faux.

**Étape 2 — retirer le repli.**

```sql
select coalesce(public.is_admin(), false)
   and exists (select 1 from admin_grants g
               where g.profile_id = auth.uid()
                 and g.capability in (p_capability, 'super_admin'));
```

**Inverser ces deux étapes** aurait laissé, le temps d'une instruction, chaque administrateur de cette plateforme sans accès à celle-ci — y compris le seul compte capable de réattribuer des capacités. L'attribution doit exister avant la règle qui l'exige.

**Vérification finale :** `super_admins: 1 · admins: 1 · fallback_removed: true`.

### 1.3 Ce que cela change

| Situation | Avant | Maintenant |
| --- | --- | --- |
| Admin sans attribution | accès complet | **aucun accès privilégié** |
| Retirer la dernière capacité | rendait l'accès complet | **retire réellement l'accès** |
| `super_admin` | implicite | **explicite** |
| operations / finance / support | leurs capacités | leurs capacités (inchangé) |

`ops_super_admin_count()` répond à la question qu'il faut désormais pouvoir poser : *reste-t-il quelqu'un capable d'attribuer une capacité ?* Ce n'est ni une contrainte ni un déclencheur — un déclencheur se déclenchant sur le dernier `DELETE` serait un piège à son tour, et déplacer la dernière attribution entre deux comptes dans une transaction est légitime.

### 1.4 Code mis à jour

L'écran **Accès** et le centre de commande disaient tous deux « vous conservez l'accès complet ». C'est maintenant faux, donc c'est corrigé : un compte sans capacité affiche **« aucun accès privilégié »** en rouge, et l'écran explique qu'il faut garder au moins un super administrateur.

Le harnais financier de la Phase 7.1 s'appuyait sur la règle grand-père. Il attribue désormais `super_admin` explicitement — ce qui est exactement l'effet recherché : plus rien n'est implicite, donc les tests doivent dire ce qu'ils exercent.

### 1.5 Tests

Quatre assertions RLS ajoutées, dont celle qui compte :

* un admin sans attribution ne détient **aucune** capacité ;
* **retirer la dernière capacité retire l'accès plutôt que de tout accorder** ;
* un admin dépouillé ne peut plus autoriser un remboursement ;
* un admin dépouillé ne peut plus écrire l'économie de la plateforme ;
* il reste au moins un super administrateur sur ce projet.

---

## 2. Suppléments — un repli réellement encaissable

### 2.1 Le problème

Phase 7 ne savait qu'ajouter un supplément à l'autorisation déjà détenue. Phase 7.1 a prouvé, contre Stripe réel, que **ce compte n'est pas éligible à l'autorisation incrémentale** — demander la fonctionnalité casse toutes les autorisations. Donc chaque supplément approuvé finissait `uncollected` et le partenaire n'était crédité de rien. Sûr, et inutile : le client avait accepté de payer, et personne n'était payé.

### 2.2 Le flux

```
chauffeur propose
  → client voit la raison, le montant ET LE NOUVEAU TOTAL
  → client approuve
  → tentative d'autorisation incrémentale        (refusée sur ce compte)
  → PaymentIntent séparé pour le supplément      ← le chemin réel
  → succeeded            → settled  → crédit partenaire
  → requires_action      → attente d'authentification, rien n'est crédité
  → refus                → failed, rien n'est crédité
```

### 2.3 Les règles, rendues structurelles

| Règle | Comment elle est garantie |
| --- | --- |
| Aucun supplément non approuvé n'est encaissé | le déclencheur 0027 : seul le client approuve |
| Aucun supplément non encaissé ne crédite | `creditSettledSupplement()` exige `payment_state = 'settled'` |
| Aucune double facturation | clé d'idempotence `supplement-intent-<id>` **et** `request_supplements.stripe_payment_intent_id` UNIQUE |
| Aucun double crédit | `provider_ledger_entries.supplement_id` avec index **UNIQUE** |
| Le webhook fait foi | `payment_intent.*` portant `towconnect_supplement_id` est routé vers `reconcileSupplementIntent()` |
| Le reçu sépare le supplément | facturés dans le total, non facturés listés à part avec « non facturé » |
| Remboursement possible | `issueRefund({ supplementId })` rembourse la charge du supplément, pas le tarif |

**`requires_action` est un état à part entière.** Un paiement hors session qui déclenche l'authentification forte n'est ni encaissé ni échoué. L'aplatir d'un côté créditerait de l'argent jamais arrivé ; de l'autre, il abandonnerait de l'argent que le client est encore prêt à payer. La file d'attention opérationnelle a maintenant trois lignes distinctes — `supplement_uncollected`, `supplement_charge_failed`, `supplement_awaiting_authentication` — parce que ce sont trois problèmes différents avec trois réponses différentes.

**Capture immédiate**, contrairement au tarif. Le tarif est autorisé à la demande et capturé à la complétion parce que la course peut ne pas avoir lieu ; un supplément est approuvé pour un travail en cours, pour un montant que le client vient d'accepter. Le retenir ne créerait qu'une seconde capture à oublier.

---

## 3. Connect Express — ce qui reste humain

### 3.1 État

| | |
| --- | --- |
| Connect activé sur la plateforme | ✅ (Phase 7.1, modèle Marketplace, sandbox) |
| Compagnie fixture | ✅ `Phase 8.1 Connect Fixture` |
| Compte Express canadien | ✅ `acct_1UBDcu…` |
| Account Link généré | ✅ |
| `charges_enabled` | ❌ `false` |
| `payouts_enabled` | ❌ `false` |
| `requirements.currently_due` | `business_type`, `external_account`, `tos_acceptance.date`, `tos_acceptance.ip` |
| Base synchronisée avec Stripe | ✅ **oui**, vérifié champ par champ |

### 3.2 L'action humaine restante, précisément

Le formulaire hébergé demande **identité, adresse personnelle et numéro de compte bancaire**. Je ne saisis pas ce type de donnée à la place de quelqu'un, même avec les valeurs de test publiées par Stripe : ce formulaire est fait pour collecter exactement cette catégorie d'information, et c'est une limite que je ne relâche pas. C'est aussi le cœur de l'architecture — **TowConnect ne voit jamais ces données**.

**Vous avez choisi de le compléter plus tard.** Tout est prêt pour reprendre en deux commandes :

```bash
npx tsx scripts/connect-onboarding-fixture.ts link
```

```bash
npx tsx scripts/connect-onboarding-fixture.ts status
```

`link` génère un Account Link frais (ils sont à usage unique et expirent en quelques minutes) ; `status` relit le compte **chez Stripe**, resynchronise la base et affiche les deux côtes à côte.

Valeurs de test documentées par Stripe (mode test) : téléphone → bouton « Use test phone number » puis code `000000` ; type d'entreprise → *Individual* ; SIN → `000000000` ; compte bancaire CA → transit `11000`, institution `000`, compte `000123456789`.

### 3.3 Statut du versement — sans ambiguïté

| | |
| --- | --- |
| `internal payout prepared` | ✅ implémenté et testé (Phase 7.1, 107 → 125 assertions) |
| `Stripe transfer/payout executed` | ❌ **non exécuté** |

Aucun `transfers.create` n'a été appelé. Il ne pouvait pas l'être : `payouts_enabled` est `false`, donc Stripe refuserait le transfert. Cela reste bloqué sur §3.2 et sur rien d'autre — aucun code ne manque pour l'essayer.

Le fixture Connect est **délibérément conservé** : le supprimer détruirait précisément ce que vous vous apprêtez à compléter. Il apparaît d'ailleurs correctement dans la file d'attention opérationnelle sous `connect_payouts_disabled`, ce qui est le comportement attendu. `teardown` le retire quand il ne servira plus.

---

## 4. Économie du supplément — au cent près

La rémunération du supplément utilise la **configuration gelée de la course**, jamais une version créée après l'acceptation.

Mesuré sur un vrai cycle Stripe sandbox (tarif 45,00 $, supplément 25,00 $, fixture à 18 % + 2,9 % / 0,30 $) :

| | |
| --- | --- |
| Supplément client | **25,00 $** |
| Part partenaire | **20,50 $** |
| Marge TowConnect | **3,78 $** |
| Coût de traitement | **0,72 $** |
| **Somme** | **25,00 $** |

La part est **marginale par construction** : ce que la course paie avec le supplément, moins ce qu'elle paie sans. Les planchers et plafonds par course s'appliquent donc une seule fois, quel que soit le nombre de suppléments et leur ordre d'arrivée.

Net partenaire après remboursements, sur la même course :

```
gain           36,90
supplément    +20,50
tarif remboursé 18,00 → reprise −14,76   (18,00 × 36,90/45,00)
supplément remboursé 10,00 → reprise −8,20 (10,00 × 20,50/25,00)
                         = 34,44   ← le grand livre dit 34,44
```

---

## 5. Le défaut trouvé — et corrigé

### Le crédit du supplément prenait la part de toute la course

**Observé.** Le test E2E : *« the credit uses the job's frozen configuration, not today's — 57.4 vs 20.5 »*. Le partenaire était crédité de 57,40 $ pour un supplément de 25,00 $.

**Cause.** La première version calculait « recalculer la course entière au nouveau total, puis soustraire ce qui est déjà crédité ». C'est la formule qui fonctionne pour l'ancienne autorisation incrémentale, et elle est fausse ici, pour une raison d'**ordre** : un supplément est encaissé **au moment où le client l'approuve**, c'est-à-dire presque toujours **avant la fin de la course**. L'écriture de gain n'existe donc pas encore, la soustraction n'avait rien à soustraire, et le supplément se voyait attribuer la part partenaire du tarif complet. À la complétion, le gain s'ajoutait par-dessus : 94,30 $ crédités sur une course de 70 $.

**Correctif.** Le crédit est la **différence entre deux règlements** — avec le supplément, moins sans lui — ce qui ne dépend d'aucun état du grand livre et ne peut donc pas dépendre de ce qui s'est déjà produit.

**Ce que cela dit.** Une formule correcte peut devenir fausse quand l'ordre des événements change, sans qu'une ligne de son code bouge. Seul un cycle réel, où le supplément est encaissé avant la fin de la course, pouvait le révéler.

---

## 6. Tests

### 6.1 Les 10 scénarios de la Partie 5 — réellement exécutés

`npm run test:finance` : **125 assertions, 0 échec, 1 action humaine.**

| # | Scénario | Preuve |
| --- | --- | --- |
| 1 | Supplément proposé | `payment_state = pending`, le chauffeur ne peut pas s'auto-approuver |
| 2 | Client approuve | statut `approved` par le chemin client |
| 3 | Autorisation incrémentale indisponible | tentée puis refusée par Stripe ; consignée |
| 4 | PaymentIntent séparé créé | `collection_method = separate_payment_intent`, id stocké |
| 5 | Paiement du supplément réussi | Stripe `succeeded`, 2500 ; **l'autorisation du tarif est intacte** |
| 6 | Webhook | métadonnée `towconnect_supplement_id` présente et routée |
| 7 | Grand livre crédité **une seule fois** | 1 écriture, clé `supplement_id` ; rejeu → toujours 1 ; re-règlement → **aucune seconde charge** |
| 8 | Reçu | 25,00 $ affichés comme facturés ; non facturés listés à part |
| 9 | Remboursement du supplément | remboursé **sur l'intent du supplément**, tarif intact, reprise proportionnelle 8,20 $, sur-remboursement refusé |
| 10 | Rejeu webhook | signature vérifiée, 2ᵉ livraison `deduplicated`, aucune écriture en double |

**`requires_action` :** le chemin est implémenté et surveillé (état dédié, ligne dédiée dans la file d'attention), mais **il n'a pas été déclenché** dans ce run — la carte de test utilisée n'exige pas d'authentification, et fabriquer une réussite humaine aurait été exactement ce que ce projet refuse. C'est une limitation, pas une omission.

### 6.2 Batterie complète

| Commande | Résultat |
| --- | --- |
| `npx tsc --noEmit` | ✅ |
| `npm run lint` | ✅ |
| `npm run build` | ✅ 37 routes |
| `npm run test` | ✅ 60 |
| `npm run test:integration` | ✅ **203 assertions RLS** (199 inchangées + 4) |
| `npm run verify:phase6` | ✅ 37 |
| `npm run verify:phase6_1` | ✅ 32 |
| `npm run verify:phase7` | ✅ 24 |
| `npm run verify:finance` | ✅ **16** (13 + 3 nouvelles) |
| `npm run test:finance` | ✅ **125** (107 + 18) |
| `npm run verify:operations` | ✅ **27** (24 + 3) |
| `npm run test:operations` | ✅ 40 |

### 6.3 Vérifications ajoutées

**`verify:finance`** — aucun supplément crédité avant confirmation de Stripe ; tout supplément confirmé sur une course tarifée est crédité ; aucun supplément crédité deux fois ; aucun supplément à la fois facturé séparément et ajouté à l'autorisation du tarif.

**`verify:operations`** — chaque administrateur détient au moins une capacité ; il reste au moins un super administrateur ; `has_admin_capability()` répond `false` pour un appelant qui n'est pas administrateur.

---

## 7. Cleanup — vérifié en base

| | |
| --- | --- |
| Configurations économiques actives | **0** |
| `pricing_configured()` | **`false`** |
| Configurations enregistrées | **0** |
| Comptes fixtures | **0** |
| Écritures de grand livre | **0** |
| Versements / remboursements / suppléments | **0 / 0 / 0** |
| PaymentIntents de supplément ouverts | **0** — les 3 créés sont tous `succeeded` |
| Autorisations Stripe retenant des fonds | **0** — 4 intents subsistent en `requires_payment_method`, `amount_capturable = 0` sur chacun |
| Comptes Connect | **1**, le fixture, **conservé volontairement** (§3.3) |
| Attributions admin | **1** — `super_admin` au compte réel |

Les 4 PaymentIntents restants sont les échecs historiques des validations Phase 4.5 et Phase 7.1 (carte refusée, authentification requise). Ils ne retiennent aucun fonds. Ils ne sont **pas** annulés délibérément : les annuler ferait basculer les lignes `payments` correspondantes en `canceled` et retirerait de la file d'attention des échecs réels que le centre de contrôle a raison de montrer.

---

## 8. Limitations

* **Le chemin `requires_action` n'a pas été déclenché en conditions réelles.** Implémenté, surveillé, non exercé (§6.1).
* **L'autorisation incrémentale reste indisponible** sur ce compte Stripe. Le code la tente en premier ; sur un compte éligible, elle serait utilisée. Non testable ici.
* **Le transfert Stripe vers un compte connecté n'a pas été exécuté** — bloqué uniquement par §3.2.
* **Le supplément est capturé immédiatement**, alors que le tarif attend la complétion. C'est un choix, argumenté en §2.3, pas un oubli.
* **Le crédit d'un supplément est payable dès l'encaissement**, donc potentiellement avant la fin de la course. L'argent est réellement encaissé ; c'est cohérent, mais cela signifie qu'un solde partenaire peut inclure un supplément d'une course encore en cours.

---

## PHASE 8.1 COMPLETE

* **Admin permissions hardened** — ✅ La règle grand-père est supprimée (0044), après attribution explicite de `super_admin` à l'unique administrateur existant, dans cet ordre et vérifié entre les deux étapes. Retirer la dernière capacité retire désormais réellement l'accès, ce qui est prouvé par un test RLS dédié. `ops_super_admin_count()` répond à « reste-t-il quelqu'un capable d'attribuer ? ».

* **Connect E2E** — ⏸️ Compte Express canadien créé, Account Link généré, `requirements` lus, base synchronisée avec Stripe champ par champ. **Reste une action humaine**, choisie pour plus tard : compléter le formulaire hébergé (identité, adresse, compte bancaire). Deux commandes prêtes, §3.2. Rien n'a été simulé.

* **Supplement collection** — ✅ Un supplément approuvé est désormais encaissé sur un PaymentIntent qui lui est propre, confirmé par Stripe avant tout crédit, crédité exactement une fois grâce à un index unique, remboursable séparément du tarif, et affiché distinctement sur le reçu. Identité économique vérifiée au cent : 25,00 $ = 20,50 $ + 3,78 $ + 0,72 $.

* **Stripe payout status** — `internal payout prepared` ✅ · `Stripe transfer/payout executed` ❌ (impossible tant que `payouts_enabled = false`).

* **Tests** — 203 assertions RLS · 125 assertions financières E2E · 40 scénarios opérationnels · 60 unitaires · 37 + 32 + 24 + 16 + 27 vérifications d'effet en base. `tsc`, `lint`, `build` propres.

* **Blockers** — **aucun blocage technique.** Une seule action humaine reste ouverte, par votre choix : compléter l'onboarding Express, ce qui débloquera ensuite le transfert sandbox réel.

**Verdict : SAFE TO START PHASE 9**
