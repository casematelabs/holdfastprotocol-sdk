/**
 * Holdfast SDK — Quickstart: First On-Chain Transaction
 *
 * Walks through the minimal path from install to a confirmed escrow pact
 * on Solana devnet using @holdfastprotocol/sdk.
 *
 * ── Part 1: Read reputation (no signer required) ────────────────────────────
 *
 *   npx ts-node --esm examples/quickstart.ts <agent-pubkey>
 *
 * ── Part 2: Create an escrow pact (first on-chain write) ────────────────────
 *
 * Prerequisites:
 *   1. Funded devnet keypair:
 *        solana-keygen new -o ~/.config/solana/devnet.json
 *        solana airdrop 2 --url devnet
 *
 *   2. AgentWallet registration is handled automatically by the quickstart
 *      via registerAgentWallet(). No separate script needed.
 *
 *   3. Wrapped SOL (wSOL) in your token account:
 *        spl-token wrap 0.05 --fee-payer ~/.config/solana/devnet.json
 *
 * Usage:
 *   KEYPAIR_PATH=~/.config/solana/devnet.json \
 *   COUNTERPARTY=<base58-pubkey> \
 *   COUNTERPARTY_WALLET=<base58-pda> \
 *   npx ts-node --esm examples/quickstart.ts
 *
 *   For a self-pact test (same agent as both sides):
 *   KEYPAIR_PATH=~/.config/solana/devnet.json \
 *   npx ts-node --esm examples/quickstart.ts
 *
 * DEVNET ONLY — Holdfast programs have not been formally audited.
 * Not for production use. No security guarantees.
 */

import { createHoldfastClient, registerAgentWallet, VerifTier, ReputationNotFoundError, EscrowStatus } from "../src/index.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

const TIER_LABELS: Record<VerifTier, string> = {
  [VerifTier.Unverified]: "Unverified",
  [VerifTier.Attested]:   "Attested (secp256r1)",
  [VerifTier.Hardline]:   "Hardline (TEE-attested)",
};

const STATUS_LABELS: Record<EscrowStatus, string> = {
  [EscrowStatus.Pending]:  "Pending",
  [EscrowStatus.Funded]:   "Funded",
  [EscrowStatus.Locked]:   "Locked",
  [EscrowStatus.Released]: "Released",
  [EscrowStatus.Disputed]: "Disputed",
  [EscrowStatus.Refunded]: "Refunded",
  [EscrowStatus.Closed]:   "Closed",
  [EscrowStatus.Claimed]:  "Claimed",
};

function explorerAddr(addr: string): string {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}

function explorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

async function main(): Promise<void> {
  console.log("\n══ Holdfast SDK Quickstart ════════════════════════════════════");
  console.log("   DEVNET ONLY — pre-audit release, not for production use");
  console.log("══════════════════════════════════════════════════════════════\n");

  // ── Load keypair ────────────────────────────────────────────────────────────
  const keypairPath = (process.env["KEYPAIR_PATH"] ?? `${os.homedir()}/.config/solana/devnet.json`)
    .replace(/^~/, os.homedir());
  let signer: Keypair | undefined;
  if (fs.existsSync(keypairPath)) {
    const raw = JSON.parse(fs.readFileSync(keypairPath, "utf8")) as number[];
    signer = Keypair.fromSecretKey(Uint8Array.from(raw));
    console.log(`Keypair:  ${signer.publicKey.toBase58()}`);
    console.log(`Explorer: ${explorerAddr(signer.publicKey.toBase58())}`);
  }

  // Target pubkey: from arg (read-only mode), or from loaded signer
  const arg = process.argv[2];
  let targetPubkey: PublicKey;
  if (arg) {
    targetPubkey = new PublicKey(arg);
  } else if (signer) {
    targetPubkey = signer.publicKey;
  } else {
    console.error("Provide an agent pubkey as argument, or set KEYPAIR_PATH.");
    process.exit(1);
  }

  // ── Part 1: Reputation read (no signer needed) ─────────────────────────────
  console.log("\n── Part 1: Read Reputation ──────────────────────────────────");
  console.log(`Agent: ${targetPubkey.toBase58()}\n`);

  const readClient = createHoldfastClient();

  try {
    const rep = await readClient.reputation.get(targetPubkey);
    const pct = ((rep.score / 10000) * 100).toFixed(1);
    console.log(`  Score:       ${rep.score} / 10000 bp  (${pct}%)`);
    console.log(`  Tier:        ${TIER_LABELS[rep.tier]}`);
    console.log(`  Total pacts: ${rep.totalPacts}`);
    console.log(`  Disputes:    ${rep.disputeCount}`);
    if (rep.history.length > 0) {
      console.log(`\n  Recent events (${rep.history.length}):`);
      for (const e of rep.history.slice(-5)) {
        const sign = e.scoreDelta >= 0 ? "+" : "";
        const date = new Date(e.timestamp * 1000).toISOString().slice(0, 10);
        console.log(`    [${date}]  pact ${e.pactId}  ${sign}${e.scoreDelta}bp`);
      }
    }
  } catch (err) {
    if (err instanceof ReputationNotFoundError) {
      console.log("  No ReputationAccount yet — account is created on first pact sign.");
    } else {
      throw err;
    }
  }

  const eligible = await readClient.reputation.meetsRequirements(targetPubkey, { minScore: 0 });
  console.log(`\n  Requirements check (minScore=0): ${eligible ? "PASS" : "FAIL"}`);

  // ── Part 2: Create a pact (first on-chain write) ────────────────────────────
  console.log("\n── Part 2: Create Escrow Pact (on-chain write) ──────────────");

  if (!signer) {
    console.log("  Skipping: KEYPAIR_PATH not set or keypair file not found.");
    console.log("  Set KEYPAIR_PATH to a funded devnet keypair to run Part 2.");
    console.log("\nDone.\n");
    return;
  }

  // Register the agent wallet on-chain (idempotent — safe to call every run).
  console.log("  Registering AgentWallet...");
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const registration = await registerAgentWallet({ connection, signer });
  const agentWallet = registration.agentWallet;
  if (registration.signature) {
    console.log(`  ✓ AgentWallet registered: ${agentWallet.toBase58()}`);
    console.log(`  ✓ Tx: https://explorer.solana.com/tx/${registration.signature}?cluster=devnet`);
  } else {
    console.log(`  ✓ AgentWallet already registered: ${agentWallet.toBase58()}`);
  }

  // For a self-pact test, counterparty defaults to the same keypair + wallet.
  const counterpartyEnv = process.env["COUNTERPARTY"];
  const counterpartyWalletEnv = process.env["COUNTERPARTY_WALLET"];
  const counterparty = counterpartyEnv ? new PublicKey(counterpartyEnv) : signer.publicKey;
  const counterpartyWallet = counterpartyWalletEnv
    ? new PublicKey(counterpartyWalletEnv)
    : agentWallet;

  // wSOL mint — use spl-token wrap to get wSOL into your token account first.
  const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

  const writeClient = createHoldfastClient({ signer, agentWallet });

  const timeLockExpiresAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60; // 2 hours
  const amount = 10_000n; // 0.00001 wSOL (lamports) — minimal amount for devnet testing

  console.log(`  Initiator:         ${signer.publicKey.toBase58()}`);
  console.log(`  AgentWallet PDA:   ${agentWallet.toBase58()}`);
  console.log(`  Counterparty:      ${counterparty.toBase58()}`);
  console.log(`  Mint:              ${WSOL_MINT.toBase58()} (wSOL)`);
  console.log(`  Amount:            ${amount} lamports`);
  console.log(`  Time-lock:         ${new Date(timeLockExpiresAt * 1000).toISOString()}`);
  console.log(`  Release type:      task (manual release by initiator)`);
  console.log("\n  Submitting initialize_escrow transaction...");

  const pact = await writeClient.escrow.createPact({
    counterparty,
    counterpartyWallet,
    mint: WSOL_MINT,
    amount,
    releaseCondition: {
      kind: "task",
      timeLockExpiresAt,
    },
  });

  console.log("\n  ✓ Pact created!");
  console.log(`  Escrow PDA:  ${pact.address}`);
  console.log(`  Escrow ID:   ${pact.escrowId}`);
  console.log(`  Status:      ${STATUS_LABELS[pact.status]}`);
  console.log(`  Explorer:    ${explorerAddr(pact.address)}`);

  // ── Read back the pact to confirm ─────────────────────────────────────────
  console.log("\n── Part 3: Read Pact Back ───────────────────────────────────");
  const escrowIdPubkey = new PublicKey(Buffer.from(pact.escrowId, "hex"));
  const confirmed = await readClient.escrow.getPact(escrowIdPubkey);
  console.log(`  Address:    ${confirmed.address}`);
  console.log(`  Initiator:  ${confirmed.initiator}`);
  console.log(`  Status:     ${STATUS_LABELS[confirmed.status]}`);
  console.log(`  Amount:     ${confirmed.escrowAmount} lamports`);

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("   First Holdfast on-chain transaction confirmed.");
  console.log("   Next: call depositEscrow() to fund the vault.");
  console.log(`   Docs: https://docs.holdfastprotocol.com/sdk/escrow`);
  console.log("══════════════════════════════════════════════════════════════\n");
}

main().catch((err: unknown) => {
  console.error("\n[quickstart] Fatal error:", err);
  process.exit(1);
});
