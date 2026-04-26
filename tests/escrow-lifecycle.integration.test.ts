import { createHash } from "crypto";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  Connection,
  Keypair,
  PublicKey,
  Signer,
  Transaction,
} from "@solana/web3.js";
import { EscrowModule } from "../src/escrow/index.js";
import { EscrowStatus, VerifTier } from "../src/types.js";
import type { ReputationModule } from "../src/reputation/index.js";

const ESCROW_PROGRAM_ID = new PublicKey("BNxA76z6vjQYtUJXGpH8qjA3wHvtAAqGqL6rvVWH6b3H");
const HOLDFAST_PROGRAM_ID = new PublicKey("D6mUa4wGtFyLyJorMfxoKvA9ybohjUSsfw88t66ATxg");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bL");

function disc(name: string): Buffer {
  return Buffer.from(createHash("sha256").update(`global:${name}`).digest()).subarray(0, 8);
}

const ESCROW_ACCOUNT_DISC = Buffer.from(
  createHash("sha256").update("account:EscrowAccount").digest(),
).subarray(0, 8);

function deriveAta(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

function deriveEscrowPda(escrowId: Uint8Array): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), Buffer.from(escrowId)],
    ESCROW_PROGRAM_ID,
  );
  return pda;
}

function derivePactPda(escrowId: Uint8Array): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pact"), Buffer.from(escrowId)],
    ESCROW_PROGRAM_ID,
  );
  return pda;
}

function deriveRepPda(agent: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("reputation"), agent.toBuffer()],
    HOLDFAST_PROGRAM_ID,
  );
  return pda;
}

function buildEscrowAccountData(params: {
  escrowId: Uint8Array;
  initiator: PublicKey;
  beneficiary: PublicKey;
  arbiter: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
  pactRecord: PublicKey;
  status: EscrowStatus;
  disputeWindowEndsAt: bigint;
}): Buffer {
  const buf = Buffer.alloc(8 + 308, 0);
  ESCROW_ACCOUNT_DISC.copy(buf, 0);
  let o = 8;
  buf.writeUInt8(1, o); o += 1; // schema_version
  buf.writeUInt8(254, o); o += 1; // bump
  Buffer.from(params.escrowId).copy(buf, o); o += 32;
  params.initiator.toBuffer().copy(buf, o); o += 32;
  params.beneficiary.toBuffer().copy(buf, o); o += 32;
  params.arbiter.toBuffer().copy(buf, o); o += 32;
  params.mint.toBuffer().copy(buf, o); o += 32;
  params.vault.toBuffer().copy(buf, o); o += 32;
  buf.writeBigUInt64LE(1_000_000n, o); o += 8;
  buf.writeBigUInt64LE(10_000n, o); o += 8;
  buf.writeBigUInt64LE(5_000n, o); o += 8;
  buf.writeUInt8(params.status, o); o += 1;
  buf.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 3600), o); o += 8;
  buf.writeBigInt64LE(params.disputeWindowEndsAt, o); o += 8;
  params.pactRecord.toBuffer().copy(buf, o); o += 32;
  buf.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) - 120), o); o += 8;
  buf.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) - 110), o); o += 8;
  buf.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) - 100), o); o += 8;
  buf.writeBigInt64LE(0n, o); o += 8;
  buf.writeUInt8(1, o); o += 1;
  buf.writeBigInt64LE(0n, o);
  return buf;
}

class FakeConnection {
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

describe("Escrow SDK lifecycle integration", async () => {
  await test("create/deposit/stake/lock/release/claim use expected accounts and reputation CPI wiring", async () => {
    const initiator = Keypair.generate();
    const beneficiary = Keypair.generate();
    const arbiter = Keypair.generate();
    const initiatorWallet = Keypair.generate().publicKey;
    const beneficiaryWallet = Keypair.generate().publicKey;
    const arbiterWallet = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;

    const escrowIdBytes = Buffer.alloc(32, 0x42);
    const escrowId = new PublicKey(escrowIdBytes);
    const escrowPda = deriveEscrowPda(escrowIdBytes);
    const pactPda = derivePactPda(escrowIdBytes);
    const vault = deriveAta(escrowPda, mint);

    const conn = new FakeConnection();
    conn.setAccount(
      escrowPda,
      buildEscrowAccountData({
        escrowId: escrowIdBytes,
        initiator: initiator.publicKey,
        beneficiary: beneficiary.publicKey,
        arbiter: arbiter.publicKey,
        mint,
        vault,
        pactRecord: pactPda,
        status: EscrowStatus.Released,
        disputeWindowEndsAt: BigInt(Math.floor(Date.now() / 1000) - 10),
      }),
    );

    const repCalls: Array<{ agent: string; requirements: Record<string, number> }> = [];
    const rep = {
      async meetsRequirements(agentPubkey: PublicKey | string, requirements: Record<string, number>) {
        repCalls.push({
          agent: typeof agentPubkey === "string" ? agentPubkey : agentPubkey.toBase58(),
          requirements,
        });
        return true;
      },
    } as unknown as ReputationModule;

    const initiatorSdk = new EscrowModule(
      conn as unknown as Connection,
      "http://indexer.test",
      rep,
      initiator,
      initiatorWallet,
      ESCROW_PROGRAM_ID,
      HOLDFAST_PROGRAM_ID,
    );
    const beneficiarySdk = new EscrowModule(
      conn as unknown as Connection,
      "http://indexer.test",
      rep,
      beneficiary,
      beneficiaryWallet,
      ESCROW_PROGRAM_ID,
      HOLDFAST_PROGRAM_ID,
    );

    await initiatorSdk.createPact({
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
        minPacts: 2,
      },
      escrowId: escrowIdBytes,
    });

    assert.equal(repCalls.length, 1);
    assert.equal(repCalls[0].agent, initiator.publicKey.toBase58());
    assert.equal(repCalls[0].requirements.minScore, 6000);
    assert.equal(repCalls[0].requirements.minTier, VerifTier.Attested);
    assert.equal(repCalls[0].requirements.minPacts, 2);

    const initiatorRepPda = deriveRepPda(initiator.publicKey);
    const beneficiaryRepPda = deriveRepPda(beneficiary.publicKey);
    const [escrowAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vp_escrow_authority")],
      ESCROW_PROGRAM_ID,
    );

    const createIx = conn.sent[0].tx.instructions[0];
    assert.deepEqual(createIx.data.subarray(0, 8), disc("initialize_escrow"));
    assert.ok(createIx.keys.some((k) => k.pubkey.equals(initiatorRepPda)));
    assert.ok(createIx.keys.some((k) => k.pubkey.equals(HOLDFAST_PROGRAM_ID)));

    await initiatorSdk.depositEscrow(escrowId);
    const depositIx = conn.sent[1].tx.instructions[0];
    assert.deepEqual(depositIx.data, disc("deposit_funds"));
    assert.ok(depositIx.keys.some((k) => k.pubkey.equals(vault)));

    await beneficiarySdk.stakeBeneficiary(escrowId);
    const stakeIx = conn.sent[2].tx.instructions[0];
    assert.deepEqual(stakeIx.data, disc("stake_beneficiary"));
    assert.ok(stakeIx.keys.some((k) => k.pubkey.equals(beneficiaryRepPda)));
    assert.ok(stakeIx.keys.some((k) => k.pubkey.equals(HOLDFAST_PROGRAM_ID)));

    const lockTx = await initiatorSdk.buildLockEscrowTransaction(
      escrowId,
      beneficiaryWallet,
      arbiterWallet,
    );
    const lockIx = lockTx.instructions[0];
    assert.deepEqual(lockIx.data, disc("lock_escrow"));
    assert.ok(lockIx.keys.some((k) => k.pubkey.equals(initiatorRepPda)));
    assert.ok(lockIx.keys.some((k) => k.pubkey.equals(beneficiaryRepPda)));

    await initiatorSdk.lockEscrow(escrowId, beneficiary, beneficiaryWallet, arbiterWallet);
    assert.equal(conn.sent[3].signers.length, 2);

    await initiatorSdk.releasePact(escrowId);
    const releaseIx = conn.sent[4].tx.instructions[0];
    assert.deepEqual(releaseIx.data, disc("release_escrow"));
    assert.ok(releaseIx.keys.some((k) => k.pubkey.equals(initiatorWallet)));

    await beneficiarySdk.claimReleased(escrowId, initiator.publicKey);
    const claimIx = conn.sent[5].tx.instructions[0];
    assert.deepEqual(claimIx.data, disc("claim_released"));
    assert.ok(claimIx.keys.some((k) => k.pubkey.equals(initiatorRepPda)));
    assert.ok(claimIx.keys.some((k) => k.pubkey.equals(beneficiaryRepPda)));
    assert.ok(claimIx.keys.some((k) => k.pubkey.equals(escrowAuthority)));
    assert.ok(claimIx.keys.some((k) => k.pubkey.equals(HOLDFAST_PROGRAM_ID)));
  });
});
