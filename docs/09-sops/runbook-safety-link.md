# Runbook — Safety Link questions

- **Owner:** Founder / Product (future: Support)
- **Status:** Active
- **Last reviewed:** 2026-09-02
- **Review cycle:** Quarterly
- **Related systems:** `safety_links`, `safety_link_view()`

## "My family says the link does not work"

A link stops working for three reasons, and the page deliberately does not say
which: it expired, it was revoked, or the token is wrong. That distinction is
only useful to somebody guessing.

**Answer:** ask the customer to generate a new link from their tracking screen.
The old one dies the moment a new one is created.

## "Can you send me the link?"

**No — and not as a policy choice.** Only the SHA-256 of a token is stored.
TowConnect genuinely cannot reproduce a link that was already issued.

## "What can they see?"

State, the vehicle's location, the driver's first name, company, truck type and
plate, the driver's position **with its age**, and an ETA only when a fresh
position exists.

Never: prices, phone numbers, saved addresses, other jobs, internal notes,
documents, incidents, risk flags.

## "Someone is watching who should not be"

Ask the customer to press **Turn off** on their tracking screen. Revocation is
immediate. Support can see that a link exists and how many times it was opened
(`view_count`), but cannot see the link itself.
