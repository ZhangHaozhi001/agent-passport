/**
 * Storage / network backend for the passport service.
 *
 * The passport logic (src/passport.ts) talks only to this interface, so the
 * same code runs against:
 *  - InMemoryBackend  — local demo & tests, no network (implemented)
 *  - T3nBackend       — live Terminal 3 testnet via @terminal3/t3n-sdk
 *                       (src/t3n/adapter.ts, wired in milestone M2)
 *
 * On T3N the mapping is:
 *  - identity     → tenant DID from T3nClient.authenticate(); org agents via
 *                   client.createAgent(orgDid, name)
 *  - attestations → tenant KV map entries (tenant.maps) with issuer-only
 *                   writers ACL; revocation = entry update
 *  - delegation   → client.updateMemberDelegation / getMemberDelegation /
 *                   revokeMemberDelegationForOrg (SDK ≥ 5.22 vocabulary)
 *  - audit        → client.getAuditEvents() / getActivityLog()
 */
import type {
  AgentIdentity,
  Attestation,
  DelegationGrant,
} from "./types.js";

export interface PassportBackend {
  putAgent(agent: AgentIdentity): Promise<void>;
  getAgent(did: string): Promise<AgentIdentity | undefined>;

  putAttestation(attestation: Attestation): Promise<void>;
  listAttestations(subjectDid: string): Promise<Attestation[]>;

  putDelegation(grant: DelegationGrant): Promise<void>;
  listDelegations(granteeDid: string, resource: string): Promise<DelegationGrant[]>;
}

/** Local, dependency-free backend used by the demo and unit tests. */
export class InMemoryBackend implements PassportBackend {
  private agents = new Map<string, AgentIdentity>();
  private attestations = new Map<string, Attestation>();
  private delegations = new Map<string, DelegationGrant>();

  async putAgent(agent: AgentIdentity): Promise<void> {
    this.agents.set(agent.did, agent);
  }
  async getAgent(did: string): Promise<AgentIdentity | undefined> {
    return this.agents.get(did);
  }
  async putAttestation(attestation: Attestation): Promise<void> {
    this.attestations.set(attestation.id, attestation);
  }
  async listAttestations(subjectDid: string): Promise<Attestation[]> {
    return [...this.attestations.values()].filter(
      (a) => a.subjectDid === subjectDid,
    );
  }
  async putDelegation(grant: DelegationGrant): Promise<void> {
    this.delegations.set(grant.id, grant);
  }
  async listDelegations(
    granteeDid: string,
    resource: string,
  ): Promise<DelegationGrant[]> {
    return [...this.delegations.values()].filter(
      (g) => g.granteeDid === granteeDid && g.resource === resource,
    );
  }
}
