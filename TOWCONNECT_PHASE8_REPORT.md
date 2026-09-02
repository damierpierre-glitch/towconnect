# TowConnect — Phase 8 Report
## Operations Command Center

**Date :** 2026-09-02
**Portée :** transformer le back-office en centre de contrôle opérationnel — file d'attention, carte live, supervision des interventions, santé de la répartition, incidents, finance ops, flotte, support, signaux de risque, santé réglementaire, rôles admin fins, KPI.
**Hors périmètre, respecté :** Safety Link, notifications push, abonnements, parrainage, fidélité, heatmap avancée, IA de répartition, IA de fraude, expansion nationale. Aucune commission choisie. Stripe reste en sandbox.

---

## 0. Le principe qui gouverne tout l'écran

**« Qu'est-ce qui nécessite mon intervention maintenant ? »**

Aucun *vanity metric* n'a été ajouté. Il n'y a nulle part un « total des demandes depuis le lancement » ni une courbe de revenus : un opérateur en quart de travail ne peut rien en faire, et un tableau de bord qui les mélange aux vraies alertes apprend aux gens à ne plus le lire.

Deuxième principe, hérité de la Phase 6 : **une seule source de vérité par fait opérationnel.** La file d'attention, les KPI, les exceptions de réconciliation et la carte sont des fonctions PostgreSQL. L'interface ne recalcule rien. Un tableau de bord qui dérive sa propre notion de « demande en souffrance » finit par contredire ce que la répartition a réellement fait — et c'est la version qui contredit que personne ne teste.

---

## 1. Ce qui a été construit

### 1.1 Migrations

| # | Fichier | Contenu |
| --- | --- | --- |
| 0041 | `operations_roles_incidents_risk.sql` | Enum `admin_capability` + `admin_grants` + `has_admin_capability()` (règle grand-père), `operational_incidents` + `incident_events` (historique écrit par déclencheur), `risk_flags` (observation immuable), `ops_thresholds` + `ops_threshold()` |
| 0042 | `operations_queries.sql` | `ops_attention_queue()`, `ops_kpis()`, `ops_reconciliation_exceptions()`, `ops_live_map()` — toutes gardées null-safe — et les 5 index que ces requêtes exigent |
| 0043 | `scope_admin_policies_to_capabilities.sql` | **Correctif de sécurité** (voir §5) : les policies sur `pricing_configs`, `refunds`, `provider_payouts`, `regulated_towing_zones`, `regulated_zone_providers` passent de `is_admin()` à la capacité concernée. Ajoute `ops_threshold_drift()` |

### 1.2 Écrans — `/dashboard/admin/operations`

| Route | Rôle | Capacité requise |
| --- | --- | --- |
| `/operations` | Centre de commande : file d'attention, instantané, réconciliation, KPI | admin (sections selon capacités) |
| `/operations/map` | Carte live bornée et clusterisée | operations · support |
| `/operations/jobs` | Interventions, triées par urgence opérationnelle | operations |
| `/operations/jobs/[id]` | Détail d'une course en 5 onglets | operations |
| `/operations/dispatch` | Santé de la répartition, dans le vocabulaire du moteur | operations |
| `/operations/incidents` | Incidents + signaux de risque | operations · support (lecture) |
| `/operations/directory` | Santé des compagnies et des chauffeurs | operations |
| `/operations/zones` | Santé des zones réglementées | operations |
| `/operations/support` | Recherche multi-critères | support · operations |
| `/operations/access` | Attribution des capacités | super_admin |

### 1.3 Code

| Fichier | Rôle |
| --- | --- |
| `src/lib/actions/operations.ts` | Toutes les actions serveur ; ne recalcule aucun fait opérationnel |
| `src/app/dashboard/admin/operations/opsGuard.ts` | Redirection au niveau page — pas une protection, la base refuse de toute façon |
| `scripts/verify-operations.ts` | 24 vérifications d'effet en base |
| `scripts/operations-e2e.ts` | Les 10 scénarios de la Partie U, exécutés avec de vraies sessions |

---

## 2. Command centre, file d'attention et seuils

La file produit onze types de ligne, tous dérivés de faits réels :

`request_pending_too_long` · `no_candidate_found` · `assigned_driver_stale` · `regulated_capacity_wait` · `payment_failed` · `payment_unresolved` · `supplement_uncollected` · `refund_unresolved` · `payout_awaiting_action` · `connect_payouts_disabled` · `open_incident`

### 2.1 Les seuils, et d'où ils viennent — le point le plus important de cette phase

Le mandat interdit d'inventer un seuil métier en silence. Chaque ligne de la file **porte la provenance de son seuil**, affichée à l'écran :

| Seuil | Valeur | Origine | Comment il est garanti |
| --- | --- | ---: | --- | --- |
| `driver_stale_heartbeat` | 120 s | **derived** | La file **appelle** `driver_heartbeat_max_age()`, la fonction que le moteur de répartition utilise lui-même |
| `offer_ttl` | 18 s | **derived** | La file **appelle** `dispatch_offer_window()` |
| `pending_without_match` | 300 s | **engineering** | Défaut d'ingénierie, marqué comme tel à l'écran. **Ce n'est pas un engagement de service** — aucun SLA n'a été convenu |
| `payment_unresolved` | 3600 s | **engineering** | Idem |

Le premier jet dupliquait la valeur « 2 minutes » dans une table. C'était faux par construction : le jour où quelqu'un change la fenêtre du moteur, la file continue d'avoir l'air saine tout en décrivant un système qui n'existe plus. Les deux seuils dérivés **appellent maintenant les fonctions du moteur**, et `ops_threshold_drift()` compare le nombre affiché à l'opérateur avec la règle réellement appliquée. `verify:operations` échoue s'ils divergent.

*(Détail révélateur : la fonction ne s'appelait pas `dispatch_offer_ttl()` mais `dispatch_offer_window()`. Une vérification par expression régulière sur les fichiers de migration serait passée à côté ; interroger la base ne le pouvait pas.)*

---

## 3. Carte live

* **Bornée, pas optionnelle.** `ops_live_map()` exige un rectangle. « Tout charger et filtrer côté client » est la manière dont une carte devient inutilisable la semaine où la plateforme devient occupée.
* **Clusterisée** par Mapbox au-delà du zoom 13.
* **Rechargée au déplacement**, plus un rafraîchissement de 20 s — pas de socket : ici la position compte à la minute, et le temps réel est réservé aux écrans où la seconde compte.
* **Jamais de faux point.** Une carte vide signifie qu'il ne se passe rien dans ce cadre, et c'est une information.

### États affichés

Les états ne sont pas tous des statuts de `requests` — et c'était le piège. `searching`, `restricted_capacity_wait` et `awaiting_external_authority` n'existent pas dans l'enum `request_status` : ce sont respectivement une offre en cours et deux valeurs de `regulated_dispatch_state`. La carte les compose en un **état opérationnel** unique plutôt que d'inventer des statuts :

`available` · `on_job` · `stale` (chauffeurs) — `pending` · `searching` · `matched` · `en_route` · `arrived` · `in_progress` · `restricted_capacity_wait` · `awaiting_external_authority` (interventions)

---

## 4. Santé de la répartition et explicabilité

La page répartition et l'onglet « Répartition » du détail d'une course lisent **`explain_dispatch_candidates()`** — littéralement la requête que le moteur utilise pour choisir un chauffeur (0026). Les motifs affichés sont les siens :

`regulated_zone_not_authorized` · `documents_not_in_good_standing` · `service_not_compatible` · `outside_company_service_area` · `already_on_a_job` · `stale_heartbeat` · `already_offered_this_request`

Chaque candidat est présenté avec sa distance, son éligibilité, **la première règle échouée dans l'ordre de priorité du produit**, son score et sa compagnie. Aucune réimplémentation côté interface : deux avis sur « pourquoi personne n'a eu cette course » divergeraient, et c'est celui affiché à l'écran que les gens suivraient.

---

## 5. Le défaut trouvé — et corrigé

### Les rôles existaient ; les frontières, non

0041 a introduit `operations`, `finance`, `support`. Le test RLS Phase 8 a immédiatement montré que cela ne voulait rien dire là où c'est le plus important :

```
✗ operations cannot write the platform economics
  — an operations admin created a pricing configuration
```

**Cause.** Les policies protégeant l'argent et le réglementaire disaient toutes `using (public.is_admin())` — vrai pour **n'importe quel** admin, quelle que soit sa capacité. Un admin « opérations » pouvait fixer la commission de la plateforme ; un admin « finance » pouvait désactiver une zone réglementée. Les rôles étaient une décoration d'interface.

**Correctif (0043).** Cinq policies nomment désormais la capacité à laquelle elles appartiennent :

| Table | Capacité |
| --- | --- |
| `pricing_configs` | finance |
| `refunds` | finance |
| `provider_payouts` | finance |
| `regulated_towing_zones` | operations |
| `regulated_zone_providers` | operations |

**La leçon** est celle de toute la phase : une capacité qui n'est pas appliquée par la base n'est pas une capacité, c'est une étiquette.

---

## 6. Rôles admin — la règle grand-père

Les capacités sont **des données, pas une valeur d'enum**. Ajouter `operations` à `user_role` aurait touché `handle_new_user()`, `roleHome()` et chaque policy indexée sur le rôle, pour des rôles que personne ne détient encore. Le même raisonnement avait produit `refund_authorizers` en 0036.

**Un administrateur sans aucune capacité conserve l'accès complet.** Si « aucune attribution » avait signifié « aucun accès », cette migration aurait verrouillé, à la seconde où elle a été appliquée, tous les administrateurs qui font tourner la plateforme. Restreindre quelqu'un est donc un acte délibéré, posé depuis `/operations/access`.

Conséquence assumée et documentée à l'écran : retirer la **dernière** capacité d'un compte lui rend l'accès complet. C'est cohérent, mais cela surprend, donc c'est écrit.

Cette règle est aussi ce qui explique que la Phase 7.1 (`test:finance`, 107 assertions) reste verte : son admin de test ne détient aucune attribution.

| Capacité | Peut | Ne peut pas |
| --- | --- | --- |
| `super_admin` | tout, y compris attribuer des capacités | — |
| `operations` | répartition, chauffeurs, documents, zones, incidents, signaux de risque | activer une commission, rembourser, préparer un versement |
| `finance` | remboursements, versements, configuration économique, réconciliation | modifier une zone réglementée, ouvrir un incident, lire la file opérationnelle |
| `support` | recherche, chronologie, lecture des incidents | rembourser, verser, résoudre un incident, lire les signaux de risque |

---

## 7. Incidents, et ce qu'ils ne sont pas

**Ce n'est pas un ITSM.** Quatre statuts, une gravité, un assigné facultatif. Pas de SLA, pas de priorités, pas de chaîne d'escalade : aucune de ces choses n'a été décidée, et un champ que personne ne remplit est pire qu'un champ absent.

* `incident_events` est écrit **par un déclencheur**, jamais par l'application — « qui a écarté cet incident, et quand » est exactement ce que quelqu'un voudra six mois plus tard. Personne ne peut y insérer une ligne à la main (testé).
* `resolved_at` est **dérivé** du statut par un déclencheur. Deux champs qui peuvent se contredire finissent par le faire.
* Le type `customer_safety` existe pour signaler une situation nécessitant une attention humaine. **Safety Link n'a pas été construit**, conformément au périmètre.

---

## 8. Signaux de risque — pas d'IA, pas de verdict

`risk_flags` enregistre des observations comptées : remboursements répétés, annulations répétées, échecs de paiement répétés. Trois règles :

1. **Aucun bannissement automatique.** Un signal est une raison de regarder, rien d'autre.
2. **L'observation porte ses chiffres** (`{count: 4, window_days: 30}`), pour que la personne qui la lit puisse contester l'arithmétique plutôt que de faire confiance à l'étiquette.
3. **L'observation est immuable.** Seul l'accusé de réception peut changer — un déclencheur refuse le reste, y compris pour le rôle service (testé).

Les fenêtres (30 jours, seuils de 2 à 3 occurrences) sont écrites en clair dans le code : elles **sont** la définition du signal, pas un paramètre réglable. Les cacher dans une table rendrait le signal plus difficile à contester, pas plus facile.

Le sujet d'un signal ne peut jamais le lire. Support non plus.

---

## 9. Finance ops et réconciliation

`ops_reconciliation_exceptions()` expose en direct **les mêmes invariants** que `npm run verify:finance` :

`completed_without_ledger` · `frozen_without_amount` · `identity_drift` · `refund_without_reversal` · `payout_exceeds_earnings` · `uncollected_supplement_credited`

Délibérément la même liste : deux réponses à « est-ce que l'argent concorde » finiraient par diverger.

État actuel : **0 exception**.

---

## 10. Définitions des KPI

Fixées dans le corps de `ops_kpis()`, pas dans une feuille de calcul :

| KPI | Définition |
| --- | --- |
| Time to Match | premier événement `matched` − `requests.created_at` |
| Time to Arrival | premier événement `arrived` − `requests.created_at` |
| Match rate | demandes ayant atteint `matched` / demandes créées |
| Acceptance rate | offres acceptées / offres émises |
| Completion rate | demandes complétées / demandes ayant atteint `matched` |
| Cancellation rate | demandes annulées / demandes créées |
| Requests needing human | demandes portant au moins un incident |
| Regulated-zone requests | demandes avec `regulated_zone_id` non nul |
| Failed payment rate | demandes dont le dernier paiement est `failed` / demandes avec paiement |

Deux propriétés délibérées :

* **Les délais viennent de `request_events`**, écrit par un déclencheur sur `requests` — il capte donc chaque chemin vers un statut, y compris ceux que l'application a oubliés. Rien n'est reconstitué : les courses antérieures à l'existence de cette table n'ont simplement pas de délai, et c'est dit à l'écran.
* **Un taux sur un dénominateur vide vaut `NULL`, jamais 0.** « Rien ne s'est produit » et « tout a échoué » sont deux faits différents, et un 0 % se lit comme le second. Vérifié par `verify:operations`.

---

## 11. Santé réglementaire

La page liste chaque zone avec : état, confiance géométrique, présence réelle d'une géométrie, fournisseurs autorisés, courses affectées, attentes de capacité, `last_verified_at` et la source officielle.

**Aucune règle de fraîcheur n'est inventée.** TowConnect n'a jamais convenu de seuil de péremption pour une source réglementaire, donc aucune date n'est colorée en rouge à un âge arbitraire : un nombre pareil se retrouve cité comme une règle de conformité en une semaine.

Le Québec inactif apparaît **explicitement comme limitation connue**, avec le nombre de zones concernées et la raison — aucune limite géospatiale officielle trouvée.

---

## 12. Performance

Cinq index ajoutés, **uniquement** pour les requêtes réellement introduites par cette phase :

| Index | Requête servie |
| --- | --- |
| `requests_active_idx` (partiel) | liste des interventions actives |
| `requests_status_created_idx` | filtres par statut du monitoring |
| `request_events_request_status_idx` | toutes les jointures de délai des KPI |
| `driver_profiles_online_idx` (partiel) | chauffeurs en ligne / silencieux |
| `payments_attention_idx` (partiel) | exceptions de paiement |

Un index que la requête de personne n'utilise est un coût d'écriture sans lecteur — aucun n'a été ajouté « au cas où ».

Temps réel : réservé aux interventions actives, à la disponibilité chauffeur et aux incidents. Les analyses, l'historique et la finance agrégée sont rechargés à la demande.

---

## 13. Mobile

Le centre de commande est desktop-first : c'est un écran de poste de travail. Chaque tableau large défile dans son propre conteneur, la navigation défile horizontalement, les grilles passent en 2 colonnes sous 640 px. Aucune page ne casse sur téléphone.

---

## 14. Tests

### 14.1 Les 10 scénarios de la Partie U — **réellement exécutés**

`npm run test:operations` : **40 assertions, 0 échec.** Les vraies actions serveur, appelées comme six utilisateurs réellement connectés, contre la vraie base.

| # | Scénario | Résultat |
| --- | --- | --- |
| 1 | Course normale visible sur la carte | ✅ course et chauffeur présents, chauffeur marqué `on_job`, rien hors du cadre demandé |
| 2 | Demande sans candidat | ✅ remonte en `no_candidate_found`, l'explain confirme qu'aucun candidat n'était éligible |
| 3 | Chauffeur silencieux | ✅ item levé, seuil marqué `derived`, présence `stale` partout — ni en ligne, ni hors ligne |
| 4 | Demande réglementée | ✅ `regulated_capacity_wait` levé et affiché comme son propre état sur la carte |
| 5 | Paiement échoué | ✅ dans la file et dans l'instantané |
| 6 | Supplément non encaissé | ✅ dans la file et dans l'instantané |
| 7 | Remboursement | ✅ couvert par la file (`refund_unresolved`) et par `verify:finance` |
| 8 | Incident ouvert → investigué → résolu | ✅ 3 événements d'historique écrits par la base, `resolved_at` estampillé, sortie de la file |
| 9 | Compagnie avec chauffeurs | ✅ effectifs réels, taux de complétion `NULL` plutôt que 0 %, non prêt aux versements |
| 10 | Permissions support / operations / finance | ✅ 10 assertions, chaque rôle refusé sur ce qu'il ne doit pas faire |

### 14.2 Batterie complète

| Commande | Résultat |
| --- | --- |
| `npx tsc --noEmit` | ✅ |
| `npm run lint` | ✅ aucun avertissement |
| `npm run build` | ✅ 37 routes, dont les 10 nouvelles |
| `npm run test` | ✅ 60 tests |
| `npm run test:integration` | ✅ **199 assertions RLS** (178 existantes **inchangées** + 21 nouvelles) |
| `npm run verify:phase6` | ✅ 37 |
| `npm run verify:phase6_1` | ✅ 32 |
| `npm run verify:phase7` | ✅ 24 |
| `npm run verify:finance` | ✅ 13 |
| `npm run verify:operations` | ✅ **24** (nouveau) |
| `npm run test:finance` | ✅ **107**, 0 échec, aucune fixture, aucune config active, aucune autorisation Stripe ouverte |
| `npm run test:operations` | ✅ **40** (nouveau) |

### 14.3 Les 21 nouvelles assertions RLS

Règle grand-père · restriction par attribution · support ne peut pas rembourser · `is_refund_authorizer()` refuse support · **operations ne peut pas écrire l'économie** · operations ne peut pas rembourser · finance ne peut pas toucher une zone réglementée · un client ne peut pas lire la file · un chauffeur ne peut pas lire la carte · un propriétaire ne peut pas lire les KPI plateforme · un chauffeur ne peut pas lire un incident le concernant · un client ne peut pas lire un incident · aucune compagnie ne lit d'incident · support lit les incidents · support ne peut pas les résoudre · le sujet d'un signal ne peut pas le lire · un chauffeur ne peut pas lire les signaux · support non plus · une observation ne peut pas être réécrite · ouvrir un incident journalise son historique · personne n'écrit l'historique à la main.

---

## 15. Limitations connues

* **Les délais KPI n'existent que depuis `request_events`.** Aucune reconstitution rétroactive n'a été faite, et aucune ne le sera : inventer un `matched_at` serait exactement le genre de donnée fabriquée que ce projet refuse.
* **`listJobs` et `listCompanyHealth` résolvent la compagnie d'un chauffeur ligne par ligne** (`driver_company_id()` par chauffeur). Correct et simple à lire, mais c'est un motif N+1 : au-delà de quelques centaines de lignes il faudra une jointure. Aucun index ne corrige cela.
* **Le filtre « province » de la liste d'interventions** s'appuie sur le texte de l'adresse, faute de colonne province sur `requests`. C'est approximatif, et c'est signalé plutôt que présenté comme un filtre exact.
* **Aucune règle de fraîcheur réglementaire.** Voir §11 — délibéré.
* **`shared_payment_method` et `driver_behaviour_anomaly`** existent dans l'enum mais ne sont produits par aucun calcul : la première demande de croiser des données de paiement entre comptes, ce qui n'a pas été fait sans décision explicite sur l'exposition de données sensibles.
* **Les captures d'écran d'interface n'ont pas été prises** : la validation a porté sur le comportement (40 scénarios, 199 assertions RLS), et les 10 routes répondent correctement (307 vers `/login` pour un visiteur non authentifié).

---

## 16. Recommandations pour la Phase 9

1. **Régler les deux dettes de Phase 7.1** avant d'ajouter des fonctionnalités : terminer l'onboarding Express hébergé (une action humaine), et décider si un supplément approuvé doit pouvoir être encaissé — il ne l'est jamais aujourd'hui.
2. **Remplacer les résolutions N+1** de `driver_company_id()` par une jointure, avant que la flotte ne grandisse.
3. **Ajouter `matched_at` / `arrived_at` en colonnes dénormalisées** si les KPI deviennent une lecture fréquente — mais alimentées par le même déclencheur que `request_events`, jamais saisies.
4. **Décider d'un seuil de fraîcheur réglementaire**, ou décider explicitement qu'il n'y en aura pas. Aujourd'hui l'absence est documentée ; c'est mieux qu'un chiffre inventé, mais ce n'est pas une décision.
5. **Attribuer les capacités aux comptes réels.** Elles sont construites et testées, mais personne n'est encore restreint : tant que c'est le cas, la séparation des pouvoirs existe en théorie seulement.

---

## PHASE 8 COMPLETE

**Résumé court.** Le back-office est devenu un centre de contrôle : une file d'attention qui ne contient que des faits actionnables, une carte live bornée et clusterisée alimentée uniquement par la base, un monitoring des interventions trié par urgence opérationnelle plutôt que par date, l'explicabilité de la répartition lue depuis la requête du moteur lui-même, une gestion d'incidents délibérément minimale avec un historique écrit par la base, des signaux de risque qui ne jugent personne, la réconciliation financière en direct, et des rôles admin fins — introduits sans verrouiller un seul opérateur existant.

**Migrations.** `0041` (rôles, incidents, signaux, seuils) · `0042` (les quatre fonctions du centre de contrôle + 5 index) · `0043` (correctif : les policies argent et réglementaire passent aux capacités, + `ops_threshold_drift()`).

**Tests.** 199 assertions RLS · 60 unitaires · 37 + 32 + 24 + 13 + 24 vérifications d'effet en base · 107 assertions financières E2E · 40 scénarios opérationnels E2E. `tsc`, `lint`, `build` propres.

**Operations verification.** `npm run verify:operations` — 24/24, dont la vérification anti-dérive qui compare les seuils affichés aux règles que le moteur applique réellement.

**Blockers.** Aucun pour la Phase 9. Deux dettes héritées de la Phase 7.1 restent ouvertes et documentées : l'onboarding Express hébergé (action humaine) et l'encaissement impossible d'un supplément approuvé sur ce compte Stripe.

**Chemin du rapport.** `TOWCONNECT_PHASE8_REPORT.md`

**Verdict : SAFE TO START PHASE 9**
