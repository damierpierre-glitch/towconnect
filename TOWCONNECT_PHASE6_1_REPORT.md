# TowConnect — Phase 6.1 : activation des données réglementaires et durcissement conformité

Date : 2026-09-01. Reprise depuis `TOWCONNECT_PHASE6_REPORT.md`.
Phase 7 n'est pas commencée. Aucune commission, aucun Stripe Connect, aucun payout.

---

## 0. Ce qui change

Phase 6 a livré un moteur de zones réglementées **sans frontière**. Il protégeait
zéro client parce qu'aucune juridiction ne publie ses limites en géospatial.

Phase 6.1 en dérive une, pour l'Ontario, à partir de deux sources officielles —
et laisse le Québec inactif, parce que là, la donnée manquante n'est pas
dérivable.

| | Phase 6 | Phase 6.1 |
|---|---|---|
| Ontario | 1 ligne programme, sans géométrie, inactive | **15 zones actives**, chacune avec sa géométrie dérivée et son opérateur contracté |
| Québec | inactive, prose seulement | **toujours inactive**, 3 sources officielles vérifiées cette fois |
| `document_requirements` | vide | **2 règles Ontario**, vérifiées sur ontario.ca |
| Historique chauffeur | incluait des offres jamais acceptées | ne montre que les missions réellement prises |
| Répartiteur | ne voyait aucune course | voit les courses de **sa** compagnie, sans voir le client |
| Inspection d'une géométrie | impossible | carte par zone dans l'admin |

---

## 1. Ontario — 15 zones, dérivées et vérifiées

### 1.1 Deux sources, une méthode

| | |
|---|---|
| Liste des zones, bornes officielles, opérateur contracté | [Tow Zone Program — Government of Ontario](https://www.ontario.ca/page/tow-zone-program) |
| Axes routiers | Ontario Road Network (ORN) Composite – Segment, [Ontario GeoHub](https://geohub.lio.gov.on.ca/) / MNRF |

Méthode, par zone :

1. Segments ORN classés `Freeway` portant le numéro de route de la zone.
   `ROUTE_NUMBER` peut valoir `QEW; 403`, donc le numéro est comparé comme
   **jeton entier**, pas comme sous-chaîne.
2. Fusion d'**une seule chaussée** en composantes continues ; on retient celle
   dont les deux bornes officielles sont le plus proches. C'est la ligne de
   référence : une seule ligne ordonnée, donc la distance le long est une vraie
   mesure linéaire.
3. Localisation de chaque borne par point le plus proche, puis découpe entre les
   deux.
4. Un corridor de 200 m autour de la découpe sert **uniquement à sélectionner**
   les segments réels de l'autoroute — chaussée opposée, voies collectrices et
   express.
5. Ces segments réels sont tamponnés à **30 m** et unis.

**Les étapes 4 et 5 sont tout l'enjeu.** Tamponner une seule ligne assez large
pour atteindre la chaussée opposée avalerait aussi les voies de desserte et les
artères qui longent une autoroute de série 400. Chacun de ces faux positifs dit
à quelqu'un debout sur une rue de quartier que TowConnect ne peut pas l'aider.

Les scripts sont dans le dépôt — `app/scripts/geodata/` avec son README — parce
qu'une « méthode documentée » devrait être exécutable, pas seulement décrite.

### 1.2 Deux tentatives ratées, gardées au dossier

Elles expliquent la forme du code, et surtout : **c'est le même contrôle qui les
a attrapées** — comparer la longueur dérivée à la distance réelle entre les
bornes officielles.

* **« Plus longue composante fusionnée des deux chaussées »** — quatre zones
  différentes se sont effondrées sur le même pâté de 0,04 km². Les chaussées
  doubles de l'ORN ne fusionnent pas en une ligne.
* **« Router un graphe sur les deux chaussées »** — l'autoroute 401 de Dixie Road
  à Islington Avenue, **12 km l'une de l'autre**, est sortie en un trajet de
  36 km passant par Milton et revenant : les deux chaussées ne se rejoignent
  qu'aux extrémités de l'extrait, donc le graphe est une chaîne qui fait
  demi-tour.

Trois bornes ont aussi demandé mieux qu'une correspondance de nom :

* `DIXIE ROAD` existe à **Mississauga et à Pickering**, aux deux extrémités
  opposées de la 401 — les bornes sont donc appariées sur (nom, municipalité).
* « Third Line » et « Fifty Road » d'ontario.ca sont `3RD LINE` (Town of
  Oakville) et `50 ROAD` (City of Hamilton) dans l'ORN.
* Hurontario Street **longe** la 410 sur toute sa longueur à ~2 km : « le point
  de la 410 le plus proche de Hurontario » ne veut rien dire, et sortait à 2 km
  d'une zone de 20 km. La borne officielle est le terminus nord de l'autoroute,
  donc le tronçon de Caledon.

### 1.3 Résultat

| Zone | Bornes officielles | Opérateur contracté | Longueur dérivée | Attendue |
|---|---|---|---|---|
| 1A | Hwy 401 : Hwy 400 → Hwy 404 | Abrams Towing | 17,15 km | ~16 |
| 1B | Hwy 401 : Hwy 404 → Morningside Ave | Bob's Towing | 11,94 km | ~12 |
| 1C | Hwy 404 : Hwy 401 → Major Mackenzie Dr | William's Towing Service | 14,21 km | ~13 |
| 1D | Hwy 401 : Morningside → Hwy 412 | Classic Towing & Storage Service | 21,20 km | ~21 |
| 2A | Hwy 401 : Dixie Rd → James Snow Pkwy | A.Z. Towing | 21,92 km | ~22 |
| 2B | Hwy 401 : James Snow Pkwy → Hwy 6 South | C.A. Towing | 24,36 km | ~25 |
| 2C | Hwy 410 : Hwy 401 → Hurontario St | COMTOW | 20,17 km | ~20 |
| 2D | Hwy 403 : QEW → Hwy 401 | Lyon's Towing | 20,35 km | ~20 |
| 3A | Hwy 400 : Hwy 401 → Hwy 9 | Fellow's Towing | 35,76 km | ~40 |
| 3B | Hwy 401 : Dixie Rd → Islington Ave | Pacific Towing and Recovery | 10,90 km | ~12 |
| 3C | 401 (Islington→400) ; 409 (427→401) ; 427 (409→QEW) | Bill & Son Towing | 17,39 km | ~18 |
| 3D | Hwy 427 : Hwy 409 → Major Mackenzie Dr | JP Towing Service & Storage Ltd. | 13,76 km | ~14 |
| 4A | QEW : Hwy 427 → Third Line | ABC Towing | 25,90 km | ~26 |
| 4B | QEW : Third Line → Hwy 403 at Hwy 6 North | JKM Towing Inc. | 14,39 km | ~14 |
| 4C | QEW : séparation 403/QEW → Fifty Road | A Action Towing and Recovery Inc. | 23,79 km | ~25 |

Les 15 opérateurs restent enregistrés avec `company_id = null` : aucun n'est une
entreprise TowConnect, et leur en inventer une transformerait un fait officiel
en partenariat imaginaire.

### 1.4 Niveau de confiance — ce qui n'est pas revendiqué

`geometry_confidence = 'derived_from_official_text'`, **jamais**
`'official_geospatial'`. L'Ontario n'a pas publié ces frontières. C'est notre
lecture de ses bornes écrites contre ses propres axes routiers, et l'écran admin
affiche cette distinction sur chaque ligne, à côté d'une carte du polygone.

La ligne programme de Phase 6 est **retirée, pas supprimée** (`active = false`,
`effective_to` fermée) : elle porte l'historique d'audit de la façon dont
l'Ontario était représenté avant d'avoir des frontières.

---

## 2. Québec — reste inactive, et pourquoi

Trois sources officielles vérifiées cette fois, contre une en Phase 6 :

1. **[quebec.ca — Exclusive towing in metropolitan Montréal](https://www.quebec.ca/en/transports/traffic-road-safety/road-network/exclusive-towing-metropolitan-montreal)** :
   décrit toujours le territoire en prose et renvoie à une image de carte.
2. **Données Québec** : publie bien le réseau routier du MTMD
   (« Réseau routier – RTSS », avec classification fonctionnelle **Autoroute**),
   mais **aucune couche du territoire de remorquage exclusif**.
3. **Le tarif officiel en vigueur** (« Towing service fees for permitted
   activities », 1ᵉʳ août – 31 octobre 2026), lu intégralement : **tarifs et
   définitions seulement, aucune annexe territoriale**.

**Le blocage n'est pas le réseau routier** — il est disponible. Le blocage est
que « sections of the North and South shores » n'a **aucune étendue publiée**.
Construire un polygone reviendrait à deviner où le régime s'arrête, sur la Rive-
Sud, c'est-à-dire exactement là où TowConnect lance.

Utiliser le contour de Montréal/Laval était explicitement exclu par la mission,
et à raison : le régime vise le **réseau autoroutier**, pas les rues ordinaires.
Une zone couvrant l'île entière refuserait le service à chaque rue résidentielle
de Montréal — l'inverse de la vérité.

Constat consigné **dans la base**, sur `geometry_note` de la ligne, pas seulement
dans ce rapport.

---

## 3. Validation GPS — 80 contrôles, 0 échec

Le contrôle qui compte le plus est le dernier : chaque faux positif est un client
à qui on dit d'appeler le 511 alors qu'il est sur une rue de quartier.

| Contrôle | Résultat |
|---|---|
| Points sur la chaussée, dans leur propre zone | 15/15 zones |
| Chaussée couverte de bout en bout | **100 % des échantillons**, 15/15 zones |
| À 20 m de l'axe | **99 % à l'intérieur** |
| À 40 m | 63 % |
| À 80 m | 6 % |
| À 150 m et au-delà | **0 %** |
| Chevauchement entre zones voisines | < 0,35 km², uniquement à leur borne partagée |
| Points clairement extérieurs (Toronto centre, Guelph, Barrie, Niagara, Montréal) | tous dehors |
| Bornes d'échangeur couvertes par une zone | 28/28 |
| **Rues locales : 2000 segments ORN non-autoroutiers échantillonnés dans le corridor le plus dense** | **19 milieux à l'intérieur (0,95 %)** |

Sur ces 19 : 9 sont des **bretelles**, dont la plupart littéralement nommées
`HIGHWAY 401 COLLECTOR` / `HIGHWAY 404 COLLECTOR` — c'est-à-dire l'autoroute
elle-même, correctement incluse. 7 sont des artères (Avenue Road, Yonge Street)
au point où elles **passent en viaduc au-dessus** de la 401 : un faux positif
d'environ 30 m au droit de chaque passage supérieur, inhérent au tampon.

Une première version des contrôles ponctuels utilisait des coordonnées tapées de
mémoire (« la 401 à Yonge ») et rapportait des échecs qui n'étaient que mes
coordonnées fausses de 300 m. Remplacée par un profil perpendiculaire dérivé des
axes officiels — le tableau ci-dessus.

### Vérifié en direct, sur le projet réel

```
regulated_zone_for_point() :
  28 des 28 coordonnées de bornes officielles résolvent vers une zone
  Yorkdale / Mississauga City Centre / Toronto centre / Montréal / Longueuil -> aucune
  401 milieu zone 1A -> ON 1A     401 milieu zone 2A -> ON 2A     QEW milieu 4A -> ON 4A
```

Et **8 points de la zone de lancement** (Montréal centre, Plateau,
Montréal-Nord, Pointe-Claire, Laval, Longueuil, Brossard, Saint-Lambert)
résolvent tous vers **rien**. C'est le faux positif qui coûterait le plus cher, et
il est mesuré, pas supposé.

---

## 4. Inspection avant activation

`regulated_zone_geojson()` (migration 0032) renvoie la frontière en GeoJSON,
simplifiée à ~5 m pour le transport, et `ZoneGeometryMap` la dessine dans
l'écran admin, sous la note de dérivation.

Les zones **inactives ne sont visibles que par un admin** — délibéré : une
frontière non activée est exactement ce qu'un admin doit voir et qu'un client ne
doit pas.

Vérifié à l'écran : la zone 4B suit le QEW de Burlington vers Bronte ; la zone 1A
suit la 401 à travers North York en ruban étroit, **sans déborder sur la trame
résidentielle** — l'élargissement visible correspond à la séparation
express/collectrices, qui est bien de l'autoroute.

---

## 5. Exigences documentaires

**Ontario — vérifié.** Source :
[Towing and vehicle storage requirements — Government of Ontario](https://www.ontario.ca/page/towing-and-vehicle-storage-requirements),
sous la *Towing and Storage Safety and Enforcement Act, 2021*. La page dit deux
choses en toutes lettres d'un chauffeur, et ce sont les deux seules règles
saisies :

| Document | Règle | Effet |
|---|---|---|
| Permis de conduire de la bonne classe | « have the proper class of driver's licence for the tow truck you are driving » | bloque mise en ligne + répartition |
| Certificat de remorqueur (TSSEA) | « carry both the tow operator's certificate and your tow driver's certificate when operating the tow truck » | bloque mise en ligne + répartition |

Un type de document `tow_certificate` a été ajouté à l'énumération : classer ce
certificat sous « Autre » aurait affiché « Autre document » là où la loi en nomme
un précis.

**Ce qui est délibérément absent :**

* **L'assurance.** La page ontarienne n'énonce pas d'exigence d'assurance pour un
  chauffeur. Il est très probable que des obligations existent quelque part dans
  la réglementation ; « très probable » n'est pas une source.
* **Le Québec.** Rien n'est saisi pour la province où TowConnect lance
  réellement. LegisQuébec répond **403** aux requêtes automatisées, le matériel
  SAAQ trouvé couvre les véhicules lourds et récréatifs plutôt que ce qu'un
  remorqueur doit détenir, et les pages MTMD couvrent tarifs et procédure, pas
  les accréditations d'opérateur. Inventer une règle québécoise plausible aurait
  été inventer du droit dans la seule juridiction où elle bloquerait
  immédiatement de vrais chauffeurs. **C'est le premier point ouvert.**
* **Aucune règle générale « Canada »** — il n'existe aucune accréditation
  fédérale de remorquage à pointer.

**Effet aujourd'hui : aucun sur personne.** Tous les chauffeurs de la plateforme
sont au Québec (vérifié : 1 chauffeur, province QC), donc ces règles ne bloquent
personne jusqu'à l'inscription d'un chauffeur ontarien — moment où elles doivent
justement commencer à bloquer.

---

## 6. Historique chauffeur — corrigé

`requests.driver_id` est posé au moment de l'**offre**, et survit délibérément à
deux chemins qui n'ont jamais atteint l'acceptation : `expire_offer_on_cancel()`
le laisse quand le client annule, `cleanup_stale()` le laisse à l'expiration.
Filtrer sur `driver_id` seul mettait donc « le client a annulé pendant que je
réfléchissais » dans l'historique du chauffeur — et au dénominateur de ses
statistiques de performance.

Le correctif utilise le **même discriminant que la Phase 5.1** : la course
a-t-elle réellement atteint `matched`, lu depuis `request_events`. Deux réponses
différentes à « ce chauffeur a-t-il pris cette course ? » finiraient par diverger,
et la version divergente serait celle que personne ne teste.

Fait **sans migration** : `request_events` existe déjà, et une jointure interne
PostgREST (`request_events!inner`) exprime la règle. `listAcceptedDriverRequests()`
est le seul endroit où elle vit ; `/dashboard/driver/history` et
`/dashboard/driver/performance` l'appellent. `earnings` n'était pas touché — il
filtrait déjà sur `completed` seul.

Audit, dispatch, confidentialité 5.1 et reçus : inchangés.

---

## 7. Répartiteur — policy RLS minimale

`requests` n'était lisible que par son client, son chauffeur assigné ou un admin
— et un répartiteur n'est aucun des trois. L'onglet « Courses » du tableau de
bord entreprise revenait donc **vide pour exactement la personne dont c'est le
métier**.

Migration 0030 :

```sql
create policy "requests: company managers read their company's jobs" on requests
  for select using (
    driver_id is not null
    and is_company_manager(driver_company_id(driver_id))
  );
```

Ce qu'elle expose : type de service, ramassage, destination, statut, prix — ce
dont un répartiteur a besoin.
Ce qu'elle **n'expose pas** : l'identité du client. `profiles` reste gouverné par
la règle Phase 5.1, qui exige d'être participant d'une course matchée, et un
répartiteur ne l'est pas. Un répartiteur voit la course sans voir qui est le
client — c'est le bon découpage pour un rôle de back-office, et c'est asserté.

Aucun chemin inter-entreprises : `driver_company_id()` résout la compagnie du
chauffeur depuis `company_members`, et `is_company_manager()` n'est vrai que pour
owner/admin/dispatcher de **cette même** compagnie.

---

## 8. Migrations

| Fichier | Contenu |
|---|---|
| `0029_ontario_zone_geometries.sql` | 15 zones ontariennes avec géométrie, opérateurs repointés, ligne programme retirée, note Québec |
| `0030_dispatcher_visibility_and_tow_certificate.sql` | policy répartiteur + type de document `tow_certificate` |
| `0031_ontario_document_requirements.sql` | les 2 règles ontariennes vérifiées |
| `0032_zone_geojson_for_inspection.sql` | `regulated_zone_geojson()` pour l'inspection admin |

Toutes additives, toutes appliquées au projet réel, toutes **vérifiées par effet
en base**.

Note d'exécution honnête : l'éditeur SQL du tableau de bord Supabase ne s'est pas
chargé pendant cette session — Monaco diffère son initialisation tant que
l'onglet est `visibilityState: "hidden"`, et l'onglet ne pouvait pas être mis au
premier plan. 0029 (uniquement du DML) a été appliqué via PostgREST avec la clé
service_role, qui accepte l'EWKT pour une colonne `geography` ; le DDL de
0030/0032 a été appliqué via l'API Management v1 (`POST
/v1/projects/{ref}/database/query`) avec la session du tableau de bord déjà
ouverte dans le navigateur de l'utilisateur. Aucun secret n'a été affiché,
journalisé ni commité. Les fichiers `.sql` restent la référence pour un
environnement neuf.

---

## 9. Tests

| Commande | Résultat |
|---|---|
| `npx tsc --noEmit` | ✅ |
| `npm run lint` | ✅ |
| `npm run build` | ✅ — 25 routes |
| `npm run test` | ✅ 30/30 |
| `npm run test:integration` | ✅ **167/167** (147 → 167) |
| `npm run verify:phase6` | ✅ 37/37 |
| `npm run verify:phase6_1` | ✅ **32/32** (nouveau) |
| Validation GPS (`scripts/geodata/validate_zones.py`) | ✅ **80/80** |

Les 147 assertions RLS existantes restent vertes. Les 20 nouvelles couvrent : la
détection sur la géométrie ontarienne **réelle** (deux tronçons distincts de la
401 résolvant vers deux zones distinctes), l'absence totale d'effet sur Montréal
et Longueuil, le refus de dispatch dans une zone en vigueur **même avec un
chauffeur en ligne posé dessus**, la visibilité répartiteur dans les deux sens,
la non-fuite du profil client vers un répartiteur, l'historique chauffeur (offre
annulée exclue / mission acceptée puis annulée conservée), les exigences
documentaires ON vs QC, et le fait qu'une frontière non activée ne fuit pas vers
un non-admin.

Un échec réel a été trouvé et corrigé en cours de route : la seconde acceptation
du test historique était silencieusement bloquée par
`requests_one_active_job_per_driver` — le test échouait pour une raison sans
rapport avec l'historique. Le garde-fou « les deux demandes portent bien le même
`driver_id` » était initialement un `pass: true` vide ; il vérifie maintenant
réellement les deux lignes.

`verify-phase6.ts` a été mis à jour là où Phase 6.1 a rendu ses assertions
fausses (« les deux zones sont inactives », « aucune exigence documentaire ») —
remplacées par l'invariant qui survit aux deux phases : *rien n'est actif sans
géométrie ni provenance déclarée*, et *toute règle qui bloque un chauffeur nomme
sa source*.

---

## 10. Limitations

1. **Le Québec reste inactif** — et c'est la province de lancement. Le moteur ne
   protège donc aujourd'hui aucun client réel de TowConnect ; il protège
   l'Ontario, où TowConnect n'opère pas encore. Point ouvert n°1.
2. **Aucune exigence documentaire québécoise** vérifiée, pour la même raison de
   source. Point ouvert n°2.
3. **Les frontières ontariennes sont dérivées, pas officielles.** Marquées comme
   telles partout. Elles devraient être soumises au MTO pour validation avant
   d'être traitées comme du droit.
4. **Faux positifs résiduels aux viaducs** : ~30 m au droit de chaque passage
   supérieur d'artère au-dessus d'une autoroute. Mesuré (0,95 % sur 2000
   segments, la majorité étant des bretelles correctement incluses), non éliminé.
   Le réduire demanderait des polygones d'emprise plutôt que des tampons d'axe.
5. **Zone 3A courte de ~4 km** (35,76 km dérivés contre ~40 attendus) : la
   composante ORN retenue s'arrête avant la borne exacte de la route 9. Sous-
   couverture, donc côté « on pourrait dispatcher là où il ne faudrait pas ».
6. **L'assurance n'est exigée nulle part**, faute de source — alors que c'est
   probablement une obligation réelle.
7. **`requires_expiry = false`** sur le certificat de remorqueur : renouvelé aux
   3 ans, mais ontario.ca ne dit pas que la date doit être au dossier.
8. L'éditeur SQL du tableau de bord n'a pas fonctionné (voir §8) ; les
   migrations sont appliquées et vérifiées, mais par une voie inhabituelle.

---

## 11. Recommandations Phase 7

1. **Obtenir du MTMD l'étendue du territoire de remorquage exclusif** — la liste
   des autoroutes et des tronçons de rive visés. C'est un courriel, pas un projet
   de développement, et c'est ce qui débloque la protection dans la zone où
   TowConnect opère réellement.
2. **Vérifier les obligations documentaires québécoises** auprès de la SAAQ ou du
   MTMD et remplir `document_requirements`. Une ligne suffit à activer toute la
   chaîne.
3. **Soumettre les 15 frontières ontariennes au MTO** ; si elles sont confirmées,
   passer `geometry_confidence` à `official_geospatial`.
4. Corriger la sous-couverture de la zone 3A vers la route 9.
5. Éditeur cartographique pour dessiner et corriger une frontière dans l'admin,
   plutôt que de repasser par le script.
6. Toujours hors périmètre : commission, Stripe Connect, payouts, pricing réel,
   Safety Link, push, abonnements, referral.
