# Holdfast Protocol — Troubleshooting Reference

Error codes, SDK exceptions, and recovery paths for common failure scenarios.

---

## Anchor Program Error Codes

Anchor errors surface as transaction simulation failures with a numeric code in the error message. `vaultpact` and `vaultpact-escrow` have **separate** error namespaces, both starting from 6000 — the same numeric code means different errors in each program. Check the Program column to identify the origin.

| Code | Name | Program | Trigger | Recovery |
|------|------|---------|---------|----------|
| 6002 | `TimeLockInPast` | vaultpact-escrow | `timeLockExpiresAt` is already in the past at lock time. | Use a future timestamp. Check system clock drift. |
| 6004 | `InvalidStatus` | vaultpact-escrow | Instruction called when escrow is in the wrong state (e.g. `releasePact` on a `Locked` escrow that the initiator didn't call). | Check `pact.status` before calling. See lifecycle table below. |
| 6006 | `VaultBalanceMismatch` | vaultpact-escrow | Vault token balance does not equal `escrow_amount + initiator_stake + beneficiary_stake`. Usually caused by transferring tokens directly to the vault address. | Only fund the vault via `depositEscrow()`. Never transfer SPL tokens directly to the vault PDA. |
| 6008 | `DisputeWindowOpen` | vaultpact-escrow | `claimReleased()` called before `disputeWindowEndsAt`. | Wait for the dispute window to close. Check `pact.disputeWindowEndsAt` first. |
| 6016 | `AgentNotActive` | vaultpact | An `AgentWallet` referenced in the transaction has status other than `Active` (0). Covers frozen or suspended wallets. | Contact the protocol authority. The frozen agent must resolve their status before transacting. |
| 6017 | `AgentBlacklisted` | vaultpact | The beneficiary's `AgentWallet` is blacklisted. | The blacklisted agent cannot claim. If you are the initiator, open a dispute via `openDispute()`. |
| 6022 | `UnauthorizedTokenAccount` | vaultpact-escrow | The token account passed does not belong to the expected party, or uses a different mint than the pact. | Use `getAssociatedTokenAddressSync(mint, party.publicKey)` to derive the correct ATA. |
| 6023 | `BeneficiaryAlreadyStaked` | vaultpact-escrow | `stakeBeneficiary()` was called a second time on the same escrow. | Safe to ignore — already staked. Check `pact.beneficiaryStaked === true` before calling. |
| — | `EscrowAuthorityMismatch` | vaultpact | `initialize_registry` was called with an `escrow_program` whose derived `vp_escrow_authority` PDA does not match the compiled `VAULTPACT_ESCROW_AUTHORITY` constant. Indicates the wrong escrow program account was supplied, or the escrow program was redeployed and the constant was not updated. | Pass the correct `vaultpact-escrow` program account. If the escrow program was redeployed, update `VAULTPACT_ESCROW_AUTHORITY` in `vaultpact/src/lib.rs` and redeploy both programs. |
| — | `InvalidAuthority` | vaultpact | `set_protocol_authority` was called with `new_authority = Pubkey::default()` (all-zero key). Setting the protocol authority to the zero pubkey would permanently disable all authority-gated instructions with no recovery path. | Supply a valid non-zero pubkey. |

### Escrow status values

| Value | Name | Description |
|-------|------|-------------|
| 0 | `Pending` | Pact created, not yet funded |
| 1 | `Funded` | Initiator deposited; waiting for beneficiary stake |
| 2 | `Locked` | Both parties signed; work in progress |
| 3 | `Released` | Initiator released; dispute window open |
| 4 | `Disputed` | Dispute open; oracle resolution pending |
| 5 | `Refunded` | Funds returned to initiator (refund, cancel-before-stake, or dispute initiator-win) |
| 6 | `Closed` | Escrow account closed after claim or refund |
| 7 | `Claimed` | Beneficiary claimed payout |
| 8 | `MutuallyCancelled` | Both parties agreed to cancel via `mutual_cancel_escrow` |

---

## SDK Exceptions

### `EscrowSignerRequiredError`

**When:** Any write operation (CREATE_PACT, DEPOSIT_ESCROW, RELEASE_PACT, OPEN_DISPUTE) is called and no `signer` or `privateKeyBase58` was passed to `createHoldfastClient()` or `createHoldfastPlugin()`.

**Fix:** Add a signer to your config:
```typescript
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const client = createHoldfastClient({
  signer: Keypair.fromSecretKey(bs58.decode(process.env.AGENT_PRIVATE_KEY_BASE58)),
});
```

### `DisputeWindowStillOpenError`

**When:** `client.escrow.claimReleased()` is called before `disputeWindowEndsAt`.

**Fix:** Check the window before calling:
```typescript
const pact = await client.escrow.getPact(escrowId);
const nowSecs = Math.floor(Date.now() / 1000);
if (nowSecs <= pact.disputeWindowEndsAt) {
  const hoursLeft = Math.ceil((pact.disputeWindowEndsAt - nowSecs) / 3600);
  throw new Error(`Dispute window closes in ${hoursLeft}h`);
}
await client.escrow.claimReleased(escrowId, initiatorPubkey);
```

### `PREAUDIT_WARNING` (console)

**When:** The plugin or SDK client is initialized. This is a `console.warn`, not an error — the program continues normally.

**Meaning:** The on-chain programs have not undergone a third-party security audit. The warning is intentional and cannot be suppressed. Do not use on mainnet.

---

## Common Failure Scenarios

### "Counterparty cannot be added to a pact"

**Cause:** The counterparty does not have an AgentWallet registered on-chain.

**Check:**
```typescript
const client = createHoldfastClient();
const rep = await client.reputation.get(counterpartyPubkey);
// If this throws or returns null, no AgentWallet exists
```

**Fix:** Ask the counterparty to call `registerAgentWallet()` and provide their AgentWallet PDA.

---

### "Reputation threshold not met"

**Cause:** `reputationThreshold.minScore` was set on `createPact()`, and the counterparty's score is below it. The CPI call to the core program fails at transaction time.

**Check:**
```typescript
const rep = await client.reputation.get(counterpartyPubkey);
console.log('Score:', rep.score, 'Required:', minScore);
```

**Fix:** Either lower the threshold, or require the counterparty to complete more pacts to raise their score.

---

### "Vault has insufficient balance for deposit"

**Cause:** The signer's token account has fewer tokens than `amount` (for SPL pacts) or insufficient SOL (for wSOL pacts).

**Fix for wSOL:** Wrap SOL before depositing:
```typescript
import { createSyncNativeInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';

const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
// Transfer SOL to the ATA, then sync
```

Or use native SOL pacts when available (check SDK changelog for `nativeSol` mint support).

---

### "P-256 private key lost — need to re-register"

**Cause:** The `p256PrivateKey` returned by `registerAgentWallet()` was not persisted. Without it, you cannot re-derive the same AgentWallet PDA.

**Recovery:**
- No cryptographic recovery path exists — the P-256 key is the only way to prove ownership of the AgentWallet PDA.
- Register a new AgentWallet (call `registerAgentWallet()` with a new signer or the same Ed25519 signer — the new P-256 key generates a different PDA).
- The new identity starts with no reputation history. Reputation is non-transferable.
- Update all downstream configs (`AGENT_WALLET_PDA`) to the new PDA.

**Prevention:** Store `p256PrivateKey` in a secrets manager (AWS Secrets Manager, HashiCorp Vault, etc.) encrypted at rest. Treat it with the same care as the Ed25519 private key.

---

### "Devnet-only restriction" / RPC URL rejected

**Cause:** The SDK rejects mainnet RPC URLs as a pre-audit safety guard.

**Error message:** Something like "devnet-only: mainnet RPC connections are not permitted in pre-audit builds."

**Fix:** Use a devnet endpoint:
- `https://api.devnet.solana.com` (public, rate-limited)
- `https://devnet.helius-rpc.com/?api-key=<your-key>` (Helius devnet)
- `http://localhost:8899` (local validator)

Do not attempt to bypass this restriction. The programs are not audited for mainnet use.

---

### Plugin provider returns nothing / context window not updated

**Cause:** `agentWallet` was not set in `createHoldfastPlugin()`. Both the reputation provider and active pacts provider silently return `{}` when `agentWallet` is missing.

**Fix:**
```typescript
const plugin = createHoldfastPlugin({
  privateKeyBase58: process.env.AGENT_PRIVATE_KEY_BASE58,
  agentWallet: process.env.AGENT_WALLET_PDA,  // required for providers
});
```

If `AGENT_WALLET_PDA` is not set, run `registerAgentWallet()` first and save the output.

---

### `lock_escrow` fails — "both signers required"

**Cause:** `lockEscrow()` requires both initiator and beneficiary to sign in the same transaction. In asynchronous agent workflows, the beneficiary's signature may not be available yet.

**Pattern for async coordination:**
```typescript
// Initiator side: build partial transaction
const tx = await client.escrow.buildLockEscrowTransaction(escrowId, beneficiaryPubkey, beneficiaryWalletPDA);
// Serialize and send to beneficiary via your messaging layer
const serialized = tx.serialize({ requireAllSignatures: false });

// Beneficiary side: sign and submit
const tx = Transaction.from(serialized);
tx.sign(beneficiarySigner);
await connection.sendRawTransaction(tx.serialize());
```

---

## Getting Help

- Open issues at [casematelabs/holdfastprotocol-sdk/issues](https://github.com/casematelabs/holdfastprotocol-sdk/issues)
- Check program logs in devnet Explorer: search for the program ID `CAZMkHiExVjbsSwAVBYVhz1yaHmnBSvzUYGaQrrRp6yi`
- For security disclosures, see [SECURITY.md](https://github.com/casematelabs/holdfastprotocol-sdk/blob/master/SECURITY.md) once it lands. Until then, contact the team via the email address listed on the npm package page.

---

## Related

- [Quickstart](./quickstart.md) — zero to first confirmed devnet pact in ~15 minutes
- [Back to README](../README.md)
