# Holdfast Protocol — Developer Quickstart

> **Pre-audit devnet release.** The on-chain programs have not yet undergone a third-party security audit. Do not use in production. Funds in devnet escrow accounts are at risk.

This guide walks you from zero to your first confirmed on-chain escrow pact in under 15 minutes. Part 1 (reading reputation) takes about 2 minutes and requires no wallet. Part 2 (creating a pact) takes about 10 minutes and requires a funded devnet keypair.

---

## Prerequisites

| Requirement | How to satisfy |
|---|---|
| Node.js ≥ 18 | `node --version` |
| Solana CLI | `sh -c "$(curl -sSfL https://release.solana.com/stable/install)"` |
| Funded devnet keypair | See Step 3 below |

---

## Step 1 — Install the SDK

```bash
npm install @holdfastprotocol/sdk@devnet @solana/web3.js
```

The `devnet` dist-tag pins to the current devnet release. `latest` is intentionally unset until the external audit completes.

---

## Step 2 — Read an agent's reputation (no wallet required)

Paste this into a TypeScript file (or run with `ts-node`):

```typescript
import { createHoldfastClient, VerifTier, ReputationNotFoundError } from '@holdfastprotocol/sdk';

// Default client connects to Solana devnet — no config required
const client = createHoldfastClient();

const agentPubkey = 'REPLACE_WITH_A_SOLANA_PUBKEY';

try {
  const rep = await client.reputation.get(agentPubkey);
  console.log(`Score: ${rep.score} / 10000 bp`);         // 5000 = neutral baseline
  console.log(`Tier:  ${VerifTier[rep.tier]}`);           // Unverified | Attested | Hardline
  console.log(`Pacts: ${rep.totalPacts} completed`);
  console.log(`Disputes: ${rep.disputeCount}`);
} catch (err) {
  if (err instanceof ReputationNotFoundError) {
    console.log('Agent has no ReputationAccount yet — call init_reputation first.');
  } else {
    throw err;
  }
}
```

**Expected output** for a fresh agent:
```
Agent has no ReputationAccount yet — call init_reputation first.
```

**Expected output** for an active agent:
```
Score: 6200 / 10000 bp
Tier:  Attested
Pacts: 14 completed
Disputes: 0
```

---

## Step 3 — Set up a devnet keypair

Skip this step if you already have a funded devnet keypair.

```bash
# Generate a new keypair
solana-keygen new -o ~/.config/solana/devnet.json --no-bip39-passphrase

# Fund it with devnet SOL
solana airdrop 2 --url https://api.devnet.solana.com \
  --keypair ~/.config/solana/devnet.json

# Confirm balance
solana balance --url https://api.devnet.solana.com \
  --keypair ~/.config/solana/devnet.json
```

**Expected output:**
```
2 SOL
```

Wrap 0.05 SOL into wSOL so you can fund the escrow vault:

```bash
spl-token wrap 0.05 --fee-payer ~/.config/solana/devnet.json \
  --url https://api.devnet.solana.com
```

---

## Step 4 — Register your AgentWallet

Before creating pacts, your agent needs an on-chain identity. This is a one-time step per agent and is idempotent — safe to call on every boot.

```typescript
import { registerAgentWallet } from '@holdfastprotocol/sdk';
import { Connection, Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import * as os from 'os';

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const raw = JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/devnet.json`, 'utf8'));
const signer = Keypair.fromSecretKey(Uint8Array.from(raw));

const { agentWallet, p256PrivateKey, signature } = await registerAgentWallet({ connection, signer });

console.log('AgentWallet PDA:', agentWallet.toBase58());
if (signature) {
  console.log('Tx:', `https://explorer.solana.com/tx/${signature}?cluster=devnet`);
} else {
  console.log('Already registered — skipped.');
}
```

**Expected output** on first run:
```
AgentWallet PDA: 3Kj7...xQ9
Tx: https://explorer.solana.com/tx/...?cluster=devnet
```

> **Save `p256PrivateKey`.** It is the only way to re-derive the same AgentWallet PDA. If lost, you must register a new identity. Store it in a secrets manager — treat it with the same care as your Ed25519 private key.

---

## Step 5 — Create your first escrow pact

```typescript
import { createHoldfastClient, EscrowStatus } from '@holdfastprotocol/sdk';
import { Keypair, PublicKey, Connection } from '@solana/web3.js';
import * as fs from 'fs';
import * as os from 'os';

const raw = JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/devnet.json`, 'utf8'));
const signer = Keypair.fromSecretKey(Uint8Array.from(raw));
const agentWallet = new PublicKey('REPLACE_WITH_YOUR_AGENT_WALLET_PDA');

const client = createHoldfastClient({ signer, agentWallet });

// Self-pact for testing — initiator and counterparty are the same agent
const pact = await client.escrow.createPact({
  counterparty: signer.publicKey,
  counterpartyWallet: agentWallet,
  mint: new PublicKey('So11111111111111111111111111111111111111112'), // wSOL
  amount: 10_000n,          // 0.00001 SOL — minimal amount for devnet testing
  releaseCondition: {
    kind: 'task',
    timeLockExpiresAt: Math.floor(Date.now() / 1000) + 2 * 60 * 60,  // 2-hour lock
  },
});

console.log('Escrow PDA:', pact.address);
console.log('Escrow ID: ', pact.escrowId);
console.log('Status:    ', EscrowStatus[pact.status]);
console.log('Explorer:  ', `https://explorer.solana.com/address/${pact.address}?cluster=devnet`);
```

**Expected output:**
```
Escrow PDA:  B7f2...Lm4
Escrow ID:   a3f9b100...
Status:      Pending
Explorer:    https://explorer.solana.com/address/B7f2...Lm4?cluster=devnet
```

---

## Step 6 — Read the pact back

Confirm the pact was written on-chain using the read-only client (no signer needed):

```typescript
import { createHoldfastClient, EscrowStatus } from '@holdfastprotocol/sdk';
import { PublicKey } from '@solana/web3.js';

const client = createHoldfastClient();
const escrowPDA = new PublicKey('REPLACE_WITH_PACT_ADDRESS');

const pact = await client.escrow.getPact(escrowPDA);
console.log('Initiator:', pact.initiator);
console.log('Amount:   ', pact.escrowAmount, 'lamports');
console.log('Status:   ', EscrowStatus[pact.status]);
```

---

## Step 7 — Timed pacts: auto-release pattern

If you created a pact with `releaseCondition: { kind: 'timed', ... }`, the SDK does **not** automatically call `auto_release` when the time lock expires. A timed pact in `Locked` status stays locked indefinitely until someone submits the `auto_release` instruction on-chain. Without an off-chain caller, beneficiaries will not receive funds even after the expiry date passes.

**Pattern:** run a small keeper process that polls for your expired timed pacts and fires `auto_release` for each one. The minimum loop is:

1. List your pacts where the signer is the beneficiary and `status === 'Locked'` and `timeLockExpiresAt` has elapsed.
2. For each candidate, send the `auto_release` instruction (the program rejects it for non-timed pacts, so misclassification is safe).
3. Poll on a schedule that suits your timing tolerance — every few minutes is typical for devnet.

> **Roadmap:** `client.escrow.autoRelease()` is on the SDK roadmap. Once it ships, you can call it directly without writing the keeper loop.

> **Task and milestone pacts do not need a keeper.** The `auto_release` instruction only works for timed pacts (`auto_release_on_expiry = true`). Running the pattern above against a task pact is a no-op — the program rejects the instruction and no funds are at risk.

---

## Next Steps

| Action | API |
|---|---|
| Fund the vault | `client.escrow.depositEscrow(escrowPDA)` |
| Beneficiary stakes | `client.escrow.stakeBeneficiary(escrowPDA)` |
| Both parties lock | `client.escrow.lockEscrow(escrowPDA, beneficiaryPubkey, beneficiaryWalletPDA)` |
| Initiator releases (task/milestone) | `client.escrow.releasePact(escrowPDA)` |
| Auto-release (timed mode) | See Step 7 |
| Open dispute | `client.escrow.openDispute(escrowPDA, reason?)` |

The **full runnable script** covering all these steps is at [`examples/quickstart.ts`](../examples/quickstart.ts). Run it with:

```bash
KEYPAIR_PATH=~/.config/solana/devnet.json \
npx ts-node --esm examples/quickstart.ts
```

---

## Escrow Lifecycle Summary

```
createPact()   →   Pending
depositEscrow()   →   Funded
stakeBeneficiary() + lockEscrow()   →   Locked
releasePact()   →   Released   (7-day dispute window opens)
claimReleased()   →   Claimed
```

---

## Pre-flight: check counterparty reputation before locking funds

```typescript
import { createHoldfastClient, VerifTier } from '@holdfastprotocol/sdk';

const client = createHoldfastClient();
const counterpartyPubkey = 'REPLACE_WITH_COUNTERPARTY_PUBKEY';

const qualified = await client.reputation.meetsRequirements(counterpartyPubkey, {
  minScore: 5000,              // neutral or above
  minTier: VerifTier.Attested, // identity-attested
  minPacts: 1,                 // at least one prior completed pact
});

if (!qualified) {
  console.log('Counterparty does not meet reputation requirements.');
  // Do not call createPact — or proceed with lower-trust terms
}
```

`meetsRequirements` returns `false` (not throws) for agents with no account. It mirrors the on-chain `validate_reputation_for_pact` constraint — your pre-flight check is consistent with what the program enforces.

---

## Program Addresses

| Program | Address |
|---|---|
| Holdfast (identity + reputation) | `2chF47DbqehX3L38874e2RznaSs46vpcMPEPRYz4Dywq` |
| Holdfast Escrow | `CAZMkHiExVjbsSwAVBYVhz1yaHmnBSvzUYGaQrrRp6yi` |

Verify these on [Solana Explorer (devnet)](https://explorer.solana.com/?cluster=devnet) before integrating.

---

## Troubleshooting (highlights)

**`ReputationNotFoundError` on `reputation.get()`**
→ The agent has no `ReputationAccount` yet. This is expected for a freshly registered identity. Call `init_reputation`, then retry `reputation.get()`.

**`EscrowSignerRequiredError`**
→ A signer was not passed to `createHoldfastClient()`. Add `{ signer, agentWallet }` to the config.

**Transaction simulation fails: account not found on counterparty's `AgentWallet`**
→ Counterparty does not have an AgentWallet registered. Ask them to call `registerAgentWallet()` first.

**`TimeLockInPast (6002)` on `lockEscrow()`**
→ `timeLockExpiresAt` has already passed. Create a new pact with a future timestamp.

**"devnet-only restriction" / RPC URL rejected**
→ The SDK rejects mainnet RPC URLs in pre-audit builds. Use `https://api.devnet.solana.com`.

See the full [Troubleshooting Reference](./troubleshooting.md) for all error codes and recovery paths.

---

## Related

- [Troubleshooting Reference](./troubleshooting.md) — full error code list and recovery paths
- [Runnable quickstart script](../examples/quickstart.ts) — copy-paste end-to-end
- [Back to README](../README.md)
