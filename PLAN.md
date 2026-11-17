# PLAN — Agent Trust Passport (Terminal 3 Build+Scale Agent Micro Grant)

Deadline: **2026-12-24 23:59 CST** (15:59 UTC). Internal freeze: **Dec 20**
(submission + video done), Dec 21–24 buffer for the recheck pass and the
account holder's DoraHacks steps. Verification facts: see `../NOTES.md`.

## Concept (locked)
Agent Trust Passport — register an agent identity (did:t3n), collect
capability attestations from trusted issuers, hold scoped delegations from
resource owners, and verify all three fail-closed before access. Revoking
any layer closes the gate. Simple web UI: register → attest → verify/revoke,
with the audit trail visible throughout.

## Milestones
- **M0 — Verify + scaffold (2026-11-17, DONE)**: channel verified open;
  NOTES.md written; repo scaffolded; core `PassportService` implemented and
  demo runs end-to-end on the in-memory backend; UI skeleton in place.
- **M1 — Core hardening (by Nov 30)**: unit tests for every VerifyFailure
  branch; expiry edge cases; README architecture diagram; pin SDK 5.31.0
  (legacy agent-auth API was removed in 5.22 — delegation vocabulary only).
- **M2 — Live T3N testnet wiring (by Dec 7)**: claim testnet API key
  (user-account step, see below); implement `T3nBackend` in
  `src/t3n/adapter.ts` (authenticate → maps for attestations →
  updateMemberDelegation/getMemberDelegation for grants → audit reads);
  record a real testnet register→verify→revoke run.
- **M3 — Demo UI live (by Dec 13)**: wire `web/` to the service (small Node
  server or static + API), deploy to GitHub Pages/Vercel, polish the
  revocation moment (the money shot for judging).
- **M4 — Demo video + submission package (by Dec 20)**: ≤3-min video
  (problem → live testnet flow → revoke → gate closes → audit trail);
  DoraHacks BUIDL text drafted (problem, T3N primitives used, repo, video,
  what's next: quotas, spend caps, multi-issuer trust policies).
- **M5 — Recheck pass (Dec 21–22, house rule)**: fresh-eyes review of repo,
  demo link, video, and submission text; fix findings; only then submit.
- **Submit (by Dec 23, a day early)**: account holder registers + submits on
  DoraHacks (steps below). Dec 24 kept as pure buffer.

## Honest status at M0
Built: types, backend interface + in-memory backend, full PassportService
(register/attest/revoke/delegate/revoke/verify/audit), runnable demo,
T3N adapter with config loading + the exact SDK call mapped per operation,
UI skeleton, README, this plan.
Not yet built: live T3N backend implementation (needs API key — M2), unit
tests (M1), hosted UI (M3), video (M4). Nothing submitted anywhere.

## Remaining user-account steps (batched for the user, later)
1. **Claim a T3N testnet API key** at https://www.terminal3.io/claim-page
   (self-serve, free testnet credits; the key is shown once — hand it over
   via the Secure Vault, never in chat). Needed by **Dec 7** (M2).
2. **DoraHacks**: log in → join "Terminal 3 Build+Scale Agent Micro Grant"
   → at submission time, confirm on the detail page the two items that were
   unverifiable read-only: the exact $1,800 split between top 2 and the
   prize payment method → submit the BUIDL (repo link + demo video +
   prefilled text from M4). Needed by **Dec 23**.
3. If selected: respond to Terminal 3's winner/payout instructions and the
   Google Cloud credits introduction (>$100k credits for winners).
