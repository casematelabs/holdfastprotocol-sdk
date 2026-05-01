// Types mirroring the on-chain ReputationAccount layout defined in CAS-11 §2.1.
// Keep in sync with the Rust structs in programs/holdfast/src/lib.rs once CAS-19 lands.

/** Borsh-encoded as a single u8 variant index. */
export enum VerifTier {
  Unverified = 0,
  Attested = 1,
  /** TEE-attested via Hardline Protocol (cross-CPI tier upgrade — see CAS-11 §6 Q4). */
  Hardline = 2,
}

/** Borsh-encoded as a single u8 variant index. */
export enum PactOutcome {
  Fulfilled = 0,
  Disputed = 1,
  Cancelled = 2,
}

/**
 * One entry in the on-chain ring buffer.
 * 18 bytes on-chain: 1 (outcome) + 2 (score_delta i16) + 8 (timestamp i64) + 7 (pact_id).
 */
export interface HistEntry {
  outcome: PactOutcome;
  /** Signed score delta in basis points applied by this event. */
  scoreDelta: number;
  /** Unix seconds of the event. */
  timestamp: number;
  /**
   * Hex-encoded first 7 bytes of the pact pubkey.
   * Display-only — not a unique identifier. Collisions are possible.
   */
  pactId: string;
}

/**
 * Decoded view of the on-chain ReputationAccount PDA.
 * Account size: exactly 512 bytes (compile-time asserted in Rust — see CAS-11 §8.5).
 * PDA seeds: ["reputation", agentPubkey]
 */
export interface ReputationAccount {
  /** Base58-encoded agent pubkey this account belongs to. */
  agent: string;
  /**
   * Current reputation score in basis points: [0, 10000].
   * 5000 = neutral. Time-decay pulls toward 5000 lazily on each write.
   */
  score: number;
  tier: VerifTier;
  totalPacts: number;
  disputeCount: number;
  /** Unix seconds of account creation. */
  createdAt: number;
  /** Unix seconds of last score mutation. */
  lastUpdated: number;
  /** Unix seconds of last decay application (decay is lazily applied on writes). */
  decayCursor: number;
  /** Monotonic anti-replay nonce. Incremented on every authorized write. */
  nonce: number;
  /** Number of valid entries currently in the history ring buffer (max 20). */
  historyLen: number;
  /** Write pointer: index where the next entry will be written. */
  historyHead: number;
  /**
   * Up to 20 most-recent history entries, ordered oldest → newest.
   * The SDK reorders from the raw ring buffer on read.
   */
  history: HistEntry[];
}

/** Requirements passed to `meetsRequirements` — mirrors `validate_reputation_for_pact`. */
export interface ReputationRequirements {
  /** Minimum score in basis points [0, 10000]. Default: 0 (no requirement). */
  minScore?: number;
  /** Minimum verification tier. Default: Unverified (no requirement). */
  minTier?: VerifTier;
  /** Minimum lifetime completed pacts. Default: 0 (no requirement). */
  minPacts?: number;
}

/** Paginated history page returned by the off-chain indexer. */
export interface HistoryPage {
  entries: HistEntry[];
  total: number;
  hasMore: boolean;
  /** Opaque cursor — pass as `before` to fetch the next page. Absent on last page. */
  cursor?: string;
}

export interface GetHistoryOptions {
  /** Number of entries to return. Default: 50. Max: 200. */
  limit?: number;
  /** Pagination cursor from a previous `HistoryPage`. */
  before?: string;
}

// ── Escrow Types ──────────────────────────────────────────────────────

/** Borsh-encoded as a single u8 variant index. Mirrors EscrowStatus in the escrow program. */
export enum EscrowStatus {
  Pending = 0,
  Funded = 1,
  Locked = 2,
  Released = 3,
  Disputed = 4,
  Refunded = 5,
  Closed = 6,
  Claimed = 7,
  MutuallyCancelled = 8,
}

/**
 * Funds release only on explicit mutual agreement — no time-based auto-trigger.
 * Sets `auto_release_on_expiry = false` on-chain.
 */
export interface TaskRelease {
  kind: "task";
  /** Unix seconds: escrow time-lock horizon. Must be in the future at creation time. */
  timeLockExpiresAt: number;
}

/**
 * Funds release after arbiter verifies milestone deliverables.
 * Sets `auto_release_on_expiry = false` on-chain.
 */
export interface MilestoneRelease {
  kind: "milestone";
  /** Unix seconds: escrow time-lock horizon. Must be in the future at creation time. */
  timeLockExpiresAt: number;
}

/**
 * Funds auto-release to beneficiary when `timeLockExpiresAt` is reached.
 * Sets `auto_release_on_expiry = true` on-chain.
 *
 * NOTE: Auto-release is triggered by the `auto_release` on-chain instruction,
 * which must be cranked by a keeper or the beneficiary after expiry.
 * The SDK does not invoke the crank automatically.
 */
export interface TimedRelease {
  kind: "timed";
  /** Unix seconds: auto-release fires at or after this time. Must be in the future at creation time. */
  timeLockExpiresAt: number;
}

export type ReleaseCondition = TaskRelease | MilestoneRelease | TimedRelease;

/**
 * SDK-decoded view of the on-chain EscrowAccount PDA.
 * PDA seeds: ["escrow", escrow_id]
 * Account size: 8 (discriminator) + 400 (fields with headroom)
 */
export interface EscrowAccount {
  /** Base58-encoded EscrowAccount PDA address. */
  address: string;
  /** On-chain schema version (currently 1). Used for versioned deserialization. */
  schemaVersion: number;
  /** Hex-encoded 32-byte escrow ID (PDA seed). */
  escrowId: string;
  /** Base58-encoded initiator pubkey. */
  initiator: string;
  /** Base58-encoded beneficiary pubkey. */
  beneficiary: string;
  /** Base58-encoded arbiter pubkey. All-zeros (11111…) means no arbiter. */
  arbiter: string;
  /** Base58-encoded SPL mint pubkey. */
  mint: string;
  /** Base58-encoded vault token account pubkey. */
  vault: string;
  /** Escrow amount in token base units. */
  escrowAmount: bigint;
  /** Initiator stake in token base units. Slashed on losing side if arbiter resolves. */
  initiatorStake: bigint;
  /** Beneficiary stake in token base units. */
  beneficiaryStake: bigint;
  status: EscrowStatus;
  /**
   * Unix seconds: escrow is time-locked until this timestamp.
   * For TimedRelease, auto-release fires at or after this time.
   */
  timeLockExpiresAt: number;
  /**
   * Unix seconds: dispute window closes at this time. 0 until release.
   * Dispute window is a fixed 7-day grace period after the initiator calls releasePact.
   */
  disputeWindowEndsAt: number;
  /** Base58-encoded PactRecord PDA (contains deliverables and pact metadata). */
  pactRecord: string;
  /** Unix seconds of escrow creation. */
  createdAt: number;
  /** Unix seconds when locked. 0 if not yet locked. */
  lockedAt: number;
  /** Unix seconds when released. 0 if not yet released. */
  releasedAt: number;
  /** Unix seconds when dispute was resolved. 0 if not yet resolved. */
  resolvedAt: number;
  /** True once the beneficiary has deposited their stake. */
  beneficiaryStaked: boolean;
  /** Unix seconds when the escrow was mutually cancelled. 0 if not cancelled. */
  cancelledAt: number;
}

/** Paginated pact list returned by the off-chain indexer. */
export interface PactPage {
  pacts: EscrowAccount[];
  hasMore: boolean;
  /** Opaque cursor — pass as `before` to fetch the next page. Absent on last page. */
  cursor?: string;
}

export interface ListPactsOptions {
  /** Filter by escrow status. Omit to return all statuses. */
  status?: EscrowStatus;
  /** Number of pacts to return. Default: 20. Max: 100. */
  limit?: number;
  /** Pagination cursor from a previous `PactPage`. */
  before?: string;
}

/** One escrow lifecycle event from the indexer. */
export interface EscrowEventEntry {
  kind: string;
  slot: number;
  signature: string;
  timestamp: number;
  /** Gross claim amount at claim-time (beneficiary + protocol fee). */
  grossAmount?: string;
  /** Protocol fee amount charged at claim-time. */
  protocolFeeAmount?: string;
  /** Beneficiary net amount paid at claim-time. */
  beneficiaryNetAmount?: string;
}

export interface EscrowEventPage {
  events: EscrowEventEntry[];
  total: number;
  hasMore: boolean;
  cursor?: string;
}

export interface GetEscrowEventsOptions {
  /** Number of events to return. Default: 50. Max: 200. */
  limit?: number;
  /** Pagination cursor from a previous `EscrowEventPage`. */
  before?: string;
}
