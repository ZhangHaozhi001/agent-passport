# M3 Report — Demo UI live (completed 2026-11-18, ahead of the Dec 13 node)

**Live demo: https://zhanghaozhi001.github.io/agent-passport/**

## Scope vs PLAN.md M3

| PLAN M3 item | Status |
|---|---|
| Wire `web/` to the service | ✅ Static route chosen over a Node server (GitHub Pages is static-only): `web/index.html` embeds a line-by-line browser port of `PassportService` + `InMemoryBackend`, so the page runs the service logic itself, in the visitor's browser |
| Deploy to GitHub Pages | ✅ Pages enabled (source `main` `/docs`); `docs/index.html` is a byte-identical copy of `web/index.html`; build verified `built`, live page byte-identical to the repo file |
| Polish the revocation moment | ✅ Verdict banner flips green/red with the exact reason code (`delegation_revoked` / `attestation_revoked`), a pulse animation on every fresh verdict, and a guided checklist that ticks off each beat of the story |

## What the page does

- The full `src/demo.ts` story, interactively and via a one-click
  "Play the full story" button: register → attest → delegate → verify
  **ALLOWED** → revoke delegation → verify **DENIED `delegation_revoked`** →
  grant again → revoke attestation → verify **DENIED
  `attestation_revoked`**.
- Every button performs exactly one `PassportService` call with the
  demo's arguments (owner `did:t3n:org-acme`, auditor
  `did:t3n:auditor-trustco`, agent `did:t3n:agent-research-01`,
  `records.read` on `vault:customer-records`, capability `data.read`).
  Nothing is faked at the UI layer — verify can be pressed at any time,
  including before registration (`unknown_agent`).
- Live passport state (identity / attestation / all delegations with
  status), the gate verdict with reason code + `checkedAt`, and the full
  audit trail (seq, time, kind, actor → subject, detail) rendered from
  the service's own log.
- Semantics section: check order identity → attestation → delegation,
  revoked-before-expired, `expiresAt` == now counts as expired, and the
  first-matching-record rule (the M1-flagged observation, stated openly).
  Full 7-row reason-code table, wording identical to `README.md`.
- M2 section: states precisely what the testnet wiring replaces — only
  the backend behind `PassportBackend` (`InMemoryBackend` →
  `T3nBackend` in `src/t3n/adapter.ts`), with the per-operation SDK call
  table from the adapter header. Gate logic and this page do not change.
- Bilingual: English primary, Chinese glosses on the key explanations,
  section titles and primary buttons.

## Fidelity verification (the port vs the real service)

- Extracted the page's DOM-free core and replayed in Node: demo story
  yields the exact 9-event kind sequence, seq 1..9, denial details
  prefixed `delegation_revoked:` / `attestation_revoked:`, and every
  detail string byte-identical to `src/passport.ts` — all assertions pass.
- Cross-checked against the real TypeScript service (same scenarios):
  fresh → `unknown_agent`; registered-only → `missing_attestation`;
  attested-only → `missing_delegation`; and the first-match quirk
  (grant #1 revoked, grant #2 live → still denied `delegation_revoked`
  citing grant #1) — the port reproduces all four outcomes exactly.
- `npm run demo` output (9-event trail) matches the page's strings;
  `npm test` still 27/27; `npm run typecheck` clean.

## Recheck pass

- Full inline script: `node --check` clean; every `$("…")` reference is
  bound to an element id present in the page.
- Served locally from both `web/` and `docs/` (HTTP 200, correct title);
  `diff` confirms the two copies identical.
- GitHub Pages build polled to `built`; the live URL fetched and diffed
  byte-identical against the repo file.
- README reconciled: architecture block now lists `docs/` and describes
  `web/` accurately; "Run it" leads with the live demo link; Status
  updated (M3 done, M2 still waiting on the API-key step). No code or
  behaviour changes anywhere in `src/` or `test/`.
- Pre-push secret scan of the changed files: clean.

## Not done (by design / hard limits)

No testnet API key claimed, nothing registered or submitted, no payment.
M2 (live T3N wiring) still waits on the user's claim-page step, due
Dec 7 — when it lands, this page's M2 section describes exactly which
part gets replaced.
