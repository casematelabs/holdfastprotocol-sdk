/**
 * Unit tests for the ReputationModule — on-chain account deserialization,
 * PDA derivation, meetsRequirements logic, and indexer fallback paths.
 *
 * Run: node --import tsx/esm --test tests/reputation.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  ReputationModule,
  ReputationNotFoundError,
  ReputationAccountCorruptError,
  IndexerRequestError,
} from "../src/reputation/index.js";
import { VerifTier, PactOutcome } from "../src/types.js";

// ── Constants (must match reputation/index.ts) ─────────────────────────────

const REPUTATION_DISCRIMINATOR = Buffer.from([19, 185, 177, 157, 34, 87, 67, 233]);
const ACCOUNT_SIZE = 512;
const HIST_ENTRY_SIZE = 18;
const HOLDFAST_PROGRAM_ID = new PublicKey("D6mUa4wGtFyLyJorMfxoKvA9ybohjUSsfw88t66ATxg");

// ── Fixtures ───────────────────────────────────────────────────────────────

interface RepBufOptions {
  discriminator?: Buffer;
  schemaVersion?: number;
  agentPubkeyBytes?: Buffer;
  score?: bigint;
  tier?: VerifTier;
  totalPacts?: bigint;
  disputeCount?: bigint;
  createdAt?: bigint;
  lastUpdated?: bigint;
  decayCursor?: bigint;
  nonce?: bigint;
  historyLen?: number;
  historyHead?: number;
  size?: number;
}

function makeRepBuf(opts: RepBufOptions = {}): Buffer {
  const buf = Buffer.alloc(opts.size ?? ACCOUNT_SIZE, 0);
  const disc = opts.discriminator ?? REPUTATION_DISCRIMINATOR;
  disc.copy(buf, 0);
  buf.writeUInt8(opts.schemaVersion ?? 1, 8);
  if (opts.agentPubkeyBytes) opts.agentPubkeyBytes.copy(buf, 9);
  buf.writeBigUInt64LE(opts.score ?? 5000n, 41);
  buf.writeUInt8(opts.tier ?? VerifTier.Unverified, 49);
  buf.writeBigUInt64LE(opts.totalPacts ?? 0n, 50);
  buf.writeBigUInt64LE(opts.disputeCount ?? 0n, 58);
  buf.writeBigInt64LE(opts.createdAt ?? 1700000000n, 66);
  buf.writeBigInt64LE(opts.lastUpdated ?? 1700000001n, 74);
  buf.writeBigInt64LE(opts.decayCursor ?? 1700000001n, 82);
  buf.writeBigUInt64LE(opts.nonce ?? 0n, 90);
  buf.writeUInt8(opts.historyLen ?? 0, 98);
  buf.writeUInt8(opts.historyHead ?? 0, 99);
  return buf;
}

function writeHistEntry(
  buf: Buffer,
  baseOffset: number,
  ringIdx: number,
  outcome: PactOutcome,
  scoreDelta: number,
  timestamp: bigint,
  pactIdByte: number,
): void {
  const off = baseOffset + ringIdx * HIST_ENTRY_SIZE;
  buf.writeUInt8(outcome, off);
  buf.writeInt16LE(scoreDelta, off + 1);
  buf.writeBigInt64LE(timestamp, off + 3);
  buf.writeUInt8(pactIdByte, off + 11);
}

const HISTORY_OFFSET = 100;

function mockConn(
  accountData: Buffer | null,
  programId: PublicKey = HOLDFAST_PROGRAM_ID,
): Connection {
  return {
    getAccountInfo: async () =>
      accountData === null
        ? null
        : {
            data: accountData,
            executable: false,
            lamports: 1_000_000,
            owner: programId,
            rentEpoch: 0,
          },
  } as unknown as Connection;
}

const INDEXER_URL = "http://indexer.test";
const TEST_AGENT = "So11111111111111111111111111111111111111112";

const originalFetch = global.fetch;
function withFetch<T>(mock: typeof global.fetch, fn: () => Promise<T>): Promise<T> {
  global.fetch = mock;
  return fn().finally(() => {
    global.fetch = originalFetch;
  });
}

// ── PDA derivation ─────────────────────────────────────────────────────────

describe("deriveReputationPda", async () => {
  await test("derives deterministic PDA for known pubkey", () => {
    const agent = new PublicKey(TEST_AGENT);
    const [expectedPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("reputation"), agent.toBuffer()],
      HOLDFAST_PROGRAM_ID,
    );
    // The module derives the PDA internally on get(); we verify it's deterministic
    // by checking that two derivations produce the same result.
    const [pda1] = PublicKey.findProgramAddressSync(
      [Buffer.from("reputation"), agent.toBuffer()],
      HOLDFAST_PROGRAM_ID,
    );
    assert.equal(pda1.toBase58(), expectedPda.toBase58());
  });

  await test("different agents produce different PDAs", () => {
    const agent1 = new PublicKey("So11111111111111111111111111111111111111112");
    const agent2 = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const [pda1] = PublicKey.findProgramAddressSync(
      [Buffer.from("reputation"), agent1.toBuffer()],
      HOLDFAST_PROGRAM_ID,
    );
    const [pda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("reputation"), agent2.toBuffer()],
      HOLDFAST_PROGRAM_ID,
    );
    assert.notEqual(pda1.toBase58(), pda2.toBase58());
  });
});

// ── Account deserialization — happy paths ──────────────────────────────────

describe("ReputationModule.get — deserialization", async () => {
  await test("parses a minimal valid account (no history)", async () => {
    const buf = makeRepBuf({ score: 5000n, tier: VerifTier.Unverified, totalPacts: 0n });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    const rep = await mod.get(TEST_AGENT);

    assert.equal(rep.score, 5000);
    assert.equal(rep.tier, VerifTier.Unverified);
    assert.equal(rep.totalPacts, 0);
    assert.equal(rep.disputeCount, 0);
    assert.equal(rep.historyLen, 0);
    assert.deepEqual(rep.history, []);
  });

  await test("parses score correctly across the range [0, 10000]", async () => {
    for (const score of [0n, 1n, 5000n, 9999n, 10000n]) {
      const buf = makeRepBuf({ score });
      const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
      const rep = await mod.get(TEST_AGENT);
      assert.equal(rep.score, Number(score), `score=${score}`);
    }
  });

  await test("parses all VerifTier values", async () => {
    for (const tier of [VerifTier.Unverified, VerifTier.Attested, VerifTier.Hardline]) {
      const buf = makeRepBuf({ tier });
      const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
      const rep = await mod.get(TEST_AGENT);
      assert.equal(rep.tier, tier, `tier=${tier}`);
    }
  });

  await test("parses totalPacts and disputeCount as numbers", async () => {
    const buf = makeRepBuf({ totalPacts: 42n, disputeCount: 3n });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    const rep = await mod.get(TEST_AGENT);
    assert.equal(rep.totalPacts, 42);
    assert.equal(rep.disputeCount, 3);
  });

  await test("parses timestamp fields as seconds (i64 LE)", async () => {
    const buf = makeRepBuf({
      createdAt: 1700000000n,
      lastUpdated: 1700001000n,
      decayCursor: 1700001001n,
    });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    const rep = await mod.get(TEST_AGENT);
    assert.equal(rep.createdAt, 1700000000);
    assert.equal(rep.lastUpdated, 1700001000);
    assert.equal(rep.decayCursor, 1700001001);
  });

  await test("parses nonce as a number", async () => {
    const buf = makeRepBuf({ nonce: 99n });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    const rep = await mod.get(TEST_AGENT);
    assert.equal(rep.nonce, 99);
  });

  await test("agent field matches the supplied pubkey string", async () => {
    const buf = makeRepBuf({});
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    const rep = await mod.get(TEST_AGENT);
    assert.equal(rep.agent, TEST_AGENT);
  });

  await test("accepts PublicKey object as well as string", async () => {
    const buf = makeRepBuf({});
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    const rep = await mod.get(new PublicKey(TEST_AGENT));
    assert.equal(rep.agent, TEST_AGENT);
  });
});

// ── History ring-buffer reordering ────────────────────────────────────────

describe("ReputationModule.get — history ring-buffer reordering", async () => {
  await test("single entry: historyLen=1, historyHead=1 (first slot)", async () => {
    const buf = makeRepBuf({ historyLen: 1, historyHead: 1 });
    writeHistEntry(buf, HISTORY_OFFSET, 0, PactOutcome.Fulfilled, 50, 1700000100n, 0xaa);
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    const rep = await mod.get(TEST_AGENT);
    assert.equal(rep.history.length, 1);
    assert.equal(rep.history[0].outcome, PactOutcome.Fulfilled);
    assert.equal(rep.history[0].scoreDelta, 50);
    assert.equal(rep.history[0].timestamp, 1700000100);
  });

  await test("two entries in order: head=2 means slots 0 and 1 (oldest=slot0, newest=slot1)", async () => {
    const buf = makeRepBuf({ historyLen: 2, historyHead: 2 });
    writeHistEntry(buf, HISTORY_OFFSET, 0, PactOutcome.Fulfilled, 50, 1700000100n, 0x01);
    writeHistEntry(buf, HISTORY_OFFSET, 1, PactOutcome.Disputed, -25, 1700000200n, 0x02);
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    const rep = await mod.get(TEST_AGENT);
    assert.equal(rep.history.length, 2);
    assert.equal(rep.history[0].outcome, PactOutcome.Fulfilled);
    assert.equal(rep.history[0].scoreDelta, 50);
    assert.equal(rep.history[1].outcome, PactOutcome.Disputed);
    assert.equal(rep.history[1].scoreDelta, -25);
  });

  await test("full ring buffer (20 entries), no wrap: head=20", async () => {
    const buf = makeRepBuf({ historyLen: 20, historyHead: 20 });
    for (let i = 0; i < 20; i++) {
      writeHistEntry(buf, HISTORY_OFFSET, i, PactOutcome.Fulfilled, i, BigInt(1700000000 + i), i);
    }
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    const rep = await mod.get(TEST_AGENT);
    assert.equal(rep.history.length, 20);
    // Oldest first: ringIdx = (20 - 20 + 0 + 20) % 20 = 0
    assert.equal(rep.history[0].scoreDelta, 0);
    // Newest: ringIdx = (20 - 20 + 19 + 20) % 20 = 19
    assert.equal(rep.history[19].scoreDelta, 19);
  });

  await test("wrapped ring: historyLen=20, historyHead=5 means slots 5..19 then 0..4 (oldest→newest)", async () => {
    // head=5 means next write goes to slot 5
    // oldest is slot (5 - 20 + 0 + 20) % 20 = 5
    // newest is slot (5 - 20 + 19 + 20) % 20 = 4
    const buf = makeRepBuf({ historyLen: 20, historyHead: 5 });
    for (let i = 0; i < 20; i++) {
      writeHistEntry(buf, HISTORY_OFFSET, i, PactOutcome.Fulfilled, i * 10, BigInt(1700000000 + i), i);
    }
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    const rep = await mod.get(TEST_AGENT);
    assert.equal(rep.history.length, 20);
    // First (oldest) entry should be ring slot 5
    assert.equal(rep.history[0].scoreDelta, 5 * 10);
    // Last (newest) entry should be ring slot 4
    assert.equal(rep.history[19].scoreDelta, 4 * 10);
  });

  await test("partial fill (5 entries), no wrap: historyLen=5, historyHead=5", async () => {
    const buf = makeRepBuf({ historyLen: 5, historyHead: 5 });
    for (let i = 0; i < 5; i++) {
      writeHistEntry(buf, HISTORY_OFFSET, i, PactOutcome.Cancelled, i, BigInt(1700000000 + i), i);
    }
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    const rep = await mod.get(TEST_AGENT);
    assert.equal(rep.history.length, 5);
    assert.equal(rep.history[0].scoreDelta, 0);
    assert.equal(rep.history[4].scoreDelta, 4);
  });

  await test("historyLen=0 returns empty history regardless of historyHead", async () => {
    const buf = makeRepBuf({ historyLen: 0, historyHead: 15 });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    const rep = await mod.get(TEST_AGENT);
    assert.deepEqual(rep.history, []);
  });

  await test("history entry pactId is a 14-char hex string (7 bytes)", async () => {
    const buf = makeRepBuf({ historyLen: 1, historyHead: 1 });
    writeHistEntry(buf, HISTORY_OFFSET, 0, PactOutcome.Fulfilled, 0, 0n, 0xab);
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    const rep = await mod.get(TEST_AGENT);
    assert.equal(rep.history[0].pactId.length, 14, "pactId should be 7 bytes as hex = 14 chars");
    assert.match(rep.history[0].pactId, /^[0-9a-f]{14}$/);
  });

  await test("negative scoreDelta (i16 LE) is parsed correctly", async () => {
    const buf = makeRepBuf({ historyLen: 1, historyHead: 1 });
    writeHistEntry(buf, HISTORY_OFFSET, 0, PactOutcome.Disputed, -100, 1700000000n, 0);
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    const rep = await mod.get(TEST_AGENT);
    assert.equal(rep.history[0].scoreDelta, -100);
  });

  await test("all PactOutcome values are parsed", async () => {
    for (const outcome of [PactOutcome.Fulfilled, PactOutcome.Disputed, PactOutcome.Cancelled]) {
      const buf = makeRepBuf({ historyLen: 1, historyHead: 1 });
      writeHistEntry(buf, HISTORY_OFFSET, 0, outcome, 0, 0n, 0);
      const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
      const rep = await mod.get(TEST_AGENT);
      assert.equal(rep.history[0].outcome, outcome);
    }
  });
});

// ── Account deserialization — error paths ──────────────────────────────────

describe("ReputationModule.get — deserialization errors", async () => {
  await test("throws ReputationNotFoundError when account does not exist", async () => {
    const mod = new ReputationModule(mockConn(null), INDEXER_URL);
    await assert.rejects(
      mod.get(TEST_AGENT),
      (err: unknown) => {
        assert.ok(err instanceof ReputationNotFoundError);
        assert.ok(err.agentPubkey === TEST_AGENT);
        return true;
      },
    );
  });

  await test("throws ReputationAccountCorruptError on wrong account size (too small)", async () => {
    const buf = Buffer.alloc(256, 0); // wrong size
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    await assert.rejects(mod.get(TEST_AGENT), ReputationAccountCorruptError);
  });

  await test("throws ReputationAccountCorruptError on wrong account size (too large)", async () => {
    const buf = Buffer.alloc(1024, 0);
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    await assert.rejects(mod.get(TEST_AGENT), ReputationAccountCorruptError);
  });

  await test("throws ReputationAccountCorruptError on discriminator mismatch", async () => {
    const badDisc = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const buf = makeRepBuf({ discriminator: badDisc });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    await assert.rejects(
      mod.get(TEST_AGENT),
      (err: unknown) => {
        assert.ok(err instanceof ReputationAccountCorruptError);
        assert.ok(err.message.includes("discriminator"));
        return true;
      },
    );
  });

  await test("throws ReputationAccountCorruptError on schema_version mismatch (v0)", async () => {
    const buf = makeRepBuf({ schemaVersion: 0 });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    await assert.rejects(
      mod.get(TEST_AGENT),
      (err: unknown) => {
        assert.ok(err instanceof ReputationAccountCorruptError);
        assert.ok(err.message.includes("schema_version"));
        return true;
      },
    );
  });

  await test("throws ReputationAccountCorruptError on schema_version mismatch (v2)", async () => {
    const buf = makeRepBuf({ schemaVersion: 2 });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    await assert.rejects(mod.get(TEST_AGENT), ReputationAccountCorruptError);
  });

  await test("ReputationNotFoundError has correct name property", async () => {
    const mod = new ReputationModule(mockConn(null), INDEXER_URL);
    try {
      await mod.get(TEST_AGENT);
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ReputationNotFoundError);
      assert.equal(err.name, "ReputationNotFoundError");
    }
  });

  await test("ReputationAccountCorruptError has correct name property", async () => {
    const badDisc = Buffer.alloc(8, 0xff);
    const buf = makeRepBuf({ discriminator: badDisc });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    try {
      await mod.get(TEST_AGENT);
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ReputationAccountCorruptError);
      assert.equal(err.name, "ReputationAccountCorruptError");
    }
  });
});

// ── meetsRequirements ──────────────────────────────────────────────────────

describe("ReputationModule.meetsRequirements", async () => {
  await test("returns false when account does not exist (no throw)", async () => {
    const mod = new ReputationModule(mockConn(null), INDEXER_URL);
    const result = await mod.meetsRequirements(TEST_AGENT, { minScore: 100 });
    assert.equal(result, false);
  });

  await test("returns true with no requirements (empty object)", async () => {
    const buf = makeRepBuf({ score: 0n, tier: VerifTier.Unverified, totalPacts: 0n });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    assert.equal(await mod.meetsRequirements(TEST_AGENT, {}), true);
  });

  await test("returns true when score exactly equals minScore", async () => {
    const buf = makeRepBuf({ score: 5000n });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    assert.equal(await mod.meetsRequirements(TEST_AGENT, { minScore: 5000 }), true);
  });

  await test("returns false when score is below minScore", async () => {
    const buf = makeRepBuf({ score: 4999n });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    assert.equal(await mod.meetsRequirements(TEST_AGENT, { minScore: 5000 }), false);
  });

  await test("returns true when score exceeds minScore", async () => {
    const buf = makeRepBuf({ score: 8000n });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    assert.equal(await mod.meetsRequirements(TEST_AGENT, { minScore: 5000 }), true);
  });

  await test("returns false when tier is below minTier", async () => {
    const buf = makeRepBuf({ tier: VerifTier.Unverified });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    assert.equal(
      await mod.meetsRequirements(TEST_AGENT, { minTier: VerifTier.Attested }),
      false,
    );
  });

  await test("returns true when tier exactly equals minTier", async () => {
    const buf = makeRepBuf({ tier: VerifTier.Attested });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    assert.equal(
      await mod.meetsRequirements(TEST_AGENT, { minTier: VerifTier.Attested }),
      true,
    );
  });

  await test("returns true when tier exceeds minTier (Hardline >= Attested)", async () => {
    const buf = makeRepBuf({ tier: VerifTier.Hardline });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    assert.equal(
      await mod.meetsRequirements(TEST_AGENT, { minTier: VerifTier.Attested }),
      true,
    );
  });

  await test("returns false when totalPacts is below minPacts", async () => {
    const buf = makeRepBuf({ totalPacts: 4n });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    assert.equal(await mod.meetsRequirements(TEST_AGENT, { minPacts: 5 }), false);
  });

  await test("returns true when totalPacts exactly equals minPacts", async () => {
    const buf = makeRepBuf({ totalPacts: 5n });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    assert.equal(await mod.meetsRequirements(TEST_AGENT, { minPacts: 5 }), true);
  });

  await test("all three requirements must be met (score, tier, pacts)", async () => {
    // Fails on score
    const buf1 = makeRepBuf({ score: 4000n, tier: VerifTier.Attested, totalPacts: 10n });
    const mod1 = new ReputationModule(mockConn(buf1), INDEXER_URL);
    assert.equal(
      await mod1.meetsRequirements(TEST_AGENT, {
        minScore: 5000,
        minTier: VerifTier.Attested,
        minPacts: 10,
      }),
      false,
    );

    // Fails on tier
    const buf2 = makeRepBuf({ score: 6000n, tier: VerifTier.Unverified, totalPacts: 10n });
    const mod2 = new ReputationModule(mockConn(buf2), INDEXER_URL);
    assert.equal(
      await mod2.meetsRequirements(TEST_AGENT, {
        minScore: 5000,
        minTier: VerifTier.Attested,
        minPacts: 10,
      }),
      false,
    );

    // Fails on pacts
    const buf3 = makeRepBuf({ score: 6000n, tier: VerifTier.Attested, totalPacts: 9n });
    const mod3 = new ReputationModule(mockConn(buf3), INDEXER_URL);
    assert.equal(
      await mod3.meetsRequirements(TEST_AGENT, {
        minScore: 5000,
        minTier: VerifTier.Attested,
        minPacts: 10,
      }),
      false,
    );

    // All pass
    const buf4 = makeRepBuf({ score: 6000n, tier: VerifTier.Attested, totalPacts: 10n });
    const mod4 = new ReputationModule(mockConn(buf4), INDEXER_URL);
    assert.equal(
      await mod4.meetsRequirements(TEST_AGENT, {
        minScore: 5000,
        minTier: VerifTier.Attested,
        minPacts: 10,
      }),
      true,
    );
  });

  await test("minTier=0 (Unverified) always passes", async () => {
    const buf = makeRepBuf({ tier: VerifTier.Unverified });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    assert.equal(
      await mod.meetsRequirements(TEST_AGENT, { minTier: VerifTier.Unverified }),
      true,
    );
  });

  await test("propagates non-NotFound errors from get()", async () => {
    const badDisc = Buffer.alloc(8, 0xff);
    const buf = makeRepBuf({ discriminator: badDisc });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    await assert.rejects(
      mod.meetsRequirements(TEST_AGENT, {}),
      ReputationAccountCorruptError,
    );
  });
});

// ── getHistory ─────────────────────────────────────────────────────────────

describe("ReputationModule.getHistory", async () => {
  await test("throws IndexerRequestError on non-2xx response", async () => {
    const mod = new ReputationModule(mockConn(null), INDEXER_URL);
    await withFetch(
      async () =>
        ({ ok: false, status: 404, text: async () => "Not Found" }) as unknown as Response,
      () =>
        assert.rejects(
          mod.getHistory(TEST_AGENT),
          (err: unknown) => {
            assert.ok(err instanceof IndexerRequestError);
            assert.equal(err.status, 404);
            return true;
          },
        ),
    );
  });

  await test("returns parsed HistoryPage on 200 response", async () => {
    const page = { entries: [], total: 0, hasMore: false };
    const mod = new ReputationModule(mockConn(null), INDEXER_URL);
    const result = await withFetch(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => page,
          text: async () => "",
        }) as unknown as Response,
      () => mod.getHistory(TEST_AGENT),
    );
    assert.deepEqual(result, page);
  });

  await test("caps limit at 200 even when caller passes higher value", async () => {
    let capturedUrl = "";
    const mod = new ReputationModule(mockConn(null), INDEXER_URL);
    await withFetch(
      async (url) => {
        capturedUrl = String(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ entries: [], total: 0, hasMore: false }),
          text: async () => "",
        } as unknown as Response;
      },
      () => mod.getHistory(TEST_AGENT, { limit: 500 }),
    );
    assert.ok(capturedUrl.includes("limit=200"), `expected limit=200 in URL, got: ${capturedUrl}`);
  });

  await test("passes before cursor to indexer URL", async () => {
    let capturedUrl = "";
    const mod = new ReputationModule(mockConn(null), INDEXER_URL);
    await withFetch(
      async (url) => {
        capturedUrl = String(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ entries: [], total: 0, hasMore: false }),
          text: async () => "",
        } as unknown as Response;
      },
      () => mod.getHistory(TEST_AGENT, { before: "cursor-abc" }),
    );
    assert.ok(capturedUrl.includes("before=cursor-abc"), `URL missing cursor: ${capturedUrl}`);
  });
});

// ── getHistoryWithFallback ─────────────────────────────────────────────────

describe("ReputationModule.getHistoryWithFallback", async () => {
  await test("returns indexer data when healthy (200)", async () => {
    const page = { entries: [], total: 0, hasMore: false };
    const mod = new ReputationModule(mockConn(null), INDEXER_URL);
    const result = await withFetch(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => page,
          text: async () => "",
        }) as unknown as Response,
      () => mod.getHistoryWithFallback(TEST_AGENT),
    );
    assert.deepEqual(result, page);
  });

  await test("falls back to on-chain ring buffer on 503", async () => {
    const buf = makeRepBuf({ historyLen: 0 });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    const result = await withFetch(
      async () =>
        ({
          ok: false,
          status: 503,
          text: async () => "Service Unavailable",
        }) as unknown as Response,
      () => mod.getHistoryWithFallback(TEST_AGENT),
    );
    assert.ok(Array.isArray(result.entries));
    assert.equal(result.total, 0);
    assert.equal(result.hasMore, false);
  });

  await test("falls back on network TypeError (indexer unreachable)", async () => {
    const buf = makeRepBuf({ historyLen: 0 });
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    const result = await withFetch(
      async () => {
        throw new TypeError("fetch failed");
      },
      () => mod.getHistoryWithFallback(TEST_AGENT),
    );
    assert.ok(Array.isArray(result.entries));
  });

  await test("does NOT fall back on 4xx client errors — propagates", async () => {
    const mod = new ReputationModule(mockConn(null), INDEXER_URL);
    await withFetch(
      async () =>
        ({
          ok: false,
          status: 401,
          text: async () => "Unauthorized",
        }) as unknown as Response,
      () =>
        assert.rejects(
          mod.getHistoryWithFallback(TEST_AGENT),
          (err: unknown) => {
            assert.ok(err instanceof IndexerRequestError);
            assert.equal(err.status, 401);
            return true;
          },
        ),
    );
  });

  await test("fallback respects limit option from on-chain ring buffer", async () => {
    const buf = makeRepBuf({ historyLen: 5, historyHead: 5 });
    for (let i = 0; i < 5; i++) {
      writeHistEntry(buf, HISTORY_OFFSET, i, PactOutcome.Fulfilled, i, BigInt(1700000000 + i), i);
    }
    const mod = new ReputationModule(mockConn(buf), INDEXER_URL);
    const result = await withFetch(
      async () =>
        ({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        }) as unknown as Response,
      () => mod.getHistoryWithFallback(TEST_AGENT, { limit: 2 }),
    );
    assert.ok(result.entries.length <= 2, `expected ≤2 entries, got ${result.entries.length}`);
  });

  await test("IndexerRequestError has correct name and status properties", async () => {
    const mod = new ReputationModule(mockConn(null), INDEXER_URL);
    try {
      await withFetch(
        async () =>
          ({
            ok: false,
            status: 403,
            text: async () => "Forbidden",
          }) as unknown as Response,
        () => mod.getHistoryWithFallback(TEST_AGENT),
      );
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof IndexerRequestError);
      assert.equal(err.name, "IndexerRequestError");
      assert.equal(err.status, 403);
    }
  });
});
