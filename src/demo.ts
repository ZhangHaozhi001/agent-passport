/**
 * Runnable end-to-end demo (in-memory backend, no network, no API key):
 *
 *   npm install && npm run demo
 *
 * Story: an org registers a research agent; an auditor attests its
 * "data.read" capability; a data owner delegates read access to one vault;
 * the gate verifies → allowed. Then the delegation is revoked → the same
 * request is denied. Every step lands in the audit trail.
 */
import { InMemoryBackend } from "./backend.js";
import { PassportService } from "./passport.js";

const OWNER = "did:t3n:org-acme";
const AUDITOR = "did:t3n:auditor-trustco";
const AGENT = "did:t3n:agent-research-01";
const RESOURCE = "vault:customer-records";

const passport = new PassportService(new InMemoryBackend());

await passport.registerAgent({ did: AGENT, name: "Research Agent 01", ownerDid: OWNER });
const attestation = await passport.issueAttestation({
  capability: "data.read",
  issuerDid: AUDITOR,
  subjectDid: AGENT,
});
const grant = await passport.grantDelegation({
  grantorDid: OWNER,
  granteeDid: AGENT,
  resource: RESOURCE,
  functions: ["records.read"],
});

const request = {
  agentDid: AGENT,
  capability: "data.read",
  resource: RESOURCE,
  action: "records.read",
  trustedIssuers: [AUDITOR],
};

console.log("verify #1 (grant live):   ", await passport.verifyAccess(request));

await passport.revokeDelegation(grant.id, OWNER);
console.log("verify #2 (grant revoked):", await passport.verifyAccess(request));

await passport.grantDelegation({
  grantorDid: OWNER,
  granteeDid: AGENT,
  resource: RESOURCE,
  functions: ["records.read"],
});
await passport.revokeAttestation(attestation.id, AUDITOR);
console.log("verify #3 (attest. revoked):", await passport.verifyAccess(request));

console.log("\naudit trail:");
for (const e of passport.getAuditTrail()) {
  console.log(`  #${e.seq} ${e.at} ${e.kind} — ${e.detail}`);
}
