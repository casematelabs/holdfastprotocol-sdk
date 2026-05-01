import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import { createHoldfastClient, registerAgentWallet } from "../src/index.js";

const RPC_URL = "https://api.devnet.solana.com";
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const MIN_SOL = 0.1;
const LAMPORTS_PER_SOL = 1_000_000_000;
const MIN_LAMPORTS = Math.floor(MIN_SOL * LAMPORTS_PER_SOL);
const AIRDROP_RETRIES = 3;

function loadKeypair(pathLike: string): Keypair {
  const p = pathLike.replace(/^~/, os.homedir());
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function ensureFunded(connection: Connection, signer: Keypair, label: string): Promise<void> {
  const current = await connection.getBalance(signer.publicKey, "confirmed");
  if (current >= MIN_LAMPORTS) return;

  const needed = MIN_LAMPORTS - current;
  let lastErr: unknown = null;
  for (let i = 1; i <= AIRDROP_RETRIES; i += 1) {
    try {
      const sig = await connection.requestAirdrop(signer.publicKey, needed);
      await connection.confirmTransaction(sig, "confirmed");
      break;
    } catch (err) {
      lastErr = err;
      if (i < AIRDROP_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, i * 1500));
      }
    }
  }

  const updated = await connection.getBalance(signer.publicKey, "confirmed");
  if (updated < MIN_LAMPORTS) {
    const missingSol = (MIN_LAMPORTS - updated) / LAMPORTS_PER_SOL;
    throw new Error(
      `${label} (${signer.publicKey.toBase58()}) needs ${missingSol.toFixed(4)} more SOL; ` +
      `fund it manually (devnet faucet or transfer) and rerun. Last airdrop error: ${String(lastErr)}`,
    );
  }
}

async function main(): Promise<void> {
  const agentA = loadKeypair("~/.config/solana/agent-a.json");
  const agentB = loadKeypair("~/.config/solana/agent-b.json");
  const arbiter = loadKeypair("~/.config/solana/devnet.json");

  if (
    agentA.publicKey.equals(agentB.publicKey) ||
    agentA.publicKey.equals(arbiter.publicKey) ||
    agentB.publicKey.equals(arbiter.publicKey)
  ) {
    throw new Error("Agent A, Agent B, and arbiter must be distinct pubkeys.");
  }

  const connection = new Connection(RPC_URL, "confirmed");
  await ensureFunded(connection, agentA, "agentA");
  await ensureFunded(connection, agentB, "agentB");
  await ensureFunded(connection, arbiter, "arbiter");

  const regA = await registerAgentWallet({ connection, signer: agentA });
  const regB = await registerAgentWallet({ connection, signer: agentB });
  const regArbiter = await registerAgentWallet({ connection, signer: arbiter });

  const clientA = createHoldfastClient({ signer: agentA, agentWallet: regA.agentWallet });
  const amount = 10_000n;
  const timeLockExpiresAt = Math.floor(Date.now() / 1000) + 2 * 3600;

  const pact = await clientA.escrow.createPact({
    counterparty: agentB.publicKey,
    counterpartyWallet: regB.agentWallet,
    arbiter: arbiter.publicKey,
    arbiterWallet: regArbiter.agentWallet,
    mint: WSOL_MINT,
    amount,
    releaseCondition: { kind: "task", timeLockExpiresAt },
  });

  console.log("CAS-27 createPact smoke success");
  console.log("escrow:", pact.address);
  console.log("escrowId:", pact.escrowId);
}

void main().catch((err) => {
  console.error("CAS-27 createPact smoke failed");
  console.error(err);
  if (typeof err?.getLogs === "function") {
    err.getLogs().then((logs: string[]) => {
      console.error("Simulation logs:");
      console.error(logs.join("\n"));
      process.exit(1);
    }).catch(() => process.exit(1));
    return;
  }
  process.exit(1);
});
