import { createHash } from "crypto";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey, Signer, Transaction } from "@solana/web3.js";
import { EscrowModule } from "../src/escrow/index.js";
import { VerifTier } from "../src/types.js";
import type { ReputationModule } from "../src/reputation/index.js";

const ESCROW_PROGRAM_ID = new PublicKey("CAZMkHiExVjbsSwAVBYVhz1yaHmnBSvzUYGaQrrRp6yi");
const HOLDFAST_PROGRAM_ID = new PublicKey("2chF47DbqehX3L38874e2RznaSs46vpcMPEPRYz4Dywq");

function disc(name: string): Buffer {
  return Buffer.from(createHash("sha256").update(`global:${name}`).digest()).subarray(0, 8);
}

class RecordingConnection {
  readonly sent: Array<{ tx: Transaction; signers: Signer[] }> = [];
  private readonly accounts = new Map<string, Buffer>();

  setAccount(pubkey: PublicKey, data: Buffer): void {
    this.accounts.set(pubkey.toBase58(), data);
  }

  async getLatestBlockhash() {
    return {
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 99999999,
    };
  }

  async sendTransaction(tx: Transaction, signers: Signer[]): Promise<string> {
    this.sent.push({ tx, signers });
    return `sig-${this.sent.length}`;
  }

  async confirmTransaction() {
    return { value: { err: null } };
  }

  async getAccountInfo(pubkey: PublicKey) {
    const data = this.accounts.get(pubkey.toBase58());
    if (!data) return null;
    return {
      data,
      executable: false,
      lamports: 1_000_000,
      owner: ESCROW_PROGRAM_ID,
      rentEpoch: 0,
    };
  }
}

function buildEscrowAccountData(escrowId: Uint8Array, initiator: PublicKey, beneficiary: PublicKey): Buffer {
  const disc = Buffer.from(createHash("sha256").update("account:EscrowAccount").digest()).subarray(0, 8);
  const buf = Buffer.alloc(8 + 308, 0);
  disc.copy(buf, 0);
  let o = 8;
  buf.writeUInt8(1, o); o += 1;
  buf.writeUInt8(254, o); o += 1;
  Buffer.from(escrowId).copy(buf, o); o += 32;
  initiator.toBuffer().copy(buf, o); o += 32;
  beneficiary.toBuffer().copy(buf, o); o += 32;
  Buffer.alloc(32, 0).copy(buf, o); o += 32;
  Buffer.alloc(32, 1).copy(buf, o); o += 32;
  Buffer.alloc(32, 2).copy(buf, o); o += 32;
  buf.writeBigUInt64LE(1_000_000n, o); o += 8;
  buf.writeBigUInt64LE(0n, o); o += 8;
  buf.writeBigUInt64LE(0n, o); o += 8;
  buf.writeUInt8(0, o); o += 1;
  buf.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 3600), o); o += 8;
  buf.writeBigInt64LE(0n, o); o += 8;
  Buffer.alloc(32, 3).copy(buf, o); o += 32;
  buf.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), o); o += 8;
  buf.writeBigInt64LE(0n, o); o += 8;
  buf.writeBigInt64LE(0n, o); o += 8;
  buf.writeBigInt64LE(0n, o); o += 8;
  buf.writeUInt8(0, o); o += 1;
  buf.writeBigInt64LE(0n, o);
  return buf;
}

describe("quickstart parity (deterministic CI)", async () => {
  await test("createPact encodes initialize_escrow and keeps quickstart SDK lifecycle surface callable", async () => {
    const initiator = Keypair.generate();
    const beneficiary = Keypair.generate();
    const agentWallet = Keypair.generate().publicKey;
    const beneficiaryWallet = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const escrowId = Buffer.alloc(32, 7);
    const connection = new RecordingConnection();
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), Buffer.from(escrowId)],
      ESCROW_PROGRAM_ID,
    );
    connection.setAccount(
      escrowPda,
      buildEscrowAccountData(escrowId, initiator.publicKey, beneficiary.publicKey),
    );

    const rep = {
      async meetsRequirements() {
        return true;
      },
    } as unknown as ReputationModule;

    const sdk = new EscrowModule(
      connection as unknown as Connection,
      "http://indexer.test",
      rep,
      initiator,
      agentWallet,
      ESCROW_PROGRAM_ID,
      HOLDFAST_PROGRAM_ID,
    );

    await sdk.createPact({
      counterparty: beneficiary.publicKey,
      counterpartyWallet: beneficiaryWallet,
      mint,
      amount: 1_000_000n,
      releaseCondition: {
        kind: "timed",
        timeLockExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      reputationThreshold: {
        minScore: 6000,
        minTier: VerifTier.Attested,
        minPacts: 1,
      },
      escrowId,
    });

    assert.equal(connection.sent.length, 1);
    const ix = connection.sent[0].tx.instructions[0];
    assert.deepEqual(ix.data.subarray(0, 8), disc("initialize_escrow"));
    assert.equal(ix.programId.toBase58(), ESCROW_PROGRAM_ID.toBase58());

    // Quickstart lifecycle surface parity: these methods remain present/callable.
    assert.equal(typeof sdk.depositEscrow, "function");
    assert.equal(typeof sdk.stakeBeneficiary, "function");
    assert.equal(typeof sdk.lockEscrow, "function");
    assert.equal(typeof sdk.releasePact, "function");
    assert.equal(typeof sdk.claimReleased, "function");
  });
});
