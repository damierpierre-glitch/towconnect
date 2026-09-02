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
import { BusinessDashboard } from './BusinessDashboard';
import { NoCompany } from './NoCompany';

// Access is membership, not a fourth user_role. A company owner is a normal
// account that happens to have a company_members row; adding a 'business'
// role to the user_role enum would mean touching handle_new_user(), roleHome
// and every policy keyed on role, for no gain — the membership table already
// answers "which company, in what capacity" more precisely than a role could.
export default async function BusinessDashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const context = await getMyCompanyContext();
  if (!context) return <NoCompany />;

  const { company, role } = context;

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
    />
  );
}
