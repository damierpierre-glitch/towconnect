# TowConnect — Phase 4.5 : mise en service infrastructure

Date : 2026-08-31
Aucune valeur de secret ne figure dans ce document.

---

## Verdict

**NOT READY**

Les deux corrections de code demandées (§10 et §11) sont **faites, appliquées en base et vérifiées** : la suite RLS live passe intégralement, désormais **78 assertions** (73 → 78).

En revanche les trois blockers d'infrastructure **ne sont pas levés**, et l'investigation a mis au jour un **défaut réel supplémentaire, plus grave que celui visé** : les deux Edge Functions rejettent *tous* les appelants — `cleanup-stale` était déployée depuis un jour et n'aurait rien fait à chaque exécution planifiée. Le correctif est écrit et les secrets sont configurés, mais le déploiement final bute sur un outillage que je ne peux pas franchir seul.

---

## 1. Edge Functions déployées

| Fonction | État |
|---|---|
| `cleanup-stale` | Déjà déployée avant cette mission (2 déploiements) |
| `dispatch-tick` | **Déployée** pendant cette mission (3 déploiements successifs) |

Aucune fonction parasite n'a été créée (la liste finale contient exactement ces deux fonctions).

### 🔴 Défaut trouvé : les deux fonctions rejettent tout appelant

Test direct des endpoints :

| Appel | dispatch-tick | cleanup-stale |
|---|---|---|
| sans en-tête d'auth | 401 (passerelle plateforme) | 401 |
| clé anon | 401 (notre code) | 401 |
| **clé service_role** | **401 (notre code)** | **401** |

Le corps `Unauthorized` est *notre* message : la requête franchit la passerelle et c'est notre propre comparaison qui échoue. Les deux fonctions comparaient l'en-tête à `SUPABASE_SERVICE_ROLE_KEY` — que Supabase marque désormais **DEPRECATED**, le jeu de secrets par défaut exposant `SUPABASE_SECRET_KEYS` (un dictionnaire JSON) à la place.

**Conséquence réelle** : `cleanup-stale` était déployée et, une fois planifiée, aurait renvoyé 401 à chaque exécution — les courses jamais expirées, les chauffeurs fantômes jamais mis hors ligne. Le filet de sécurité que la Phase 2.5 documentait comme « le backstop » n'aurait jamais fonctionné.

Second obstacle découvert en tentant de corriger : avec « Verify JWT » activé sur la fonction, la plateforme **exige un JWT dans `Authorization`** et répond `UNAUTHORIZED_INVALID_JWT_FORMAT` à un secret opaque. Un secret partagé ne peut donc pas voyager dans cet en-tête.

### Correctif écrit (non encore vérifié en production)

- Les deux fonctions lisent maintenant le secret dans un en-tête dédié **`x-cron-secret`**, laissant `Authorization` libre pour le JWT que la passerelle réclame (la clé anon publique suffit). Fonctionne que « Verify JWT » soit activé ou non.
- Comparaison **à temps constant** (un `!==` fuit par le timing la portion de secret devinée).
- **Échec fermé** : sans secret configuré, rien n'est accepté.
- La clé privilégiée pour l'accès base vient de `CRON_DB_KEY`, avec repli sur la clé legacy.
- Secrets **déjà créés** côté Supabase : `CRON_SECRET` et `CRON_DB_KEY` (visibles dans Edge Function Secrets, valeurs jamais affichées ici).

Il reste à déployer ce code et à confirmer un `200`.

## 2. Scheduler

**Non configuré.** Planifier des fonctions qui répondent 401 n'aurait fait qu'inscrire un échec récurrent dans les logs. Cette étape est volontairement reportée après la vérification du §1 — la mission demandait de contrôler les effets réels, pas seulement de créer la configuration.

## 3. Mapbox

**Non configuré.** Le token existe bien dans Vercel (`NEXT_PUBLIC_MAPBOX_TOKEN`, Production), mais je n'ai pas pu l'extraire :

- Les boutons « Copy » de Vercel (et de Stripe) n'écrivent pas dans le presse-papier depuis cette surface d'automatisation — vérifié : le presse-papier restait inchangé après le clic.
- Le token n'est pas dans le bundle déployé : la page `/request` est derrière authentification, donc le chunk qui le contient n'est pas servi publiquement.
- `Infos.txt` **n'a pas été utilisé**, conformément à la consigne.

## 4. Remorquage avec destination

**Non validé** — dépend du token Mapbox : sans géocodage, la destination ne peut pas obtenir de coordonnées, et le formulaire (correctement) refuse de soumettre.

Ce qui **est** déjà vérifié sur cet axe, depuis la session précédente et inchangé : la section destination apparaît bien pour « Panne mécanique » / « Accident » et reste masquée sinon ; le calcul `estimatePriceBreakdown` avec `towDistanceKm` est couvert par les tests unitaires ; `tow_distance_km` est calculé serveur, jamais reçu du navigateur.

## 5. Webhook Stripe distant

**Non configuré**, et pour une raison de fond qu'il faut expliciter :

> Le déploiement Vercel `towconnect-chi.vercel.app` date de ~24 h et **précède tout le travail des Phases 1 à 4**, qui est encore **non commité** localement. La route `/api/stripe/webhook` n'existe donc pas en ligne — y pointer un endpoint Stripe ne produirait que des 404.

Configurer ce webhook suppose d'abord de déployer le code actuel, ce qui implique de committer et pousser sur `main` (déclenchant un déploiement public d'une application qui manipule des paiements) **et** de renseigner des secrets de production sur Vercel. C'est une action sortante et durable que je n'ai pas prise seul.

## 6. 3DS

**Non rejoué** cette phase : sans déploiement ni token Mapbox, le scénario n'apportait rien de neuf par rapport à la session précédente, où il est déjà établi que le challenge s'affiche correctement et que **`dispatch offers: 0`** tant que le paiement n'est pas résolu. Seul le clic « COMPLETE » (iframe cross-origin) reste à faire par un humain.

## 7. Corrections supplémentaires réalisées

### §10 — Estimation et dispatch réconciliés (migration `0017`, appliquée ✅)

`nearby_drivers()` ignorait la fraîcheur du heartbeat alors que le dispatch l'exigeait (2 min) : un client pouvait être **facturé sur la base d'un chauffeur auquel la course ne serait jamais offerte**. La règle est remontée dans `nearby_drivers()` elle-même — le point de passage unique de l'estimation, du prix serveur et de la recherche de candidat — et la fenêtre vit désormais dans une fonction dédiée (`driver_heartbeat_max_age()`) plutôt qu'en littéral dupliqué. Le filtre redondant côté dispatch est conservé volontairement (défense en profondeur).

### §11 — Écriture systématiquement annulée supprimée (migration `0017`, appliquée ✅)

Sur offre expirée, `respond_to_dispatch_offer()` marquait l'offre `timeout` **puis** levait une exception — qui annulait cette écriture. Le code et son commentaire affirmaient un changement d'état qui n'avait jamais lieu. L'écriture est retirée ; la garantie essentielle (**une offre expirée ne peut jamais être acceptée**) est intacte, portée par le `RAISE` lui-même.

En complément, côté application : `acceptRequest()` détecte cette erreur et déclenche immédiatement `nudge_dispatch()` dans une **transaction séparée** — l'offre périmée est donc réellement soldée et la course repart vers le candidat suivant, au lieu d'attendre un poll.

## 8. Tests

| Test | Résultat |
|---|---|
| `npx tsc --noEmit` | ✅ |
| `npm run lint` | ✅ 0 erreur, 0 warning |
| `npm run build` | ✅ |
| `npm run test` (vitest) | ✅ 27/27 |
| `npm run test:integration` | ✅ **78/78** — « All RLS invariants held » |

Cinq assertions ajoutées pour les corrections ci-dessus : chauffeur au heartbeat périmé exclu de `nearby_drivers()` ; dispatch d'accord avec l'estimation quand le seul chauffeur est périmé ; chauffeur redevenu frais à nouveau cotable **et** dispatchable ; offre laissée intacte par un accept refusé ; balayage ultérieur qui la solde en `timeout`.

## 9. Sécurité

| Contrôle | Résultat |
|---|---|
| Aucun secret dans le diff / fichiers non suivis | ✅ (seul « match » : ce rapport citant des motifs de recherche) |
| `.env.local` et `Infos.txt` ignorés par Git | ✅ |
| Stripe strictement Sandbox, aucune clé live | ✅ |
| Aucun paiement réel | ✅ aucune transaction créée cette phase |
| Mapbox **non** récupéré depuis `Infos.txt` | ✅ |
| service_role côté serveur uniquement | ✅ inchangé |
| Edge Functions | ✅ échouent **fermé** (toute voie non autorisée → 401) |
| Aucune donnée réelle supprimée | ✅ |

Décision prise en cours de route : le dashboard proposait de générer un **jeton d'accès personnel Supabase** pour déployer via le CLI. Ce jeton « peut contrôler l'intégralité du compte » ; je ne l'ai pas créé, la mission plaçant explicitement l'authentification sensible parmi les motifs d'arrêt.

À signaler : le presse-papier de la machine sert de canal de transport pour éviter que les secrets transitent par la conversation. Il est partagé avec votre session réelle — à un moment, un contenu personnel sans rapport (un brouillon de courriel) s'y trouvait et a été collé dans un éditeur de fonction ; **rien n'a été déployé** et l'éditeur a été écrasé aussitôt.

## 10. Blockers restants

**B1 — Déployer les deux Edge Functions corrigées** (bloque aussi le §2).
Tout est prêt : code corrigé dans le repo, `CRON_SECRET` et `CRON_DB_KEY` déjà créés côté Supabase. Il manque un mécanisme de déploiement fiable — l'éditeur navigateur du dashboard s'est révélé trop instable (pages qui ne chargent pas, collages qui n'atterrissent pas, un déploiement sur trois qui aboutit).

```bash
npx supabase login
npx supabase functions deploy dispatch-tick --project-ref cnwkchbuuzfquxckfwdw
npx supabase functions deploy cleanup-stale --project-ref cnwkchbuuzfquxckfwdw
```

Puis vérifier — le premier doit renvoyer 401, le second 200 :

```bash
curl -i -X POST https://cnwkchbuuzfquxckfwdw.supabase.co/functions/v1/dispatch-tick -H "Authorization: Bearer <ANON_KEY>"
curl -i -X POST https://cnwkchbuuzfquxckfwdw.supabase.co/functions/v1/dispatch-tick -H "Authorization: Bearer <ANON_KEY>" -H "x-cron-secret: <CRON_SECRET>"
```

**B2 — Décider du déploiement Vercel** (bloque §5, §6 et le webhook distant).
Le travail des Phases 1-4 est intégralement non commité. Publier une application de paiement et renseigner des secrets de production est votre décision : souhaitez-vous que je committe sur `main`, sur une branche, ou que vous relisiez d'abord ?

**B3 — Token Mapbox** (bloque §4).
La valeur est dans Vercel. Le plus simple : la coller vous-même dans `app/.env.local` (`NEXT_PUBLIC_MAPBOX_TOKEN=…`), ou m'autoriser à la lire autrement.

**B4 — Clic « COMPLETE » du challenge 3DS** — action humaine, anticipée par la mission.

**B5 — Rotation des identifiants d'`Infos.txt`** — toujours en attente, action sur vos comptes.

**B6 — Taux de commission** — décision business, inchangée.

## 11. Recommandation

Traiter **B1** puis **B2** dans cet ordre : le premier rend le filet de sécurité du dispatch réellement opérationnel (aujourd'hui il ne l'est pas, ce qui est le point le plus important de ce rapport), le second débloque d'un coup le webhook distant, le test destination et le 3DS.
