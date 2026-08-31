# TowConnect — Audit produit complet

Date : 2026-08-30
Portée : `app/` (Next.js 16 App Router, Supabase, Mapbox), migrations SQL, Edge Function.
Aucun fichier applicatif n'a été modifié pour produire ce rapport.

---

## 0. Résumé exécutif

TowConnect existe déjà comme un **MVP fonctionnel et raisonnablement sécurisé**, pas comme une coquille vide. L'authentification (email/mdp + Google OAuth), la géolocalisation, le RLS Postgres, la recherche géospatiale (PostGIS), l'acceptation atomique d'une course et le tracking temps réel via Supabase Realtime sont **implémentés et de bonne qualité technique** — au point d'avoir déjà traversé 4 passes de durcissement sécurité (`0001`→`0004`).

Ce qui manque n'est pas de la plomberie technique de base, mais **la couche "compte client central"** que la vision demande : aucun véhicule enregistré, aucune adresse enregistrée, aucun moyen de paiement, aucune évaluation post-course, aucune messagerie, et le matching est **une sélection manuelle dans une liste**, pas un dispatch automatique. C'est l'écart le plus important avec la vision Uber-like.

**Un point de sécurité hors-code à signaler immédiatement** : [`Infos.txt`](Infos.txt) à la racine du repo contient en clair un mot de passe Supabase et le token Mapbox. Il n'est pas suivi par git (`git status` le montre en `??`), mais il est assis dans l'arbre de travail — un `git add -A` accidentel l'enverrait au dépôt. Recommandation : le déplacer hors du repo et faire tourner (rotate) les deux secrets par précaution. Je n'ai touché à rien ici sans ton autorisation.

---

## 1. État actuel réel de TowConnect

**Stack** : Next.js 16 (App Router, Server Actions), Supabase (Postgres + Auth + Realtime), Mapbox GL JS + Geocoding API, Tailwind v4. ~860 lignes de code applicatif (petit, dense, pas de dette de duplication visible).

**Modèle de données** (`0001_init.sql` → `0004`) :
- `profiles` (id, role, full_name, phone, created_at) — 1 ligne par `auth.users`, créée par trigger.
- `driver_profiles` (véhicule, plaque, province, rating, total_services, is_online, approval_status, position live, heartbeat).
- `requests` (une course : type de panne, lieu texte + lat/lng, description véhicule en texte libre, prix, statut, driver_id).
- `request_events` (journal des changements de statut — sert au KPI temps-de-match admin).
- **Aucune table** `vehicles`, `addresses`, `payments`, `payment_methods`, `reviews`, `messages`, `companies`.

**Rôles réellement supportés** : `user`, `driver`, `admin`. **Pas de rôle `business`** — le "propriétaire d'entreprise de remorquage" de la Phase 3 n'existe nulle part dans le schéma ni le code.

**Parcours actuellement livré** : demande manuelle avec **sélection du remorqueur dans une liste** (prix + ETA affichés par remorqueur), pas de dispatch automatique à un seul remorqueur. Paiement et notifications sont explicitement documentés comme simulés dans le README existant.

---

## 2. Ce qui fonctionne déjà et doit être conservé

| Fonctionnalité | Qualité constatée | Verdict |
|---|---|---|
| Google Sign-In (OAuth code flow via `/auth/callback`) | Fonctionne, redirect propre, gère l'erreur d'échange de code | **Garder** |
| Email/mot de passe + confirmation email | Flow standard Supabase, message d'attente clair | **Garder** |
| Session (`@supabase/ssr` + proxy/middleware) | Rafraîchit correctement le cookie pour les Server Components | **Garder** |
| Géolocalisation navigateur (`navigator.geolocation`) | Utilisée côté usager (détection ponctuelle + reverse-geocode) et côté chauffeur (ping toutes les 20s si en ligne) | **Garder**, à durcir (voir §Gaps) |
| RLS Postgres | 4 itérations de durcissement documentées : self-approval, récursion admin, exposition de position live, sur-exposition des requêtes pending | **Garder**, exemplaire pour un MVP |
| `accept_request()` (RPC `SECURITY DEFINER`) | Empêche la course entre deux chauffeurs sur la même offre via un index unique partiel + `UPDATE ... WHERE` atomique | **Garder** |
| `nearby_drivers()` (PostGIS, KNN via GiST) | Recherche par paliers (15/40/350 km), ne fuit jamais lat/lng brut | **Garder** |
| Tracking temps réel (Supabase Realtime) | Statut + position chauffeur poussés en direct pendant que l'onglet est ouvert | **Garder** |
| Prix transparent avant confirmation | Formule simple (base + $/km + surcharge par type de panne), affichée avant que l'usager confirme | **Garder**, conforme à la vision "aucune surprise" |
| Edge Function `cleanup-stale` | Protégée par service-role bearer token, expire les requêtes pending >10 min et les chauffeurs sans heartbeat >3 min | **Garder** |
| Tests | Unitaires (pricing) + script d'intégration RLS jetable | **Garder**, rare à ce stade d'un MVP |
| Bilingue FR/EN | Dictionnaire client + toggle persisté en `localStorage` | **Garder**, mais voir gap SEO ci-dessous |

**Ne rien reconstruire ici.** Le socle auth/géoloc/RLS est le genre de travail qu'on casse facilement en le réécrivant "en mieux" — c'est la fondation la plus solide du projet.

---

## 3. Top 10 problèmes critiques (P0/P1)

1. **[P0] Pas de dispatch automatique — l'usager choisit lui-même son remorqueur dans une liste.** C'est l'écart n°1 avec la vision Uber-like : `StepDrivers.tsx` affiche jusqu'à 8 chauffeurs à choisir manuellement, aucun matching algorithmique, aucun timeout d'offre.
2. **[P0] Aucun véhicule enregistré / aucun véhicule principal.** `vehicle_desc` est un champ texte libre resaisi à chaque demande. Bloque directement l'étape 4 du parcours cible ("véhicule principal présélectionné").
3. **[P0] Aucune adresse enregistrée ni détection automatique au chargement.** La localisation est redemandée/re-géocodée à chaque demande ; aucune adresse "Maison"/"Travail" sauvegardée.
4. **[P0] Aucune persistance de session de course.** L'état `RequestFlow` (`step`, `requestId`) vit uniquement en mémoire React. Fermer l'onglet ou rafraîchir pendant une course active fait perdre le fil — aucune reprise automatique, contrairement à l'exigence explicite de la Phase 5.
5. **[P0] Communication chauffeur↔usager = appel téléphonique uniquement**, via `tel:${driver.phone}`. Aucune messagerie ni messages rapides prédéfinis — contredit directement la règle "aucun appel obligatoire dans le parcours normal". De plus, `profiles.phone` n'est **jamais collecté** dans le formulaire d'inscription : le bouton d'appel sera probablement absent pour la majorité des comptes.
6. **[P0] Aucun paiement intégré, aucun moyen de paiement sauvegardé, aucun reçu.** Confirmé simulé dans le README existant.
7. **[P0] Aucune évaluation post-course.** `driver_profiles.rating` existe et est verrouillé côté écriture (bien protégé), mais rien dans l'app ne le fait évoluer après une course — pas d'écran de notation.
8. **[P1] Google Sign-Up ne permet pas de créer un compte chauffeur.** Le bouton Google (login et signup) ne transmet jamais `role` dans les métadonnées — tout compte créé via Google devient `user` par défaut (`handle_new_user()`), sans chemin dans l'UI pour devenir `driver` ensuite.
9. **[P1] Rôle `business` inexistant dans le schéma/l'enum** (`user_role` = user/driver/admin seulement). Toute la Phase 3 "entreprise de remorquage" est à construire depuis zéro, pas juste un dashboard manquant.
10. **[P1] Notifications = uniquement Realtime in-app, onglet ouvert requis.** Aucun push/SMS. Un usager qui quitte l'onglet pendant que son remorqueur avance ne reçoit rien.

**Fichier sensible hors-code** : `Infos.txt` (racine) contient un mot de passe Supabase et un token Mapbox en clair — à traiter avant toute mise en production, indépendamment de la roadmap produit.

---

## 4. Top 10 opportunités produit

1. **Auto-matching "Smart Dispatch"** : remplacer la liste de choix par une offre séquentielle/à fenêtre courte au meilleur chauffeur (ETA × note × équipement), avec re-offre automatique en cas de non-réponse — c'est le plus gros levier pour atteindre <60s et pour la différenciation "premium".
2. **Compte = identité centrale** : table `vehicles` (avec véhicule principal), `addresses`, historique consultable, reçus — transforme le compte en actif stratégique comme demandé en Phase 6.
3. **Reprise automatique de course** : persister `requestId`/étape dans l'URL ou `localStorage`, restaurer l'état au chargement — gain UX énorme pour un contexte de stress/urgence.
4. **Messagerie in-app avec messages rapides prédéfinis** ("J'arrive dans 5 min", "Je suis bloqué, appelle-moi") + statut de lecture — supprime la dépendance à l'appel téléphonique.
5. **Safety Link** : URL de suivi partageable en lecture seule (sans compte) pour un proche — différenciateur simple à livrer avec l'infra Realtime déjà en place.
6. **Pré-remplissage agressif de l'écran d'accueil pour usager connecté** : détecter la position automatiquement au chargement (pas de clic 📍 requis), présélectionner le véhicule principal et le dernier type de panne — vise directement le KPI "Time to Rescue Request".
7. **Notation post-course en 1 tap** (étoiles + tag rapide) — alimente `rating`, qui est déjà protégé côté écriture, juste jamais rempli.
8. **Paiement intégré (Stripe) avec carte sauvegardée** — élimine l'échange d'argent/carte sur le bord de la route, complète la promesse "prix transparent, aucune surprise" jusqu'au bout.
9. **Dashboard entreprise** (nouveau rôle `business`) — gestion de flotte, zones, revenus — ouvre le marché B2B (compagnies de remorquage existantes) sans toucher au parcours client.
10. **Photo à l'arrivée / à la complétion** — preuve pour litiges, upload direct vers Supabase Storage (pas encore utilisé dans le projet).

---

## 5. Analyse détaillée du parcours client actuel

Parcours réel observé dans le code (`page.tsx` → `RequestFlow.tsx` → `StepForm` → `StepDrivers` → `StepTracking`) pour un usager **déjà inscrit et déjà connecté** :

1. Ouverture de `/` → redirection serveur vers `/request` (role lookup) — 1 aller-retour réseau avant même d'afficher quoi que ce soit.
2. `/request` affiche un **Hero marketing** ("🚨 Demander de l'aide") — écran interstitiel avant le formulaire, même pour un utilisateur qui revient pour la 50e fois.
3. Clic sur le CTA → **Étape "Situation"** : choisir un type de panne (menu déroulant), saisir/détecter la localisation (clic 📍 → attente GPS + reverse-geocode Mapbox), **retaper la description du véhicule en texte libre** (aucune mémoire du véhicule d'une fois à l'autre), notes optionnelles.
4. Soumission → **Étape "Remorqueurs"** : appel `nearby_drivers()` (jusqu'à 3 paliers de rayon), affichage d'une liste de chauffeurs avec prix/ETA — **l'usager doit lire et choisir manuellement**, aucune sélection automatique.
5. Clic "Confirmer" → création de la ligne `requests` → **Étape "Suivi"**.

**Nombre d'étapes actuel pour un usager déjà inscrit** : ~4 écrans distincts (Hero → Formulaire → Liste chauffeurs → Suivi), avec un formulaire à 4 champs (dont un texte libre resaisi) et une décision manuelle de sélection de chauffeur. Réaliste : **45 à 90+ secondes** dans le meilleur cas (GPS rapide, choix rapide), plus en cas de saisie manuelle de l'adresse ou d'hésitation sur la liste de chauffeurs. L'objectif <60s n'est **pas garanti aujourd'hui**, surtout à cause de l'étape 4 (parcourir/choisir) qui n'existe pas dans le parcours cible en 13 étapes fourni (qui prévoit un matching automatique, pas un menu).

Rien ne re-demande une information déjà connue au niveau du compte au sens strict (le formulaire ne relit pas non plus le profil pour pré-remplir quoi que ce soit) — **le problème n'est pas la redondance de saisie entre étapes, c'est l'absence totale de mémoire du compte d'une session à l'autre.**

---

## 6. Nombre d'étapes actuel vs parcours recommandé <60s

| # | Parcours actuel | Parcours cible <60s |
|---|---|---|
| 1 | Hero marketing (clic requis) | Détection auto de position au chargement, pas d'écran intermédiaire |
| 2 | Choix type de panne (menu) | Idem, mais gros boutons pleine largeur (1 tap) |
| 3 | Saisie/détection manuelle de la localisation | Position déjà affichée (GPS silencieux au chargement), champ pré-rempli, éditable |
| 4 | Saisie texte libre du véhicule | Véhicule principal présélectionné (chip), changeable en 1 tap si plusieurs véhicules |
| 5 | Notes optionnelles | Idem (inchangé) |
| 6 | Recherche + **liste de chauffeurs à parcourir et choisir** | Prix + ETA affichés immédiatement pour **le meilleur match**, un seul bouton "Confirmer" |
| 7 | Confirmation → création de la course | Idem |
| 8 | Écran de suivi | Idem, + reprise auto si l'app est refermée |

**Recommandation** : fusionner 2–5 en un seul écran "carte + gros bouton" avec présélections, et remplacer 6 par un matching automatique (avec un fallback "voir d'autres options" en lien secondaire, pas en étape obligatoire).

---

## 7. Cartographie des rôles (état actuel)

### Visiteur
- Accès : `/`, `/login`, `/signup`. Landing FR/EN, CTA vers connexion.
- Manque : aucune preview du produit sans compte (pas de mode "voir un exemple de course").

### Client connecté (`user`)
- Fonctionnel : demande de course, liste de chauffeurs, suivi temps réel, annulation, historique implicite via Realtime (pas d'écran d'historique dédié cependant).
- Simulé/absent : véhicules, adresses, paiement, évaluation, reçus, messagerie, litige.
- Bug potentiel : si un chauffeur décline après confirmation, `onDriverDeclined` renvoie à l'étape "chauffeurs" — logique correcte, mais rien n'avertit l'usager qu'il devra re-choisir un chauffeur en pleine urgence sans notification proactive (juste un toast si l'onglet est ouvert).

### Chauffeur (`driver`)
- Fonctionnel : onboarding (véhicule/province/plaque), toggle en ligne, accepter/refuser une offre, faire progresser le statut, revenu/note affichés, historique des 8 dernières courses complétées.
- Simulé/absent : aucune heatmap de demande, aucune navigation intégrée (pas de lien Google/Apple Maps), aucun document/vérification d'identité au-delà de l'approbation admin manuelle, aucune preuve photo.
- UX : ping de position toutes les 20s **seulement si l'onglet reste ouvert et au premier plan** — pas de service worker, la position s'arrête si l'app est en arrière-plan mobile.

### Propriétaire d'entreprise (`business`)
- **N'existe pas.** Aucune page, aucun rôle, aucune table.

### Administrateur (`admin`)
- Fonctionnel : stats live (chauffeurs actifs, demandes du jour, temps moyen de match, revenu), répartition par province, file d'approbation chauffeurs, flux de courses en direct.
- Simulé/absent : pas de carte "live operations", pas de gestion des paiements/remboursements, pas de litiges, pas de détection de fraude, pas de gestion tarifaire (constantes codées en dur dans `pricing.ts`), pas de logs/audit trail au-delà de `request_events` (statuts seulement, pas d'acteur).

---

## 8. Architecture recommandée (évolutive, pas une réécriture)

- **Garder** Next.js App Router + Server Actions, Supabase (Auth/Postgres/Realtime/Storage), Mapbox, le modèle RLS existant.
- **Ajouter**, sans toucher au schéma existant :
  - `vehicles` (user_id, make, model, year, color, is_primary) + FK optionnelle depuis `requests.vehicle_id` (garder `vehicle_desc` en fallback texte pour compat).
  - `addresses` (user_id, label, lat, lng) pour favoris.
  - `payment_methods` + intégration Stripe (Payment Intents), `receipts`.
  - `reviews` (request_id, rating, comment) + trigger qui recalcule `driver_profiles.rating` en moyenne pondérée — réutilise le pattern `SECURITY DEFINER` déjà en place pour `total_services`.
  - `messages` (request_id, sender_id, body|template_key, created_at) + policy RLS calquée sur `request_events`.
  - `companies` + rôle `business` + `driver_profiles.company_id`.
- **Ajouter** Supabase Storage pour les photos (proof-of-arrival, dommages).
- **Ajouter** notifications push web (Web Push API / service worker) pour ne plus dépendre de l'onglet ouvert — c'est aussi le prérequis technique pour la reprise automatique de session.
- **Ne pas** introduire de queue/dispatch externe tout de suite : le matching automatique peut d'abord s'implémenter comme une extension de `nearby_drivers()` + une Edge Function d'offre séquentielle avec timeout, sans nouvelle infra.

---

## 9. Roadmap P0 → P3

### P0 — indispensable avant lancement
| Problème | Solution recommandée | Fichiers concernés | Difficulté | Risque de régression |
|---|---|---|---|---|
| Pas de dispatch auto | Offre séquentielle au meilleur match + timeout + re-offre (Edge Function ou RPC + cron) | `StepDrivers.tsx`, nouvelle fonction SQL, `supabase/functions/` | Élevée | Moyen — remplace un flux qui marche |
| Pas de véhicule enregistré | Table `vehicles`, écran "mes véhicules", présélection dans `StepForm` | nouvelle migration, `StepForm.tsx`, `types.ts` | Moyenne | Faible (additif) |
| Pas de reprise de session | Persister `requestId` actif (ex: `localStorage` + requête au montage) | `RequestFlow.tsx`, `request/page.tsx` | Faible | Faible |
| Pas de messagerie in-app | Table `messages` + UI messages rapides dans `StepTracking`/`DriverDashboard` | nouvelle migration, `StepTracking.tsx`, `DriverDashboard.tsx` | Moyenne | Faible (additif) |
| `phone` jamais collecté | Ajouter le champ au formulaire d'inscription (ou onboarding) | `signup/page.tsx`, `0001_init.sql` (déjà nullable, ok) | Faible | Faible |
| Fuite de secrets (`Infos.txt`) | Retirer du repo, faire tourner les secrets | hors code applicatif | Faible | Aucun (à valider avec toi) |

### P1 — important
- Paiement Stripe + reçus.
- Évaluation post-course (écran + trigger de recalcul de `rating`).
- Google Sign-Up avec choix de rôle (passer `role` dans les `options.data` de `signInWithOAuth`, ou écran de choix de rôle après le premier callback OAuth si le profil est fraîchement créé).
- Notifications push web.
- Adresses favorites.

### P2 — amélioration
- Dashboard entreprise + rôle `business`.
- Photo à l'arrivée/complétion (Storage).
- Heatmap de demande côté chauffeur.
- Navigation intégrée (lien vers Google/Apple Maps depuis le dashboard chauffeur).
- i18n via routes (`/fr`, `/en`) + `hreflang` pour le SEO, au lieu du toggle client-only actuel.

### P3 — futur / scale
- Safety Link (partage de suivi sans compte).
- Abonnement/forfait familial, programme de fidélité, crédits/promos.
- Détection de fraude, litiges structurés, audit trail avec acteur.
- Carte "live operations" admin avec positions temps réel de tous les véhicules actifs.

---

## 10. Les 5 prochaines tâches de développement, dans l'ordre

1. **Sécuriser `Infos.txt`** (le sortir du repo, faire tourner le mot de passe Supabase et le token Mapbox) — 5 minutes, zéro risque, doit être fait avant tout le reste.
2. **Table `vehicles` + présélection du véhicule principal** dans `StepForm.tsx` — débloque directement l'étape 4 du parcours cible, additif, faible risque.
3. **Reprise automatique de session** (persister la course active) — gain UX majeur, faible risque, ne touche pas au schéma.
4. **Collecter `phone` à l'inscription** — prérequis pour que le bouton d'appel (et plus tard la messagerie) fonctionne réellement.
5. **Concevoir et prototyper le dispatch automatique** (le remplacement de `StepDrivers.tsx` par une offre au meilleur match) — c'est le changement le plus structurant, à faire *après* avoir sécurisé les fondations ci-dessus, et avec ta validation explicite du design avant implémentation vu son impact sur le flux existant.

---

## 11. Ce que je déconseille absolument de modifier maintenant

- **Le schéma RLS existant et ses 4 migrations de durcissement** — chaque changement corrige une faille réelle trouvée par écrit de tests d'intégration ; les toucher sans le même niveau de rigueur réintroduirait des failles déjà fermées (self-approval, récursion admin, fuite de position live, sur-exposition des requêtes pending).
- **`accept_request()` et l'index unique `requests_one_active_job_per_driver`** — c'est ce qui empêche deux chauffeurs d'accepter la même course ; toute réécriture du matching (P0 #1 ci-dessus) doit **s'appuyer dessus**, pas le remplacer.
- **Le flow Google OAuth existant** (`/auth/callback`, `signInWithOAuth`) — fonctionne correctement ; le correctif du rôle (P1) doit s'ajouter par-dessus, pas remplacer le mécanisme.
- **`nearby_drivers()` et l'indexation PostGIS** — le dispatch automatique doit être construit *sur* cette fonction (elle fait déjà le filtrage géospatial correctement), pas la dupliquer.
- **La géolocalisation navigateur actuelle** (`navigator.geolocation`) — solide pour un MVP web ; ne pas la remplacer par une lib tierce avant d'avoir un besoin concret (précision insuffisante constatée, PWA native, etc.).

---

*Fin du diagnostic. Aucune implémentation n'a été faite — en attente de ton autorisation avant de commencer les tâches de la section 10.*
