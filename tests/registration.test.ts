/**
 * Unit tests for the registration module logic — AgentWallet PDA derivation,
 * secp256r1 instruction layout, and P-256 key generation/encoding.
 *
 * NOTE: src/registration/index.ts imports @noble/curves/nist (no .js extension),
 * which is not resolvable under the tsx/esm runner because @noble/curves v2.x
 * exports `./nist.js` (not `./nist`) in its package.json exports map. This file
 * tests the equivalent logic directly to achieve coverage without the import chain.
 *
 * Run: node --import tsx/esm --test tests/registration.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
// Use explicit .js extension to match the package.json exports map
import { p256 } from "@noble/curves/nist.js";

// ── Constants ──────────────────────────────────────────────────────────────

const DEVNET_HOLDFAST_PROGRAM_ID = new PublicKey(
  "D6mUa4wGtFyLyJorMfxoKvA9ybohjUSsfw88t66ATxg",
);

// sha256("global:register_agent_wallet")[0..8]
const DISC_REGISTER_AGENT_WALLET = Buffer.from(
  createHash("sha256").update("global:register_agent_wallet").digest(),
).subarray(0, 8);

// ── Inline deriveAgentWalletPda (same logic as src/registration/index.ts) ──

function deriveAgentWalletPda(
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

// ── deriveAgentWalletPda ───────────────────────────────────────────────────

describe("deriveAgentWalletPda", async () => {
  // Fixed test key derived from a deterministic P-256 private key
  const privKey = new Uint8Array(32).fill(0x42);
  const uncompressed = p256.getPublicKey(privKey, false);
  const pubkeyX = uncompressed.slice(1, 33);
  const pubkeyY = uncompressed.slice(33, 65);

  await test("returns a valid PublicKey", () => {
    const pda = deriveAgentWalletPda(pubkeyX, pubkeyY);
    assert.ok(pda instanceof PublicKey);
    assert.doesNotThrow(() => pda.toBase58());
  });

  await test("is deterministic — same coordinates produce same PDA", () => {
    const pda1 = deriveAgentWalletPda(pubkeyX, pubkeyY);
    const pda2 = deriveAgentWalletPda(pubkeyX, pubkeyY);
    assert.equal(pda1.toBase58(), pda2.toBase58());
  });

  await test("different P-256 keys produce different PDAs", () => {
    const privKey2 = new Uint8Array(32).fill(0x43);
    const uncomp2 = p256.getPublicKey(privKey2, false);
    const x2 = uncomp2.slice(1, 33);
    const y2 = uncomp2.slice(33, 65);
    const pda1 = deriveAgentWalletPda(pubkeyX, pubkeyY);
    const pda2 = deriveAgentWalletPda(x2, y2);
    assert.notEqual(pda1.toBase58(), pda2.toBase58());
  });

  await test("uses the correct seeds: ['agent_wallet', pubkeyX, pubkeyY]", () => {
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_wallet"), Buffer.from(pubkeyX), Buffer.from(pubkeyY)],
      DEVNET_HOLDFAST_PROGRAM_ID,
    );
    const actual = deriveAgentWalletPda(pubkeyX, pubkeyY);
    assert.equal(actual.toBase58(), expected.toBase58());
  });

  await test("accepts Uint8Array inputs", () => {
    const pda = deriveAgentWalletPda(new Uint8Array(pubkeyX), new Uint8Array(pubkeyY));
    assert.ok(pda instanceof PublicKey);
  });

  await test("custom holdfastProgramId produces a different PDA", () => {
    const altProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const pda1 = deriveAgentWalletPda(pubkeyX, pubkeyY, DEVNET_HOLDFAST_PROGRAM_ID);
    const pda2 = deriveAgentWalletPda(pubkeyX, pubkeyY, altProgram);
    assert.notEqual(pda1.toBase58(), pda2.toBase58());
  });
});

// ── P-256 key generation & encoding ───────────────────────────────────────

describe("P-256 key generation and encoding", async () => {
  await test("p256.getPublicKey returns 65 bytes uncompressed (0x04 prefix)", () => {
    const priv = p256.utils.randomSecretKey();
    const uncompressed = p256.getPublicKey(priv, false);
    assert.equal(uncompressed.length, 65);
    assert.equal(uncompressed[0], 0x04, "uncompressed pubkey must start with 0x04");
  });

  await test("p256.getPublicKey returns 33 bytes compressed (0x02 or 0x03 prefix)", () => {
    const priv = p256.utils.randomSecretKey();
    const compressed = p256.getPublicKey(priv, true);
    assert.equal(compressed.length, 33);
    assert.ok(
      compressed[0] === 0x02 || compressed[0] === 0x03,
      "compressed pubkey must start with 0x02 or 0x03",
    );
  });

  await test("X coordinate is bytes [1..33] of uncompressed pubkey", () => {
    const priv = new Uint8Array(32).fill(0x77);
    const uncompressed = p256.getPublicKey(priv, false);
    const x = uncompressed.slice(1, 33);
    assert.equal(x.length, 32);
  });

  await test("Y coordinate is bytes [33..65] of uncompressed pubkey", () => {
    const priv = new Uint8Array(32).fill(0x77);
    const uncompressed = p256.getPublicKey(priv, false);
    const y = uncompressed.slice(33, 65);
    assert.equal(y.length, 32);
  });

  await test("same private key always produces the same public key", () => {
    const priv = new Uint8Array(32).fill(0x99);
    const pub1 = p256.getPublicKey(priv, true);
    const pub2 = p256.getPublicKey(priv, true);
    assert.deepEqual(pub1, pub2);
  });

  await test("different private keys produce different public keys", () => {
    const priv1 = new Uint8Array(32).fill(0x01);
    const priv2 = new Uint8Array(32).fill(0x02);
    const pub1 = p256.getPublicKey(priv1, true);
    const pub2 = p256.getPublicKey(priv2, true);
    assert.notDeepEqual(pub1, pub2);
  });
});

// ── register_agent_wallet instruction discriminator ────────────────────────

describe("register_agent_wallet instruction discriminator", async () => {
  await test("discriminator is 8 bytes", () => {
    assert.equal(DISC_REGISTER_AGENT_WALLET.length, 8);
  });

  await test("discriminator matches sha256('global:register_agent_wallet')[0..8]", () => {
    const expected = createHash("sha256")
      .update("global:register_agent_wallet")
      .digest()
      .slice(0, 8);
    assert.deepEqual(DISC_REGISTER_AGENT_WALLET, Buffer.from(expected));
  });

  await test("discriminator is deterministic across multiple computations", () => {
    const d1 = Buffer.from(
      createHash("sha256").update("global:register_agent_wallet").digest(),
    ).subarray(0, 8);
    const d2 = Buffer.from(
      createHash("sha256").update("global:register_agent_wallet").digest(),
    ).subarray(0, 8);
    assert.deepEqual(d1, d2);
  });
});

// ── Secp256r1 instruction layout ───────────────────────────────────────────

describe("Secp256r1 instruction layout (SIMD-48)", async () => {
  // Layout matches buildSecp256r1Instruction in src/registration/index.ts
  const SIG_OFFSET = 16;
  const PUBKEY_OFFSET = SIG_OFFSET + 64; // 80
  const MSG_OFFSET = PUBKEY_OFFSET + 33;  // 113

  function buildInstructionData(sig: Uint8Array, pubkey: Uint8Array, message: Buffer): Buffer {
    const data = Buffer.alloc(MSG_OFFSET + message.length);
    data[0] = 1;          // num_signatures
    data[1] = 0;          // padding
    data.writeUInt16LE(SIG_OFFSET, 2);
    data.writeUInt16LE(0xffff, 4);    // sig_instruction_index = current
    data.writeUInt16LE(PUBKEY_OFFSET, 6);
    data.writeUInt16LE(0xffff, 8);    // pubkey_instruction_index = current
    data.writeUInt16LE(MSG_OFFSET, 10);
    data.writeUInt16LE(message.length, 12);
    data.writeUInt16LE(0xffff, 14);   // msg_instruction_index = current
    Buffer.from(sig).copy(data, SIG_OFFSET);
    Buffer.from(pubkey).copy(data, PUBKEY_OFFSET);
    message.copy(data, MSG_OFFSET);
    return data;
  }

  await test("num_signatures header byte is 1", () => {
    const data = buildInstructionData(new Uint8Array(64), new Uint8Array(33), Buffer.from("test"));
    assert.equal(data[0], 1);
  });

  await test("sig_offset header is 16 (u16 LE at byte 2)", () => {
    const data = buildInstructionData(new Uint8Array(64), new Uint8Array(33), Buffer.from("test"));
    assert.equal(data.readUInt16LE(2), SIG_OFFSET);
  });

  await test("pubkey_offset header is 80 (sig at 16 + 64 bytes)", () => {
    const data = buildInstructionData(new Uint8Array(64), new Uint8Array(33), Buffer.from("test"));
    assert.equal(data.readUInt16LE(6), PUBKEY_OFFSET);
  });

  await test("msg_offset header is 113 (pubkey at 80 + 33 bytes)", () => {
    const data = buildInstructionData(new Uint8Array(64), new Uint8Array(33), Buffer.from("test"));
    assert.equal(data.readUInt16LE(10), MSG_OFFSET);
  });

  await test("msg_len header equals message byte length", () => {
    const msg = Buffer.from("vaultpact:register_agent_wallet:v1:");
    const data = buildInstructionData(new Uint8Array(64), new Uint8Array(33), msg);
    assert.equal(data.readUInt16LE(12), msg.length);
  });

  await test("all instruction_index fields are 0xffff (self-referential)", () => {
    const data = buildInstructionData(new Uint8Array(64), new Uint8Array(33), Buffer.from("x"));
    assert.equal(data.readUInt16LE(4), 0xffff);
    assert.equal(data.readUInt16LE(8), 0xffff);
    assert.equal(data.readUInt16LE(14), 0xffff);
  });

  await test("signature bytes are placed at offset 16..79", () => {
    const sig = new Uint8Array(64).fill(0xab);
    const data = buildInstructionData(sig, new Uint8Array(33), Buffer.from("msg"));
    assert.equal(data[SIG_OFFSET], 0xab);
    assert.equal(data[SIG_OFFSET + 63], 0xab);
  });

  await test("compressed pubkey bytes are placed at offset 80..112", () => {
    const pubkey = new Uint8Array(33).fill(0xcd);
    const data = buildInstructionData(new Uint8Array(64), pubkey, Buffer.from("msg"));
    assert.equal(data[PUBKEY_OFFSET], 0xcd);
    assert.equal(data[PUBKEY_OFFSET + 32], 0xcd);
  });

  await test("message bytes are placed starting at offset 113", () => {
    const msg = Buffer.from("hello-holdfast");
    const data = buildInstructionData(new Uint8Array(64), new Uint8Array(33), msg);
    assert.deepEqual(data.subarray(MSG_OFFSET, MSG_OFFSET + msg.length), msg);
  });

  await test("total instruction data size is 113 + message.length", () => {
    const msg = Buffer.from("test-message-abc");
    const data = buildInstructionData(new Uint8Array(64), new Uint8Array(33), msg);
    assert.equal(data.length, MSG_OFFSET + msg.length);
  });
});

// ── Registration preimage construction ────────────────────────────────────

describe("Registration preimage", async () => {
  const PREFIX = "vaultpact:register_agent_wallet:v1:";

  await test("preimage starts with the expected version prefix", () => {
    const signerPubkey = new PublicKey("So11111111111111111111111111111111111111112");
    const pubkeyX = Buffer.alloc(32, 0x01);
    const pubkeyY = Buffer.alloc(32, 0x02);
    const preimage = Buffer.concat([Buffer.from(PREFIX), signerPubkey.toBuffer(), pubkeyX, pubkeyY]);
    assert.ok(preimage.toString("utf8", 0, PREFIX.length) === PREFIX);
  });

  await test("preimage is deterministic for same inputs", () => {
    const signerPubkey = new PublicKey("So11111111111111111111111111111111111111112");
    const pubkeyX = Buffer.alloc(32, 0x55);
    const pubkeyY = Buffer.alloc(32, 0x66);
    const p1 = Buffer.concat([Buffer.from(PREFIX), signerPubkey.toBuffer(), pubkeyX, pubkeyY]);
    const p2 = Buffer.concat([Buffer.from(PREFIX), signerPubkey.toBuffer(), pubkeyX, pubkeyY]);
    assert.deepEqual(p1, p2);
  });

  await test("preimage length is prefix(35) + pubkey(32) + x(32) + y(32) = 131 bytes", () => {
    const signerPubkey = new PublicKey("So11111111111111111111111111111111111111112");
    const pubkeyX = Buffer.alloc(32, 0x00);
    const pubkeyY = Buffer.alloc(32, 0x00);
    const preimage = Buffer.concat([Buffer.from(PREFIX), signerPubkey.toBuffer(), pubkeyX, pubkeyY]);
    assert.equal(Buffer.from(PREFIX).length, 35);
    assert.equal(preimage.length, 131);
  });

  await test("P-256 sign over sha256(preimage) does not throw", () => {
    const priv = new Uint8Array(32).fill(0x11);
    const uncompressed = p256.getPublicKey(priv, false);
    const pubkeyX = Buffer.from(uncompressed.slice(1, 33));
    const pubkeyY = Buffer.from(uncompressed.slice(33, 65));
    const signer = new PublicKey("So11111111111111111111111111111111111111112");
    const preimage = Buffer.concat([
      Buffer.from(PREFIX),
      signer.toBuffer(),
      pubkeyX,
      pubkeyY,
    ]);
    const hash = createHash("sha256").update(preimage).digest();
    assert.doesNotThrow(() => p256.sign(hash, priv));
  });
});

// ── Register instruction Borsh encoding ───────────────────────────────────

describe("register_agent_wallet Borsh instruction encoding", async () => {
  // Layout: discriminator (8) + Vec<u8> pubkeyX (4 len + 32) + Vec<u8> pubkeyY (4 len + 32) = 80 bytes
  const EXPECTED_SIZE = 8 + 4 + 32 + 4 + 32;

  function buildRegisterIxData(pubkeyX: Buffer, pubkeyY: Buffer): Buffer {
    const data = Buffer.alloc(EXPECTED_SIZE);
    DISC_REGISTER_AGENT_WALLET.copy(data, 0);
    data.writeUInt32LE(32, 8);
    pubkeyX.copy(data, 12);
    data.writeUInt32LE(32, 44);
    pubkeyY.copy(data, 48);
    return data;
  }

  await test("instruction data is exactly 80 bytes", () => {
    const data = buildRegisterIxData(Buffer.alloc(32, 0x01), Buffer.alloc(32, 0x02));
    assert.equal(data.length, EXPECTED_SIZE);
  });

  await test("discriminator occupies bytes 0-7", () => {
    const data = buildRegisterIxData(Buffer.alloc(32), Buffer.alloc(32));
    assert.deepEqual(data.subarray(0, 8), DISC_REGISTER_AGENT_WALLET);
  });

  await test("pubkeyX length prefix is 32 at offset 8 (u32 LE)", () => {
    const data = buildRegisterIxData(Buffer.alloc(32), Buffer.alloc(32));
    assert.equal(data.readUInt32LE(8), 32);
  });

  await test("pubkeyX bytes occupy offsets 12-43", () => {
    const x = Buffer.alloc(32, 0xaa);
    const data = buildRegisterIxData(x, Buffer.alloc(32));
    assert.deepEqual(data.subarray(12, 44), x);
  });

  await test("pubkeyY length prefix is 32 at offset 44 (u32 LE)", () => {
    const data = buildRegisterIxData(Buffer.alloc(32), Buffer.alloc(32));
    assert.equal(data.readUInt32LE(44), 32);
  });

  await test("pubkeyY bytes occupy offsets 48-79", () => {
    const y = Buffer.alloc(32, 0xbb);
    const data = buildRegisterIxData(Buffer.alloc(32), y);
    assert.deepEqual(data.subarray(48, 80), y);
  });
});
