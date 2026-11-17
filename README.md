# Agent Trust Passport — on Terminal 3 Network (T3N)

**Built for the Terminal 3 Build+Scale Agent Micro Grant (DoraHacks).**
Theme: agent governance · trust · security · privacy.

## The problem

AI agents are starting to act on our behalf — reading data, calling tools,
spending money — but a resource owner has no standard way to ask, *before*
granting access:

> Who is this agent? Who vouches for what it can do? Did I actually
> delegate this to it — and can I take that back?

## The passport

An **Agent Trust Passport** bundles the three facts a gate needs, and
checks them together, fail-closed, at access time:

| Layer | What it is | On T3N |
|---|---|---|
| **Identity** | A DID the agent authenticated with | `did:t3n:…` from `T3nClient.authenticate()`; org agents via `createAgent` |
| **Attestations** | Capability claims ("can read data", "can initiate payments ≤ $X") issued by trusted third parties, revocable and expirable | Tenant KV maps (`tenant.maps`) with issuer-only writer ACLs |
| **Delegation** | A scoped grant from the resource owner to the agent: one resource, named functions only, revocable at any time | Member delegation — `updateMemberDelegation` / `getMemberDelegation` / `revokeMemberDelegationForOrg` |
| **Audit** | Every registration, grant, revocation and gate decision, in order | `client.getAuditEvents()` / org activity log |

**Verify flow:** `register → attest → delegate → verify → (revoke → verify fails)`.
Revoking *either* the attestation *or* the delegation immediately closes
the gate — that revocation demo is the heart of the pitch video.

## Architecture

```
web/index.html          demo UI: passport card, revoke buttons, gate verdict, audit list
src/types.ts            identity / attestation / delegation / verify / audit types
src/passport.ts         PassportService — the core logic (framework-free)
src/backend.ts          PassportBackend interface + InMemoryBackend (demo/tests)
src/t3n/adapter.ts      live T3N mapping: the exact @terminal3/t3n-sdk call per operation
src/demo.ts             runnable end-to-end story (no network, no key needed)
```

The service talks only to the `PassportBackend` interface, so the identical
logic runs in-memory for the demo and on the T3N testnet (TEE nodes,
wallet-SIWE auth, encrypted sessions) for the real thing.

## Run it

```bash
npm install
npm run demo        # register → attest → delegate → verify ✓ → revoke → verify ✗
npm run typecheck
```

Live testnet mode (milestone M2): claim a free API key at
https://www.terminal3.io/claim-page, copy `.env.example` to `.env`, and set
`T3N_API_KEY`. Grant participants receive fully subsidised T3 credits.

## Why Terminal 3

T3N is built for exactly this: verifiable agent identity (Agent Auth),
scoped permissions, TEE-confidential execution, and a native audit layer.
The passport is a thin, legible governance product on top of those
primitives — the thing an enterprise admin actually wants to look at
before an agent touches customer data.

## Status

Phase 1 (this repo state): design + verified core module + runnable demo +
UI skeleton. Live testnet wiring, hosted demo and the pitch video follow
the milestones in `PLAN.md`. Submission deadline: **2026-12-24 23:59 CST**.

## License

MIT
