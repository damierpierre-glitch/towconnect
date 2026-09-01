# TowConnect — Premium Brand Refresh

Date : 2026-09-01. Reprise après Phase 5.1. Mission **strictement visuelle et marketing**.
Phase 6 n'est pas commencée.

---

## 0. Les deux références jointes ne sont jamais arrivées

La mission annonce deux pièces jointes — le logo officiel et le mockup premium de
homepage. **Aucun fichier image n'est arrivé avec le message.** Le dépôt n'en
contenait pas non plus : `app/public/` ne contenait que les cinq SVG du starter
Next.js (`file`, `globe`, `next`, `vercel`, `window`), et `favicon.ico` est
toujours l'icône par défaut. Vérifié :

```
$ find . -iname "*.svg" -o -iname "*.png" -o -iname "*.jpg" -o -iname "*.webp"
./app/public/file.svg      ./app/public/globe.svg    ./app/public/next.svg
./app/public/vercel.svg    ./app/public/window.svg   ./app/src/app/favicon.ico
```

Ça change deux choses, et rien d'autre :

**Le logo.** La consigne était explicite : « Ne le remplace pas par un autre logo
généré. » Je n'en ai donc pas dessiné un. Ce qui existait — un émoji 🚛 dans une
tuile orange — était précisément ça : un logo de substitution que la marque n'a
jamais choisi, et qui se dessine différemment sur chaque système d'exploitation.
Il a été retiré au profit d'un **wordmark typographique** : le nom de la marque,
composé dans la police d'affichage de la marque. Un wordmark ne peut pas entrer en
concurrence avec le logo qu'il remplace, contrairement à un symbole inventé.

Surtout, l'installation du vrai fichier est **une ligne**, à un seul endroit :
`BrandMark` est le seul composant qui rend le logo dans toute l'application.
Voir `app/public/brand/README.md` et §1.

**Le mockup.** Le point 4 de la mission décrit la direction en toutes lettres —
dark premium, noir/graphite, orange TowConnect, contrastes marqués, glow très
subtil, hiérarchie forte, responsive impeccable — et demande de « reconstruire la
page proprement en code » plutôt que d'intégrer une image. C'est ce qui a été
fait. Le point 5 prévoyait le cas où le visuel de remorquage ne serait pas assez
propre pour la production : « utiliser la direction artistique sans intégrer
l'image elle-même. » Faute d'image, cette clause s'applique d'elle-même, et les
contraintes qu'elle protégeait sont satisfaites par construction :

| Contrainte du point 5 | État |
|---|---|
| TowConnect seule marque visible | ✅ aucune autre marque nulle part |
| Aucun logo automobile tiers | ✅ aucune image de véhicule |
| Aucun nom de constructeur | ✅ |
| Roues au sol, pas d'essieu flottant, pas de géométrie impossible | ✅ sans objet — aucun rendu de camion |

Les seuls dessins de la page sont trois icônes de ligne SVG écrites à la main
(étiquette, épingle, itinéraire) : formes abstraites, pas de véhicule.

---

## 1. Logo — un seul point d'intégration

**`app/src/components/BrandMark.tsx`** (nouveau) est le seul endroit du code qui
rend le logo. Il alimente :

- la navbar desktop
- la navbar mobile
- les écrans d'authentification (connexion, inscription, confirmation courriel)
- le pied de page, présent sur la homepage et sur toutes les pages publiques

Pour installer le logo officiel :

1. déposer le fichier dans `app/public/brand/` ;
2. le retourner depuis `officialLogo()` dans `BrandMark.tsx`.

Rien d'autre ne change. Le composant bascule alors de lui-même sur `next/image`,
avec un ratio préservé et trois tailles calibrées (`sm` barre, `md` auth/pied de
page, `lg` marketing). `app/public/brand/README.md` contient ces instructions à
côté de l'emplacement du fichier.

Le pied de page est rendu uniquement pour les visiteurs non connectés : un
chauffeur en mission n'a pas besoin d'un pied de page marketing sous sa carte.

---

## 2. Positionnement géographique — corrigé partout

Toutes les promesses de couverture nationale ont été retirées du code livré.
Recherche finale sur `src/` et `public/` pour `canada|canadien|nationwide|yukon|nouvelle-écosse` :
**aucun résultat visible par l'utilisateur.**

| Emplacement | Avant | Après |
|---|---|---|
| `metadata.title` | `Remorquage instantané au Canada` | `Remorquage à la demande — Montréal & Rive-Sud` |
| `metadata.description` | `…partout au Canada.` | `…dans la région de Montréal et la Rive-Sud…` |
| `hero_sub` FR | `Couverture Canada entier — 24/7.` | `…dans la région de Montréal et la Rive-Sud…` |
| `hero_sub` EN | `Coverage across all of Canada — 24/7.` | `…across Montréal and the South Shore…` |
| badge 1 | `🇨🇦 Tout le Canada` / `🇨🇦 All of Canada` | `Montréal & Rive-Sud` / `Montréal & South Shore` |
| `feat3_title` | `Canada entier` / `All of Canada` | `Couverture locale au lancement` / `Local coverage at launch` |
| `feat3_sub` | `Du Yukon à la Nouvelle-Écosse…` | `Disponible d'abord à Montréal et sur la Rive-Sud.` |
| pied de page | — | `Zone de service au lancement : Montréal & Rive-Sud` |

La clé `badge_canada` a été **renommée** `badge_area` plutôt que simplement
revalorisée : une clé qui s'appelle `canada` et qui contient « Montréal » est un
piège pour la prochaine personne qui édite le dictionnaire.

Une balise `openGraph` a été ajoutée (`locale: fr_CA`), parce que la première
chose qu'un lien partagé cite est justement cette phrase.

**Non modifié, volontairement :** `src/lib/mapbox.ts` biaise le géocodage vers le
Canada (`country=ca`). C'est un paramètre technique, pas une promesse
commerciale — et le restreindre serait un changement fonctionnel, hors périmètre.

---

## 3. Hero — conforme à la direction demandée

| Élément | Valeur livrée |
|---|---|
| Headline | `Panne au bord de la route?` — « route? » en orange |
| Sous-titre | texte de la mission, au mot près |
| Badges | `Montréal & Rive-Sud` · `Réponse rapide` · `Prix transparent` |
| CTA principal | `Demander de l'aide` → `/signup` |
| CTA secondaire | `Connexion` → `/login` |

Les émojis des badges (🇨🇦 ⚡ 🔒) et du CTA (🚨) ont été retirés : ils rendaient
différemment sur chaque plateforme, ce qu'une passe de marque est justement censée
faire cesser. Les badges portent maintenant une pastille colorée cohérente avec le
reste du système.

**Le wordmark n'est pas répété dans le hero.** La première version l'affichait en
grand juste sous la navbar, qui le contient déjà — la page disait son propre nom
deux fois avant de dire quoi que ce soit. Remplacé par un filet-titre discret
(« Assistance routière à la demande », capitales espacées, filets orange).

---

## 4. Direction visuelle

Reconstruite en code, sans image statique. Nouvelles primitives CSS dans
`globals.css`, toutes bâties sur les jetons existants (`night`, `steel`, `orange`) :

- `.brand-aura` — deux dégradés radiaux orange très faibles (0.16 / 0.06). Un glow
  qu'on peut désigner du doigt est un dégradé ; un glow qu'on ne peut pas désigner
  est une atmosphère.
- `.brand-grid` — grille technique à 3,5 % d'opacité, masquée en radial pour ne
  jamais lire comme une texture répétée.
- `.hairline-top` — arête d'1 px qui accroche la lumière, comme un panneau
  physique.
- `.surface-card` — surface en dégradé, bordure orange **au survol seulement**,
  pour qu'une grille de cartes reste calme au repos.
- `.cta-glow` — le seul glow appuyé de la page, réservé au CTA principal.
- `::selection` orange et anneau de focus orange visible : sur un fond quasi noir,
  l'anneau par défaut du navigateur est presque invisible.
- Tout ce qui bouge est désactivé sous `prefers-reduced-motion`.

Structure de la homepage : hero → *Comment ça marche* (3 étapes) → 3 cartes
fonctionnalités → bloc de conversion, avec un rappel « Vous êtes remorqueur? »
vers l'inscription partenaire (les deux côtés d'une place de marché).

Détail corrigé en cours de route : les numéros d'étapes étaient composés en Syne,
dont les chiffres sont difficiles à lire à 15 px. Ils utilisent maintenant la
police de texte.

---

## 5. Feature cards

| Titre | Sous-titre |
|---|---|
| Prix transparent | Voyez le prix estimé avant de confirmer. |
| Suivi en temps réel | Suivez votre remorqueur en direct sur la carte. |
| Couverture locale au lancement | Disponible d'abord à Montréal et sur la Rive-Sud. |

Formulations exactes de la mission. Émojis (💵 📍 🍁) remplacés par des icônes de
ligne SVG. Le 🍁 disparaît de lui-même avec le repositionnement géographique.

---

## 6. Mobile — un vrai débordement, trouvé et corrigé

Vérifié à 320, 375 et 1280 px, connecté **et** déconnecté.

**Le défaut.** Syne est une police d'affichage large : « TowConnect » en 800 mesure
**≈ 10,2 × la taille de police**, soit 194 px à 19 px. Sur une navbar de 375 px, le
wordmark seul poussait le bouton `S'inscrire` hors de l'écran. Mesuré, pas
supposé :

```
375px AVANT : navKids = [194, 0, 164]  signupRight = 387  (viewport 375) -> COUPÉ
375px APRÈS : navKids = [153, 0, 156]  signupRight = 361  scrollW = 375  -> OK
320px AVANT : scrollW = 332 > clientW = 320  -> DÉBORDE de 12px
320px APRÈS : scrollW = 320 = clientW = 320  overflowing = []  -> OK
```

Corrections : wordmark responsive (14 / 15 / 19 px), espacements et paddings
resserrés sous `sm`, `Connexion` masqué sous 380 px (le bouton d'inscription est
celui qui mérite la place), globe du sélecteur de langue masqué sous 360 px.

**Vérification anti-débordement**, exécutée sur chaque largeur — elle liste tout
élément dont le bord droit dépasse le viewport :

```js
[...document.querySelectorAll('*')].filter(e =>
  e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
```

→ `[]` à 320, 375 et 1280 px, homepage et connexion.

**Navbar connectée.** Vérifiée en forçant temporairement `role='driver'` dans le
layout — un changement local, immédiatement annulé, qui ne touche **aucune
donnée** : pas de faux chauffeur, pas d'écriture en base. Le menu hamburger
s'ouvre (`aria-expanded=true`) et rend les six liens attendus : `Remorqueur`,
`Profil`, `Documents`, `Revenus`, `Historique`, `Performance`, plus `Déconnexion`.
Aucun débordement à 375 px, aucun à 1280 px. La barre desktop a d'ailleurs *gagné*
de la place : l'ancien bloc tuile-émoji + texte faisait ~230 px, le wordmark seul
en fait 194.

---

## 7. Ce qui n'a pas été touché

Aucune modification à : authentification, Smart Dispatch, Stripe, RLS et
migrations, tableau de bord chauffeur, admin, suivi, messagerie, moteur de prix.
Aucune migration ajoutée. Aucun changement du taux de commission. Le diff se limite
à sept fichiers modifiés et trois ajoutés, tous de présentation.

```
 M app/src/app/(auth)/login/page.tsx      en-tête de marque
 M app/src/app/(auth)/signup/page.tsx     en-tête de marque (2 vues)
 M app/src/app/LandingHero.tsx            reconstruction complète
 M app/src/app/globals.css                primitives de marque (ajout seul)
 M app/src/app/layout.tsx                 metadata, viewport, pied de page
 M app/src/components/NavBar.tsx          logo + responsive
 M app/src/lib/i18n/dictionary.ts         textes FR/EN
?? app/public/brand/                      emplacement du logo + instructions
?? app/src/components/BrandMark.tsx       point d'intégration unique
?? app/src/components/SiteFooter.tsx      pied de page de marque
```

Les écrans d'authentification n'ont reçu qu'une enveloppe visuelle : la logique de
soumission, `signInWithPassword`, `signUp`, OAuth Google et le flux de
confirmation par courriel sont identiques au caractère près.

---

## 8. Tests

| Commande | Résultat |
|---|---|
| `npx tsc --noEmit` | ✅ |
| `npm run lint` | ✅ |
| `npm run build` | ✅ — 19 routes générées |
| `npm run test` | ✅ 30/30 |

Vérification manuelle sur serveur de développement réel : homepage, connexion et
inscription, en **FR et EN**, à 320 / 375 / 1280 px, déconnecté et connecté.
Console propre au chargement de la homepage (seules erreurs restantes : le
websocket HMR du serveur de développement).

Les 107 assertions RLS n'ont pas été réexécutées : aucune migration, aucune policy
et aucune requête n'a été modifiée par cette mission.

---

## 9. Limitations

1. **Le logo officiel n'est pas installé** — il n'a pas été fourni. C'est le seul
   point ouvert de la mission. Un fichier dans `app/public/brand/` et une ligne
   dans `BrandMark.tsx` le referment.
2. **`favicon.ico` est toujours l'icône Next.js par défaut.** À dériver du logo
   officiel en même temps — c'est la marque dans l'onglet du navigateur.
3. **Aucune image `openGraph`** : une carte de partage sans image est plus faible
   qu'avec. À produire à partir du logo, au même moment.
4. **`badge_canada` a été renommée `badge_area`** : toute référence externe devrait
   être mise à jour (aucune n'existe dans le dépôt).
5. Les rapports de phases antérieures contiennent encore l'ancien positionnement.
   Ce sont des documents historiques, pas du contenu livré ; ils n'ont pas été
   réécrits.
