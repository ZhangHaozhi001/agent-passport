/**
 * T3N adapter — maps passport operations onto the live Terminal 3 testnet
 * using @terminal3/t3n-sdk (pinned 5.31.0; see NOTES in the project docs —
 * the legacy agent-auth surface was removed in SDK 5.22, only the
 * delegation vocabulary exists now).
 *
 * Status: interface + connection path implemented; the per-operation wiring
 * lands in milestone M2 once a testnet API key is claimed
 * (https://www.terminal3.io/claim-page). Until then the service runs on
 * InMemoryBackend, and this file documents the exact SDK call for each op:
 *
 *   registerAgent      → client.authenticate() → tenantDid (self), or
 *                        client.createAgent(orgDid, name) for org agents
 *   issueAttestation   → tenant.maps: create map "passport:attestations"
 *                        (writers: issuer only) + entrySet(subjectDid, json)
 *   revokeAttestation  → same map, entry update with revokedAt
 *   grantDelegation    → client.updateMemberDelegation([grant]) — one grant
 *                        per function; fanOutGrant() for several functions
 *   revokeDelegation   → client.revokeMemberDelegationForOrg(orgTid) or a
 *                        delegation update removing the function rows
 *   verifyAccess       → client.getMemberDelegation() +
 *                        discoverCheckDelegation() (stateless, API-key auth)
 *                        + attestation map read
 *   audit              → client.getAuditEvents() / client.getActivityLog()
 */

export interface T3nConfig {
  /** From the Terminal 3 claim page; never committed to the repo. */
  apiKey: string;
  environment: "testnet" | "sandbox" | "production";
}

export class T3nNotConfiguredError extends Error {
  constructor() {
    super(
      "T3N live mode needs T3N_API_KEY (claim one at " +
        "https://www.terminal3.io/claim-page). Run `npm run demo` for the " +
        "in-memory mode, which needs no key.",
    );
    this.name = "T3nNotConfiguredError";
  }
}

export function loadT3nConfig(env: NodeJS.ProcessEnv = process.env): T3nConfig {
  const apiKey = env.T3N_API_KEY?.trim();
  if (!apiKey) throw new T3nNotConfiguredError();
  const environment =
    env.T3N_ENVIRONMENT === "production"
      ? "production"
      : env.T3N_ENVIRONMENT === "sandbox"
        ? "sandbox"
        : "testnet";
  return { apiKey, environment };
}

/**
 * Placeholder for the live client factory (M2). Kept as a throwing stub so
 * the wiring point is explicit and type-checked, instead of silently
 * falling back to demo data in a "live" run.
 */
export async function createT3nSession(_config: T3nConfig): Promise<never> {
  throw new Error(
    "Live T3N session wiring lands in milestone M2 (see PLAN.md). " +
      "The SDK calls for every passport operation are mapped in this file.",
  );
}
