# M2 Pre-build Report — T3nBackend adapter (2026-11-19)

Milestone M2 (PLAN.md, due Dec 7) is the live T3N testnet wiring. Its only
external dependency is a claimed testnet API key (a user-account step).
This pre-build lands everything that does NOT need the key, ahead of the
node, so the key's arrival leaves a 3-step hookup instead of a build.

## What was built

- **`src/t3n/adapter.ts`** (rewritten): `T3nBackend implements
  PassportBackend`, written against two narrow structural ports
  (`T3nClientPort`, `T3nMapsPort`) that mirror the installed
  @terminal3/t3n-sdk 5.31.0 type declarations method-for-method. Mapping:
  - identity → tenant KV map `passport-agents` (`entrySet`/`entryGet`,
    key = DID, value = JSON); minting a new DID is the session-level
    `mintAgentDid()` → `T3nClient.createAgent`
  - attestations → KV map `passport-attestations` (key = subject DID,
    value = JSON array, upsert by id; revocation = update with revokedAt)
  - delegation → `fanOutGrant` one `BoundGrant` row per function →
    `updateMemberDelegation`; reads via `getMemberDelegation` regrouped
    per (grantee, contract_id); validity window ⇄ ISO expiry round-trips
  - revocation → `removeMemberDelegationGrants([{grantee, contract_id}])`
    (authority gone immediately) + a tombstone in KV map
    `passport-delegation-tombstones`, so the gate still reports
    `delegation_revoked` rather than `missing_delegation` — backend
    behaviour identical to InMemoryBackend
  - audit → adapter-level `fetchNodeAuditEvents()` → `getAuditEvents()`,
    projected onto the passport AuditEvent shape (committed batches only;
    unknown contract actions bucket by outcome, original text preserved
    in `detail`); plus `checkNodeDelegation()` pass-through to the node's
    own `checkDelegation` verdict
  - `createT3nSession(config)` — the only network-touching code: builds
    `T3nClient` (WASM + `fetchTrustedManifest` anchor + ETH signing
    handler; the API key is the registered ETH wallet's private key per
    the SDK README), handshakes, authenticates, wires a `TenantClient`'s
    maps in. Refuses a keyless config before any I/O.
  - `T3nNotConfiguredError` now lists every missing item by name
    (constructor validates ports + sessionDid the same way).
- **`src/t3n/mock.ts`**: mock SDK stand-in implementing both ports with
  SDK-faithful semantics — the merge uses the SDK's own exported
  `mergeGrants`/`mergeDiscoverDids`; removal is subtractive per
  (grantee[, contract_id]); call recording + one-shot fault injection.
- **`test/t3n-adapter.test.ts`**: 19 new tests (config errors, identity
  and attestation map mapping, delegation fan-out/regroup, revocation
  immediacy + tombstone semantics, re-grant clearing, full service story
  on T3nBackend, expiry via window round-trip, error propagation with
  identity of the thrown error, audit projection).
- `package.json` test script runs both suites; `src/index.ts` exports
  the adapter surface. **`src/passport.ts`, `src/backend.ts`,
  `src/types.ts`, `src/demo.ts`, `web/`, `docs/` are untouched** — the
  M2 contract (swap only the backend implementation) holds.

## Recheck

- Clean typecheck (`tsc --noEmit`) — one real issue found and fixed
  during the build: the SDK's `Did` is an object (`{ value, toString }`),
  not a string; `createT3nSession` normalises it at the factory boundary.
- Full suite: **46/46 tests green** (27 M1 + 19 new), demo runs unchanged.
- Secret scan of `src/` + `test/`: clean (no keys, no key-shaped strings).

## Honest TODOs (isolated, marked `TODO(M2-live)` in the adapter)

1. Map `visibility` string (`"private"` assumed) and tightening the map
   writer/reader ACLs from `"all"` — the SDK's scoped form is
   `{ only: number[] }` (contract ids); its tenant-map semantics can only
   be confirmed against a live node on the first keyed run.
2. Nothing else is stubbed: every port method maps to a real SDK 5.31.0
   method verified in the installed `.d.ts`. Where the SDK has no
   counterpart (per-entry map delete), the adapter documents and works
   around it (tombstone clearing writes `""`).

## What remains once the key is claimed (≤3 steps)

1. Set `T3N_API_KEY` (Secure Vault hand-over; key shown once).
2. `createT3nSession(loadT3nConfig())` → pass `backend` to
   `PassportService`.
3. One live register→verify→revoke run on testnet + close the two
   TODO(M2-live) items above; then M2 closes and the run is recorded in
   PLAN.md as originally scheduled.
