import { createHash } from "crypto";
import {
  Connection,
  PublicKey,
  Signer,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { p256 } from "@noble/curves/nist.js";

// ── Constants ─────────────────────────────────────────────────────────────────

// secp256r1 native precompile (SIMD-48)
const SECP256R1_PROGRAM_ID = new PublicKey(
  Buffer.from([
    6, 146, 13, 236, 47, 234, 113, 181, 183, 35, 129, 77, 116, 45, 169, 3,
    28, 131, 231, 95, 219, 121, 93, 86, 142, 117, 71, 128, 32, 0, 0, 0,
  ]),
);

const SYSVAR_INSTRUCTIONS_PUBKEY = new PublicKey(
  "Sysvar1nstructions1111111111111111111111111",
);

const DEVNET_HOLDFAST_PROGRAM_ID = new PublicKey(
  "2chF47DbqehX3L38874e2RznaSs46vpcMPEPRYz4Dywq",
);

// sha256("global:register_agent_wallet")[0..8]
const DISC_REGISTER_AGENT_WALLET = Buffer.from(
  createHash("sha256").update("global:register_agent_wallet").digest(),
).subarray(0, 8);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RegisterAgentWalletParams {
  connection: Connection;
  /** Ed25519 signer — becomes the AgentWallet authority and fee payer */
  signer: Signer;
  /**
   * Optional P-256 (secp256r1) private key (32 raw bytes).
   * If omitted, a fresh key is generated.
   * Save the returned `p256PrivateKey` — it determines the AgentWallet PDA address.
   */
  p256PrivateKey?: Uint8Array;
  /** Override the holdfast program ID (defaults to devnet deployment) */
  holdfastProgramId?: PublicKey;
}

export interface RegisterAgentWalletResult {
  /** The on-chain AgentWallet PDA — pass as `agentWallet` in HoldfastClientOptions */
  agentWallet: PublicKey;
  /** P-256 compressed public key (33 bytes) registered on-chain */
  p256PublicKey: Uint8Array;
  /**
   * P-256 private key (32 bytes). Save this — it is the only way to re-derive
   * the same AgentWallet PDA for this agent identity.
   */
  p256PrivateKey: Uint8Array;
  /**
   * Transaction signature. Undefined when the AgentWallet was already registered
   * and no transaction was sent (idempotent re-registration).
   */
  signature?: string;
}

// ── PDA helpers ───────────────────────────────────────────────────────────────

/**
 * Derives the AgentWallet PDA from the P-256 public key coordinates.
 * Seeds: ["agent_wallet", pubkey_x, pubkey_y] on the holdfast program.
 *
 * Use this to look up an existing AgentWallet without registering again.
 */
export function deriveAgentWalletPda(
  p256PubkeyX: Uint8Array,
  p256PubkeyY: Uint8Array,
  holdfastProgramId: PublicKey = DEVNET_HOLDFAST_PROGRAM_ID,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("agent_wallet"),
      Buffer.from(p256PubkeyX),
      Buffer.from(p256PubkeyY),
    ],
    holdfastProgramId,
  );
  return pda;
}

// ── Instruction builders ──────────────────────────────────────────────────────

function buildSecp256r1Instruction(
  sig: Uint8Array,
  pubkey: Uint8Array,
  message: Buffer,
): TransactionInstruction {
  const SIG_OFFSET = 16;
  const PUBKEY_OFFSET = SIG_OFFSET + 64;
  const MSG_OFFSET = PUBKEY_OFFSET + pubkey.length;
  const data = Buffer.alloc(MSG_OFFSET + message.length);
  data[0] = 1; // num_signatures
  data[1] = 0; // padding
  data.writeUInt16LE(SIG_OFFSET, 2);
  data.writeUInt16LE(0xffff, 4); // sig_instruction_index = current ix
  data.writeUInt16LE(PUBKEY_OFFSET, 6);
  data.writeUInt16LE(0xffff, 8); // pubkey_instruction_index = current ix
  data.writeUInt16LE(MSG_OFFSET, 10);
  data.writeUInt16LE(message.length, 12);
  data.writeUInt16LE(0xffff, 14); // msg_instruction_index = current ix
  Buffer.from(sig).copy(data, SIG_OFFSET);
  Buffer.from(pubkey).copy(data, PUBKEY_OFFSET);
  message.copy(data, MSG_OFFSET);
  return new TransactionInstruction({
    programId: SECP256R1_PROGRAM_ID,
    keys: [],
    data,
  });
}

function buildRegisterInstruction(
  agentWallet: PublicKey,
  attestationRegistry: PublicKey,
  payer: PublicKey,
  pubkeyX: Buffer,
  pubkeyY: Buffer,
  holdfastProgramId: PublicKey,
): TransactionInstruction {
  // Borsh: discriminator (8) + [u8;32] pubkeyX (32) + [u8;32] pubkeyY (32)
  // Fixed arrays serialize without a length prefix (unlike Vec<u8>).
  const data = Buffer.alloc(8 + 32 + 32);
  DISC_REGISTER_AGENT_WALLET.copy(data, 0);
  pubkeyX.copy(data, 8);
  pubkeyY.copy(data, 40);

  return new TransactionInstruction({
    programId: holdfastProgramId,
    keys: [
      { pubkey: agentWallet, isSigner: false, isWritable: true },
      { pubkey: attestationRegistry, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Registers an AgentWallet PDA on the holdfast program for the given signer.
 *
 * This is a one-time setup call per agent identity. After registration, pass
 * the returned `agentWallet` address as `agentWallet` in HoldfastClientOptions
 * to enable `createPact` and `releasePact`.
 *
 * The call is idempotent: if the AgentWallet PDA already exists on-chain,
 * no transaction is sent and the existing address is returned immediately.
 *
 * Requires the secp256r1 native precompile (SIMD-48) to be active on the
 * target cluster. This is available on localnet and devnet after the cluster
 * upgrade. The function throws if the transaction fails — check devnet feature
 * gate status if you see a precompile error.
 */
export async function registerAgentWallet(
  params: RegisterAgentWalletParams,
): Promise<RegisterAgentWalletResult> {
  const { connection, signer } = params;
  const holdfastProgramId =
    params.holdfastProgramId ?? DEVNET_HOLDFAST_PROGRAM_ID;

  const privKey = params.p256PrivateKey ?? p256.utils.randomSecretKey();
  const uncompressed = p256.getPublicKey(privKey, false);
  const compressedPubkey = p256.getPublicKey(privKey, true);
  const pubkeyX = Buffer.from(uncompressed.slice(1, 33));
  const pubkeyY = Buffer.from(uncompressed.slice(33, 65));

  const agentWallet = deriveAgentWalletPda(
    pubkeyX,
    pubkeyY,
    holdfastProgramId,
  );

  const [attestationRegistry] = PublicKey.findProgramAddressSync(
    [Buffer.from("attestation_registry")],
    holdfastProgramId,
  );

  // Idempotent: skip tx if PDA already initialized
  const existing = await connection.getAccountInfo(agentWallet);
  if (existing !== null) {
    return { agentWallet, p256PublicKey: compressedPubkey, p256PrivateKey: privKey };
  }

  const preimage = Buffer.concat([
    Buffer.from("vaultpact:register_agent_wallet:v1:"),
    signer.publicKey.toBuffer(),
    pubkeyX,
    pubkeyY,
  ]);
  const preimageHash = createHash("sha256").update(preimage).digest();
  // noble return type differs across package versions/workspaces:
  // - Uint8Array(64) in newer builds
  // - Signature object with toCompactRawBytes() in older builds
  const signed = p256.sign(preimageHash, privKey) as
    | Uint8Array
    | { toCompactRawBytes: () => Uint8Array };
  const sigBytes =
    signed instanceof Uint8Array
      ? signed
      : signed.toCompactRawBytes();

  // Devnet secp256r1 precompile path accepts the 32-byte challenge digest
  // (sha256(preimage)) as the message payload for verification.
  const secp256r1Ix = buildSecp256r1Instruction(
    sigBytes,
    compressedPubkey,
    preimageHash,
  );
  const registerIx = buildRegisterInstruction(
    agentWallet,
    attestationRegistry,
    signer.publicKey,
    pubkeyX,
    pubkeyY,
    holdfastProgramId,
  );

  const tx = new Transaction().add(secp256r1Ix, registerIx);
  const signature = await sendAndConfirmTransaction(connection, tx, [signer]);

  return { agentWallet, p256PublicKey: compressedPubkey, p256PrivateKey: privKey, signature };
}
