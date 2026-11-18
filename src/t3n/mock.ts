/**
 * Mock SDK stand-in for the T3N adapter tests — in-memory implementations of
 * the two ports in adapter.ts (T3nClientPort / T3nMapsPort), with
 * semantics mirrored from the SDK 5.31.0 type documentation:
 *
 *  - updateMemberDelegation is a read-merge-write with (grantee,
 *    contract_id, function) union semantics — implemented with the SDK's
 *    own exported mergeGrants/mergeDiscoverDids helpers, so the mock
 *    cannot drift from the real merge behaviour.
 *  - removeMemberDelegationGrants is subtractive: a target with a
 *    contract_id drops that contract's rows for the grantee; without
 *    one it drops the whole delegatee edge.
 *  - checkDelegation answers from the mock's delegation doc for a
 *    configured "acting agent" DID (on the node the agent is resolved
 *    from the session; here it is a constructor parameter).
 *  - Maps: entrySet/entryGet on an absent map throw (a node refuses
 *    writes to a map that does not exist); entryGet of a missing key
 *    returns null — the SDK's deliberate "key absent" signal.
 *
 * Every call is recorded in `calls` for mapping assertions, and
 * `failWith(method, error)` injects a one-shot failure so tests can
 * verify that SDK errors propagate through the adapter unchanged.
 */
import {
  mergeDiscoverDids,
  mergeGrants,
  type BoundGrant,
  type GrantCheckParams,
  type GrantCheckResult,
  type MapCreateInput,
  type MapLifecycleStatus,
  type MemberDelegationDoc,
  type RemoveTarget,
} from "@terminal3/t3n-sdk";
import type {
  SdkAuditPageLike,
  T3nClientPort,
  T3nMapsPort,
} from "./adapter.js";

export interface RecordedCall {
  method: string;
  args: unknown[];
}

class CallRecorder {
  readonly calls: RecordedCall[] = [];
  private failures = new Map<string, Error>();

  /** Make the next call to `method` throw `error` (once). */
  failWith(method: string, error: Error): void {
    this.failures.set(method, error);
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  protected record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw failure;
    }
  }
}

export class MockT3nClient extends CallRecorder implements T3nClientPort {
  private doc: MemberDelegationDoc = { grants: [], discover_dids: [] };
  private agentSeq = 0;
  private auditPage: SdkAuditPageLike = { batches: [], next_cursor: null };

  /**
   * @param actingAgentDid the DID checkDelegation treats as the session
   * agent (the node resolves this from the session itself).
   */
  constructor(private actingAgentDid: string = "did:t3n:agent-mock") {
    super();
  }

  /** Test helper: replace the audit page getAuditEvents returns. */
  setAuditPage(page: SdkAuditPageLike): void {
    this.auditPage = page;
  }

  /** Test helper: read the current delegation doc (defensive copy). */
  delegationDoc(): MemberDelegationDoc {
    return structuredClone(this.doc);
  }

  async createAgent(
    organisationDid: string,
    name: string,
  ): Promise<{ agentDid: string }> {
    this.record("createAgent", [organisationDid, name]);
    const hex = (++this.agentSeq).toString(16).padStart(40, "0");
    return { agentDid: `did:t3n:${hex}` };
  }

  async getMemberDelegation(): Promise<MemberDelegationDoc> {
    this.record("getMemberDelegation", []);
    return structuredClone(this.doc);
  }

  async updateMemberDelegation(
    grant: BoundGrant | BoundGrant[],
    options?: { discoverDids?: string[] },
  ): Promise<{ preservedRows: string[] }> {
    this.record("updateMemberDelegation", [grant, options]);
    const additions = Array.isArray(grant) ? grant : [grant];
    const { grants, preservedRows } = mergeGrants(this.doc.grants, additions);
    this.doc = {
      grants,
      discover_dids: options?.discoverDids
        ? mergeDiscoverDids(this.doc.discover_dids, options.discoverDids)
        : this.doc.discover_dids,
    };
    return { preservedRows };
  }

  async removeMemberDelegationGrants(targets: RemoveTarget[]): Promise<void> {
    this.record("removeMemberDelegationGrants", [targets]);
    for (const target of targets) {
      this.doc = {
        ...this.doc,
        grants: this.doc.grants.filter(
          (g) =>
            g.grantee !== target.grantee ||
            (target.contract_id !== undefined &&
              g.contract_id !== target.contract_id),
        ),
      };
    }
  }

  async checkDelegation(params: GrantCheckParams): Promise<GrantCheckResult> {
    this.record("checkDelegation", [params]);
    const held = this.doc.grants.filter(
      (g) => g.grantee === this.actingAgentDid && g.contract_id === params.contract,
    );
    const satisfied =
      params.functions.length > 0 &&
      params.functions.every((f) => held.some((g) => g.function === f));
    const ref = {
      grant: "member_delegation" as const,
      contract: params.contract,
      functions: params.functions,
      scopes: params.scopes,
    };
    return satisfied
      ? { authorised: true, disclosed: true, satisfied: [ref], missing: [] }
      : { authorised: false, disclosed: true, satisfied: [], missing: [ref] };
  }

  async getAuditEvents(opts?: {
    pii_did?: string;
    limit?: number;
    cursor?: string;
  }): Promise<SdkAuditPageLike> {
    this.record("getAuditEvents", [opts]);
    return structuredClone(this.auditPage);
  }
}

export class MockT3nMaps extends CallRecorder implements T3nMapsPort {
  private maps = new Map<string, Map<string, string>>();
  /** Every create() input, in order — for ACL/shape assertions. */
  readonly createdMaps: MapCreateInput[] = [];

  async create(input: MapCreateInput): Promise<unknown> {
    this.record("create", [input]);
    if (this.maps.has(input.tail)) {
      throw new Error(`map already exists: ${input.tail}`);
    }
    this.maps.set(input.tail, new Map());
    this.createdMaps.push(input);
    return { tail: input.tail };
  }

  async getStatus(tail: string): Promise<MapLifecycleStatus> {
    this.record("getStatus", [tail]);
    return this.maps.has(tail) ? "active" : "absent";
  }

  async entrySet(tail: string, key: string, value: string): Promise<void> {
    this.record("entrySet", [tail, key, value]);
    const map = this.maps.get(tail);
    if (!map) throw new Error(`map absent: ${tail}`);
    map.set(key, value);
  }

  async entryGet(tail: string, key: string): Promise<string | null> {
    this.record("entryGet", [tail, key]);
    return this.maps.get(tail)?.get(key) ?? null;
  }
}
