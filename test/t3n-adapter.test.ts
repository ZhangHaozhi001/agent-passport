/**
 * T3nBackend adapter test suite (node:test, run via `npm test`).
 *
 * Runs the real adapter against the mock SDK ports (src/t3n/mock.ts) —
 * no network, no API key. Covers: config-error completeness, the
 * identity/attestation KV-map mapping, the delegation fan-out and
 * regrouping, revocation taking effect on the (mock) node immediately
 * while the gate still reports `delegation_revoked`, the full
 * PassportService story end-to-end on T3nBackend, SDK error propagation,
 * and the node-audit projection.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PassportService } from "../src/passport.js";
import {
  AGENTS_MAP,
  ATTESTATIONS_MAP,
  TOMBSTONES_MAP,
  T3nBackend,
  createT3nSession,
  grantToBoundRows,
  loadT3nConfig,
  rowsToGrant,
  T3nNotConfiguredError,
  type T3nPorts,
} from "../src/t3n/adapter.js";
import { MockT3nClient, MockT3nMaps } from "../src/t3n/mock.js";
import type { DelegationGrant } from "../src/types.js";

const OWNER = "did:t3n:1111111111111111111111111111111111111111"; // session DID (grantor)
const ORG = "did:t3n:2222222222222222222222222222222222222222";
const AUDITOR = "did:t3n:3333333333333333333333333333333333333333";
const AGENT = "did:t3n:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RESOURCE = "tee:vault/contracts";
const CAPABILITY = "data.read";
const ACTION = "records.read";

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const HOUR = 3_600_000;

function makeBackend(actingAgentDid: string = AGENT) {
  const client = new MockT3nClient(actingAgentDid);
  const maps = new MockT3nMaps();
  const backend = new T3nBackend({ client, maps }, OWNER);
  return { client, maps, backend };
}

function makeService() {
  const parts = makeBackend();
  return { ...parts, svc: new PassportService(parts.backend) };
}

async function fullyProvision(svc: PassportService) {
  await svc.registerAgent({ did: AGENT, name: "Research Agent 01", ownerDid: ORG });
  const attestation = await svc.issueAttestation({
    capability: CAPABILITY,
    issuerDid: AUDITOR,
    subjectDid: AGENT,
  });
  const delegation = await svc.grantDelegation({
    grantorDid: OWNER,
    granteeDid: AGENT,
    resource: RESOURCE,
    functions: [ACTION],
  });
  return { attestation, delegation };
}

const request = {
  agentDid: AGENT,
  capability: CAPABILITY,
  resource: RESOURCE,
  action: ACTION,
  trustedIssuers: [AUDITOR],
};

describe("T3N adapter — configuration errors", () => {
  test("constructor lists every missing piece by name", () => {
    assert.throws(
      () => new T3nBackend({} as T3nPorts, ""),
      (err: unknown) => {
        assert.ok(err instanceof T3nNotConfiguredError);
        assert.equal(err.missing.length, 3);
        assert.match(err.message, /ports\.client/);
        assert.match(err.message, /ports\.maps/);
        assert.match(err.message, /sessionDid/);
        return true;
      },
    );
  });

  test("createT3nSession refuses a keyless config before any network I/O", async () => {
    await assert.rejects(
      createT3nSession({ apiKey: "  ", environment: "testnet" }),
      T3nNotConfiguredError,
    );
  });

  test("loadT3nConfig picks up T3N_NODE_URL only when set", () => {
    assert.equal(
      loadT3nConfig({ T3N_API_KEY: "k", T3N_NODE_URL: "https://node.example" })
        .nodeUrl,
      "https://node.example",
    );
    assert.equal(loadT3nConfig({ T3N_API_KEY: "k" }).nodeUrl, undefined);
  });
});

describe("T3N adapter — identity mapping (KV map)", () => {
  test("putAgent/getAgent round-trips through the agents map as JSON", async () => {
    const { backend, maps } = makeBackend();
    const agent = {
      did: AGENT,
      name: "Research Agent 01",
      ownerDid: ORG,
      createdAt: iso(0),
    };
    await backend.putAgent(agent);
    assert.deepEqual(await backend.getAgent(AGENT), agent);
    const write = maps.callsTo("entrySet").find((c) => c.args[0] === AGENTS_MAP);
    assert.ok(write, "agent written to the agents map");
    assert.equal(write.args[1], AGENT);
    assert.deepEqual(JSON.parse(write.args[2] as string), agent);
  });

  test("getAgent of an unknown DID returns undefined", async () => {
    const { backend } = makeBackend();
    assert.equal(await backend.getAgent("did:t3n:ghost"), undefined);
  });

  test("maps are created once, with readers explicitly set", async () => {
    const { backend, maps } = makeBackend();
    await backend.putAgent({
      did: AGENT,
      name: "A",
      ownerDid: ORG,
      createdAt: iso(0),
    });
    await backend.listAttestations(AGENT);
    assert.deepEqual(
      maps.createdMaps.map((m) => m.tail),
      [AGENTS_MAP, ATTESTATIONS_MAP, TOMBSTONES_MAP],
    );
    for (const created of maps.createdMaps) {
      assert.equal(created.readers, "all", "readers set explicitly (deny-all footgun)");
    }
  });

  test("mintAgentDid maps to client.createAgent and returns the new DID", async () => {
    const { backend, client } = makeBackend();
    const did = await backend.mintAgentDid(ORG, "Research Agent 01");
    assert.match(did, /^did:t3n:[0-9a-f]{40}$/);
    assert.deepEqual(client.callsTo("createAgent")[0].args, [ORG, "Research Agent 01"]);
  });
});

describe("T3N adapter — attestation mapping (KV map)", () => {
  test("attestations are stored per subject and upserted by id", async () => {
    const { backend } = makeBackend();
    const a1 = await new PassportService(backend).issueAttestation({
      capability: CAPABILITY,
      issuerDid: AUDITOR,
      subjectDid: AGENT,
    });
    const a2 = await new PassportService(backend).issueAttestation({
      capability: "data.write",
      issuerDid: AUDITOR,
      subjectDid: AGENT,
    });
    let list = await backend.listAttestations(AGENT);
    assert.deepEqual(
      list.map((a) => a.id).sort(),
      [a1.id, a2.id].sort(),
    );
    // Revocation is an upsert of the same id carrying revokedAt.
    await backend.putAttestation({ ...a1, revokedAt: iso(0) });
    list = await backend.listAttestations(AGENT);
    assert.equal(list.length, 2);
    assert.equal(list.find((a) => a.id === a1.id)?.revokedAt !== undefined, true);
    // Another subject's attestations are not mixed in.
    assert.deepEqual(await backend.listAttestations(ORG), []);
  });
});

describe("T3N adapter — delegation mapping (member-delegation doc)", () => {
  test("grantToBoundRows fans out one row per function with a validity window", () => {
    const grant: DelegationGrant = {
      id: "g1",
      grantorDid: OWNER,
      granteeDid: AGENT,
      resource: RESOURCE,
      functions: ["records.read", "records.write"],
      grantedAt: "2026-11-19T00:00:00.000Z",
      expiresAt: "2026-12-19T00:00:00.000Z",
    };
    const rows = grantToBoundRows(grant);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.function),
      ["records.read", "records.write"],
    );
    for (const row of rows) {
      assert.equal(row.grantee, AGENT);
      assert.equal(row.contract_id, RESOURCE);
      assert.deepEqual(row.scopes, []);
      assert.equal(row.window?.valid_from_secs, Date.parse(grant.grantedAt) / 1000);
      assert.equal(row.window?.valid_until_secs, Date.parse(grant.expiresAt!) / 1000);
    }
  });

  test("putDelegation writes rows via updateMemberDelegation; listDelegations regroups them", async () => {
    const { backend, client } = makeBackend();
    const grant: DelegationGrant = {
      id: "uuid-from-service",
      grantorDid: OWNER,
      granteeDid: AGENT,
      resource: RESOURCE,
      functions: ["records.read", "records.write"],
      grantedAt: iso(0),
      expiresAt: iso(HOUR),
    };
    await backend.putDelegation(grant);
    const write = client.callsTo("updateMemberDelegation")[0];
    assert.equal((write.args[0] as unknown[]).length, 2, "one row per function");
    // The node's doc now holds exactly those rows.
    assert.equal(client.delegationDoc().grants.length, 2);

    const listed = await backend.listDelegations(AGENT, RESOURCE);
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0].functions, ["records.read", "records.write"]);
    assert.equal(listed[0].grantorDid, OWNER, "grantor is the session DID (SelfOnly doc)");
    assert.equal(listed[0].id, `t3n:${AGENT}:${RESOURCE}`, "synthesised edge id");
    assert.ok(Math.abs(Date.parse(listed[0].expiresAt!) - Date.parse(grant.expiresAt)) < 1000);
    // A different resource has no edge.
    assert.deepEqual(await backend.listDelegations(AGENT, "tee:other/contracts"), []);
  });

  test("rowsToGrant returns undefined for an edge with no rows", () => {
    assert.equal(
      rowsToGrant({ grants: [], discover_dids: [] }, AGENT, RESOURCE, OWNER),
      undefined,
    );
  });

  test("checkNodeDelegation passes params through to the node verdict", async () => {
    const { backend, svc } = makeService();
    await fullyProvision(svc);
    const verdict = await backend.checkNodeDelegation({
      contract: RESOURCE,
      pii_did: OWNER,
      functions: [ACTION],
      scopes: [],
    });
    assert.equal(verdict.authorised, true);
    const missing = await backend.checkNodeDelegation({
      contract: RESOURCE,
      pii_did: OWNER,
      functions: ["records.delete"],
      scopes: [],
    });
    assert.equal(missing.authorised, false);
  });
});

describe("T3N adapter — revocation", () => {
  test("revoking removes the node rows immediately and leaves a tombstone", async () => {
    const { backend, client, svc } = makeService();
    const { delegation } = await fullyProvision(svc);
    assert.equal(client.delegationDoc().grants.length, 1);

    await svc.revokeDelegation(delegation.id, OWNER);

    // Immediate effect on the (mock) node: no standing rows remain, and
    // the removal went through removeMemberDelegationGrants with the
    // (grantee, contract_id) target.
    assert.equal(client.delegationDoc().grants.length, 0);
    assert.deepEqual(client.callsTo("removeMemberDelegationGrants")[0].args[0], [
      { grantee: AGENT, contract_id: RESOURCE },
    ]);
    // The gate still reports delegation_revoked (tombstone), exactly
    // like the in-memory backend — not missing_delegation.
    const res = await svc.verifyAccess(request);
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "delegation_revoked");
  });

  test("re-granting after revocation clears the tombstone and allows again", async () => {
    const { backend, client, svc } = makeService();
    const { delegation } = await fullyProvision(svc);
    await svc.revokeDelegation(delegation.id, OWNER);
    await svc.grantDelegation({
      grantorDid: OWNER,
      granteeDid: AGENT,
      resource: RESOURCE,
      functions: [ACTION],
    });
    assert.equal(client.delegationDoc().grants.length, 1);
    const res = await svc.verifyAccess(request);
    assert.equal(res.allowed, true);
    const listed = await backend.listDelegations(AGENT, RESOURCE);
    assert.equal(listed[0].revokedAt, undefined);
  });
});

describe("T3N adapter — full service story on T3nBackend", () => {
  test("register → attest → delegate → verify ✓ → revoke attestation → verify ✗", async () => {
    const { svc } = makeService();
    const { attestation } = await fullyProvision(svc);
    assert.equal((await svc.verifyAccess(request)).allowed, true);
    await svc.revokeAttestation(attestation.id, AUDITOR);
    const res = await svc.verifyAccess(request);
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "attestation_revoked");
  });

  test("expired delegation is denied via the window round-trip", async () => {
    const { svc } = makeService();
    await svc.registerAgent({ did: AGENT, name: "Research Agent 01", ownerDid: ORG });
    await svc.issueAttestation({
      capability: CAPABILITY,
      issuerDid: AUDITOR,
      subjectDid: AGENT,
    });
    await svc.grantDelegation({
      grantorDid: OWNER,
      granteeDid: AGENT,
      resource: RESOURCE,
      functions: [ACTION],
      expiresAt: iso(-HOUR),
    });
    const res = await svc.verifyAccess(request);
    assert.equal(res.reason, "delegation_expired");
  });
});

describe("T3N adapter — SDK error propagation", () => {
  test("a failing updateMemberDelegation rejects putDelegation with the same error", async () => {
    const { backend, client } = makeBackend();
    const boom = new Error("node unreachable");
    client.failWith("updateMemberDelegation", boom);
    await assert.rejects(
      backend.putDelegation({
        id: "g",
        grantorDid: OWNER,
        granteeDid: AGENT,
        resource: RESOURCE,
        functions: [ACTION],
        grantedAt: iso(0),
      }),
      (err: unknown) => err === boom,
    );
  });

  test("a failing maps entrySet rejects putAttestation with the same error", async () => {
    const { backend, maps } = makeBackend();
    const boom = new Error("map write refused");
    maps.failWith("entrySet", boom);
    await assert.rejects(
      backend.putAttestation({
        id: "a",
        capability: CAPABILITY,
        issuerDid: AUDITOR,
        subjectDid: AGENT,
        issuedAt: iso(0),
      }),
      (err: unknown) => err === boom,
    );
  });
});

describe("T3N adapter — node audit projection", () => {
  test("only committed batches are projected; kinds bucket by outcome, detail keeps the original", async () => {
    const { backend, client } = makeBackend();
    client.setAuditPage({
      batches: [
        {
          key: "aa",
          committed: true,
          events: [
            {
              ts_ms: Date.parse("2026-11-19T00:00:00.000Z"),
              subject: AGENT,
              actor: OWNER,
              action: "delegation.granted",
              target: RESOURCE,
              outcome: "success",
            },
            {
              ts_ms: Date.parse("2026-11-19T00:01:00.000Z"),
              subject: AGENT,
              actor: AGENT,
              action: "vault.open",
              target: RESOURCE,
              outcome: "denied",
              details: "no grant",
            },
          ],
        },
        {
          key: "bb",
          committed: false, // rolled back — its "success" is not a fact
          events: [
            {
              ts_ms: Date.parse("2026-11-19T00:02:00.000Z"),
              subject: AGENT,
              actor: AGENT,
              action: "access.verified",
              target: RESOURCE,
              outcome: "success",
            },
          ],
        },
      ],
      next_cursor: "bb",
    });
    const { events, nextCursor } = await backend.fetchNodeAuditEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, "delegation.granted", "known action keeps its kind");
    assert.equal(events[0].actorDid, OWNER);
    assert.equal(events[0].subjectDid, AGENT);
    assert.equal(events[1].kind, "access.denied", "unknown action buckets by outcome");
    assert.match(events[1].detail, /vault\.open/);
    assert.deepEqual(
      events.map((e) => e.seq),
      [1, 2],
    );
    assert.equal(nextCursor, "bb");
  });
});
