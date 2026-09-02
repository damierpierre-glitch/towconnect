// Phase 9 — exports, verified by PARSING the files that come out.
//
// A test that only checks "the export did not throw" proves nothing about the
// deliverable: the failure modes here are mangled accents, a decimal comma
// Excel cannot sum, a date column that sorts alphabetically wrong, and — the
// one that matters most — a role receiving a file it had no right to.
//
// So every file produced below is read back: the CSV is decoded and split, the
// XLSX is re-opened with ExcelJS, and the cell values are compared to what the
// database actually holds.
//
//   npm run test:exports
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import ExcelJS from 'exceljs';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

import { actAs } from './e2e/session';
import { listAvailableExports, runExport } from '@/lib/actions/exports';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const results: { name: string; pass: boolean; detail?: string }[] = [];
let section = '';
const sect = (s: string) => {
  section = s;
  console.log(`\n── ${s}`);
};
const ok = (name: string, pass: boolean, detail?: string) => {
  results.push({ name: `[${section}] ${name}`, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${!pass && detail ? ` — ${detail}` : ''}`);
};

interface Actor {
  id: string;
  token: string;
  client: SupabaseClient;
}
const createdUserIds: string[] = [];

async function makeAdmin(who: string, capability: string): Promise<Actor> {
  const email = `p9-${who}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = 'test-password-123!';
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role: 'user', full_name: `Phase 9 ${who}` },
  });
  if (error || !data.user) throw new Error(`could not create ${who}: ${error?.message}`);
  createdUserIds.push(data.user.id);

  await admin.from('profiles').update({ role: 'admin' }).eq('id', data.user.id);
  await admin
    .from('admin_grants')
    .insert({ profile_id: data.user.id, capability } as never);

  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  for (let attempt = 1; ; attempt++) {
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (!signInError) break;
    if (!/rate limit/i.test(signInError.message) || attempt >= 5) {
      throw new Error(`could not sign in ${who}: ${signInError.message}`);
    }
    console.log(`  … auth rate limit, waiting 65s (${attempt}/4)`);
    await new Promise((r) => setTimeout(r, 65_000));
  }
  const { data: session } = await client.auth.getSession();
  return { id: data.user.id, token: session.session!.access_token, client };
}

function decodeCsv(base64: string): { raw: string; header: string[]; rows: string[][] } {
  const raw = Buffer.from(base64, 'base64').toString('utf8');
  const withoutBom = raw.replace(/^﻿/, '');
  const lines = withoutBom.split('\r\n').filter((l) => l.length > 0);
  const parse = (line: string) => {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        cells.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current);
    return cells;
  };
  return { raw, header: parse(lines[0] ?? ''), rows: lines.slice(1).map(parse) };
}

async function main() {
  const opsAdmin = await makeAdmin('ops', 'operations');
  const financeAdmin = await makeAdmin('finance', 'finance');
  const supportAdmin = await makeAdmin('support', 'support');
  const superAdmin = await makeAdmin('super', 'super_admin');

  try {
    // ================================================================
    sect('1. Each capability is offered only its own domain');
    // ================================================================
    actAs(opsAdmin.token, 'operations');
    const opsDatasets = (await listAvailableExports()).map((d) => d.key);
    actAs(financeAdmin.token, 'finance');
    const financeDatasets = (await listAvailableExports()).map((d) => d.key);
    actAs(supportAdmin.token, 'support');
    const supportDatasets = (await listAvailableExports()).map((d) => d.key);
    actAs(superAdmin.token, 'super admin');
    const superDatasets = (await listAvailableExports()).map((d) => d.key);

    ok('operations is offered operational datasets', opsDatasets.includes('requests') && opsDatasets.includes('dispatch'));
    ok('operations is NOT offered the ledger', !opsDatasets.includes('ledger'), opsDatasets.join(', '));
    ok('operations is NOT offered payouts', !opsDatasets.includes('payouts'));
    ok('finance is offered financial datasets', financeDatasets.includes('ledger') && financeDatasets.includes('payouts'));
    ok('finance is NOT offered regulated zones', !financeDatasets.includes('regulated_zones'), financeDatasets.join(', '));
    ok('finance is NOT offered driver documents', !financeDatasets.includes('driver_documents'));
    ok('support is offered only its narrow view', supportDatasets.includes('support_requests'));
    ok('support is NOT offered incidents', !supportDatasets.includes('incidents'), supportDatasets.join(', '));
    ok('support is NOT offered the ledger', !supportDatasets.includes('ledger'));
    ok('super admin is offered every dataset', superDatasets.length >= 15, `${superDatasets.length}`);

    // ================================================================
    sect('2. Cross-domain exports are refused on the server');
    // ================================================================
    const refused = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        ok(what, false, 'the export was produced');
      } catch {
        ok(what, true);
      }
    };

    actAs(opsAdmin.token, 'operations');
    await refused('operations cannot export the ledger', () =>
      runExport({ dataset: 'ledger', format: 'csv' })
    );
    await refused('operations cannot export payouts', () =>
      runExport({ dataset: 'payouts', format: 'xlsx' })
    );

    actAs(financeAdmin.token, 'finance');
    await refused('finance cannot export regulated zones', () =>
      runExport({ dataset: 'regulated_zones', format: 'csv' })
    );
    await refused('finance cannot export driver documents', () =>
      runExport({ dataset: 'driver_documents', format: 'csv' })
    );

    actAs(supportAdmin.token, 'support');
    await refused('support cannot export incidents', () =>
      runExport({ dataset: 'incidents', format: 'csv' })
    );
    await refused('support cannot export the ledger', () => runExport({ dataset: 'ledger', format: 'csv' }));
    await refused('support cannot export payments', () => runExport({ dataset: 'payments', format: 'csv' }));

    // An admin holding nothing exports nothing — the Phase 8.1 rule, applied
    // here too.
    await admin.from('admin_grants').delete().eq('profile_id', supportAdmin.id);
    await refused('an admin stripped of every capability can export nothing', () =>
      runExport({ dataset: 'support_requests', format: 'csv' })
    );
    await admin
      .from('admin_grants')
      .insert({ profile_id: supportAdmin.id, capability: 'support' } as never);

    // ================================================================
    sect('3. The CSV is one Excel can actually open');
    // ================================================================
    actAs(opsAdmin.token, 'operations');
    const csv = await runExport({ dataset: 'requests', format: 'csv' });
    const parsed = decodeCsv(csv.content);

    ok('the file is named .csv', csv.filename.endsWith('.csv'));
    ok(
      'it starts with a byte-order mark, so Excel reads it as UTF-8',
      Buffer.from(csv.content, 'base64').toString('utf8').startsWith('﻿'),
      'without it every accent is mangled on Windows'
    );
    ok(
      'French accents survive the round trip',
      parsed.header.includes('Créée le') && parsed.header.includes('Zone réglementée'),
      parsed.header.join(' | ')
    );
    ok('the header matches the declared columns', parsed.header.length === 12, `${parsed.header.length} columns`);
    ok('the row count matches what was reported', parsed.rows.length === csv.rowCount, `${parsed.rows.length} vs ${csv.rowCount}`);

    if (parsed.rows.length > 0) {
      const priceIndex = parsed.header.indexOf('Prix client');
      const dateIndex = parsed.header.indexOf('Créée le');
      const prices = parsed.rows.map((r) => r[priceIndex]).filter((v) => v !== '');
      ok(
        'money is a plain number with a dot, so Excel can sum it',
        prices.every((v) => /^-?\d+(\.\d+)?$/.test(v)),
        prices.slice(0, 3).join(', ')
      );
      const dates = parsed.rows.map((r) => r[dateIndex]).filter((v) => v !== '');
      ok(
        'dates are ISO-shaped, so they sort correctly as text',
        dates.every((v) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)),
        dates.slice(0, 2).join(', ')
      );
      ok(
        'every cell is quoted, so an address containing a comma cannot split a row',
        parsed.rows.every((r) => r.length === parsed.header.length),
        'a row has the wrong number of cells'
      );
    } else {
      ok('an empty dataset still produces a header row', parsed.header.length > 0);
    }

    // ================================================================
    sect('4. The XLSX is a real spreadsheet');
    // ================================================================
    actAs(financeAdmin.token, 'finance');
    const xlsx = await runExport({ dataset: 'ledger', format: 'xlsx' });
    ok('the file is named .xlsx', xlsx.filename.endsWith('.xlsx'));

    const workbook = new ExcelJS.Workbook();
    // Node's Buffer generic and ExcelJS's declared parameter disagree; the
    // bytes are identical, and re-opening the file is the whole point.
    // ExcelJS declares an older Buffer shape than Node's current typings.
    // The bytes are identical; re-opening the real file is the whole point.
    await workbook.xlsx.load(Buffer.from(xlsx.content, 'base64') as never);
    const sheetNames = workbook.worksheets.map((w) => w.name);
    ok('it opens as a workbook', workbook.worksheets.length >= 1, sheetNames.join(', '));
    ok('it has a Résumé sheet and a Données sheet', sheetNames.includes('Résumé') && sheetNames.includes('Données'), sheetNames.join(', '));

    const data = workbook.getWorksheet('Données')!;
    const headerRow = data.getRow(1);
    const headers = (headerRow.values as unknown[]).slice(1).map(String);
    ok('accented headers survive into the workbook', headers.includes('Écriture du'), headers.join(' | '));
    ok('the header row is bold', headerRow.font?.bold === true);
    ok(
      'the sheet has as many data rows as were reported',
      data.rowCount - 1 === xlsx.rowCount,
      `${data.rowCount - 1} vs ${xlsx.rowCount}`
    );

    const summary = workbook.getWorksheet('Résumé')!;
    const summaryLabels: string[] = [];
    summary.eachRow((row) => {
      const label = row.getCell(1).value;
      if (label) summaryLabels.push(String(label));
    });
    ok(
      'the Résumé sheet states what it counted',
      summaryLabels.some((l) => l.includes('Lignes dans l’onglet Données')),
      summaryLabels.join(' | ')
    );

    if (xlsx.rowCount > 0) {
      const amountColumn = headers.indexOf('Montant') + 1;
      const firstAmount = data.getRow(2).getCell(amountColumn).value;
      ok(
        'money is stored as a NUMBER, not as text',
        typeof firstAmount === 'number' || firstAmount === null,
        `${typeof firstAmount}: ${String(firstAmount)}`
      );
    }

    // ================================================================
    sect('5. Filters are applied on the server, over the whole dataset');
    // ================================================================
    actAs(opsAdmin.token, 'operations');
    const { count: completedInDb } = await admin
      .from('requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'completed');
    const filtered = await runExport({
      dataset: 'requests',
      format: 'csv',
      filters: { status: 'completed' },
    });
    ok(
      'a status filter matches the database exactly',
      filtered.rowCount === (completedInDb ?? 0),
      `export ${filtered.rowCount} vs database ${completedInDb}`
    );

    const future = await runExport({
      dataset: 'requests',
      format: 'csv',
      filters: { from: new Date(Date.now() + 86_400_000).toISOString() },
    });
    const futureParsed = decodeCsv(future.content);
    ok('a period with nothing in it exports zero rows', future.rowCount === 0);
    ok('and still produces a usable header', futureParsed.header.length === 12);

    // ================================================================
    sect('6. Nothing sensitive is in the columns at all');
    // ================================================================
    actAs(superAdmin.token, 'super admin');
    const forbidden = ['token', 'secret', 'stripe_', 'sk_', 'whsec', 'iban', 'storage_path', 'password'];
    const leaks: string[] = [];
    for (const key of ['requests', 'payments', 'refunds', 'ledger', 'payouts', 'driver_documents', 'supplements']) {
      const file = await runExport({ dataset: key, format: 'csv' });
      const text = Buffer.from(file.content, 'base64').toString('utf8').toLowerCase();
      for (const needle of forbidden) {
        if (text.includes(needle)) leaks.push(`${key}: ${needle}`);
      }
    }
    ok(
      'no export contains a token, a key, a bank detail or a document path',
      leaks.length === 0,
      leaks.join('; ')
    );

    // ================================================================
    sect('7. Every export is audited');
    // ================================================================
    const { data: auditRows } = await admin
      .from('export_audit')
      .select('actor_id, capability, dataset, format, row_count')
      .in('actor_id', createdUserIds);
    ok('exports were written to the audit trail', (auditRows ?? []).length > 0, `${(auditRows ?? []).length} rows`);
    ok(
      'the audit records the capability that authorized each one, not the strongest one held',
      (auditRows ?? []).some((r) => r.capability === 'operations') &&
        (auditRows ?? []).some((r) => r.capability === 'finance'),
      (auditRows ?? []).map((r) => r.capability).join(', ')
    );
    ok(
      'refused exports left no audit row',
      !(auditRows ?? []).some((r) => r.dataset === 'ledger' && r.capability === 'operations'),
      'a refused export was logged as if it had happened'
    );

    // The file is deliberately not stored: a log of exports would be a second
    // unguarded copy of the data.
    const { data: auditColumns } = await admin.from('export_audit').select('*').limit(1);
    const columnNames = Object.keys((auditColumns ?? [{}])[0] ?? {});
    ok(
      'the audit trail stores no file content',
      !columnNames.some((c) => /content|file|payload|body/.test(c)),
      columnNames.join(', ')
    );
  } finally {
    section = 'Cleanup';
    for (const id of createdUserIds) {
      await admin.from('export_audit').delete().eq('actor_id', id);
      await admin.from('admin_grants').delete().eq('profile_id', id);
      await admin.auth.admin.deleteUser(id);
    }
    const { data: leftover } = await admin.auth.admin.listUsers({ perPage: 200 });
    ok(
      'no fixture admin is left behind',
      leftover.users.filter((u) => (u.email ?? '').startsWith('p9-')).length === 0
    );
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length} passed, ${failed.length} failed.`);
    if (failed.length) {
      console.log('\nFailures:');
      for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error('\nExport tests crashed:', err);
    process.exit(1);
  });
