/**
 * test-register-devnet.ts — live devnet smoke test for registerAgentWallet.
 *
 * Confirms that the secp256r1 native precompile (SIMD-48) is active on devnet
 * by submitting a real transaction and verifying it lands on-chain.
 *
 * Usage:
 *   node --import tsx/esm scripts/test-register-devnet.ts
 *
 * The payer keypair defaults to ~/.config/solana/devnet.json.
 * Override with PAYER_KEYPAIR_PATH env var.
 */

import { Connection, Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { registerAgentWallet } from "../src/registration/index.js";

function loadKeypairFile(rawPath: string): Keypair {
  const expanded = rawPath.startsWith("~")
    ? rawPath.replace("~", homedir())
    : rawPath;
  const bytes = JSON.parse(readFileSync(expanded, "utf8")) as number[];
  return Keypair.fromSecretKey(new Uint8Array(bytes));
}

async function main(): Promise<void> {
  const payerPath =
    process.env["PAYER_KEYPAIR_PATH"] ?? "~/.config/solana/devnet.json";
  const signer = loadKeypairFile(payerPath);
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");

  console.log("[test-register-devnet] Payer:   ", signer.publicKey.toBase58());
  console.log("[test-register-devnet] Network:  Solana devnet");

  const balance = await connection.getBalance(signer.publicKey);
  console.log("[test-register-devnet] Balance: ", balance / 1e9, "SOL");
  if (balance < 5_000_000) {
    console.error(
      "[test-register-devnet] Insufficient balance. Run: solana airdrop 1 --url devnet",
    );
    process.exit(1);
  }

  console.log("[test-register-devnet] Sending registerAgentWallet tx …");
  const start = Date.now();

  const result = await registerAgentWallet({ connection, signer });

  const elapsed = Date.now() - start;

  if (result.signature) {
    console.log("[test-register-devnet] ✓ SUCCESS");
    console.log("[test-register-devnet] AgentWallet PDA:", result.agentWallet.toBase58());
    console.log("[test-register-devnet] Signature:      ", result.signature);
    console.log(
      "[test-register-devnet] Explorer: https://explorer.solana.com/tx/" +
        result.signature +
        "?cluster=devnet",
    );
    console.log(`[test-register-devnet] Elapsed: ${elapsed}ms`);
  } else {
    console.log("[test-register-devnet] AgentWallet already registered (idempotent path).");
    console.log("[test-register-devnet] PDA:", result.agentWallet.toBase58());
  }
}

main().catch((err: unknown) => {
  console.error("[test-register-devnet] FAILED:", err);
  process.exit(1);
});
