import { Connection, PublicKey } from "@solana/web3.js";
import type {
  ReputationAccount,
  ReputationRequirements,
  HistoryPage,
  GetHistoryOptions,
} from "../types.js";
import { VerifTier, PactOutcome } from "../types.js";

const HOLDFAST_PROGRAM_ID = new PublicKey(
  "D6mUa4wGtFyLyJorMfxoKvA9ybohjUSsfw88t66ATxg",
);

// sha256("account:ReputationAccount")[0..8]
const REPUTATION_DISCRIMINATOR = Buffer.from([19, 185, 177, 157, 34, 87, 67, 233]);

// ── On-chain layout (CAS-11 §2.1, schema v1) ───────────────────────────────
// Offsets are byte positions within the 512-byte account data.
//
//  0  [8]  discriminator
//  8  [1]  schema_version: u8
//  9  [32] agent: Pubkey
// 41  [8]  score: u64
// 49  [1]  tier: VerifTier (u8)
// 50  [8]  total_pacts: u64
// 58  [8]  dispute_count: u64
// 66  [8]  created_at: i64
// 74  [8]  last_updated: i64
// 82  [8]  decay_cursor: i64
// 90  [8]  nonce: u64
// 98  [1]  history_len: u8
// 99  [1]  history_head: u8
//100  [360] history: [HistEntry; 20]  (18 bytes × 20)
//460  [51] _padding (reserved)
//511  [1]  bump: u8
//
// HistEntry layout (18 bytes each):
//  0  [1]  outcome: PactOutcome (u8)
//  1  [2]  score_delta: i16 (LE)
//  3  [8]  timestamp: i64 (LE)
// 11  [7]  pact_id: [u8; 7]  — display only, non-unique (see CAS-11 §8.4)
const REPUTATION_ACCOUNT_SCHEMA_VERSION = 1;

const OFF = {
  schemaVersion: 8,
  agent: 9,
  score: 41,
  tier: 49,
  totalPacts: 50,
  disputeCount: 58,
  createdAt: 66,
  lastUpdated: 74,
  decayCursor: 82,
  nonce: 90,
  historyLen: 98,
  historyHead: 99,
  history: 100,
} as const;

const ACCOUNT_SIZE = 512;
const HIST_ENTRY_SIZE = 18;

function deriveReputationPda(agentPubkey: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("reputation"), agentPubkey.toBuffer()],
    HOLDFAST_PROGRAM_ID,
  );
  return pda;
}

function parseHistEntry(
  data: Buffer,
  entryOffset: number,
): { outcome: PactOutcome; scoreDelta: number; timestamp: number; pactId: string } {
  const outcome = data.readUInt8(entryOffset) as PactOutcome;
  const scoreDelta = data.readInt16LE(entryOffset + 1);
  const timestamp = Number(data.readBigInt64LE(entryOffset + 3));
  const pactId = data.subarray(entryOffset + 11, entryOffset + 18).toString("hex");
  return { outcome, scoreDelta, timestamp, pactId };
}

function deserialize(agentPubkey: PublicKey, data: Buffer): ReputationAccount {
  if (data.length !== ACCOUNT_SIZE) {
    throw new ReputationAccountCorruptError(
      `expected ${ACCOUNT_SIZE} bytes, got ${data.length}`,
    );
  }

  const disc = data.subarray(0, 8);
  if (!disc.equals(REPUTATION_DISCRIMINATOR)) {
    throw new ReputationAccountCorruptError("discriminator mismatch");
  }

  const schemaVersion = data.readUInt8(OFF.schemaVersion);
  if (schemaVersion !== REPUTATION_ACCOUNT_SCHEMA_VERSION) {
    throw new ReputationAccountCorruptError(
      `schema_version mismatch: expected ${REPUTATION_ACCOUNT_SCHEMA_VERSION}, got ${schemaVersion}`,
    );
  }

  const score = Number(data.readBigUInt64LE(OFF.score));
  const tier = data.readUInt8(OFF.tier) as VerifTier;
  const totalPacts = Number(data.readBigUInt64LE(OFF.totalPacts));
  const disputeCount = Number(data.readBigUInt64LE(OFF.disputeCount));
  const createdAt = Number(data.readBigInt64LE(OFF.createdAt));
  const lastUpdated = Number(data.readBigInt64LE(OFF.lastUpdated));
  const decayCursor = Number(data.readBigInt64LE(OFF.decayCursor));
  const nonce = Number(data.readBigUInt64LE(OFF.nonce));
  const historyLen = data.readUInt8(OFF.historyLen);
  const historyHead = data.readUInt8(OFF.historyHead);

  // Reorder ring buffer entries from oldest to newest.
  // See CAS-11 §8.3: head points to the next write slot; entries wrap at index 20.
  const history = [];
  for (let i = 0; i < historyLen; i++) {
    const ringIdx = (historyHead - historyLen + i + 20) % 20;
    history.push(parseHistEntry(data, OFF.history + ringIdx * HIST_ENTRY_SIZE));
  }

  return {
    agent: agentPubkey.toBase58(),
    score,
    tier,
    totalPacts,
    disputeCount,
    createdAt,
    lastUpdated,
    decayCursor,
    nonce,
    historyLen,
    historyHead,
    history,
  };
}

export class ReputationModule {
  constructor(
    private readonly connection: Connection,
    private readonly indexerUrl: string,
  ) {}

  /**
   * Fetch the live on-chain ReputationAccount for an agent.
   * Reads directly via RPC — trust-critical path, no oracle round-trip.
   *
   * @throws {ReputationNotFoundError} if the account does not exist yet.
   * @throws {ReputationAccountCorruptError} if account data is malformed.
   */
  async get(agentPubkey: PublicKey | string): Promise<ReputationAccount> {
    const pubkey = toPublicKey(agentPubkey);
    const pda = deriveReputationPda(pubkey);
    const info = await this.connection.getAccountInfo(pda);
    if (info === null) {
      throw new ReputationNotFoundError(pubkey.toBase58());
    }
    return deserialize(pubkey, Buffer.from(info.data));
  }

  /**
   * Pre-flight check: returns true only if the agent's on-chain reputation satisfies
   * all supplied requirements. Mirrors the logic of `validate_reputation_for_pact`.
   *
   * Returns false (not throws) when the agent has no ReputationAccount yet.
   */
  async meetsRequirements(
    agentPubkey: PublicKey | string,
    requirements: ReputationRequirements,
  ): Promise<boolean> {
    const {
      minScore = 0,
      minTier = VerifTier.Unverified,
      minPacts = 0,
    } = requirements;

    let rep: ReputationAccount;
    try {
      rep = await this.get(agentPubkey);
    } catch (err) {
      if (err instanceof ReputationNotFoundError) return false;
      throw err;
    }

    return rep.score >= minScore && rep.tier >= minTier && rep.totalPacts >= minPacts;
  }

  /**
   * Fetch full pact history, falling back to the on-chain ring buffer if the indexer
   * returns a 5xx error or is unreachable (network TypeError).
   *
   * The on-chain fallback returns up to 20 entries from the ReputationAccount ring buffer.
   * 4xx client errors (auth, not-found) are NOT caught — they propagate as-is.
   *
   * @throws {IndexerRequestError} on 4xx responses from the indexer.
   * @throws {ReputationNotFoundError} if the agent has no on-chain account (fallback path).
   */
  async getHistoryWithFallback(
    agentPubkey: PublicKey | string,
    options: GetHistoryOptions = {},
  ): Promise<HistoryPage> {
    try {
      return await this.getHistory(agentPubkey, options);
    } catch (err) {
      const isServerError = err instanceof IndexerRequestError && err.status >= 500;
      const isNetworkError = err instanceof TypeError;
      if (!isServerError && !isNetworkError) throw err;
    }

    // Indexer unavailable — fall back to on-chain ring buffer.
    const rep = await this.get(agentPubkey);
    const limit = Math.min(options.limit ?? 50, rep.history.length);
    const entries = rep.history.slice(rep.history.length - limit);
    return {
      entries,
      total: rep.historyLen,
      hasMore: rep.historyLen > limit,
    };
  }

  /**
   * Fetch full pact history from the off-chain indexer.
   * Dashboard use only — not in the trust path.
   *
   * @throws {IndexerRequestError} on non-2xx HTTP responses.
   */
  async getHistory(
    agentPubkey: PublicKey | string,
    options: GetHistoryOptions = {},
  ): Promise<HistoryPage> {
    const pubkeyStr = typeof agentPubkey === "string"
      ? agentPubkey
      : agentPubkey.toBase58();
    const limit = Math.min(options.limit ?? 50, 200);

    const url = new URL(`/v1/agents/${pubkeyStr}/reputation/history`, this.indexerUrl);
    url.searchParams.set("limit", String(limit));
    if (options.before !== undefined) {
      url.searchParams.set("before", options.before);
    }

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new IndexerRequestError(res.status, await res.text());
    }
    return res.json() as Promise<HistoryPage>;
  }
}

function toPublicKey(key: PublicKey | string): PublicKey {
  return typeof key === "string" ? new PublicKey(key) : key;
}

export class ReputationNotFoundError extends Error {
  constructor(readonly agentPubkey: string) {
    super(
      `ReputationAccount not found for agent ${agentPubkey}. ` +
        `Account is created at first pact sign (see CAS-11 §3.1).`,
    );
    this.name = "ReputationNotFoundError";
  }
}

export class ReputationAccountCorruptError extends Error {
  constructor(detail: string) {
    super(`ReputationAccount data invalid: ${detail}`);
    this.name = "ReputationAccountCorruptError";
  }
}

export class IndexerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Indexer request failed: HTTP ${status}`);
    this.name = "IndexerRequestError";
  }
}
