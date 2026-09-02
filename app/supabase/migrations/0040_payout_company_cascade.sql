-- TowConnect — Phase 7.1: a company that has ever had a payout could never be
-- deleted. Additive, run after 0039.
--
-- THE DEADLOCK
-- Three foreign keys formed a cycle nothing could break:
--
--   provider_payouts.company_id      -> companies              ON DELETE RESTRICT
--   provider_ledger_entries.company_id -> companies            ON DELETE CASCADE
--   provider_ledger_entries.payout_id  -> provider_payouts     ON DELETE RESTRICT
--
-- and the ledger's append-only trigger refuses a direct DELETE outright. So:
-- the company could not be deleted (a payout referenced it), the payout could
-- not be deleted (a ledger entry referenced it), and the ledger entry could
-- not be deleted at all except by the company cascade that was blocked. A
-- company with one payout was permanent.
--
-- This is the same mistake as the first cut of 0035, one table over: an
-- immutability rule was written without asking how the row ever legitimately
-- leaves. Found by the Phase 7.1 end-to-end run, which could not clean up
-- after itself.
--
-- THE FIX
-- Deleting a company takes its whole financial history with it — the ledger
-- already decided that, and the payouts have no business outliving the
-- company they were owed to. A payout on its own is still protected: NO
-- ACTION refuses a standalone payout delete that would orphan a ledger entry,
-- but (unlike RESTRICT) allows the reference to disappear inside the same
-- statement, which is exactly what the company cascade does.

alter table provider_payouts
  drop constraint provider_payouts_company_id_fkey,
  add constraint provider_payouts_company_id_fkey
    foreign key (company_id) references companies(id) on delete cascade;

alter table provider_ledger_entries
  drop constraint provider_ledger_entries_payout_id_fkey,
  add constraint provider_ledger_entries_payout_id_fkey
    foreign key (payout_id) references provider_payouts(id) on delete no action;

comment on constraint provider_payouts_company_id_fkey on provider_payouts is
  'Cascade, not restrict: a payout must not outlive the company it was owed to, and restrict made '
  'such a company undeletable forever (0040).';
