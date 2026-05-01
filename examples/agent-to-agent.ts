/**
 * Holdfast SDK — Agent-to-Agent Pact Lifecycle
 *
 * Demonstrates the complete pact flow between two autonomous agents on Solana devnet:
 *   Agent A (service buyer / initiator)  →  Agent B (service provider / beneficiary)
 *
 * Steps covered:
 *   1. Both agents register AgentWallet PDAs (idempotent)
 *   2. Agent A creates the pact and deposits funds
 *   3. Agent B stakes (required even with zero stake)
 *   4. Both agents co-sign the lock transaction             ← SDK v0.2: client.escrow.lockEscrow()
 *   5. Agent A releases funds after work is accepted
 *   6. Agent B claims after the dispute window closes       ← SDK v0.2: clientB.escrow.claimReleased()
 *   7. Both agents read final reputation
 *
 * DEVNET ONLY — programs are pre-audit, not for production use.
 *
 * Usage
 * -----
 *   # Both agents on the same machine (test/demo mode)
 *   AGENT_A_KEYPAIR=~/.config/solana/agent-a.json \
 *   AGENT_B_KEYPAIR=~/.config/solana/agent-b.json \
 *   npx ts-node --esm examples/agent-to-agent.ts
 *
 *   # Fund devnet keypairs first:
 *   solana airdrop 2 --keypair ~/.config/solana/agent-a.json --url devnet
 *   solana airdrop 2 --keypair ~/.config/solana/agent-b.json --url devnet
 *   spl-token wrap 0.1 --fee-payer ~/.config/solana/agent-a.json
 *
 * In production, Agents A and B run in separate processes. For lock_escrow, they would
 * coordinate via a messaging channel to co-sign the same transaction off-chain. See
 * docs/escrow-idl-reference.md for the multi-sig coordination pattern.
 */

import {
  createHoldfastClient,
  registerAgentWallet,
  VerifTier,
  ReputationNotFoundError,
  EscrowStatus,
} from "../src/index.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

// ── Constants ─────────────────────────────────────────────────────────────
const RPC_URL = "https://api.devnet.solana.com";
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// Score labels for display
const TIER_LABEL: Record<VerifTier, string> = {
  [VerifTier.Unverified]: "Unverified",
  [VerifTier.Attested]:   "Attested",
  [VerifTier.Hardline]:   "Hardline (TEE)",
};

const STATUS_LABEL: Record<EscrowStatus, string> = {
  [EscrowStatus.Pending]:  "Pending",
  [EscrowStatus.Funded]:   "Funded",
  [EscrowStatus.Locked]:   "Locked",
  [EscrowStatus.Released]: "Released",
  [EscrowStatus.Disputed]: "Disputed",
  [EscrowStatus.Refunded]: "Refunded",
  [EscrowStatus.Claimed]:  "Claimed",
  [EscrowStatus.Closed]:   "Closed",
};

// ── Utilities ──────────────────────────────────────────────────────────────

function loadKeypair(envVar: string, fallback: string): Keypair | undefined {
  const path = (process.env[envVar] ?? fallback).replace(/^~/, os.homedir());
  if (!fs.existsSync(path)) return undefined;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8")) as number[]));
}

function explorer(addr: string, type: "address" | "tx" = "address"): string {
  return `https://explorer.solana.com/${type}/${addr}?cluster=devnet`;
}

function hr(title: string): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

async function printReputation(label: string, pubkey: PublicKey, client: ReturnType<typeof createHoldfastClient>): Promise<void> {
  try {
    const rep = await client.reputation.get(pubkey);
    const pct = ((rep.score / 10000) * 100).toFixed(1);
    console.log(`  ${label}: score=${rep.score}bp (${pct}%)  tier=${TIER_LABEL[rep.tier]}  pacts=${rep.totalPacts}  disputes=${rep.disputeCount}`);
  } catch (e) {
    if (e instanceof ReputationNotFoundError) {
      console.log(`  ${label}: no ReputationAccount yet (initialize via init_reputation first)`);
    } else throw e;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Holdfast — Agent-to-Agent Pact Lifecycle (devnet)");
  console.log("  DEVNET ONLY — pre-audit, not for production use");
  console.log("══════════════════════════════════════════════════════════════");

  // ── Load keypairs ─────────────────────────────────────────────────────────
  const agentA = loadKeypair("AGENT_A_KEYPAIR", "~/.config/solana/agent-a.json");
  const agentB = loadKeypair("AGENT_B_KEYPAIR", "~/.config/solana/agent-b.json");

  if (!agentA || !agentB) {
    console.error(
      "\nRequired: two funded devnet keypairs.\n" +
      "  AGENT_A_KEYPAIR  (service buyer / initiator)\n" +
      "  AGENT_B_KEYPAIR  (service provider / beneficiary)\n\n" +
      "  solana-keygen new -o ~/.config/solana/agent-a.json\n" +
      "  solana airdrop 2 --keypair ~/.config/solana/agent-a.json --url devnet\n" +
      "  spl-token wrap 0.1 --fee-payer ~/.config/solana/agent-a.json\n" +
      "\n  Repeat for agent-b.json (no wSOL needed — only agent-a funds the escrow).",
    );
    process.exit(1);
  }

  if (agentA.publicKey.equals(agentB.publicKey)) {
    console.error("AGENT_A and AGENT_B must be different keypairs.");
    process.exit(1);
  }

  const connection  = new Connection(RPC_URL, "confirmed");
  const readClient  = createHoldfastClient();

  console.log(`\n  Agent A (buyer):    ${agentA.publicKey.toBase58()}`);
  console.log(`  Agent B (provider): ${agentB.publicKey.toBase58()}`);

  // ── Step 1: Register agent wallets ────────────────────────────────────────
  hr("Step 1 — Register AgentWallet PDAs");
  console.log("  (idempotent — safe to call on every agent boot)\n");

  const regA = await registerAgentWallet({ connection, signer: agentA });
  const regB = await registerAgentWallet({ connection, signer: agentB });

  const walletA = regA.agentWallet;
  const walletB = regB.agentWallet;

  if (regA.signature) {
    console.log(`  Agent A registered: ${walletA.toBase58()}\n  Tx: ${explorer(regA.signature, "tx")}`);
  } else {
    console.log(`  Agent A already registered: ${walletA.toBase58()}`);
  }

  if (regB.signature) {
    console.log(`  Agent B registered: ${walletB.toBase58()}\n  Tx: ${explorer(regB.signature, "tx")}`);
  } else {
    console.log(`  Agent B already registered: ${walletB.toBase58()}`);
  }

  // ── Step 2: Check initial reputation ─────────────────────────────────────
  hr("Step 2 — Initial Reputation");
  await printReputation("Agent A", agentA.publicKey, readClient);
  await printReputation("Agent B", agentB.publicKey, readClient);

  // ── Step 3: Agent A creates pact ──────────────────────────────────────────
  hr("Step 3 — Agent A creates a pact");

  const timeLockExpiresAt = Math.floor(Date.now() / 1000) + 2 * 3600; // 2 hours
  const PACT_AMOUNT = 10_000n; // 0.00001 wSOL in lamports (minimal devnet test)

  console.log(`  Mint:          ${WSOL_MINT.toBase58()} (wSOL)`);
  console.log(`  Amount:        ${PACT_AMOUNT} lamports`);
  console.log(`  Release type:  task (manual release by initiator)`);
  console.log(`  Time-lock:     ${new Date(timeLockExpiresAt * 1000).toISOString()}`);
  console.log("\n  Submitting initialize_escrow...");

  const clientA = createHoldfastClient({ signer: agentA, agentWallet: walletA });
  const clientB = createHoldfastClient({ signer: agentB, agentWallet: walletB });

  const pact = await clientA.escrow.createPact({
    counterparty:       agentB.publicKey,
    counterpartyWallet: walletB,
    mint:               WSOL_MINT,
    amount:             PACT_AMOUNT,
    releaseCondition:   { kind: "task", timeLockExpiresAt },
  });

  console.log(`\n  ✓ Pact created!`);
  console.log(`    Escrow PDA:  ${pact.address}`);
  console.log(`    Escrow ID:   ${pact.escrowId}`);
  console.log(`    Status:      ${STATUS_LABEL[pact.status]} (${pact.status})`);
  console.log(`    Explorer:    ${explorer(pact.address)}`);

  // ── Step 4: Agent A deposits ──────────────────────────────────────────────
  hr("Step 4 — Agent A deposits funds");

  const escrowId = new PublicKey(Buffer.from(pact.escrowId, "hex"));
  const depositTx = await clientA.escrow.depositEscrow(escrowId);

  const funded = await readClient.escrow.getPact(escrowId);
  console.log(`  ✓ Deposited ${PACT_AMOUNT} lamports wSOL`);
  console.log(`    Tx:      ${explorer(depositTx, "tx")}`);
  console.log(`    Status:  ${STATUS_LABEL[funded.status]} (${funded.status})`);
  console.log(`    Vault:   ${funded.vault}`);

  // ── Step 5: Agent B stakes ────────────────────────────────────────────────
  hr("Step 5 — Agent B stakes");
  console.log("  Required even with zero stake — sets beneficiary_staked flag.");

  const stakeTx = await clientB.escrow.stakeBeneficiary(escrowId);
  const afterStake = await readClient.escrow.getPact(escrowId);

  console.log(`  ✓ Beneficiary staked`);
  console.log(`    Tx:              ${explorer(stakeTx, "tx")}`);
  console.log(`    beneficiaryStaked: ${afterStake.beneficiaryStaked}`);

  // ── Step 6: Both agents lock ──────────────────────────────────────────────
  hr("Step 6 — Both agents lock (SDK v0.2: client.escrow.lockEscrow)");
  console.log("  Both Agent A and Agent B must sign the same lock_escrow transaction.");
  console.log("  In production, use buildLockEscrowTransaction() to coordinate off-band.\n");

  const lockTx = await clientA.escrow.lockEscrow(escrowId, agentB, walletB);
  const locked  = await readClient.escrow.getPact(escrowId);

  console.log(`  ✓ Escrow locked`);
  console.log(`    Tx:      ${explorer(lockTx, "tx")}`);
  console.log(`    Status:  ${STATUS_LABEL[locked.status]} (${locked.status})`);
  console.log(`    Locked at: ${new Date(locked.lockedAt * 1000).toISOString()}`);

  // ── Step 7: Agent A releases ──────────────────────────────────────────────
  hr("Step 7 — Agent A releases funds (work accepted)");

  const releaseTx = await clientA.escrow.releasePact(escrowId);
  const released  = await readClient.escrow.getPact(escrowId);

  const disputeWindowCloses = new Date(released.disputeWindowEndsAt * 1000);
  console.log(`  ✓ Released`);
  console.log(`    Tx:                   ${explorer(releaseTx, "tx")}`);
  console.log(`    Status:               ${STATUS_LABEL[released.status]} (${released.status})`);
  console.log(`    Dispute window closes: ${disputeWindowCloses.toISOString()}`);

  // ── Step 8: Claim after dispute window ────────────────────────────────────
  hr("Step 8 — Agent B claims released funds");

  const nowSecs = Math.floor(Date.now() / 1000);
  if (nowSecs <= released.disputeWindowEndsAt) {
    const waitSecs = released.disputeWindowEndsAt - nowSecs;
    const waitH    = Math.ceil(waitSecs / 3600);
    console.log(`  Dispute window is still open (closes in ~${waitH}h).`);
    console.log(`  In this devnet demo the window is 7 days — skipping claim_released.`);
    console.log(`\n  To claim, run after ${disputeWindowCloses.toISOString()}:`);
    console.log(`\n    ESCROW_ID=${pact.escrowId} \\`);
    console.log(`    npx ts-node --esm examples/agent-to-agent-claim.ts`);
    console.log(`\n  Or deploy with a shorter disputeDeadlineSecs for test environments.`);
  } else {
    console.log("  Dispute window closed — claiming...");
    const claimTx = await clientB.escrow.claimReleased(escrowId, agentA.publicKey);
    const claimed  = await readClient.escrow.getPact(escrowId);
    console.log(`  ✓ Claimed`);
    console.log(`    Tx:     ${explorer(claimTx, "tx")}`);
    console.log(`    Status: ${STATUS_LABEL[claimed.status]} (${claimed.status})`);
  }

  // ── Step 9: Final reputation ──────────────────────────────────────────────
  hr("Step 9 — Final Reputation");
  console.log("  (reputation updates on Fulfilled pact at claim_released time)\n");
  await printReputation("Agent A", agentA.publicKey, readClient);
  await printReputation("Agent B", agentB.publicKey, readClient);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Pact lifecycle complete (pending claim after dispute window).");
  console.log(`  Escrow: ${explorer(pact.address)}`);
  console.log("══════════════════════════════════════════════════════════════\n");
}

main().catch((err: unknown) => {
  console.error("\n[agent-to-agent] Fatal error:", err);
  process.exit(1);
});
