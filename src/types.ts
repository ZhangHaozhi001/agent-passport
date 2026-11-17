/**
 * Agent Trust Passport — core types.
 *
 * A passport answers one question for a resource owner: "should this agent
 * be allowed to do this thing, right now?" It bundles three facts that are
 * checked together at access time:
 *   1. identity     — a DID the agent authenticated with (on T3N: did:t3n:…)
 *   2. attestations — capability claims issued by a trusted issuer
 *   3. delegation   — a scoped grant from the resource owner to the agent
 * Any of the three can be revoked independently; verification fails closed.
 */

export interface AgentIdentity {
  /** Decentralised identifier, e.g. did:t3n:… on the live T3N backend. */
  did: string;
  /** Human-readable agent name shown in the passport UI. */
  name: string;
  /** DID of the owner/organisation that registered this agent. */
  ownerDid: string;
  createdAt: string; // ISO 8601
}

export interface Attestation {
  id: string;
  /** The capability being attested, e.g. "payments.initiate" or "data.read.pii". */
  capability: string;
  /** DID of the issuer (auditor, platform, employer…) the verifier trusts. */
  issuerDid: string;
  subjectDid: string;
  issuedAt: string; // ISO 8601
  /** Optional expiry; undefined = valid until revoked. */
  expiresAt?: string;
  revokedAt?: string;
}

export interface DelegationGrant {
  id: string;
  /** DID granting access (resource owner / data owner). */
  grantorDid: string;
  /** DID receiving access (the agent). */
  granteeDid: string;
  /** Resource identifier, e.g. "vault:customer-records" or a T3N contract id. */
  resource: string;
  /** Contract functions / actions the grant covers — one row per function,
   *  mirroring T3N member-delegation semantics (one grant = one function). */
  functions: string[];
  grantedAt: string; // ISO 8601
  expiresAt?: string;
  revokedAt?: string;
}

export type VerifyFailure =
  | "unknown_agent"
  | "missing_attestation"
  | "attestation_expired"
  | "attestation_revoked"
  | "missing_delegation"
  | "delegation_expired"
  | "delegation_revoked";

export interface VerifyRequest {
  agentDid: string;
  capability: string;
  resource: string;
  /** The contract function / action the agent wants to invoke. */
  action: string;
  /** Issuers the verifier accepts for this capability. */
  trustedIssuers: string[];
}

export interface VerifyResult {
  allowed: boolean;
  /** Present iff allowed === false. */
  reason?: VerifyFailure;
  /** Human-readable explanation for the UI / audit log. */
  detail: string;
  checkedAt: string; // ISO 8601
}

export interface AuditEvent {
  seq: number;
  at: string; // ISO 8601
  kind:
    | "agent.registered"
    | "attestation.issued"
    | "attestation.revoked"
    | "delegation.granted"
    | "delegation.revoked"
    | "access.verified"
    | "access.denied";
  actorDid: string;
  subjectDid?: string;
  detail: string;
}
