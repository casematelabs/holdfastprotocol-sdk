import { Connection, PublicKey, Signer } from "@solana/web3.js";
import { ReputationModule } from "./reputation/index.js";
import { EscrowModule } from "./escrow/index.js";

export const PREAUDIT_WARNING =
  "[Holdfast SDK v0.1.0-devnet.1] This package has NOT been externally audited. " +
  "It is published for devnet integration testing only. " +
  "Mainnet use is blocked until the external security audit is complete. " +
  "Track audit status at https://docs.holdfastprotocol.com/security";

// Heuristic patterns for known mainnet-beta RPC endpoints.
// This is defence-in-depth — the devnet-only restriction is enforced here
// and also documented in the pre-audit disclaimer.
const MAINNET_PATTERNS = [
  "mainnet-beta",
  "mainnet.solana",
  "api.mainnet",
  "rpc.mainnet",
];

function assertNotMainnet(rpcUrl: string): void {
  const lower = rpcUrl.toLowerCase();
  if (MAINNET_PATTERNS.some((p) => lower.includes(p))) {
    throw new Error(
      `[Holdfast SDK] Mainnet connections are disabled in pre-audit release v0.1.0-devnet.1. ` +
        `Attempted RPC: ${rpcUrl}. ` +
        `This restriction will be lifted after the external security audit is complete. ` +
        `See https://docs.holdfastprotocol.com/security`,
    );
  }
}

export interface HoldfastClientOptions {
  /** Solana RPC endpoint. Defaults to the public devnet endpoint. */
  rpcUrl?: string;
  /**
   * Off-chain indexer base URL. Required for `reputation.getHistory` and `escrow.listPacts`.
   * Defaults to the Holdfast devnet indexer.
   */
  indexerUrl?: string;
  /**
   * Signing keypair for escrow write operations (createPact, depositEscrow,
   * releasePact, openDispute). Read-only methods (getPact, listPacts,
   * reputation.*) work without a signer.
   */
  signer?: Signer;
  /**
   * The caller's AgentWallet PDA address (seeds: ["agent_wallet", pubkey_x, pubkey_y]
   * on the holdfast program). Required for `createPact` and `releasePact`.
   * Obtained after calling `register_agent_wallet` on the holdfast program.
   */
  agentWallet?: PublicKey;
  /**
   * Override the holdfast-escrow program ID. Defaults to the devnet deployment
   * (BNxA76z6vjQYtUJXGpH8qjA3wHvtAAqGqL6rvVWH6b3H, deployed per CAS-54).
   */
  escrowProgramId?: PublicKey;
  /**
   * Override the holdfast program ID. Defaults to the devnet deployment
   * (D6mUa4wGtFyLyJorMfxoKvA9ybohjUSsfw88t66ATxg).
   */
  holdfastProgramId?: PublicKey;
}

const DEVNET_RPC = "https://api.devnet.solana.com";
const DEVNET_INDEXER = "https://holdfast-indexer.fly.dev";

/**
 * Canonical devnet program IDs for Holdfast Protocol.
 * Last verified deployed: 2026-04-20 (CAS-121).
 *
 * Both AgentWallet and ReputationAccount PDAs live in HOLDFAST_PROGRAM_ID.
 * holdfast-escrow is a separate program that CPIs into holdfast.
 */
export const HOLDFAST_PROGRAM_ID = "D6mUa4wGtFyLyJorMfxoKvA9ybohjUSsfw88t66ATxg";
export const HOLDFAST_ESCROW_PROGRAM_ID = "BNxA76z6vjQYtUJXGpH8qjA3wHvtAAqGqL6rvVWH6b3H";

export class HoldfastClient {
  readonly connection: Connection;
  readonly reputation: ReputationModule;
  readonly escrow: EscrowModule;

  constructor(options: HoldfastClientOptions = {}) {
    const rpcUrl = options.rpcUrl ?? DEVNET_RPC;
    assertNotMainnet(rpcUrl);
    // Emit on every instantiation until external audit clears this release.
    console.warn(PREAUDIT_WARNING);
    const indexerUrl = options.indexerUrl ?? DEVNET_INDEXER;
    this.connection = new Connection(rpcUrl, "confirmed");
    this.reputation = new ReputationModule(this.connection, indexerUrl);
    this.escrow = new EscrowModule(
      this.connection,
      indexerUrl,
      this.reputation,
      options.signer,
      options.agentWallet,
      options.escrowProgramId,
      options.holdfastProgramId,
    );
  }
}

export function createHoldfastClient(
  options?: HoldfastClientOptions,
): HoldfastClient {
  return new HoldfastClient(options);
}
