// What actually happens when a real person signs up.
//
//   npx tsx scripts/audit-auth-email.ts
//
// Reads the account lifecycle from the outside, the way a customer meets it:
// call the public signup API with the anon key, then look at what the
// database recorded. It creates one throwaway account and deletes it.
//
// Prints no secret and no link.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const anon = createClient(URL, ANON, { auth: { persistSession: false } });
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

async function main() {
  // @example.com is rejected outright by Supabase's address validation, so a
  // probe has to use a domain that looks real. Overridable, because the only
  // way to test DELIVERY is an address somebody actually reads.
  const email = process.argv[2] ?? `p10-authprobe-${Date.now()}@towconnect.ca`;

  console.log('\nSignup through the public API, exactly as the form does:\n');
  const started = Date.now();
  const { data, error } = await anon.auth.signUp({
    email,
    password: 'AuthProbe!2026',
    options: { data: { role: 'user', full_name: 'Auth Probe' } },
  });
  const ms = Date.now() - started;

  console.log(`  error        ${error ? `${error.status} ${error.message}` : 'none'}`);
  console.log(`  user         ${data.user?.id ?? 'none'}`);
  console.log(`  session      ${data.session ? 'issued immediately' : 'none — confirmation required'}`);
  console.log(`  took         ${ms} ms`);

  if (data.user?.id) {
    // What the database recorded. confirmation_sent_at is Supabase saying it
    // handed the message to its mail transport — NOT that anybody received it.
    const { data: row } = await admin
      .from('auth_users_probe' as never)
      .select('*')
      .limit(0);
    void row;

    const { data: listed } = await admin.auth.admin.listUsers({ perPage: 200 });
    const created = listed.users.find((u) => u.id === data.user!.id);
    console.log('');
    console.log(`  email_confirmed_at    ${created?.email_confirmed_at ?? 'null — not confirmed'}`);
    console.log(
      `  confirmation_sent_at  ${(created as { confirmation_sent_at?: string } | undefined)?.confirmation_sent_at ?? 'null — nothing was handed to the mailer'}`
    );

    await admin.auth.admin.deleteUser(data.user.id);
    console.log('\n  probe account deleted');
  }
  console.log('');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
