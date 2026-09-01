# TowConnect — Phase 4.5 : mise en service de l'infrastructure

Date : 2026-09-01
Aucune valeur de secret ne figure dans ce document.

---

## Verdict

**PRODUCTION INFRA READY**

Les trois blockers sont levés et vérifiés **en conditions live**, pas sur la foi du code :

| Blocker | État | Preuve |
|---|---|---|
| B1 — Edge Functions | ✅ levé | 17/17 contrôles, dont l'**effet réel en base** |
| B4 — Webhook Stripe distant | ✅ levé | 7/7, Stripe → Vercel → base, événements réels |
| B5 — Mapbox | ✅ levé | géocodage réel dans le flow déployé |
| Scheduler (§2) | ✅ configuré et prouvé | 10 réponses HTTP **200**, 0 échec, effet en base |

Réserve honnête, à lire avant de conclure : « infra ready » veut dire que la plomberie fonctionne réellement en sandbox. Cela ne veut pas dire « prêt à encaisser de vrais clients » — voir §12, qui liste ce qui reste et qui n'est pas de l'infrastructure.

Ce que la validation a coûté : **quatre défauts réels** trouvés, dont deux qui auraient touché des clients. Ils sont décrits sans ménagement au §7, parce que c'est la partie utile de ce rapport.

---

## 1. Edge Functions

Les deux fonctions sont redéployées avec le correctif `x-cron-secret` et **vérifiées sur les quatre voies d'appel** :

| Appel | dispatch-tick | cleanup-stale |
|---|---|---|
| sans en-tête d'authentification | 401 (passerelle) | 401 |
| JWT anon valide, sans secret cron | 401 (notre code) | 401 |
| JWT anon + **mauvais** secret cron | 401 | 401 |
| JWT anon + secret cron réel | **200** | **200** |

**Le 200 ne suffisait pas.** `npm run verify:functions` va jusqu'à l'effet en base :

- une course en attente sans chauffeur est offerte au **plus proche** des deux chauffeurs de test ;
- l'offre est vieillie au-delà de sa fenêtre — le seuil de 18 s n'est **pas** touché, c'est la donnée qui est datée ;
- au tick suivant, l'offre passe réellement à `timeout`, une nouvelle offre part vers le **candidat suivant**, et la course suit — **aucun onglet ouvert nulle part** ;
- un chauffeur au heartbeat périmé repasse réellement hors ligne, une course jamais matchée passe réellement à `expired`.

**17/17.** C'est cette distinction qui compte : `cleanup-stale` avait passé une journée déployée en répondant proprement… et en ne faisant rien.

## 2. Scheduler

Deux jobs `pg_cron`, chacun toutes les minutes :

| Job | Schedule | Actif |
|---|---|---|
| `dispatch-tick-every-minute` | `* * * * *` | oui |
| `cleanup-stale-every-minute` | `* * * * *` | oui |

Les secrets ne sont **pas** dans la définition des jobs : ils sont dans le **Vault** Supabase, et la commande planifiée ne fait que les lire par nom. L'interface Cron du dashboard aurait stocké les valeurs brutes dans la commande ; c'est pourquoi la voie SQL a été retenue.

Trois preuves indépendantes, pas une :

1. `cron.job_run_details` — exécutions toutes les minutes, toutes `succeeded`.
2. `net._http_response` — **10 réponses, toutes `200`**. Aucun 401. C'est le contrôle qui manquait la dernière fois.
3. `npm run verify:scheduler` — plante un chauffeur périmé et une course ancienne, **n'appelle rien**, et attend. Les deux sont balayés. Rien d'autre que le scheduler n'a pu le faire.

## 3. Mapbox

Token récupéré **depuis Vercel**, jamais depuis `Infos.txt`, et placé dans `app/.env.local` (ignoré par Git). Vérifié de bout en bout : l'autocomplétion d'adresse renvoie de vraies suggestions Mapbox sur le déploiement, et les coordonnées choisies arrivent en base.

## 4. Remorquage avec destination — validé de bout en bout

Parcours réel sur `towconnect-chi.vercel.app`, compte jetable, carte de test.

| Étape | Résultat |
|---|---|
| Connexion client | va directement au flow — pas de Hero marketing, véhicule enregistré présélectionné |
| « Panne mécanique » | la section **Destination du remorquage** apparaît |
| Départ + destination | géocodage Mapbox réel, deux adresses de Montréal |
| Estimation | 50 $ (base 45 + 2,25 $/km) |
| Confirmation | `tow_distance_km = 1.57`, calculé **serveur**, jamais reçu du navigateur |
| Prix figé | base 45,00 + distance 4,50 + supplément 0 = **49,50 $** |
| Autorisation Stripe | `capture_method: manual`, `requires_capture`, **4950** = 49,50 $ **au cent près** |
| Dispatch | une offre, au chauffeur le plus proche, acceptée dans la fenêtre |
| Statuts | `matched → en_route → arrived → in_progress → completed`, suivis en temps réel côté client |
| Capture | `succeeded`, `amount_received = 4950` |
| Reçu | départ, **destination**, base 45,00 $, **Distance · 1,6 km → 4,50 $**, total 49,50 $, « Payé », référence Stripe |

`commission_amount` et `partner_amount` restent **NULL** : aucun taux n'a été inventé.

## 5. Webhook Stripe distant

Endpoint créé dans le **sandbox** (`towconnect-vercel-payments`), pointé sur `https://towconnect-chi.vercel.app/api/stripe/webhook`, abonné aux **6 événements** que le code traite — pas un de plus. Signing secret stocké **uniquement dans Vercel**.

`npm run verify:webhook` — **7/7**, avec des événements Stripe réels :

- corps non signé → 400 ; signature forgée → 400 ;
- autorisation → notre ligne `payments` passe à `authorized` ;
- l'événement est inscrit au registre d'idempotence ;
- **challenge SCA → `requires_action`, jamais `failed`** (voir §7) ;
- annulation → `canceled`.

C'est la seule façon de prouver que `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY` et `SUPABASE_SERVICE_ROLE_KEY` sont corrects **sur Vercel** : `stripe listen` utilise un tout autre secret et ne dit rien du déploiement.

## 6. Variables d'environnement Vercel

| Variable | Type | Portée |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | Production |
| `STRIPE_SECRET_KEY` | Secret | Production |
| `STRIPE_WEBHOOK_SECRET` | Secret | Production |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Config | Production |

Les trois premières sont marquées **Secret** (illisibles après enregistrement) ; seule la clé publiable, publique par nature, est en Config. Les valeurs ont transité par le presse-papier, jamais par la conversation ni par un fichier versionné.

## 7. Défauts trouvés en validant — la partie qui compte

### 🔴 Le webhook traitait un challenge 3D Secure comme un paiement échoué

Trouvé en passant une vraie carte SCA dans l'application déployée. Le client voit « Vérification de votre carte… », le challenge est affiché et complétable, le dispatch attend correctement — **et la ligne `payments` disait `failed`**.

Stripe signale une confirmation off-session nécessitant 3DS par un `payment_intent.payment_failed` portant `last_payment_error.code = 'authentication_required'`, l'intent revenant à `requires_payment_method`. Ça ressemble à un refus. Ce n'en est pas un.

`createRequest()` le savait déjà et écrivait `requires_action` ; le webhook — conçu pour **primer sur toute écriture optimiste** — l'écrasait aussitôt en `failed`. Le client était donc informé que son paiement avait échoué pendant que le challenge était encore à l'écran, et le support voyait un paiement mort qui était vivant.

Aggravant : si le client complétait le challenge, l'état se corrigeait tout seul. Un défaut qui se répare avant d'apparaître dans les statistiques et qui n'atteint jamais que le client.

C'est **la même méprise que la Phase 4 avait corrigée côté application** — seule cette moitié-là avait été traitée. Le prédicat vit maintenant à un seul endroit (`lib/stripe/payment-status.ts`), avec un test unitaire, et `verify:webhook` l'assert contre l'endpoint déployé : la troisième occurrence fera échouer un contrôle, pas un client.

### 🟠 Le chauffeur ne voyait nulle part la destination

Ni sur la carte d'offre qu'il a **18 secondes** pour accepter, ni sur la fiche de mission après acceptation. Un remorquage, c'est « prendre le véhicule **et** l'amener quelque part » : la moitié du travail était invisible pour celui qui l'exécute. Destination et distance sont désormais affichées aux deux endroits.

### 🟠 Chaque chauffeur était présenté à 5,0 étoiles

`driver_profiles.rating` vaut 5.0 par défaut (`0001_init.sql`). Un compte tout neuf, **0 service effectué**, affichait donc une note parfaite que personne n'avait donnée — au client, au moment précis où il décide de confier sa voiture à un inconnu. C'est exactement la statistique inventée que la mission interdit.

L'écran client et le tableau de bord chauffeur affichent maintenant « Nouveau » / « New » tant qu'aucun service n'est derrière. **La valeur stockée n'est pas touchée** : le scoring du dispatch la lit, et repondérer le dispatch est une autre décision, pas la mienne à prendre ici.

### 🟠 Le reçu facturait une distance sans dire laquelle

« Distance — 4,50 $ » : précisément la ligne de facture invérifiable que ce produit existe pour remplacer. `tow_distance_km` était déjà figé sur la course ; il n'était simplement pas affiché. Le reçu dit maintenant « Distance · 1,6 km ».

### Défaut de tooling, corrigé aussi

Le démontage des comptes de test supprimait la ligne `payments` **avant** d'annuler le PaymentIntent : une empreinte réelle restait sur la carte sans plus rien en base pour la retrouver. Détecté sur la fixture 3DS. Le démontage annule maintenant toute autorisation encore ouverte.

## 8. Documentation corrigée

Les deux README d'Edge Functions décrivaient encore l'ancien schéma (`service_role` dans `Authorization`) — c'est-à-dire **exactement la configuration qui renvoie 401 à chaque appel**. Suivre la doc reproduisait la panne. Réécrits autour de `x-cron-secret`, avec la raison, et pointant sur `verify:functions` plutôt que sur « ça renvoie 200 ».

## 9. Tests

| Test | Résultat |
|---|---|
| `npx tsc --noEmit` | ✅ |
| `npm run lint` | ✅ 0 erreur, 0 warning |
| `npm run build` | ✅ |
| `npm run test` (vitest) | ✅ **30/30** (27 → 30) |
| `npm run test:integration` (RLS live) | ✅ **78/78** — « All RLS invariants held » |
| `npm run verify:functions` | ✅ **17/17** |
| `npm run verify:webhook` | ✅ **7/7** |
| `npm run verify:scheduler` | ✅ **2/2** |

Les quatre derniers sont nouveaux et vivent dans le dépôt : ils assertent sur l'**état**, jamais sur un code HTTP seul.

## 10. Git

Quatre commits sur `main`, poussés. **Aucun force-push, aucune réécriture d'historique.**

```
dfddc8a  Prove the schedule runs, not just that a cron row exists
56bb51e  Stop the webhook calling a 3D Secure challenge a failed payment
c9c0c13  Verify the deployed infrastructure, and fix what verifying it exposed
4525dac  Saved vehicles, smart dispatch, messaging and Stripe authorize/capture
e8be378  Add the audit and phase reports behind the last change
```

Correction de `.gitignore` au passage : `supabase/.temp` contient une barre oblique, donc était ancré à la racine du dépôt et ne matchait **jamais** le vrai `app/supabase/.temp`, où le CLI écrit une URL de connexion Postgres. Élargi en `**/supabase/.temp`.

## 11. Sécurité

| Contrôle | Résultat |
|---|---|
| Aucun secret dans les commits | ✅ diff scanné à chaque commit, 0 correspondance |
| `.env.local`, `Infos.txt`, `.e2e-fixtures.json` ignorés | ✅ vérifié via `git check-ignore` |
| Secrets Vercel : `service_role` / Stripe **jamais** en `NEXT_PUBLIC_` | ✅ |
| Secrets du scheduler dans le Vault, pas en clair dans les jobs | ✅ |
| Edge Functions : échec **fermé** | ✅ trois voies non autorisées → 401 |
| Comparaison du secret à **temps constant** | ✅ |
| Stripe strictement sandbox | ✅ les scripts refusent de démarrer sur une clé live |
| Aucune autorisation laissée ouverte | ✅ démontage vérifié, 1 PaymentIntent annulé |
| Mapbox **non** lu depuis `Infos.txt` | ✅ |
| Aucune donnée réelle supprimée | ✅ seuls les comptes jetables créés ici ont été effacés |
| Aucun chauffeur / avis / prix inventé | ✅ — et un affichage de note non méritée a été **retiré** |
| Jeton d'accès personnel Supabase | ❌ toujours pas créé, délibérément (§13) |

État final de la base après démontage : **0 chauffeur en ligne, 0 course en attente, 0 offre ouverte.**

## 12. Ce qui reste — et ce que « READY » ne couvre pas

1. **Clic « COMPLETE » du challenge 3DS** — action humaine. L'iframe Stripe n'accepte pas de clic automatisé depuis les surfaces disponibles. **Non bloquant** : l'invariant critique est prouvé (`dispatch_offers: []` tant que le paiement n'est pas résolu), et le défaut que ce scénario a révélé est corrigé et vérifié à distance.
2. **Rotation des identifiants d'`Infos.txt`** — le fichier contient toujours un mot de passe Postgres et un token Mapbox en clair. Il est hors de Git, mais il est sur le disque. À faire sur vos comptes.
3. **Taux de commission** — décision business. Les colonnes existent et restent NULL.
4. **Pondération du scoring pour un chauffeur sans historique** — un compte neuf marque comme un 5,0 sur les 20 % « note » du dispatch. L'affichage est corrigé ; la pondération est une décision produit, et la mission interdisait de toucher aux seuils.
5. **Onboarding chauffeur** — l'approbation reste manuelle. Normal à ce stade, à savoir avant d'ouvrir.

## 13. Décision assumée

Le dashboard proposait de générer un **jeton d'accès personnel Supabase** pour déployer via le CLI. Ce jeton contrôle l'intégralité du compte ; la mission plaçait explicitement l'authentification sensible parmi les motifs d'arrêt. Je ne l'ai pas créé, et le déploiement a été fait autrement.

## 14. Recommandation

L'infrastructure tient. Le vrai enseignement de cette phase n'est pas qu'elle tient, c'est **comment on l'a su** : les deux pannes de ce projet répondaient toutes les deux proprement en HTTP tout en ne faisant rien, et le défaut 3DS se réparait de lui-même avant d'être visible dans les métriques. Les quatre scripts `verify:*` existent pour cette raison et devraient tourner à chaque changement d'infrastructure — ils assertent sur l'état, pas sur des codes de retour.

Avant d'ouvrir à de vrais clients, le point 2 (rotation des identifiants) est le seul qui soit vraiment urgent.
