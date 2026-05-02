/**
 * Unit tests for SDK resilience utilities (CAS-181).
 * Run: node --import tsx/esm --test tests/resilience.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionExpiredBlockheightExceededError,
} from "@solana/web3.js";
import { sendAndConfirmWithRetry, HoldfastSdkError } from "../src/resilience.js";
import { ReputationModule } from "../src/reputation/index.js";

// ── helpers ────────────────────────────────────────────────────────────

let bhSeq = 0;

function mockConn(
  overrides: Partial<{
    getLatestBlockhash: Connection["getLatestBlockhash"];
    getAccountInfo: Connection["getAccountInfo"];
  }> = {},
): Connection {
  return {
    getLatestBlockhash: async () => ({
      blockhash: `test-bh-${bhSeq++}`,
      lastValidBlockHeight: 9999,
    }),
    ...overrides,
  } as unknown as Connection;
}

const ZERO_PUBKEY = new PublicKey(new Uint8Array(32));

function makeTx(): Transaction {
  const tx = new Transaction();
  tx.feePayer = ZERO_PUBKEY;
  return tx;
}

// Builds a minimal valid on-chain ReputationAccount buffer (512 bytes).
function makeRepBuf(historyLen = 0): Buffer {
  const buf = Buffer.alloc(512, 0);
  // discriminator: sha256("account:ReputationAccount")[0..8]
  Buffer.from([19, 185, 177, 157, 34, 87, 67, 233]).copy(buf, 0);
  // schema_version = 1
  buf.writeUInt8(1, 8);
  // score = 5000 (basis points) at offset 41
  buf.writeBigUInt64LE(5000n, 41);
  // historyLen (offset 98), historyHead (offset 99)
  buf.writeUInt8(historyLen, 98);
  buf.writeUInt8(0, 99);
  return buf;
}

// ── sendAndConfirmWithRetry ────────────────────────────────────────────

describe("sendAndConfirmWithRetry", async () => {
  await test("succeeds on first attempt", async () => {
    const sig = await sendAndConfirmWithRetry(mockConn(), makeTx(), [], {
      _sendFn: async () => "sig-ok",
    });
    assert.equal(sig, "sig-ok");
  });

  await test("retries on TransactionExpiredBlockheightExceededError and succeeds", async () => {
    let calls = 0;
    const sig = await sendAndConfirmWithRetry(mockConn(), makeTx(), [], {
      baseDelayMs: 0,
      _sendFn: async () => {
        calls++;
        if (calls === 1)
          throw new TransactionExpiredBlockheightExceededError("test-sig-1");
        return "sig-retry-ok";
      },
    });
    assert.equal(sig, "sig-retry-ok");
    assert.equal(calls, 2);
  });

  await test("re-fetches a distinct blockhash on each retry", async () => {
    const seenBlockhashes: string[] = [];
    let sendCalls = 0;

    // Each getLatestBlockhash call returns a unique blockhash.
    let seq = 0;
    const conn = {
      getLatestBlockhash: async () => ({
        blockhash: `bh-${seq++}`,
        lastValidBlockHeight: 9999,
      }),
    } as unknown as Connection;

    await sendAndConfirmWithRetry(conn, makeTx(), [], {
      baseDelayMs: 0,
      _sendFn: async (_c, txArg) => {
        seenBlockhashes.push(txArg.recentBlockhash ?? "");
        sendCalls++;
        if (sendCalls === 1)
          throw new TransactionExpiredBlockheightExceededError("test-sig-2");
        return "sig";
      },
    });

    assert.equal(seenBlockhashes.length, 2);
    assert.notEqual(seenBlockhashes[0], seenBlockhashes[1], "blockhash should differ per attempt");
  });

  await test("throws HoldfastSdkError after exhausting all retries", async () => {
    await assert.rejects(
      sendAndConfirmWithRetry(mockConn(), makeTx(), [], {
        attempts: 2,
        baseDelayMs: 0,
        _sendFn: async () => {
          throw new TransactionExpiredBlockheightExceededError("test-sig-3");
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof HoldfastSdkError, "should throw HoldfastSdkError");
        assert.ok(
          err.cause instanceof TransactionExpiredBlockheightExceededError,
          `cause should be the original error, got: ${String(err.cause)}`,
        );
        return true;
      },
    );
  });

  await test("does not retry on non-retryable errors", async () => {
    let calls = 0;
    await assert.rejects(
      sendAndConfirmWithRetry(mockConn(), makeTx(), [], {
        _sendFn: async () => {
          calls++;
          throw new Error("simulation failed: insufficient funds");
        },
      }),
      HoldfastSdkError,
    );
    assert.equal(calls, 1, "should not retry non-retryable error");
  });

  await test("retries on HTTP 429 rate-limit error", async () => {
    let calls = 0;
    const sig = await sendAndConfirmWithRetry(mockConn(), makeTx(), [], {
      baseDelayMs: 0,
      _sendFn: async () => {
        calls++;
        if (calls === 1) throw new Error("RPC error: 429 Too Many Requests");
        return "sig-after-rate-limit";
      },
    });
    assert.equal(sig, "sig-after-rate-limit");
    assert.equal(calls, 2);
  });
});

// ── ReputationModule.getHistoryWithFallback ────────────────────────────

describe("ReputationModule.getHistoryWithFallback", async () => {
  const INDEXER_URL = "http://indexer.test";
  const TEST_AGENT = "So11111111111111111111111111111111111111112";

  const originalFetch = global.fetch;

  function withFetch<T>(mock: typeof global.fetch, fn: () => Promise<T>): Promise<T> {
    global.fetch = mock;
    return fn().finally(() => { global.fetch = originalFetch; });
  }

  await test("returns indexer data when indexer is healthy", async () => {
    const mockPage = { entries: [], total: 0, hasMore: false };
    const mod = new ReputationModule(mockConn(), INDEXER_URL);

    const result = await withFetch(
      async (_url) =>
        ({ ok: true, status: 200, json: async () => mockPage, text: async () => "" } as unknown as Response),
      () => mod.getHistoryWithFallback(TEST_AGENT),
    );

    assert.deepEqual(result, mockPage);
  });

  await test("falls back to on-chain ring buffer on indexer 503", async () => {
    const repBuf = makeRepBuf(0);
    const conn = mockConn({
      getAccountInfo: async () => ({
        data: repBuf,
        executable: false,
        lamports: 1_000_000,
        owner: new PublicKey("2chF47DbqehX3L38874e2RznaSs46vpcMPEPRYz4Dywq"),
        rentEpoch: 0,
      }),
    });
    const mod = new ReputationModule(conn, INDEXER_URL);

    const result = await withFetch(
      async (_url) =>
        ({ ok: false, status: 503, text: async () => "Service Unavailable" } as unknown as Response),
      () => mod.getHistoryWithFallback(TEST_AGENT),
    );

    assert.ok(Array.isArray(result.entries), "entries must be an array");
    assert.equal(result.total, 0);
    assert.equal(result.hasMore, false);
  });

  await test("does NOT fall back on 4xx client errors", async () => {
    const mod = new ReputationModule(mockConn(), INDEXER_URL);

    await withFetch(
      async (_url) =>
        ({ ok: false, status: 401, text: async () => "Unauthorized" } as unknown as Response),
      () =>
        assert.rejects(
          mod.getHistoryWithFallback(TEST_AGENT),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.ok(
              err.message.includes("HTTP 401"),
              `Expected HTTP 401 error, got: ${err.message}`,
            );
            return true;
          },
        ),
    );
  });
});
