# Changelog

All notable changes to `@holdfastprotocol/sdk` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Changed

- **BREAKING**: Package renamed from `@vaultpact/sdk` to `@holdfastprotocol/sdk` (CAS-277).
  VaultPact Protocol is now Holdfast Protocol. All public API symbols renamed:
  - `VaultPactClient` → `HoldfastClient`
  - `createVaultPactClient` → `createHoldfastClient`
  - `VaultPactClientOptions` → `HoldfastClientOptions`
  - `VAULTPACT_PROGRAM_ID` → `HOLDFAST_PROGRAM_ID`
  - `VAULTPACT_ESCROW_PROGRAM_ID` → `HOLDFAST_ESCROW_PROGRAM_ID`
  - `VaultPactSdkError` → `HoldfastSdkError`
  - `vaultpactProgramId` option → `holdfastProgramId`
- Version bumped to `0.2.0-devnet.1` for the rename.

_Updated by CTO (Matthew Wicks) — CAS-277._

---

## [0.2.0-devnet] — 2026-04-21

### Added

- `EscrowModule.stakeBeneficiary(escrowId)` — SDK wrapper for `stake_beneficiary` (CAS-200).
  Call as the beneficiary after `depositEscrow` and before `lockEscrow`. Required in every
  pact flow — even when `beneficiary_stake` is 0, sets the `beneficiary_staked` flag.
  If stake > 0, transfers from beneficiary's ATA to the vault. Requires `signer` and
  `agentWallet` in `HoldfastClientOptions`.
- `EscrowModule.lockEscrow(escrowId, beneficiarySigner, beneficiaryWallet, arbiterWallet?)` —
  SDK wrapper for `lock_escrow` (CAS-201). Both initiator and beneficiary must sign.
  Passes an arbiter wallet placeholder (initiator's `agentWallet`) when no arbiter was set.
  Requires `signer` and `agentWallet` in `HoldfastClientOptions`.
- `EscrowModule.buildLockEscrowTransaction(escrowId, beneficiaryWallet, arbiterWallet?)` —
  Returns an unsigned `Transaction` for async multi-agent flows where parties exchange a
  partially-signed transaction off-band before submission (CAS-201).
- `EscrowModule.claimReleased(escrowId, initiatorPubkey)` — SDK wrapper for `claim_released`
  (CAS-202). Transfers `escrow_amount + beneficiary_stake` to the beneficiary, returns
  `initiator_stake` to the initiator, awards +50 bp Fulfilled reputation to both parties.
  Pre-flights the dispute window: throws `DisputeWindowStillOpenError` if
  `disputeWindowEndsAt` has not elapsed before sending any transaction.
- `DisputeWindowStillOpenError` — thrown by `claimReleased` pre-flight when the 7-day
  dispute window is still open. Check `pact.disputeWindowEndsAt` for the exact close time.
- `examples/agent-to-agent.ts` fully updated: all IDL direct-call helpers removed;
  Steps 5, 6, and 8 now use SDK methods exclusively. `@coral-xyz/anchor` import removed.

---

## [0.1.1-devnet] — 2026-04-21

### Added

#### Registration helper — eliminates Anchor prerequisite (CAS-123)
- `registerAgentWallet(params)` — registers a P-256 AgentWallet PDA on the
  holdfast program using pure `@solana/web3.js` (no Anchor required). Generates
  a fresh secp256r1 keypair if none is supplied, builds the secp256r1 precompile
  instruction (SIMD-48) and `registerAgentWallet` Borsh instruction, and submits
  both in one transaction. Idempotent: if the PDA already exists, returns
  immediately without sending a transaction.
- `deriveAgentWalletPda(p256PubkeyX, p256PubkeyY, programId?)` — derives the
  AgentWallet PDA address from P-256 coordinate bytes without any network call;
  useful for pre-computing the address before registering.
- `RegisterAgentWalletParams` / `RegisterAgentWalletResult` types exported from
  the package root.
- `@noble/curves` added as a production dependency (P-256 / secp256r1 signing).
  Installed at `^2.2.0`.
- `examples/quickstart.ts` — Part 2 now calls `registerAgentWallet()` inline;
  the `AGENT_WALLET` environment variable and the separate `register-agent.ts`
  script are no longer required.

---

## [0.1.0-devnet.1] — 2026-04-20

First devnet-tagged npm release. Supersedes the internal `0.1.0` snapshot.
Published as `npm install @holdfastprotocol/sdk@devnet` (tag: `devnet`, not `latest`).

_Updated by CTO (Matthew Wicks) — CAS-117._

### Added

#### Pre-audit safety
- `PREAUDIT_WARNING` — exported string constant; consume in your app to surface
  audit status in your own UI/logs
- `HoldfastClient` constructor now emits `console.warn(PREAUDIT_WARNING)` on
  every instantiation until the external security audit completes
- Devnet-only guard — throws a descriptive `Error` if `rpcUrl` matches any known
  mainnet-beta endpoint pattern; will be removed post-audit

#### Build
- Dual CJS + ESM output: `dist/esm/` (NodeNext modules) and `dist/cjs/` (CommonJS)
- `package.json` `exports` map with `"import"` and `"require"` conditions for
  correct bundler and native Node.js resolution
- `"files"` field restricts the published package to `dist/`, `README.md`,
  `CHANGELOG.md`, and `RELEASE_CHECKLIST.md` — source is not published
- `prepublishOnly` hook runs the full dual build before every `npm publish`
- `tsconfig.esm.json` / `tsconfig.cjs.json` split for independent format builds

#### Escrow module (promoted from internal stub)
- `EscrowModule` — manages pact escrow lifecycle on devnet
  - `createPact(params)`, `depositEscrow(escrowId)`, `releasePact(escrowId)`,
    `openDispute(escrowId, reason)`, `getPact(escrowId)`, `listPacts(pubkey, opts?)`
- Associated types: `EscrowAccount`, `PactPage`, `CreatePactParams`,
  `ReleaseCondition` (union: `TaskRelease | MilestoneRelease | TimedRelease`),
  `EscrowStatus`, `ListPactsOptions`
- Error classes: `EscrowNotFoundError`, `EscrowAccountCorruptError`,
  `EscrowSignerRequiredError`, `EscrowAgentWalletRequiredError`,
  `ReputationThresholdNotMet`

### Changed
- Version bumped from `0.1.0` to `0.1.0-devnet.1` to signal devnet-only
  pre-audit status

### Known limitations
- All mainnet connections blocked by devnet guard (intentional, pre-audit)
- Agent wallet registration instruction exists on-chain but has no SDK helper yet
- `getHistory` / `listPacts` require a separately hosted indexer;
  no public mainnet indexer in this release

---

## [0.1.0] — 2026-04-19

Initial internal snapshot. Covers reputation layer only. Not published to npm.

### Added

#### Client
- `HoldfastClient` — top-level client class with typed module accessors
- `createHoldfastClient(options?)` — factory function; defaults to Solana devnet

#### `ReputationModule`
- `reputation.get(agentPubkey)` — fetches live `ReputationAccount` PDA via RPC
- `reputation.meetsRequirements(agentPubkey, requirements)` — pre-flight check
- `reputation.getHistory(agentPubkey, options?)` — paginated pact history from indexer

#### On-chain account types
- `ReputationAccount`, `HistEntry`, `HistoryPage`, `GetHistoryOptions`,
  `ReputationRequirements`

#### Enums
- `VerifTier` — `Unverified` (0) · `Attested` (1) · `Hardline` (2)
- `PactOutcome` — `Fulfilled` (0) · `Disputed` (1) · `Cancelled` (2)

#### Error classes
- `ReputationNotFoundError`, `ReputationAccountCorruptError`, `IndexerRequestError`

[Unreleased]: https://github.com/casematelabs/holdfastprotocol/compare/v0.2.0-devnet...HEAD
[0.2.0-devnet]: https://github.com/casematelabs/holdfastprotocol/compare/v0.1.1-devnet...v0.2.0-devnet
[0.1.1-devnet]: https://github.com/casematelabs/holdfastprotocol/compare/v0.1.0-devnet.1...v0.1.1-devnet
[0.1.0-devnet.1]: https://github.com/casematelabs/holdfastprotocol/compare/v0.1.0...v0.1.0-devnet.1
[0.1.0]: https://github.com/casematelabs/holdfastprotocol/releases/tag/v0.1.0
