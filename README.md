# @holdfastprotocol/sdk

[![npm version](https://img.shields.io/npm/v/@holdfastprotocol/sdk?tag=devnet)](https://www.npmjs.com/package/@holdfastprotocol/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Network: Devnet](https://img.shields.io/badge/network-devnet-orange)](#program-ids-devnet)

TypeScript SDK for the Holdfast Protocol — trust infrastructure for autonomous AI agents on Solana.

## What is Holdfast?

Holdfast is trust infrastructure for autonomous agents.

It allows agents, users, and applications to:
- form verifiable agreements (pacts)
- lock and release funds via escrow
- enforce reputation-based requirements
- operate safely in autonomous workflows

---

> **Security notice:** Holdfast Protocol is currently in devnet. The on-chain programs have not yet undergone a third-party security audit. Do not use devnet program addresses in production. Funds locked in devnet escrow accounts are at risk. An external audit is in progress; this notice will be updated when the audit is complete.

**Changelog:** [`CHANGELOG.md`](./CHANGELOG.md)

---

## Install

```bash
npm install @holdfastprotocol/sdk@devnet @solana/web3.js
```

The `devnet` dist-tag points to the current devnet release. `latest` is intentionally unset until the external audit completes.

**Peer dependencies:** `@solana/web3.js` ^1.95.0

---

## Quick start

Canonical onboarding script:

- [`examples/quickstart.ts`](./examples/quickstart.ts) — runnable end-to-end devnet script

Run the first supported devnet escrow path:

```bash
KEYPAIR_PATH=~/.config/solana/devnet.json \
npx ts-node --esm examples/quickstart.ts
```

The script covers the initial path end-to-end: `registerAgentWallet()` -> `createPact()` -> `getPact()`.

```typescript
import { createHoldfastClient } from '@holdfastprotocol/sdk';
import { Keypair } from '@solana/web3.js';

const client = createHoldfastClient(); // defaults to devnet

const agentPubkey = Keypair.generate().publicKey;

// Check reputation (returns false when no ReputationAccount exists yet)
const qualified = await client.reputation.meetsRequirements(agentPubkey, {
  minScore: 5000, // neutral or above
  minPacts: 3,
});

console.log('Agent qualified:', qualified);
```

For CI/runtime parity checks, run:

```bash
node --import tsx/esm --test tests/quickstart-parity.ci.test.ts
```

For the deterministic terminal-state lifecycle proof (`createPact` → `claimReleased`) in a controllable test environment, run:

```bash
npm run verify:lifecycle
```

For a real devnet `createPact` smoke path, run:

```bash
node --import tsx/esm scripts/cas27-createpact-smoke.ts
```

Smoke prerequisites:
- Local keypairs at `~/.config/solana/agent-a.json`, `~/.config/solana/agent-b.json`, and `~/.config/solana/devnet.json`
- Distinct public keys for each role
- At least `0.1` SOL per signer (the script attempts airdrop retries and then prints manual funding guidance)

For the broader live devnet release-path smoke with persisted Holdfast identities, run:

```bash
node --import tsx/esm scripts/cas2-full-lifecycle-explicit-arbiter.ts
```

This script stores and reuses Holdfast identity files in `~/.config/solana/*.holdfast.json` so repeated runs exercise stable `AgentWallet` identity instead of re-registering fresh wallets every time.

---

## Modules

### Registration

One-time agent identity setup. No Anchor required — pure `@solana/web3.js`.

#### `registerAgentWallet(params)`

Registers an AgentWallet PDA on the holdfast program. Generates a secp256r1 keypair, builds the SIMD-48 precompile instruction, and submits both in a single transaction. Idempotent — if the PDA already exists, returns immediately without sending a transaction.

This call does **not** create a `ReputationAccount`. Reputation remains uninitialized until you explicitly run `init_reputation`.

```typescript
import { registerAgentWallet } from '@holdfastprotocol/sdk';
import { Connection, Keypair } from '@solana/web3.js';

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const signer = Keypair.fromSecretKey(/* your keypair bytes */);

const { agentWallet, p256PrivateKey, signature } = await registerAgentWallet({
  connection,
  signer,
  // p256PrivateKey?: Uint8Array  — optional; generated if omitted
});

// agentWallet: PublicKey  — pass as `agentWallet` in HoldfastClientOptions
// p256PrivateKey: Uint8Array  — SAVE THIS across restarts; re-deriving the same PDA requires it
// signature?: string  — undefined if the PDA was already registered (no tx sent)
```

> Persist `p256PrivateKey`. It is the only way to re-derive the same AgentWallet PDA for this identity.

#### `deriveAgentWalletPda(p256PubkeyX, p256PubkeyY, programId?)`

Derives the AgentWallet PDA address from P-256 coordinate bytes without a network call. Useful for pre-computing the address.

```typescript
import { deriveAgentWalletPda } from '@holdfastprotocol/sdk';
import { p256 } from '@noble/curves/nist';

const privKey = /* your saved Uint8Array */;
const uncompressed = p256.getPublicKey(privKey, false);
const pubkeyX = uncompressed.slice(1, 33);
const pubkeyY = uncompressed.slice(33, 65);

const agentWalletPda = deriveAgentWalletPda(pubkeyX, pubkeyY);
```

---

### `reputation`

Reads the on-chain `ReputationAccount` PDA directly via RPC — no oracle round-trip required.

```typescript
const client = createHoldfastClient({
  rpcUrl: 'https://api.devnet.solana.com',   // default
  indexerUrl: 'https://indexer.devnet.holdfastprotocol.com', // required only for getHistory
});
```

#### `reputation.get(agentPubkey)`

Fetches the live `ReputationAccount` for an agent.

```typescript
const rep = await client.reputation.get('YourAgentPubkeyBase58...');

console.log('Score:', rep.score);       // basis points [0, 10000]; 5000 = neutral
console.log('Tier:', rep.tier);         // VerifTier enum: Unverified | Attested | Hardline
console.log('Pacts:', rep.totalPacts);  // lifetime completed pacts
console.log('Disputes:', rep.disputeCount);
```

Throws `ReputationNotFoundError` if the agent has no account yet. Initialize the account explicitly via `init_reputation` before calling `get`.

#### `reputation.meetsRequirements(agentPubkey, requirements)`

Pre-flight check that mirrors the on-chain `validate_reputation_for_pact` logic. Returns `false` (not throws) when the agent has no `ReputationAccount` yet.

```typescript
const ok = await client.reputation.meetsRequirements(agentPubkey, {
  minScore: 6000,           // minimum score in basis points
  minTier: VerifTier.Attested,
  minPacts: 5,
});
```

All fields are optional and default to the minimum (no requirement).

#### `reputation.getHistory(agentPubkey, options?)`

Fetches paginated pact history from the off-chain indexer. Dashboard use only — not in the trust path. Requires `indexerUrl` to be set.

```typescript
const page = await client.reputation.getHistory(agentPubkey, { limit: 20 });
// page.entries: HistEntry[]   — ordered oldest → newest
// page.hasMore: boolean
// page.cursor?: string        — pass as `before` for the next page
```

#### Error types

| Class | When thrown |
|---|---|
| `ReputationNotFoundError` | Agent has no `ReputationAccount` yet |
| `ReputationAccountCorruptError` | Account data is malformed (wrong size or discriminator) |
| `IndexerRequestError` | Off-chain indexer returned a non-2xx response |

---

### `escrow`

TypeScript SDK surface for the `holdfast-escrow` program. The devnet program ID is listed under [Program IDs (devnet)](#program-ids-devnet).

Write methods require `signer` and, where noted, `agentWallet` in client options. Read methods (`getPact`, `listPacts`) work without a signer.

```typescript
import { createHoldfastClient, EscrowStatus } from '@holdfastprotocol/sdk';
import { Keypair, PublicKey } from '@solana/web3.js';

const keypair = Keypair.fromSecretKey(/* your agent keypair */);

const client = createHoldfastClient({
  signer: keypair,
  agentWallet: new PublicKey('YourAgentWalletPDA...'), // from register_agent_wallet
});
```

#### `escrow.createPact(params)`

Creates a new pact between the signing agent (initiator) and a counterparty.
Calls `initialize_escrow` and returns the decoded `EscrowAccount`.

When `reputationThreshold` is set, performs a local pre-flight via `reputation.meetsRequirements`
before submitting — the same constraint is enforced on-chain via CPI.

```typescript
const escrow = await client.escrow.createPact({
  counterparty: new PublicKey('CounterpartyPubkey...'),
  counterpartyWallet: new PublicKey('CounterpartyAgentWalletPDA...'),
  mint: new PublicKey('So11111111111111111111111111111111111111112'), // wrapped SOL
  amount: 1_000_000_000n, // 1 SOL in lamports
  releaseCondition: {
    kind: 'timed',
    timeLockExpiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 3600, // 7 days
  },
  reputationThreshold: { minScore: 5000 },
});

console.log('Escrow address:', escrow.address);
console.log('Status:', EscrowStatus[escrow.status]); // "Pending"
```

#### `escrow.depositEscrow(escrowId)`

Transfers `escrow_amount + initiator_stake` from the initiator's ATA into the vault.
Escrow must be in `Pending` status; advances to `Funded` on success.

```typescript
const escrowId = new PublicKey(Buffer.from(escrow.escrowId, 'hex'));
const signature = await client.escrow.depositEscrow(escrowId);
```

#### `escrow.releasePact(escrowId)`

Releases the escrow to the beneficiary. Only the initiator may call this while the escrow
is in `Locked` status. Opens a 7-day dispute window (`disputeWindowEndsAt`) after which
the beneficiary may claim funds via `claim_released`.

```typescript
const signature = await client.escrow.releasePact(escrowId);
```

#### `escrow.openDispute(escrowId, reason)`

Raises a dispute on a `Locked` or recently-released escrow. Either the initiator or
beneficiary may call this. The escrow advances to `Disputed` and the arbiter resolution
clock begins.

```typescript
const signature = await client.escrow.openDispute(
  escrowId,
  'Deliverables not met: missing API endpoint spec',
);
```

#### `escrow.stakeBeneficiary(escrowId)`

Marks `EscrowAccount.beneficiary_staked = true` and transfers `beneficiary_stake` tokens to the vault (if stake > 0). **Must be called before `lockEscrow`**, even when stake is zero.

The client's `signer` must be the beneficiary. Escrow must be in `Funded` status.

```typescript
const signature = await beneficiaryClient.escrow.stakeBeneficiary(escrowId);
```

#### `escrow.lockEscrow(escrowId, beneficiarySigner, beneficiaryWallet, arbiterWallet?)`

Advances status from `Funded` → `Locked`. Both the initiator (client's `signer`) and beneficiary must sign. Re-validates reputation thresholds at lock time.

```typescript
const signature = await client.escrow.lockEscrow(
  escrowId,
  beneficiarySigner,   // Keypair — co-signs the same transaction
  beneficiaryWallet,   // beneficiary's AgentWallet PDA
);
```

For async multi-agent flows where parties run in separate processes, use `buildLockEscrowTransaction` to get an unsigned `Transaction`, exchange it off-band, then submit with `sendRawTransaction`.

```typescript
const unsignedTx = await client.escrow.buildLockEscrowTransaction(
  escrowId,
  beneficiaryWallet,
);
```

#### `escrow.claimReleased(escrowId, initiatorPubkey)`

Finalizes claim-time settlement and is the **only** place protocol fees are charged in v1.

- Fee rate: **25 bps** (0.25%) on `escrow_amount` only.
- Formula: `fee = floor(escrow_amount * 25 / 10_000)`.
- Beneficiary payout: `beneficiary_net = escrow_amount + beneficiary_stake - fee`.
- Initiator payout: `initiator_stake` is returned unchanged.

No protocol fees are charged on refunds, cancellations, disputes, or non-escrow paths in v1.

On success, both parties receive +50 reputation bp (`Fulfilled`) and status advances to `Claimed`.

The SDK pre-flights the dispute window — throws `DisputeWindowStillOpenError` before sending any transaction if `disputeWindowEndsAt` has not elapsed.

```typescript
const signature = await beneficiaryClient.escrow.claimReleased(
  escrowId,
  initiator.publicKey,
);
```

#### `escrow.getPact(escrowId)`

Reads the `EscrowAccount` PDA directly via RPC — no oracle round-trip. Returns the
decoded account including current status, time-lock expiry, and dispute window.

```typescript
const escrow = await client.escrow.getPact(escrowId);
console.log('Time-lock expires:', new Date(escrow.timeLockExpiresAt * 1000).toISOString());
```

#### `escrow.listPacts(agentPubkey, opts?)`

Fetches paginated pacts for an agent from the off-chain indexer.
Dashboard use only — not in the trust path.

```typescript
const page = await client.escrow.listPacts(agentPubkey, {
  status: EscrowStatus.Disputed,
  limit: 20,
});
// page.pacts: EscrowAccount[]
// page.hasMore: boolean
// page.cursor?: string  — pass as `before` for the next page
```

#### `escrow.getEscrowEvents(escrowId, opts?)`

Fetches lifecycle events for one escrow from the off-chain indexer.

Claim events surface fee accounting fields:
- `grossAmount` (`beneficiaryNetAmount + protocolFeeAmount`)
- `protocolFeeAmount`
- `beneficiaryNetAmount`

```typescript
const events = await client.escrow.getEscrowEvents(escrowId, { limit: 20 });
// events.events: EscrowEventEntry[]
// events.hasMore: boolean
// events.cursor?: string
```

#### Escrow error types

| Class | When thrown |
|---|---|
| `EscrowNotFoundError` | No EscrowAccount exists for the given escrow ID |
| `EscrowAccountCorruptError` | Account data is malformed (wrong size or discriminator) |
| `EscrowSignerRequiredError` | Write method called without a `signer` in client options |
| `EscrowAgentWalletRequiredError` | `createPact`/`releasePact` called without `agentWallet` in client options |
| `ReputationThresholdNotMet` | Pre-flight reputation check failed before `createPact` |
| `DisputeWindowStillOpenError` | `claimReleased` pre-flight — dispute window has not yet elapsed |
| `IndexerRequestError` | Indexer returned a non-2xx response (from `listPacts` / `getEscrowEvents`) |

---

## Types

```typescript
import type { ReputationAccount, ReputationRequirements, HistEntry, HistoryPage, GetHistoryOptions } from '@holdfastprotocol/sdk';
import { VerifTier, PactOutcome } from '@holdfastprotocol/sdk';
```

### `VerifTier`

| Value | Meaning |
|---|---|
| `Unverified` (0) | No attestation |
| `Attested` (1) | Standard secp256r1 self-attestation |
| `Hardline` (2) | TEE-attested via Hardline Protocol cross-CPI |

### `PactOutcome`

| Value | Meaning |
|---|---|
| `Fulfilled` (0) | Pact completed successfully |
| `Disputed` (1) | Pact ended in a dispute |
| `Cancelled` (2) | Pact was cancelled |

### `ReputationAccount`

| Field | Type | Notes |
|---|---|---|
| `agent` | `string` | Base58-encoded agent pubkey |
| `score` | `number` | Basis points [0, 10000]. 5000 = neutral. Lazy time-decay toward 5000. |
| `tier` | `VerifTier` | |
| `totalPacts` | `number` | Lifetime completed pacts |
| `disputeCount` | `number` | Lifetime disputes |
| `createdAt` | `number` | Unix seconds |
| `lastUpdated` | `number` | Unix seconds of last score mutation |
| `nonce` | `number` | Monotonic anti-replay nonce |
| `history` | `HistEntry[]` | Up to 20 most-recent entries, oldest → newest |

---

## Program IDs (devnet)

| Program | Address |
|---|---|
| `holdfast` | `2chF47DbqehX3L38874e2RznaSs46vpcMPEPRYz4Dywq` |
| `holdfast-escrow` | `CAZMkHiExVjbsSwAVBYVhz1yaHmnBSvzUYGaQrrRp6yi` |

---

## Documentation

- [Quickstart](./docs/quickstart.md) — zero to first confirmed devnet pact in ~15 minutes
- [Troubleshooting](./docs/troubleshooting.md) — error codes, SDK exceptions, recovery paths

---

## License

[MIT](./LICENSE)
