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
   - [`supabase/migrations/0004_fix_profiles_admin_recursion.sql`](./supabase/migrations/0004_fix_profiles_admin_recursion.sql) — corrige une récursion infinie dans la policy admin de `profiles`.
   - [`supabase/migrations/0005_vehicles.sql`](./supabase/migrations/0005_vehicles.sql) — ajoute les véhicules enregistrés (table `vehicles`, véhicule principal, `requests.vehicle_id`).
   - [`supabase/migrations/0006_smart_dispatch.sql`](./supabase/migrations/0006_smart_dispatch.sql) — ajoute Smart Dispatch (table `dispatch_offers`, `dispatch_next_candidate()`, `respond_to_dispatch_offer()`, `process_dispatch_timeouts()`).
   - [`supabase/migrations/0007_dispatch_immediate_advance.sql`](./supabase/migrations/0007_dispatch_immediate_advance.sql) — un refus déclenche l'offre suivante immédiatement (sans dépendre du cron) ; ajoute `nudge_dispatch()` pour un timeout géré côté client en quelques secondes.
   - [`supabase/migrations/0008_messages.sql`](./supabase/migrations/0008_messages.sql) — messagerie in-app entre client et remorqueur assigné (table `messages`, RLS).
   - [`supabase/migrations/0009_in_progress_status.sql`](./supabase/migrations/0009_in_progress_status.sql) — ajoute le statut `in_progress` (intervention en cours).
   - [`supabase/migrations/0010_request_status_guard.sql`](./supabase/migrations/0010_request_status_guard.sql) — empêche un remorqueur de sauter ou d'inverser des statuts d'intervention côté serveur.
   - [`supabase/migrations/0011_in_progress_active_job.sql`](./supabase/migrations/0011_in_progress_active_job.sql) — étend l'exclusivité "un seul job actif par remorqueur" et la visibilité du profil remorqueur au statut `in_progress`.
   - [`supabase/migrations/0012_destination_and_pricing_snapshot.sql`](./supabase/migrations/0012_destination_and_pricing_snapshot.sql) — destination structurée + snapshot de prix figé (`price_base`/`price_distance`/`price_surcharge`), colonnes de commission préparées (non calculées).
   - [`supabase/migrations/0013_payments.sql`](./supabase/migrations/0013_payments.sql) — infrastructure Stripe (table `payments`, `payment_status`, journal d'idempotence `stripe_webhook_events`, `profiles.stripe_customer_id`).
   - [`supabase/migrations/0014_request_field_lockdown.sql`](./supabase/migrations/0014_request_field_lockdown.sql) — un remorqueur assigné ne peut modifier que `status` sur sa course ; tout le reste (prix, destination, véhicule, etc.) est verrouillé côté serveur.
   - [`supabase/migrations/0015_fix_nudge_dispatch_guard.sql`](./supabase/migrations/0015_fix_nudge_dispatch_guard.sql) — corrige une régression du verrouillage 0014 qui bloquait `nudge_dispatch()` appelé par le remorqueur détenteur de l'offre expirée.

   > **Important — appliquez `0009` seule, séparément des suivantes.** `0009` fait un `ALTER TYPE ... ADD VALUE` : Postgres interdit d'utiliser la nouvelle valeur d'enum tant que la transaction qui l'ajoute n'est pas *commitée*. Si vous collez plusieurs migrations d'un coup dans le SQL Editor, `0011` (qui référence `'in_progress'` dans un index) échouera. Exécutez chaque fichier de migration comme un lot distinct.
3. Déployez et planifiez les deux Edge Functions de fond :
   - [`supabase/functions/cleanup-stale/README.md`](./supabase/functions/cleanup-stale/README.md) — nettoyage (toutes les minutes).
   - [`supabase/functions/dispatch-tick/README.md`](./supabase/functions/dispatch-tick/README.md) — avance Smart Dispatch (offres expirées, chauffeur suivant) — idéalement toutes les ~15s, voir le README pour le compromis si votre plan ne permet que la granularité minute.
4. Dans **Project Settings → API**, copiez l'URL du projet, la clé `anon public` et la clé `service_role` (secrète — nécessaire aux paiements, voir §5).
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

### 5. Stripe (optionnel — les paiements restent inertes tant qu'il n'est pas configuré)

1. Créez un compte sur [dashboard.stripe.com](https://dashboard.stripe.com) (mode test suffit en développement).
2. **Developers → API keys** : copiez la clé secrète (`STRIPE_SECRET_KEY`) et la clé publique (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`).
3. Webhook : soit `stripe listen --forward-to localhost:3000/api/stripe/webhook` en local (copiez le secret affiché), soit **Developers → Webhooks → Add endpoint** en production pointant vers `https://<votre-domaine>/api/stripe/webhook`, événements `payment_intent.amount_capturable_updated`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded` — copiez le "Signing secret" dans `STRIPE_WEBHOOK_SECRET`.
4. Tant qu'aucune clé Stripe n'est configurée, `/request` fonctionne exactement comme en Phase 1-3 (aucune étape de paiement) — voir `TOWCONNECT_PHASE4_REPORT.md` pour le détail.

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

- **Paiement** : l'intégration Stripe (autorisation à la confirmation, capture à la complétion, webhook, reçu) est complète côté code, mais **inerte tant que les clés Stripe ne sont pas configurées** — voir §5 ci-dessus. Sans clés, `/request` fonctionne exactement comme avant (aucune étape de paiement).
- **Commission TowConnect / versement partenaire** : le schéma est prêt (`commission_amount`/`partner_amount`) mais aucun taux n'est appliqué — décision business à prendre, voir `TOWCONNECT_PHASE4_REPORT.md`.
- **Notifications** : uniquement via Supabase Realtime dans l'app — pas de SMS/push.
