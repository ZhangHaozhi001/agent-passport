/**
 * Agent Trust Passport — core service.
 *
 * Lifecycle: register → attest → delegate → verify → revoke.
 * Verification is fail-closed and checks, in order: identity, a valid
 * attestation from a trusted issuer, and a live delegation covering the
 * requested action on the requested resource. Every state change and every
 * verification outcome is written to an audit trail (on T3N this maps to
 * the node's own audit/activity log; here it is kept by the service).
 */
import { randomUUID } from "node:crypto";
import type { PassportBackend } from "./backend.js";
import type {
  AgentIdentity,
  Attestation,
  AuditEvent,
  DelegationGrant,
  VerifyRequest,
  VerifyResult,
} from "./types.js";

const now = () => new Date().toISOString();
const isPast = (iso?: string) => iso !== undefined && Date.parse(iso) <= Date.now();

export class PassportService {
  private audit: AuditEvent[] = [];
  private seq = 0;

  constructor(private backend: PassportBackend) {}

  private log(
    kind: AuditEvent["kind"],
    actorDid: string,
    detail: string,
    subjectDid?: string,
  ): void {
    this.audit.push({ seq: ++this.seq, at: now(), kind, actorDid, subjectDid, detail });
  }

  /** The full audit trail, oldest first. */
  getAuditTrail(): readonly AuditEvent[] {
    return this.audit;
  }

  // ── 1. Register ────────────────────────────────────────────────────────
  async registerAgent(input: {
    did: string;
    name: string;
    ownerDid: string;
  }): Promise<AgentIdentity> {
    const agent: AgentIdentity = { ...input, createdAt: now() };
    await this.backend.putAgent(agent);
    this.log("agent.registered", input.ownerDid, `Registered agent "${input.name}"`, input.did);
    return agent;
  }

  // ── 2. Attest ──────────────────────────────────────────────────────────
  async issueAttestation(input: {
    capability: string;
    issuerDid: string;
    subjectDid: string;
    expiresAt?: string;
  }): Promise<Attestation> {
    const attestation: Attestation = { id: randomUUID(), issuedAt: now(), ...input };
    await this.backend.putAttestation(attestation);
    this.issuedAttestations.set(attestation.id, attestation);
    this.log(
      "attestation.issued",
      input.issuerDid,
      `Attested capability "${input.capability}"`,
      input.subjectDid,
    );
    return attestation;
  }

  async revokeAttestation(id: string, revokerDid: string): Promise<void> {
    const target = this.issuedAttestations.get(id);
    if (!target) throw new Error(`unknown attestation: ${id}`);
    target.revokedAt = now();
    await this.backend.putAttestation(target);
    this.log("attestation.revoked", revokerDid, `Revoked attestation ${id}`, target.subjectDid);
  }

  private issuedAttestations = new Map<string, Attestation>();

  // ── 3. Delegate ────────────────────────────────────────────────────────
  async grantDelegation(input: {
    grantorDid: string;
    granteeDid: string;
    resource: string;
    functions: string[];
    expiresAt?: string;
  }): Promise<DelegationGrant> {
    const grant: DelegationGrant = { id: randomUUID(), grantedAt: now(), ...input };
    await this.backend.putDelegation(grant);
    this.issuedGrants.set(grant.id, grant);
    this.log(
      "delegation.granted",
      input.grantorDid,
      `Granted ${input.functions.join(", ")} on ${input.resource}`,
      input.granteeDid,
    );
    return grant;
  }

  async revokeDelegation(id: string, revokerDid: string): Promise<void> {
    // Locate via a targeted scan of the in-memory store is backend-specific;
    // the service keeps the grants it issued so revocation stays O(1)-ish.
    const grant = this.issuedGrants.get(id);
    if (!grant) throw new Error(`unknown delegation: ${id}`);
    grant.revokedAt = now();
    await this.backend.putDelegation(grant);
    this.log("delegation.revoked", revokerDid, `Revoked delegation ${id}`, grant.granteeDid);
  }

  private issuedGrants = new Map<string, DelegationGrant>();

  // ── 4. Verify (the gate every resource owner calls before access) ──────
  async verifyAccess(req: VerifyRequest): Promise<VerifyResult> {
    const checkedAt = now();
    const deny = (reason: VerifyResult["reason"], detail: string): VerifyResult => {
      this.log("access.denied", req.agentDid, `${reason}: ${detail}`);
      return { allowed: false, reason, detail, checkedAt };
    };

    const agent = await this.backend.getAgent(req.agentDid);
    if (!agent) return deny("unknown_agent", `No passport registered for ${req.agentDid}`);

    const attestations = (await this.backend.listAttestations(req.agentDid)).filter(
      (a) => a.capability === req.capability && req.trustedIssuers.includes(a.issuerDid),
    );
    if (attestations.length === 0)
      return deny(
        "missing_attestation",
        `No attestation for "${req.capability}" from a trusted issuer`,
      );
    const attestation = attestations[0];
    if (attestation.revokedAt)
      return deny("attestation_revoked", `Attestation ${attestation.id} was revoked`);
    if (isPast(attestation.expiresAt))
      return deny("attestation_expired", `Attestation ${attestation.id} has expired`);

    const delegations = (
      await this.backend.listDelegations(req.agentDid, req.resource)
    ).filter((g) => g.functions.includes(req.action));
    if (delegations.length === 0)
      return deny(
        "missing_delegation",
        `No delegation covering "${req.action}" on ${req.resource}`,
      );
    const delegation = delegations[0];
    if (delegation.revokedAt)
      return deny("delegation_revoked", `Delegation ${delegation.id} was revoked`);
    if (isPast(delegation.expiresAt))
      return deny("delegation_expired", `Delegation ${delegation.id} has expired`);

    this.log(
      "access.verified",
      req.agentDid,
      `Allowed "${req.action}" on ${req.resource} (capability "${req.capability}")`,
    );
    return {
      allowed: true,
      detail: `Identity, attestation (${attestation.id}) and delegation (${delegation.id}) all valid`,
      checkedAt,
    };
  }
}
