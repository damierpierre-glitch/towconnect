# TowConnect — Phase 5 : expérience chauffeur/provider premium

Date : 2026-09-01
Aucune valeur de secret ne figure dans ce document.

---

## Verdict

**Complétée.** Les dix volets demandés (onboarding, documents, profil, online/offline, offre, mission active, revenus, historique, performance, admin) sont livrés et vérifiés — en base (RLS live, 78 → **92** assertions) et à l'écran (parcours réel sur le serveur de dev : inscription → onboarding → envoi de document → approbation admin → mission active de bout en bout, y compris la carte, les liens de navigation et le chat).

Deux défauts réels ont été trouvés en construisant cette phase, tous deux corrigés avant la fin :
1. **Deux assertions RLS que j'avais moi-même mal écrites** — elles s'attendaient à une erreur là où Postgres répond « succès, zéro ligne affectée » (le même comportement que le reste de la suite documente déjà ailleurs). Vérifié contre la base réelle avant de conclure qu'il ne s'agissait pas d'une faille, puis corrigé.
2. **Une table oubliée dans la publication realtime** — `driver_documents` était abonnée côté client (tableau de bord admin) mais jamais ajoutée à `supabase_realtime`, donc l'abonnement n'aurait jamais rien reçu. Trouvé en relisant mon propre travail, corrigé par une migration additive (`0021`), avant qu'il ne devienne un incident comme ceux de la Phase 4.5.

Périmètre strictement respecté : **aucun Stripe Connect, aucun payout, aucun taux de commission figé, aucun Safety Link, aucune notification push, aucun pricing dynamique.**

---

## 1. Onboarding chauffeur

Le formulaire existant (déclenché tant que `driver_profiles.province` est vide) est étendu, pas remplacé :

| Champ | Avant | Après |
|---|---|---|
| Nom | ✅ (signup) | inchangé |
| Téléphone | ❌ absent | ✅ ajouté (écrit sur `profiles.phone`, partagé avec le rôle usager) |
| Type de véhicule | ✅ | inchangé |
| Plaque | ✅ | inchangé |
| Province | ✅ | inchangé — sert aussi de secteur de service, voir plus bas |
| Services offerts | ❌ absent | ✅ multi-sélection sur les mêmes `PROBLEM_TYPES` que le flow client |

**Zones de service** : demandées « si le modèle actuel le permet ». Il ne le permet pas proprement — le dispatch est basé sur un rayon autour du point de la demande (`nearby_drivers()`, `dispatch_next_candidate()`), pas sur des polygones ou codes postaux définis par le chauffeur. Construire un champ « zones » qui ne fait rien aurait été une fonctionnalité de façade. La province, déjà collectée, en tient lieu pour l'instant — dit explicitement dans l'interface (« Votre province est aussi votre secteur de service pour l'instant »).

**Services offerts** est volontairement **informatif seulement** : la colonne est capturée et affichée, mais le dispatch (`nearby_drivers`, `dispatch_next_candidate_core` — fondations validées) ne la lit pas. La câbler dans le matching est une vraie décision produit, hors du périmètre de cette phase.

L'approbation admin reste obligatoire et inchangée : `nearby_drivers()` filtre déjà sur `approval_status = 'approved'` (0002/0017) — **vérifié explicitement** par un nouveau test RLS plutôt que supposé.

## 2. Documents

Nouvelle table `driver_documents` + bucket Storage privé `driver-documents` (migration `0019`).

| Type | Statuts |
|---|---|
| 🪪 Permis · 🛡️ Assurance · 📋 Immatriculation · 📄 Autre | `pending` · `approved` · `rejected` · `expired` |

Modèle de confiance identique à `payments` (Phase 4) : un chauffeur voit et ajoute ses propres documents, mais **aucune politique UPDATE n'existe pour sa propre session** — pas seulement découragé par l'interface, structurellement impossible. Réviser un document rejeté = en envoyer un nouveau ; l'ancien reste comme trace de ce qui a été examiné.

- Upload : `Server Action` avec le client lié au cookie du chauffeur (pas de service role) — le stockage et l'insertion passent par les mêmes RLS que si le chauffeur les faisait lui-même.
- Suppression : autorisée tant que le document n'est pas `approved`.
- `expires_at` est saisi par le chauffeur mais **rien côté serveur n'agit dessus** — aucun cron n'existe pour ça, et en créer un touche exactement la surface Edge Function/scheduler que cette phase n'autorise pas à modifier. L'étiquette « Expiré » est calculée **à l'affichage seulement** (comparaison de date côté client), documenté dans la migration et le rapport plutôt que laissé implicite.
- **Défaut trouvé et corrigé** : `driver_documents` manquait dans `supabase_realtime` — voir Verdict.

## 3. Profil chauffeur

`/dashboard/driver/profile` — identité, véhicule, plaque, province, services, statut d'approbation (+ motif si rejeté), note et nombre de services réels. Formulaire d'édition réutilisant `updateDriverInfo()` (étendu pour `phone`/`serviceTypes`).

**Règle non négociable respectée partout, pas seulement ici** : `driver_profiles.rating` vaut `5.0` par défaut (`0001_init.sql`). Le profil, le tableau de bord principal et la page performance affichent tous **« Nouveau »** tant que `total_services = 0` — jamais `5.0`. C'est la même règle que la Phase 4.5 avait posée côté client ; elle est maintenant appliquée dans les trois nouveaux emplacements qui montrent une note.

## 4. Online / Offline

Le commutateur existant devient un vrai état, pas un simple booléen affiché :

| État affiché | Condition réelle |
|---|---|
| Hors ligne | `is_online = false`, ou compte non approuvé |
| En ligne | `is_online = true` **et** heartbeat < 2 min |
| Reconnexion… | `is_online = true` mais heartbeat ≥ 2 min — le backend le traite déjà comme hors ligne |

Le seuil de 2 minutes n'est pas réinventé : il **reflète** `driver_heartbeat_max_age()` (0017), avec un commentaire explicite disant que la base de données reste la seule source de vérité. Une horloge cliente (tick toutes les 5 s) recalcule cette fraîcheur en continu, indépendamment de tout rechargement de données.

Géré explicitement :
- **Permission GPS refusée** — bannière persistante « Activez la localisation pour rester en ligne », et le commutateur refuse de passer en ligne si un refus a déjà été détecté.
- **Perte de réseau** — l'écriture du heartbeat retourne maintenant `{ ok: boolean }` au lieu d'être silencieusement ignorée (`updateDriverLocation`) ; un échec affiche « Connexion réseau instable » sans faire disparaître le chauffeur.
- **Compte non approuvé** — le commutateur ne s'affiche même pas ; à la place, la raison exacte (en attente / rejeté + motif) est écrite en toutes lettres.

Vérifié en conditions réelles : navigateur sans permission de géolocalisation → la bannière « Localisation refusée » apparaît, le badge affiche « Reconnexion… » et jamais « En ligne » tant que le heartbeat n'a pas de valeur fraîche — exactement le comportement voulu.

## 5. Offre de mission (carte repensée)

Avant : type, localisation, véhicule, prix, ETA. Après, dans cet ordre :

1. **Montant en gros caractères** en haut de carte (le prix total actuellement disponible — voir §7 sur pourquoi pas un montant partenaire).
2. Barre de temps restant + compte à rebours coloré (rouge sous 5 s).
3. Type de problème, véhicule client.
4. **Distance jusqu'au point de ramassage** (nouveau — avant, seul l'ETA était visible).
5. Destination + distance de remorquage, si applicable.
6. Boutons Accepter/Refuser en grand format (`size="lg"`), Accepter visuellement dominant.

**Aucune donnée personnelle du client** (nom, téléphone) sur cette carte, avant comme après. Note de transparence : la politique RLS `profiles: request participants read each other` (fondation pré-Phase-5, non modifiée) autoriserait techniquement le chauffeur offert à lire le profil complet du client dès l'étape d'offre, pas seulement une fois la course acceptée — un accès direct à l'API pourrait donc théoriquement le faire, même si l'interface ne l'affiche jamais. Resserrer cette politique est un changement de fondation plus profond qu'il n'y paraît (elle sert aussi toute la conversation post-matching) ; **trouvé, documenté, non corrigé** — hors périmètre de cette mission, à traiter en phase dédiée sécurité.

## 6. Mission active

Écran entièrement reconstruit :

- **Client** : nom, véhicule, bouton d'appel direct (`tel:`) — visible seulement une fois la course assignée, jamais avant.
- **Carte** (`MapView`, réutilisé tel quel) avec marqueur client + destination.
- **Liens de navigation** — Google Maps et Apple Maps, ouverts dans un nouvel onglet, ciblant le point de ramassage puis la destination une fois l'intervention commencée. Aucun moteur de navigation maison.
- **Chat** (`Chat`, réutilisé tel quel) et **suivi de statut** (`StatusTracker`, réutilisé tel quel) — même composants que le côté client, mêmes garanties RLS.
- **Prix** visible en tête de carte pendant la vie de la course.

Vérifié en conditions réelles avec une mission fixture matched → en_route : carte affichée avec les tuiles Mapbox, boutons de navigation présents, `StatusTracker` synchronisé, bouton d'action correct à chaque étape.

## 7. Revenus

`/dashboard/driver/earnings` — aujourd'hui / 7 jours / 30 jours / total, chacun avec un compte de courses, plus un aperçu des dernières courses.

Chaque montant vient de `requests.price_estimate` sur des courses **réellement complétées** — jamais de `partner_amount` (qui reste `NULL`, aucun taux de commission n'existe). Un bandeau l'explique en clair plutôt que de laisser deviner : *« Le taux de commission TowConnect n'est pas encore déterminé — ces montants affichent le prix total de chaque course… »*. Le même bandeau réapparaît sur le détail d'une course terminée (§8). Aucune décision de commission n'a été prise ici, comme demandé.

## 8. Historique

`/dashboard/driver/history` — toutes les courses jamais assignées à ce chauffeur (complétées **ou** annulées après matching, pas les offres jamais acceptées), avec date, type, départ, destination si applicable, statut, montant. Chaque ligne ouvre `/dashboard/driver/history/[id]` : détail complet (client, véhicule, décomposition du prix pour une course complétée, même note sur la commission qu'en §7).

## 9. Performance

`/dashboard/driver/performance` — uniquement des métriques dérivées de vraies lignes :

| Métrique | Source | Comportement à zéro donnée |
|---|---|---|
| Évaluation | `driver_profiles.rating`, gardé par `total_services > 0` | « Nouveau » |
| Services complétés | `driver_profiles.total_services` | `0` |
| Taux d'acceptation | `dispatch_offers` (`accepted` / `accepted+declined+timeout`) | « — · Aucune offre reçue » |
| Taux de complétion | `requests` (`completed` / `completed+cancelled`) | « — · Aucune course » |
| Temps de réponse moyen | `dispatch_offers.responded_at - offered_at`, **seulement** `accepted`/`declined` | message explicite, pas `0s` |

Point technique correct délibérément : les offres **expirées** (`timeout`) ont aussi un `responded_at` (posé par le balayage du scheduler, pas par le chauffeur) — les inclure dans le temps de réponse aurait fabriqué un « vous répondez en 18 secondes » artificiel à chaque offre ignorée. Exclues explicitement, avec le commentaire expliquant pourquoi.

## 10. Admin — approbation et documents

`AdminDashboard.tsx` étendu, pas reconstruit :

- **Chauffeurs en attente** : mêmes données qu'avant, mais **Rejeter** ouvre maintenant un champ de motif (obligatoire dans l'esprit, pas bloqué en dur pour rester tolérant) avant confirmation — le motif est écrit sur `driver_profiles.rejection_reason` et visible par le chauffeur.
- **Documents en attente** : nouvelle file, **globale** (tous chauffeurs confondus, pas seulement ceux en attente d'approbation) — un document réexaminé après un rejet apparaît ici même si le compte est déjà approuvé, ce qui est le comportement voulu : chaque document est vérifié pour lui-même. Bouton **Voir** génère une URL signée (2 min) vers le fichier privé, **Approuver**/**Rejeter avec motif** par document.
- Realtime déjà en place, `driver_documents` maintenant réellement inclus (voir Verdict).

Aucune vérification de rôle explicite ajoutée dans le code — comme le reste de ce fichier avant Phase 5, l'application repose sur `public.is_admin()` côté RLS : une session non-admin obtient zéro ligne affectée, pas un contournement.

## 11. Préparation Business (minimal, pas de dashboard)

Migration `0020`, strictement préparatoire :

- Table `companies` (`id`, `name`, `owner_id`, `created_at`) — lecture réservée au propriétaire et à l'admin, **aucune politique INSERT pour un utilisateur authentifié** (créer une compagnie reste une action back-office pour l'instant, il n'y a pas encore de flow d'inscription pour ça).
- `driver_profiles.company_id`, nullable, gardé par la même fonction trigger que `approval_status`/`rating`/`rejection_reason` — un chauffeur ne peut pas s'auto-rattacher à une compagnie.
- Aucune interface ne lit ou n'écrit cette table. Aucun Stripe Connect. Aucune notion de flotte/véhicules partagés — décision volontairement reportée à une phase avec une vraie interface devant elle plutôt que devinée ici.

## 12. Migrations

| Fichier | Contenu |
|---|---|
| `0018_driver_service_types.sql` | `driver_profiles.service_types text[]`, informatif |
| `0019_driver_documents.sql` | table + enums + bucket Storage + policies + `rejection_reason` + garde étendue |
| `0020_companies_prep.sql` | `companies` + `driver_profiles.company_id` + garde étendue |
| `0021_driver_documents_realtime.sql` | correctif — `driver_documents` ajoutée à `supabase_realtime` |

Toutes additives, appliquées et vérifiées en base une par une (existence de table/colonne/policy/bucket confirmée par requête, pas supposée).

## 13. RLS — vérifié en direct, pas en local

`npm run test:integration` contre le projet Supabase réel : **78 → 92 assertions**, toutes vertes. Les 14 nouvelles couvrent exactement la liste demandée au §12 de la mission :

- ✅ chauffeur A ne lit pas les documents du chauffeur B
- ✅ un client ne lit aucun document chauffeur
- ✅ upload d'un document pré-approuvé refusé (contournement du statut)
- ✅ auto-approbation par le chauffeur sans effet (aucune policy UPDATE)
- ✅ suppression d'un document déjà approuvé sans effet
- ✅ suppression d'un document non approuvé, autorisée
- ✅ un admin (session admin réelle, pas le service role) peut réviser un document
- ✅ `rejection_reason` et `company_id` gardés comme `approval_status`
- ✅ propriétaire d'une compagnie peut lire sa ligne, un tiers ne peut pas, un chauffeur ne peut pas en créer une
- ✅ `nearby_drivers()` exclut un chauffeur non approuvé même en ligne avec heartbeat frais

**Deux de ces tests étaient mal écrits au premier essai** (voir Verdict) — vérifié contre un scénario isolé sur la base réelle avant de conclure que ce n'était pas une vraie faille, puis corrigé dans le fichier de test lui-même, pas contourné.

## 14. Tests

| Test | Résultat |
|---|---|
| `npx tsc --noEmit` | ✅ |
| `npm run lint` | ✅ 0 erreur, 0 warning |
| `npm run build` | ✅ — 7 nouvelles routes enregistrées |
| `npm run test` (vitest) | ✅ 30/30 (inchangé) |
| `npm run test:integration` (RLS live) | ✅ **92/92** |
| Parcours manuel sur serveur de dev | ✅ inscription → onboarding → upload document → révision admin → approbation → mission active complète, mobile et desktop |

## 15. Limitations connues

1. **`service_types` n'affecte pas le dispatch** — capturé et affiché, jamais lu par le matching. Décision délibérée (voir §1), pas un oubli.
2. **`expires_at` sur un document n'est pas appliqué côté serveur** — affichage seul, aucun job planifié. Construire ce job touche le scheduler/Edge Functions, hors périmètre.
3. ~~**Un chauffeur offert (avant acceptation) peut techniquement lire le profil complet du client via l'API**~~ — ✅ **corrigé en Phase 5.1**, voir §17. La fuite a été reproduite en conditions réelles puis fermée par la migration `0022`.
4. **Pas de dashboard Business** — seulement la préparation de schéma (§11), comme demandé explicitement.
5. **Rotation du token Mapbox restreinte par URL** — toujours non fait (hérité de la Phase 4.5, hors périmètre de celle-ci).

## 16. Recommandations Phase 6

Dans l'ordre où elles bloquent le moins de choses :

1. **Décider du taux de commission** — c'est la dépendance qui débloque des revenus/reçus chauffeur *réels* plutôt qu'un prix brut avec une note explicative.
2. ~~**Resserrer la policy `profiles: request participants read each other`**~~ — ✅ **fait en Phase 5.1** (§17).
3. **Dashboard Business** au-dessus de `companies`/`company_id` (déjà préparés) — plusieurs chauffeurs, une flotte, un propriétaire.
4. **Stripe Connect / payouts** une fois la commission décidée.
5. Un job planifié pour faire respecter `driver_documents.expires_at` server-side, si l'expiration doit un jour bloquer l'approbation plutôt que rester informative.

---

## 17. Phase 5.1 — Profile Privacy Hardening

Date : 2026-09-01. Correctif de la limitation §15.3, identifiée en rédigeant ce rapport.

### La fuite, mesurée avant d'être corrigée

La policy `profiles: request participants read each other` (0001) accordait une lecture mutuelle des profils dès que `requests.driver_id` pointait sur le chauffeur. Elle a été écrite quand `driver_id` n'était posé qu'à l'acceptation. **Smart Dispatch (0006) a changé ce timing sous elle** : `dispatch_next_candidate_core()` écrit `requests.driver_id` au moment de **l'offre**, alors que le statut est encore `pending`.

Reproduit contre le projet réel, avec de vraies sessions, **avant** tout correctif :

```
after offer -> status: pending | driver_id set: true
OFFERED driver reads rider profile   : LEAK -> {"full_name":"…","phone":"514-555-0142"}
rider reads OFFERED driver profile   : LEAK -> {"full_name":"…"}
UNASSIGNED driver reads rider profile: blocked (null)
```

Un chauffeur simplement **offert** lisait donc le **nom et le numéro de téléphone** du client avant d'accepter, et gardait cet accès pendant toute la fenêtre de 18 s même s'il refusait. La fuite était **symétrique** : le client lisait aussi le profil d'un chauffeur qui n'avait encore rien accepté. L'interface ne l'a jamais affiché — c'est la base qui l'autorisait, et c'est ce qui compte.

### Pourquoi `status <> 'pending'` n'aurait pas suffi

`driver_id` survit délibérément à l'étape d'offre sur deux chemins qui n'ont jamais atteint l'acceptation :

- `expire_offer_on_cancel()` (0006) laisse explicitement `driver_id` en place quand le client annule ;
- `cleanup_stale()` (0002) passe une course `pending` périmée à `expired` sans y toucher non plus.

Un chauffeur ayant seulement reçu une offre aurait donc **gagné** l'accès au profil du client au moment où cette course expirait ou était annulée. Filtrer sur le statut déplaçait la fuite au lieu de la fermer. Ces deux cas sont maintenant des assertions à part entière.

### Le correctif — `0022_profile_privacy_after_matching.sql`

Le seul fait qui sépare « on m'a proposé cette course » de « j'ai pris cette course » est de savoir si elle a **réellement atteint `matched`**. `request_events` enregistre exactement ça, via `log_request_status_change()` — un trigger sur `requests` lui-même, donc il capture *tous* les chemins vers `matched` (`respond_to_dispatch_offer`, un appel direct à `accept_request()`, une assignation admin) plutôt que de faire confiance à une seule fonction pour avoir bien tenu ses comptes. Étant append-only, la preuve survit à la course qui passe en `completed`, ou qui est annulée alors que le chauffeur était déjà dessus — c'est ce qui garde le reçu et l'historique chauffeur fonctionnels.

```sql
and exists (
  select 1 from request_events e
  where e.request_id = r.id and e.status = 'matched'
)
```

`request_events` n'avait **aucun index** ; la policy ajoutant un EXISTS dessus à chaque lecture de `profiles`, l'index `(request_id, status)` est créé dans la même migration.

**Aucun code applicatif n'a changé.** La base est l'application de la règle, pas le frontend — le tableau de bord chauffeur ne récupérait déjà l'identité du client que pour une mission `matched` ou plus.

### Vérifié après correctif — même probe, mêmes sessions

```
OFFERED driver reads rider profile   : blocked (null)
rider reads OFFERED driver profile   : blocked (null)
MATCHED driver reads rider profile   : allowed -> {"full_name":"…","phone":"…"}
rider reads MATCHED driver profile   : allowed
```

### Tests RLS : 92 → 107

Les 92 assertions existantes restent vertes ; 15 s'ajoutent :

| Assertion | Résultat |
|---|---|
| offre en attente → le chauffeur ne lit pas le profil client | ✅ |
| chauffeur sans lien → ne lit jamais le profil client | ✅ |
| client → ne lit pas le profil d'un chauffeur seulement *offert* | ✅ |
| acceptation → le profil client devient lisible | ✅ |
| après matching → le client lit son chauffeur assigné (tracking) | ✅ |
| chat après matching toujours fonctionnel | ✅ |
| après complétion → le client lit le chauffeur (reçu) | ✅ |
| après complétion → le chauffeur lit le client (historique) | ✅ |
| refus d'offre → aucune lecture | ✅ |
| course **expirée** gardant `driver_id` → aucune lecture | ✅ |
| client → ne lit pas un chauffeur jamais matché | ✅ |
| admin conserve l'accès à tous les profils | ✅ |
| + 3 assertions de *setup* garantissant que les cas ci-dessus ne passent pas à vide | ✅ |

Ces trois dernières comptent. **Deux de mes nouvelles assertions ont d'abord échoué**, et la policy n'y était pour rien : je réutilisais le même couple chauffeur/client qui venait de **terminer** une course ensemble, ce qui accorde légitimement et définitivement la lecture. Le test observait donc la course terminée, pas le refus. Corrigé avec des clients neufs, plus un garde-fou explicite (« l'offre a-t-elle réellement été émise ? ») pour qu'un « ne peut pas lire » ne puisse jamais passer simplement parce que rien ne s'est produit.

### Test manuel — API directe, pas seulement l'interface

Sur un serveur réel, avec la session authentifiée du chauffeur offert :

```
AVANT ACCEPTATION
  request visible to driver : status=pending pickup="1000 Rue Sainte-Catherine O." dest="2000 Rue Notre-Dame O." price=49.5
  rider PROFILE via direct API: BLOCKED (null)

APRÈS ACCEPTATION
  request visible to driver : status=matched …
  rider PROFILE via direct API: READABLE -> {"full_name":"P51 Rider","phone":"514-555-0163"}
```

La carte d'offre affiche bien type de service, véhicule, ramassage, destination, distances, ETA et montant — **et aucun nom ni téléphone**. La fiche client n'apparaît qu'après acceptation.

### Régressions

Aucune. Dispatch, offre, acceptation/refus, mission après matching, chat, appel client, tracking, historique, reçu et admin : tous couverts par des assertions dédiées, tous verts.

Une bizarrerie **préexistante** subsiste, non introduite par ce correctif : `driver_id` survivant à une annulation, une course annulée alors que le chauffeur n'avait qu'une offre apparaît toujours dans son historique. Depuis 5.1 elle s'y affiche sans nom de client — ce qui est le bon comportement côté confidentialité (`JobDetail` omet simplement la ligne). Non corrigé : hors périmètre, et sans exposition nouvelle.
