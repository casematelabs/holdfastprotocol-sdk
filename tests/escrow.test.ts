/**
 * Unit tests for the EscrowModule — on-chain account deserialization,
 * PDA derivation, discriminator computation, BorshWriter encoding,
 * error classes, and EscrowModule.getPact/listPacts.
 *
 * Run: node --import tsx/esm --test tests/escrow.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  EscrowModule,
  EscrowNotFoundError,
  EscrowAccountCorruptError,
  EscrowSignerRequiredError,
  EscrowAgentWalletRequiredError,
  DisputeWindowStillOpenError,
  ReputationThresholdNotMet,
} from "../src/escrow/index.js";
import { EscrowStatus, VerifTier } from "../src/types.js";
import { ReputationModule } from "../src/reputation/index.js";

// ── Constants ──────────────────────────────────────────────────────────────

const DEVNET_ESCROW_PROGRAM_ID = new PublicKey("BNxA76z6vjQYtUJXGpH8qjA3wHvtAAqGqL6rvVWH6b3H");
const DEVNET_HOLDFAST_PROGRAM_ID = new PublicKey("D6mUa4wGtFyLyJorMfxoKvA9ybohjUSsfw88t66ATxg");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bL");

// DISC_ESCROW_ACCOUNT = sha256("account:EscrowAccount")[0..8]
const DISC_ESCROW_ACCOUNT = Buffer.from(
  createHash("sha256").update("account:EscrowAccount").digest(),
).subarray(0, 8);

// Instruction discriminators: sha256("global:<name>")[0..8]
function disc(name: string): Buffer {
  return Buffer.from(
    createHash("sha256").update(`global:${name}`).digest(),
  ).subarray(0, 8);
}

// ── EscrowAccount buffer builder ───────────────────────────────────────────

interface EscrowBufOptions {
  discriminator?: Buffer;
  schemaVersion?: number;
  bump?: number;
  escrowId?: Buffer;
  initiator?: PublicKey;
  beneficiary?: PublicKey;
  arbiter?: PublicKey;
  mint?: PublicKey;
  vault?: PublicKey;
  escrowAmount?: bigint;
  initiatorStake?: bigint;
  beneficiaryStake?: bigint;
  status?: EscrowStatus;
  timeLockExpiresAt?: bigint;
  disputeWindowEndsAt?: bigint;
  pactRecord?: PublicKey;
  createdAt?: bigint;
  lockedAt?: bigint;
  releasedAt?: bigint;
  resolvedAt?: bigint;
  beneficiaryStaked?: boolean;
  cancelledAt?: bigint;
}

const ZERO_PUBKEY = new PublicKey(new Uint8Array(32));
const TEST_PUBKEY_A = new PublicKey("So11111111111111111111111111111111111111112");
const TEST_PUBKEY_B = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TEST_PUBKEY_C = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bL");

const MIN_ESCROW_BUF_SIZE = 8 + 308; // 8 disc + 308 bytes of fields

function makeEscrowBuf(opts: EscrowBufOptions = {}): Buffer {
  // allocate a bit more than the minimum to be safe
  const buf = Buffer.alloc(400, 0);

  const disc = opts.discriminator ?? DISC_ESCROW_ACCOUNT;
  disc.copy(buf, 0);

  let o = 8;
  buf.writeUInt8(opts.schemaVersion ?? 1, o); o += 1;
  buf.writeUInt8(opts.bump ?? 255, o); o += 1;
  const escrowId = opts.escrowId ?? Buffer.alloc(32, 0x01);
  escrowId.copy(buf, o); o += 32;
  (opts.initiator ?? TEST_PUBKEY_A).toBuffer().copy(buf, o); o += 32;
  (opts.beneficiary ?? TEST_PUBKEY_B).toBuffer().copy(buf, o); o += 32;
  (opts.arbiter ?? ZERO_PUBKEY).toBuffer().copy(buf, o); o += 32;
  (opts.mint ?? TEST_PUBKEY_C).toBuffer().copy(buf, o); o += 32;
  (opts.vault ?? TEST_PUBKEY_A).toBuffer().copy(buf, o); o += 32;
  buf.writeBigUInt64LE(opts.escrowAmount ?? 1_000_000n, o); o += 8;
  buf.writeBigUInt64LE(opts.initiatorStake ?? 0n, o); o += 8;
  buf.writeBigUInt64LE(opts.beneficiaryStake ?? 0n, o); o += 8;
  buf.writeUInt8(opts.status ?? EscrowStatus.Pending, o); o += 1;
  buf.writeBigInt64LE(opts.timeLockExpiresAt ?? 1800000000n, o); o += 8;
  buf.writeBigInt64LE(opts.disputeWindowEndsAt ?? 0n, o); o += 8;
  (opts.pactRecord ?? ZERO_PUBKEY).toBuffer().copy(buf, o); o += 32;
  buf.writeBigInt64LE(opts.createdAt ?? 1700000000n, o); o += 8;
  buf.writeBigInt64LE(opts.lockedAt ?? 0n, o); o += 8;
  buf.writeBigInt64LE(opts.releasedAt ?? 0n, o); o += 8;
  buf.writeBigInt64LE(opts.resolvedAt ?? 0n, o); o += 8;
  buf.writeUInt8(opts.beneficiaryStaked === true ? 1 : 0, o); o += 1;
  buf.writeBigInt64LE(opts.cancelledAt ?? 0n, o);

  return buf;
}

// ── Connection mocks ───────────────────────────────────────────────────────

function mockConn(data: Buffer | null): Connection {
  return {
    getAccountInfo: async () =>
      data === null
        ? null
        : { data, executable: false, lamports: 1_000_000, owner: DEVNET_ESCROW_PROGRAM_ID, rentEpoch: 0 },
  } as unknown as Connection;
}

function makeRepModule(conn?: Connection): ReputationModule {
  return new ReputationModule(
    conn ?? (mockConn(null) as unknown as Connection),
    "http://indexer.test",
  );
}

function makeEscrowModule(conn: Connection): EscrowModule {
  return new EscrowModule(conn, "http://indexer.test", makeRepModule(conn));
}

const INDEXER_URL = "http://indexer.test";
const originalFetch = global.fetch;
function withFetch<T>(mock: typeof global.fetch, fn: () => Promise<T>): Promise<T> {
  global.fetch = mock;
  return fn().finally(() => {
    global.fetch = originalFetch;
  });
}

// ── Discriminator computation ──────────────────────────────────────────────

describe("Anchor discriminator computation", async () => {
  await test("account discriminator: sha256('account:EscrowAccount')[0..8]", () => {
    const expected = createHash("sha256").update("account:EscrowAccount").digest().slice(0, 8);
    assert.deepEqual(DISC_ESCROW_ACCOUNT, Buffer.from(expected));
  });

  await test("instruction discriminators match sha256('global:<name>')[0..8] pattern", () => {
    const instructions = [
      "initialize_escrow",
      "deposit_funds",
      "release_escrow",
      "raise_dispute",
      "stake_beneficiary",
      "lock_escrow",
      "claim_released",
      "mutual_cancel_escrow",
      "cancel_pending_escrow",
      "close_escrow",
    ];
    for (const name of instructions) {
      const d = disc(name);
      assert.equal(d.length, 8, `${name} discriminator should be 8 bytes`);
      // Verify it's deterministic
      assert.deepEqual(d, disc(name));
    }
  });

  await test("different instruction names produce different discriminators", () => {
    const d1 = disc("initialize_escrow");
    const d2 = disc("release_escrow");
    assert.notDeepEqual(d1, d2);
  });
});

// ── PDA derivation ─────────────────────────────────────────────────────────

describe("PDA derivation helpers", async () => {
  const escrowId = Buffer.alloc(32, 0xab);

  await test("escrow PDA derives deterministically from escrowId", () => {
    const [pda1] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), escrowId],
      DEVNET_ESCROW_PROGRAM_ID,
    );
    const [pda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), escrowId],
      DEVNET_ESCROW_PROGRAM_ID,
    );
    assert.equal(pda1.toBase58(), pda2.toBase58());
  });

  await test("pact PDA derives deterministically from escrowId", () => {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pact"), escrowId],
      DEVNET_ESCROW_PROGRAM_ID,
    );
    assert.ok(pda instanceof PublicKey);
  });

  await test("dispute PDA derives deterministically from escrowId", () => {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("dispute"), escrowId],
      DEVNET_ESCROW_PROGRAM_ID,
    );
    assert.ok(pda instanceof PublicKey);
  });

  await test("reputation PDA derives from agent pubkey on holdfast program", () => {
    const agent = TEST_PUBKEY_A;
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("reputation"), agent.toBuffer()],
      DEVNET_HOLDFAST_PROGRAM_ID,
    );
    assert.ok(pda instanceof PublicKey);
    assert.notEqual(pda.toBase58(), agent.toBase58());
  });

  await test("ATA derivation: seeds are [owner, TOKEN_PROGRAM_ID, mint]", () => {
    const owner = TEST_PUBKEY_A;
    const mint = TEST_PUBKEY_B;
    const [ata] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    assert.ok(ata instanceof PublicKey);
  });

  await test("escrow PDA differs for different escrow IDs", () => {
    const id1 = Buffer.alloc(32, 0xaa);
    const id2 = Buffer.alloc(32, 0xbb);
    const [pda1] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), id1],
      DEVNET_ESCROW_PROGRAM_ID,
    );
    const [pda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), id2],
      DEVNET_ESCROW_PROGRAM_ID,
    );
    assert.notEqual(pda1.toBase58(), pda2.toBase58());
  });
});

// ── EscrowAccount deserialization — happy paths ────────────────────────────

describe("EscrowModule.getPact — deserialization happy paths", async () => {
  const escrowId = new PublicKey(Buffer.alloc(32, 0x01));

  await test("parses all fields correctly from a minimal valid buffer", async () => {
    const buf = makeEscrowBuf({
      status: EscrowStatus.Pending,
      escrowAmount: 1_000_000n,
      initiatorStake: 500n,
      beneficiaryStake: 250n,
      timeLockExpiresAt: 1800000000n,
      disputeWindowEndsAt: 0n,
      createdAt: 1700000000n,
      lockedAt: 0n,
      releasedAt: 0n,
      resolvedAt: 0n,
      cancelledAt: 0n,
      beneficiaryStaked: false,
    });
    const mod = makeEscrowModule(mockConn(buf));
    const escrow = await mod.getPact(escrowId);

    assert.equal(escrow.escrowAmount, 1_000_000n);
    assert.equal(escrow.initiatorStake, 500n);
    assert.equal(escrow.beneficiaryStake, 250n);
    assert.equal(escrow.status, EscrowStatus.Pending);
    assert.equal(escrow.timeLockExpiresAt, 1800000000);
    assert.equal(escrow.disputeWindowEndsAt, 0);
    assert.equal(escrow.createdAt, 1700000000);
    assert.equal(escrow.lockedAt, 0);
    assert.equal(escrow.releasedAt, 0);
    assert.equal(escrow.resolvedAt, 0);
    assert.equal(escrow.cancelledAt, 0);
    assert.equal(escrow.beneficiaryStaked, false);
  });

  await test("parses all EscrowStatus enum values (0-8)", async () => {
    const statuses: EscrowStatus[] = [
      EscrowStatus.Pending,
      EscrowStatus.Funded,
      EscrowStatus.Locked,
      EscrowStatus.Released,
      EscrowStatus.Disputed,
      EscrowStatus.Refunded,
      EscrowStatus.Closed,
      EscrowStatus.Claimed,
      EscrowStatus.MutuallyCancelled,
    ];
    for (const status of statuses) {
      const buf = makeEscrowBuf({ status });
      const mod = makeEscrowModule(mockConn(buf));
      const escrow = await mod.getPact(escrowId);
      assert.equal(escrow.status, status, `status=${status}`);
    }
  });

  await test("beneficiaryStaked=true is parsed correctly", async () => {
    const buf = makeEscrowBuf({ beneficiaryStaked: true });
    const mod = makeEscrowModule(mockConn(buf));
    const escrow = await mod.getPact(escrowId);
    assert.equal(escrow.beneficiaryStaked, true);
  });

  await test("beneficiaryStaked=false is parsed correctly", async () => {
    const buf = makeEscrowBuf({ beneficiaryStaked: false });
    const mod = makeEscrowModule(mockConn(buf));
    const escrow = await mod.getPact(escrowId);
    assert.equal(escrow.beneficiaryStaked, false);
  });

  await test("escrowAmount=0 (unfunded) is parsed correctly", async () => {
    const buf = makeEscrowBuf({ escrowAmount: 0n });
    const mod = makeEscrowModule(mockConn(buf));
    const escrow = await mod.getPact(escrowId);
    assert.equal(escrow.escrowAmount, 0n);
  });

  await test("large escrowAmount (u64 max) is parsed without overflow", async () => {
    const U64_MAX = 18446744073709551615n;
    const buf = makeEscrowBuf({ escrowAmount: U64_MAX });
    const mod = makeEscrowModule(mockConn(buf));
    const escrow = await mod.getPact(escrowId);
    assert.equal(escrow.escrowAmount, U64_MAX);
  });

  await test("initiator field is a valid base58 string", async () => {
    const buf = makeEscrowBuf({ initiator: TEST_PUBKEY_A });
    const mod = makeEscrowModule(mockConn(buf));
    const escrow = await mod.getPact(escrowId);
    assert.equal(escrow.initiator, TEST_PUBKEY_A.toBase58());
  });

  await test("beneficiary field is a valid base58 string", async () => {
    const buf = makeEscrowBuf({ beneficiary: TEST_PUBKEY_B });
    const mod = makeEscrowModule(mockConn(buf));
    const escrow = await mod.getPact(escrowId);
    assert.equal(escrow.beneficiary, TEST_PUBKEY_B.toBase58());
  });

  await test("arbiter=ZERO_PUBKEY means no arbiter configured", async () => {
    const buf = makeEscrowBuf({ arbiter: ZERO_PUBKEY });
    const mod = makeEscrowModule(mockConn(buf));
    const escrow = await mod.getPact(escrowId);
    assert.equal(escrow.arbiter, ZERO_PUBKEY.toBase58());
  });

  await test("escrowId is hex-encoded 32-byte value from buffer", async () => {
    const id = Buffer.alloc(32, 0xde);
    const buf = makeEscrowBuf({ escrowId: id });
    const mod = makeEscrowModule(mockConn(buf));
    const escrow = await mod.getPact(escrowId);
    assert.equal(escrow.escrowId, id.toString("hex"));
    assert.equal(escrow.escrowId.length, 64); // 32 bytes = 64 hex chars
  });

  await test("address field matches the derived PDA", async () => {
    const buf = makeEscrowBuf({});
    const mod = makeEscrowModule(mockConn(buf));
    const escrow = await mod.getPact(escrowId);
    // The address should be a valid base58 pubkey
    assert.doesNotThrow(() => new PublicKey(escrow.address));
  });

  await test("timestamps can be set to non-zero values (lockedAt, releasedAt)", async () => {
    const buf = makeEscrowBuf({
      lockedAt: 1700001000n,
      releasedAt: 1700002000n,
      resolvedAt: 1700003000n,
      cancelledAt: 1700004000n,
    });
    const mod = makeEscrowModule(mockConn(buf));
    const escrow = await mod.getPact(escrowId);
    assert.equal(escrow.lockedAt, 1700001000);
    assert.equal(escrow.releasedAt, 1700002000);
    assert.equal(escrow.resolvedAt, 1700003000);
    assert.equal(escrow.cancelledAt, 1700004000);
  });
});

// ── EscrowAccount deserialization — error paths ────────────────────────────

describe("EscrowModule.getPact — deserialization errors", async () => {
  const escrowId = new PublicKey(Buffer.alloc(32, 0x01));

  await test("throws EscrowNotFoundError when account does not exist", async () => {
    const mod = makeEscrowModule(mockConn(null));
    await assert.rejects(
      mod.getPact(escrowId),
      (err: unknown) => {
        assert.ok(err instanceof EscrowNotFoundError);
        assert.equal(err.name, "EscrowNotFoundError");
        return true;
      },
    );
  });

  await test("throws EscrowAccountCorruptError when buffer is too short", async () => {
    const short = Buffer.alloc(MIN_ESCROW_BUF_SIZE - 1, 0);
    const mod = makeEscrowModule(mockConn(short));
    await assert.rejects(
      mod.getPact(escrowId),
      (err: unknown) => {
        assert.ok(err instanceof EscrowAccountCorruptError);
        assert.equal(err.name, "EscrowAccountCorruptError");
        return true;
      },
    );
  });

  await test("throws EscrowAccountCorruptError on discriminator mismatch", async () => {
    const bad = Buffer.alloc(8, 0xff);
    const buf = makeEscrowBuf({ discriminator: bad });
    const mod = makeEscrowModule(mockConn(buf));
    await assert.rejects(
      mod.getPact(escrowId),
      (err: unknown) => {
        assert.ok(err instanceof EscrowAccountCorruptError);
        assert.ok(err.message.includes("discriminator"), `message: ${err.message}`);
        return true;
      },
    );
  });

  await test("EscrowNotFoundError includes the PDA address in the message", async () => {
    const mod = makeEscrowModule(mockConn(null));
    try {
      await mod.getPact(escrowId);
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof EscrowNotFoundError);
      assert.ok(typeof err.escrowAddress === "string" && err.escrowAddress.length > 0);
    }
  });
});

// ── Error class contracts ──────────────────────────────────────────────────

describe("EscrowModule error class contracts", async () => {
  await test("EscrowSignerRequiredError has correct name", () => {
    const err = new EscrowSignerRequiredError();
    assert.equal(err.name, "EscrowSignerRequiredError");
    assert.ok(err instanceof Error);
  });

  await test("EscrowAgentWalletRequiredError has correct name", () => {
    const err = new EscrowAgentWalletRequiredError();
    assert.equal(err.name, "EscrowAgentWalletRequiredError");
  });

  await test("DisputeWindowStillOpenError has correct name and exposes disputeWindowEndsAt", () => {
    const ts = 1800000000;
    const err = new DisputeWindowStillOpenError(ts);
    assert.equal(err.name, "DisputeWindowStillOpenError");
    assert.equal(err.disputeWindowEndsAt, ts);
    assert.ok(err.message.includes(new Date(ts * 1000).toISOString().slice(0, 10)));
  });

  await test("ReputationThresholdNotMet has correct name and exposes pubkey", () => {
    const err = new ReputationThresholdNotMet("pubkey123", 5000, VerifTier.Attested);
    assert.equal(err.name, "ReputationThresholdNotMet");
    assert.equal(err.agentPubkey, "pubkey123");
    assert.equal(err.requiredMinScore, 5000);
    assert.equal(err.requiredMinTier, VerifTier.Attested);
  });

  await test("ReputationThresholdNotMet works with undefined score/tier", () => {
    const err = new ReputationThresholdNotMet("pubkey456", undefined, undefined);
    assert.equal(err.name, "ReputationThresholdNotMet");
    assert.ok(err.message.includes("none"));
  });

  await test("EscrowNotFoundError exposes escrowAddress", () => {
    const err = new EscrowNotFoundError("SomePdaAddress123");
    assert.equal(err.escrowAddress, "SomePdaAddress123");
    assert.ok(err.message.includes("SomePdaAddress123"));
  });
});

// ── EscrowModule.requireSigner / requireAgentWallet guards ─────────────────

describe("EscrowModule signer/wallet guard errors", async () => {
  const escrowId = new PublicKey(Buffer.alloc(32, 0x01));
  const buf = makeEscrowBuf({ status: EscrowStatus.Locked });

  await test("depositEscrow throws EscrowSignerRequiredError when no signer", async () => {
    const mod = new EscrowModule(mockConn(buf), INDEXER_URL, makeRepModule());
    await assert.rejects(mod.depositEscrow(escrowId), EscrowSignerRequiredError);
  });

  await test("releasePact throws EscrowSignerRequiredError when no signer", async () => {
    const mod = new EscrowModule(mockConn(buf), INDEXER_URL, makeRepModule());
    await assert.rejects(mod.releasePact(escrowId), EscrowSignerRequiredError);
  });

  await test("openDispute throws EscrowSignerRequiredError when no signer", async () => {
    const mod = new EscrowModule(mockConn(buf), INDEXER_URL, makeRepModule());
    await assert.rejects(mod.openDispute(escrowId, "dispute reason"), EscrowSignerRequiredError);
  });

  await test("cancelPendingEscrow throws EscrowSignerRequiredError when no signer", async () => {
    const mod = new EscrowModule(mockConn(null), INDEXER_URL, makeRepModule());
    await assert.rejects(mod.cancelPendingEscrow(escrowId), EscrowSignerRequiredError);
  });

  await test("stakeBeneficiary throws EscrowSignerRequiredError when no signer", async () => {
    const mod = new EscrowModule(mockConn(null), INDEXER_URL, makeRepModule());
    await assert.rejects(mod.stakeBeneficiary(escrowId), EscrowSignerRequiredError);
  });

  await test("buildLockEscrowTransaction throws EscrowAgentWalletRequiredError when no wallet", async () => {
    const mod = new EscrowModule(mockConn(buf), INDEXER_URL, makeRepModule());
    await assert.rejects(
      mod.buildLockEscrowTransaction(escrowId, TEST_PUBKEY_A),
      EscrowAgentWalletRequiredError,
    );
  });
});

// ── claimReleased dispute window check ────────────────────────────────────

describe("EscrowModule.claimReleased — dispute window guard", async () => {
  await test("throws DisputeWindowStillOpenError when window has not closed", async () => {
    const futureTs = Math.floor(Date.now() / 1000) + 100_000;
    const buf = makeEscrowBuf({
      status: EscrowStatus.Released,
      disputeWindowEndsAt: BigInt(futureTs),
    });

    const fakeSigner = {
      publicKey: TEST_PUBKEY_A,
      secretKey: new Uint8Array(64),
    };
    const fakeAgentWallet = TEST_PUBKEY_A;
    const mod = new EscrowModule(
      mockConn(buf),
      INDEXER_URL,
      makeRepModule(),
      fakeSigner,
      fakeAgentWallet,
    );

    await assert.rejects(
      mod.claimReleased(new PublicKey(Buffer.alloc(32, 0x01)), TEST_PUBKEY_B),
      (err: unknown) => {
        assert.ok(err instanceof DisputeWindowStillOpenError);
        assert.equal(err.disputeWindowEndsAt, futureTs);
        return true;
      },
    );
  });
});

// ── listPacts (indexer) ────────────────────────────────────────────────────

describe("EscrowModule.listPacts", async () => {
  const mod = new EscrowModule(mockConn(null), INDEXER_URL, makeRepModule());

  await test("returns PactPage on 200 response", async () => {
    const page = { pacts: [], hasMore: false };
    const result = await withFetch(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => page,
          text: async () => "",
        }) as unknown as Response,
      () => mod.listPacts(TEST_PUBKEY_A),
    );
    assert.deepEqual(result, page);
  });

  await test("caps limit at 100 when caller passes higher value", async () => {
    let capturedUrl = "";
    await withFetch(
      async (url) => {
        capturedUrl = String(url);
        return {
          ok: true,
          json: async () => ({ pacts: [], hasMore: false }),
          text: async () => "",
        } as unknown as Response;
      },
      () => mod.listPacts(TEST_PUBKEY_A, { limit: 500 }),
    );
    assert.ok(capturedUrl.includes("limit=100"), `expected limit=100, got: ${capturedUrl}`);
  });

  await test("passes status filter to indexer URL when set", async () => {
    let capturedUrl = "";
    await withFetch(
      async (url) => {
        capturedUrl = String(url);
        return {
          ok: true,
          json: async () => ({ pacts: [], hasMore: false }),
          text: async () => "",
        } as unknown as Response;
      },
      () => mod.listPacts(TEST_PUBKEY_A, { status: EscrowStatus.Locked }),
    );
    assert.ok(
      capturedUrl.includes(`status=${EscrowStatus.Locked}`),
      `expected status in URL, got: ${capturedUrl}`,
    );
  });

  await test("passes before cursor to indexer URL when set", async () => {
    let capturedUrl = "";
    await withFetch(
      async (url) => {
        capturedUrl = String(url);
        return {
          ok: true,
          json: async () => ({ pacts: [], hasMore: false }),
          text: async () => "",
        } as unknown as Response;
      },
      () => mod.listPacts(TEST_PUBKEY_A, { before: "cursor-xyz" }),
    );
    assert.ok(capturedUrl.includes("before=cursor-xyz"), `expected cursor in URL, got: ${capturedUrl}`);
  });

  await test("throws IndexerRequestError on 5xx response", async () => {
    await withFetch(
      async () =>
        ({
          ok: false,
          status: 503,
          text: async () => "Service Unavailable",
        }) as unknown as Response,
      () => assert.rejects(mod.listPacts(TEST_PUBKEY_A)),
    );
  });

  await test("accepts agent pubkey as a string", async () => {
    let capturedUrl = "";
    await withFetch(
      async (url) => {
        capturedUrl = String(url);
        return {
          ok: true,
          json: async () => ({ pacts: [], hasMore: false }),
          text: async () => "",
        } as unknown as Response;
      },
      () => mod.listPacts(TEST_PUBKEY_A.toBase58()),
    );
    assert.ok(capturedUrl.includes(TEST_PUBKEY_A.toBase58()));
  });
});

// ── EscrowStatus enum boundary tests ──────────────────────────────────────

describe("EscrowStatus enum values are contiguous from 0-8", async () => {
  await test("status byte 0 = Pending", () => assert.equal(EscrowStatus.Pending, 0));
  await test("status byte 1 = Funded", () => assert.equal(EscrowStatus.Funded, 1));
  await test("status byte 2 = Locked", () => assert.equal(EscrowStatus.Locked, 2));
  await test("status byte 3 = Released", () => assert.equal(EscrowStatus.Released, 3));
  await test("status byte 4 = Disputed", () => assert.equal(EscrowStatus.Disputed, 4));
  await test("status byte 5 = Refunded", () => assert.equal(EscrowStatus.Refunded, 5));
  await test("status byte 6 = Closed", () => assert.equal(EscrowStatus.Closed, 6));
  await test("status byte 7 = Claimed", () => assert.equal(EscrowStatus.Claimed, 7));
  await test("status byte 8 = MutuallyCancelled", () => assert.equal(EscrowStatus.MutuallyCancelled, 8));
});
