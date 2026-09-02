# TowConnect — Phase 9 Report
## Customer Safety, Communication & Premium Experience

**Date :** 2026-09-02
**Portée :** Safety Link, suivi premium avec ETA honnête, notifications unifiées, centre de notifications, UX d'urgence, support contextuel, contacts de confiance, exports admin CSV/XLSX à portée de capacité, et une base de connaissances interne versionnée.
**Hors périmètre, respecté :** abonnements, fidélité, parrainage, IA dispatch, IA fraude, déploiement national, Stripe live, commission finale. La base de connaissances reste du Markdown dans le dépôt — pas un portail SaaS.

---

## 0. Le principe qui gouverne cette phase

La question posée à chaque décision : *comment une grande plateforme mature ferait-elle ceci, puis quelle est la version proportionnée à TowConnect aujourd'hui ?*

Concrètement, trois réponses reviennent :

* **Un lien de partage est un identifiant au porteur.** Donc seul son SHA-256 est stocké. Lire la table ne doit pas équivaloir à détenir tous les liens actifs.
* **Un export n'élargit jamais la visibilité d'un rôle.** Le fichier est toujours un sous-ensemble de ce que la personne pouvait déjà lire à l'écran.
* **Une documentation qui diverge du code est pire que pas de documentation.** `verify:phase9` lit les documents et les compare à la base.

---

## 1. Safety Link

### 1.1 Ce que c'est

Un lien qu'un client partage avec une personne de confiance pendant une intervention. **Aucun compte TowConnect n'est requis** pour le destinataire — c'est la première route lisible sans authentification dans tout le produit.

### 1.2 Le token n'est jamais stocké

32 octets aléatoires (`randomBytes(32)`), encodés en base64url. Seul le **SHA-256** entre en base.

Le texte clair existe exactement une fois : dans la réponse à la personne qui l'a créé. TowConnect ne peut pas le reproduire — l'écran le dit plutôt que d'afficher un bouton « Copier » qui échouerait.

**`requests.id` n'est délibérément pas le secret.** Il apparaît dans les URL admin, dans les tickets de support et dans les logs ; un lien bâti dessus ferait de chacun de ces endroits une fuite. Le test le vérifie : passer un `request_id` comme token ne résout rien.

### 1.3 La surface publique est une projection écrite à la main

`safety_link_view()` (0046) est une fonction `SECURITY DEFINER` qui sélectionne **18 champs, énumérés un par un**. Ce n'est pas une vue sur des tables ni une policy sur `requests` : ce qui n'est pas sélectionné ne peut pas fuir, même si quelqu'un élargit une requête ailleurs plus tard.

| Montré | Jamais montré |
| --- | --- |
| État opérationnel | Prix, marge, montants |
| Position du véhicule | Numéro de téléphone |
| Prénom du chauffeur | Nom de famille |
| Entreprise, type de camion, plaque | Adresse enregistrée |
| Position du chauffeur **avec son âge** | Autres interventions |
| ETA quand il existe réellement | Notes internes, documents, incidents, signaux de risque |

`verify:phase9` crée un vrai lien, l'ouvre et **compare la liste des champs retournés** aux 18 documentés. Ajouter une colonne à la fonction ferait échouer la vérification — parce que ce serait la publier.

### 1.4 Révocation et expiration

* Un index unique garantit **un seul lien vivant par intervention** : régénérer révoque l'ancien, qui ne redevient jamais valide (testé).
* Expiration : 6 h par défaut, plus 30 min de grâce après la fin de l'intervention. Deux **constantes d'ingénierie**, marquées comme telles dans `ops_thresholds` — aucune politique de rétention n'a été convenue, et un nombre inventé ici serait cité comme une règle.
* Un token faux, révoqué ou expiré produit **exactement la même page**. La distinction n'est utile qu'à quelqu'un qui devine.

---

## 2. Suivi premium et ETA honnête

### 2.1 Jamais d'ETA fabriqué

Un ETA n'est calculé que s'il existe une position chauffeur **fraîche** (< 2 min, la fenêtre du moteur de répartition lui-même). Sinon l'absence est **nommée** :

| Situation | Ce qui s'affiche |
| --- | --- |
| Position fraîche, chauffeur en route | `~N min` |
| Aucun chauffeur assigné | « Aucun remorqueur n'est encore assigné, donc aucun délai ne peut être estimé. » |
| Assigné, position indisponible | « Sa position n'est pas disponible — aucun délai ne peut être estimé. » |
| Position périmée | « **Dernière position reçue il y a X** — le délai affiché ne serait pas fiable. » |
| Zone réglementée, autorité externe | « Cette route est gérée par une autorité publique. » |
| Arrivé | « Le remorqueur est sur place. » |

### 2.2 Position périmée

`safety_link_view()` retourne `driver_location_age_seconds`. Une position vieille de 30 minutes est **retournée avec son âge**, pas masquée et pas dessinée comme si elle était actuelle — testé explicitement.

---

## 3. Notifications

### 3.1 Émises là où le fait se produit

Quatre déclencheurs en base (0046), sur `requests`, `messages`, `request_supplements` et `refunds`. Même raisonnement que `request_events` : un déclencheur sur la table capte **chaque chemin** vers un état, y compris ceux que l'application a oubliés.

Onze types : `driver_found`, `driver_en_route`, `driver_arrived`, `job_in_progress`, `job_completed`, `job_cancelled`, `message_received`, `supplement_proposed`, `supplement_needs_authentication`, `payment_action_required`, `refund_issued`.

### 3.2 Un type et une charge utile, jamais une phrase finie

Une notification stocke `{driver_first_name: 'Marc'}`, pas « Marc prend en charge votre demande ». Le texte est rendu à l'écran — même raisonnement que `messages.template_key` : un client et un chauffeur lisent le même événement chacun dans sa langue.

### 3.3 Permissions

* Une notification appartient à **exactement une personne**. Pas de policy admin : le support lit la course, pas la boîte de réception de quelqu'un.
* **Aucune policy INSERT** : elles sont écrites par les déclencheurs et par du code serveur de confiance. Personne ne peut déposer un message dans la boîte d'un autre (testé).
* Une notification livrée **ne peut pas être réécrite** — seul l'état « lu » change.

### 3.4 Préférences, et ce qui ne se coupe pas

Quatre catégories. `job_progress` et `payment` **ne peuvent pas être désactivées** — un déclencheur en base refuse, pas seulement l'interface. Quelqu'un qui a coupé « votre remorqueur est arrivé » il y a trois mois ne doit pas le manquer ce soir.

### 3.5 Canaux

In-app, livré. Push web et SMS/email : l'architecture les accueille (`notification_preferences.push` existe), **aucun fournisseur payant n'a été engagé** — c'est une décision business.

---

## 4. Chat et transparence

* `messages.read_at` existait depuis la Phase 3 sans usage ; le champ reste, et la notification `message_received` couvre désormais le besoin réel (« il y a un nouveau message »).
* **Rétention :** aucune suppression automatique. La politique actuelle est « rien n'est supprimé », documentée dans la base de connaissances plutôt que décidée en silence.
* **Identité du prestataire** après matching seulement : prénom, entreprise, type de camion, plaque. **Aucun faux 5.0** — un chauffeur sans course complétée n'a pas de note, et l'export l'écrit `NULL` plutôt que la valeur par défaut.
* **Le nouveau total avant approbation** : le panneau supplément affiche « Nouveau total si vous acceptez : X (actuellement Y) » — la règle « pas de supplément surprise » appliquée avant la décision, pas après.

---

## 5. Exports CSV / XLSX

### 5.1 L'invariant

**Un export ne peut jamais élargir la visibilité d'un rôle.** Trois choses le rendent structurel :

1. Chaque jeu de données **nomme les capacités** qui peuvent l'exporter, revérifiées **côté serveur** contre la réponse de la base, à chaque requête.
2. Le navigateur envoie des **filtres** — jamais des lignes, jamais des identifiants. Une liste d'IDs venue d'un client est une demande de faire confiance au client sur ce qu'il a le droit de lire.
3. Les colonnes sont **énumérées à la main**. Un `select *` exporterait silencieusement la prochaine colonne ajoutée — y compris un token ou une donnée KYC.

### 5.2 Qui exporte quoi

| Capacité | Jeux de données |
| --- | --- |
| `operations` | interventions, répartition, chauffeurs, entreprises, incidents, zones réglementées, documents, réconciliation, KPI |
| `finance` | paiements, remboursements, suppléments, grand livre, versements, réconciliation, KPI |
| `support` | une vue interventions volontairement étroite |
| `super_admin` | l'ensemble |

Aucun export pour un client, un chauffeur, un répartiteur ou un propriétaire d'entreprise.

### 5.3 Jamais exporté

Tokens, identifiants Stripe, secrets webhook, coordonnées bancaires, KYC, chemins de stockage des documents, hachages de Safety Link, notes internes, signaux de risque. **Pas filtrés — jamais sélectionnés.** Un test balaie sept exports à la recherche de `token`, `secret`, `stripe_`, `sk_`, `whsec`, `iban`, `storage_path`, `password` : zéro occurrence.

### 5.4 Format — testé en relisant les fichiers

Un test qui vérifie seulement « l'export n'a pas planté » ne prouve rien. Chaque fichier produit est **relu** :

| Propriété | Pourquoi | Vérifié |
| --- | --- | --- |
| UTF-8 **avec BOM** | Sans lui, Excel sur Windows affiche `CrÃ©Ã©e le` | ✅ |
| Accents français intacts | « Créée le », « Zone réglementée » | ✅ |
| Montants en nombre à point | Excel applique sa propre locale ; `1 234,56` serait du texte non sommable | ✅ |
| Dates en forme ISO | Se trient correctement quelle que soit la région du lecteur | ✅ |
| Guillemets systématiques | Une adresse contenant une virgule ne casse pas la ligne | ✅ |
| `.xlsx` réel | Rouvert avec ExcelJS, feuilles `Résumé` + `Données` vérifiées | ✅ |
| Montants stockés en **nombre** dans le classeur | Sommables | ✅ |

La feuille `Résumé` est dérivée **des lignes mêmes** de `Données` — le total qu'on cite et les lignes qu'on peut vérifier sont la même donnée.

### 5.5 Audit

Chaque export écrit dans `export_audit` : qui, **quelle capacité l'a autorisé** (pas la plus forte détenue), jeu de données, format, filtres, nombre de lignes, date. Un export refusé ne laisse **aucune** ligne.

**Le fichier n'est jamais conservé.** Un journal contenant les exports serait une seconde copie non protégée des données qu'il existe pour surveiller. Seul un `super_admin` peut lire ce journal, et personne ne peut y écrire sa propre ligne (testé).

---

## 6. Base de connaissances

24 documents sous `/docs`, versionnés avec le code, revus dans les mêmes pull requests.

```
01-company   02-product   03-operations   04-finance   05-data
06-support   07-compliance   08-security   09-sops   10-decisions
```

**Aucun remplissage.** Chaque fait est extrait du système réel : noms de fonctions, numéros de migration, seuils, définitions. Chaque document important porte **Owner, Status, Last reviewed, Review cycle, Related systems**.

**Aucun employé n'est inventé.** Les propriétaires sont `Founder / Product` ou `future <role>` là où une fonction spécialisée existera un jour.

### 6.1 Contenu

Principes opérationnels · vue produit · principes de répartition · zones réglementées · playbook opérations · cycle de vie du paiement · remboursements et versements · **dictionnaire de données** · **définitions des KPI** · playbook support · opérations réglementées · **politique d'accès admin** · **politique d'export** · 3 runbooks · **7 ADR**.

### 6.2 Documentation-as-code, appliqué par un test

C'est la partie inhabituelle. `verify:phase9` **lit les documents et les compare à la base** :

* chaque capacité admin existe-t-elle dans la politique d'accès ?
* chaque KPI est-il documenté, et le document pointe-t-il vers `ops_kpis()` comme **définition unique** ?
* chaque concept du dictionnaire est-il présent ?
* les 7 ADR existent-ils ?
* le document finance et la base **s'accordent-ils** sur le fait qu'aucune commission n'est configurée ?

Une capacité renommée ou un KPI modifié fait échouer la vérification. C'est la seule manière connue d'empêcher une page confiante et fausse.

### 6.3 Les 7 ADR

Régulation avant préférence commerciale · aucune géométrie réglementaire inventée · économie gelée à l'acceptation · grand livre append-only · accès admin par capacités · finance en sandbox avant lancement · PaymentIntent séparé pour les suppléments.

---

## 7. Migrations

| # | Fichier | Contenu |
| --- | --- | --- |
| 0046 | `safety_notifications_exports.sql` | `safety_links` + `safety_link_view()` (projection publique de 18 champs), `notifications` + `notification_preferences` + `notify_user()` + 4 déclencheurs d'émission, `trusted_contacts`, `export_audit`, 2 seuils d'ingénierie |

---

## 8. Sécurité et RLS

### 8.1 Nouvelles assertions dans la suite RLS (**211 au total**, les 203 existantes inchangées)

Un chauffeur ne peut pas lire le lien de partage du client · une entreprise non plus · le lien stocke un hachage, jamais un token utilisable · un client ne lit que ses propres notifications · un chauffeur aussi · personne ne peut déposer une notification chez un autre · seul un `super_admin` lit le journal d'exports · personne n'écrit sa propre ligne dedans.

### 8.2 Suites dédiées

**`test:safety` — 39 assertions.** Token non devinable · hachage seul en base · lien ouvert sans compte · aucune note interne, aucun prix, aucune identité dans la charge utile · exactement 18 champs · prénom seul, jamais le nom · position périmée signalée comme telle · token faux / `request_id` / autre client / anonyme sur les tables : tout refusé · révocation immédiate · l'ancien token ne revit jamais · expiration appliquée par la base · notifications isolées, immuables, catégories critiques indésactivables.

**`test:exports` — 42 assertions.** Chaque capacité ne se voit offrir que son domaine · sept refus inter-domaines côté serveur · un admin dépouillé n'exporte rien · CSV et XLSX **relus et vérifiés** · filtres serveur comparés à la base · aucun secret dans sept exports · audit écrit, capacité correcte, refus non journalisés, aucun contenu de fichier stocké.

---

## 9. Performance

* **Safety Link** : aucune table exposée à une URL publique. Une seule fonction, une seule requête, 18 colonnes.
* **Notifications** : trois index, tous pour des requêtes réellement utilisées — non lues par destinataire, historique par destinataire, notifications d'une intervention.
* **Exports** : générés **sur le serveur**, plafonnés (10 000 lignes, 20 000 pour le grand livre). Le navigateur ne fait que sauvegarder le fichier ; il n'assemble jamais le jeu de données. Un export asynchrone n'a pas été construit — les volumes actuels ne le justifient pas, et l'architecture ne l'empêche pas.

---

## 10. Bugs et frictions rencontrés

1. **`safety_link_view()` échouait à l'exécution, pas à la création.** Ses paramètres de sortie s'appellent comme les colonnes qu'elle lit (`status`, `expires_at`, `created_at`), et une référence non qualifiée résout vers le paramètre. Chaque colonne est désormais qualifiée.
2. **Une liste `select` concaténée casse le typage.** supabase-js analyse la liste **au niveau des types** : une concaténation devient `string` et toutes les colonnes reviennent en type d'erreur. C'est la protection qui fonctionne — un `select` qu'il ne peut pas lire est un `select` qu'il ne peut pas vérifier.
3. **Un fichier `'use server'` ne peut exporter que des fonctions asynchrones.** La liste des catégories de notification a été déplacée dans un module ordinaire — attrapé au build, pas en production.

---

## 11. Mise à jour Connect (dette Phase 8.1)

Vous avez fait progresser l'onboarding Express pendant cette phase. État actuel, relu **chez Stripe** :

```
charges_enabled    true      ← était false
payouts_enabled    false
currently_due      ["individual.verification.proof_of_liveness"]
in sync with Stripe: YES
```

Les exigences sont passées de **4 à 1**. Il reste la vérification d'identité par selfie. `internal payout prepared` reste vrai ; `Stripe transfer executed` reste faux.

---

## 12. Tests

| Commande | Résultat |
| --- | --- |
| `npx tsc --noEmit` | ✅ |
| `npm run lint` | ✅ aucun avertissement |
| `npm run build` | ✅ 40 routes, dont `/track/[token]`, `/notifications`, `/operations/exports` |
| `npm run test` | ✅ 60 |
| `npm run test:integration` | ✅ **211 assertions RLS** (203 inchangées + 8) |
| `npm run verify:phase6` | ✅ 37 |
| `npm run verify:phase6_1` | ✅ 32 |
| `npm run verify:phase7` | ✅ 24 |
| `npm run verify:finance` | ✅ 16 |
| `npm run test:finance` | ✅ 125 |
| `npm run verify:operations` | ✅ 27 |
| `npm run test:operations` | ✅ 40 |
| `npm run verify:phase9` | ✅ **24** (nouveau) |
| `npm run test:safety` | ✅ **39** (nouveau) |
| `npm run test:exports` | ✅ **42** (nouveau) |

### Les 14 scénarios de la Partie P

| # | Scénario | Résultat |
| --- | --- | --- |
| 1 | Course active | ✅ |
| 2 | Créer un Safety Link | ✅ token 43 caractères, hachage seul en base |
| 3 | Ouvrir sans être connecté | ✅ résout, avec la projection complète |
| 4 | Suivre le chauffeur | ✅ prénom, camion, plaque, position **avec son âge** |
| 5 | Révoquer | ✅ effet immédiat |
| 6 | Token refusé | ✅ faux / révoqué / expiré / `request_id` — tous refusés |
| 7 | Notification « chauffeur trouvé » | ✅ avec la charge utile, pas une phrase |
| 8 | Notification message | ✅ déclencheur sur `messages` |
| 9 | Supplément | ✅ proposé et « authentification requise » notifiés |
| 10 | Intervention terminée | ✅ chaque étape produit sa notification |
| 11 | Export CSV admin | ✅ relu : BOM, accents, nombres, dates, guillemets |
| 12 | Export XLSX admin | ✅ rouvert : `Résumé` + `Données`, montants numériques |
| 13 | Export inter-capacité refusé | ✅ 7 refus |
| 14 | Docs présents et cohérents | ✅ 24 documents, cohérence KPI/capacités vérifiée contre la base |

---

## 13. Nettoyage — vérifié en base

| | |
| --- | --- |
| Comptes fixtures | **0** |
| Safety Links | **0** |
| Notifications | **0** |
| Préférences de notification | **0** |
| Contacts de confiance | **0** |
| Journal d'exports | **0** |
| Configurations économiques | **0** · `pricing_configured()` = **`false`** |
| Grand livre / versements / remboursements / suppléments | **0 / 0 / 0 / 0** |
| Autorisations Stripe retenant des fonds | **0** |
| PaymentIntents de supplément ouverts | **0** |
| Entreprises | **1** — le fixture Connect de la Phase 8.1, conservé volontairement pour votre action |

---

## 14. Limitations

* **Push web et SMS/email ne sont pas livrés.** L'architecture les accueille ; engager un fournisseur payant est une décision business.
* **L'ETA reste une estimation à vol d'oiseau** (`distanceKm` / 45 km/h). Honnête sur sa disponibilité, pas sur son itinéraire : aucun calcul routier n'est fait.
* **Les accusés de lecture du chat ne sont pas exposés.** `messages.read_at` existe et reste inutilisé ; la notification « nouveau message » couvre le besoin réel.
* **Les contacts de confiance sont mémorisés, jamais utilisés automatiquement.** Aucun envoi automatique, aucun partage permanent — ce serait un autre produit.
* **L'export est synchrone**, plafonné à 10 000 lignes (20 000 pour le grand livre). Suffisant aujourd'hui ; un export asynchrone n'a pas été construit prématurément.
* **La rétention du chat n'est pas configurable.** La politique actuelle — rien n'est supprimé — est documentée, pas encore paramétrable.

---

## 15. Recommandations Phase 10

1. **Terminer la vérification d'identité Connect** (une seule exigence restante), puis exécuter le vrai transfert sandbox et faire passer §11 de `prepared` à `executed`.
2. **Décider si un supplément non encaissé doit être poursuivi**, ou accepté comme perte. Le produit le signale correctement ; personne n'a décidé quoi en faire.
3. **Décider d'un canal push** avant que le volume ne rende l'in-app insuffisant.
4. **ETA routier** : la première amélioration que les clients ressentiront, une fois qu'il y aura assez de courses pour la calibrer.
5. **Rétention** : décider une politique pour le chat, les notifications et les Safety Links expirés, puis la rendre configurable — les seuils sont déjà dans `ops_thresholds`.
6. **Attribuer les capacités aux comptes réels.** Un seul compte détient `super_admin` ; la séparation des pouvoirs existe et n'est encore exercée par personne.

---

## PHASE 9 COMPLETE

**Résumé.** TowConnect peut maintenant rassurer quelqu'un arrêté au bord de la route : partager son suivi avec une personne de confiance sans lui demander de compte, savoir ce qui se passe sans deviner, être prévenu à chaque étape, et voir un ETA seulement quand il est réel. Côté back-office, chaque capacité admin peut extraire son propre domaine dans un fichier qu'Excel ouvre correctement — jamais un octet de plus que ce qu'elle pouvait déjà lire. Et le système sait maintenant se documenter lui-même, avec un test qui échoue quand la documentation ment.

**Migrations.** `0046` — Safety Links + projection publique, notifications + préférences + 4 déclencheurs, contacts de confiance, audit d'export, 2 seuils d'ingénierie.

**Safety Link E2E.** ✅ 39 assertions. Token non devinable, hachage seul en base, ouverture anonyme, révocation immédiate, expiration appliquée par la base, et une projection de 18 champs vérifiée champ par champ.

**Notification status.** ✅ In-app livré, 11 types, émis par déclencheurs. Catégories critiques indésactivables **par la base**. Push/SMS : architecture prête, aucun fournisseur engagé.

**Exports status.** ✅ CSV et XLSX, sur le serveur, à portée de capacité, audités, **relus par les tests**. 42 assertions. Aucun secret exportable, aucun export inter-domaine possible.

**Knowledge base status.** ✅ 24 documents versionnés, métadonnées complètes, 7 ADR, dictionnaire de données et définitions KPI transcrites depuis `ops_kpis()`. Cohérence avec la base **vérifiée par un test**.

**Tests.** 211 assertions RLS · 39 Safety Link · 42 exports · 125 financières · 40 opérationnelles · 60 unitaires · 37 + 32 + 24 + 16 + 27 + 24 vérifications d'effet en base. `tsc`, `lint`, `build` propres.

**Blockers.** Aucun. La seule action humaine ouverte reste la vérification d'identité Connect, héritée de la Phase 8.1 et déjà réduite de 4 exigences à 1.

**Chemin du rapport.** `TOWCONNECT_PHASE9_REPORT.md`

**Verdict : SAFE TO START PHASE 10**
