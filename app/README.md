# TowConnect

Plateforme de remorquage temps réel — usagers, remorqueurs et administration, avec prix transparent affiché avant confirmation.

## Stack

Next.js 16 (App Router) · Supabase (Postgres, Auth, Realtime) · Mapbox · Tailwind CSS v4

## Configuration requise avant de lancer l'app

### 1. Supabase

1. Créez un projet sur [supabase.com](https://supabase.com).
2. Dans le SQL Editor du projet, exécutez **dans l'ordre** :
   - [`supabase/migrations/0001_init.sql`](./supabase/migrations/0001_init.sql) — tables, policies RLS et triggers de base.
   - [`supabase/migrations/0002_hardening.sql`](./supabase/migrations/0002_hardening.sql) — active PostGIS, ajoute la recherche géospatiale, l'acceptation atomique d'une course, et restreint la visibilité de la position des remorqueurs.
   - [`supabase/migrations/0003_lockdown_driver_fields.sql`](./supabase/migrations/0003_lockdown_driver_fields.sql) — verrouille `rating`/`total_services` (même faille qu'`approval_status`) et restreint la lecture des demandes pending au seul remorqueur à qui elles ont été offertes.
3. Déployez et planifiez la Edge Function de nettoyage — voir [`supabase/functions/cleanup-stale/README.md`](./supabase/functions/cleanup-stale/README.md).
4. Dans **Project Settings → API**, copiez l'URL du projet et la clé `anon public`.
5. Dans **Authentication → Sign In / Providers**, activez **Google** si vous voulez le bouton "Continuer avec Google" (voir section Google OAuth ci-dessous). Sinon, l'email/mot de passe fonctionne sans configuration additionnelle (vous pouvez désactiver la confirmation d'email dans **Authentication → Sign In / Email** pour simplifier les tests).

### 2. Mapbox

1. Créez un compte sur [mapbox.com](https://account.mapbox.com/access-tokens) et copiez un token d'accès public.

### 3. Google OAuth (optionnel, pour "Continuer avec Google")

1. Créez des identifiants OAuth 2.0 dans [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Ajoutez l'URL de callback fournie par Supabase (**Authentication → Providers → Google**) comme "Authorized redirect URI".
3. Collez le Client ID / Secret dans Supabase (**Authentication → Providers → Google**).

### 4. Variables d'environnement

Copiez `.env.local.example` vers `.env.local` et remplissez les valeurs :

```bash
cp .env.local.example .env.local
```

## Lancer en local

```bash
npm install
npm run dev
```

Ouvrez [http://localhost:3000](http://localhost:3000).

## Devenir admin

Par défaut, tout compte créé est `user` ou `driver` (choisi à l'inscription). Pour créer un compte admin, inscrivez-vous normalement puis, dans le SQL Editor de Supabase :

```sql
update profiles set role = 'admin' where id = '<uuid-du-compte>';
```

## Tests

Tests unitaires (pricing, calcul de distance) — aucune infra requise :

```bash
npm run test
```

Test d'intégration RLS (confirme qu'un usager ne peut pas lire les requests d'un autre, et qu'un remorqueur ne peut pas s'auto-approuver) — nécessite une vraie instance Supabase jetable (locale via `supabase start`, ou un projet de test) :

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... npm run test:integration
```

Voir l'en-tête de [`scripts/rls-integration-test.ts`](./scripts/rls-integration-test.ts) pour le détail. Ne jamais pointer ce script vers un projet de production — il crée et supprime de vrais comptes.

## Ce qui est simulé dans cette version

- **Paiement** : le prix est calculé et affiché, mais aucune transaction réelle n'est traitée (pas de Stripe pour l'instant).
- **Notifications** : uniquement via Supabase Realtime dans l'app — pas de SMS/push.
