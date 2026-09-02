import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import {
  getMyCompanyContext,
  listCompanyJobs,
  listCompanyMembers,
  listFleetVehicles,
  listServiceAreas,
  listVehicleAssignments,
} from '@/lib/actions/company';
import { getConnectAvailability, refreshConnectStatus } from '@/lib/actions/connect';
import { getProviderBalances, listLedgerEntries, listPayouts } from '@/lib/actions/finance';
import { BusinessDashboard } from './BusinessDashboard';
import { NoCompany } from './NoCompany';

// Access is membership, not a fourth user_role. A company owner is a normal
// account that happens to have a company_members row; adding a 'business'
// role to the user_role enum would mean touching handle_new_user(), roleHome
// and every policy keyed on role, for no gain — the membership table already
// answers "which company, in what capacity" more precisely than a role could.
export default async function BusinessDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ connect?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const context = await getMyCompanyContext();
  if (!context) return <NoCompany />;

  const { company, role } = context;
  const isOwnerOrAdmin = role === 'owner' || role === 'admin';

  // Stripe redirects back here after onboarding. Coming back is not the same
  // fact as being approved, so the account is re-read from Stripe rather than
  // inferred from the redirect.
  const params = await searchParams;
  if (params.connect === 'return' && isOwnerOrAdmin) {
    try {
      await refreshConnectStatus(company.id);
    } catch {
      // The tab shows whatever status is stored; a failed refresh must not
      // take the whole dashboard down.
    }
  }

  const [members, vehicles, assignments, areas, jobs, zoneAuth] = await Promise.all([
    listCompanyMembers(company.id),
    listFleetVehicles(company.id),
    listVehicleAssignments(company.id),
    listServiceAreas(company.id),
    listCompanyJobs(company.id),
    supabase
      .from('regulated_zone_providers')
      .select('id, official_operator_name, authorization_status, valid_from, valid_to, zone_id')
      .eq('company_id', company.id),
  ]);

  // Money is fetched only for an owner or admin, so a dispatcher's page never
  // holds the numbers in the first place.
  const finance = isOwnerOrAdmin
    ? await (async () => {
        const [balances, entries, payouts, connect] = await Promise.all([
          getProviderBalances(company.id),
          listLedgerEntries(company.id),
          listPayouts(company.id),
          getConnectAvailability(),
        ]);
        return { balances, entries, payouts, connect };
      })()
    : null;

  return (
    <BusinessDashboard
      company={company}
      role={role}
      members={members}
      vehicles={vehicles}
      assignments={assignments}
      areas={areas}
      jobs={jobs}
      zoneAuthorizations={zoneAuth.data ?? []}
      finance={finance}
    />
  );
}
