import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHoldfastClient, registerAgentWallet, EscrowStatus } from "../src/index.js";

const RPC_URL = "https://api.devnet.solana.com";
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

interface StoredAgentIdentity {
  agentWallet: string;
  p256PrivateKey: number[];
}

function loadKeypair(pathLike: string): Keypair {
  const p = expandHome(pathLike);
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function expandHome(pathLike: string): string {
  return pathLike.replace(/^~/, os.homedir());
}

function loadStoredIdentity(pathLike: string): StoredAgentIdentity | null {
  const p = expandHome(pathLike);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as StoredAgentIdentity;
}

function saveStoredIdentity(pathLike: string, identity: StoredAgentIdentity): void {
  const p = expandHome(pathLike);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(identity, null, 2)}\n`);
}

async function registerWithPersistedIdentity(
  connection: Connection,
  signer: Keypair,
  identityPath: string,
): Promise<{
  agentWallet: PublicKey;
  signature?: string;
  reusedIdentity: boolean;
}> {
  const stored = loadStoredIdentity(identityPath);
  const result = await registerAgentWallet({
    connection,
    signer,
    ...(stored && { p256PrivateKey: Uint8Array.from(stored.p256PrivateKey) }),
  });

  if (stored && result.agentWallet.toBase58() !== stored.agentWallet) {
    throw new Error(
      `Persisted identity mismatch for ${identityPath}: expected ${stored.agentWallet}, got ${result.agentWallet.toBase58()}`,
    );
  }

  if (!stored) {
    saveStoredIdentity(identityPath, {
      agentWallet: result.agentWallet.toBase58(),
      p256PrivateKey: Array.from(result.p256PrivateKey),
    });
  }

  return {
    agentWallet: result.agentWallet,
    signature: result.signature,
    reusedIdentity: stored !== null,
  };
}

function tx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

async function main(): Promise<void> {
  const agentA = loadKeypair("~/.config/solana/agent-a.json");
  const agentB = loadKeypair("~/.config/solana/agent-b.json");
  const arbiter = loadKeypair("~/.config/solana/devnet.json");
  const agentAIdentityPath = process.env["AGENT_A_IDENTITY_PATH"] ?? "~/.config/solana/agent-a.holdfast.json";
  const agentBIdentityPath = process.env["AGENT_B_IDENTITY_PATH"] ?? "~/.config/solana/agent-b.holdfast.json";
  const arbiterIdentityPath = process.env["ARBITER_IDENTITY_PATH"] ?? "~/.config/solana/devnet-arbiter.holdfast.json";

  const connection = new Connection(RPC_URL, "confirmed");

  const regA = await registerWithPersistedIdentity(connection, agentA, agentAIdentityPath);
  const regB = await registerWithPersistedIdentity(connection, agentB, agentBIdentityPath);
  const regArb = await registerWithPersistedIdentity(connection, arbiter, arbiterIdentityPath);

  if (regA.signature) console.log("registerA:", tx(regA.signature));
  else if (regA.reusedIdentity) console.log("registerA: reusing persisted identity", expandHome(agentAIdentityPath), regA.agentWallet.toBase58());
  if (regB.signature) console.log("registerB:", tx(regB.signature));
  else if (regB.reusedIdentity) console.log("registerB: reusing persisted identity", expandHome(agentBIdentityPath), regB.agentWallet.toBase58());
  if (regArb.signature) console.log("registerArbiter:", tx(regArb.signature));
  else if (regArb.reusedIdentity) console.log("registerArbiter: reusing persisted identity", expandHome(arbiterIdentityPath), regArb.agentWallet.toBase58());

  const readClient = createHoldfastClient();
  const clientA = createHoldfastClient({ signer: agentA, agentWallet: regA.agentWallet });
  const clientB = createHoldfastClient({ signer: agentB, agentWallet: regB.agentWallet });

  const pact = await clientA.escrow.createPact({
    counterparty: agentB.publicKey,
    counterpartyWallet: regB.agentWallet,
    arbiter: arbiter.publicKey,
    arbiterWallet: regArb.agentWallet,
    mint: WSOL_MINT,
    amount: 10_000n,
    releaseCondition: { kind: "task", timeLockExpiresAt: Math.floor(Date.now() / 1000) + 7200 },
  });

  const escrowId = new PublicKey(Buffer.from(pact.escrowId, "hex"));
  console.log("createPactEscrow:", `https://explorer.solana.com/address/${pact.address}?cluster=devnet`);

  const depSig = await clientA.escrow.depositEscrow(escrowId);
  console.log("depositEscrow:", tx(depSig));

  const stakeSig = await clientB.escrow.stakeBeneficiary(escrowId);
  console.log("stakeBeneficiary:", tx(stakeSig));

  const lockSig = await clientA.escrow.lockEscrow(escrowId, agentB, regB.agentWallet, regArb.agentWallet);
  console.log("lockEscrow:", tx(lockSig));

  const releaseSig = await clientA.escrow.releasePact(escrowId);
  console.log("releasePact:", tx(releaseSig));

  const finalState = await readClient.escrow.getPact(escrowId);
  console.log("finalStatus:", finalState.status, EscrowStatus[finalState.status]);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
