/**
 * PassportService test suite (node:test, run via `npm test`).
 *
 * Covers every VerifyFailure branch of verifyAccess, the expiry edge
 * cases (past / exactly-now / future / unset), the fail-closed check
 * order (identity → attestation → delegation; revoked before expired),
 * and audit-trail integrity (monotonic seq, one event per state change
 * and per gate decision, denial events carry the reason code).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InMemoryBackend } from "../src/backend.js";
import { PassportService } from "../src/passport.js";
import { loadT3nConfig, T3nNotConfiguredError } from "../src/t3n/adapter.js";
import type { VerifyRequest } from "../src/types.js";

const OWNER = "did:t3n:org-acme";
const AUDITOR = "did:t3n:auditor-trustco";
const STRANGER = "did:t3n:issuer-untrusted";
const AGENT = "did:t3n:agent-research-01";
const RESOURCE = "vault:customer-records";
const CAPABILITY = "data.read";
const ACTION = "records.read";

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const HOUR = 3_600_000;

function makeService(): PassportService {
  return new PassportService(new InMemoryBackend());
}

function baseRequest(overrides: Partial<VerifyRequest> = {}): VerifyRequest {
  return {
    agentDid: AGENT,
    capability: CAPABILITY,
    resource: RESOURCE,
    action: ACTION,
    trustedIssuers: [AUDITOR],
    ...overrides,
  };
}

/** Register the agent and issue a valid attestation; returns both. */
async function registerAndAttest(
  svc: PassportService,
  attestation: { issuerDid?: string; capability?: string; expiresAt?: string } = {},
) {
  await svc.registerAgent({ did: AGENT, name: "Research Agent 01", ownerDid: OWNER });
  return svc.issueAttestation({
    capability: attestation.capability ?? CAPABILITY,
    issuerDid: attestation.issuerDid ?? AUDITOR,
    subjectDid: AGENT,
    expiresAt: attestation.expiresAt,
  });
}

/** Additionally grant a valid delegation; returns the grant. */
async function fullyProvision(
  svc: PassportService,
  grant: { resource?: string; functions?: string[]; expiresAt?: string } = {},
) {
  const attestation = await registerAndAttest(svc);
  const delegation = await svc.grantDelegation({
    grantorDid: OWNER,
    granteeDid: AGENT,
    resource: grant.resource ?? RESOURCE,
    functions: grant.functions ?? [ACTION],
    expiresAt: grant.expiresAt,
  });
  return { attestation, delegation };
}

describe("verifyAccess — happy path", () => {
  test("allows when identity, attestation and delegation are all valid", async () => {
    const svc = makeService();
    const { attestation, delegation } = await fullyProvision(svc);
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.allowed, true);
    assert.equal(res.reason, undefined);
    assert.ok(res.detail.includes(attestation.id), "detail names the attestation used");
    assert.ok(res.detail.includes(delegation.id), "detail names the delegation used");
    assert.ok(!Number.isNaN(Date.parse(res.checkedAt)), "checkedAt is ISO 8601");
  });

  test("attestation and delegation without expiresAt stay valid (valid until revoked)", async () => {
    const svc = makeService();
    await fullyProvision(svc);
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.allowed, true);
  });
});

describe("verifyAccess — identity branch", () => {
  test("unknown_agent for an unregistered DID", async () => {
    const svc = makeService();
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "unknown_agent");
  });

  test("unknown_agent trumps every other failure", async () => {
    const svc = makeService();
    await fullyProvision(svc); // everything valid — but for AGENT, not the requester
    const res = await svc.verifyAccess(baseRequest({ agentDid: "did:t3n:ghost" }));
    assert.equal(res.reason, "unknown_agent");
  });
});

describe("verifyAccess — attestation branches", () => {
  test("missing_attestation when the agent has none", async () => {
    const svc = makeService();
    await svc.registerAgent({ did: AGENT, name: "Research Agent 01", ownerDid: OWNER });
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.reason, "missing_attestation");
  });

  test("missing_attestation when the only issuer is not trusted", async () => {
    const svc = makeService();
    await registerAndAttest(svc, { issuerDid: STRANGER });
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.reason, "missing_attestation");
  });

  test("missing_attestation for a different capability than requested", async () => {
    const svc = makeService();
    await registerAndAttest(svc, { capability: "data.write" });
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.reason, "missing_attestation");
  });

  test("attestation_revoked after the issuer revokes", async () => {
    const svc = makeService();
    const attestation = await registerAndAttest(svc);
    await svc.grantDelegation({
      grantorDid: OWNER,
      granteeDid: AGENT,
      resource: RESOURCE,
      functions: [ACTION],
    });
    await svc.revokeAttestation(attestation.id, AUDITOR);
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "attestation_revoked");
  });

  test("attestation_expired when expiresAt is in the past", async () => {
    const svc = makeService();
    await registerAndAttest(svc, { expiresAt: iso(-HOUR) });
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.reason, "attestation_expired");
  });

  test("attestation_expired at the boundary: expiresAt == now counts as expired", async () => {
    const svc = makeService();
    await registerAndAttest(svc, { expiresAt: iso(0) });
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.reason, "attestation_expired");
  });

  test("attestation with a future expiresAt passes the attestation stage", async () => {
    const svc = makeService();
    await registerAndAttest(svc, { expiresAt: iso(HOUR) });
    await svc.grantDelegation({
      grantorDid: OWNER,
      granteeDid: AGENT,
      resource: RESOURCE,
      functions: [ACTION],
    });
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.allowed, true);
  });

  test("revoked is reported before expired when both apply (check order)", async () => {
    const svc = makeService();
    const attestation = await registerAndAttest(svc, { expiresAt: iso(-HOUR) });
    await svc.revokeAttestation(attestation.id, AUDITOR);
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.reason, "attestation_revoked");
  });

  test("attestation failures are reported before delegation is consulted", async () => {
    const svc = makeService();
    const attestation = await registerAndAttest(svc); // no delegation granted at all
    await svc.revokeAttestation(attestation.id, AUDITOR);
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.reason, "attestation_revoked"); // not missing_delegation
  });
});

describe("verifyAccess — delegation branches", () => {
  test("missing_delegation when no grant exists", async () => {
    const svc = makeService();
    await registerAndAttest(svc);
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.reason, "missing_delegation");
  });

  test("missing_delegation when the grant covers a different action", async () => {
    const svc = makeService();
    await fullyProvision(svc, { functions: ["records.write"] });
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.reason, "missing_delegation");
  });

  test("missing_delegation when the grant is for a different resource", async () => {
    const svc = makeService();
    await fullyProvision(svc, { resource: "vault:other-records" });
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.reason, "missing_delegation");
  });

  test("delegation_revoked after the owner revokes the grant", async () => {
    const svc = makeService();
    const { delegation } = await fullyProvision(svc);
    await svc.revokeDelegation(delegation.id, OWNER);
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "delegation_revoked");
  });

  test("delegation_expired when expiresAt is in the past", async () => {
    const svc = makeService();
    await fullyProvision(svc, { expiresAt: iso(-HOUR) });
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.reason, "delegation_expired");
  });

  test("delegation_expired at the boundary: expiresAt == now counts as expired", async () => {
    const svc = makeService();
    await fullyProvision(svc, { expiresAt: iso(0) });
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.reason, "delegation_expired");
  });

  test("delegation with a future expiresAt allows access", async () => {
    const svc = makeService();
    await fullyProvision(svc, { expiresAt: iso(HOUR) });
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.allowed, true);
  });

  test("revoked is reported before expired when both apply (check order)", async () => {
    const svc = makeService();
    const { delegation } = await fullyProvision(svc, { expiresAt: iso(-HOUR) });
    await svc.revokeDelegation(delegation.id, OWNER);
    const res = await svc.verifyAccess(baseRequest());
    assert.equal(res.reason, "delegation_revoked");
  });
});

describe("revocation guards", () => {
  test("revoking an unknown attestation throws", async () => {
    const svc = makeService();
    await assert.rejects(svc.revokeAttestation("no-such-id", AUDITOR), /unknown attestation/);
  });

  test("revoking an unknown delegation throws", async () => {
    const svc = makeService();
    await assert.rejects(svc.revokeDelegation("no-such-id", OWNER), /unknown delegation/);
  });
});

describe("audit trail integrity", () => {
  test("demo story produces the full ordered trail with monotonic seq", async () => {
    const svc = makeService();
    const attestation = await registerAndAttest(svc);
    const grant = await svc.grantDelegation({
      grantorDid: OWNER,
      granteeDid: AGENT,
      resource: RESOURCE,
      functions: [ACTION],
    });
    await svc.verifyAccess(baseRequest()); // allowed
    await svc.revokeDelegation(grant.id, OWNER);
    await svc.verifyAccess(baseRequest()); // denied: delegation_revoked
    await svc.grantDelegation({
      grantorDid: OWNER,
      granteeDid: AGENT,
      resource: RESOURCE,
      functions: [ACTION],
    });
    await svc.revokeAttestation(attestation.id, AUDITOR);
    await svc.verifyAccess(baseRequest()); // denied: attestation_revoked

    const trail = svc.getAuditTrail();
    assert.deepEqual(
      trail.map((e) => e.kind),
      [
        "agent.registered",
        "attestation.issued",
        "delegation.granted",
        "access.verified",
        "delegation.revoked",
        "access.denied",
        "delegation.granted",
        "attestation.revoked",
        "access.denied",
      ],
    );
    // seq is 1-based and strictly increases by 1 — no gaps, no duplicates.
    assert.deepEqual(
      trail.map((e) => e.seq),
      trail.map((_, i) => i + 1),
    );
    for (const e of trail) {
      assert.ok(e.actorDid.length > 0, `event #${e.seq} has an actor`);
      assert.ok(!Number.isNaN(Date.parse(e.at)), `event #${e.seq} has an ISO timestamp`);
    }
    // Every denial event records the reason code at the head of its detail.
    const denials = trail.filter((e) => e.kind === "access.denied");
    assert.equal(denials.length, 2);
    assert.ok(denials[0].detail.startsWith("delegation_revoked:"));
    assert.ok(denials[1].detail.startsWith("attestation_revoked:"));
  });

  test("every verifyAccess call appends exactly one gate event", async () => {
    const svc = makeService();
    await fullyProvision(svc);
    const before = svc.getAuditTrail().length;
    await svc.verifyAccess(baseRequest());
    await svc.verifyAccess(baseRequest({ agentDid: "did:t3n:ghost" }));
    const gateEvents = svc
      .getAuditTrail()
      .slice(before)
      .filter((e) => e.kind === "access.verified" || e.kind === "access.denied");
    assert.equal(gateEvents.length, 2);
  });
});

describe("T3N adapter config (no network)", () => {
  test("loadT3nConfig throws T3nNotConfiguredError without an API key", () => {
    assert.throws(() => loadT3nConfig({}), T3nNotConfiguredError);
    assert.throws(() => loadT3nConfig({ T3N_API_KEY: "  " }), T3nNotConfiguredError);
  });

  test("loadT3nConfig defaults to testnet and honours explicit environments", () => {
    assert.deepEqual(loadT3nConfig({ T3N_API_KEY: "k" }), {
      apiKey: "k",
      environment: "testnet",
    });
    assert.equal(
      loadT3nConfig({ T3N_API_KEY: "k", T3N_ENVIRONMENT: "sandbox" }).environment,
      "sandbox",
    );
    assert.equal(
      loadT3nConfig({ T3N_API_KEY: "k", T3N_ENVIRONMENT: "production" }).environment,
      "production",
    );
  });
});
