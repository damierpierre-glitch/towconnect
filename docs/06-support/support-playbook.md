# Support Playbook

- **Owner:** Founder / Product (future: Support)
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Monthly
- **Related systems:** `/dashboard/admin/operations/support`

## Finding the job

`/dashboard/admin/operations/support` takes whatever the caller has: a request
id, the email they signed up with, their phone number, or a payment reference
from their bank statement. **Each result says which identifier matched** — so
you know what you have actually confirmed about the person on the phone.

## What support may and may not do

| May | May not |
| --- | --- |
| Look up a job by any identifier | Issue a refund |
| Read the timeline | Prepare a payout |
| Read incidents | Resolve or dismiss an incident |
| See the attention queue and the live map | Read risk flags |
| Export its own narrow dataset | Export incidents, the ledger, or payments |

Every "may not" is refused **by the database**, not by hiding a button.

## Common questions

**"Where is my tow truck?"** — Open the job, read the operational state. If the
driver's position is stale, say so; do not read out a position as if it were
current.

**"Why has nobody come?"** — Job → Dispatch tab. It shows every driver the
engine evaluated and the first rule each one failed. If the answer is
`regulated_zone_not_authorized`, the honest answer is that the law restricts
who may tow there.

**"I was charged extra."** — Job → Money tab. Approved supplements are listed
with their payment state. A supplement showing `uncollected` was **not
charged** — the receipt says so too.

**"I want a refund."** — Support cannot issue one. Escalate to finance with the
request id, the amount and the reason.

## The phone is a fallback

It remains available for a real emergency and for regulated-zone procedures. It
is not the normal path, and nothing in the product should make it one.

---

## During the pilot

`06-support/pilot-support-runbook.md` covers the eight situations a Montréal &
Rive-Sud pilot will actually produce, with an escalation table saying for each
one: who looks, what they may read, what they may do, and when it stops being
theirs.

Two additions to everything above:

**Every intervention gets an incident.** Not for process theatre —
`requests_needing_human` in `ops_kpis()` is built from incidents, and an
unrecorded intervention makes the platform look more autonomous than it is.
During a pilot that number matters more than the job count.

**"We are not accepting requests right now."** If the pilot is paused, a
customer sees the reason an operator wrote. Repeat it as written; do not
improvise a restart time. If they are in danger, 911 comes first and TowConnect
second.


---

## "I never got the email"

The two cases arrive with the same sentence and need different answers.

**Creating an account.** Ask whether they saw a confirmation screen. Then
check `confirmation_sent_at` on their user row: null means Supabase never
handed the message to the mailer, which today almost always means the hourly
quota is spent (two per hour, whole project). Say so plainly — *"our mail is
rate-limited while we set up a provider, try again shortly"* — rather than
sending them round the loop again.

**Resetting a password.** The screen says the same thing whether or not the
address has an account, on purpose. **Do not tell them whether it does.** If
they insist, the honest line is that we cannot confirm whether an address has
an account, for their protection as much as anybody's.

Then: check spam, check the address for typos, and check the provider's own
dashboard for a bounce. `03-operations/account-lifecycle.md` has the order.

## "I have forgotten my password"

Point them at **Mot de passe oublié ?** under the sign-in form. Support cannot
reset a password, cannot send the link on their behalf, and cannot read the
link — the flow is deliberately end-to-end between the customer and their
mailbox.

Two things worth telling them up front: the link works **once**, and changing
the password **signs them out everywhere else**. Both are measured behaviours,
not guesses.
