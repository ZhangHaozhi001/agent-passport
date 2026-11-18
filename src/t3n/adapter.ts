/**
 * T3N adapter — maps passport operations onto the live Terminal 3 testnet
 * using @terminal3/t3n-sdk (pinned 5.31.0; the legacy agent-auth surface
 * was removed in SDK 5.22, only the delegation vocabulary exists now).
 *
 * Status (M2 pre-build): `T3nBackend` is fully implemented against two
 * narrow ports (below) and covered by unit tests against a mock SDK
 * (src/t3n/mock.ts, test/t3n-adapter.test.ts). `createT3nSession()` is the
 * only piece that touches the network: it builds a real `T3nClient` +
 * `TenantClient` from a claimed API key and hands their real methods to
 * the backend. Until a key is claimed (https://www.terminal3.io/claim-page)
 * the service runs on InMemoryBackend; nothing here silently falls back.
 *
 * Operation mapping (SDK 5.31.0, verified against the installed types):
 *
 *   identity     putAgent/getAgent → tenant KV map "passport-agents"
 *                (TenantMapsNamespace.entrySet/entryGet, key = agent DID,
 *                value = AgentIdentity JSON). Minting a NEW agent DID is a
 *                session-level op, not a backend op: `mintAgentDid()` →
 *                T3nClient.createAgent(orgDid, name). In live mode the DID
 *                passed to PassportService.registerAgent must come from
 *                createAgent (or be the session DID itself) — T3N will not
 *                register arbitrary caller-chosen DIDs.
 *   attestation  putAttestation/listAttestations → tenant KV map
 *                "passport-attestations" (key = subject DID, value = JSON
 *                array of Attestation, upsert by id). Revocation is an
 *                entry update carrying revokedAt — the service already
 *                models it that way, so no extra SDK surface is needed.
 *   delegation   putDelegation (live grant) → fanOutGrant() one BoundGrant
 *                row per function → T3nClient.updateMemberDelegation()
 *                (read-merge-write of the caller's own delegation doc;
 *                contract_id = the passport resource, window = validity).
 *                listDelegations → T3nClient.getMemberDelegation(),
 *                rows for (grantee, contract_id) regrouped into one
 *                DelegationGrant; grantor is the session DID (the doc is
 *                SelfOnly — every row in it is the caller's own grant).
 *   revocation   putDelegation with revokedAt set →
 *                T3nClient.removeMemberDelegationGrants([{grantee,
 *                contract_id}]) — the standing authority is gone from the
 *                node immediately — PLUS a tombstone record in the KV map
 *                "passport-delegation-tombstones" so listDelegations can
 *                still surface the revoked grant and the gate reports
 *                `delegation_revoked` (not `missing_delegation`), exactly
 *                like InMemoryBackend. The tombstone is bookkeeping only:
 *                it confers nothing, and live rows always win over it.
 *   audit        PassportBackend has no audit ops (PassportService keeps
 *                the trail), but the node-side trail is exposed here as
 *                `fetchNodeAuditEvents()` → T3nClient.getAuditEvents(),
 *                projected onto the passport AuditEvent shape.
 *
 * Known mapping constraints (documented, not hidden):
 *  - T3N keeps at most one row per (grantee, contract_id, function), and
 *    updateMemberDelegation unions into the doc: re-granting the same
 *    (grantee, resource) with FEWER functions does not narrow the live
 *    grant — revoke first, then re-grant. DelegationGrant.id has no
 *    on-chain counterpart; listDelegations synthesises
 *    `t3n:<grantee>:<resource>` per (grantee, resource) edge.
 *  - removeMemberDelegationGrants removes at (grantee, contract_id)
 *    granularity — all functions of that edge at once. That matches the
 *    service, which revokes whole grants, never single functions.
 *  - BoundGrant.scopes (org-data scopes) are not modelled by the
 *    passport; rows are written with `scopes: []`.
 *  - Map creation passes writers/readers "all": the SDK's scoped form is
 *    `{ only: number[] }` (contract ids), whose tenant-map semantics can
 *    only be confirmed against a live node. TODO(M2-live): tighten the
 *    ACLs and confirm the map `visibility` string on first live run —
 *    both are isolated in ensureMaps() below.
 */
import {
  fanOutGrant,
  type BoundGrant,
  type GrantCheckParams,
  type GrantCheckResult,
  type MapCreateInput,
  type MapLifecycleStatus,
  type MemberDelegationDoc,
  type RemoveTarget,
} from "@terminal3/t3n-sdk";
import type { PassportBackend } from "../backend.js";
import type {
  AgentIdentity,
  Attestation,
  AuditEvent,
  DelegationGrant,
} from "../types.js";

// ── Config ───────────────────────────────────────────────────────────────

export interface T3nConfig {
  /** From the Terminal 3 claim page; never committed to the repo.
   *  Per the SDK README this is the private key of the ETH wallet
   *  registered with Terminal 3 — it signs the login challenge locally. */
  apiKey: string;
  environment: "testnet" | "sandbox" | "production";
  /** Optional node URL override (T3N_NODE_URL); defaults to the SDK's
   *  NODE_URLS entry for the environment. */
  nodeUrl?: string;
}

export class T3nNotConfiguredError extends Error {
  /** What is missing, named one by one so the fix is obvious. */
  readonly missing: string[];
  constructor(missing: string[] = ["T3N_API_KEY"]) {
    super(
      "T3N live mode is not configured — missing: " +
        missing.join(", ") +
        ". Claim a free testnet API key at " +
        "https://www.terminal3.io/claim-page and set T3N_API_KEY. " +
        "Run `npm run demo` for the in-memory mode, which needs no key.",
    );
    this.name = "T3nNotConfiguredError";
    this.missing = missing;
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
  const nodeUrl = env.T3N_NODE_URL?.trim();
  return nodeUrl ? { apiKey, environment, nodeUrl } : { apiKey, environment };
}

// ── Ports: the exact SDK surface the backend consumes ────────────────────
// Structural subsets of the real SDK classes (T3nClient /
// TenantMapsNamespace), so unit tests can substitute a mock and the live
// session factory can pass the real objects with no adapter code between.

export interface T3nClientPort {
  createAgent(
    organisationDid: string,
    name: string,
  ): Promise<{ agentDid: string }>;
  getMemberDelegation(): Promise<MemberDelegationDoc>;
  updateMemberDelegation(
    grant: BoundGrant | BoundGrant[],
    options?: { discoverDids?: string[] },
  ): Promise<{ preservedRows: string[] }>;
  removeMemberDelegationGrants(targets: RemoveTarget[]): Promise<void>;
  checkDelegation(params: GrantCheckParams): Promise<GrantCheckResult>;
  getAuditEvents(opts?: {
    pii_did?: string;
    limit?: number;
    cursor?: string;
  }): Promise<SdkAuditPageLike>;
}

export interface T3nMapsPort {
  create(input: MapCreateInput): Promise<unknown>;
  getStatus(tail: string): Promise<MapLifecycleStatus>;
  entrySet(tail: string, key: string, value: string): Promise<void>;
  entryGet(tail: string, key: string): Promise<string | null>;
}

export interface T3nPorts {
  client: T3nClientPort;
  maps: T3nMapsPort;
}

/**
 * The SDK's audit shapes (AuditPage / AuditEvent) are not in the package's
 * exported type list, so the port uses these structural mirrors of the
 * installed .d.ts declarations.
 */
export interface SdkAuditEventLike {
  ts_ms: number;
  subject: string;
  actor: string;
  vc_id?: string | null;
  action: string;
  target: string;
  outcome: string;
  details?: string | null;
}
export interface SdkAuditPageLike {
  batches: Array<{ key: string; committed: boolean; events: SdkAuditEventLike[] }>;
  next_cursor?: string | null;
}

// ── Tenant KV map layout ─────────────────────────────────────────────────

export const AGENTS_MAP = "passport-agents";
export const ATTESTATIONS_MAP = "passport-attestations";
export const TOMBSTONES_MAP = "passport-delegation-tombstones";
const ALL_MAPS = [AGENTS_MAP, ATTESTATIONS_MAP, TOMBSTONES_MAP];

/** TODO(M2-live): confirm the visibility string against a live node. */
const MAP_VISIBILITY = "private";

const tombstoneKey = (granteeDid: string, resource: string) =>
  JSON.stringify([granteeDid, resource]);

const toSecs = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const toIso = (secs: number) => new Date(secs * 1000).toISOString();

// ── Grant conversion (passport DelegationGrant ↔ SDK BoundGrant rows) ────

/** The BoundGrant base shared by every fanned-out row of one grant. */
export function grantToBoundBase(
  grant: DelegationGrant,
): Omit<BoundGrant, "function"> {
  return {
    grantee: grant.granteeDid,
    contract_id: grant.resource,
    scopes: [],
    window: {
      valid_from_secs: toSecs(grant.grantedAt),
      ...(grant.expiresAt ? { valid_until_secs: toSecs(grant.expiresAt) } : {}),
    },
  };
}

/** One passport grant → one BoundGrant row per function (SDK wire shape). */
export function grantToBoundRows(grant: DelegationGrant): BoundGrant[] {
  return fanOutGrant(grantToBoundBase(grant), grant.functions);
}

/**
 * Regroup the rows of one (grantee, contract_id) edge of a delegation doc
 * back into a passport DelegationGrant. Returns undefined when the edge
 * has no rows. `grantorDid` is the session DID (the doc is SelfOnly).
 */
export function rowsToGrant(
  doc: MemberDelegationDoc,
  granteeDid: string,
  resource: string,
  grantorDid: string,
): DelegationGrant | undefined {
  const rows = doc.grants.filter(
    (g) => g.grantee === granteeDid && g.contract_id === resource,
  );
  if (rows.length === 0) return undefined;
  const window = rows[0].window;
  return {
    id: `t3n:${granteeDid}:${resource}`,
    grantorDid,
    granteeDid,
    resource,
    functions: rows.map((r) => r.function),
    grantedAt: window?.valid_from_secs ? toIso(window.valid_from_secs) : toIso(0),
    ...(window?.valid_until_secs
      ? { expiresAt: toIso(window.valid_until_secs) }
      : {}),
  };
}

// ── Audit projection (node trail → passport AuditEvent shape) ────────────

const AUDIT_KINDS: ReadonlySet<string> = new Set([
  "agent.registered",
  "attestation.issued",
  "attestation.revoked",
  "delegation.granted",
  "delegation.revoked",
  "access.verified",
  "access.denied",
]);

/**
 * Project one page of node audit events onto the passport AuditEvent
 * shape. Only committed batches are projected (an uncommitted batch's
 * "success" is the contract's claim, not a fact — per the SDK docs).
 * Node actions are contract-defined free text: an action that matches a
 * passport kind keeps it, anything else is bucketed by outcome
 * (denied → access.denied, otherwise access.verified) and the original
 * action/target/outcome are preserved verbatim in `detail`. `seq` is
 * fetch-local (1-based, page order); the node's own ordering key is the
 * batch key, surfaced via the returned cursor.
 */
export function projectAuditPage(page: SdkAuditPageLike): {
  events: AuditEvent[];
  nextCursor: string | null;
} {
  const events: AuditEvent[] = [];
  for (const batch of page.batches) {
    if (!batch.committed) continue;
    for (const e of batch.events) {
      const kind = AUDIT_KINDS.has(e.action)
        ? (e.action as AuditEvent["kind"])
        : e.outcome === "denied"
          ? "access.denied"
          : "access.verified";
      events.push({
        seq: events.length + 1,
        at: new Date(e.ts_ms).toISOString(),
        kind,
        actorDid: e.actor,
        subjectDid: e.subject,
        detail:
          `${e.action} on ${e.target} → ${e.outcome}` +
          (e.details ? ` — ${e.details}` : ""),
      });
    }
  }
  return { events, nextCursor: page.next_cursor ?? null };
}

// ── T3nBackend ───────────────────────────────────────────────────────────

export class T3nBackend implements PassportBackend {
  private mapsReady: Promise<void> | undefined;

  constructor(
    private ports: T3nPorts,
    private sessionDid: string,
  ) {
    const missing: string[] = [];
    if (!ports?.client) missing.push("ports.client (authenticated T3nClient)");
    if (!ports?.maps) missing.push("ports.maps (TenantClient.maps)");
    if (!sessionDid) missing.push("sessionDid (DID from client.authenticate())");
    if (missing.length > 0) throw new T3nNotConfiguredError(missing);
  }

  /** Create the three KV maps on first use (idempotent, cached; a
   *  failed attempt is not cached, so the next call retries). */
  private ensureMaps(): Promise<void> {
    this.mapsReady ??= (async () => {
      for (const tail of ALL_MAPS) {
        if ((await this.ports.maps.getStatus(tail)) === "absent") {
          await this.ports.maps.create({
            tail,
            visibility: MAP_VISIBILITY,
            // TODO(M2-live): tighten from "all" once the numeric
            // writer/reader id semantics are confirmed on a live node;
            // readers must be set explicitly — omitting them defaults
            // to deny-all and the maps would be unreadable.
            writers: "all",
            readers: "all",
          });
        }
      }
    })().catch((err: unknown) => {
      this.mapsReady = undefined;
      throw err;
    });
    return this.mapsReady;
  }

  // ── Identity → KV map ────────────────────────────────────────────────
  async putAgent(agent: AgentIdentity): Promise<void> {
    await this.ensureMaps();
    await this.ports.maps.entrySet(AGENTS_MAP, agent.did, JSON.stringify(agent));
  }

  async getAgent(did: string): Promise<AgentIdentity | undefined> {
    await this.ensureMaps();
    const raw = await this.ports.maps.entryGet(AGENTS_MAP, did);
    return raw ? (JSON.parse(raw) as AgentIdentity) : undefined;
  }

  /**
   * Mint a NEW agent DID on T3N (session-level op, not part of
   * PassportBackend): T3nClient.createAgent. The returned DID is what
   * live mode passes to PassportService.registerAgent.
   */
  async mintAgentDid(organisationDid: string, name: string): Promise<string> {
    const { agentDid } = await this.ports.client.createAgent(organisationDid, name);
    return agentDid;
  }

  // ── Attestations → KV map (per-subject JSON array, upsert by id) ─────
  async putAttestation(attestation: Attestation): Promise<void> {
    await this.ensureMaps();
    const list = await this.listAttestations(attestation.subjectDid);
    const idx = list.findIndex((a) => a.id === attestation.id);
    if (idx >= 0) list[idx] = attestation;
    else list.push(attestation);
    await this.ports.maps.entrySet(
      ATTESTATIONS_MAP,
      attestation.subjectDid,
      JSON.stringify(list),
    );
  }

  async listAttestations(subjectDid: string): Promise<Attestation[]> {
    await this.ensureMaps();
    const raw = await this.ports.maps.entryGet(ATTESTATIONS_MAP, subjectDid);
    return raw ? (JSON.parse(raw) as Attestation[]) : [];
  }

  // ── Delegation → member-delegation document ──────────────────────────
  async putDelegation(grant: DelegationGrant): Promise<void> {
    await this.ensureMaps();
    if (grant.revokedAt) {
      // Revocation: remove the standing authority from the node first
      // (effective immediately), then leave a tombstone so the gate can
      // still report `delegation_revoked` instead of `missing_delegation`.
      await this.ports.client.removeMemberDelegationGrants([
        { grantee: grant.granteeDid, contract_id: grant.resource },
      ]);
      await this.ports.maps.entrySet(
        TOMBSTONES_MAP,
        tombstoneKey(grant.granteeDid, grant.resource),
        JSON.stringify(grant),
      );
      return;
    }
    await this.ports.client.updateMemberDelegation(grantToBoundRows(grant));
    // A fresh grant supersedes any tombstone for the edge. The maps
    // surface has no per-entry delete, so clearing = writing "" (which
    // readTombstone treats as absent).
    await this.ports.maps.entrySet(
      TOMBSTONES_MAP,
      tombstoneKey(grant.granteeDid, grant.resource),
      "",
    );
  }

  async listDelegations(
    granteeDid: string,
    resource: string,
  ): Promise<DelegationGrant[]> {
    await this.ensureMaps();
    const doc = await this.ports.client.getMemberDelegation();
    const live = rowsToGrant(doc, granteeDid, resource, this.sessionDid);
    if (live) return [live];
    const tombstone = await this.readTombstone(granteeDid, resource);
    return tombstone ? [tombstone] : [];
  }

  private async readTombstone(
    granteeDid: string,
    resource: string,
  ): Promise<DelegationGrant | undefined> {
    const raw = await this.ports.maps.entryGet(
      TOMBSTONES_MAP,
      tombstoneKey(granteeDid, resource),
    );
    return raw ? (JSON.parse(raw) as DelegationGrant) : undefined;
  }

  /**
   * The node's own delegation verdict (member_delegation ∩ org_delegation)
   * for the acting agent — an adapter-level read, NOT the passport gate:
   * PassportService.verifyAccess stays the single gate logic for every
   * backend. Pass-through: SDK errors propagate unchanged.
   */
  async checkNodeDelegation(params: GrantCheckParams): Promise<GrantCheckResult> {
    return this.ports.client.checkDelegation(params);
  }

  /** Node-side audit trail, projected (see projectAuditPage). */
  async fetchNodeAuditEvents(opts?: {
    pii_did?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ events: AuditEvent[]; nextCursor: string | null }> {
    return projectAuditPage(await this.ports.client.getAuditEvents(opts));
  }
}

// ── Live session factory (the only network-touching code) ────────────────

/**
 * Build a live session from a claimed API key: construct T3nClient
 * (WASM component + operator trust anchor + ETH signing handler — the
 * API key is the registered ETH wallet's private key, per the SDK
 * README), handshake, authenticate, then wire the real client and a
 * TenantClient's maps namespace into a T3nBackend.
 *
 * Throws T3nNotConfiguredError before any network I/O when the config
 * carries no API key.
 */
export async function createT3nSession(config: T3nConfig): Promise<{
  backend: T3nBackend;
  sessionDid: string;
}> {
  if (!config?.apiKey?.trim()) throw new T3nNotConfiguredError();
  const sdk = await import("@terminal3/t3n-sdk");
  const baseUrl = config.nodeUrl ?? sdk.NODE_URLS[config.environment];
  const address = sdk.eth_get_address(config.apiKey);
  const client = new sdk.T3nClient({
    baseUrl,
    trustAnchor: await sdk.fetchTrustedManifest(config.environment, { baseUrl }),
    wasmComponent: await sdk.loadWasmComponent(),
    handlers: { EthSign: sdk.metamask_sign(address, undefined, config.apiKey) },
  });
  await client.handshake();
  const sessionDid = String(await client.authenticate(sdk.createEthAuthInput(address)));
  const tenant = new sdk.TenantClient({
    environment: config.environment,
    t3n: client,
    tenantDid: sessionDid,
    baseUrl,
  });
  // The real client is structurally the port, except createAgent returns
  // the SDK's Did object ({ value, toString }) — normalise it to the
  // canonical string form here, at the factory boundary.
  const clientPort: T3nClientPort = {
    createAgent: async (organisationDid, name) => ({
      agentDid: String((await client.createAgent(organisationDid, name)).agentDid),
    }),
    getMemberDelegation: () => client.getMemberDelegation(),
    updateMemberDelegation: (grant, options) =>
      client.updateMemberDelegation(grant, options),
    removeMemberDelegationGrants: (targets) =>
      client.removeMemberDelegationGrants(targets),
    checkDelegation: (params) => client.checkDelegation(params),
    getAuditEvents: (opts) => client.getAuditEvents(opts),
  };
  return {
    backend: new T3nBackend({ client: clientPort, maps: tenant.maps }, sessionDid),
    sessionDid,
  };
}
