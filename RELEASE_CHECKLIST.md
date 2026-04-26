# @holdfastprotocol/sdk v0.2.0-devnet.1 Release Checklist

Publish tag: `devnet`  
Target: `npm publish --tag devnet` (NOT `--tag latest` or no tag)

> **dist-tag policy:** The `latest` dist-tag is npm-mandatory and cannot be removed once set. If set unintentionally, the deprecation warning (`PREAUDIT_WARNING`) is the intended mitigation for pre-audit packages. Future releases MUST use `npm publish --tag devnet` — never `--tag latest` or no tag.

---

## 1. Pre-build verification

- [ ] All source compiles clean: `npm run typecheck` exits 0
- [ ] No uncommitted changes to `sdk/src/` or `sdk/package.json`
- [ ] Confirm version in `package.json` is exactly `0.2.0-devnet.1`
- [ ] Confirm `PREAUDIT_WARNING` is exported from `src/index.ts`

## 2. Build

- [ ] Run `npm run build` inside `holdfast/sdk/`
- [ ] `dist/esm/index.js` exists and is ES module syntax (`export {`)
- [ ] `dist/cjs/index.js` exists and is CommonJS syntax (`exports.`)
- [ ] `dist/cjs/package.json` contains `{"type":"commonjs"}`
- [ ] `dist/esm/index.d.ts` declares `PREAUDIT_WARNING`, `HoldfastClient`,
  `createHoldfastClient`, `ReputationModule`, `EscrowModule`, and all exported types
- [ ] `dist/cjs/index.d.ts` likewise

## 3. Smoke tests (run before publish)

### ESM consumer (Node.js ≥18)
```js
import { createHoldfastClient, PREAUDIT_WARNING } from "./dist/esm/index.js";
console.log(PREAUDIT_WARNING);          // should print the disclaimer
const client = createHoldfastClient(); // should console.warn the disclaimer
```

### CJS consumer
```js
const { createHoldfastClient, PREAUDIT_WARNING } =
  require("./dist/cjs/index.js");
console.log(PREAUDIT_WARNING);
```

### Devnet guard test
```js
import { createHoldfastClient } from "./dist/esm/index.js";
try {
  createHoldfastClient({ rpcUrl: "https://api.mainnet-beta.solana.com" });
  throw new Error("FAIL — should have thrown");
} catch (e) {
  console.log("PASS:", e.message);
}
```

### Live devnet connection (requires funded keypair)
```sh
ts-node --esm holdfast/sdk/examples/quickstart.ts
# Expect: PREAUDIT_WARNING console.warn, then successful register_agent_wallet
```

## 4. Pack dry-run

```sh
cd holdfast/sdk
npm pack --dry-run
```

Verify the tarball includes:
- `dist/esm/**`
- `dist/cjs/**`
- `README.md`
- `CHANGELOG.md`
- `RELEASE_CHECKLIST.md`

Verify the tarball does NOT include:
- `src/`
- `scripts/`
- `tsconfig*.json`
- `examples/` (not in `files` field)

## 5. npm publish

```sh
cd holdfast/sdk
npm publish --tag devnet --access public
```

- [ ] Confirm exit 0 with `+ @holdfastprotocol/sdk@0.2.0-devnet.1`

## 6. Post-publish verification

```sh
npm info @holdfastprotocol/sdk dist-tags
# Expected: { devnet: '0.2.0-devnet.1', latest: '0.2.0-devnet.1' }
# Note: latest tag is npm-mandatory and cannot be removed. Deprecation warning is the intended mitigation.
```

- [ ] `npm install @holdfastprotocol/sdk@devnet` resolves `0.2.0-devnet.1` in a blank project
- [ ] ESM import resolves types (TypeScript `tsc --noEmit` passes in a consumer project)
- [ ] CJS require works in a bare `node` script with `"type": "commonjs"` or `.cjs` extension

## 7. Documentation

- [ ] Update integration guide ([CAS-69](/CAS/issues/CAS-69)) with:
  - `npm install @holdfastprotocol/sdk@devnet` install command
  - Note that `@devnet` tag is required (not `@latest`)
  - Link to `PREAUDIT_WARNING` and audit status page
- [ ] Confirm quickstart in integration guide reaches `register_agent_wallet` within 10 min

## 8. Git tag

```sh
git tag v0.2.0-devnet.1 -m "Holdfast SDK v0.2.0-devnet.1 — devnet pre-audit release"
git push origin v0.2.0-devnet.1
```

## 9. Notify

- [ ] Post completion comment on [CAS-117](/CAS/issues/CAS-117) with npm link
- [ ] Assign [CAS-69](/CAS/issues/CAS-69) to Backend Engineer to update integration guide

---

## Security reminders

- **Do not** remove the devnet-only guard or `PREAUDIT_WARNING` before audit sign-off.
- **`latest` dist-tag is npm-mandatory** and cannot be removed once set. Deprecation warning is the intended mitigation for pre-audit packages.
- **Future releases MUST use** `npm publish --tag devnet` — never `--tag latest` or no tag.
- Audit readiness tracked on [CAS-59](/CAS/issues/CAS-59).
- Any mainnet SDK release requires CTO + CEO sign-off and audit firm approval.
