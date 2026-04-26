import {
  Connection,
  Transaction,
  Signer,
  sendAndConfirmTransaction,
  TransactionExpiredBlockheightExceededError,
  type Commitment,
} from "@solana/web3.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── HoldfastSdkError ─────────────────────────────────────────────────

export class HoldfastSdkError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "HoldfastSdkError";
  }
}

// ── sendAndConfirmWithRetry ───────────────────────────────────────────

type SendFn = (
  conn: Connection,
  tx: Transaction,
  signers: Signer[],
) => Promise<string>;

export interface RetryOptions {
  /** Maximum number of send attempts. Default: 3. */
  attempts?: number;
  /** Base delay in milliseconds for exponential backoff. Default: 500. */
  baseDelayMs?: number;
  /**
   * @internal Test-only override for the underlying send function.
   * Not part of the public API — subject to removal without notice.
   */
  _sendFn?: SendFn;
}

/**
 * Submit a transaction with automatic retry on `TransactionExpiredBlockheightExceededError`
 * and RPC rate-limit errors (HTTP 429). Re-fetches a fresh blockhash before each attempt
 * and clears stale signatures so the transaction is re-signed correctly.
 *
 * @throws {HoldfastSdkError} after all attempts are exhausted, wrapping the last error
 *   in `cause`.
 */
export async function sendAndConfirmWithRetry(
  connection: Connection,
  tx: Transaction,
  signers: Signer[],
  options: RetryOptions = {},
): Promise<string> {
  const maxAttempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sendFn: SendFn = options._sendFn ?? sendAndConfirmTransaction;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    // Clear stale signatures so the tx is re-signed with the fresh blockhash.
    tx.signatures = [];

    try {
      return await sendFn(connection, tx, signers);
    } catch (err) {
      lastError = err;
      const isRetryable =
        err instanceof TransactionExpiredBlockheightExceededError ||
        (err instanceof Error &&
          /429|too many requests|rate.?limit/i.test(err.message));

      if (!isRetryable || attempt === maxAttempts) break;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }

  throw new HoldfastSdkError(
    `Transaction failed after ${maxAttempts} attempt(s)`,
    lastError,
    false,
  );
}

// ── pollTxStatus ──────────────────────────────────────────────────────

export interface PollOptions {
  /** RPC commitment level to wait for. Default: "confirmed". */
  commitment?: Commitment;
  /** Maximum wall-clock time to wait in milliseconds. Default: 60000. */
  timeoutMs?: number;
  /** Polling interval in milliseconds. Default: 2000. */
  intervalMs?: number;
}

export interface TxStatus {
  confirmed: boolean;
  slot?: number;
  err?: unknown;
}

const CONF_ORDER = ["processed", "confirmed", "finalized"] as const;
type ConfStatus = (typeof CONF_ORDER)[number];

function meetsCommitment(status: ConfStatus, target: Commitment): boolean {
  const statusIdx = CONF_ORDER.indexOf(status);
  const targetIdx = CONF_ORDER.indexOf(target as ConfStatus);
  // Unknown commitment strings: require exact match.
  if (targetIdx === -1) return status === (target as string);
  return statusIdx >= targetIdx;
}

/**
 * Poll for transaction confirmation with configurable commitment level and timeout.
 * Returns immediately when the transaction fails on-chain (returns `{ confirmed: false, err }`).
 *
 * @throws {HoldfastSdkError} (retryable: true) when the timeout is reached before
 *   the transaction reaches the requested commitment level.
 */
export async function pollTxStatus(
  connection: Connection,
  sig: string,
  options: PollOptions = {},
): Promise<TxStatus> {
  const commitment = options.commitment ?? "confirmed";
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await connection.getSignatureStatus(sig);
    if (result.value !== null) {
      if (result.value.err) {
        return { confirmed: false, err: result.value.err };
      }
      const confStatus = result.value.confirmationStatus;
      if (confStatus && meetsCommitment(confStatus, commitment)) {
        return { confirmed: true, slot: result.context.slot };
      }
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
  }

  throw new HoldfastSdkError(
    `pollTxStatus: transaction ${sig} not confirmed within ${timeoutMs}ms`,
    undefined,
    true,
  );
}
