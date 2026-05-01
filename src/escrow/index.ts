import { createHash } from "crypto";
import {
  Connection,
  PublicKey,
  Signer,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { sendAndConfirmWithRetry } from "../resilience.js";
import type {
  EscrowAccount,
  EscrowStatus,
  EscrowEventPage,
  GetEscrowEventsOptions,
  ListPactsOptions,
  PactPage,
  ReleaseCondition,
} from "../types.js";
import { VerifTier } from "../types.js";
import type { ReputationModule } from "../reputation/index.js";
import { IndexerRequestError } from "../reputation/index.js";

// ── Program IDs ───────────────────────────────────────────────────────
const DEVNET_ESCROW_PROGRAM_ID = new PublicKey(
  "CAZMkHiExVjbsSwAVBYVhz1yaHmnBSvzUYGaQrrRp6yi",
);
const DEVNET_HOLDFAST_PROGRAM_ID = new PublicKey(
  "2chF47DbqehX3L38874e2RznaSs46vpcMPEPRYz4Dywq",
);
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const DEFAULT_PUBKEY = new PublicKey(new Uint8Array(32));

// ── Anchor discriminators ─────────────────────────────────────────────
// Discriminator = sha256("global:<instruction_name>")[0..8]
// Account discriminator = sha256("account:<AccountName>")[0..8]

function disc(name: string): Buffer {
  return Buffer.from(
    createHash("sha256").update(`global:${name}`).digest(),
  ).subarray(0, 8);
}

function accountDisc(name: string): Buffer {
  return Buffer.from(
    createHash("sha256").update(`account:${name}`).digest(),
  ).subarray(0, 8);
}

// Precomputed at module init to avoid per-call crypto overhead.
const DISC_INITIALIZE_ESCROW = disc("initialize_escrow");
const DISC_DEPOSIT_FUNDS = disc("deposit_funds");
const DISC_RELEASE_ESCROW = disc("release_escrow");
const DISC_RAISE_DISPUTE = disc("raise_dispute");
const DISC_STAKE_BENEFICIARY = disc("stake_beneficiary");
const DISC_LOCK_ESCROW = disc("lock_escrow");
const DISC_CLAIM_RELEASED = disc("claim_released");
const DISC_MUTUAL_CANCEL_ESCROW = disc("mutual_cancel_escrow");
const DISC_CANCEL_PENDING_ESCROW = disc("cancel_pending_escrow");
const DISC_CLOSE_ESCROW = disc("close_escrow");
const DISC_ESCROW_ACCOUNT = accountDisc("EscrowAccount");

// ── PDA derivation ────────────────────────────────────────────────────

function deriveEscrowPda(escrowId: Uint8Array, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), Buffer.from(escrowId)],
    programId,
  );
  return pda;
}

function derivePactPda(escrowId: Uint8Array, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pact"), Buffer.from(escrowId)],
    programId,
  );
  return pda;
}

function deriveDisputePda(escrowId: Uint8Array, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("dispute"), Buffer.from(escrowId)],
    programId,
  );
  return pda;
}

function deriveReputationPda(
  agentPubkey: PublicKey,
  holdfastProgramId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("reputation"), agentPubkey.toBuffer()],
    holdfastProgramId,
  );
  return pda;
}

// ATA derivation: seeds = [owner, TOKEN_PROGRAM_ID, mint], program = ASSOCIATED_TOKEN_PROGRAM_ID
function deriveAta(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

// ── Borsh writer ──────────────────────────────────────────────────────

class BorshWriter {
  private chunks: Buffer[] = [];

  u8(v: number): this {
    const b = Buffer.allocUnsafe(1);
    b.writeUInt8(v);
    this.chunks.push(b);
    return this;
  }

  u64(v: bigint): this {
    const b = Buffer.allocUnsafe(8);
    b.writeBigUInt64LE(v);
    this.chunks.push(b);
    return this;
  }

  i64(v: bigint): this {
    const b = Buffer.allocUnsafe(8);
    b.writeBigInt64LE(v);
    this.chunks.push(b);
    return this;
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  // Copy up to `len` bytes from `bytes`; zero-pad if shorter, truncate if longer.
  fixedBytes(bytes: Uint8Array, len: number): this {
    const b = Buffer.alloc(len);
    Buffer.from(bytes).copy(b, 0, 0, Math.min(bytes.length, len));
    this.chunks.push(b);
    return this;
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

// ── Account deserialization ───────────────────────────────────────────
// EscrowAccount on-chain layout (after 8-byte discriminator):
//  [0]       schema_version: u8
//  [1]       bump: u8
//  [2..34]   escrow_id: [u8; 32]
//  [34..66]  initiator: Pubkey
//  [66..98]  beneficiary: Pubkey
//  [98..130] arbiter: Pubkey
//  [130..162] mint: Pubkey
//  [162..194] vault: Pubkey
//  [194..202] escrow_amount: u64 LE
//  [202..210] initiator_stake: u64 LE
//  [210..218] beneficiary_stake: u64 LE
//  [218]     status: u8
//  [219..227] time_lock_expires_at: i64 LE
//  [227..235] dispute_window_ends_at: i64 LE
//  [235..267] pact_record: Pubkey
//  [267..275] created_at: i64 LE
//  [275..283] locked_at: i64 LE
//  [283..291] released_at: i64 LE
//  [291..299] resolved_at: i64 LE
//  [299]     beneficiary_staked: bool
//  [300..308] cancelled_at: i64 LE

const ESCROW_SCHEMA_VERSION = 1;

function deserializeEscrowAccount(pda: PublicKey, data: Buffer): EscrowAccount {
  const MIN_SIZE = 8 + 308; // 8 disc + fields through cancelled_at
  if (data.length < MIN_SIZE) {
    throw new EscrowAccountCorruptError(
      `expected at least ${MIN_SIZE} bytes, got ${data.length}`,
    );
  }
  if (!data.subarray(0, 8).equals(DISC_ESCROW_ACCOUNT)) {
    throw new EscrowAccountCorruptError("discriminator mismatch");
  }

  let o = 8;
  const schemaVersion = data.readUInt8(o); o += 1;
  if (schemaVersion !== ESCROW_SCHEMA_VERSION) {
    throw new EscrowAccountCorruptError(
      `unsupported schema_version ${schemaVersion} (expected ${ESCROW_SCHEMA_VERSION})`,
    );
  }
  o += 1; // bump — not exposed in SDK interface
  const escrowId = data.subarray(o, o + 32); o += 32;
  const initiator = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const beneficiary = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const arbiter = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const mint = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const vault = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const escrowAmount = data.readBigUInt64LE(o); o += 8;
  const initiatorStake = data.readBigUInt64LE(o); o += 8;
  const beneficiaryStake = data.readBigUInt64LE(o); o += 8;
  const status = data.readUInt8(o) as EscrowStatus; o += 1;
  const timeLockExpiresAt = Number(data.readBigInt64LE(o)); o += 8;
  const disputeWindowEndsAt = Number(data.readBigInt64LE(o)); o += 8;
  const pactRecord = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const createdAt = Number(data.readBigInt64LE(o)); o += 8;
  const lockedAt = Number(data.readBigInt64LE(o)); o += 8;
  const releasedAt = Number(data.readBigInt64LE(o)); o += 8;
  const resolvedAt = Number(data.readBigInt64LE(o)); o += 8;
  const beneficiaryStaked = data.readUInt8(o) !== 0; o += 1;
  const cancelledAt = Number(data.readBigInt64LE(o));

  return {
    address: pda.toBase58(),
    schemaVersion,
    escrowId: Buffer.from(escrowId).toString("hex"),
    initiator: initiator.toBase58(),
    beneficiary: beneficiary.toBase58(),
    arbiter: arbiter.toBase58(),
    mint: mint.toBase58(),
    vault: vault.toBase58(),
    escrowAmount,
    initiatorStake,
    beneficiaryStake,
    status,
    timeLockExpiresAt,
    disputeWindowEndsAt,
    pactRecord: pactRecord.toBase58(),
    createdAt,
    lockedAt,
    releasedAt,
    resolvedAt,
    beneficiaryStaked,
    cancelledAt,
  };
}

// ── CreatePactParams ──────────────────────────────────────────────────

export interface CreatePactParams {
  /** Counterparty (beneficiary) pubkey. */
  counterparty: PublicKey;
  /**
   * Counterparty's AgentWallet PDA address.
   * PDA seeds: ["agent_wallet", pubkey_x, pubkey_y] (holdfast program).
   * Obtained after the counterparty calls `register_agent_wallet`.
   */
  counterpartyWallet: PublicKey;
  /**
   * SPL token mint for escrow funds.
   * Use the wrapped SOL mint (So111…1112) for native SOL escrows.
   */
  mint: PublicKey;
  /** Escrow amount in token base units (lamports for wrapped SOL). */
  amount: bigint;
  /** Release trigger type. Determines `auto_release_on_expiry` and time-lock behavior on-chain. */
  releaseCondition: ReleaseCondition;
  /** Arbiter pubkey. Optional — omit for arbiter-free pacts. */
  arbiter?: PublicKey;
  /** Stake amounts. Both default to 0 (no stake). Slashed on the losing side if an arbiter resolves the dispute. */
  stakes?: {
    initiator?: bigint;
    beneficiary?: bigint;
  };
  /**
   * SHA-256 hash of the deliverables specification. Optional.
   * Exactly 32 bytes — omit or zero-fill if no hash.
   */
  deliverablesHash?: Uint8Array;
  /**
   * URI pointing to the deliverables spec (IPFS, Arweave, etc.). Optional.
   * Encoded as UTF-8 and truncated to 128 bytes on-chain.
   */
  deliverablesUri?: string;
  /**
   * Arbiter's AgentWallet PDA address. Required when `arbiter` is provided.
   * PDA seeds: ["agent_wallet", pubkey_x, pubkey_y] (holdfast program).
   */
  arbiterWallet?: PublicKey;
  /**
   * Optional reputation pre-flight threshold.
   * When set, `createPact` calls `reputation.meetsRequirements` for the initiator
   * before building the transaction. The same constraint is enforced on-chain via
   * CPI to `validate_reputation_for_pact`.
   *
   * @throws {ReputationThresholdNotMet} if the pre-flight check fails.
   */
  reputationThreshold?: {
    minScore?: number;
    minTier?: VerifTier;
    minPacts?: number;
  };
  /**
   * Arbiter resolution deadline in seconds after a dispute is raised.
   * Default: 604800 (7 days). Maps to `dispute_deadline_secs` on-chain.
   */
  disputeDeadlineSecs?: number;
  /** Slash the losing party's stake when an arbiter resolves the dispute. Default: false. */
  slashLoserStake?: boolean;
  /**
   * Optional deterministic escrow ID (32 bytes). Provide for idempotent retry — the
   * same ID will derive the same PDA. If omitted, generated from
   * sha256(initiator ‖ counterparty ‖ Date.now()).
   */
  escrowId?: Uint8Array;
}

// ── EscrowModule ──────────────────────────────────────────────────────

export class EscrowModule {
  private readonly programId: PublicKey;
  private readonly holdfastProgramId: PublicKey;

  constructor(
    private readonly connection: Connection,
    private readonly indexerUrl: string,
    private readonly reputation: ReputationModule,
    private readonly signer?: Signer,
    private readonly agentWallet?: PublicKey,
    programId?: PublicKey,
    holdfastProgramId?: PublicKey,
  ) {
    this.programId = programId ?? DEVNET_ESCROW_PROGRAM_ID;
    this.holdfastProgramId = holdfastProgramId ?? DEVNET_HOLDFAST_PROGRAM_ID;
  }

  /**
   * Create a new pact between the signing agent (initiator) and a counterparty.
   * Calls `initialize_escrow` on the holdfast-escrow program, which also initializes
   * the EscrowAccount, PactRecord, and vault ATAs in a single transaction.
   *
   * When `reputationThreshold` is set, performs a local pre-flight via
   * `reputation.meetsRequirements` before submitting. The same check runs on-chain
   * via CPI to `validate_reputation_for_pact` — the pre-flight is advisory only.
   *
   * @throws {EscrowSignerRequiredError} if no signer was configured on the client.
   * @throws {EscrowAgentWalletRequiredError} if no agentWallet was configured on the client.
   * @throws {ReputationThresholdNotMet} if the pre-flight reputation check fails.
   */
  async createPact(params: CreatePactParams): Promise<EscrowAccount> {
    const signer = this.requireSigner();
    const agentWallet = this.requireAgentWallet();

    if (params.reputationThreshold) {
      const { minScore, minTier, minPacts } = params.reputationThreshold;
      const requirements = {
        ...(minScore !== undefined && { minScore }),
        ...(minTier !== undefined && { minTier }),
        ...(minPacts !== undefined && { minPacts }),
      };
      const ok = await this.reputation.meetsRequirements(signer.publicKey, requirements);
      if (!ok) {
        throw new ReputationThresholdNotMet(
          signer.publicKey.toBase58(),
          minScore,
          minTier,
        );
      }
    }

    const escrowId = params.escrowId
      ? Buffer.from(params.escrowId)
      : Buffer.from(
          createHash("sha256")
            .update(signer.publicKey.toBuffer())
            .update(params.counterparty.toBuffer())
            .update(Buffer.from(String(Date.now())))
            .digest(),
        );

    const escrowPda = deriveEscrowPda(escrowId, this.programId);
    const pactPda = derivePactPda(escrowId, this.programId);
    const initiatorReputationPda = deriveReputationPda(
      signer.publicKey,
      this.holdfastProgramId,
    );
    const vault = deriveAta(escrowPda, params.mint);

    const arbiter = params.arbiter ?? DEFAULT_PUBKEY;
    const initiatorStake = params.stakes?.initiator ?? 0n;
    const beneficiaryStake = params.stakes?.beneficiary ?? 0n;
    const autoReleaseOnExpiry = params.releaseCondition.kind === "timed";
    const slashLoserStake = params.slashLoserStake ?? false;
    const disputeDeadlineSecs = BigInt(params.disputeDeadlineSecs ?? 7 * 24 * 3600);
    const timeLockExpiresAt = BigInt(params.releaseCondition.timeLockExpiresAt);
    const deliverablesHash = params.deliverablesHash ?? new Uint8Array(32);
    const deliverablesUri = params.deliverablesUri
      ? Buffer.from(params.deliverablesUri, "utf8")
      : new Uint8Array(128);
    const initiatorReputationMin = BigInt(params.reputationThreshold?.minScore ?? 0);
    const initiatorMinTier = params.reputationThreshold?.minTier ?? VerifTier.Unverified;
    const initiatorMinPacts = BigInt(params.reputationThreshold?.minPacts ?? 0);

    if (params.arbiter && !params.arbiterWallet) {
      throw new EscrowArbiterWalletRequiredError();
    }
    const arbiterWallet = params.arbiterWallet ?? agentWallet;

    const initLayouts = [
      {
        data: this.buildInitializeEscrowData({
          escrowId,
          beneficiary: params.counterparty,
          arbiter,
          amount: params.amount,
          initiatorStake,
          beneficiaryStake,
          timeLockExpiresAt,
          deliverablesHash,
          deliverablesUri,
          autoReleaseOnExpiry,
          slashLoserStake,
          disputeDeadlineSecs,
          initiatorReputationMin,
          initiatorMinTier,
          initiatorMinPacts,
          includeBeneficiaryMin: true,
          includeBeneficiaryTierAndPacts: true,
        }),
        keys: this.buildInitializeEscrowKeys({
          signer: signer.publicKey,
          escrowPda,
          pactPda,
          mint: params.mint,
          vault,
          initiatorReputationPda,
          initiatorWallet: agentWallet,
          beneficiaryWallet: params.counterpartyWallet,
          arbiterWallet,
          includePactRecord: true,
        }),
      },
      {
        data: this.buildInitializeEscrowData({
          escrowId,
          beneficiary: params.counterparty,
          arbiter,
          amount: params.amount,
          initiatorStake,
          beneficiaryStake,
          timeLockExpiresAt,
          deliverablesHash,
          deliverablesUri,
          autoReleaseOnExpiry,
          slashLoserStake,
          disputeDeadlineSecs,
          initiatorReputationMin,
          initiatorMinTier,
          initiatorMinPacts,
          includeBeneficiaryMin: true,
          includeBeneficiaryTierAndPacts: false,
        }),
        keys: this.buildInitializeEscrowKeys({
          signer: signer.publicKey,
          escrowPda,
          pactPda,
          mint: params.mint,
          vault,
          initiatorReputationPda,
          initiatorWallet: agentWallet,
          beneficiaryWallet: params.counterpartyWallet,
          arbiterWallet,
          includePactRecord: true,
        }),
      },
      {
        data: this.buildInitializeEscrowData({
          escrowId,
          beneficiary: params.counterparty,
          arbiter,
          amount: params.amount,
          initiatorStake,
          beneficiaryStake,
          timeLockExpiresAt,
          deliverablesHash,
          deliverablesUri,
          autoReleaseOnExpiry,
          slashLoserStake,
          disputeDeadlineSecs,
          initiatorReputationMin,
          initiatorMinTier,
          initiatorMinPacts,
          includeBeneficiaryMin: false,
          includeBeneficiaryTierAndPacts: false,
        }),
        keys: this.buildInitializeEscrowKeys({
          signer: signer.publicKey,
          escrowPda,
          pactPda,
          mint: params.mint,
          vault,
          initiatorReputationPda,
          initiatorWallet: agentWallet,
          beneficiaryWallet: params.counterpartyWallet,
          arbiterWallet,
          includePactRecord: true,
        }),
      },
      {
        data: this.buildInitializeEscrowData({
          escrowId,
          beneficiary: params.counterparty,
          arbiter,
          amount: params.amount,
          initiatorStake,
          beneficiaryStake,
          timeLockExpiresAt,
          deliverablesHash,
          deliverablesUri,
          autoReleaseOnExpiry,
          slashLoserStake,
          disputeDeadlineSecs,
          initiatorReputationMin,
          initiatorMinTier,
          initiatorMinPacts,
          includeBeneficiaryMin: false,
          includeBeneficiaryTierAndPacts: false,
        }),
        keys: this.buildInitializeEscrowKeys({
          signer: signer.publicKey,
          escrowPda,
          pactPda,
          mint: params.mint,
          vault,
          initiatorReputationPda,
          initiatorWallet: agentWallet,
          beneficiaryWallet: params.counterpartyWallet,
          arbiterWallet,
          includePactRecord: false,
        }),
      },
    ];

    let sent = false;
    let lastErr: unknown = undefined;
    for (const [i, layout] of initLayouts.entries()) {
      const ix = new TransactionInstruction({
        programId: this.programId,
        data: layout.data,
        keys: layout.keys,
      });
      const tx = new Transaction().add(ix);
      tx.feePayer = signer.publicKey;
      try {
        await sendAndConfirmWithRetry(this.connection, tx, [signer]);
        sent = true;
        break;
      } catch (err) {
        lastErr = err;
        if (i === initLayouts.length - 1 || !isInitializeEscrowCompatibilityError(err)) {
          throw err;
        }
      }
    }
    if (!sent && lastErr) throw lastErr;

    const info = await this.connection.getAccountInfo(escrowPda);
    if (info === null) throw new EscrowNotFoundError(escrowPda.toBase58());
    return deserializeEscrowAccount(escrowPda, Buffer.from(info.data));
  }

  private buildInitializeEscrowData(args: {
    escrowId: Uint8Array;
    beneficiary: PublicKey;
    arbiter: PublicKey;
    amount: bigint;
    initiatorStake: bigint;
    beneficiaryStake: bigint;
    timeLockExpiresAt: bigint;
    deliverablesHash: Uint8Array;
    deliverablesUri: Uint8Array;
    autoReleaseOnExpiry: boolean;
    slashLoserStake: boolean;
    disputeDeadlineSecs: bigint;
    initiatorReputationMin: bigint;
    initiatorMinTier: number;
    initiatorMinPacts: bigint;
    includeBeneficiaryMin: boolean;
    includeBeneficiaryTierAndPacts: boolean;
  }): Buffer {
    const writer = new BorshWriter()
      .fixedBytes(DISC_INITIALIZE_ESCROW, 8)
      .fixedBytes(args.escrowId, 32)
      .fixedBytes(args.beneficiary.toBuffer(), 32)
      .fixedBytes(args.arbiter.toBuffer(), 32)
      .u64(args.amount)
      .u64(args.initiatorStake)
      .u64(args.beneficiaryStake)
      .i64(args.timeLockExpiresAt)
      .fixedBytes(args.deliverablesHash, 32)
      .fixedBytes(args.deliverablesUri, 128)
      .bool(args.autoReleaseOnExpiry)
      .bool(args.slashLoserStake)
      .i64(args.disputeDeadlineSecs)
      .u64(args.initiatorReputationMin);

    if (args.includeBeneficiaryMin) {
      writer.u64(0n); // beneficiary_reputation_min not exposed in SDK API.
    }
    writer.u8(args.initiatorMinTier).u64(args.initiatorMinPacts);
    if (args.includeBeneficiaryTierAndPacts) {
      writer.u8(0).u64(0n); // beneficiary_min_tier / beneficiary_min_pacts
    }
    return writer.build();
  }

  private buildInitializeEscrowKeys(args: {
    signer: PublicKey;
    escrowPda: PublicKey;
    pactPda: PublicKey;
    mint: PublicKey;
    vault: PublicKey;
    initiatorReputationPda: PublicKey;
    initiatorWallet: PublicKey;
    beneficiaryWallet: PublicKey;
    arbiterWallet: PublicKey;
    includePactRecord: boolean;
  }): Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> {
    const keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
      { pubkey: args.signer, isSigner: true, isWritable: true },
      { pubkey: args.escrowPda, isSigner: false, isWritable: true },
    ];
    if (args.includePactRecord) {
      keys.push({ pubkey: args.pactPda, isSigner: false, isWritable: true });
    }
    keys.push(
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: args.initiatorReputationPda, isSigner: false, isWritable: false },
      { pubkey: args.initiatorWallet, isSigner: false, isWritable: false },
      { pubkey: args.beneficiaryWallet, isSigner: false, isWritable: false },
      { pubkey: args.arbiterWallet, isSigner: false, isWritable: false },
      { pubkey: this.holdfastProgramId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    );
    return keys;
  }

  /**
   * Deposit escrow funds into the vault (calls `deposit_funds`).
   * Transfers `escrow_amount + initiator_stake` tokens from the initiator's ATA
   * to the vault. The transfer amount is determined by the on-chain escrow account.
   *
   * The escrow must be in `Pending` status; status advances to `Funded` on success.
   *
   * @param escrowId - The 32-byte escrow ID encoded as a PublicKey.
   * @throws {EscrowSignerRequiredError} if no signer was configured on the client.
   * @throws {EscrowNotFoundError} if no escrow exists for this ID.
   */
  async depositEscrow(escrowId: PublicKey): Promise<string> {
    const signer = this.requireSigner();

    const escrowPda = deriveEscrowPda(escrowId.toBuffer(), this.programId);
    const info = await this.connection.getAccountInfo(escrowPda);
    if (info === null) throw new EscrowNotFoundError(escrowPda.toBase58());
    const escrow = deserializeEscrowAccount(escrowPda, Buffer.from(info.data));

    const mint = new PublicKey(escrow.mint);
    const vault = new PublicKey(escrow.vault);
    const initiatorAta = deriveAta(signer.publicKey, mint);

    const ix = new TransactionInstruction({
      programId: this.programId,
      data: Buffer.from(DISC_DEPOSIT_FUNDS),
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: initiatorAta, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = signer.publicKey;
    return sendAndConfirmWithRetry(this.connection, tx, [signer]);
  }

  /**
   * Stake the beneficiary's collateral into the vault (calls `stake_beneficiary`).
   * Must be called by the beneficiary after `deposit_funds` (escrow in `Funded` status)
   * and before `lock_escrow`. Required in every pact flow — even when `beneficiary_stake`
   * is 0, this call sets the `beneficiary_staked` flag that `lock_escrow` requires.
   *
   * If `beneficiary_stake > 0`, the on-chain instruction transfers that amount from the
   * beneficiary's token account to the vault. A reputation CPI validates the beneficiary
   * against the pact record's minimum thresholds before any transfer occurs.
   *
   * @param escrowId - The 32-byte escrow ID encoded as a PublicKey.
   * @returns Transaction signature.
   * @throws {EscrowSignerRequiredError} if no signer was configured on the client.
   * @throws {EscrowAgentWalletRequiredError} if no agentWallet was configured on the client.
   * @throws {EscrowNotFoundError} if no escrow exists for this ID.
   */
  async stakeBeneficiary(escrowId: PublicKey): Promise<string> {
    const signer = this.requireSigner();
    const agentWallet = this.requireAgentWallet();

    const escrowIdBytes = escrowId.toBuffer();
    const escrowPda = deriveEscrowPda(escrowIdBytes, this.programId);

    const info = await this.connection.getAccountInfo(escrowPda);
    if (info === null) throw new EscrowNotFoundError(escrowPda.toBase58());
    const escrow = deserializeEscrowAccount(escrowPda, Buffer.from(info.data));

    const mint = new PublicKey(escrow.mint);
    const vault = new PublicKey(escrow.vault);
    const pactPda = derivePactPda(escrowIdBytes, this.programId);
    const beneficiaryAta = deriveAta(signer.publicKey, mint);
    const beneficiaryReputationPda = deriveReputationPda(
      signer.publicKey,
      this.holdfastProgramId,
    );

    const ix = new TransactionInstruction({
      programId: this.programId,
      data: Buffer.from(DISC_STAKE_BENEFICIARY),
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: pactPda, isSigner: false, isWritable: false },
        { pubkey: beneficiaryAta, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: beneficiaryReputationPda, isSigner: false, isWritable: false },
        { pubkey: agentWallet, isSigner: false, isWritable: false },
        { pubkey: this.holdfastProgramId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = signer.publicKey;
    return sendAndConfirmWithRetry(this.connection, tx, [signer]);
  }

  /**
   * Build the `lock_escrow` transaction without signing it.
   * Use this for async multi-agent flows where initiator and beneficiary sign
   * in separate processes — exchange the serialised transaction off-band, then
   * each party signs and one submits.
   *
   * The initiator pubkey and reputation PDA are read from the on-chain escrow account,
   * so the caller only needs to supply the wallet PDAs.
   *
   * @param escrowId - The 32-byte escrow ID encoded as a PublicKey.
   * @param beneficiaryWallet - Beneficiary's AgentWallet PDA (holdfast program).
   * @param arbiterWallet - Arbiter's AgentWallet PDA. Defaults to initiator's agentWallet when no arbiter.
   * @returns Unsigned Transaction — caller must set `feePayer`, sign with both parties, and submit.
   * @throws {EscrowAgentWalletRequiredError} if no agentWallet was configured on the client.
   * @throws {EscrowNotFoundError} if no escrow exists for this ID.
   */
  async buildLockEscrowTransaction(
    escrowId: PublicKey,
    beneficiaryWallet: PublicKey,
    arbiterWallet?: PublicKey,
  ): Promise<Transaction> {
    const agentWallet = this.requireAgentWallet();

    const escrowIdBytes = escrowId.toBuffer();
    const escrowPda = deriveEscrowPda(escrowIdBytes, this.programId);
    const pactPda = derivePactPda(escrowIdBytes, this.programId);

    const info = await this.connection.getAccountInfo(escrowPda);
    if (info === null) throw new EscrowNotFoundError(escrowPda.toBase58());
    const escrow = deserializeEscrowAccount(escrowPda, Buffer.from(info.data));

    const initiatorPubkey = new PublicKey(escrow.initiator);
    const beneficiaryPubkey = new PublicKey(escrow.beneficiary);
    const arbiterPubkey = new PublicKey(escrow.arbiter);
    const vault = new PublicKey(escrow.vault);
    const resolvedArbiterWallet = arbiterPubkey.equals(DEFAULT_PUBKEY)
      ? (arbiterWallet ?? agentWallet)
      : (arbiterWallet ?? null);
    if (resolvedArbiterWallet === null) {
      throw new EscrowLockArbiterWalletRequiredError(arbiterPubkey.toBase58());
    }
    const initiatorReputationPda = deriveReputationPda(initiatorPubkey, this.holdfastProgramId);
    const beneficiaryReputationPda = deriveReputationPda(beneficiaryPubkey, this.holdfastProgramId);

    const ix = new TransactionInstruction({
      programId: this.programId,
      data: Buffer.from(DISC_LOCK_ESCROW),
      keys: [
        { pubkey: initiatorPubkey, isSigner: true, isWritable: false },
        { pubkey: beneficiaryPubkey, isSigner: true, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: pactPda, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: false },
        { pubkey: agentWallet, isSigner: false, isWritable: false },
        { pubkey: beneficiaryWallet, isSigner: false, isWritable: false },
        { pubkey: resolvedArbiterWallet, isSigner: false, isWritable: false },
        { pubkey: initiatorReputationPda, isSigner: false, isWritable: false },
        { pubkey: beneficiaryReputationPda, isSigner: false, isWritable: false },
        { pubkey: this.holdfastProgramId, isSigner: false, isWritable: false },
      ],
    });

    return new Transaction().add(ix);
  }

  /**
   * Lock a funded escrow (calls `lock_escrow`).
   * Advances status from `Funded` → `Locked`, signalling that work has begun.
   * Both the initiator (this client's configured signer) and the beneficiary must co-sign.
   *
   * For async flows where signers run in separate processes, use `buildLockEscrowTransaction`
   * to obtain an unsigned transaction that each party can sign independently before submission.
   *
   * Preconditions (enforced on-chain):
   * - Escrow must be in `Funded` status.
   * - `beneficiary_staked` must be `true` — call `stakeBeneficiary` first.
   * - Both parties' AgentWallets must be Active (status == 0).
   * - Vault balance must equal `escrow_amount + initiator_stake + beneficiary_stake`.
   * - `timeLockExpiresAt` must be in the future.
   *
   * @param escrowId - The 32-byte escrow ID encoded as a PublicKey.
   * @param beneficiarySigner - Signer for the beneficiary (second required co-signer).
   * @param beneficiaryWallet - Beneficiary's AgentWallet PDA (holdfast program).
   * @param arbiterWallet - Arbiter's AgentWallet PDA. Defaults to initiator's agentWallet when no arbiter.
   * @returns Transaction signature.
   * @throws {EscrowSignerRequiredError} if no signer was configured on the client.
   * @throws {EscrowAgentWalletRequiredError} if no agentWallet was configured on the client.
   * @throws {EscrowNotFoundError} if no escrow exists for this ID.
   */
  async lockEscrow(
    escrowId: PublicKey,
    beneficiarySigner: Signer,
    beneficiaryWallet: PublicKey,
    arbiterWallet?: PublicKey,
  ): Promise<string> {
    const signer = this.requireSigner();

    const tx = await this.buildLockEscrowTransaction(escrowId, beneficiaryWallet, arbiterWallet);
    tx.feePayer = signer.publicKey;
    return sendAndConfirmWithRetry(this.connection, tx, [signer, beneficiarySigner]);
  }

  /**
   * Release escrow funds to the beneficiary (calls `release_escrow`).
   * Only the initiator can call this; the escrow must be in `Locked` status.
   *
   * After release, a 7-day dispute window opens during which the beneficiary
   * may raise a dispute via `openDispute`. This window is tracked in
   * `EscrowAccount.disputeWindowEndsAt`. Funds are not spendable by the
   * beneficiary until `claim_released` is called after the window closes.
   *
   * @param escrowId - The 32-byte escrow ID encoded as a PublicKey.
   * @throws {EscrowSignerRequiredError} if no signer was configured on the client.
   * @throws {EscrowAgentWalletRequiredError} if no agentWallet was configured on the client.
   */
  async releasePact(escrowId: PublicKey): Promise<string> {
    const signer = this.requireSigner();
    const agentWallet = this.requireAgentWallet();

    const escrowIdBytes = escrowId.toBuffer();
    const escrowPda = deriveEscrowPda(escrowIdBytes, this.programId);
    const pactPda = derivePactPda(escrowIdBytes, this.programId);
    const info = await this.connection.getAccountInfo(escrowPda);
    if (info === null) throw new EscrowNotFoundError(escrowPda.toBase58());
    const escrow = deserializeEscrowAccount(escrowPda, Buffer.from(info.data));
    const vault = new PublicKey(escrow.vault);

    const ix = new TransactionInstruction({
      programId: this.programId,
      data: Buffer.from(DISC_RELEASE_ESCROW),
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: pactPda, isSigner: false, isWritable: false },
        { pubkey: agentWallet, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: false },
      ],
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = signer.publicKey;
    return sendAndConfirmWithRetry(this.connection, tx, [signer]);
  }

  /**
   * Finalise a released pact by claiming all funds (calls `claim_released`).
   * Transfers `escrow_amount + beneficiary_stake` to the beneficiary and returns
   * `initiator_stake` to the initiator. Awards both parties +50 reputation for a
   * `Fulfilled` pact outcome.
   *
   * Preconditions (enforced on-chain and pre-flight):
   * - Escrow must be in `Released` status.
   * - The 7-day dispute window (`disputeWindowEndsAt`) must have elapsed.
   * - Beneficiary must not be Blacklisted.
   *
   * @param escrowId        - The 32-byte escrow ID encoded as a PublicKey.
   * @param initiatorPubkey - Initiator's public key, used to derive their ATA for stake return.
   * @returns Transaction signature.
   * @throws {EscrowSignerRequiredError} if no signer was configured on the client.
   * @throws {EscrowAgentWalletRequiredError} if no agentWallet was configured on the client.
   * @throws {EscrowNotFoundError} if no escrow exists for this ID.
   * @throws {DisputeWindowStillOpenError} if the 7-day dispute window has not yet closed.
   */
  async claimReleased(escrowId: PublicKey, initiatorPubkey: PublicKey): Promise<string> {
    const signer = this.requireSigner();
    const agentWallet = this.requireAgentWallet();

    const escrowIdBytes = escrowId.toBuffer();
    const escrowPda = deriveEscrowPda(escrowIdBytes, this.programId);

    const info = await this.connection.getAccountInfo(escrowPda);
    if (info === null) throw new EscrowNotFoundError(escrowPda.toBase58());
    const escrow = deserializeEscrowAccount(escrowPda, Buffer.from(info.data));

    const nowSecs = Math.floor(Date.now() / 1000);
    if (nowSecs <= escrow.disputeWindowEndsAt) {
      throw new DisputeWindowStillOpenError(escrow.disputeWindowEndsAt);
    }

    const mint = new PublicKey(escrow.mint);
    const vault = new PublicKey(escrow.vault);
    const beneficiaryAta = deriveAta(signer.publicKey, mint);
    const initiatorAta = deriveAta(initiatorPubkey, mint);
    const initiatorReputationPda = deriveReputationPda(initiatorPubkey, this.holdfastProgramId);
    const beneficiaryReputationPda = deriveReputationPda(signer.publicKey, this.holdfastProgramId);
    const [escrowAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vp_escrow_authority")],
      this.programId,
    );

    const ix = new TransactionInstruction({
      programId: this.programId,
      data: Buffer.from(DISC_CLAIM_RELEASED),
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: beneficiaryAta, isSigner: false, isWritable: true },
        { pubkey: initiatorAta, isSigner: false, isWritable: true },
        { pubkey: agentWallet, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: initiatorReputationPda, isSigner: false, isWritable: true },
        { pubkey: beneficiaryReputationPda, isSigner: false, isWritable: true },
        { pubkey: escrowAuthorityPda, isSigner: false, isWritable: false },
        { pubkey: this.holdfastProgramId, isSigner: false, isWritable: false },
      ],
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = signer.publicKey;
    return sendAndConfirmWithRetry(this.connection, tx, [signer]);
  }

  /**
   * Open a dispute on a locked or recently-released escrow (calls `raise_dispute`).
   * Either the initiator or beneficiary may raise a dispute.
   *
   * The escrow must be in `Locked` status, or in `Released` status within the
   * 7-day dispute window (`disputeWindowEndsAt`). After a dispute is raised,
   * the escrow advances to `Disputed` status and the arbiter resolution clock begins.
   *
   * The `reason` string is stored as the evidence URI (truncated to 128 bytes UTF-8).
   * For hashed evidence, submit the raw `raise_dispute` instruction directly.
   *
   * @param escrowId - The 32-byte escrow ID encoded as a PublicKey.
   * @param reason   - Human-readable dispute reason (up to 128 UTF-8 bytes).
   * @throws {EscrowSignerRequiredError} if no signer was configured on the client.
   */
  async openDispute(escrowId: PublicKey, reason: string): Promise<string> {
    const signer = this.requireSigner();

    const escrowIdBytes = escrowId.toBuffer();
    const escrowPda = deriveEscrowPda(escrowIdBytes, this.programId);
    const pactPda = derivePactPda(escrowIdBytes, this.programId);
    const disputePda = deriveDisputePda(escrowIdBytes, this.programId);
    const info = await this.connection.getAccountInfo(escrowPda);
    if (info === null) throw new EscrowNotFoundError(escrowPda.toBase58());
    const escrow = deserializeEscrowAccount(escrowPda, Buffer.from(info.data));

    const mint = new PublicKey(escrow.mint);
    const vault = new PublicKey(escrow.vault);
    const beneficiaryAta = deriveAta(new PublicKey(escrow.beneficiary), mint);
    const initiatorAta = deriveAta(new PublicKey(escrow.initiator), mint);

    // RaiseDisputeParams Borsh layout: evidence_hash [u8;32], evidence_uri [u8;128]
    const data = new BorshWriter()
      .fixedBytes(DISC_RAISE_DISPUTE, 8)
      .fixedBytes(new Uint8Array(32), 32) // evidence_hash: zeroed when passing plain-text reason
      .fixedBytes(Buffer.from(reason, "utf8"), 128)
      .build();

    const ix = new TransactionInstruction({
      programId: this.programId,
      data,
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: pactPda, isSigner: false, isWritable: false },
        { pubkey: disputePda, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: false },
        { pubkey: beneficiaryAta, isSigner: false, isWritable: false },
        { pubkey: initiatorAta, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = signer.publicKey;
    return sendAndConfirmWithRetry(this.connection, tx, [signer]);
  }

  /**
   * Mutually cancel a locked escrow (calls `mutual_cancel_escrow`).
   * Both the initiator and beneficiary must sign. The vault is drained immediately:
   * initiator receives `escrow_amount + initiator_stake`, beneficiary receives `beneficiary_stake`.
   *
   * Preconditions (enforced on-chain):
   * - Escrow must be in `Locked` status.
   * - No active DisputeRecord PDA (dispute must not have been raised).
   * - Neither signer may be Blacklisted.
   *
   * After this call, the escrow is in `MutuallyCancelled` status and can be closed
   * via `close_escrow` (or use `cancelAndClose` to do both atomically).
   * No reputation delta is applied.
   *
   * @param escrowId         - The 32-byte escrow ID encoded as a PublicKey.
   * @param initiatorSigner  - Keypair of the escrow initiator.
   * @param beneficiarySigner - Keypair of the escrow beneficiary.
   * @param initiatorWallet  - Initiator's AgentWallet PDA (holdfast program).
   * @param beneficiaryWallet - Beneficiary's AgentWallet PDA (holdfast program).
   * @returns Transaction signature.
   */
  async cancelPact(
    escrowId: PublicKey,
    initiatorSigner: Signer,
    beneficiarySigner: Signer,
    initiatorWallet: PublicKey,
    beneficiaryWallet: PublicKey,
  ): Promise<string> {
    const escrowIdBytes = escrowId.toBuffer();
    const escrowPda = deriveEscrowPda(escrowIdBytes, this.programId);
    const disputePda = deriveDisputePda(escrowIdBytes, this.programId);

    const info = await this.connection.getAccountInfo(escrowPda);
    if (info === null) throw new EscrowNotFoundError(escrowPda.toBase58());
    const escrow = deserializeEscrowAccount(escrowPda, Buffer.from(info.data));

    const mint = new PublicKey(escrow.mint);
    const vault = new PublicKey(escrow.vault);
    const initiatorAta = deriveAta(new PublicKey(escrow.initiator), mint);
    const beneficiaryAta = deriveAta(new PublicKey(escrow.beneficiary), mint);

    const ix = new TransactionInstruction({
      programId: this.programId,
      data: Buffer.from(DISC_MUTUAL_CANCEL_ESCROW),
      keys: [
        { pubkey: initiatorSigner.publicKey, isSigner: true, isWritable: true },
        { pubkey: beneficiarySigner.publicKey, isSigner: true, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: initiatorAta, isSigner: false, isWritable: true },
        { pubkey: beneficiaryAta, isSigner: false, isWritable: true },
        // Optional dispute_record: always pass the PDA; Anchor resolves to None if uninitialised.
        { pubkey: disputePda, isSigner: false, isWritable: false },
        { pubkey: initiatorWallet, isSigner: false, isWritable: false },
        { pubkey: beneficiaryWallet, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = initiatorSigner.publicKey;
    return sendAndConfirmWithRetry(this.connection, tx, [initiatorSigner, beneficiarySigner]);
  }

  /**
   * Mutually cancel a locked escrow and close it in a single transaction.
   * Combines `mutual_cancel_escrow` + `close_escrow` atomically so rent is returned
   * to the initiator without a second transaction.
   *
   * @param escrowId          - The 32-byte escrow ID encoded as a PublicKey.
   * @param initiatorSigner   - Keypair of the escrow initiator (also pays for close).
   * @param beneficiarySigner - Keypair of the escrow beneficiary.
   * @param initiatorWallet   - Initiator's AgentWallet PDA (holdfast program).
   * @param beneficiaryWallet - Beneficiary's AgentWallet PDA (holdfast program).
   * @returns Transaction signature.
   */
  async cancelAndClose(
    escrowId: PublicKey,
    initiatorSigner: Signer,
    beneficiarySigner: Signer,
    initiatorWallet: PublicKey,
    beneficiaryWallet: PublicKey,
  ): Promise<string> {
    const escrowIdBytes = escrowId.toBuffer();
    const escrowPda = deriveEscrowPda(escrowIdBytes, this.programId);
    const pactPda = derivePactPda(escrowIdBytes, this.programId);
    const disputePda = deriveDisputePda(escrowIdBytes, this.programId);

    const info = await this.connection.getAccountInfo(escrowPda);
    if (info === null) throw new EscrowNotFoundError(escrowPda.toBase58());
    const escrow = deserializeEscrowAccount(escrowPda, Buffer.from(info.data));

    const mint = new PublicKey(escrow.mint);
    const vault = new PublicKey(escrow.vault);
    const initiatorAta = deriveAta(new PublicKey(escrow.initiator), mint);
    const beneficiaryAta = deriveAta(new PublicKey(escrow.beneficiary), mint);

    const cancelIx = new TransactionInstruction({
      programId: this.programId,
      data: Buffer.from(DISC_MUTUAL_CANCEL_ESCROW),
      keys: [
        { pubkey: initiatorSigner.publicKey, isSigner: true, isWritable: true },
        { pubkey: beneficiarySigner.publicKey, isSigner: true, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: initiatorAta, isSigner: false, isWritable: true },
        { pubkey: beneficiaryAta, isSigner: false, isWritable: true },
        { pubkey: disputePda, isSigner: false, isWritable: false },
        { pubkey: initiatorWallet, isSigner: false, isWritable: false },
        { pubkey: beneficiaryWallet, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
    });

    const closeIx = new TransactionInstruction({
      programId: this.programId,
      data: Buffer.from(DISC_CLOSE_ESCROW),
      keys: [
        { pubkey: initiatorSigner.publicKey, isSigner: true, isWritable: true },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: pactPda, isSigner: false, isWritable: true },
        // Optional dispute_record for close: pass PDA; Anchor handles None.
        { pubkey: disputePda, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
    });

    const tx = new Transaction().add(cancelIx, closeIx);
    tx.feePayer = initiatorSigner.publicKey;
    return sendAndConfirmWithRetry(this.connection, tx, [initiatorSigner, beneficiarySigner]);
  }

  /**
   * Cancel a funded escrow after its time lock has expired (calls `cancel_pending_escrow`).
   * Only the initiator can call this. Returns `escrow_amount + initiator_stake` to the
   * initiator and `beneficiary_stake` to the beneficiary (if staked).
   *
   * Preconditions (enforced on-chain):
   * - Escrow must be in `Funded` status.
   * - `time_lock_expires_at` must have passed.
   *
   * After this call, the escrow is in `Refunded` status.
   *
   * @param escrowId - The 32-byte escrow ID encoded as a PublicKey.
   * @returns Transaction signature.
   * @throws {EscrowSignerRequiredError} if no signer was configured on the client.
   * @throws {EscrowNotFoundError} if no escrow exists for this ID.
   */
  async cancelPendingEscrow(escrowId: PublicKey): Promise<string> {
    const signer = this.requireSigner();

    const escrowIdBytes = escrowId.toBuffer();
    const escrowPda = deriveEscrowPda(escrowIdBytes, this.programId);

    const info = await this.connection.getAccountInfo(escrowPda);
    if (info === null) throw new EscrowNotFoundError(escrowPda.toBase58());
    const escrow = deserializeEscrowAccount(escrowPda, Buffer.from(info.data));

    const mint = new PublicKey(escrow.mint);
    const vault = new PublicKey(escrow.vault);
    const initiatorAta = deriveAta(new PublicKey(escrow.initiator), mint);
    const beneficiaryAta = deriveAta(new PublicKey(escrow.beneficiary), mint);
    const initiatorReputationPda = deriveReputationPda(
      new PublicKey(escrow.initiator),
      this.holdfastProgramId,
    );
    const beneficiaryReputationPda = deriveReputationPda(
      new PublicKey(escrow.beneficiary),
      this.holdfastProgramId,
    );
    const [escrowAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vp_escrow_authority")],
      this.programId,
    );

    const ix = new TransactionInstruction({
      programId: this.programId,
      data: Buffer.from(DISC_CANCEL_PENDING_ESCROW),
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: initiatorAta, isSigner: false, isWritable: true },
        { pubkey: beneficiaryAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: initiatorReputationPda, isSigner: false, isWritable: true },
        { pubkey: beneficiaryReputationPda, isSigner: false, isWritable: true },
        { pubkey: escrowAuthorityPda, isSigner: false, isWritable: false },
        { pubkey: this.holdfastProgramId, isSigner: false, isWritable: false },
      ],
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = signer.publicKey;
    return sendAndConfirmWithRetry(this.connection, tx, [signer]);
  }

  /**
   * Read current pact state directly via RPC — no oracle round-trip.
   * Derives the EscrowAccount PDA from the escrow ID and fetches it in one RPC call.
   *
   * @param escrowId - The 32-byte escrow ID encoded as a PublicKey.
   * @throws {EscrowNotFoundError} if no escrow exists for this ID.
   * @throws {EscrowAccountCorruptError} if account data is malformed.
   */
  async getPact(escrowId: PublicKey): Promise<EscrowAccount> {
    const escrowPda = deriveEscrowPda(escrowId.toBuffer(), this.programId);
    const info = await this.connection.getAccountInfo(escrowPda);
    if (info === null) throw new EscrowNotFoundError(escrowPda.toBase58());
    return deserializeEscrowAccount(escrowPda, Buffer.from(info.data));
  }

  /**
   * List active pacts for an agent via the off-chain indexer.
   * Calls `GET /v1/agents/:pubkey/escrow/pacts` — dashboard use only, not in the trust path.
   *
   * @throws {IndexerRequestError} on non-2xx HTTP responses.
   */
  async listPacts(
    agentPubkey: PublicKey | string,
    opts: ListPactsOptions = {},
  ): Promise<PactPage> {
    const pubkeyStr =
      typeof agentPubkey === "string" ? agentPubkey : agentPubkey.toBase58();
    const limit = Math.min(opts.limit ?? 20, 100);

    const url = new URL(`/v1/agents/${pubkeyStr}/escrow/pacts`, this.indexerUrl);
    url.searchParams.set("limit", String(limit));
    if (opts.status !== undefined) {
      url.searchParams.set("status", String(opts.status));
    }
    if (opts.before !== undefined) {
      url.searchParams.set("before", opts.before);
    }

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new IndexerRequestError(res.status, await res.text());
    }
    return res.json() as Promise<PactPage>;
  }

  /**
   * List escrow lifecycle events for a specific escrow via the off-chain indexer.
   * Calls `GET /v1/escrows/:escrow/events`.
   */
  async getEscrowEvents(
    escrowId: PublicKey | string,
    opts: GetEscrowEventsOptions = {},
  ): Promise<EscrowEventPage> {
    const escrowStr = typeof escrowId === "string" ? escrowId : escrowId.toBase58();
    const limit = Math.min(opts.limit ?? 50, 200);

    const url = new URL(`/v1/escrows/${escrowStr}/events`, this.indexerUrl);
    url.searchParams.set("limit", String(limit));
    if (opts.before !== undefined) {
      url.searchParams.set("before", opts.before);
    }

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new IndexerRequestError(res.status, await res.text());
    }
    return res.json() as Promise<EscrowEventPage>;
  }

  private requireSigner(): Signer {
    if (!this.signer) throw new EscrowSignerRequiredError();
    return this.signer;
  }

  private requireAgentWallet(): PublicKey {
    if (!this.agentWallet) throw new EscrowAgentWalletRequiredError();
    return this.agentWallet;
  }
}

function isInitializeEscrowCompatibilityError(err: unknown): boolean {
  const pattern =
    /(invalid instruction data|instruction.*fallback not found|not enough account keys|failed to deserialize|AccountNotEnoughKeys|InstructionDidNotDeserialize)/i;
  let current: unknown = err;
  while (current instanceof Error) {
    if (pattern.test(current.message)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

// ── Errors ────────────────────────────────────────────────────────────

export class EscrowNotFoundError extends Error {
  constructor(readonly escrowAddress: string) {
    super(
      `EscrowAccount not found at ${escrowAddress}. ` +
        `Verify the escrow ID is correct and the pact has been created.`,
    );
    this.name = "EscrowNotFoundError";
  }
}

export class EscrowAccountCorruptError extends Error {
  constructor(detail: string) {
    super(`EscrowAccount data invalid: ${detail}`);
    this.name = "EscrowAccountCorruptError";
  }
}

export class EscrowSignerRequiredError extends Error {
  constructor() {
    super(
      "A signer is required for escrow write operations. " +
        "Pass `signer` in HoldfastClientOptions.",
    );
    this.name = "EscrowSignerRequiredError";
  }
}

export class EscrowArbiterWalletRequiredError extends Error {
  constructor() {
    super(
      "An arbiterWallet PDA is required when `arbiter` is specified. " +
        "Pass `arbiterWallet` in CreatePactParams. " +
        "The AgentWallet PDA is created by calling `register_agent_wallet` " +
        "on the holdfast program.",
    );
    this.name = "EscrowArbiterWalletRequiredError";
  }
}

export class EscrowAgentWalletRequiredError extends Error {
  constructor() {
    super(
      "An agentWallet PDA is required for this operation. " +
        "Pass `agentWallet` in HoldfastClientOptions. " +
        "The AgentWallet PDA is created by calling `register_agent_wallet` " +
        "on the holdfast program.",
    );
    this.name = "EscrowAgentWalletRequiredError";
  }
}

export class EscrowLockArbiterWalletRequiredError extends Error {
  constructor(readonly arbiterPubkey: string) {
    super(
      "lockEscrow requires an explicit arbiterWallet when the escrow was created " +
        `with arbiter=${arbiterPubkey}. Pass arbiterWallet to lockEscrow/buildLockEscrowTransaction.`,
    );
    this.name = "EscrowLockArbiterWalletRequiredError";
  }
}

export class DisputeWindowStillOpenError extends Error {
  constructor(readonly disputeWindowEndsAt: number) {
    const endsAt = new Date(disputeWindowEndsAt * 1000).toISOString();
    super(
      `The 7-day dispute window is still open and closes at ${endsAt}. ` +
        `claimReleased() cannot be called until after the dispute window closes.`,
    );
    this.name = "DisputeWindowStillOpenError";
  }
}

export class ReputationThresholdNotMet extends Error {
  constructor(
    readonly agentPubkey: string,
    readonly requiredMinScore: number | undefined,
    readonly requiredMinTier: VerifTier | undefined,
  ) {
    super(
      `Agent ${agentPubkey} did not meet the reputation pre-flight threshold ` +
        `(minScore=${requiredMinScore ?? "none"}, minTier=${requiredMinTier ?? "none"}). ` +
        `Counterparties using this threshold will reject the pact on-chain.`,
    );
    this.name = "ReputationThresholdNotMet";
  }
}
