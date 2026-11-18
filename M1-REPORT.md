# M1 Report — Core hardening (completed 2026-11-18, ahead of the Nov 30 node)

## Scope vs PLAN.md M1

| PLAN M1 item | Status |
|---|---|
| Unit tests for every VerifyFailure branch | ✅ 27 tests, all 7 branches covered (see below) |
| Expiry edge cases | ✅ past / exactly-now / future / unset, for both attestations and delegations |
| README architecture diagram | ✅ ASCII diagram added (layers, gate flow, backend split) |
| Pin SDK 5.31.0, delegation vocabulary only | ✅ `package.json` pins exact `5.31.0`; installed version verified = 5.31.0 after clean `npm ci`; no legacy agent-auth references in code |

## Test suite — `npm test` (tsx + node:test, `test/passport.test.ts`)

27 tests / 7 suites, **27 pass, 0 fail**:

- **Happy path (2)** — full allow with detail naming the attestation +
  delegation used; no-`expiresAt` records stay valid until revoked.
- **Identity (2)** — `unknown_agent`; unknown agent trumps all other failures.
- **Attestation (9)** — `missing_attestation` ×3 (none / untrusted issuer /
  wrong capability), `attestation_revoked`, `attestation_expired` (past and
  exactly-now boundary), future expiry passes, revoked-reported-before-expired,
  attestation checked before delegation.
- **Delegation (8)** — `missing_delegation` ×3 (none / wrong action / wrong
  resource), `delegation_revoked`, `delegation_expired` (past and exactly-now
  boundary), future expiry allows, revoked-before-expired order.
- **Revocation guards (2)** — revoking an unknown attestation/delegation id throws.
- **Audit integrity (2)** — the demo story yields the exact 9-event kind
  sequence with seq strictly 1..9, every event carrying actor + ISO
  timestamp, denial details prefixed with the reason code; each
  `verifyAccess` appends exactly one gate event.
- **T3N adapter config (2)** — `loadT3nConfig` throws `T3nNotConfiguredError`
  without a key (incl. whitespace-only), defaults to testnet, honours
  sandbox/production.

## README ↔ code reconciliation

Checked line by line against `src/passport.ts`, `src/types.ts`,
`src/demo.ts`, `.env.example`. Fixes made (docs only — no behaviour change
was needed anywhere):

1. **Run-it demo comment understated the story** — it showed a single
   revoke; the demo actually revokes the delegation *and* the attestation.
   Comment corrected.
2. **Failure reason codes were undocumented** — added a "Verify failure
   reasons" table with all 7 codes, the fail-closed check order
   (identity → attestation → delegation; revoked before expired) and the
   expiry boundary semantics (`expiresAt` == now counts as expired),
   verified against the implementation.
3. **Architecture section was a file list only** — added the diagram
   (PLAN M1 deliverable) and the `test/` entry.
4. **Status section** — now records the M1 test suite.
5. Verified accurate as-is: `.env.example`/`T3N_API_KEY` instructions,
   the T3N mapping table (maps / member delegation / audit), the
   "revoking either layer closes the gate" claim (now test-locked).

## Flagged for M2 (observed, deliberately not changed in M1)

`verifyAccess` evaluates the **first** matching attestation/delegation
only: if the earliest match is revoked or expired, the gate denies even
when a later valid record exists. The tests intentionally do not pin this
either way. Recommend deciding in M2 whether to select the first *valid*
record instead — it affects reason-code semantics, so it should be a
conscious product decision, not a drive-by fix.

## Recheck pass (clean-room)

`rm -rf node_modules dist && npm ci` → `npm run typecheck` clean →
`npm test` 27/27 → `npm run demo` runs, 9 audit events, verdicts
allow / `delegation_revoked` / `attestation_revoked` as documented.
Pre-push secret scan of the working tree: clean (no keys/seeds; the only
credential-shaped string is the `<redacted>` placeholder in
`.env.example`).

## Not done (by design / hard limits)

No testnet API key claimed, nothing registered or submitted, no payment.
M2 (live T3N wiring) still waits on the user's claim-page step, due Dec 7.
