# TowConnect — Phase 6 : zones réglementées, Business/Flotte, architecture tarifaire

Date : 2026-09-01. Reprise depuis `TOWCONNECT_PHASE5_REPORT.md` et
`TOWCONNECT_BRAND_REFRESH_REPORT.md`. Phase 7 n'est pas commencée.

---

## 0. La règle qui gouverne tout le reste

```
réglementation → sécurité/conformité → compatibilité du service → disponibilité → ETA → préférence commerciale
```

Cet ordre n'est pas un commentaire : c'est la structure du code. Dans
`dispatch_candidates()` (0026), les cinq premiers niveaux sont des **filtres**,
et le score ne classe que des candidats qui les ont déjà tous passés. La
préférence commerciale est lue **après**, sur un gagnant déjà légal, conforme
et compatible.

C'est la raison structurelle pour laquelle une préférence commerciale ne peut
pas contourner une restriction légale : au moment où on la consulte, les
candidats illégaux ont déjà disparu de la liste. Ce n'est pas une promesse,
c'est une assertion testée (§9, invariant 11).

---

## 1. Zone Engine — architecture

### 1.1 Modèle

`0023_regulated_zones.sql` :

| Objet | Rôle |
|---|---|
| `regulated_towing_zones` | la règle : juridiction, type de restriction, mode de répartition, géométrie PostGIS, **source officielle obligatoire**, dates d'effet, dernière vérification, instruction FR/EN, téléphone de l'autorité, précédence |
| `regulated_zone_providers` | qui est **légalement** autorisé. Jamais une liste de préférence commerciale |
| `regulated_zone_audit` | journal append-only, écrit par trigger |
| `regulated_zone_for_point(lat,lng)` | le point d'entrée unique de la détection |
| `company_authorized_for_zone(company,zone)` | l'autorisation, à la date du jour |

Quatre modes de répartition, dont aucun n'est spécifique au Québec :
`authorized_provider_only`, `external_authority_required`,
`manual_instruction_only`, `restricted_network`.

### 1.2 Le garde-fou anti-fabrication

```sql
constraint regulated_zone_active_requires_geometry check (
  not active or (geometry is not null and geometry_confidence <> 'none')
)
```

Une zone **ne peut pas** être activée sans limite géospatiale et sans
provenance déclarée. Ce n'est pas une convention d'équipe : la base refuse
l'`UPDATE`. Vérifié en conditions réelles :

```
activating a geometry-less zone -> BLOCKED: violates check constraint
                                   "regulated_zone_active_requires_geometry"
```

L'interface admin reflète la même règle : le bouton « Activer » est
`disabled` pour les deux zones seedées (vérifié : `[{disabled:true},{disabled:true}]`).

### 1.3 Détection et horodatage

Un trigger `BEFORE INSERT` sur `requests` estampille la zone détectée
(`regulated_zone_id`, `regulated_zone_mode`, `regulated_dispatch_state`,
`regulated_zone_checked_at`). En `BEFORE INSERT`, donc **jamais fourni par le
client** : ce que le navigateur envoie dans ces colonnes est écrasé par ce que
PostGIS dit des coordonnées. Le garde 0014 a été étendu pour que la session
d'un chauffeur ne puisse pas les modifier non plus.

Le dispatch ré-évalue la règle **en direct** à chaque tentative plutôt que de
faire confiance à l'estampille : si une zone est activée pendant qu'une demande
cherche, la nouvelle règle s'applique immédiatement et l'estampille est
rafraîchie. La réglementation d'abord, y compris rétroactivement sur une
demande en vol.

### 1.4 État de la demande

Un enum dédié `regulated_dispatch_state` plutôt que de nouvelles valeurs dans
`request_status` : `not_applicable`, `awaiting_external_authority`,
`authorized_provider_search`, **`restricted_capacity_wait`**,
`manual_instruction`. `request_status` pilote la machine
accept/en_route/arrived/completed, ses garde-fous et ses index uniques ;
y mêler la détection légale aurait obligé à re-raisonner sur chacun.

---

## 2. Sources officielles — et ce qu'elles ne donnent pas

### 2.1 Ce qui a été trouvé

**Québec** — [Exclusive towing in metropolitan Montréal, Gouvernement du Québec](https://www.quebec.ca/en/transports/traffic-road-safety/road-network/exclusive-towing-metropolitan-montreal)

Fait déterminant, et **récent** : depuis le **1er juin 2026**, les lignes
`*4141` / `310-4141` sont retirées et l'automobiliste doit composer le **911**.
La page est explicite sur l'obligation : « You are obligated to use the
services of the designated towing company for the area in which you break down
or have an accident. » Le territoire couvre l'île de Montréal, l'île de Laval,
des sections des rives Nord et Sud, et les ponts de juridiction provinciale.
Le tarif inclut 10 km et 60 minutes ; le client retrouve son libre choix dès
que le véhicule a quitté la zone.

→ Mode `external_authority_required`, téléphone `911`, `effective_from`
2026-06-01.

**Ontario** — [Tow Zone Program, Government of Ontario](https://www.ontario.ca/page/tow-zone-program)

15 zones de remorquage restreint dans la région du Grand Toronto et Hamilton,
sur les autoroutes 401, 403, 404, 409, 410, 400, 427 et la QEW. « Only
authorized companies can provide towing service in the restricted towing
zones, and each company is assigned a specific zone. » Procédure : 911 en
urgence ou si le véhicule ne peut pas quitter la voie, sinon **511**, option
Tow Zone Program.

→ Mode `external_authority_required`, téléphone `511`. **Les 15 opérateurs
contractés sont enregistrés tels que publiés** (Abrams Towing, Bob's Towing,
William's Towing Service, Classic Towing & Storage Service, A.Z. Towing,
C.A. Towing, COMTOW, Lyon's Towing, Fellow's Towing, Pacific Towing and
Recovery, Bill & Son Towing, JP Towing Service & Storage Ltd., ABC Towing,
JKM Towing Inc., A Action Towing and Recovery Inc.), chacun avec l'URL et le
titre de la source et la date de lecture.

Ils sont enregistrés avec `company_id = NULL`. Aucun de ces opérateurs n'est
une entreprise TowConnect, et leur en inventer une aurait transformé un fait
officiel en partenariat imaginaire. Vérifié : `no official operator was
invented as a TowConnect company`.

### 2.2 Ce qui n'existe pas — et pourquoi les deux zones sont INACTIVES

**Aucune des deux juridictions ne publie de limite géospatiale.**

- **Québec** décrit le territoire en prose et renvoie à une image de carte.
  Données Québec n'a aucune couche correspondante.
- **Ontario** définit chaque zone comme un segment d'autoroute entre deux
  croisements nommés (« Highway 401 from Highway 400 to Highway 404 ») et
  renvoie à la carte interactive Ontario 511. Ontario GeoHub ne publie pas de
  couche de zones de remorquage, et l'API ouverte d'Ontario 511 — **sondée
  directement le 2026-09-01** — retourne 404 sur les points d'accès de zones
  alors qu'elle sert bien les événements :

```
GET https://511on.ca/api/v2/get/event                 -> 200  (633 362 octets)
GET https://511on.ca/api/v2/get/towzones              -> 404
GET https://511on.ca/api/v2/get/restrictedtowzones    -> 404
```

Transformer ces descriptions en polygone à la main aurait produit une limite
qui **a l'air** officielle sans l'être. Chaque faux positif refuse à un
automobiliste en panne le service qu'il est venu chercher, et pour le Québec
l'erreur serait grossière : le territoire vise le **réseau autoroutier**, pas
l'île entière — approximer par le contour de l'île refuserait le service à
toutes les rues résidentielles de Montréal.

Les deux zones sont donc livrées :

| | active | geometry | geometry_confidence | mode | tél. |
|---|---|---|---|---|---|
| QC — Remorquage exclusif Montréal | ❌ | NULL | `none` | `external_authority_required` | 911 |
| ON — Restricted Towing Zones (GTHA) | ❌ | NULL | `none` | `external_authority_required` | 511 |

Le `geometry_note` de chaque ligne contient le constat ci-dessus **dans la base
de données**, pas seulement dans ce rapport, et il est affiché dans l'écran
admin.

**Niveau de confiance** — l'enum `zone_geometry_confidence` distingue
`official_geospatial`, `derived_from_official_text`,
`approximate_pending_validation` et `none`. Rien ne peut être promu
silencieusement : c'est une colonne, elle est affichée, et le CHECK l'exige
pour activer.

### 2.3 Ce qu'il faut pour les activer

Une géométrie vérifiée par zone. Le chemin concret : obtenir les tracés
d'autoroutes officiels (Adresses Québec / réseau routier MTMD ; Ontario Road
Network sur GeoHub), découper les segments entre les bornes nommées, appliquer
un tampon, faire valider la limite par la juridiction, puis renseigner
`geometry` + `geometry_confidence` et activer. Aucun code applicatif ne change :
tout est déjà branché.

---

## 3. Business / Flotte

`0024_companies_fleet.sql` :

- **`companies`** étendue : `display_name`, `status`, `phone`, `email`,
  `province`, `address`, `updated_at`. Rien de collecté « au cas où ».
- **`company_members`** — source de vérité de l'appartenance
  (`owner` / `admin` / `dispatcher` / `driver`).
  `driver_profiles.company_id` (0020) devient un **miroir dérivé** maintenu par
  trigger, et le dispatch lit `driver_company_id()`, pas le miroir. Motif :
  un propriétaire ou un répartiteur n'est pas un chauffeur et n'a aucune ligne
  `driver_profiles` sur laquelle accrocher un `company_id`.
- **`fleet_vehicles`** — type de camion, plaque, province, statut et
  **capacités** (`flatbed`, `wheel_lift`, `heavy_duty`, `winch`, `boost`,
  `lockout`, `tire_change`, `fuel_delivery`, `recovery`).
- **`driver_vehicle_assignments`** — une affectation active par chauffeur et
  par camion (index uniques partiels). **Aucun chemin d'auto-affectation** :
  les policies sont réservées aux gestionnaires, et un trigger refuse en plus
  tout appariement inter-entreprises — y compris pour le `service_role`, parce
  qu'un chauffeur derrière le camion d'une autre compagnie est faux quel que
  soit l'auteur de l'écriture.
- **`company_service_areas`** — rayon ou polygone, avec
  `company_covers_point()`. **Une entreprise sans zone déclarée n'est pas
  restreinte** : le silence veut dire « aucune restriction énoncée », pas
  « ne sert nulle part » — lire une config vide comme un refus aurait mis tous
  les opérateurs existants hors ligne le jour de la migration.

Une zone de service ne peut que **restreindre** où une entreprise reçoit des
offres. Elle ne donne jamais accès à une zone réglementée — c'est écrit dans
le commentaire SQL de la fonction et affiché dans le dashboard.

### 3.1 Anti-récursion RLS

Toute policy demandant « le demandeur est-il dans cette entreprise ? » passe
par un helper `SECURITY DEFINER` (`is_company_member`, `is_company_manager`,
`is_company_owner_or_admin`, `company_role_of`, `driver_company_id`). Une
policy sur `company_members` qui interrogerait `company_members` récurse à
l'infini — le même piège que 0004 a dû corriger sur `profiles`.

---

## 4. Smart Dispatch V2

`0026_smart_dispatch_v2.sql`. Ce que V1 collectait sans l'utiliser est
maintenant utilisé.

### 4.1 Compatibilité de service — et la nuance qui compte

`service_type_requirements` mappe chaque type de problème vers des capacités,
**configurable sans redéploiement** (batterie → `boost`, panne sèche →
`fuel_delivery`, accident → `flatbed|heavy_duty|recovery`, `other` → aucune).

`driver_service_compatibility()` répond l'une de quatre choses :

| Réponse | Effet |
|---|---|
| `compatible` | éligible, **+0.15** au score |
| `incompatible` | **exclu** |
| `unknown` | éligible, aucun bonus |
| `not_required` | éligible, aucun bonus |

Les preuves, de la plus forte à la plus faible : (1) les capacités du camion de
flotte assigné, (2) les types de service déclarés par le chauffeur lui-même
(Phase 5), (3) le type de camion déclaré.

**(1) et (2) suffisent pour exclure. (3) non.** `vehicle_type` dit quel genre
de camion c'est, pas ce qu'il y a dans le coffre : un camion « standard » qui
transporte un survolteur ne doit pas être écarté des demandes de batterie sur
une déduction. Elle peut donc **accorder** la compatibilité, jamais la nier.
Conséquence pratique : les chauffeurs Phase 5 qui n'ont rien déclaré reçoivent
exactement le travail qu'ils recevaient avant cette migration — la migration
ne met personne au chômage silencieusement.

### 4.2 Fin du 5.0 gratuit

`driver_profiles.rating` vaut 5.0 par défaut et `total_services` 0 : un
chauffeur neuf marquait donc le **maximum théorique** sur le terme de note,
mieux qu'un chauffeur à 200 courses et 4.8. Ce n'est pas un départ neutre,
c'est une prime au fait de n'avoir aucun historique.

Correctif : rétrécissement vers la moyenne de la plateforme.

```
effective = (rating × n + moyenne × K) / (n + K),  K = 5
```

- `n = 0` → exactement la moyenne des chauffeurs notés : **ni bonus ni
  pénalité**.
- `n` grandit → sa vraie note reprend le dessus.
- Aucun chauffeur noté sur la plateforme → tout le monde reçoit la même valeur
  et le terme **disparaît de la comparaison**.

`K` est une constante documentée dans une seule fonction — « combien de
courses avant que la moyenne d'un chauffeur pèse plus que celle de la
plateforme » — pas une note attribuée à quiconque. Mesuré en direct :

```
driver_effective_rating(5.0,   0, 4.5) = 4.5      <- chauffeur neuf : la moyenne
driver_effective_rating(4.8, 200, 4.5) = 4.79268  <- vétéran : sa propre note
```

`driver_rating_population_mean()` ne compte que les chauffeurs avec
`total_services > 0` : inclure les 5.0 par défaut gonflerait la moyenne même
qu'ils sont censés être mesurés contre.

### 4.3 Préférence commerciale — volontairement faible, volontairement éteinte

`dispatch_partner_preferences` : `head_start_seconds` **plafonné à 60 et par
défaut à 0**. Une ligne créée sans décision explicite ne change donc
strictement rien.

Le partenaire préféré remplace le meilleur candidat **uniquement si** il est
lui-même entièrement éligible, à moins de `preferred_partner_max_extra_km()`
(3 km) de distance supplémentaire, et si la demande est encore dans sa fenêtre.
Sinon le client garde le camion légal le plus rapide. La préférence est lue
après tous les filtres : elle ne peut rendre légal un candidat illégal,
compatible un camion incompatible, ni dispatchable un chauffeur non conforme.

Aucune exclusivité absolue n'est vendue dans la logique produit.

### 4.4 Explicabilité

`dispatch_candidates()` produit **une seule fois** la liste des candidats,
l'éligibilité de chacun, **la première règle échouée dans l'ordre de priorité**
et le score. `dispatch_next_candidate_core()` en prend la première ligne
éligible ; `explain_dispatch_candidates()` (admin) affiche tout. La vue d'audit
**ne peut pas** diverger de ce que le dispatch a fait : c'est la même requête.

Motifs d'exclusion possibles, dans l'ordre où ils sont évalués :
`regulated_zone_not_authorized`, `documents_not_in_good_standing`,
`service_not_compatible`, `outside_company_service_area`, `already_on_a_job`,
`stale_heartbeat`, `already_offered_this_request`.

Chaque offre porte en plus un `decision jsonb` : distance, note effective,
compatibilité, zone, autorisation, entreprise, **si la préférence commerciale
a joué**, et le rayon utilisé.

### 4.5 Surcharge en zone réglementée

Si les fournisseurs autorisés d'une zone sont tous occupés, la demande passe à
`restricted_capacity_wait` et le client voit :

> **Forte demande dans cette zone réglementée**
> TowConnect suit la procédure autorisée pour trouver l'intervention
> disponible la plus rapide.

**Sans délai estimé** — nous n'en avons pas, et en inventer un serait exactement
le faux ETA que le brief interdit. Aucun remorqueur non autorisé n'est jamais
envoyé par simple préférence de vitesse.

---

## 5. Architecture tarifaire — et zéro chiffre inventé

`0027_pricing_architecture.sql`.

- **`platform_pricing_config`** — une seule ligne, **entièrement NULL** :
  `commission_percent`, `commission_fixed`, `provider_minimum`,
  `payment_processing_percent`, `payment_processing_fixed`.
- **`pricing_rules`** — la forme complète d'un futur moteur (frais de base,
  prix/km, minimums, pourcentage, montant fixe, plafond ; portée par province,
  zone réglementée, entreprise, type de service, équipement, jour, heure).
  **Zéro ligne, `active` par défaut à `false`**, et un CHECK refuse d'activer
  une règle sans valeur : une règle vivante qui ne dit rien est un piège, elle
  a l'air configurée et ne fait rien.
- **`request_economics`** — la vue qui expose les quatre noms demandés
  (`customer_price`, `provider_compensation`, `towconnect_margin`,
  `payment_processing_cost`) au-dessus des colonnes qui les portent déjà depuis
  0012, plus la seule qui manquait vraiment. Renommer aurait touché le reçu,
  le webhook, l'historique et la capture Stripe pour zéro gain fonctionnel.
  `economics_status` distingue **`not_configured`** de « calculé et nul ».
- **`request_provider_compensation()`** retourne **NULL** tant qu'aucun taux
  n'existe, précisément pour que chaque appelant doive décider quoi afficher
  pour « inconnu » au lieu de recevoir un zéro plausible. L'interface chauffeur
  n'affiche rien.

Vérifié : `pricing_configured() = false`, toutes les colonnes NULL, une règle
active sans valeur refusée, aucune règle en vigueur.

### 5.1 Suppléments — aucune surprise possible

`request_supplements` + `service_supplement_types` (treuillage, récupération
complexe, changement de destination, temps d'attente, autre).

La règle produit est « aucun supplément surprise ». La règle base de données
qui la rend vraie :

- seul le chauffeur assigné peut **proposer**, et seulement en `proposed` ;
- **seul le client** peut approuver ou refuser — un trigger, pas une policy,
  parce qu'une policy ne peut pas exprimer « celui qui paie décide » ;
- un supplément **approuvé est gelé** : montant, type et origine ne bougent
  plus ;
- le chauffeur peut retirer sa propre proposition non répondue.

Testé sur les quatre chemins (§9).

---

## 6. Conformité documentaire

`0025_document_compliance.sql`.

**`document_requirements` est livrée VIDE.** Personne sur ce projet n'a
vérifié ce que le Québec ou l'Ontario exigent réellement d'un remorqueur, et
deviner serait exactement le fait inventé que cette phase doit empêcher. La
mécanique est complète et exécutoire dès qu'une règle vérifiée est saisie ;
d'ici là elle ne bloque personne. Vérifié : `count = 0`.

**L'expiration est calculée, pas stockée.** Une tâche nocturne qui bascule
`status` en `expired` rend l'application aussi fraîche que la dernière
exécution, et une exécution manquée laisse repartir un permis expiré.
`driver_document_effective_status()` dérive l'expiration de la date **au moment
de la lecture** : la réponse est juste à l'instant où on la pose, sans
ordonnanceur dans le chemin de confiance. `expire_driver_documents()` existe
pour la cosmétique de la colonne, et rien de sécuritaire n'en dépend.

Deux points d'application : `blocks_dispatch` exclut des offres,
`blocks_online` refuse la mise en ligne (trigger `BEFORE UPDATE`, uniquement
sur la transition vers en ligne — un chauffeur déjà en ligne dont un document
expire en cours de quart n'est pas éjecté d'une mission en cours, il cesse
simplement de recevoir du nouveau travail).

---

## 7. UX client

**La vérification réglementaire a lieu AVANT l'engagement**, pas après.
Confirmer d'abord aurait autorisé une carte pour une intervention qu'aucun
camion TowConnect ne peut légalement prendre, puis expliqué le problème
ensuite.

Dans une zone dont la règle interdit la répartition, **le bouton de
confirmation n'existe pas** — il n'est pas grisé. Un bouton désactivé suggère
encore que TowConnect pourrait le faire pour vous en réessayant.

Le panneau affiche : la zone détectée, l'instruction officielle **stockée
verbatim par langue**, le bouton d'appel vers le numéro publié, l'autorité, le
**lien vers la source officielle** et la date de vérification. Rien n'est
composé à la volée : une instruction légale paraphrasée est la façon dont
quelqu'un finit par appeler le mauvais numéro.

`StepTracking` couvre aussi le cas où une zone est activée pendant qu'une
demande cherche : le dispatch réévalue en direct et l'écran suit — « recherche
en cours » serait un mensonge quand rien ne cherche et que rien n'arrivera.

Aucun faux ETA, aucun faux chauffeur disponible, aucun faux prix, aucun faux
fournisseur autorisé.

---

## 8. Dashboards

**Business** (`/dashboard/business`) — chauffeurs et leur disponibilité réelle,
véhicules et leur équipement, affectation chauffeur↔camion, courses, zones de
service, autorisations en zone réglementée. Un membre `driver` y accède en
lecture seule ; owner/admin/dispatcher peuvent agir.

L'accès Business est **une appartenance, pas un quatrième `user_role`** :
ajouter une valeur à l'enum aurait touché `handle_new_user()`, `roleHome` et
chaque policy indexée sur le rôle, pour moins de précision que
`company_members` n'en donne déjà.

**Admin zones** (`/dashboard/admin/zones`) — chaque zone avec son mode, son
niveau de confiance géométrique **en rouge quand il vaut `none`**, sa source
cliquable, sa date de vérification, sa note d'écart, ses fournisseurs
autorisés, un rattachement à une entreprise TowConnect, et le journal d'audit.
Bouton « Activer » désactivé tant qu'il n'y a pas de géométrie.

Le journal est écrit par un trigger et **aucun rôle, administrateur compris,
n'a de policy permettant d'en supprimer une ligne**. Un admin peut supprimer
une zone ; il ne peut pas supprimer la trace qu'il l'a supprimée, ni ce que sa
source disait alors.

---

## 9. Sécurité / RLS

**147 assertions, 0 échec** (107 avant cette phase → 147). Les 107 existantes
restent vertes, y compris toutes celles de la Phase 5.1 — ce qui compte,
puisque 0028 élargit `profiles`.

Les onze invariants demandés, chacun couvert :

| # | Invariant | Assertion |
|---|---|---|
| 1 | entreprise A ne lit jamais entreprise B | ✅ ligne entreprise + effectif |
| 2 | chauffeur A ne lit pas la flotte B | ✅ + contre-preuve : il lit bien la sienne |
| 3 | chauffeur ne s'autoassigne pas à une compagnie étrangère | ✅ + ne se promeut pas dans la sienne |
| 4 | chauffeur ne modifie pas ses autorisations réglementaires | ✅ + une entreprise ne s'autoautorise pas |
| 5 | client ne voit pas les données internes d'une compagnie | ✅ effectif, flotte, entreprises : 0 |
| 6 | dispatcher ne voit que sa compagnie | ✅ exactement une |
| 7 | zone réglementée bloque le chauffeur non autorisé | ✅ aucune offre en `external_authority_required` |
| 8 | compatible mais non autorisé → exclu | ✅ `regulated_zone_not_authorized` |
| 9 | autorisé mais incompatible → exclu | ✅ `service_not_compatible` |
| 10 | autorisé **et** compatible → éligible | ✅ |
| 11 | le fallback commercial ne contourne jamais la réglementation | ✅ partenaire préféré toujours exclu, **et** l'offre part au chauffeur autorisé |

Plus, au-delà de la liste : le `service_role` lui-même ne peut pas créer une
affectation inter-entreprises ; une zone sans géométrie ne s'active pas ; un
admin ne peut pas effacer une ligne d'audit ; un chauffeur ne peut pas lire la
vue d'explication du dispatch ; un chauffeur non conforme ne peut pas se mettre
en ligne ; les quatre chemins de supplément.

Les tests créent une **zone active** : elle est placée à 51.0 / -68.0, dans le
nord inhabité du Québec, et supprimée à la fin — une zone de test active
au-dessus d'une vraie ville refuserait le service à de vraies personnes. Une
assertion de teardown vérifie qu'il n'en reste aucune.

---

## 10. Migrations

| Fichier | Contenu |
|---|---|
| `0023_regulated_zones.sql` | zones, fournisseurs autorisés, audit, détection, estampille sur `requests`, seed QC + ON |
| `0024_companies_fleet.sql` | companies étendue, memberships, flotte, affectations, zones de service |
| `0025_document_compliance.sql` | exigences documentaires configurables, expiration calculée, blocage en ligne/dispatch |
| `0026_smart_dispatch_v2.sql` | exigences de service, compatibilité, note neutre, préférence partenaire, `dispatch_candidates()`, dispatch V2, vue d'explication |
| `0027_pricing_architecture.sql` | config tarifaire vide, règles de prix, vue économique, suppléments |
| `0028_company_roster_visibility.sql` | correctif trouvé en vérification manuelle (§11) |

Toutes additives, toutes appliquées au projet réel et **vérifiées par effet en
base**, pas par une bannière « Success ».

---

## 11. Un bug trouvé en marchant l'écran

Le dashboard Business affichait sa liste de chauffeurs ainsi :

```
—  ·  Hors ligne  ·  Non assigné
```

Le bon nombre de lignes, aucune information. La Phase 5.1 avait — correctement
— restreint `profiles` aux participants d'une course **matchée**, et la Phase 6
demandait ensuite à un employeur d'afficher son propre personnel : une relation
qui n'existait pas quand cette policy a été écrite. Même chose pour
`driver_profiles`, dont 0002 réservait les données live au chauffeur lui-même,
à un admin, ou au client de la course active.

`0028_company_roster_visibility.sql` ajoute deux policies **en lecture seule**,
réservées à `owner` / `admin` / `dispatcher` de **la même** entreprise. Pas à
tous les membres : un répartiteur a besoin du nom et du téléphone d'un
chauffeur pour faire tourner la journée, un autre chauffeur non. C'est le plus
petit élargissement qui fait fonctionner la fonctionnalité — le seul genre qui
vaille sur une policy de confidentialité.

Après correctif : `P6 driver | Hors ligne | pending | Non assigné`.

Un second défaut, trouvé au même endroit : `toLocaleDateString()` produisait
une hydratation divergente entre Node et le navigateur sur l'écran admin
(badge « 1 Issue » de Next). Remplacé par un formatage déterministe
(`src/lib/formatDate.ts`) ; badge absent après correctif.

---

## 12. Tests

| Commande | Résultat |
|---|---|
| `npx tsc --noEmit` | ✅ |
| `npm run lint` | ✅ |
| `npm run build` | ✅ — 25 routes |
| `npm run test` | ✅ 30/30 |
| `npm run test:integration` | ✅ **147/147** (107 → 147) |
| `npm run verify:phase6` | ✅ **37/37** (nouveau) |

`scripts/verify-phase6.ts` est le nouveau script de vérification
d'infrastructure. Il n'affirme rien sur la foi d'un statut HTTP : il vérifie
que le schéma existe, que les zones sont bien inactives et sans géométrie, que
le CHECK d'activation refuse réellement, que les 15 opérateurs ontariens sont
là **sans company_id**, que la note d'un chauffeur neuf vaut la moyenne et non
5.0, qu'aucun taux de commission n'est configuré, qu'aucune exigence
documentaire n'est supposée, et qu'aucun résidu de test ne traîne.

### Vérification manuelle

Les sept scénarios du brief, sur serveur réel :

| # | Scénario | Résultat |
|---|---|---|
| 1 | demande **hors** zone réglementée | ✅ aucun panneau, bouton « Confirmer et trouver un remorqueur » présent |
| 2 | demande **dans** une zone réglementée | ✅ instruction + « Appeler le 911 », `hasConfirm: false` |
| 3 | fournisseur autorisé | ✅ éligible, reçoit l'offre |
| 4 | fournisseur non autorisé | ✅ exclu, motif `regulated_zone_not_authorized` |
| 5 | compagnie avec plusieurs chauffeurs | ✅ effectif, disponibilité, statut d'approbation |
| 6 | camion compatible / incompatible | ✅ affectation chauffeur↔camion, exclusion sur équipement |
| 7 | dashboard Business | ✅ 5 onglets, actions gestionnaire fonctionnelles |

La zone de test manuelle a été placée sur **Fermont, QC** — à ~900 km de la
zone de lancement Montréal & Rive-Sud — pour qu'une zone active de test ne
puisse refuser le service à aucun client réel pendant qu'elle existait. Retirée
ensuite, et `verify:phase6` confirme qu'il n'en reste rien.

---

## 13. Limitations

1. **Les deux zones officielles sont inactives, faute de limite géospatiale
   publiée.** C'est la limitation principale de la phase, et elle est visible
   partout : dans la base, dans l'admin, dans ce rapport. Le moteur est
   complet ; ce qui manque est une donnée qu'aucune des deux juridictions ne
   publie sous forme géospatiale.
2. **L'Ontario est modélisé comme une seule ligne au niveau du programme.**
   Les 15 zones ont chacune un opérateur distinct ; les activer indépendamment
   demandera une ligne et une géométrie par zone. La structure le supporte
   déjà (`zone_code`, `precedence`).
3. **`document_requirements` est vide** — aucune obligation légale n'est
   supposée pour aucune province. La mécanique ne bloque donc personne
   aujourd'hui.
4. **Aucun taux de commission**, donc `provider_compensation` reste NULL et
   l'offre chauffeur n'affiche aucun montant partenaire. Conforme au brief.
5. **Les zones de service Business sont saisies en rayon uniquement.** Le
   polygone est supporté par le schéma et par `company_covers_point()`, mais
   le dessiner demande un éditeur cartographique — saisir un polygone à la
   main produirait une limite fausse, exactement ce que §2.2 refuse.
6. **Le dashboard dispatcher liste les courses via les chauffeurs de
   l'entreprise.** La policy `requests` n'expose une course qu'à son client, à
   son chauffeur assigné ou à un admin ; élargir cela méritait sa propre
   décision plutôt que d'être glissé ici.
7. **`preferred_partner_max_extra_km()` = 3 km et `K` = 5** sont des constantes
   d'ingénierie documentées, pas des décisions d'affaires validées. Elles sont
   chacune dans une fonction dédiée, modifiables en un endroit.
8. Le géocodage Mapbox reste biaisé au Canada entier (`country=ca`) — paramètre
   technique, pas une promesse de couverture.

---

## 14. Recommandations Phase 7

1. **Obtenir les géométries officielles** et activer les zones — le seul
   travail qui transforme cette phase en protection réelle plutôt qu'en
   machinerie prête. Commencer par l'Ontario, dont les bornes sont nommées et
   donc dérivables du réseau routier ; le Québec demandera une validation
   auprès du MTMD.
2. **Vérifier les obligations documentaires** par province auprès d'une source
   officielle, puis remplir `document_requirements`. Une ligne suffit à
   activer toute la chaîne.
3. **Décider le taux de commission**, remplir `platform_pricing_config`, et
   l'affichage « Vous recevrez X » s'allume de lui-même.
4. **Une ligne par zone ontarienne**, rattachée à son opérateur contracté déjà
   enregistré.
5. **Éditeur cartographique** pour les polygones (zones de service Business et
   géométries réglementées) — le même composant sert les deux.
6. Revisiter la bizarrerie préexistante notée en Phase 5.1 : une course
   annulée alors que le chauffeur n'avait qu'une offre reste dans son
   historique.
7. Hors périmètre de cette phase et toujours à faire : Stripe Connect, payouts,
   Safety Link, notifications push, abonnements, referral, heatmap, IA de
   dispatch, expansion nationale.
