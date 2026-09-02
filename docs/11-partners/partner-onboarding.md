# Partner onboarding — from first call to ready

- **Owner:** Founder / Commercial
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** After the first three partners
- **Related systems:** `companies`, `company_members`, `fleet_vehicles`, `company_service_areas`, `driver_documents`, `companies.pilot_status`

Nine steps. None of them is optional, and none of them is longer than it needs
to be — an onboarding that takes a week is an onboarding a small operator never
finishes.

## Three words that all sound like "ready"

Getting these confused is the single most likely cause of somebody being sent
work they should not have received, or being counted as capacity while asleep.

| Field | Question it answers | Who sets it |
| --- | --- | --- |
| `companies.status` | Is this company approved to operate at all? | TowConnect (compliance) |
| `companies.pilot_status` | Where are they in **our** rollout? | TowConnect operations (commercial) |
| `driver_profiles.is_online` | Is a truck available *right now*? | The driver |

Dispatch reads the first and the third. It never reads `pilot_status`.

---

## The nine steps

### 1. Invitation — `pilot_status = 'invited'`

Contact made, nothing signed. Recorded so we know who has been spoken to and
who has not.

### 2. The company account

The owner creates a TowConnect account and the company record: legal name,
trading name customers will see, phone, email, province, address.

### 3. Owner and managers — `pilot_status = 'onboarding'`

The owner is the account that created the company. Additional managers are
added as `admin` or `dispatcher` members. A `dispatcher` can see and coordinate
work without being able to change the company itself.

### 4. Drivers

Each driver signs up for their own account and is added to the roster. **A
driver account is personal**: it carries their documents and their history, and
it follows them if they change employer. Nobody shares a login.

### 5. Vehicles

Fleet vehicles with their type — `standard`, `flatbed`, `heavy_duty`. Type is
not decoration: dispatch will not offer a job that needs a flatbed to a company
whose only active vehicle is standard.

### 6. Service areas

Where the company wants work. A radius around the yard is usually enough to
start with.

**Declaring nothing means "no restriction stated", not "serves nowhere".** A
company with no declared area is offered work anywhere the rest of the rules
allow. Say so out loud during onboarding — several operators assume the
opposite.

### 7. Documents

Licence, insurance, registration, and anything the province requires. Uploaded
by each driver, reviewed by TowConnect.

**This is the step that blocks going online.** A driver with a missing or
expired mandatory document cannot go online and cannot be dispatched — enforced
by the database, not by a policy anybody can bend. Expect this to be where
onboarding stalls, and chase it early rather than on launch morning.

### 8. Stripe Connect

The company completes Stripe's own hosted onboarding. **TowConnect never sees
and never stores a bank number, an identity document or any KYC field** — that
data goes to Stripe directly.

Two flags come back and they mean different things:

- `charges_enabled` — customers can be charged for their jobs.
- `payouts_enabled` — **the company can actually be paid.**

Until `payouts_enabled` is true, work can be credited in the ledger and cannot
be transferred. Finishing this before the first job is far easier than
explaining it afterwards.

### 9. Ready → active

`pilot_status = 'ready'` when `pilot_partner_readiness()` returns an empty
`blocking_reasons` — not when it feels ready. The blocking reasons are read out
of the same functions dispatch uses, so a company that is "ready" here and
refused by dispatch would be one bug in one place rather than two opinions.

`pilot_status = 'active'` when they are switched on for the pilot.

---

## What blocks a company, in the system's own words

`pilot_partner_readiness()` returns these, and only these:

- `company not active`
- `no driver on the roster`
- `no driver passes compliance`
- `no active fleet vehicle`
- `Stripe Connect cannot accept charges`
- `Stripe Connect cannot pay out`

Every one is a fact read from the system. None is a judgement.

## Pausing a partner

`pilot_status = 'paused'` — their choice or ours, holidays or a problem. It is
a commercial state and it removes them from the pilot conversation. It does
**not** take their drivers offline: a driver's availability is theirs.
