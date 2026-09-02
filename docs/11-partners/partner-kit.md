# Partner kit — TowConnect for towing companies

- **Owner:** Founder / Commercial
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Before it is handed to a partner who has not seen it
- **Related systems:** `11-partners/partner-onboarding.md`, `13-legal/partner-terms.md`

Written to be handed over — printed, emailed or read aloud at a counter.
Everything in it is true of the system as it exists today.

**Two things it deliberately does not contain:** a commission rate, because
none has been set; and a volume estimate, because we have none. Both are
easier to explain now than to walk back later.

---

## 1. TowConnect in one page

A person breaks down. Instead of phoning around, they open TowConnect, describe
the problem, see the price before confirming, and confirm. The job is offered
to one available operator at a time. Whoever accepts does the work. The
customer watches the truck arrive on a map.

**We own no trucks and employ no drivers.** The work is done by independent
towing companies — with their own vehicles, their own insurance and their own
permits. TowConnect handles the request, the price, the dispatch, the payment
and the tracking.

Currently a **pilot on Montréal and the South Shore**. Not a national network,
not 24/7, not a guaranteed volume of work.

---

## 2. How a job works

1. **The customer describes the situation** — type of breakdown, where they
   are, where the vehicle is going.
2. **The price is shown before they confirm**, computed on the server from the
   real distance and the type of service. Not negotiated at the roadside.
3. **Their card is authorized, not charged.** The money is held. If nobody
   accepts, nothing is taken.
4. **The job is offered to one driver at a time**, with a short response
   window. No answer moves it to the next candidate.
5. **The driver accepts** — the customer sees their first name, the company and
   the plate, and follows the truck on a map.
6. **The driver advances the status**: en route, arrived, in progress,
   completed.
7. **The payment is captured at completion**, not before.

## 3. What the driver sees

- **Offers**, one at a time, with the pickup, the type of job and the distance.
  **Declining is free.** No penalty, no score, no consequence — the offer
  simply moves on.
- **The job**: the customer's location, the destination, chat with the
  customer, and the status buttons.
- **A supplement button** for work the job turns out to need. The driver
  proposes, **the customer must accept**, and only then does it become money.
- **Their earnings**, per job and in total.

## 4. What the company sees

- The roster of drivers and their compliance state.
- Fleet vehicles and which driver has which.
- Service areas — where the company wants work.
- Every job the company's drivers have done.
- The ledger: what has been earned, what has been paid, what is outstanding.

## 5. Payment and compensation

- The customer is charged by TowConnect. The company does not handle the card.
- Compensation is **frozen when the job is accepted**. A later change to how
  TowConnect prices things cannot reprice work that was already accepted.
- Money reaches the company through **Stripe Connect**. Stripe collects the
  banking and identity details directly — TowConnect never sees or stores a
  bank number, and never asks for one.
- Two Stripe flags matter and they are different: charges enabled (customers
  can be charged) and payouts enabled (**you can be paid**). Both need to be
  true before the first job.

**The commission rate has not been set.** It is not in this document because it
does not exist yet, and a rate invented for a sales conversation is a rate that
gets disputed on the first invoice. It will be written into the partner terms
before anybody signs.

## 6. Compliance

- Every driver uploads their licence, insurance and registration.
- **A driver with a missing or expired mandatory document cannot go online and
  cannot receive work.** The system enforces this; nobody at TowConnect can
  wave it through for one shift.
- The company remains responsible for its own permits, vehicles and insurance.
- On some highways and bridges, towing is reserved for an operator mandated by
  a public authority. TowConnect does not dispatch into those zones — it shows
  the motorist the official instruction instead. This is not a commercial
  choice.

## 7. Support

During a job, the in-app chat is the fastest route: it is attached to the job,
so whoever answers can already see what it is about.

**A support telephone line does not exist yet.** We would rather say that than
print a number nobody is watching.

## 8. Responsibilities

| | |
| --- | --- |
| **TowConnect** | The request, the price, dispatch, payment, tracking, the customer relationship up to the match |
| **The company** | The tow itself, the vehicle, the driver, the insurance, the permits, the standard of the work |

## 9. Questions we are actually asked

**Do I have to accept every job?**
No. Declining costs nothing.

**How much work will I get?**
We do not know, and anybody who tells you a number at this stage is guessing.
It is a pilot: the honest answer is that we are trying to find out together.

**What does it cost me?**
Nothing to join. The commission rate is not set yet, and it will be in the
partner terms in writing before you sign anything.

**When do I get paid?**
Compensation is recorded in your ledger when the job completes and is paid out
through Stripe Connect. Until your Connect account is complete, money can be
credited to you but not transferred — which is why step 8 of onboarding matters
before the first job rather than after it.

**Who is liable if a vehicle is damaged?**
The towing company carries its own insurance for the work it performs. That is
the intended arrangement and it is written in the partner terms, which are
still marked *DRAFT — LEGAL REVIEW REQUIRED*: it has not yet been validated by
an insurer or a lawyer, and we would rather you knew that.

**Can I use it for my existing customers?**
Not yet. The pilot is about work TowConnect brings you.

**What happens to my data?**
Your company, your drivers, your vehicles and your jobs. A driver sees only
what their own assigned job requires. Another company sees nothing of yours.
Banking and identity details go to Stripe, not to us.
